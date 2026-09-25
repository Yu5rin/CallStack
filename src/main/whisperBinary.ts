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

/** JSON/API リクエストの全体タイムアウト（応答が来ないまま固まるのを防ぐ） */
const JSON_TIMEOUT_MS = 15_000;
/** ダウンロードの接続タイムアウト（response イベントが来るまで） */
const CONNECT_TIMEOUT_MS = 20_000;
/** ダウンロードのアイドルタイムアウト（データが来なくなってから） */
const IDLE_TIMEOUT_MS = 30_000;

/**
 * ネットワーク系のエラーや HTTP ステータスを、ユーザー向けの日本語メッセージへ変換する。
 * whisperBinary / whisperModels / vosk / updates から共通で利用する。
 */
export function describeNetError(err: unknown, statusCode?: number): string {
  if (typeof statusCode === 'number' && statusCode !== 200) {
    if (statusCode === 404) return 'ファイルが見つかりませんでした (HTTP 404)';
    if (statusCode === 403 || statusCode === 429) {
      return `アクセスが制限されています。しばらくしてから再試行してください (HTTP ${statusCode})`;
    }
    if (statusCode >= 500) return `サーバーでエラーが発生しました (HTTP ${statusCode})`;
    return `ダウンロードに失敗しました (HTTP ${statusCode})`;
  }
  const msg = err instanceof Error ? err.message : String(err ?? '');
  if (/timed?\s*out|タイムアウト/i.test(msg)) {
    return '通信がタイムアウトしました。ネットワーク接続を確認してください';
  }
  if (/ENOTFOUND|ECONNREFUSED|net::ERR_NAME_NOT_RESOLVED|net::ERR_INTERNET_DISCONNECTED|net::ERR_PROXY|net::ERR_CONNECTION_(?!RESET)/i.test(msg)) {
    return 'インターネットに接続できません。ネットワーク接続を確認してください';
  }
  if (/ECONNRESET|EPIPE|net::ERR_CONNECTION_RESET|net::ERR_ABORTED|net::ERR_EMPTY_RESPONSE/i.test(msg)) {
    return '通信が切断されました。ネットワーク接続を確認してください';
  }
  return msg || '不明な通信エラーが発生しました';
}

export function fetchJson<T>(url: string, timeoutMs = JSON_TIMEOUT_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, method: 'GET', redirect: 'follow' });
    req.setHeader('Accept', 'application/vnd.github+json');
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.abort();
      reject(new Error(describeNetError(new Error('timeout'))));
    }, timeoutMs);
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    req.on('response', (res) => {
      let body = '';
      res.on('data', (c: Buffer) => { body += c.toString(); });
      res.on('end', () => {
        finish(() => {
          if (res.statusCode !== 200) {
            reject(new Error(describeNetError(new Error(`HTTP ${res.statusCode}`), res.statusCode)));
            return;
          }
          try { resolve(JSON.parse(body) as T); } catch (err) { reject(new Error(describeNetError(err))); }
        });
      });
      res.on('aborted', () => finish(() => reject(new Error(describeNetError(new Error('aborted'))))));
      res.on('error', (err: Error) => finish(() => reject(new Error(describeNetError(err)))));
    });
    req.on('error', (err) => finish(() => reject(new Error(describeNetError(err)))));
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
    let settled = false;
    let idleTimer: NodeJS.Timeout | null = null;
    let out: ReturnType<typeof createWriteStream> | null = null;

    // response イベントが来るまでの接続タイムアウト
    let connectTimer: NodeJS.Timeout | null = setTimeout(() => {
      fail(new Error(describeNetError(new Error('timeout'))));
    }, CONNECT_TIMEOUT_MS);

    function clearTimers(): void {
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    }

    function fail(err: Error): void {
      if (settled) return;
      settled = true;
      clearTimers();
      try { req.abort(); } catch { /* noop */ }
      out?.destroy();
      // 不完全な部分ファイルを残さない
      fs.unlink(dest).catch(() => {});
      reject(err);
    }

    function resetIdleTimer(): void {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        fail(new Error(describeNetError(new Error('timeout'))));
      }, IDLE_TIMEOUT_MS);
    }

    req.on('response', (res) => {
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      const status = res.statusCode;
      if (status !== 200) {
        res.on('data', () => {});
        fail(new Error(describeNetError(new Error(`HTTP ${status}`), status)));
        return;
      }
      const lenHdr = res.headers['content-length'];
      const lenStr = Array.isArray(lenHdr) ? lenHdr[0] : lenHdr;
      // 圧縮転送(content-encoding)時は Content-Length が圧縮後のサイズで、受信バイト数
      // （展開後）と一致しないため、完全性の照合には使わない
      const encHdr = res.headers['content-encoding'];
      const encoded = !!(Array.isArray(encHdr) ? encHdr[0] : encHdr) && !/^identity$/i.test(String(encHdr));
      const total = lenStr && !encoded ? Number(lenStr) : null;
      let received = 0;
      out = createWriteStream(dest);
      resetIdleTimer();
      res.on('data', (chunk: Buffer) => {
        if (settled) return;
        received += chunk.length;
        resetIdleTimer();
        onProgress({ receivedBytes: received, totalBytes: total });
        out!.write(chunk);
      });
      res.on('end', () => {
        if (settled) return;
        if (total !== null && received !== total) {
          fail(new Error('ダウンロードが途中で途切れました'));
          return;
        }
        clearTimers();
        settled = true;
        out!.end(() => resolve());
      });
      res.on('aborted', () => fail(new Error('ダウンロードが途中で途切れました')));
      res.on('error', (err: Error) => fail(new Error(describeNetError(err))));
      out.on('error', (err) => fail(new Error(describeNetError(err))));
    });
    req.on('error', (err) => fail(new Error(describeNetError(err))));
    req.end();
  });
}

/**
 * 展開結果を整える。zip の構造（サブフォルダ入り・exe と DLL が別階層など）に
 * 関わらず、exe・DLL を含む全ファイルを dir 直下へ集約（フラット化）する。
 * whisper-cli.exe は依存 DLL（whisper.dll / ggml*.dll / openblas.dll 等）を
 * 自分と同じフォルダから読むため、これらが同居していないと 0xC0000135 になる。
 */
async function normalizeExecutable(dir: string): Promise<void> {
  // 1. サブフォルダも含め全ファイルを収集
  const files: string[] = [];
  const walk = async (d: string, depth: number): Promise<void> => {
    if (depth > 5) return;
    for (const entry of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) await walk(p, depth + 1);
      else files.push(p);
    }
  };
  await walk(dir, 0);

  // 2. すべて dir 直下へ移動（exe と DLL を必ず同居させる）
  for (const f of files) {
    const dest = path.join(dir, path.basename(f));
    if (path.resolve(f) === path.resolve(dest)) continue;
    await fs.rename(f, dest).catch(async () => {
      // 別ドライブ等で rename できない場合はコピー
      await fs.copyFile(f, dest).catch(() => {});
    });
  }

  // 3. 空になったサブフォルダを掃除
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      await fs.rm(path.join(dir, entry.name), { recursive: true, force: true }).catch(() => {});
    }
  }

  // 4. whisper-cli.exe を用意（古いビルドは main.exe）
  const cli = path.join(dir, 'whisper-cli.exe');
  try {
    await fs.access(cli);
  } catch {
    const mainExe = path.join(dir, 'main.exe');
    try {
      await fs.access(mainExe);
      await fs.copyFile(mainExe, cli);
    } catch {
      throw new Error('zip 内に whisper-cli.exe / main.exe が見つかりませんでした');
    }
  }
}

/**
 * 検証済みの staging ディレクトリを target の位置へ入れ替える。
 * target を一時バックアップへ退避 → staging を target にリネームする流れにし、
 * 万一 staging への切り替えに失敗しても target を元の状態へ復元する
 * （オフライン時の再ダウンロード失敗で既存インストールを壊さないため）。
 */
export async function swapStagingDir(target: string, staging: string): Promise<void> {
  const backup = `${target}.bak`;
  await fs.rm(backup, { recursive: true, force: true }).catch(() => {});
  let hadOld = false;
  try {
    await fs.rename(target, backup);
    hadOld = true;
  } catch {
    hadOld = false;
  }
  try {
    await fs.rename(staging, target);
  } catch {
    // 別ドライブ等で rename できない場合はコピーで代替
    try {
      await fs.mkdir(target, { recursive: true });
      const copyDir = async (src: string, dst: string): Promise<void> => {
        for (const entry of await fs.readdir(src, { withFileTypes: true })) {
          const s = path.join(src, entry.name);
          const d = path.join(dst, entry.name);
          if (entry.isDirectory()) {
            await fs.mkdir(d, { recursive: true });
            await copyDir(s, d);
          } else {
            await fs.copyFile(s, d);
          }
        }
      };
      await copyDir(staging, target);
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    } catch (copyErr) {
      // 入れ替えに失敗した場合は旧インストールを復元する
      await fs.rm(target, { recursive: true, force: true }).catch(() => {});
      if (hadOld) await fs.rename(backup, target).catch(() => {});
      throw copyErr;
    }
  }
  await fs.rm(backup, { recursive: true, force: true }).catch(() => {});
}

export async function downloadWhisperBinary(
  onProgress: (p: BinDownloadProgress & { step: 'download' | 'extract' }) => void,
  variant: BinaryVariant = 'cpu',
): Promise<void> {
  const dir = getUserWhisperDir(variant);
  // 既存の作業ディレクトリはダウンロード完了・検証後にのみ置き換える。
  // オフライン等でダウンロードに失敗しても、既存の動作中インストールを壊さない。
  const staging = `${dir}.staging`;
  await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(staging, { recursive: true });
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
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    await fs.unlink(tmpZip).catch(() => {});
    throw new Error(
      `whisper.cpp のダウンロードに失敗しました (${lastError?.message ?? '不明'})。` +
      'ネットワークを確認するか、README の手順で手動配置してください。',
    );
  }

  try {
    onProgress({ receivedBytes: 0, totalBytes: null, step: 'extract' });
    await extract(tmpZip, { dir: staging });
    await normalizeExecutable(staging);
    // 展開結果を検証（exe が存在しない不完全な展開を「配置済み」にしない）
    await fs.access(path.join(staging, 'whisper-cli.exe'));
    await swapStagingDir(dir, staging);
    logInfo('whisperbin', `extracted to ${dir}`);
  } catch (err) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw err;
  } finally {
    await fs.unlink(tmpZip).catch(() => {});
  }
}
