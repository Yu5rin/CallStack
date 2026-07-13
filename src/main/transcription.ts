import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { app } from 'electron';
import { CallTranscript, TranscriptSegment, WhisperModel } from '../shared/types';
import { getDirs } from './paths';
import { convertMp3ToWav16k } from './ffmpeg';
import { getModelPath, isModelDownloaded } from './whisperModels';
import { getUserWhisperDir } from './whisperBinary';

export interface TranscribeOptions {
  audioPath: string;          // absolute path to mp3
  model: WhisperModel;
  language: 'auto' | 'ja' | 'en';
  /** 用語ヒント（whisper の初期プロンプト）。空文字なら渡さない */
  prompt?: string;
  /** GPU (CUDA) 版バイナリを使用する（隠しオプション） */
  useGpu?: boolean;
}

export class WhisperMissingError extends Error {
  constructor(public readonly binaryPath: string) {
    super(`whisper.cpp の実行ファイルが見つかりません: ${binaryPath}`);
    this.name = 'WhisperMissingError';
  }
}

export class TranscriptionCancelledError extends Error {
  constructor() {
    super('文字起こしをキャンセルしました');
    this.name = 'TranscriptionCancelledError';
  }
}

export async function checkSetup(model: WhisperModel, useGpu = false): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(await isModelDownloaded(model))) {
    return { ok: false, error: `モデル '${model}' が未ダウンロードです。設定画面からダウンロードしてください。` };
  }
  try {
    await resolveWhisperBin(useGpu);
  } catch (err) {
    if (err instanceof WhisperMissingError) {
      return {
        ok: false,
        error: 'whisper.cpp の実行ファイルが見つかりません。\n下の「whisper.cpp をダウンロード」ボタンで自動セットアップできます。',
      };
    }
    return { ok: false, error: (err as Error).message };
  }
  return { ok: true };
}

async function resolveWhisperBin(useGpu = false): Promise<string> {
  const exeName = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
  // 0. GPU 版が有効で配置済みなら最優先
  if (useGpu) {
    const gpuBin = path.join(getUserWhisperDir('gpu'), exeName);
    try {
      await fs.access(gpuBin);
      return gpuBin;
    } catch { /* CPU 版へフォールバック */ }
  }
  // 1. アプリ内ダウンロードで配置されたもの (userData/whisper) を最優先
  const userBin = path.join(getUserWhisperDir(), exeName);
  try {
    await fs.access(userBin);
    return userBin;
  } catch { /* fall through */ }
  // 2. 同梱リソース (resources/whisper)
  const { whisperBin } = getDirs();
  try {
    await fs.access(whisperBin);
    return whisperBin;
  } catch {
    // 3. 環境変数での上書き (開発用)
    const envPath = process.env.TELTIMESTACK_WHISPER_BIN;
    if (envPath) {
      try { await fs.access(envPath); return envPath; } catch { /* fall through */ }
    }
    throw new WhisperMissingError(whisperBin);
  }
}

export type TranscribeStage = 'convert' | 'transcribe';

export async function transcribe(
  opts: TranscribeOptions,
  onProgress?: (stage: TranscribeStage, percent: number) => void,
  cancelToken?: { cancelled: boolean; kill: (() => void) | null },
): Promise<CallTranscript> {
  if (!(await isModelDownloaded(opts.model))) {
    throw new Error(`モデル '${opts.model}' が未ダウンロードです。設定画面からダウンロードしてください。`);
  }
  const bin = await resolveWhisperBin(opts.useGpu);
  const modelPath = getModelPath(opts.model);
  const baseTmp = path.join(app.getPath('temp'), `tts-${Date.now()}`);
  const wavPath = baseTmp + '.wav';
  const outBase = baseTmp;

  onProgress?.('convert', 0);
  // キャンセルは変換中の ffmpeg にも届く（kill フックを共有）
  await convertMp3ToWav16k(opts.audioPath, wavPath, cancelToken);
  if (cancelToken?.cancelled) {
    await fs.unlink(wavPath).catch(() => {});
    throw new TranscriptionCancelledError();
  }
  onProgress?.('transcribe', 0);

  try {
    await runWhisper(bin, modelPath, wavPath, outBase, opts.language, opts.prompt, (p) => onProgress?.('transcribe', p), cancelToken);
    const jsonPath = `${outBase}.json`;
    const raw = await fs.readFile(jsonPath, 'utf-8');
    const parsed = JSON.parse(raw) as WhisperJson;
    const segments: TranscriptSegment[] = (parsed.transcription ?? []).map((s) => ({
      start: parseTimestamp(s.offsets?.from ?? 0),
      end: parseTimestamp(s.offsets?.to ?? 0),
      text: (s.text ?? '').trim(),
    }));
    const text = segments.map((s) => s.text).join('\n').trim();
    return {
      text,
      language: opts.language === 'auto' ? (parsed.result?.language ?? '') : opts.language,
      model: opts.model,
      createdAt: new Date().toISOString(),
      segments,
    };
  } finally {
    await fs.unlink(wavPath).catch(() => {});
    await fs.unlink(`${outBase}.json`).catch(() => {});
  }
}

function parseTimestamp(ms: number): number {
  return ms / 1000;
}

function runWhisper(
  bin: string,
  model: string,
  wav: string,
  outBase: string,
  lang: string,
  prompt?: string,
  onProgress?: (percent: number) => void,
  cancelToken?: { cancelled: boolean; kill: (() => void) | null },
): Promise<void> {
  return new Promise((resolve, reject) => {
    // スレッド数を CPU コア数に合わせて高速化（whisper.cpp 既定は最大4スレッド）
    const threads = Math.max(1, Math.min(16, os.cpus()?.length ?? 4));
    const args = [
      '-m', model,
      '-f', wav,
      '-of', outBase,
      '-oj',                                  // output JSON with timestamps
      '-l', lang === 'auto' ? 'auto' : lang,
      '-t', String(threads),                  // スレッド数（高速化）
      '-pp',                                  // print progress
    ];
    if (prompt && prompt.trim()) {
      args.push('--prompt', prompt.trim());
    }
    const proc = spawn(bin, args);
    if (cancelToken) cancelToken.kill = () => proc.kill();
    let stderr = '';
    // ストール監視: 出力が 10 分止まったらハングとみなして中断する
    let stalled = false;
    let stallTimer = setTimeout(onStall, 10 * 60 * 1000);
    function onStall() { stalled = true; proc.kill(); }
    function resetStall() {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(onStall, 10 * 60 * 1000);
    }
    proc.stderr.on('data', (d) => {
      resetStall();
      const text = d.toString();
      stderr += text;
      // whisper.cpp -pp: "whisper_print_progress_callback: progress =  15%"
      const matches = text.match(/progress\s*=\s*(\d+)%/g);
      if (matches && onProgress) {
        const last = matches[matches.length - 1].match(/(\d+)%/);
        if (last) onProgress(Math.min(100, Number(last[1])));
      }
    });
    proc.on('error', (err) => { clearTimeout(stallTimer); reject(err); });
    proc.on('close', (code) => {
      clearTimeout(stallTimer);
      if (cancelToken) cancelToken.kill = null;
      if (cancelToken?.cancelled) {
        reject(new TranscriptionCancelledError());
        return;
      }
      if (stalled) {
        reject(new Error('whisper が応答しないため文字起こしを中断しました。再度お試しください。'));
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      // STATUS_DLL_NOT_FOUND (0xC0000135) — whisper-cli.exe lacks DLL deps
      if (code === 0xC0000135 || code === -1073741515 || code === 3221225781) {
        reject(new Error(
          'whisper-cli.exe が依存 DLL を読み込めません (STATUS_DLL_NOT_FOUND, 0xC0000135)。\n' +
          'whisper.cpp の Windows release zip (例: whisper-bin-x64.zip) を解凍した\n' +
          '中身を丸ごと resources\\whisper\\ にコピーしてください。\n' +
          'whisper.dll / ggml*.dll などが exe と同じフォルダに必要です。',
        ));
        return;
      }
      reject(new Error(`whisper exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}

interface WhisperJson {
  result?: { language?: string };
  transcription?: Array<{
    text?: string;
    offsets?: { from?: number; to?: number };
  }>;
}

/** Simple sequential job queue. */
type Job = { callId: string; opts: TranscribeOptions };
type JobHandlers = {
  onStart: (callId: string) => void;
  onProgress: (callId: string, stage: TranscribeStage, percent: number) => void;
  onDone: (callId: string, t: CallTranscript) => void;
  onCancelled: (callId: string) => void;
  onError: (callId: string, err: Error) => void;
  /** キューが完全に空になった（running フラグ解除後）。サマリー表示の最終クリア用 */
  onIdle: () => void;
};

const queue: Job[] = [];
let running = false;
let handlers: JobHandlers | null = null;
let currentJob: { callId: string; token: { cancelled: boolean; kill: (() => void) | null } } | null = null;
/** enqueue 前の一瞬にキャンセルされた場合の記録（enqueue 時に照合して即キャンセル扱いにする） */
const cancelledBeforeEnqueue = new Set<string>();

export function setQueueHandlers(h: JobHandlers): void {
  handlers = h;
}

/** 待機中・実行中のいずれかに存在するか（二重開始の防止用） */
export function isActive(callId: string): boolean {
  return currentJob?.callId === callId || queue.some((j) => j.callId === callId);
}

export function enqueue(callId: string, opts: TranscribeOptions): void {
  // ステータス表示直後（enqueue 前）にキャンセルされていたら投入しない
  // （キャンセル時の onCancelled は cancel() 側で通知済み）
  if (cancelledBeforeEnqueue.delete(callId)) return;
  // 同じ記録の二重投入は無視する
  if (isActive(callId)) return;
  queue.push({ callId, opts });
  void pump();
}

/**
 * キャンセル。待機中ならキューから除去、実行中ならプロセスを kill する。
 * まだ enqueue されていない（楽観的ステータス表示のみの）場合も予約キャンセルする。
 */
export function cancel(callId: string): boolean {
  const idx = queue.findIndex((j) => j.callId === callId);
  if (idx >= 0) {
    queue.splice(idx, 1);
    handlers?.onCancelled(callId);
    return true;
  }
  if (currentJob && currentJob.callId === callId) {
    currentJob.token.cancelled = true;
    currentJob.token.kill?.();
    return true;
  }
  // enqueue 前の競合: 予約キャンセルとして記録し、即キャンセル済み扱いにする
  cancelledBeforeEnqueue.add(callId);
  handlers?.onCancelled(callId);
  return true;
}

async function pump(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const job = queue.shift()!;
      const token = { cancelled: false, kill: null as (() => void) | null };
      currentJob = { callId: job.callId, token };
      handlers?.onStart(job.callId);
      try {
        const t = await transcribe(job.opts, (stage, p) => handlers?.onProgress(job.callId, stage, p), token);
        handlers?.onDone(job.callId, t);
      } catch (err) {
        if (err instanceof TranscriptionCancelledError || token.cancelled) {
          handlers?.onCancelled(job.callId);
        } else {
          handlers?.onError(job.callId, err as Error);
        }
      } finally {
        currentJob = null;
      }
    }
  } finally {
    running = false;
    // running 解除後に通知することで、待機数の計算が正しく 0 になる
    handlers?.onIdle();
  }
}

export function queueLength(): number {
  return queue.length + (running ? 1 : 0);
}

/** アプリ終了時: キューを破棄し、実行中の whisper プロセスを確実に落とす */
export function shutdownQueue(): void {
  queue.length = 0;
  if (currentJob) {
    currentJob.token.cancelled = true;
    currentJob.token.kill?.();
  }
}
