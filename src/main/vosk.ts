import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import extract from 'extract-zip';
import { logInfo } from './log';
import { downloadTo, fetchJson, BinDownloadProgress } from './whisperBinary';

/**
 * Vosk によるライブ文字起こし。
 *
 * - libvosk.dll（vosk-api の Windows ビルド）を koffi (FFI) で直接呼ぶ。
 *   公式 npm パッケージは ffi-napi 依存で新しい Electron では動かないため使わない。
 * - モデルロードと認識は koffi の非同期呼び出し（ワーカープール）で実行し、
 *   main プロセスのイベントループをブロックしない。
 * - あくまで「録音中の暫定表示」用。確定版は従来どおり whisper が生成する。
 */

export type VoskModelId = 'small-ja' | 'ja';

const MODEL_URLS: Record<VoskModelId, string> = {
  'small-ja': 'https://alphacephei.com/vosk/models/vosk-model-small-ja-0.22.zip',
  ja: 'https://alphacephei.com/vosk/models/vosk-model-ja-0.22.zip',
};

const VOSK_API_RELEASES = 'https://api.github.com/repos/alphacep/vosk-api/releases?per_page=10';
const VOSK_DLL_FALLBACKS = [
  'https://github.com/alphacep/vosk-api/releases/download/v0.3.45/vosk-win64-0.3.45.zip',
  'https://github.com/alphacep/vosk-api/releases/download/v0.3.42/vosk-win64-0.3.42.zip',
];

export function getVoskDir(): string {
  return path.join(app.getPath('userData'), 'vosk');
}

export function getVoskModelDir(model: VoskModelId): string {
  return path.join(app.getPath('userData'), 'vosk-models', model);
}

async function findDll(dir: string): Promise<string | null> {
  // zip はサブフォルダ (vosk-win64-x.y.z/) 入りのことがあるため2階層まで走査
  const walk = async (d: string, depth: number): Promise<string | null> => {
    if (depth > 2) return null;
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isFile() && /^libvosk\.dll$/i.test(e.name)) return p;
      if (e.isDirectory()) {
        const found = await walk(p, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(dir, 0);
}

export async function isVoskEngineInstalled(): Promise<boolean> {
  return (await findDll(getVoskDir())) !== null;
}

export async function isVoskModelInstalled(model: VoskModelId): Promise<boolean> {
  // モデル zip はフォルダ入り。中の am/ ディレクトリ等の存在で判定
  const dir = getVoskModelDir(model);
  const conf = await findModelRoot(dir);
  return conf !== null;
}

/** モデルの実体フォルダ（am/ conf/ を含む階層）を探す */
async function findModelRoot(dir: string): Promise<string | null> {
  const check = async (d: string): Promise<boolean> => {
    try {
      await fs.access(path.join(d, 'am'));
      return true;
    } catch {
      return false;
    }
  };
  if (await check(dir)) return dir;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (e.isDirectory() && await check(path.join(dir, e.name))) return path.join(dir, e.name);
  }
  return null;
}

interface GhRelease {
  prerelease: boolean;
  assets: Array<{ name: string; browser_download_url: string }>;
}

export async function downloadVosk(
  what: 'engine' | VoskModelId,
  onProgress: (p: BinDownloadProgress & { step: 'download' | 'extract' }) => void,
): Promise<void> {
  const isEngine = what === 'engine';
  const dir = isEngine ? getVoskDir() : getVoskModelDir(what as VoskModelId);
  await fs.mkdir(dir, { recursive: true });
  const tmpZip = path.join(app.getPath('temp'), `vosk-${Date.now()}.zip`);

  let urls: string[];
  if (isEngine) {
    urls = [...VOSK_DLL_FALLBACKS];
    try {
      const releases = await fetchJson<GhRelease[]>(VOSK_API_RELEASES);
      const found: string[] = [];
      for (const rel of releases) {
        if (rel.prerelease) continue;
        const a = rel.assets.find((x) => /^vosk-win64-[\d.]+\.zip$/i.test(x.name));
        if (a) found.push(a.browser_download_url);
      }
      if (found.length) urls = [...new Set([...found, ...urls])];
    } catch (err) {
      logInfo('vosk', `GitHub API failed: ${(err as Error).message} — using fallback URLs`);
    }
  } else {
    urls = [MODEL_URLS[what as VoskModelId]];
  }

  let lastError: Error | null = null;
  let ok = false;
  for (const url of urls) {
    try {
      logInfo('vosk', `downloading ${url}`);
      await downloadTo(url, tmpZip, (p) => onProgress({ ...p, step: 'download' }));
      ok = true;
      break;
    } catch (err) {
      lastError = err as Error;
      logInfo('vosk', `failed ${url}: ${(err as Error).message}`);
    }
  }
  if (!ok) {
    throw new Error(`Vosk のダウンロードに失敗しました (${lastError?.message ?? '不明'})`);
  }
  try {
    onProgress({ receivedBytes: 0, totalBytes: null, step: 'extract' });
    await extract(tmpZip, { dir });
    logInfo('vosk', `extracted to ${dir}`);
  } finally {
    await fs.unlink(tmpZip).catch(() => {});
  }
}

// ============ ライブ認識エンジン ============

export interface LiveSegment {
  text: string;
  final: boolean;
}

type KoffiFunc = {
  async: (...args: unknown[]) => void;
  (...args: unknown[]): unknown;
};

interface VoskLib {
  setLogLevel: KoffiFunc;
  modelNew: KoffiFunc;
  modelFree: KoffiFunc;
  recNew: KoffiFunc;
  recFree: KoffiFunc;
  accept: KoffiFunc;
  result: KoffiFunc;
  partial: KoffiFunc;
  finalResult: KoffiFunc;
}

let lib: VoskLib | null = null;
let model: unknown = null;
let loadedModelDir: string | null = null;
let recognizer: unknown = null;
let feeding = Promise.resolve();
let onSegment: ((seg: LiveSegment) => void) | null = null;
let lastPartial = '';

function loadLib(): VoskLib {
  if (lib) return lib;
  // koffi はネイティブモジュールのため実行時 require（バンドル対象外）
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const koffi = require('koffi');
  const dllPath = dllPathCache;
  if (!dllPath) throw new Error('libvosk.dll が見つかりません');
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
  lib.setLogLevel(-1);
  return lib;
}

let dllPathCache: string | null = null;

function callAsync<T>(fn: KoffiFunc, ...args: unknown[]): Promise<T> {
  return new Promise((resolve, reject) => {
    fn.async(...args, (err: Error | null, result: T) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

/** ライブ認識セッションを開始する（モデルは初回のみロードし、以後キャッシュ） */
export async function startLive(
  modelId: VoskModelId,
  handler: (seg: LiveSegment) => void,
): Promise<void> {
  dllPathCache = await findDll(getVoskDir());
  if (!dllPathCache) throw new Error('Vosk エンジンが未インストールです');
  const modelRoot = await findModelRoot(getVoskModelDir(modelId));
  if (!modelRoot) throw new Error(`Vosk モデル '${modelId}' が未インストールです`);

  const l = loadLib();
  if (!model || loadedModelDir !== modelRoot) {
    if (model) {
      l.modelFree(model);
      model = null;
    }
    logInfo('vosk', `loading model ${modelRoot}`);
    model = await callAsync(l.modelNew, modelRoot);
    if (!model) throw new Error('Vosk モデルの読み込みに失敗しました');
    loadedModelDir = modelRoot;
    logInfo('vosk', 'model loaded');
  }
  recognizer = await callAsync(l.recNew, model, 16000.0);
  if (!recognizer) throw new Error('Vosk 認識器の初期化に失敗しました');
  onSegment = handler;
  lastPartial = '';
  feeding = Promise.resolve();
}

/** 16kHz/mono/Int16 PCM を投入する（呼び出し順を保証するため直列化） */
export function feedPcm(buf: Buffer): void {
  if (!recognizer || !lib) return;
  const l = lib;
  const rec = recognizer;
  feeding = feeding.then(async () => {
    if (recognizer !== rec) return;   // 停止後の遅延チャンクは捨てる
    try {
      const hasFinal = await callAsync<number>(l.accept, rec, buf, buf.length);
      if (recognizer !== rec) return;
      if (hasFinal) {
        const raw = l.result(rec) as string;
        const text = (JSON.parse(raw)?.text ?? '').trim();
        lastPartial = '';
        if (text) onSegment?.({ text, final: true });
      } else {
        const raw = l.partial(rec) as string;
        const text = (JSON.parse(raw)?.partial ?? '').trim();
        if (text && text !== lastPartial) {
          lastPartial = text;
          onSegment?.({ text, final: false });
        }
      }
    } catch (err) {
      logInfo('vosk', `feed error: ${(err as Error).message}`);
    }
  });
}

/** セッションを終了し、末尾の確定テキストを返す */
export async function stopLive(): Promise<string | null> {
  const rec = recognizer;
  recognizer = null;
  onSegment = null;
  if (!rec || !lib) return null;
  await feeding.catch(() => {});
  try {
    const raw = lib.finalResult(rec) as string;
    lib.recFree(rec);
    const text = (JSON.parse(raw)?.text ?? '').trim();
    return text || null;
  } catch {
    return null;
  }
}

/** モデルをメモリから解放する（設定でライブを無効化したときなど） */
export function unloadModel(): void {
  if (model && lib) {
    lib.modelFree(model);
    model = null;
    loadedModelDir = null;
    logInfo('vosk', 'model unloaded');
  }
}
