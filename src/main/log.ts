import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

/**
 * 軽量なファイルロガー。フリーズ等の不具合調査用に主要イベントを
 * userData/logs/app.log へ追記する（1MB 超で世代交代、1世代のみ保持）。
 */

let logPath: string | null = null;

function ensureLogPath(): string {
  if (logPath) return logPath;
  const dir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  logPath = path.join(dir, 'app.log');
  try {
    const stat = fs.statSync(logPath);
    if (stat.size > 1024 * 1024) {
      fs.renameSync(logPath, path.join(dir, 'app.log.1'));
    }
  } catch { /* not present yet */ }
  return logPath;
}

export function logInfo(tag: string, message: string): void {
  try {
    const line = `${new Date().toISOString()} [${tag}] ${message}\n`;
    fs.appendFileSync(ensureLogPath(), line, 'utf-8');
  } catch { /* logging must never break the app */ }
}

export function getLogPath(): string {
  return ensureLogPath();
}
