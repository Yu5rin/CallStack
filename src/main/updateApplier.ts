import path from 'node:path';
import type { promises as NodeFsPromises } from 'node:fs';
import { planCarryOver, USER_PLACED_RESOURCE_DIRS } from './updateCarryOver.ts';
import { COMPLETION_MARKER_FILE_NAME } from './updateLeftoverPolicy.ts';
import { PORTABLE_DATA_DIR_NAME } from './dataLocation.ts';

/**
 * 自動更新の最後の「入れ替え」を行う処理。
 *
 * 【なぜ新しい版の exe 自身が行うか】
 * 以前は PowerShell スクリプトを %TEMP% に書き出して入れ替えていたが、ウイルス対策ソフトや
 * ASR（攻撃面の縮小）規則で隠しウィンドウの PowerShell が止められる環境では、スクリプトが
 * 1行も実行されず、更新が黙って失敗していた。そこで、展開済みの新しい版の CallStack.exe を
 * 「適用モード」（--callstack-apply-update=...）で起動し、その exe 自身が入れ替える。
 * 利用者が普段から起動している exe と同じなので、止められにくい。
 *
 * 【入れ替えの方式】
 * インストール先フォルダ自体はリネームしない（エクスプローラーや AV が掴んでいることがある）。
 * その中に退避フォルダ `.callstack-old-<日時>` を作り、既存の直下の項目をすべてそこへ移し、
 * ステージング（展開済みの新しい版）の中身をインストール先へ「コピー」する
 * （ステージングの exe は実行中のため移動できない）。失敗したら元に戻す。
 *
 * 【データフォルダ `data` は絶対に動かさない】
 * 設定・記録・録音・ログは exe の隣の `data` フォルダにある（dataLocation.ts）。入れ替えでは、
 * インストール先の `data` を退避にも移さず、ステージングに（万一）`data` があっても
 * 上書きせず、ロールバックでも消さない。入れ替えの対象はアプリ本体のファイルだけ。
 *
 * このモジュールは electron に依存せず、ファイル操作は注入された fs（本番は original-fs）で行う。
 * そのため node:test で素の node:fs を渡して検証できる。
 */

/** 適用モードを示すコマンドライン引数の名前（値は base64url の JSON を 1 トークンで渡す）。 */
export const APPLY_SWITCH_NAME = '--callstack-apply-update';

/** 退避フォルダ名の接頭辞（インストール先の直下に作る）。 */
export const BACKUP_DIR_PREFIX = '.callstack-old-';

/** ログに書く目印の文言。次回起動時の結果判定（analyzeApplyLog）がこれを読む。 */
export const LOG_APPLY_START = 'apply start';
export const LOG_APPLY_SUCCEEDED = 'apply succeeded';
export const LOG_APPLY_FAILED = 'apply FAILED';

export interface ApplyUpdateArgs {
  installDir: string;
  stagingDir: string;
  oldPid: number;
  relaunch: boolean;
  logFile: string;
  /** 適用する新しい版（完了マーカーに書く）。 */
  version: string;
}

/** 起動引数 1 トークン（`--callstack-apply-update=<base64url>`）を作る。 */
export function encodeApplyArg(args: ApplyUpdateArgs): string {
  const json = JSON.stringify(args);
  return `${APPLY_SWITCH_NAME}=${Buffer.from(json, 'utf-8').toString('base64url')}`;
}

/** argv から適用モードの指定を読む。無い・壊れている場合は null（通常起動として扱う）。 */
export function parseApplyArg(argv: readonly string[]): ApplyUpdateArgs | null {
  const prefix = `${APPLY_SWITCH_NAME}=`;
  const token = argv.find((a) => a.startsWith(prefix));
  if (!token) return null;
  try {
    const raw = JSON.parse(Buffer.from(token.slice(prefix.length), 'base64url').toString('utf-8')) as Partial<ApplyUpdateArgs>;
    if (
      typeof raw.installDir !== 'string' || !raw.installDir ||
      typeof raw.stagingDir !== 'string' || !raw.stagingDir ||
      typeof raw.logFile !== 'string' || !raw.logFile ||
      typeof raw.oldPid !== 'number' || !Number.isInteger(raw.oldPid) || raw.oldPid < 0 ||
      typeof raw.relaunch !== 'boolean' ||
      typeof raw.version !== 'string'
    ) {
      return null;
    }
    return {
      installDir: raw.installDir, stagingDir: raw.stagingDir, oldPid: raw.oldPid,
      relaunch: raw.relaunch, logFile: raw.logFile, version: raw.version,
    };
  } catch {
    return null;
  }
}

/** 適用処理が使うファイル操作。本番は original-fs の promises、テストは node:fs の promises。 */
export type ApplierFs = Pick<
  typeof NodeFsPromises,
  'readdir' | 'mkdir' | 'rename' | 'copyFile' | 'rm' | 'writeFile' | 'appendFile' | 'access'
>;

export interface ApplierDeps {
  fs: ApplierFs;
  /** 旧プロセスの終了を待つ。タイムアウトしても例外にはせず続行する。 */
  waitForPidExit: (pid: number) => Promise<void>;
  /** 待機（テストでは即時に返す）。 */
  sleep: (ms: number) => Promise<void>;
  /** 新しい版の exe を起動する（detached・stdio ignore）。 */
  spawnApp: (exePath: string, cwd: string) => void;
  /** 実行中の exe のファイル名（例: CallStack.exe）。 */
  exeName: string;
  now?: () => Date;
  /** 1 回の操作を再試行する合計時間の上限。既定 60 秒。 */
  retryTotalMs?: number;
}

export interface ApplyResult {
  ok: boolean;
  rolledBack: boolean;
  error?: string;
  backupDir?: string;
}

const RETRYABLE = new Set(['EBUSY', 'EPERM', 'EACCES']);
const RETRY_FIRST_DELAY_MS = 250;
const RETRY_MAX_DELAY_MS = 2000;
export const DEFAULT_RETRY_TOTAL_MS = 60_000;
/** 旧プロセス終了後に、子プロセスや AV のファイル保持が消えるのを待つ時間。 */
const AFTER_EXIT_GRACE_MS = 1000;

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 退避フォルダ名（例: .callstack-old-20261010T123456）。 */
export function makeBackupDirName(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
  return `${BACKUP_DIR_PREFIX}${stamp}`;
}

export function isBackupDirName(name: string): boolean {
  return name.startsWith(BACKUP_DIR_PREFIX);
}

/**
 * 入れ替えの対象外にする項目か（データフォルダ `data`）。
 * Windows ではフォルダ名の大文字小文字を区別しないので、小文字にそろえて比べる。
 */
export function isPreservedEntryName(name: string): boolean {
  return name.toLowerCase() === PORTABLE_DATA_DIR_NAME;
}

/**
 * 旧プロセスの終了を待つ既定の実装。process.kill(pid, 0) は送信せず存在確認だけをする。
 * ESRCH なら終了済み。EPERM は「存在するが権限が無い」＝まだ生きている。
 */
export async function waitForPidExit(
  pid: number,
  opts: {
    timeoutMs?: number; intervalMs?: number;
    kill?: (pid: number, signal: number) => unknown;
    sleep?: (ms: number) => Promise<void>;
    log?: (msg: string) => Promise<void> | void;
  } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const intervalMs = opts.intervalMs ?? 500;
  const kill = opts.kill ?? ((p: number, s: number) => process.kill(p, s));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let waited = 0;
  for (;;) {
    try {
      kill(pid, 0);
    } catch (err) {
      if (errCode(err) === 'ESRCH') return true;
      // EPERM などは生存扱い
    }
    if (waited >= timeoutMs) {
      await opts.log?.(`pid ${pid} still alive after ${timeoutMs}ms — continuing anyway`);
      return false;
    }
    await sleep(intervalMs);
    waited += intervalMs;
  }
}

/**
 * 入れ替えを実行する。成功・失敗にかかわらず例外は投げず結果を返す
 * （呼び出し側は結果に応じて終了コードを決めるだけ）。
 */
export async function runApplyUpdate(args: ApplyUpdateArgs, deps: ApplierDeps): Promise<ApplyResult> {
  const { fs } = deps;
  const now = deps.now ?? (() => new Date());
  const retryTotalMs = deps.retryTotalMs ?? DEFAULT_RETRY_TOTAL_MS;
  const { installDir, stagingDir, version } = args;

  const log = async (msg: string): Promise<void> => {
    try {
      await fs.mkdir(path.dirname(args.logFile), { recursive: true });
      await fs.appendFile(args.logFile, `${now().toISOString()} ${msg}\n`, 'utf-8');
    } catch { /* ログが書けなくても入れ替えは続ける */ }
  };

  /** EBUSY/EPERM/EACCES のときだけ、バックオフしながら合計 retryTotalMs まで再試行する。 */
  const retry = async <T>(label: string, op: () => Promise<T>): Promise<T> => {
    let waited = 0;
    let delay = RETRY_FIRST_DELAY_MS;
    for (let attempt = 1; ; attempt++) {
      try {
        return await op();
      } catch (err) {
        const code = errCode(err);
        if (!code || !RETRYABLE.has(code) || waited >= retryTotalMs) throw err;
        await log(`retry ${label}: ${code} (attempt ${attempt}, waited ${waited}ms)`);
        const d = Math.min(delay, retryTotalMs - waited);
        await deps.sleep(d);
        waited += d;
        delay = Math.min(delay * 2, RETRY_MAX_DELAY_MS);
      }
    }
  };

  const copyRecursive = async (from: string, to: string): Promise<void> => {
    const entries = await fs.readdir(from, { withFileTypes: true });
    await fs.mkdir(to, { recursive: true });
    for (const e of entries) {
      const src = path.join(from, e.name);
      const dst = path.join(to, e.name);
      if (e.isDirectory()) {
        await copyRecursive(src, dst);
      } else if (e.isFile()) {
        await retry(`copy ${e.name}`, () => fs.copyFile(src, dst));
      }
      // シンボリックリンク等は配布物に含まれない想定のため触れない
    }
  };

  const exists = (p: string) => fs.access(p).then(() => true, () => false);

  const backupDir = path.join(installDir, makeBackupDirName(now()));
  const backupName = path.basename(backupDir);
  const movedNames: string[] = [];
  const copiedNames: string[] = [];

  await log(`${LOG_APPLY_START}: v${version} installDir='${installDir}' stagingDir='${stagingDir}' oldPid=${args.oldPid} relaunch=${args.relaunch} applier=${deps.exeName} pid=${process.pid}`);

  const result: ApplyResult = { ok: false, rolledBack: false, backupDir };

  try {
    // a. 旧プロセスの終了を待つ
    await log(`waiting for pid ${args.oldPid} to exit`);
    await deps.waitForPidExit(args.oldPid);
    await deps.sleep(AFTER_EXIT_GRACE_MS);

    if (!(await exists(path.join(stagingDir, deps.exeName)))) {
      throw new Error(`staging に ${deps.exeName} がありません`);
    }

    // b. 既存の項目を退避フォルダへ移す（インストール先フォルダ自体は動かさない）
    await fs.mkdir(backupDir, { recursive: true });
    await log(`backup dir: '${backupDir}'`);
    const existing = await fs.readdir(installDir);
    for (const name of existing) {
      if (isBackupDirName(name)) continue; // 自分の退避先と、以前の退避フォルダには触れない
      if (isPreservedEntryName(name)) continue; // データフォルダは退避にも移さない
      await retry(`move ${name}`, () => fs.rename(path.join(installDir, name), path.join(backupDir, name)));
      movedNames.push(name);
    }
    await log(`moved ${movedNames.length} entries into backup`);

    // c. ステージングの中身をインストール先へコピーする
    const staged = await fs.readdir(stagingDir, { withFileTypes: true });
    for (const e of staged) {
      if (isBackupDirName(e.name)) continue;
      if (isPreservedEntryName(e.name)) {
        await log(`skip '${e.name}' in staging (データフォルダは上書きしない)`);
        continue;
      }
      const src = path.join(stagingDir, e.name);
      const dst = path.join(installDir, e.name);
      copiedNames.push(e.name); // 途中で失敗しても巻き戻せるよう、先に記録する
      if (e.isDirectory()) {
        await copyRecursive(src, dst);
      } else if (e.isFile()) {
        await retry(`copy ${e.name}`, () => fs.copyFile(src, dst));
      }
    }
    await log(`copied ${copiedNames.length} entries from staging`);

    // d. 利用者が手で置いたファイル（resources/whisper）を引き継ぐ。
    //    移動ではなくコピー: ロールバック時に退避側が元のまま残っている必要があるため。
    for (const sub of USER_PLACED_RESOURCE_DIRS) {
      const from = path.join(backupDir, 'resources', sub);
      const to = path.join(installDir, 'resources', sub);
      let oldEntries: string[];
      try {
        oldEntries = await fs.readdir(from);
      } catch {
        continue;
      }
      const newEntries = await fs.readdir(to).catch(() => [] as string[]);
      const names = planCarryOver(oldEntries, newEntries, true);
      if (names.length === 0) continue;
      await fs.mkdir(to, { recursive: true });
      const fromEntries = await fs.readdir(from, { withFileTypes: true });
      for (const name of names) {
        const e = fromEntries.find((x) => x.name === name);
        if (e?.isDirectory()) await copyRecursive(path.join(from, name), path.join(to, name));
        else if (e?.isFile()) await retry(`carry over ${name}`, () => fs.copyFile(path.join(from, name), path.join(to, name)));
      }
      await log(`carried over ${names.length} item(s) in resources/${sub}`);
    }

    // e. 完了マーカー
    await fs.writeFile(
      path.join(installDir, COMPLETION_MARKER_FILE_NAME),
      `${version}\n${now().toISOString()}\n`,
      'utf-8',
    );
    await log('wrote completion marker');

    await log(`${LOG_APPLY_SUCCEEDED}: v${version}`);
    result.ok = true;
  } catch (err) {
    const message = errMessage(err);
    result.error = message;
    await log(`${LOG_APPLY_FAILED}: ${message}`);

    // f. ロールバック: ステージング由来で入れたものを消し、退避したものを戻す
    try {
      await log('rolling back');
      for (const name of copiedNames) {
        await retry(`rollback remove ${name}`, () => fs.rm(path.join(installDir, name), { recursive: true, force: true }));
      }
      for (const name of movedNames) {
        const dst = path.join(installDir, name);
        await retry(`rollback restore ${name}`, async () => {
          // 同名が（コピーの失敗途中などで）残っていたら先に消す
          await fs.rm(dst, { recursive: true, force: true });
          await fs.rename(path.join(backupDir, name), dst);
        });
      }
      await fs.rm(backupDir, { recursive: true, force: true }).catch(() => {});
      result.rolledBack = true;
      await log('rollback succeeded');
    } catch (rbErr) {
      await log(`ROLLBACK FAILED: ${errMessage(rbErr)} (退避フォルダ '${backupName}' に元のファイルが残っている可能性があります)`);
    }
  }

  // g. 再起動（成功時は新しい版、ロールバック後は元の版）。ベストエフォート。
  if (args.relaunch) {
    const exePath = path.join(installDir, deps.exeName);
    if (await exists(exePath)) {
      try {
        deps.spawnApp(exePath, installDir);
        await log('relaunched app');
      } catch (err) {
        await log(`relaunch failed: ${errMessage(err)}`);
      }
    } else {
      await log('no executable found to relaunch (manual restart required)');
    }
  } else {
    await log('relaunch skipped (apply on quit)');
  }

  return result;
}

export type ApplyLogOutcome = 'none' | 'succeeded' | 'failed' | 'incomplete';

export interface ApplyLogSummary {
  outcome: ApplyLogOutcome;
  /** 最後の試行の開始時刻（ログ行の先頭の ISO 文字列）。識別子として使う。 */
  startedAt: string | null;
  /** 失敗時のエラー文言。 */
  error: string | null;
}

/**
 * update-apply.log の内容から、最後の適用の結果を判定する。
 * 「開始したのに成功も失敗も書かれていない」場合は incomplete（途中で強制終了された等）。
 */
export function analyzeApplyLog(text: string): ApplyLogSummary {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  let startIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes(` ${LOG_APPLY_START}:`)) { startIdx = i; break; }
  }
  if (startIdx < 0) return { outcome: 'none', startedAt: null, error: null };
  const startedAt = lines[startIdx].split(' ')[0] ?? null;
  let outcome: ApplyLogOutcome = 'incomplete';
  let error: string | null = null;
  for (const line of lines.slice(startIdx + 1)) {
    if (line.includes(` ${LOG_APPLY_SUCCEEDED}`)) outcome = 'succeeded';
    else if (line.includes(` ${LOG_APPLY_FAILED}:`)) {
      outcome = 'failed';
      error = line.slice(line.indexOf(`${LOG_APPLY_FAILED}:`) + LOG_APPLY_FAILED.length + 1).trim();
    }
  }
  return { outcome, startedAt, error };
}
