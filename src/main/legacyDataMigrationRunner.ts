import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { logInfo } from './log';
import {
  classifyCurrentData,
  type CurrentDataState,
  DATA_FILE,
  type EntryKind,
  legacyDirCandidates,
  MIGRATION_ORDER,
  planLegacyDataMigration,
  setAsideName,
} from './legacyDataMigration';

/**
 * 旧製品名（TelTimeStack）のデータフォルダから今のデータフォルダへ引き継ぐ。
 * 何をどう移すかの判断は legacyDataMigration.ts（テストで固定）にあり、
 * ここはフォルダを調べて、決まったとおりに rename するだけ。
 *
 * store.init() / ensureAppDirs() より前に呼ぶこと（先に既定値の data.json や
 * 空フォルダが作られても判断はできるが、余計な退避が増える）。
 * 失敗しても起動は止めない（旧フォルダは残るので、次回また試みる）。
 */
export async function migrateLegacyUserData(): Promise<void> {
  try {
    const userData = app.getPath('userData');
    const candidates = legacyDirCandidates(
      app.getPath('appData'),
      userData,
      path.join,
      process.platform === 'win32' || process.platform === 'darwin',
    );

    const legacy = [];
    for (const dir of candidates) {
      const entries = await snapshot(dir);
      if (entries.size > 0) legacy.push({ dir, entries });
    }
    if (legacy.length === 0) return; // 旧フォルダが無い（大多数）

    const plan = planLegacyDataMigration({
      currentData: await readCurrentDataState(path.join(userData, DATA_FILE)),
      current: await snapshot(userData),
      legacy,
    });
    if (plan.action === 'none') {
      if (plan.reason === 'current-has-data') {
        logInfo('migrate', `skip: ${userData} already has records; legacy data left in ${legacy.map((l) => l.dir).join(', ')}`);
      }
      return;
    }

    await fs.mkdir(userData, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    for (const name of plan.setAside) {
      const to = setAsideName(name, stamp);
      await fs.rename(path.join(userData, name), path.join(userData, to));
      logInfo('migrate', `set aside ${name} -> ${to}`);
    }
    for (const name of plan.replaceEmptyDirs) {
      // ファイルを含まないことは snapshot で確認済み
      await fs.rm(path.join(userData, name), { recursive: true });
    }
    // 1つでも失敗したらそこで止める（data.json は最後なので、次回起動時に続きから試みられる）
    for (const name of plan.moves) {
      await fs.rename(path.join(plan.from, name), path.join(userData, name));
      logInfo('migrate', `moved ${name} from ${plan.from}`);
    }
    logInfo('migrate', `legacy data migrated from ${plan.from} to ${userData}`);
  } catch (err) {
    logInfo('migrate', `legacy data migration failed (will retry next launch): ${(err as Error).message}`);
  }
}

/** 新しい側の data.json の状態。無いのは 'none'、それ以外の読み取り失敗は中身が分からないので 'unreadable' */
async function readCurrentDataState(file: string): Promise<CurrentDataState> {
  try {
    return classifyCurrentData(await fs.readFile(file, 'utf-8'));
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'none' : 'unreadable';
  }
}

/** 引き継ぎ対象の項目だけを調べる（フォルダが無ければ空） */
async function snapshot(dir: string): Promise<Map<string, EntryKind>> {
  const out = new Map<string, EntryKind>();
  for (const name of MIGRATION_ORDER) {
    const p = path.join(dir, name);
    let stat;
    try {
      stat = await fs.stat(p);
    } catch {
      continue;
    }
    if (stat.isFile()) out.set(name, 'file');
    else if (stat.isDirectory()) out.set(name, (await containsFile(p)) ? 'dir' : 'emptyDir');
  }
  return out;
}

/** フォルダの中（サブフォルダも含む）にファイルが1つでもあるか。見つかった時点で打ち切る */
async function containsFile(dir: string): Promise<boolean> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) return true;
    if (await containsFile(path.join(dir, entry.name))) return true;
  }
  return false;
}
