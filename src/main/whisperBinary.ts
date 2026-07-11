import { promises as fs, createWriteStream } from 'node:fs';
import path from 'node:path';
import { app, net } from 'electron';
import extract from 'extract-zip';
import { logInfo } from './log';

/**
 * whisper.cpp の Windows ビルド（zip）を GitHub Release から取得し、
 * userData/whisper に展開する。リリースごとに資産名が揺れるため、
 * 候補 URL を順に試す。
 */

const RELEASE_BASE = 'https://github.com/ggerganov/whisper.cpp/releases/download';

/** 上から順に試す。BLAS 版（CPU 最適化）を優先 */
const CANDIDATE_ASSETS = [
  'v1.7.4/whisper-blas-bin-x64.zip',
  'v1.7.4/whisper-bin-x64.zip',
  'v1.7.2/whisper-blas-bin-x64.zip',
  'v1.7.2/whisper-bin-x64.zip',
  'v1.5.5/whisper-blas-bin-x64.zip',
  'v1.5.4/whisper-blas-bin-x64.zip',
];

export function getUserWhisperDir(): string {
  return path.join(app.getPath('userData'), 'whisper');
}

export async function isBinaryInstalled(): Promise<boolean> {
  try {
    await fs.access(path.join(getUserWhisperDir(), 'whisper-cli.exe'));
    return true;
  } catch {
    return false;
  }
}

export interface BinDownloadProgress {
  receivedBytes: number;
  totalBytes: number | null;
}

function downloadTo(url: string, dest: string, onProgress: (p: BinDownloadProgress) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const req = net.request({ url, method: 'GET', redirect: 'follow' });
    req.on('response', (res) => {
      const status = res.statusCode;
      if (status !== 200) {
        res.on('data', () => {});
        reject(new Error(`HTTP ${status}`));
        return;
      }
      const lenHdr = res.headers['content-length'];
      const lenStr = Array.isArray(lenHdr) ? lenHdr[0] : lenHdr;
      const total = lenStr ? Number(lenStr) : null;
      let received = 0;
      const out = createWriteStream(dest);
      let failed = false;
      res.on('data', (chunk: Buffer) => {
        if (failed) return;
        received += chunk.length;
        onProgress({ receivedBytes: received, totalBytes: total });
        out.write(chunk);
      });
      res.on('end', () => {
        if (failed) return;
        out.end(() => resolve());
      });
      res.on('error', (err: Error) => { failed = true; out.destroy(); reject(err); });
      out.on('error', (err) => { failed = true; reject(err); });
    });
    req.on('error', reject);
    req.end();
  });
}

/** zip 内の実行ファイルを whisper-cli.exe に揃える（古いビルドは main.exe） */
async function normalizeExecutable(dir: string): Promise<void> {
  const cli = path.join(dir, 'whisper-cli.exe');
  try {
    await fs.access(cli);
    return;
  } catch { /* fall through */ }
  // サブフォルダ展開のケースも走査する
  const candidates: string[] = [];
  const walk = async (d: string, depth: number): Promise<void> => {
    if (depth > 2) return;
    for (const entry of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) await walk(p, depth + 1);
      else if (/^(whisper-cli|main)\.exe$/i.test(entry.name)) candidates.push(p);
    }
  };
  await walk(dir, 0);
  if (candidates.length === 0) {
    throw new Error('zip 内に whisper-cli.exe / main.exe が見つかりませんでした');
  }
  // 実行ファイルがサブフォルダにある場合は、その階層の全ファイルを直下へ移動
  const found = candidates.find((p) => /whisper-cli\.exe$/i.test(p)) ?? candidates[0];
  const foundDir = path.dirname(found);
  if (foundDir !== dir) {
    for (const entry of await fs.readdir(foundDir)) {
      await fs.rename(path.join(foundDir, entry), path.join(dir, entry)).catch(() => {});
    }
  }
  try {
    await fs.access(cli);
  } catch {
    await fs.copyFile(path.join(dir, 'main.exe'), cli);
  }
}

export async function downloadWhisperBinary(
  onProgress: (p: BinDownloadProgress & { step: 'download' | 'extract' }) => void,
): Promise<void> {
  const dir = getUserWhisperDir();
  await fs.mkdir(dir, { recursive: true });
  const tmpZip = path.join(app.getPath('temp'), `whisper-bin-${Date.now()}.zip`);

  let lastError: Error | null = null;
  let downloaded = false;
  for (const asset of CANDIDATE_ASSETS) {
    const url = `${RELEASE_BASE}/${asset}`;
    try {
      logInfo('whisperbin', `trying ${url}`);
      await downloadTo(url, tmpZip, (p) => onProgress({ ...p, step: 'download' }));
      downloaded = true;
      logInfo('whisperbin', `downloaded ${asset}`);
      break;
    } catch (err) {
      lastError = err as Error;
      logInfo('whisperbin', `failed ${asset}: ${(err as Error).message}`);
    }
  }
  if (!downloaded) {
    throw new Error(
      `whisper.cpp のダウンロードに失敗しました (${lastError?.message ?? '不明'})。` +
      'ネットワークを確認するか、README の手順で手動配置してください。',
    );
  }

  try {
    onProgress({ receivedBytes: 0, totalBytes: null, step: 'extract' });
    await extract(tmpZip, { dir });
    await normalizeExecutable(dir);
    logInfo('whisperbin', `extracted to ${dir}`);
  } finally {
    await fs.unlink(tmpZip).catch(() => {});
  }
}
