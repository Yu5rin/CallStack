import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CallRecord, Settings, DEFAULT_SETTINGS } from '../shared/types';

interface DataFile {
  version: number;
  calls: CallRecord[];
  settings: Settings;
}

const FILE_VERSION = 1;

export class Store {
  private dataFile: string;
  private backupDir: string;
  private data: DataFile;
  private writeTimer: NodeJS.Timeout | null = null;

  constructor() {
    const userData = app.getPath('userData');
    this.dataFile = path.join(userData, 'data.json');
    this.backupDir = path.join(userData, 'backups');
    this.data = {
      version: FILE_VERSION,
      calls: [],
      settings: structuredClone(DEFAULT_SETTINGS),
    };
  }

  async init(): Promise<void> {
    try {
      const buf = await fs.readFile(this.dataFile, 'utf-8');
      const parsed = JSON.parse(buf) as Partial<DataFile>;
      this.data = {
        version: FILE_VERSION,
        calls: Array.isArray(parsed.calls) ? parsed.calls : [],
        settings: { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) },
      };
      // Ensure shortcuts object is fully populated
      this.data.settings.shortcuts = {
        ...DEFAULT_SETTINGS.shortcuts,
        ...(parsed.settings?.shortcuts ?? {}),
      };
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') {
        console.error('[store] failed to read data file:', err);
      }
      // First run — keep defaults and persist
      await this.flush();
    }
    await this.backup();
  }

  getCalls(): CallRecord[] {
    return this.data.calls;
  }

  getSettings(): Settings {
    return this.data.settings;
  }

  getActiveCall(): CallRecord | null {
    return this.data.calls.find((c) => c.endTime === null) ?? null;
  }

  addCall(record: CallRecord): void {
    this.data.calls.push(record);
    this.scheduleWrite();
  }

  updateCall(id: string, patch: Partial<CallRecord>): CallRecord | null {
    const idx = this.data.calls.findIndex((c) => c.id === id);
    if (idx < 0) return null;
    const merged = { ...this.data.calls[idx], ...patch };
    if (merged.startTime && merged.endTime) {
      merged.durationSec = Math.max(
        0,
        Math.round((new Date(merged.endTime).getTime() - new Date(merged.startTime).getTime()) / 1000),
      );
    }
    this.data.calls[idx] = merged;
    this.scheduleWrite();
    return merged;
  }

  deleteCall(id: string): boolean {
    const before = this.data.calls.length;
    this.data.calls = this.data.calls.filter((c) => c.id !== id);
    if (this.data.calls.length !== before) {
      this.scheduleWrite();
      return true;
    }
    return false;
  }

  setSettings(settings: Settings): void {
    this.data.settings = settings;
    this.scheduleWrite();
  }

  private scheduleWrite(): void {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => {
      this.flush().catch((err) => console.error('[store] flush failed:', err));
    }, 300);
  }

  async flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    const tmp = `${this.dataFile}.tmp`;
    await fs.mkdir(path.dirname(this.dataFile), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf-8');
    await fs.rename(tmp, this.dataFile);
  }

  private async backup(): Promise<void> {
    try {
      await fs.mkdir(this.backupDir, { recursive: true });
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const target = path.join(this.backupDir, `data-${stamp}.json`);
      try {
        await fs.access(target);
        // already backed up today
        return;
      } catch {
        // not present, create
      }
      await fs.writeFile(target, JSON.stringify(this.data, null, 2), 'utf-8');
      // keep last 30 backups
      const files = (await fs.readdir(this.backupDir))
        .filter((f) => f.startsWith('data-') && f.endsWith('.json'))
        .sort();
      while (files.length > 30) {
        const oldest = files.shift();
        if (oldest) await fs.unlink(path.join(this.backupDir, oldest));
      }
    } catch (err) {
      console.error('[store] backup failed:', err);
    }
  }
}
