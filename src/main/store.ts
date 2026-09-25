import { app } from 'electron';
import { localDateStamp } from './localTime';
import { promises as fs, openSync, writeSync, fsyncSync, closeSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { CallRecord, HoldSegment, Settings, DEFAULT_SETTINGS } from '../shared/types';
import { getDirs } from './paths';

interface DataFile {
  version: number;
  calls: CallRecord[];
  settings: Settings;
}

const FILE_VERSION = 1;

/**
 * parsed.settings（旧バージョンや破損復旧時の断片的な値）を DEFAULT_SETTINGS と
 * ネストしたオブジェクトごとにマージし、常にフル充填された Settings を返す。
 * init() と restoreFromJson() で同じロジックを共有するための共通ヘルパー。
 */
function mergeSettings(partial: Partial<Settings> | undefined): Settings {
  const settings: Settings = { ...DEFAULT_SETTINGS, ...(partial ?? {}) };
  // Ensure nested objects are fully populated (handle older versions)
  settings.shortcuts = {
    ...DEFAULT_SETTINGS.shortcuts,
    ...(partial?.shortcuts ?? {}),
  };
  // v1.9.0 以前の 'Control+' 表記を 'Ctrl+' へ移行（accelerator としては等価）
  for (const k of Object.keys(settings.shortcuts) as Array<keyof typeof settings.shortcuts>) {
    settings.shortcuts[k] = settings.shortcuts[k].replace(/\bControl\b/g, 'Ctrl');
  }
  settings.recording = {
    ...DEFAULT_SETTINGS.recording,
    ...(partial?.recording ?? {}),
    callSource: {
      ...DEFAULT_SETTINGS.recording.callSource,
      ...(partial?.recording?.callSource ?? {}),
    },
    meetingSource: {
      ...DEFAULT_SETTINGS.recording.meetingSource,
      ...(partial?.recording?.meetingSource ?? {}),
    },
  };
  // v1.4 以前の recording.source ('mic' | 'mic+system') からの移行
  const legacySource = (partial?.recording as { source?: string } | undefined)?.source;
  if (legacySource && !partial?.recording?.callSource) {
    const system = legacySource === 'mic+system';
    settings.recording.callSource = { mic: true, system, systemScope: 'screen' };
    settings.recording.meetingSource = { mic: true, system, systemScope: 'screen' };
  }
  delete (settings.recording as { source?: string }).source;
  settings.transcription = {
    ...DEFAULT_SETTINGS.transcription,
    ...(partial?.transcription ?? {}),
    modelDownloaded: {
      ...(partial?.transcription?.modelDownloaded ?? {}),
    },
  };
  return settings;
}

export interface RecoveryInfo {
  /** リネームして保持した破損データファイルのパス */
  corruptPath: string;
  /** 復元元にしたバックアップファイルのパス（見つからなければ null＝空で開始） */
  restoredFrom: string | null;
}

export class Store {
  private dataFile: string;
  private backupDir: string;
  private data: DataFile;
  private writeTimer: NodeJS.Timeout | null = null;
  /** 直列化された flush の Promise チェーン（同じ tmp ファイルへの書き込み競合を防ぐ） */
  private flushChain: Promise<void> = Promise.resolve();
  /** 書き込み内容の世代番号。同期書き込みより前に取った内容で上書きしないために使う */
  private writeSeq = 0;
  private lastSyncSeq = 0;
  /** data.json が破損しておりバックアップから復旧した場合の情報（起動後にユーザーへ通知する） */
  recoveryInfo: RecoveryInfo | null = null;

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

  /** バックアップディレクトリ内の JSON を新しい順に走査し、最初にパースできたものを返す */
  private async loadNewestValidBackup(): Promise<{ file: string; data: DataFile } | null> {
    let files: string[];
    try {
      files = (await fs.readdir(this.backupDir)).filter((f) => f.endsWith('.json')).sort();
    } catch {
      return null;
    }
    for (let i = files.length - 1; i >= 0; i--) {
      const file = path.join(this.backupDir, files[i]);
      try {
        const buf = await fs.readFile(file, 'utf-8');
        const parsed = JSON.parse(buf) as Partial<DataFile>;
        if (!Array.isArray(parsed.calls)) continue;
        return {
          file,
          data: {
            version: FILE_VERSION,
            calls: parsed.calls,
            settings: mergeSettings(parsed.settings),
          },
        };
      } catch {
        continue; // このバックアップも壊れている場合は、より古いものを試す
      }
    }
    return null;
  }

  async init(): Promise<void> {
    try {
      const buf = await fs.readFile(this.dataFile, 'utf-8');
      const parsed = JSON.parse(buf) as Partial<DataFile>;
      this.data = {
        version: FILE_VERSION,
        calls: Array.isArray(parsed.calls) ? parsed.calls : [],
        settings: mergeSettings(parsed.settings),
      };
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        // First run — keep defaults and persist
        await this.flush();
      } else {
        // data.json は存在するが読み込み・パースに失敗＝破損。
        // 上書きして失うことのないよう退避し、バックアップからの復旧を試みる。
        console.error('[store] failed to read data file (corrupt):', err);
        const stamp = localDateStamp(new Date()).replace(/-/g, '') + '-' +
          new Date().toISOString().slice(11, 19).replace(/:/g, '');
        const corruptPath = `${this.dataFile}.corrupt-${stamp}`;
        let renamed = false;
        try {
          await fs.rename(this.dataFile, corruptPath);
          renamed = true;
        } catch (renameErr) {
          console.error('[store] failed to preserve corrupt data file:', renameErr);
        }
        const backup = await this.loadNewestValidBackup();
        if (backup) {
          this.data = backup.data;
          console.error(`[store] restored from backup: ${backup.file}`);
        } else {
          this.data = {
            version: FILE_VERSION,
            calls: [],
            settings: structuredClone(DEFAULT_SETTINGS),
          };
          console.error('[store] no valid backup found — starting with empty data');
        }
        this.recoveryInfo = {
          corruptPath: renamed ? corruptPath : this.dataFile,
          restoredFrom: backup ? backup.file : null,
        };
        // 復旧したデータを直ちに保存する（同日分の backup() が空データで
        // 上書きしてしまわないよう、backup() より前に確定させておく）
        await this.flush();
      }
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

  /** 設定された外部フォルダ (autoBackupDir) にもバックアップを複製する */
  private async copyToAutoBackupDir(sourcePath: string): Promise<void> {
    const dir = this.data.settings.autoBackupDir;
    if (!dir) return;
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.copyFile(sourcePath, path.join(dir, path.basename(sourcePath)));
    } catch (err) {
      console.error('[store] auto backup copy failed:', err);
    }
  }

  /** Create a pre-import backup with a custom suffix. */
  async backupNow(suffix: string): Promise<string> {
    await fs.mkdir(this.backupDir, { recursive: true });
    const stamp = localDateStamp(new Date());
    const target = path.join(this.backupDir, `data-${stamp}-${suffix}.json`);
    await fs.writeFile(target, JSON.stringify(this.data, null, 2), 'utf-8');
    await this.copyToAutoBackupDir(target);
    return target;
  }

  /** 復元対象の call レコードが不正な audio.path（録音フォルダ外・絶対パス等）を
   *  持たないよう検証し、id / startTime を欠くレコードは除外する。 */
  private sanitizeRestoredCalls(calls: unknown): CallRecord[] {
    if (!Array.isArray(calls)) return [];
    const { recordings } = getDirs();
    const out: CallRecord[] = [];
    for (const item of calls) {
      if (!item || typeof item !== 'object') continue;
      const c = { ...(item as CallRecord) };
      if (typeof c.id !== 'string' || !c.id) continue;
      if (typeof c.startTime !== 'string' || !c.startTime) continue;
      if (c.audio) {
        const relPath = c.audio.path;
        const abs = typeof relPath === 'string' ? path.resolve(recordings, relPath) : null;
        const inside = typeof relPath === 'string' && !path.isAbsolute(relPath) && abs !== null
          && (abs === recordings || abs.startsWith(recordings + path.sep));
        if (!inside) {
          console.error(`[store] restore: dropping unsafe audio.path for call ${c.id}: ${String(relPath)}`);
          c.audio = undefined;
        }
      }
      out.push(c);
    }
    return out;
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
      calls: this.sanitizeRestoredCalls(parsed.calls),
      settings: parsed.settings ? mergeSettings(parsed.settings) : this.data.settings,
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

  /**
   * data.json への書き込みを行う（tmp ファイルへ書いて fsync してから rename）。
   * flush() は this.flushChain 経由で直列化して呼び出し、同じ tmp ファイルへの
   * 書き込みが競合しないようにする。
   */
  private async writeDataFile(payload: string, seq: number): Promise<void> {
    // 終了直前の flushSync がより新しい内容を書いた後なら、古い内容で上書きしない
    if (seq < this.lastSyncSeq) return;
    await fs.mkdir(path.dirname(this.dataFile), { recursive: true });
    const tmp = `${this.dataFile}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const handle = await fs.open(tmp, 'w');
    try {
      await handle.writeFile(payload, 'utf-8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (seq < this.lastSyncSeq) {
      await fs.unlink(tmp).catch(() => {});
      return;
    }
    await fs.rename(tmp, this.dataFile);
  }

  async flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    const payload = JSON.stringify(this.data, null, 2);
    const seq = ++this.writeSeq;
    // 直列化: 前の flush の完了（成功・失敗いずれでも）を待ってから書き込む。
    const task = this.flushChain.then(
      () => this.writeDataFile(payload, seq),
      () => this.writeDataFile(payload, seq),
    );
    this.flushChain = task.catch(() => { /* チェーン自体は継続させる */ });
    return task;
  }

  /**
   * 同期版の flush。Electron の before-quit ハンドラは非同期処理の完了を
   * 待たないため、終了直前（300ms のデバウンス中）の変更を確実に保存するために使う。
   */
  flushSync(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    this.lastSyncSeq = ++this.writeSeq;
    try {
      mkdirSync(path.dirname(this.dataFile), { recursive: true });
      const tmp = `${this.dataFile}.tmp-sync-${process.pid}-${Date.now()}`;
      const buf = Buffer.from(JSON.stringify(this.data, null, 2), 'utf-8');
      const fd = openSync(tmp, 'w');
      try {
        writeSync(fd, buf);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, this.dataFile);
    } catch (err) {
      console.error('[store] flushSync failed:', err);
    }
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
      await this.copyToAutoBackupDir(target);
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
