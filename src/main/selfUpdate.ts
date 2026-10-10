import { app, net, session } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
// electron のメインプロセスでは node:fs に asar 対応パッチが当たっており、
// パス中に「*.asar」というセグメント（例: resources/app.asar）があると
// アーカイブとして扱われてしまう。展開先（ステージング先）には配布 zip 由来の
// resources/app.asar が、旧フォルダ(.old)にも入れ替え前の resources/app.asar が
// 含まれるため、そこに触れる書き込み・削除・リネームが「Invalid package」等で
// 失敗する。この対策として、このファイルではモジュール全体で node:fs の代わりに
// asar パッチが当たっていない original-fs を使う。
import originalFs from 'original-fs';
import { extractZip } from './zipExtract';
import { describeNetError } from './whisperBinary';
import { logInfo } from './log';
import type { UpdateCheckResult } from './updates';
import { checkForUpdate } from './updates';
import { planCarryOver, USER_PLACED_RESOURCE_DIRS } from './updateCarryOver';
import { isAllowedUpdateUrl, buildDownloadUrl } from './updateCheckLogic';
import * as updateLeftoverPolicy from './updateLeftoverPolicy';
import { encodeApplyArg, analyzeApplyLog, isBackupDirName } from './updateApplier';
import { notify } from './notifications';

const fs = originalFs.promises;
const { createReadStream, createWriteStream } = originalFs;

/**
 * Windows 向けの自己更新（ダウンロード → SHA256検証 → 展開 → 新しい版の exe 自身による入れ替え）。
 * electron-builder の "zip" 配布（ポータブル形式、インストーラ不使用）を前提にしている。
 *
 * 実行中の exe・DLL は Windows がロックしているため直接上書きできない。そこで:
 *   1. 新バージョンを、インストール先フォルダの「隣」（<親>/.callstack-update-staging）に展開しておく
 *   2. 適用時は、展開済みの新しい CallStack.exe を「適用モード」
 *      （--callstack-apply-update=...）で起動してアプリ自身は終了する。
 *      適用モードの exe（updateApplier.ts）が旧プロセスの終了を待ち、インストール先の中身を
 *      フォルダ内の退避フォルダ .callstack-old-* へ移し、新しい版の中身をコピーして入れ替える
 *      （インストール先フォルダ自体はリネームしない）。失敗したら元に戻す
 *   3. 次回起動時に、適用結果（update-apply.log）の確認と、退避フォルダ・ステージングの掃除を行う。
 *      手で置いた whisper.cpp の引き継ぎは適用モード側が行う
 *
 * PowerShell は使わない。ウイルス対策ソフトや ASR 規則で隠しウィンドウの PowerShell が
 * 止められる環境では、入れ替えスクリプトが 1 行も実行されず更新が黙って失敗していたため。
 *
 * 「書き込み権限が無い（例: Program Files 配下）」場合は事前チェックで
 * 検知し、自己更新を諦めて手動更新（リリースページを開く）に倒す。
 */

export type SelfUpdateStatus = 'idle' | 'downloading' | 'verifying' | 'extracting' | 'ready' | 'error';

let currentStatus: SelfUpdateStatus = 'idle';
let preparedVersion: string | null = null;
let preparedStagingDir: string | null = null;
/** 準備処理が進行中の場合の Promise。起動時の自動チェックとボタン操作が
 *  同時に走って同じステージングフォルダを取り合わないようにする。 */
let preparingPromise: Promise<boolean> | null = null;

export function getSelfUpdateStatus(): { status: SelfUpdateStatus; version: string | null } {
  return { status: currentStatus, version: preparedVersion };
}

/** この環境で自己更新（自動ダウンロード＆適用）を試みてよいか。開発時・非Windowsでは常に false。 */
export function isSelfUpdateSupported(): boolean {
  return app.isPackaged && process.platform === 'win32';
}

function getInstallDir(): string {
  return path.dirname(process.execPath);
}

function getStagingDir(): string {
  // インストール先と同じ親フォルダ（＝同じドライブ）に置き、
  // 入れ替え時の rename/move が確実かつ高速になるようにする。
  return path.join(path.dirname(getInstallDir()), '.callstack-update-staging');
}

/** 旧版（〜2.10.0 の PowerShell 方式）が作っていた、インストール先の隣の退避フォルダ */
function getOldBackupDir(): string {
  const dir = getInstallDir();
  return `${dir}.old`;
}

/** インストール先の親フォルダに書き込めるか（Program Files 等では不可）を確認する */
async function canWriteNextToInstallDir(): Promise<boolean> {
  const parent = path.dirname(getInstallDir());
  const probe = path.join(parent, `.callstack-write-test-${Date.now()}`);
  try {
    await fs.writeFile(probe, 'ok');
    await fs.unlink(probe);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/** 接続タイムアウト（response が来るまで）。 */
const CONNECT_TIMEOUT_MS = 20_000;
/** アイドルタイムアウト（データが来なくなってから）。 */
const IDLE_TIMEOUT_MS = 30_000;
/** ダウンロードするバイト数の上限。配布元がサイズを知らせてこない場合の歯止め。 */
const MAX_DOWNLOAD_BYTES = 600 * 1024 * 1024;

/** この起動で1回だけ、通信がプロキシを経由するかどうかをログに残したか。 */
let networkEnvironmentLogged = false;

/**
 * 通信がどの経路を通るのかをログに残す（この起動で1回だけ）。会社のネットワークでは
 * プロキシ経由になることが多く、経由するかどうかが分かるだけで切り分けの幅が狭まる。
 * アドレス自体は社内のホスト名の場合があるため、ホストとポートだけを出す。
 */
async function logNetworkEnvironmentOnce(url: string): Promise<void> {
  if (networkEnvironmentLogged) return;
  networkEnvironmentLogged = true;
  try {
    const proxyStr = await session.defaultSession.resolveProxy(url);
    if (!proxyStr || proxyStr.trim().toUpperCase() === 'DIRECT') {
      logInfo('selfupdate', '通信: プロキシを経由しない(DIRECT)');
    } else {
      // "PROXY host:port" 等の先頭要素だけを出す（資格情報は含まれない）。
      const first = proxyStr.split(';')[0]?.trim() ?? proxyStr;
      logInfo('selfupdate', `通信: プロキシを経由する(${first})`);
    }
  } catch (err) {
    logInfo('selfupdate', `通信: 経路を調べられなかった: ${(err as Error).message}`);
  }
}

interface DownloadDiagnosticsResult {
  finalUrl: string;
  contentType: string;
  receivedBytes: number;
}

/**
 * 配布物をダウンロードし、途中経過を詳しくログへ残す。
 *
 * 【なぜ診断を厚くするか】
 * 会社のネットワークで「確認はできるがダウンロードだけ失敗する」という報告があったとき、
 * 原因の切り分けにはここが要る（Pane の docs/調査記録/修正-更新の失敗を追えるようにする.md）。
 *   ・最終URL … github.com は objects.githubusercontent.com 等へ転送される。
 *               転送先だけ許可されていない構成かどうかが分かる
 *   ・状態コード … 403(拒否)・407(プロキシ認証)の区別
 *   ・Content-Type … 中身が zip ではなくプロキシのエラーページにすり替わっていないか
 *                    （text/html なら典型的にそれ）
 *   ・Via … 途中に中継が入っているか
 */
function downloadAssetWithDiagnostics(
  url: string,
  dest: string,
  onProgress: (p: { receivedBytes: number; totalBytes: number | null }) => void,
): Promise<DownloadDiagnosticsResult> {
  return new Promise((resolve, reject) => {
    const currentVersion = app.getVersion();
    let settled = false;
    let received = 0;
    let out: ReturnType<typeof createWriteStream> | null = null;
    let idleTimer: NodeJS.Timeout | null = null;
    let connectTimer: NodeJS.Timeout | null = null;

    const clearTimers = (): void => {
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    };
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      try { req.abort(); } catch { /* noop */ }
      out?.destroy();
      fs.unlink(dest).catch(() => {});
      logInfo('selfupdate', `ダウンロードに失敗: ${describeNetError(err)} (受信済み ${received}バイト)`);
      reject(err);
    };
    const resetIdleTimer = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => fail(new Error('timeout')), IDLE_TIMEOUT_MS);
    };

    const req = net.request({ url, method: 'GET', redirect: 'follow' });
    req.setHeader('Accept', 'application/octet-stream');
    req.setHeader('User-Agent', `CallStack-Updater/${currentVersion}`);

    let finalUrl = url;
    req.on('redirect', (_status, _method, redirectUrl) => {
      finalUrl = redirectUrl;
      logInfo('selfupdate', `ダウンロード: 転送先=${redirectUrl}`);
      req.followRedirect();
    });

    connectTimer = setTimeout(() => fail(new Error('timeout')), CONNECT_TIMEOUT_MS);

    req.on('response', (res) => {
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      const status = res.statusCode;
      const contentType = String(res.headers['content-type'] ?? '(なし)');
      const contentLength = res.headers['content-length'];
      const via = res.headers['via'] ? String(res.headers['via']) : '(なし)';
      logInfo('selfupdate', `ダウンロード: 応答 ${status}, Content-Type=${contentType}, Content-Length=${contentLength ?? '(なし)'}, Via=${via}`);

      if (status !== 200) {
        res.on('data', () => {});
        fail(new Error(describeNetError(new Error(`HTTP ${status}`), status)));
        return;
      }
      if (/text\/html/i.test(contentType)) {
        res.on('data', () => {});
        fail(new Error('配布物ではなくWebページが返りました。社内ネットワークのプロキシ等で差し替えられている可能性があります'));
        return;
      }

      const lenStr = Array.isArray(contentLength) ? contentLength[0] : contentLength;
      const total = lenStr ? Number(lenStr) : null;
      out = createWriteStream(dest);
      resetIdleTimer();
      res.on('data', (chunk: Buffer) => {
        if (settled) return;
        received += chunk.length;
        if (received > MAX_DOWNLOAD_BYTES) {
          fail(new Error(`配布物が想定より大きいためダウンロードを中止しました(上限${MAX_DOWNLOAD_BYTES}バイト)`));
          return;
        }
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
        out!.end(() => resolve({ finalUrl, contentType, receivedBytes: received }));
      });
      res.on('aborted', () => fail(new Error('ダウンロードが途中で途切れました')));
      res.on('error', (err: Error) => fail(err));
      out.on('error', (err) => fail(err));
    });
    req.on('error', (err) => fail(err));
    req.end();
  });
}

/**
 * 更新の準備（ダウンロード→検証→展開）を行う。成功すると次回の適用が
 * 可能になる。失敗しても録音・記録には一切影響しない（通知のみに倒す）。
 */
export async function prepareUpdate(
  result: UpdateCheckResult,
  onStatus: (s: { status: SelfUpdateStatus; receivedBytes?: number; totalBytes?: number | null; error?: string }) => void,
): Promise<boolean> {
  // 既に同じ準備処理が進行中なら、新たに並走させず同じ Promise を返す
  // （起動時の自動チェックと「今すぐ更新」ボタンが同時に走るケースへの対策）。
  if (preparingPromise) {
    logInfo('selfupdate', 'prepare already in progress — reusing in-flight promise');
    return preparingPromise;
  }
  // 既に同じバージョンが準備済み（ready）なら再ダウンロードしない。
  if (currentStatus === 'ready' && preparedVersion === result.latest && preparedStagingDir) {
    onStatus({ status: 'ready' });
    return true;
  }
  const task = prepareUpdateInner(result, onStatus);
  preparingPromise = task;
  try {
    return await task;
  } finally {
    preparingPromise = null;
  }
}

async function prepareUpdateInner(
  result: UpdateCheckResult,
  onStatus: (s: { status: SelfUpdateStatus; receivedBytes?: number; totalBytes?: number | null; error?: string }) => void,
): Promise<boolean> {
  if (!isSelfUpdateSupported()) return false;
  // SHA256 は無くてもよい（API の上限に当たり、ダウンロード URL を規則から組み立てた場合。
  // updates.ts の newerButNoDetails 参照）。無い場合は検証を省いて続行する（下記 VerifyHash 相当）。
  if (!result.assetUrl || !result.latest) {
    logInfo('selfupdate', 'skip: asset url not available from release');
    return false;
  }
  if (!isAllowedUpdateUrl(result.assetUrl, { requireDownloadPrefix: true })) {
    logInfo('selfupdate', `skip: 許可されていないダウンロードURL: ${result.assetUrl}`);
    onStatus({ status: 'error', error: '配布物のURLが正しくありません。リリースページから手動でご確認ください。' });
    currentStatus = 'error';
    return false;
  }
  // 準備を開始する時点で、既存の ready 状態を無効化しておく。
  // これにより、再準備中に古い（既に消えている可能性のある）ステージング
  // フォルダへ apply が実行されてしまうのを防ぐ。
  preparedVersion = null;
  preparedStagingDir = null;
  if (!(await canWriteNextToInstallDir())) {
    logInfo('selfupdate', `skip: no write access next to install dir (${getInstallDir()})`);
    onStatus({ status: 'error', error: 'インストール先フォルダに書き込めません（管理者権限が必要な場所に配置されている可能性があります）' });
    currentStatus = 'error';
    return false;
  }

  const stagingDir = getStagingDir();
  const tmpZip = path.join(app.getPath('temp'), `callstack-update-${Date.now()}.zip`);

  try {
    currentStatus = 'downloading';
    onStatus({ status: 'downloading', receivedBytes: 0, totalBytes: null });
    logInfo('selfupdate', `更新のダウンロード開始: ${result.assetUrl}`);
    await logNetworkEnvironmentOnce(result.assetUrl);
    await downloadAssetWithDiagnostics(result.assetUrl, tmpZip, (p) => {
      onStatus({ status: 'downloading', receivedBytes: p.receivedBytes, totalBytes: p.totalBytes });
    });

    currentStatus = 'verifying';
    onStatus({ status: 'verifying' });
    // 配布元が SHA256（digest）を提供していない場合（API の上限で詳細を取れず、URL だけ
    // 組み立てて続行したケース）は照合を省いて続行する。HTTPS で取得している以上そこで
    // 防げるのは転送中の破損だけで、防げないもの（配布元そのものの差し替え）は元々
    // このハッシュでも検出できない、という限界は変わらない（README 参照）。
    if (!result.assetSha256) {
      logInfo('selfupdate', '更新の検証: 配布元がSHA256を提供していないため照合を省いて続行する');
    } else {
      const actualSha256 = await sha256File(tmpZip);
      if (actualSha256.toLowerCase() !== result.assetSha256.toLowerCase()) {
        throw new Error(`SHA256 が一致しません（期待値と異なる配布物です。再ダウンロードしてください）`);
      }
      logInfo('selfupdate', `sha256 verified for v${result.latest}`);
    }

    currentStatus = 'extracting';
    onStatus({ status: 'extracting' });
    // 前回の失敗分が残っていれば掃除してから展開する
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(stagingDir, { recursive: true });
    try {
      await extractZip(tmpZip, stagingDir, originalFs);
    } catch (err) {
      // 技術的な詳細はログへ、利用者への表示は日本語の文言にまとめる。
      const detail = (err as Error).message;
      logInfo('selfupdate', `zip 展開に失敗: ${detail}`);
      throw new Error(`更新ファイルの展開に失敗しました: ${detail}`);
    }

    // zip の中身がサブフォルダに包まれている場合（例: CallStack-2.6.0-win-x64/CallStack.exe）は
    // 直下へ引き上げる。既存の whisper.cpp 展開と同じ考え方。
    await flattenIfWrapped(stagingDir);

    // 展開結果に exe が実在するか確認してから "ready" にする
    const exeName = path.basename(process.execPath);
    await fs.access(path.join(stagingDir, exeName));

    preparedVersion = result.latest;
    preparedStagingDir = stagingDir;
    currentStatus = 'ready';
    onStatus({ status: 'ready' });
    logInfo('selfupdate', `prepared v${result.latest} at ${stagingDir}`);
    return true;
  } catch (err) {
    const message = (err as Error).message;
    logInfo('selfupdate', `prepare failed: ${message}`);
    currentStatus = 'error';
    onStatus({ status: 'error', error: message });
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    preparedVersion = null;
    preparedStagingDir = null;
    return false;
  } finally {
    await fs.unlink(tmpZip).catch(() => {});
  }
}

/** zip 展開結果が単一のサブフォルダに包まれていた場合、中身を直下へ引き上げる */
async function flattenIfWrapped(dir: string): Promise<void> {
  const exeName = path.basename(process.execPath);
  try {
    await fs.access(path.join(dir, exeName));
    return; // 既に直下にある
  } catch { /* fall through */ }
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory());
  if (dirs.length !== 1 || entries.length !== 1) return; // 想定外の構造は触らない
  const inner = path.join(dir, dirs[0].name);
  for (const entry of await fs.readdir(inner)) {
    await fs.rename(path.join(inner, entry), path.join(dir, entry));
  }
  await fs.rmdir(inner).catch(() => {});
}

export function hasPreparedUpdate(): boolean {
  return currentStatus === 'ready' && !!preparedStagingDir;
}

/** 適用モードの exe を起動済みか（終了時の適用と「今すぐ再起動」が二重に走らないため）。 */
let applyScriptLaunched = false;

export function isApplyScriptLaunched(): boolean {
  return applyScriptLaunched;
}

function getApplyLogFile(): string {
  return path.join(app.getPath('userData'), 'logs', 'update-apply.log');
}

/**
 * 展開済みの新しい版の exe を、適用モードで起動する（アプリ自身はこの後に終了する）。
 * 起動だけなので速く、終了処理（before-quit）の中から呼んでも終了を待たせない。
 * @param relaunch true なら入れ替え後に新しい版を起動する。false（終了時の適用）なら起動しない。
 */
function launchApplier(relaunch: boolean): ChildProcess {
  if (applyScriptLaunched) {
    throw new Error('更新の適用は既に開始されています');
  }
  if (currentStatus !== 'ready' || !preparedStagingDir || !preparedVersion) {
    throw new Error('適用可能な更新の準備ができていません（再準備中、または未準備の可能性があります）');
  }
  const stagingDir = preparedStagingDir;
  const exeName = path.basename(process.execPath);
  const applierExe = path.join(stagingDir, exeName);
  const logFile = getApplyLogFile();
  try { originalFs.mkdirSync(path.dirname(logFile), { recursive: true }); } catch { /* 適用側でも作る */ }

  const arg = encodeApplyArg({
    installDir: getInstallDir(), stagingDir, oldPid: process.pid,
    relaunch, logFile, version: preparedVersion,
  });
  const child = spawn(applierExe, [arg], {
    detached: true, stdio: 'ignore', windowsHide: true, cwd: stagingDir,
  });
  child.on('error', (err) => logInfo('selfupdate', `apply launch error: ${err.message}`));
  child.unref();
  applyScriptLaunched = true;
  logInfo('selfupdate', `apply launched (applier=staging exe, pid=${process.pid}, target v${preparedVersion}, relaunch=${relaunch})`);
  return child;
}

/**
 * 準備済みの更新を適用する。新しい版の exe を適用モードで起動し、その直後にアプリを終了する
 * （呼び出し側）。実際の入れ替えは、アプリが完全終了した後に適用モードの exe が行う。
 * exe を起動できなかった場合は例外にして、アプリを終了させない。
 */
export async function applyPreparedUpdate(): Promise<void> {
  const child = launchApplier(true);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, 3000); // 'spawn' が来なくても待ち続けない
    child.once('spawn', () => { clearTimeout(timer); resolve(); });
    child.once('error', (err) => {
      clearTimeout(timer);
      applyScriptLaunched = false;
      reject(new Error(`更新用のプログラムを起動できませんでした: ${err.message}`));
    });
  });
}

/**
 * 終了処理の中から呼ぶ版。入れ替えだけを行い、アプリは再起動しない
 * （「あとで（終了時に更新）」と、自動入れ替えONで普通に終了したとき）。
 * 失敗しても終了は妨げない。戻り値は起動できたか。
 */
export function applyPreparedUpdateOnQuit(): boolean {
  try {
    launchApplier(false);
    return true;
  } catch (err) {
    logInfo('selfupdate', `apply on quit failed: ${(err as Error).message}`);
    return false;
  }
}

/**
 * 更新で入れ替えた旧フォルダ(.old)から、利用者が resources\whisper に手で置いた
 * whisper.cpp（exe・DLL）などを新しいフォルダへ移す。理由は updateCarryOver.ts を参照。
 *
 * 現在の方式では入れ替え（updateApplier.ts）の中で引き継ぐため、これが働くのは
 * 旧方式（〜2.10.0 の PowerShell スクリプト）で入れ替えた直後の初回起動だけ（互換のために残している）。
 *
 * 戻り値: 引き継ぐべきものを取りこぼしていなければ true（.old を消してよい）。
 */
export async function carryOverFromOldInstallDir(): Promise<boolean> {
  if (!isSelfUpdateSupported()) return true;
  const oldDir = getOldBackupDir();
  // resources の位置はインストール先からの相対で求める（通常は "resources"）
  const resourcesRel = path.relative(getInstallDir(), process.resourcesPath);
  let ok = true;
  for (const sub of USER_PLACED_RESOURCE_DIRS) {
    const from = path.join(oldDir, resourcesRel, sub);
    const to = path.join(process.resourcesPath, sub);
    let oldEntries: string[];
    try {
      oldEntries = await fs.readdir(from);
    } catch {
      continue; // .old が無い、または該当フォルダが無い（大多数）
    }
    const newEntries = await fs.readdir(to).catch(() => [] as string[]);
    const moves = planCarryOver(oldEntries, newEntries, true);
    if (moves.length === 0) continue;
    await fs.mkdir(to, { recursive: true }).catch(() => {});
    let moved = 0;
    for (const name of moves) {
      try {
        // .old はインストール先の隣（同じドライブ）なので rename で足りる
        await fs.rename(path.join(from, name), path.join(to, name));
        moved += 1;
      } catch (err) {
        ok = false;
        logInfo('selfupdate', `carry-over of resources\\${sub}\\${name} failed: ${(err as Error).message}`);
      }
    }
    logInfo('selfupdate', `carried over ${moved}/${moves.length} item(s) in resources\\${sub} from ${oldDir}`);
  }
  return ok;
}

/** 退避フォルダ1つを、完了マーカー・経過時間の方針（updateLeftoverPolicy）に従って片付ける。 */
async function cleanupBackupDir(dir: string, markerExists: boolean): Promise<void> {
  let backupAgeMs: number | null = null;
  let currentExeIsNewerThanBackup = false;
  try {
    const [backupStat, exeStat] = await Promise.all([fs.stat(dir), fs.stat(process.execPath)]);
    backupAgeMs = Date.now() - backupStat.mtimeMs;
    currentExeIsNewerThanBackup = exeStat.mtimeMs >= backupStat.mtimeMs;
  } catch { /* 読めなければ null のまま（KeepBackups 側に倒れる） */ }

  const action = updateLeftoverPolicy.decide({ oldInstallDirExists: true, markerExists, backupAgeMs, currentExeIsNewerThanBackup });
  if (action === 'KeepBackups') {
    logInfo('selfupdate', `keep ${dir}: 入れ替えが完了したか確認できないため残す（次回また確認する）`);
    return;
  }
  if (action === 'None') return;
  await fs.rm(dir, { recursive: true, force: true })
    .then(() => logInfo('selfupdate', `cleaned up leftover ${dir} (${action})`))
    .catch((err) => logInfo('selfupdate', `cleanup of ${dir} failed (will retry next launch): ${(err as Error).message}`));
}

/**
 * 前回の適用結果（update-apply.log）を確認し、失敗していたら app.log に要約を残して
 * 利用者に一度だけ知らせる。適用モードの exe は画面を持たないため、失敗はここでしか伝えられない。
 */
async function reportLastApplyResult(): Promise<void> {
  const logFile = getApplyLogFile();
  let text: string;
  try {
    const buf = await fs.readFile(logFile);
    text = buf.subarray(Math.max(0, buf.length - 64 * 1024)).toString('utf-8'); // 末尾だけ読む
  } catch {
    return; // ログが無い＝更新したことが無い
  }
  const summary = analyzeApplyLog(text);
  if (summary.outcome !== 'failed' && summary.outcome !== 'incomplete') return;
  logInfo('selfupdate', `前回の更新の適用は完了しなかった(${summary.outcome}, 開始 ${summary.startedAt ?? '不明'}): ${summary.error ?? '失敗の記録なし'} — 詳細は update-apply.log`);

  // 同じ失敗を毎回知らせないよう、知らせた試行を記録しておく
  const notifiedFile = path.join(path.dirname(logFile), 'update-apply.notified');
  const already = await fs.readFile(notifiedFile, 'utf-8').catch(() => '');
  if (summary.startedAt && already.trim() === summary.startedAt) return;
  notify('更新を適用できませんでした', '更新を適用できませんでした。詳しくはログフォルダの update-apply.log をご覧ください。');
  await fs.writeFile(notifiedFile, summary.startedAt ?? '', 'utf-8').catch(() => {});
}

/**
 * 更新の後始末を起動時に行う（ベストエフォート）。
 *   1. 前回の適用が失敗していたら知らせる
 *   2. インストール先の中の退避フォルダ .callstack-old-* を、完了マーカー（callstack-update.ok）の
 *      有無・経過時間から updateLeftoverPolicy.decide に判断させて削除する。
 *      マーカーが無く古くもない場合は、復旧の材料として残す
 *   3. ステージング（<親>/.callstack-update-staging）を削除する（適用モードの exe が終了済みのため）
 *   4. 旧方式（〜2.10.0）が作っていた隣の <インストール先>.old も同じ方針で片付ける
 */
export async function cleanupOldInstallDir(): Promise<void> {
  if (!isSelfUpdateSupported()) return;
  await reportLastApplyResult().catch((err) => logInfo('selfupdate', `適用結果の確認に失敗: ${(err as Error).message}`));

  const installDir = getInstallDir();
  const markerPath = path.join(installDir, updateLeftoverPolicy.COMPLETION_MARKER_FILE_NAME);
  const markerExists = await fs.access(markerPath).then(() => true).catch(() => false);

  // 2. インストール先の中の退避フォルダ
  const entries = await fs.readdir(installDir, { withFileTypes: true }).catch(() => []);
  const backups = entries.filter((e) => e.isDirectory() && isBackupDirName(e.name));
  for (const e of backups) {
    await cleanupBackupDir(path.join(installDir, e.name), markerExists);
  }

  // 3. ステージング。準備中・準備済みのもの、いま動いている exe が入っているものは消さない
  const stagingDir = getStagingDir();
  const runningFromStaging = path.resolve(process.execPath).toLowerCase().startsWith(path.resolve(stagingDir).toLowerCase() + path.sep);
  if ((currentStatus === 'idle' || currentStatus === 'error') && !runningFromStaging) {
    const hasStaging = await fs.access(stagingDir).then(() => true).catch(() => false);
    if (hasStaging) {
      await fs.rm(stagingDir, { recursive: true, force: true })
        .then(() => logInfo('selfupdate', `cleaned up staging ${stagingDir}`))
        .catch((err) => logInfo('selfupdate', `cleanup of staging failed (will retry next launch): ${(err as Error).message}`));
    }
  }

  // 4. 旧方式の <インストール先>.old
  const oldDir = getOldBackupDir();
  if (await fs.access(oldDir).then(() => true).catch(() => false)) {
    // 手で置いた whisper.cpp を引き継げていないうちは消さない（消すと取り戻せない）
    if (await carryOverFromOldInstallDir()) {
      await cleanupBackupDir(oldDir, markerExists);
    } else {
      logInfo('selfupdate', `keep ${oldDir}: some user-placed files could not be carried over (will retry next launch)`);
    }
  }

  // 退避フォルダがすべて片付いたら、完了マーカーも消す（次回以降のために残さない）
  if (markerExists) {
    const left = (await fs.readdir(installDir).catch(() => [] as string[])).some(isBackupDirName)
      || (await fs.access(oldDir).then(() => true).catch(() => false));
    if (!left) await fs.unlink(markerPath).catch(() => {});
  }
}

/** 「通信を確かめる」で受け取ってみるバイト数。繋がるかどうかを見るのが目的なので、
 *  配布物すべてを落とす必要は無い。 */
const CONNECTION_PROBE_BYTES = 256 * 1024;
/** 「通信を確かめる」の待ち時間の上限。 */
const CONNECTION_CHECK_TIMEOUT_MS = 30_000;

export interface ConnectionCheckResult {
  ok: boolean;
  message: string;
}

/**
 * 配布物の置き場へ実際に接続して、何が返ってくるかをログに残す（Pane U-08 相当）。
 *
 * 【なぜ「更新の確認」と別に要るか】
 * 会社のネットワークで、更新の確認は通るのにダウンロードだけが失敗する、という報告が
 * ありうる。原因を調べるにはそのときのログが要るが、最新版のままでは checkForUpdate が
 * ダウンロード URL の詳細を取りに行かないため、ダウンロードを試す手段そのものが無い。
 * 最新版のままでも通信だけを試せる入口を用意する。
 *
 * 受け取るのは先頭の一部だけで、ファイルは保存しない（更新はしない）。
 */
export async function checkConnection(): Promise<ConnectionCheckResult> {
  logInfo('selfupdate', '更新の通信確認: 開始');

  let downloadUrl: string | undefined;
  try {
    const info = await checkForUpdate();
    downloadUrl = info.assetUrl;
    if (!downloadUrl) {
      // 最新版のとき（または API から詳細を取れなかったとき）はダウンロード URL が無い。
      // 確かめたいのは「配布物の置き場まで通信が届くか」であって更新の要否ではないので、
      // 分かっているタグ（無ければ現在の版）から API を使わずに組み立てる。
      const tag = info.latest ? `v${info.latest}` : `v${app.getVersion()}`;
      downloadUrl = buildDownloadUrl('Yu5rin', 'CallStack', tag);
      logInfo('selfupdate', `更新の通信確認: 配布物のURLを組み立てた(最新版等のため詳細は取っていない): ${downloadUrl}`);
    }
  } catch (err) {
    logInfo('selfupdate', `更新の通信確認: 配布元への問い合わせに失敗: ${(err as Error).message}`);
    return { ok: false, message: `配布元へ問い合わせられませんでした。${describeNetError(err)}` };
  }

  if (!downloadUrl || !isAllowedUpdateUrl(downloadUrl, { requireDownloadPrefix: true })) {
    logInfo('selfupdate', '更新の通信確認: 配布物のURLが分からなかった');
    return { ok: false, message: '配布物の場所が分かりませんでした。問い合わせの段階で止まっています。詳しくはログを確認してください。' };
  }

  logInfo('selfupdate', `更新の通信確認: 配布物へ接続する: ${downloadUrl}`);
  await logNetworkEnvironmentOnce(downloadUrl);

  return new Promise((resolve) => {
    const currentVersion = app.getVersion();
    const req = net.request({ url: downloadUrl!, method: 'GET', redirect: 'follow' });
    req.setHeader('Accept', 'application/octet-stream');
    req.setHeader('User-Agent', `CallStack-Updater/${currentVersion}`);
    let settled = false;
    let received = 0;
    const finish = (result: ConnectionCheckResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { req.abort(); } catch { /* noop */ }
      resolve(result);
    };
    const timer = setTimeout(() => {
      logInfo('selfupdate', `更新の通信確認: ${CONNECTION_CHECK_TIMEOUT_MS / 1000}秒以内に応答がなかった`);
      finish({ ok: false, message: '時間内に応答がありませんでした。' });
    }, CONNECTION_CHECK_TIMEOUT_MS);

    req.on('redirect', (_status, _method, redirectUrl) => {
      logInfo('selfupdate', `更新の通信確認: 転送先=${redirectUrl}`);
      req.followRedirect();
    });
    req.on('response', (res) => {
      const status = res.statusCode;
      const contentType = String(res.headers['content-type'] ?? '(なし)');
      const contentLength = res.headers['content-length'];
      const via = res.headers['via'] ? String(res.headers['via']) : '(なし)';
      logInfo('selfupdate', `更新の通信確認: 応答 ${status}, Content-Type=${contentType}, Content-Length=${contentLength ?? '(なし)'}, Via=${via}`);

      if (status === 403 || status === 407) {
        res.on('data', () => {});
        finish({ ok: false, message: `配布物の置き場から ${status} が返りました。ネットワークの経路で止められている可能性があります。` });
        return;
      }
      if (status < 200 || status >= 300) {
        res.on('data', () => {});
        finish({ ok: false, message: `配布物の置き場から ${status} が返りました。ネットワークの経路で止められている可能性があります。` });
        return;
      }
      if (/text\/html/i.test(contentType)) {
        res.on('data', (chunk: Buffer) => { received += chunk.length; });
        res.on('end', () => finish({ ok: false, message: '配布物ではなくWebページが返りました。ネットワークの経路で差し替えられている可能性があります。' }));
        return;
      }
      res.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received >= CONNECTION_PROBE_BYTES) {
          logInfo('selfupdate', `更新の通信確認: ${received}バイトを受け取れた(先頭のみ。ファイルは保存していない)`);
          finish({ ok: true, message: `配布物の置き場まで届きました（${Math.round(received / 1024)}KBを受け取って確認を終えました）。` });
        }
      });
      res.on('end', () => {
        logInfo('selfupdate', `更新の通信確認: ${received}バイトを受け取れた(先頭のみ。ファイルは保存していない)`);
        if (received <= 0) {
          finish({ ok: false, message: '接続はできましたが、中身を受け取れませんでした。' });
        } else {
          finish({ ok: true, message: `配布物の置き場まで届きました（${Math.round(received / 1024)}KBを受け取って確認を終えました）。` });
        }
      });
      res.on('aborted', () => finish({ ok: false, message: 'ダウンロードが途中で途切れました。' }));
      res.on('error', (err: Error) => finish({ ok: false, message: `配布物の置き場へ接続できませんでした。${describeNetError(err)}` }));
    });
    req.on('error', (err) => finish({ ok: false, message: `配布物の置き場へ接続できませんでした。${describeNetError(err)}` }));
    req.end();
  });
}
