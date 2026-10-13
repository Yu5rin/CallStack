import { app } from 'electron';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logInfo } from './log';
import {
  planDataLocation, probeWritableDir, resolveDataLocation, type DataLocationInfo,
} from './dataLocation';
import { migrateDataDir } from './dataDirMigration';

/**
 * データフォルダの決定と、従来の保存先からの引き継ぎ（判断ロジックは dataLocation.ts /
 * dataDirMigration.ts にあり、テストで固定している）。
 *
 * 呼び出し順（index.ts）:
 *   1. initDataLocation() … モジュールの先頭で。userData を参照するもの（store・ログ・
 *      単一起動ロック・Chromium のセッション）より前に setPath する
 *   2. migrateToDataLocation() … main() の中、単一起動ロックより前に。store の初期化より前
 */

let info: DataLocationInfo | null = null;
/** ログは新しいフォルダに書く。引き継ぎの前に書くとフォルダが空でなくなるので、溜めておく */
const pendingLogs: string[] = [];

/** 開始時に userData を決めて setPath する。適用モードなら一時フォルダを使う */
export function initDataLocation(applyMode: boolean): DataLocationInfo {
  // setPath する前の値＝従来の保存先（%APPDATA%\callstack）
  const defaultDir = app.getPath('userData');
  const execPath = process.execPath;
  const plan = planDataLocation({
    isPackaged: app.isPackaged,
    platform: process.platform,
    execPath,
    applyMode,
    defaultDir,
    tmpDir: os.tmpdir(),
    pid: process.pid,
    portableExecutableDir: process.env.PORTABLE_EXECUTABLE_DIR || null,
    // インストーラ版は exe の隣に「Uninstall …exe」がある。そこに data を置くと更新・削除で消える
    installedByInstaller: app.isPackaged && process.platform === 'win32' && hasUninstaller(path.dirname(execPath)),
  });
  const probe = plan.kind === 'default' ? null : probeWritableDir(plan.dir, fs, process.pid);
  info = resolveDataLocation(plan, defaultDir, probe);
  applyPaths(info.dir);
  if (info.mode === 'fallback') pendingLogs.push(`データフォルダ: ${info.reason ?? ''}`);
  else if (info.mode === 'portable') pendingLogs.push(`データフォルダ: ${info.dir}`);
  return info;
}

function hasUninstaller(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((n) => /^Uninstall .*\.exe$/i.test(n));
  } catch {
    return false;
  }
}

function applyPaths(dir: string): void {
  app.setPath('userData', dir);
  app.setPath('sessionData', dir);
  app.setPath('crashDumps', path.join(dir, 'Crashpad'));
}

export function getDataLocationInfo(): DataLocationInfo {
  return info ?? {
    mode: 'default', dir: app.getPath('userData'), defaultDir: app.getPath('userData'), reason: null,
  };
}

/**
 * portable のとき、従来の保存先から設定・記録を引き継ぐ（無ければ何もしない）。
 * 失敗したら従来の保存先に戻して起動を続ける（記録を見失わないため。次回の起動でまた試みる）。
 * 最後に、溜めたログを書き出す。
 */
export async function migrateToDataLocation(): Promise<void> {
  try {
    if (info && info.mode === 'portable') {
      const outcome = await migrateDataDir({
        oldDir: info.defaultDir,
        newDir: info.dir,
        fs: fsp,
        caseInsensitive: process.platform === 'win32',
      });
      pendingLogs.push(...outcome.logs);
      if (outcome.result === 'failed') {
        const reason = `従来の保存先からの引き継ぎに失敗したため、今回は従来の保存先を使います: ${outcome.detail ?? ''}`;
        info = { mode: 'fallback', dir: info.defaultDir, defaultDir: info.defaultDir, reason };
        applyPaths(info.dir);
        pendingLogs.push(reason);
      }
    }
  } catch (err) {
    pendingLogs.push(`データフォルダの準備で想定外のエラー: ${(err as Error).message}`);
  }
  for (const line of pendingLogs.splice(0)) logInfo('datadir', line);
}
