import { app } from 'electron';
import { localDateStamp } from './localTime';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CallRecord, HoldSegment, Settings, DEFAULT_SETTINGS } from '../shared/types';

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
      // Ensure nested objects are fully populated (handle older versions)
      this.data.settings.shortcuts = {
        ...DEFAULT_SETTINGS.shortcuts,
        ...(parsed.settings?.shortcuts ?? {}),
      };
      this.data.settings.recording = {
        ...DEFAULT_SETTINGS.recording,
        ...(parsed.settings?.recording ?? {}),
        callSource: {
          ...DEFAULT_SETTINGS.recording.callSource,
          ...(parsed.settings?.recording?.callSource ?? {}),
        },
        meetingSource: {
          ...DEFAULT_SETTINGS.recording.meetingSource,
          ...(parsed.settings?.recording?.meetingSource ?? {}),
        },
      };
      // v1.4 以前の recording.source ('mic' | 'mic+system') からの移行
      const legacySource = (parsed.settings?.recording as { source?: string } | undefined)?.source;
      if (legacySource && !parsed.settings?.recording?.callSource) {
        const system = legacySource === 'mic+system';
        this.data.settings.recording.callSource = { mic: true, system, systemScope: 'screen' };
        this.data.settings.recording.meetingSource = { mic: true, system, systemScope: 'screen' };
      }
      delete (this.data.settings.recording as { source?: string }).source;
      this.data.settings.transcription = {
        ...DEFAULT_SETTINGS.transcription,
        ...(parsed.settings?.transcription ?? {}),
        modelDownloaded: {
          ...(parsed.settings?.transcription?.modelDownloaded ?? {}),
        },
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
    return this.data.calls.find((c) => c.endTime === null && !c.deletedAt) ?? null;
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

  /** Returns the call by id (or null). */
  getCall(id: string): CallRecord | null {
    return this.data.calls.find((c) => c.id === id) ?? null;
  }

  /** Bulk upsert by id. Returns counts. */
  upsertMany(records: CallRecord[]): { inserted: number; updated: number } {
    let inserted = 0;
    let updated = 0;
    for (const r of records) {
      const idx = this.data.calls.findIndex((c) => c.id === r.id);
      if (idx >= 0) {
        this.data.calls[idx] = { ...this.data.calls[idx], ...r };
        updated += 1;
      } else {
        this.data.calls.push(r);
        inserted += 1;
      }
    }
    this.scheduleWrite();
    return { inserted, updated };
  }

  /** Begin a hold segment on the currently active call. Returns true if started. */
  startHold(): { record: CallRecord | null; started: boolean } {
    const active = this.getActiveCall();
    if (!active) return { record: null, started: false };
    const holds: HoldSegment[] = active.holds ? active.holds.slice() : [];
    if (holds.length && holds[holds.length - 1].end === null) {
      return { record: active, started: false };
    }
    holds.push({ start: new Date().toISOString(), end: null, sec: 0 });
    const updated = this.updateCall(active.id, { holds });
    return { record: updated, started: true };
  }

  /** End the current hold segment. Returns true if a segment was closed. */
  endHold(): { record: CallRecord | null; ended: boolean } {
    const active = this.getActiveCall();
    if (!active || !active.holds || !active.holds.length) return { record: active, ended: false };
    const holds = active.holds.slice();
    const last = holds[holds.length - 1];
    if (last.end !== null) return { record: active, ended: false };
    const end = new Date().toISOString();
    const sec = Math.max(0, Math.round((new Date(end).getTime() - new Date(last.start).getTime()) / 1000));
    holds[holds.length - 1] = { ...last, end, sec };
    const holdSec = holds.reduce((a, h) => a + (h.sec ?? 0), 0);
    const updated = this.updateCall(active.id, { holds, holdSec });
    return { record: updated, ended: true };
  }

  /** Returns true if active call has an open hold segment. */
  isHolding(): boolean {
    const a = this.getActiveCall();
    if (!a || !a.holds || !a.holds.length) return false;
    return a.holds[a.holds.length - 1].end === null;
  }

  /** For tick events: live hold seconds including any in-progress segment. */
  getLiveHoldSec(): number {
    const a = this.getActiveCall();
    if (!a || !a.holds || !a.holds.length) return 0;
    let total = 0;
    for (const h of a.holds) {
      if (h.end) total += h.sec;
      else total += Math.max(0, Math.round((Date.now() - new Date(h.start).getTime()) / 1000));
    }
    return total;
  }

  /** Create a pre-import backup with a custom suffix. */
  async backupNow(suffix: string): Promise<string> {
    await fs.mkdir(this.backupDir, { recursive: true });
    const stamp = localDateStamp(new Date());
    const target = path.join(this.backupDir, `data-${stamp}-${suffix}.json`);
    await fs.writeFile(target, JSON.stringify(this.data, null, 2), 'utf-8');
    return target;
  }

  /** Replace in-memory data from a previously exported JSON. Used by manual restore. */
  async restoreFromJson(json: unknown): Promise<{ calls: number }> {
    if (!json || typeof json !== 'object') throw new Error('JSON ファイルの形式が不正です');
    const parsed = json as Partial<DataFile>;
    if (!Array.isArray(parsed.calls)) throw new Error('calls 配列が見つかりません');
    // Take a snapshot of the current data before replacing.
    await this.backupNow('pre-restore');
    this.data = {
      version: FILE_VERSION,
      calls: parsed.calls as CallRecord[],
      settings: parsed.settings ? { ...DEFAULT_SETTINGS, ...parsed.settings } : this.data.settings,
    };
    await this.flush();
    return { calls: this.data.calls.length };
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
      const stamp = localDateStamp(new Date());
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
