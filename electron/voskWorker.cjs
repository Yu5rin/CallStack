/**
 * Vosk ライブ認識ワーカー（Electron utilityProcess で実行される専用プロセス）。
 *
 * libvosk.dll（ネイティブライブラリ）のクラッシュや例外がアプリ本体を
 * 巻き込まないよう、FFI 呼び出しはすべてこのプロセス内に隔離する。
 * ここが落ちても main 側は exit イベントで検知してエラー表示するだけで済む。
 *
 * main との通信は process.parentPort のメッセージのみ:
 *  受信: {type:'start', dllPath, modelDir}
 *        {type:'pcm', data: Uint8Array}     16kHz/mono/Int16 PCM
 *        {type:'stop'} / {type:'unload'}
 *  送信: {type:'ready'} / {type:'started'} / {type:'segment', text, final}
 *        {type:'stopped', text} / {type:'unloaded'} / {type:'error', message}
 *
 * 認識は同期呼び出しで行う（ブロックするのはこのプロセスだけで、
 * メッセージはキューに溜まり順に処理されるため音声の取りこぼしもない）。
 */

const path = require('node:path');
const koffi = require('koffi');

// 【重要】koffi は FFI 呼び出しを専用スタック（既定 1MiB）で実行するが、
// Kaldi のモデル読込はそれを超えるスタックを消費し、スタックオーバーフローで
// プロセスごとクラッシュする（検証済み）。上限の 16MiB まで引き上げる。
// ※ koffi.load / 関数呼び出しより前に設定する必要がある
koffi.config({ sync_stack_size: 16 * 1024 * 1024, sync_heap_size: 8 * 1024 * 1024 });

let lib = null;
let model = null;
let loadedModelDir = null;
let recognizer = null;
let lastPartial = '';
// 認識器が消費した音声の累積秒数（16kHz mono Int16 前提）。
// タイムスタンプは壁時計ではなく「消費した音声位置」で付けることで、
// モデルロードや処理遅延によるズレを避ける。
let consumedSec = 0;
let phraseStartSec = null;

const port = process.parentPort;
const send = (msg) => port.postMessage(msg);

function loadLib(dllPath) {
  if (lib) return lib;
  // 依存 DLL（libgcc/libstdc++ 等）を確実に解決できるよう、DLL のフォルダを PATH に加える
  if (process.platform === 'win32') {
    process.env.Path = `${path.dirname(dllPath)};${process.env.Path ?? ''}`;
  }
  const k = koffi.load(dllPath);
  lib = {
    setLogLevel: k.func('void vosk_set_log_level(int)'),
    modelNew: k.func('void* vosk_model_new(const char*)'),
    modelFree: k.func('void vosk_model_free(void*)'),
    recNew: k.func('void* vosk_recognizer_new(void*, float)'),
    recFree: k.func('void vosk_recognizer_free(void*)'),
    accept: k.func('int vosk_recognizer_accept_waveform(void*, const uint8_t*, int)'),
    result: k.func('const char* vosk_recognizer_result(void*)'),
    partial: k.func('const char* vosk_recognizer_partial_result(void*)'),
    finalResult: k.func('const char* vosk_recognizer_final_result(void*)'),
  };
  // Kaldi のロードログを stderr に出す（main が app.log に記録する）。
  // モデル読込中のネイティブクラッシュの発生箇所を特定するため 0（情報あり）にする。
  lib.setLogLevel(0);
  return lib;
}

port.on('message', (e) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'start': {
        console.log(`[vosk-worker] dll: ${msg.dllPath}`);
        const l = loadLib(msg.dllPath);
        console.log('[vosk-worker] dll loaded');
        if (!model || loadedModelDir !== msg.modelDir) {
          if (model) {
            l.modelFree(model);
            model = null;
            loadedModelDir = null;
          }
          console.log(`[vosk-worker] loading model: ${msg.modelDir}`);
          model = l.modelNew(msg.modelDir);
          if (!model) throw new Error('Vosk モデルの読み込みに失敗しました');
          loadedModelDir = msg.modelDir;
          console.log('[vosk-worker] model loaded');
        }
        if (recognizer) l.recFree(recognizer);
        recognizer = l.recNew(model, 16000.0);
        if (!recognizer) throw new Error('Vosk 認識器の初期化に失敗しました');
        lastPartial = '';
        consumedSec = 0;
        phraseStartSec = null;
        send({ type: 'started' });
        break;
      }
      case 'pcm': {
        if (!recognizer || !lib) break;
        const buf = Buffer.from(msg.data.buffer ?? msg.data, msg.data.byteOffset ?? 0, msg.data.byteLength);
        // この時点の音声位置（accept 前）＝フレーズ開始の目安
        const beforeSec = consumedSec;
        const hasFinal = lib.accept(recognizer, buf, buf.length);
        // Int16 mono 16kHz: 2 バイト = 1 サンプル
        consumedSec += (buf.length / 2) / 16000;
        if (hasFinal) {
          const text = (JSON.parse(lib.result(recognizer)).text || '').trim();
          lastPartial = '';
          const startSec = phraseStartSec != null ? phraseStartSec : Math.max(0, consumedSec - 5);
          phraseStartSec = null;
          if (text) send({ type: 'segment', text, final: true, startSec, endSec: consumedSec });
        } else {
          const text = (JSON.parse(lib.partial(recognizer)).partial || '').trim();
          if (text && text !== lastPartial) {
            if (phraseStartSec == null) phraseStartSec = beforeSec;
            lastPartial = text;
            send({ type: 'segment', text, final: false, startSec: phraseStartSec, endSec: consumedSec });
          }
        }
        break;
      }
      case 'stop': {
        let text = null;
        let startSec = phraseStartSec != null ? phraseStartSec : Math.max(0, consumedSec - 5);
        if (recognizer && lib) {
          try {
            text = (JSON.parse(lib.finalResult(recognizer)).text || '').trim() || null;
          } catch (err) {
            console.error(`[vosk-worker] final_result failed: ${err && err.message}`);
          }
          lib.recFree(recognizer);
          recognizer = null;
        }
        send({ type: 'stopped', text, startSec, endSec: consumedSec });
        break;
      }
      case 'unload': {
        if (recognizer && lib) {
          lib.recFree(recognizer);
          recognizer = null;
        }
        if (model && lib) {
          lib.modelFree(model);
          model = null;
          loadedModelDir = null;
        }
        send({ type: 'unloaded' });
        break;
      }
    }
  } catch (err) {
    console.error(`[vosk-worker] ${msg && msg.type}: ${err && err.message}`);
    send({ type: 'error', message: (err && err.message) || String(err) });
  }
});

send({ type: 'ready' });
