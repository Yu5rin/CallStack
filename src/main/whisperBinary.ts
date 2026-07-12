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
const RELEASES_API = 'https://api.github.com/repos/ggerganov/whisper.cpp/releases?per_page=10';

/**
 * GitHub API が使えない場合のフォールバック候補（上から順に試す）。
 * リリースごとに資産名が揺れるため、実行時は API で動的に解決するのが第一。
 */
const FALLBACK_ASSETS = [
  'v1.5.5/whisper-blas-bin-x64.zip',
  'v1.5.5/whisper-bin-x64.zip',
  'v1.5.4/whisper-blas-bin-x64.zip',
  'v1.5.4/whisper-bin-x64.zip',
  'v1.7.4/whisper-bin-x64.zip',
  'v1.7.2/whisper-bin-x64.zip',
];

export type BinaryVariant = 'cpu' | 'gpu';

/** Windows 用ビルドとして採用する資産名（優先順） */
const ASSET_PATTERNS: Record<BinaryVariant, RegExp[]> = {
  cpu: [
    /^whisper-blas-bin-x64\.zip$/i,     // CPU + OpenBLAS（速い）
    /^whisper-bin-x64\.zip$/i,          // CPU 汎用
    /^whisper-.*bin.*x64.*\.zip$/i,     // 名前が変わった場合の保険
  ],
  gpu: [
    /^whisper-cublas-[\d.]+-bin-x64\.zip$/i,  // NVIDIA CUDA 版
    /^whisper-cuda.*bin.*x64.*\.zip$/i,
  ],
};

export function fetchJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, method: 'GET', redirect: 'follow' });
    req.setHeader('Accept', 'application/vnd.github+json');
    req.on('response', (res) => {
      let body = '';
      res.on('data', (c: Buffer) => { body += c.toString(); });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        try { resolve(JSON.parse(body) as T); } catch (err) { reject(err as Error); }
      });
      res.on('error', (err: Error) => reject(err));
    });
    req.on('error', reject);
    req.end();
  });
}

interface GhRelease {
  tag_name: string;
  prerelease: boolean;
  assets: Array<{ name: string; browser_download_url: string }>;
}

/** 最近のリリースから Windows x64 ビルドのダウンロード URL を解決する */
async function resolveAssetUrls(variant: BinaryVariant): Promise<string[]> {
  try {
    const releases = await fetchJson<GhRelease[]>(RELEASES_API);
    const urls: string[] = [];
    for (const pattern of ASSET_PATTERNS[variant]) {
      for (const rel of releases) {
        if (rel.prerelease) continue;
        const asset = rel.assets.find((a) => {
          if (!pattern.test(a.name)) return false;
          if (/arm|win32/i.test(a.name)) return false;
          // CPU 版検索時は GPU 資産を誤って掴まない
          if (variant === 'cpu' && /cublas|cuda|vulkan/i.test(a.name)) return false;
          return true;
        });
        if (asset) urls.push(asset.browser_download_url);
      }
    }
    if (urls.length > 0) {
      logInfo('whisperbin', `resolved ${urls.length} ${variant} assets via GitHub API`);
      return [...new Set(urls)];
    }
  } catch (err) {
    logInfo('whisperbin', `GitHub API failed: ${(err as Error).message} — using fallback list`);
  }
  if (variant === 'gpu') {
    return [
      `${RELEASE_BASE}/v1.5.5/whisper-cublas-12.2.0-bin-x64.zip`,
      `${RELEASE_BASE}/v1.5.4/whisper-cublas-12.2.0-bin-x64.zip`,
    ];
  }
  return FALLBACK_ASSETS.map((a) => `${RELEASE_BASE}/${a}`);
}

export function getUserWhisperDir(variant: BinaryVariant = 'cpu'): string {
  return path.join(app.getPath('userData'), variant === 'gpu' ? 'whisper-gpu' : 'whisper');
}

export async function isBinaryInstalled(variant: BinaryVariant = 'cpu'): Promise<boolean> {
  try {
    await fs.access(path.join(getUserWhisperDir(variant), 'whisper-cli.exe'));
    return true;
  } catch {
    return false;
  }
}

export interface BinDownloadProgress {
  receivedBytes: number;
  totalBytes: number | null;
}

export function downloadTo(url: string, dest: string, onProgress: (p: BinDownloadProgress) => void): Promise<void> {
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
  variant: BinaryVariant = 'cpu',
): Promise<void> {
  const dir = getUserWhisperDir(variant);
  await fs.mkdir(dir, { recursive: true });
  const tmpZip = path.join(app.getPath('temp'), `whisper-bin-${Date.now()}.zip`);

  const urls = await resolveAssetUrls(variant);
  let lastError: Error | null = null;
  let downloaded = false;
  for (const url of urls) {
    try {
      logInfo('whisperbin', `trying ${url}`);
      await downloadTo(url, tmpZip, (p) => onProgress({ ...p, step: 'download' }));
      downloaded = true;
      logInfo('whisperbin', `downloaded ${url}`);
      break;
    } catch (err) {
      lastError = err as Error;
      logInfo('whisperbin', `failed ${url}: ${(err as Error).message}`);
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
