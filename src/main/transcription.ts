import { spawn } from 'node:child_process';
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

export async function checkSetup(model: WhisperModel): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(await isModelDownloaded(model))) {
    return { ok: false, error: `モデル '${model}' が未ダウンロードです。設定画面からダウンロードしてください。` };
  }
  try {
    await resolveWhisperBin();
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

async function resolveWhisperBin(): Promise<string> {
  // 1. アプリ内ダウンロードで配置されたもの (userData/whisper) を最優先
  const userBin = path.join(getUserWhisperDir(), process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli');
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

export async function transcribe(
  opts: TranscribeOptions,
  onProgress?: (percent: number) => void,
  cancelToken?: { cancelled: boolean; kill: (() => void) | null },
): Promise<CallTranscript> {
  if (!(await isModelDownloaded(opts.model))) {
    throw new Error(`モデル '${opts.model}' が未ダウンロードです。設定画面からダウンロードしてください。`);
  }
  const bin = await resolveWhisperBin();
  const modelPath = getModelPath(opts.model);
  const baseTmp = path.join(app.getPath('temp'), `tts-${Date.now()}`);
  const wavPath = baseTmp + '.wav';
  const outBase = baseTmp;

  await convertMp3ToWav16k(opts.audioPath, wavPath);
  if (cancelToken?.cancelled) {
    await fs.unlink(wavPath).catch(() => {});
    throw new TranscriptionCancelledError();
  }

  try {
    await runWhisper(bin, modelPath, wavPath, outBase, opts.language, opts.prompt, onProgress, cancelToken);
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
    const args = [
      '-m', model,
      '-f', wav,
      '-of', outBase,
      '-oj',                                  // output JSON with timestamps
      '-l', lang === 'auto' ? 'auto' : lang,
      '-pp',                                  // print progress
    ];
    if (prompt && prompt.trim()) {
      args.push('--prompt', prompt.trim());
    }
    const proc = spawn(bin, args);
    if (cancelToken) cancelToken.kill = () => proc.kill();
    let stderr = '';
    proc.stderr.on('data', (d) => {
      const text = d.toString();
      stderr += text;
      // whisper.cpp -pp: "whisper_print_progress_callback: progress =  15%"
      const matches = text.match(/progress\s*=\s*(\d+)%/g);
      if (matches && onProgress) {
        const last = matches[matches.length - 1].match(/(\d+)%/);
        if (last) onProgress(Math.min(100, Number(last[1])));
      }
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (cancelToken) cancelToken.kill = null;
      if (cancelToken?.cancelled) {
        reject(new TranscriptionCancelledError());
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
  onProgress: (callId: string, percent: number) => void;
  onDone: (callId: string, t: CallTranscript) => void;
  onCancelled: (callId: string) => void;
  onError: (callId: string, err: Error) => void;
};

const queue: Job[] = [];
let running = false;
let handlers: JobHandlers | null = null;
let currentJob: { callId: string; token: { cancelled: boolean; kill: (() => void) | null } } | null = null;

export function setQueueHandlers(h: JobHandlers): void {
  handlers = h;
}

export function enqueue(callId: string, opts: TranscribeOptions): void {
  queue.push({ callId, opts });
  void pump();
}

/**
 * キャンセル。待機中ならキューから除去、実行中ならプロセスを kill する。
 * 対象が見つかったら true。
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
  return false;
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
        const t = await transcribe(job.opts, (p) => handlers?.onProgress(job.callId, p), token);
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
