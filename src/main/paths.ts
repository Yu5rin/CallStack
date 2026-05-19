import { app } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';

let cachedDirs: {
  userData: string;
  recordings: string;
  tmpRecordings: string;
  models: string;
  whisperBin: string;
} | null = null;

export async function ensureAppDirs() {
  if (cachedDirs) return cachedDirs;
  const userData = app.getPath('userData');
  const recordings = path.join(userData, 'recordings');
  const tmpRecordings = path.join(recordings, '.tmp');
  const models = path.join(userData, 'models');
  await fs.mkdir(recordings, { recursive: true });
  await fs.mkdir(tmpRecordings, { recursive: true });
  await fs.mkdir(models, { recursive: true });
  // Default location for whisper binary (extraResources/whisper or override via settings later)
  const baseResources = app.isPackaged
    ? path.join(process.resourcesPath, 'whisper')
    : path.join(__dirname, '..', '..', 'resources', 'whisper');
  const whisperBin = path.join(baseResources, process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli');
  cachedDirs = { userData, recordings, tmpRecordings, models, whisperBin };
  return cachedDirs;
}

export function getDirs() {
  if (!cachedDirs) throw new Error('ensureAppDirs has not been called');
  return cachedDirs;
}
