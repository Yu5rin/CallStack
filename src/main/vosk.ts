import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app, utilityProcess, UtilityProcess } from 'electron';
import extract from 'extract-zip';
import { logInfo } from './log';
import { downloadTo, fetchJson, BinDownloadProgress } from './whisperBinary';

/**
 * Vosk によるライブ文字起こし。
 *
 * - libvosk.dll（vosk-api の Windows ビルド）を koffi (FFI) で呼ぶが、
 *   FFI は専用の utilityProcess（electron/voskWorker.cjs）に隔離する。
 *   ネイティブ側のクラッシュは try/catch では防げず main プロセスごと
 *   落としてしまうため、別プロセスにするのが唯一の安全策。
 * - 公式 npm パッケージは ffi-napi 依存で新しい Electron では動かないため使わない。
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
// libvosk.dll の FFI 呼び出しは専用の utilityProcess（electron/voskWorker.cjs）に
// 隔離する。ネイティブ側がクラッシュしてもワーカーが落ちるだけで、
// アプリ本体・録音には影響しない（exit を検知してエラー通知する）。

export interface LiveSegment {
  text: string;
  final: boolean;
}

export interface LiveHandlers {
  onSegment: (seg: LiveSegment) => void;
  /** ワーカーの異常終了・認識エラー（セッションは継続不能） */
  onError: (message: string) => void;
}

interface WorkerMsg {
  type: 'ready' | 'started' | 'segment' | 'stopped' | 'unloaded' | 'error';
  text?: string | null;
  final?: boolean;
  message?: string;
}

let worker: UtilityProcess | null = null;
let sessionActive = false;
let handlers: LiveHandlers | null = null;
let startWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;
let stopWaiter: ((text: string | null) => void) | null = null;

function workerPath(): string {
  // 開発時: <プロジェクト>/electron/voskWorker.cjs
  // パッケージ時: app.asar/electron/voskWorker.cjs（__dirname は dist-electron/main）
  return path.join(__dirname, '../../electron/voskWorker.cjs');
}

function spawnWorker(): UtilityProcess {
  if (worker) return worker;
  const w = utilityProcess.fork(workerPath(), [], { serviceName: 'vosk-live', stdio: 'pipe' });
  w.stdout?.on('data', (d: Buffer) => logInfo('vosk', `[worker] ${String(d).trim()}`));
  w.stderr?.on('data', (d: Buffer) => logInfo('vosk', `[worker:err] ${String(d).trim()}`));
  w.on('message', (raw: unknown) => {
    const msg = raw as WorkerMsg;
    switch (msg.type) {
      case 'started':
        startWaiter?.resolve();
        startWaiter = null;
        break;
      case 'segment':
        if (sessionActive && typeof msg.text === 'string') {
          handlers?.onSegment({ text: msg.text, final: !!msg.final });
        }
        break;
      case 'stopped':
        stopWaiter?.(msg.text ?? null);
        stopWaiter = null;
        break;
      case 'error': {
        const message = msg.message ?? '不明なエラー';
        logInfo('vosk', `worker error: ${message}`);
        if (startWaiter) {
          startWaiter.reject(new Error(message));
          startWaiter = null;
        } else if (stopWaiter) {
          stopWaiter(null);
          stopWaiter = null;
        } else if (sessionActive) {
          sessionActive = false;
          handlers?.onError(message);
        }
        break;
      }
    }
  });
  w.on('exit', (code: number) => {
    logInfo('vosk', `worker exited (code=${code})`);
    worker = null;
    if (startWaiter) {
      startWaiter.reject(new Error(`ライブ認識プロセスが起動できませんでした (code=${code})`));
      startWaiter = null;
    }
    if (stopWaiter) {
      stopWaiter(null);
      stopWaiter = null;
    }
    if (sessionActive) {
      sessionActive = false;
      handlers?.onError(`ライブ認識プロセスが異常終了しました (code=${code})`);
    }
  });
  worker = w;
  logInfo('vosk', `worker spawned (${workerPath()})`);
  return w;
}

/** ライブ認識セッションを開始する（モデルはワーカー内で初回のみロードし、以後キャッシュ） */
export async function startLive(modelId: VoskModelId, h: LiveHandlers): Promise<void> {
  const dllPath = await findDll(getVoskDir());
  if (!dllPath) throw new Error('Vosk エンジンが未インストールです');
  const modelRoot = await findModelRoot(getVoskModelDir(modelId));
  if (!modelRoot) throw new Error(`Vosk モデル '${modelId}' が未インストールです`);

  const w = spawnWorker();
  handlers = h;
  await new Promise<void>((resolve, reject) => {
    // モデルロードは大きいモデルで数十秒〜数分かかることがある
    const timer = setTimeout(() => {
      if (startWaiter) {
        startWaiter = null;
        reject(new Error('Vosk の初期化がタイムアウトしました'));
      }
    }, 5 * 60 * 1000);
    startWaiter = {
      resolve: () => { clearTimeout(timer); resolve(); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    };
    w.postMessage({ type: 'start', dllPath, modelDir: modelRoot });
  });
  sessionActive = true;
  logInfo('vosk', `live session ready (model=${modelId})`);
}

/** 16kHz/mono/Int16 PCM を投入する（ワーカー側で到着順に処理される） */
export function feedPcm(buf: Buffer): void {
  if (!sessionActive || !worker) return;
  worker.postMessage({ type: 'pcm', data: buf });
}

/** セッションを終了し、末尾の確定テキストを返す */
export async function stopLive(): Promise<string | null> {
  if (!sessionActive || !worker) {
    sessionActive = false;
    return null;
  }
  sessionActive = false;
  const w = worker;
  return new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => {
      if (stopWaiter) {
        stopWaiter = null;
        resolve(null);
      }
    }, 10 * 1000);
    stopWaiter = (text) => { clearTimeout(timer); resolve(text); };
    w.postMessage({ type: 'stop' });
  });
}

/** モデルをメモリから解放する（設定でライブを無効化したときなど） */
export function unloadModel(): void {
  worker?.postMessage({ type: 'unload' });
}

/** アプリ終了時: ワーカープロセスを残さない */
export function shutdownVosk(): void {
  sessionActive = false;
  handlers = null;
  if (worker) {
    worker.kill();
    worker = null;
  }
}
