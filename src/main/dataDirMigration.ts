import path from 'node:path';
import type { promises as NodeFsPromises } from 'node:fs';

/**
 * データフォルダを exe の隣の `data` へ移した版に初めて上がったとき、従来の保存先
 * （%APPDATA%\callstack）にある設定・記録・録音をそのまま引き継ぐ処理。
 *
 * 方針（安全側）:
 *   - 新しい側に data.json が既にあれば何もしない（上書き・混ぜ合わせをしない）
 *   - 旧フォルダに data.json が無ければ何もしない（引き継ぐ記録が無い）
 *   - まず旧フォルダ丸ごとの rename（同じドライブなら一瞬。録音が何GBあっても速い）。
 *     失敗したら（別ドライブ・使用中など）コピーに切り替え、旧フォルダは消さずに残す
 *   - コピーでは Chromium のキャッシュ類は対象にしない（再生成できて、容量が大きい）
 *   - data.json は最後にコピーする。途中で失敗しても新しい側に data.json が無い状態が残り、
 *     次回起動時にやり直せる
 *
 * 呼び出し側（dataLocationRunner.ts）は、store の初期化・単一起動ロックより前に呼ぶこと
 * （Windows の単一起動ロックは userData 直下に lockfile を作るため、先にロックを取ると
 * 新しいフォルダが「空」でなくなり、フォルダごとの rename ができなくなる）。
 *
 * electron に依存しない。ファイル操作は注入された fs（本番は node:fs の promises）で行い、
 * node:test で実ファイルの一時フォルダに対して検証する。
 */

/** コピーしない項目（旧フォルダ直下の名前）。再生成できるキャッシュと、使用中のロックファイル */
export const SKIP_COPY_ENTRIES = [
  'Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
  'blob_storage', 'Crashpad', 'Shared Dictionary',
  'lockfile', 'SingletonLock', 'SingletonCookie', 'SingletonSocket',
] as const;

/** 本体データ（通話記録・設定）。移行の有無の判断に使い、コピーでは最後に回す */
export const DATA_FILE_NAME = 'data.json';

/** コピー移行のあと、旧フォルダに置く案内ファイル */
export const MIGRATED_NOTICE_FILE_NAME = '移行済み.txt';

export type NewDirState = 'absent' | 'empty' | 'non-empty';

export type DataDirPlan =
  | { action: 'none'; reason: 'same-dir' | 'new-has-data' | 'no-old-data' }
  | { action: 'migrate'; tryRename: boolean };

export function planDataDirMigration(input: {
  sameDir: boolean;
  oldHasData: boolean;
  newHasData: boolean;
  newState: NewDirState;
}): DataDirPlan {
  if (input.sameDir) return { action: 'none', reason: 'same-dir' };
  if (input.newHasData) return { action: 'none', reason: 'new-has-data' };
  if (!input.oldHasData) return { action: 'none', reason: 'no-old-data' };
  // フォルダごとの rename は、新しい側が無い／空のときだけ（何かあれば混ぜずにコピーで足りない分だけ入れる）
  return { action: 'migrate', tryRename: input.newState !== 'non-empty' };
}

/** 2つのパスが同じ場所か（Windows では大文字小文字を区別しない） */
export function isSameDir(a: string, b: string, caseInsensitive: boolean): boolean {
  const norm = (p: string) => {
    const r = path.resolve(p).replace(/[\\/]+$/, '');
    return caseInsensitive ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

export type MigrationFs = Pick<
  typeof NodeFsPromises,
  'readdir' | 'rename' | 'rmdir' | 'mkdir' | 'copyFile' | 'writeFile' | 'stat'
>;

export interface DataDirMigrationOutcome {
  result: 'none' | 'renamed' | 'copied' | 'failed';
  /** 'none' の理由、または 'failed' のエラー文言 */
  detail?: string;
  /** 起動ログに残す文言（新しいフォルダの logs に書く。呼び出し側が logInfo する） */
  logs: string[];
}

async function isFile(fs: MigrationFs, p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

async function dirState(fs: MigrationFs, dir: string): Promise<NewDirState> {
  try {
    return (await fs.readdir(dir)).length === 0 ? 'empty' : 'non-empty';
  } catch {
    return 'absent';
  }
}

function msg(err: unknown): string {
  const e = err as NodeJS.ErrnoException;
  return e?.code ? `${e.code}: ${e.message}` : String((err as Error)?.message ?? err);
}

/** 旧フォルダの中身をコピーする。Chromium のキャッシュ類は飛ばし、data.json は最後 */
async function copyTree(fs: MigrationFs, from: string, to: string, topLevel: boolean): Promise<number> {
  const entries = await fs.readdir(from, { withFileTypes: true });
  await fs.mkdir(to, { recursive: true });
  let count = 0;
  const lastEntries: typeof entries = [];
  for (const e of entries) {
    if (topLevel && (SKIP_COPY_ENTRIES as readonly string[]).includes(e.name)) continue;
    if (topLevel && e.name === DATA_FILE_NAME) { lastEntries.push(e); continue; }
    count += await copyEntry(fs, from, to, e);
  }
  for (const e of lastEntries) count += await copyEntry(fs, from, to, e);
  return count;
}

async function copyEntry(
  fs: MigrationFs, from: string, to: string, e: { name: string; isDirectory(): boolean; isFile(): boolean },
): Promise<number> {
  const src = path.join(from, e.name);
  const dst = path.join(to, e.name);
  if (e.isDirectory()) return copyTree(fs, src, dst, false);
  if (!e.isFile()) return 0; // シンボリックリンク等は対象外
  // やり直しのとき、コピー済みで大きさが同じものは飛ばす
  try {
    const [s, d] = await Promise.all([fs.stat(src), fs.stat(dst)]);
    if (s.size === d.size) return 0;
  } catch { /* コピー先が無い */ }
  await fs.copyFile(src, dst);
  return 1;
}

/**
 * 旧フォルダ（oldDir）から新しいフォルダ（newDir）へデータを引き継ぐ。
 * 例外は投げず、結果で返す。'failed' のときは新しい側を使い続けず、呼び出し側が
 * 旧フォルダに戻す（記録を見失わないため）。
 */
export async function migrateDataDir(opts: {
  oldDir: string;
  newDir: string;
  fs: MigrationFs;
  caseInsensitive: boolean;
  now?: () => Date;
}): Promise<DataDirMigrationOutcome> {
  const { oldDir, newDir, fs } = opts;
  const now = opts.now ?? (() => new Date());
  const logs: string[] = [];
  try {
    const plan = planDataDirMigration({
      sameDir: isSameDir(oldDir, newDir, opts.caseInsensitive),
      oldHasData: await isFile(fs, path.join(oldDir, DATA_FILE_NAME)),
      newHasData: await isFile(fs, path.join(newDir, DATA_FILE_NAME)),
      newState: await dirState(fs, newDir),
    });
    if (plan.action === 'none') {
      if (plan.reason === 'new-has-data') {
        logs.push(`移行しません: ${newDir} に既にデータがあります`);
      }
      return { result: 'none', detail: plan.reason, logs };
    }

    if (plan.tryRename) {
      const state = await dirState(fs, newDir);
      try {
        if (state === 'empty') await fs.rmdir(newDir); // 空フォルダへの rename は Windows で失敗するため先に消す
        else await fs.mkdir(path.dirname(newDir), { recursive: true });
        await fs.rename(oldDir, newDir);
        logs.push(`データフォルダを移動しました: ${oldDir} -> ${newDir}`);
        return { result: 'renamed', logs };
      } catch (err) {
        logs.push(`フォルダごとの移動に失敗したためコピーに切り替えます（${msg(err)}）`);
        // 空フォルダを消していたら作り直す（コピー先として使う）
        await fs.mkdir(newDir, { recursive: true });
      }
    }

    const count = await copyTree(fs, oldDir, newDir, true);
    logs.push(`データをコピーしました: ${oldDir} -> ${newDir}（${count} ファイル。Chromium のキャッシュ類は除く）`);
    try {
      await fs.writeFile(
        path.join(oldDir, MIGRATED_NOTICE_FILE_NAME),
        [
          'CallStack のデータは、次のフォルダへ移行しました。',
          '',
          `  ${newDir}`,
          '',
          `移行した日時: ${now().toISOString()}`,
          '',
          'このフォルダ（旧い保存先）は、移行後は使われません。',
          '新しい保存先で問題なく使えることを確認してから、不要なら削除してください。',
          '',
        ].join('\r\n'),
        'utf-8',
      );
    } catch (err) {
      logs.push(`${MIGRATED_NOTICE_FILE_NAME} を書けませんでした（${msg(err)}）`);
    }
    return { result: 'copied', logs };
  } catch (err) {
    logs.push(`データの移行に失敗しました（次回の起動で再び試みます）: ${msg(err)}`);
    return { result: 'failed', detail: msg(err), logs };
  }
}
