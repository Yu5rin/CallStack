import { app } from 'electron';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import extract from 'extract-zip';
import { downloadTo } from './whisperBinary';
import { logInfo } from './log';
import type { UpdateCheckResult } from './updates';
import { planCarryOver, USER_PLACED_RESOURCE_DIRS } from './updateCarryOver';

/**
 * Windows 向けの自己更新（ダウンロード → SHA256検証 → 展開 → 次回起動時に
 * フォルダごと置き換え）。electron-builder の "zip" 配布（ポータブル形式、
 * インストーラ不使用）を前提にしている。
 *
 * 実行中の exe・DLL は Windows がロックしているため直接上書きできないが、
 * リネームは可能（Chrome・VS Code 等と同じ手法）。そこで:
 *   1. 新バージョンを、インストール先フォルダの「隣」に展開しておく
 *      （同じドライブにするため rename が高速・確実になる）
 *   2. アプリ終了後、外部の PowerShell スクリプトが
 *      旧フォルダ → .old にリネーム → 新フォルダ → 元の名前にリネーム
 *      → 新 exe を起動、という順で入れ替える
 *   3. 失敗したら .old を元に戻すロールバックを行う
 *   4. 次回起動時に残っている .old を掃除する。その前に、利用者が resources\whisper に
 *      手で置いた whisper.cpp を新しいフォルダへ引き継ぐ（carryOverFromOldInstallDir）。
 *      配布 zip には README.txt しか入っていないので、これをしないと更新のたびに消える
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
  if (!result.assetUrl || !result.assetSha256 || !result.latest) {
    logInfo('selfupdate', 'skip: asset url or sha256 not available from release');
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
    await downloadTo(result.assetUrl, tmpZip, (p) => {
      onStatus({ status: 'downloading', receivedBytes: p.receivedBytes, totalBytes: p.totalBytes });
    });

    currentStatus = 'verifying';
    onStatus({ status: 'verifying' });
    const actualSha256 = await sha256File(tmpZip);
    if (actualSha256.toLowerCase() !== result.assetSha256.toLowerCase()) {
      throw new Error(`SHA256 が一致しません（期待値と異なる配布物です。再ダウンロードしてください）`);
    }
    logInfo('selfupdate', `sha256 verified for v${result.latest}`);

    currentStatus = 'extracting';
    onStatus({ status: 'extracting' });
    // 前回の失敗分が残っていれば掃除してから展開する
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(stagingDir, { recursive: true });
    await extract(tmpZip, { dir: stagingDir });

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

/**
 * 準備済みの更新を適用する。PowerShell の入れ替えスクリプトを書き出して
 * 検知プロセス（このアプリ）とは別に起動し、その直後にアプリを終了する。
 * 実際のフォルダ入れ替えはアプリが完全終了した後にスクリプトが行う。
 */
export async function applyPreparedUpdate(): Promise<void> {
  if (currentStatus !== 'ready' || !preparedStagingDir || !preparedVersion) {
    throw new Error('適用可能な更新の準備ができていません（再準備中、または未準備の可能性があります）');
  }
  const installDir = getInstallDir();
  const stagingDir = preparedStagingDir;
  const oldBackupDir = getOldBackupDir();
  const exeName = path.basename(process.execPath);
  const pid = process.pid;
  const scriptPath = path.join(app.getPath('temp'), `callstack-update-apply-${Date.now()}.ps1`);
  const logFile = path.join(app.getPath('userData'), 'logs', 'update-apply.log');

  const ps1 = buildUpdateScript({ installDir, stagingDir, oldBackupDir, exeName, pid, logFile });
  await fs.mkdir(path.dirname(logFile), { recursive: true }).catch(() => {});
  await fs.writeFile(scriptPath, ps1, 'utf-8');

  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptPath],
    { detached: true, stdio: 'ignore', windowsHide: true },
  );
  child.unref();
  logInfo('selfupdate', `apply script launched (pid=${pid}, target v${preparedVersion})`);
}

function buildUpdateScript(opts: {
  installDir: string; stagingDir: string; oldBackupDir: string; exeName: string; pid: number; logFile: string;
}): string {
  const { installDir, stagingDir, oldBackupDir, exeName, pid, logFile } = opts;
  // PowerShell 側の文字列内に紛れ込まないよう、パスはシングルクォートでリテラル化する。
  const esc = (s: string) => s.replace(/'/g, "''");
  return `
$ErrorActionPreference = 'Stop'
$InstallDir = '${esc(installDir)}'
$StagingDir = '${esc(stagingDir)}'
$OldBackupDir = '${esc(oldBackupDir)}'
$ExeName = '${esc(exeName)}'
$ParentPid = ${pid}
$LogFile = '${esc(logFile)}'

function Write-Log($msg) {
  $line = "$(Get-Date -Format o) $msg"
  Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
}

Write-Log "update apply: waiting for pid $ParentPid to exit"

# 旧プロセスの終了を待つ（最大30秒）。安全のため待ちきれなくても続行はする。
$waited = 0
while ((Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) -and ($waited -lt 30)) {
  Start-Sleep -Milliseconds 1000
  $waited += 1
}
Start-Sleep -Milliseconds 1500

# 前回の残骸があれば片付ける（使用中で消せなくても続行）
if (Test-Path -LiteralPath $OldBackupDir) {
  Remove-Item -LiteralPath $OldBackupDir -Recurse -Force -ErrorAction SilentlyContinue
}

$renamedOld = $false
$swapped = $false
try {
  Write-Log "renaming '$InstallDir' -> '$OldBackupDir'"
  Rename-Item -LiteralPath $InstallDir -NewName (Split-Path -Leaf $OldBackupDir) -ErrorAction Stop
  $renamedOld = $true

  Write-Log "moving '$StagingDir' -> '$InstallDir'"
  Move-Item -LiteralPath $StagingDir -Destination $InstallDir -ErrorAction Stop
  $swapped = $true
  Write-Log 'swap succeeded'
}
catch {
  Write-Log "ERROR during swap: $($_.Exception.Message)"
}

# スワップが失敗し、かつ旧フォルダを退避済みの場合だけロールバックする
# （起動そのものの失敗は下のブロックで扱い、ここでは判定しない）
if ($renamedOld -and -not $swapped) {
  Write-Log 'rolling back: restoring original install dir'
  try {
    Rename-Item -LiteralPath $OldBackupDir -NewName (Split-Path -Leaf $InstallDir) -ErrorAction Stop
    Write-Log 'rollback succeeded'
  } catch {
    Write-Log "ROLLBACK FAILED: $($_.Exception.Message)"
  }
}

# 起動はスワップ成否に関わらずベストエフォートで試みる
# （成功時は新版、ロールバック成功時は旧版が $InstallDir に実在する）
# 旧フォルダ(.old)の削除は次回起動時のアプリ本体に任せる（ここで長時間粘らない）
if (Test-Path -LiteralPath (Join-Path $InstallDir $ExeName)) {
  try {
    Start-Process -FilePath (Join-Path $InstallDir $ExeName) -WorkingDirectory $InstallDir
    Write-Log 'relaunched app'
  } catch {
    Write-Log "relaunch failed: $($_.Exception.Message)"
  }
} else {
  Write-Log 'no executable found to relaunch (manual restart required)'
}
`.trimStart();
}

/**
 * 更新で入れ替えた旧フォルダ(.old)から、利用者が resources\whisper に手で置いた
 * whisper.cpp（exe・DLL）などを新しいフォルダへ移す。理由は updateCarryOver.ts を参照。
 *
 * 入れ替えスクリプト（PowerShell）ではなく新しい版の起動時に行うのは、スクリプトは
 * 更新「前」の版が書き出すため、そちらを直しても次の更新からしか効かないから。
 * 起動時に行えば、この修正が入る前の版（v2.7.0）からの更新でも引き継げる。
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

/** 前回の更新で残った .old フォルダがあれば、起動時に片付ける（ベストエフォート） */
export async function cleanupOldInstallDir(): Promise<void> {
  if (!isSelfUpdateSupported()) return;
  const oldDir = getOldBackupDir();
  try {
    await fs.access(oldDir);
  } catch {
    return; // 何も残っていない
  }
  // 手で置いた whisper.cpp を引き継げていないうちは消さない（消すと取り戻せない）
  if (!(await carryOverFromOldInstallDir())) {
    logInfo('selfupdate', `keep ${oldDir}: some user-placed files could not be carried over (will retry next launch)`);
    return;
  }
  await fs.rm(oldDir, { recursive: true, force: true })
    .then(() => logInfo('selfupdate', `cleaned up leftover ${oldDir}`))
    .catch((err) => logInfo('selfupdate', `cleanup of ${oldDir} failed (will retry next launch): ${(err as Error).message}`));
}
