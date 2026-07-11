import { app, BrowserWindow, ipcMain, dialog, session, WebContents, desktopCapturer } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { Store } from './store';
import {
  CallRecord, CsvExportOptions, CsvImportResult, Settings,
  CallTranscript, WhisperModel, RecordKind, AudioSourceLabel, Marker,
} from '../shared/types';
import { registerShortcuts, unregisterAll } from './shortcuts';
import {
  createMainWindow,
  toggleMainWindow,
  showMainWindow,
  showMainWindowAt,
  createHudWindow,
  closeHudWindow,
  broadcast,
  getHudWindow,
  markForceQuit,
  setMinimizeToTray,
  setHudSize,
  setHudExtraHeight,
  nextHudSize,
} from './window';
import { createTray, updateTray, destroyTray, TrayHandlers } from './tray';
import { exportCsv, parseCsv } from './csv';
import { notify } from './notifications';
import { ensureAppDirs, getDirs } from './paths';
import { registerAppProtocol, registerAppProtocolPrivilege } from './protocol';
import * as recording from './recording';
import {
  enqueue as enqueueTranscription, cancel as cancelTranscription,
  setQueueHandlers, WhisperMissingError, checkSetup as checkTranscriptionSetup,
} from './transcription';
import { downloadModel, isModelDownloaded, getModelPath } from './whisperModels';
import { scheduleDailyCleanup, stopDailyCleanup, cleanupExpiredRecordings } from './retention';
import { localDate } from './localTime';

registerAppProtocolPrivilege();

const store = new Store();

let tickInterval: NodeJS.Timeout | null = null;
let longCallAlertFired = false;

/** システム音声キャプチャの対象。録音開始前にレンダラから設定される */
let captureTarget: { type: 'screen' } | { type: 'window'; sourceId: string } = { type: 'screen' };

function getActive(): CallRecord | null {
  return store.getActiveCall();
}

function todayStats(): { count: number; totalSec: number } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  let count = 0;
  let totalSec = 0;
  for (const c of store.getCalls()) {
    if (!c.endTime) continue;
    if (new Date(c.startTime).getTime() < start) continue;
    count++;
    totalSec += c.durationSec ?? 0;
  }
  return { count, totalSec };
}

function startTickLoop() {
  if (tickInterval) return;
  tickInterval = setInterval(() => {
    const active = getActive();
    if (!active) return;
    const elapsedSec = Math.floor((Date.now() - new Date(active.startTime).getTime()) / 1000);
    const holding = store.isHolding();
    const holdSec = store.getLiveHoldSec();
    broadcast('app-event', { type: 'tick', activeId: active.id, elapsedSec, holding, holdSec });
    updateTray(
      { active: true, elapsedSec, holding, recording: store.getSettings().recording.enabled, today: todayStats() },
      trayHandlers,
    );

    // 長電話アラートは通話のみ（会議は長時間が通常のため対象外）
    const alertMin = store.getSettings().longCallAlertMin;
    if (alertMin && alertMin > 0 && !longCallAlertFired && elapsedSec >= alertMin * 60 && active.kind !== 'meeting') {
      longCallAlertFired = true;
      notify('長電話アラート', `${alertMin} 分経過しました。`, () => showMainWindow());
    }
  }, 1000);
}

function stopTickLoop() {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
}

function startCall(kind: RecordKind = 'call'): CallRecord | null {
  if (getActive()) {
    notify('CallStack', '進行中の記録があります。先に終了してください。');
    return null;
  }
  const now = new Date().toISOString();
  const rec: CallRecord = {
    id: nanoid(),
    kind,
    startTime: now,
    endTime: null,
    durationSec: null,
    tag: null,
    memo: '',
    holds: [],
    holdSec: 0,
  };
  store.addCall(rec);
  longCallAlertFired = false;
  const settings = store.getSettings();
  createHudWindow(settings.hudPosition, settings.hudSize);
  updateTray({ active: true, elapsedSec: 0, today: todayStats() }, trayHandlers);
  startTickLoop();
  broadcast('app-event', { type: 'call:started', record: rec });
  return rec;
}

async function endCall(): Promise<CallRecord | null> {
  const active = getActive();
  if (!active) return null;
  // Close any open hold first
  if (store.isHolding()) store.endHold();
  const endTime = new Date().toISOString();
  const durationSec = Math.max(
    0,
    Math.round((new Date(endTime).getTime() - new Date(active.startTime).getTime()) / 1000),
  );
  const updated = store.updateCall(active.id, { endTime, durationSec });

  // Wait briefly for recording to finalize (HUD pushes last chunk + finalize)
  // Then ask the renderer to stop and provide chunks.
  // Recording stop is initiated by the renderer reacting to call:ended event,
  // so we just broadcast and let it call recording:finalize.
  stopTickLoop();
  closeHudWindow();
  updateTray({ active: false, today: todayStats() }, trayHandlers);
  if (updated) {
    broadcast('app-event', { type: 'call:ended', record: updated });
    const label = updated.kind === 'meeting' ? '会議を記録しました' : '通話を記録しました';
    notify(label, `${formatHMS(durationSec)} — クリックで詳細編集`, () => showMainWindow());
  }
  return updated;
}

/** 録音中のレンダラへ一時停止/再開のトグルを指示する */
function togglePauseRecording(): void {
  if (!getActive()) return;
  if (!store.getSettings().recording.enabled) return;
  broadcast('app-event', { type: 'recording:togglePause' });
}

function toggleHold(): void {
  if (!getActive()) return;
  if (store.isHolding()) {
    const r = store.endHold();
    if (r.record) broadcast('app-event', { type: 'hold:changed', callId: r.record.id, holding: false, holdSec: r.record.holdSec ?? 0 });
  } else {
    const r = store.startHold();
    if (r.record) broadcast('app-event', { type: 'hold:changed', callId: r.record.id, holding: true, holdSec: r.record.holdSec ?? 0 });
  }
}

function formatHMS(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rs = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(rs).padStart(2, '0')}`;
}

async function chooseAndExport(): Promise<{ count: number; path: string } | null> {
  const result = await dialog.showSaveDialog({
    title: 'CSV をエクスポート',
    defaultPath: `callstack-${localDate(new Date())}.csv`,
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (result.canceled || !result.filePath) return null;
  const count = await exportCsv(result.filePath, store.getCalls(), { range: 'all' });
  return { count, path: result.filePath };
}

const trayHandlers: TrayHandlers = {
  onStart: () => startCall(),
  onStartMeeting: () => startCall('meeting'),
  onEnd: () => { void endCall(); },
  onOpen: () => showMainWindow(),
  onExport: async () => {
    const r = await chooseAndExport();
    if (r) notify('CSV エクスポート完了', `${r.count} 件を ${r.path} に書き出しました`);
  },
  onQuit: () => {
    markForceQuit();
    app.quit();
  },
  onSetTheme: (theme) => {
    const cur = store.getSettings();
    if (cur.theme === theme) return;
    const next = { ...cur, theme };
    store.setSettings(next);
    broadcast('app-event', { type: 'settings:updated', settings: next });
    updateTray({ active: !!getActive(), today: todayStats() }, trayHandlers);
  },
  getTheme: () => store.getSettings().theme,
};

function assignTagToActive(tag: string | null): CallRecord | null {
  const active = getActive();
  if (!active) return null;
  // Toggle: pressing the shortcut for the already-assigned tag clears it.
  const next = active.tag === tag ? null : tag;
  const updated = store.updateCall(active.id, { tag: next });
  if (updated) broadcast('app-event', { type: 'call:updated', record: updated });
  return updated;
}

function assignTagByIndex(idx: number): void {
  const s = store.getSettings();
  const tag = s.tags[idx]?.name;
  if (!tag) return;
  assignTagToActive(tag);
}

function reRegisterShortcuts(): void {
  const s = store.getSettings();
  const failures = registerShortcuts(s.shortcuts, {
    start: () => startCall(),
    startMeeting: () => startCall('meeting'),
    end: () => { void endCall(); },
    toggle: () => toggleMainWindow(),
    toggleHold: () => toggleHold(),
    togglePauseRecording: () => togglePauseRecording(),
    openSettings: () => showMainWindowAt('settings'),
    assignTag: (idx) => assignTagByIndex(idx),
  });
  if (failures.length > 0) {
    notify('ショートカット登録失敗', `登録できませんでした: ${failures.join(', ')}`);
  }
}

function setupIpc(): void {
  ipcMain.handle('calls:list', () => store.getCalls());
  ipcMain.handle('calls:getActive', () => store.getActiveCall());
  ipcMain.handle('calls:get', (_e, id: string) => store.getCall(id));

  ipcMain.handle('calls:startNow', (_e, kind?: RecordKind) => startCall(kind ?? 'call'));
  ipcMain.handle('calls:endNow', () => endCall());
  ipcMain.handle('calls:toggleHold', () => toggleHold());

  // 進行中の記録に現在時刻のマーカーを打つ（HUD・ヘッダーから）
  ipcMain.handle('calls:add-marker', (_e, callId?: string, label?: string) => {
    const rec = callId ? store.getCall(callId) : getActive();
    if (!rec) return null;
    const at = rec.endTime
      ? 0
      : Math.max(0, Math.round((Date.now() - new Date(rec.startTime).getTime()) / 1000));
    const marker: Marker = label ? { at, label } : { at };
    const markers = [...(rec.markers ?? []), marker].sort((a, b) => a.at - b.at);
    const updated = store.updateCall(rec.id, { markers });
    if (updated) {
      broadcast('app-event', { type: 'call:updated', record: updated });
      broadcast('app-event', { type: 'marker:added', callId: rec.id, marker, count: markers.length });
    }
    return updated;
  });

  ipcMain.handle('calls:update', (_e, id: string, patch: Partial<CallRecord>) => {
    const updated = store.updateCall(id, patch);
    if (updated) broadcast('app-event', { type: 'call:updated', record: updated });
    return updated;
  });

  ipcMain.handle('calls:delete', async (_e, id: string) => {
    const rec = store.getCall(id);
    if (rec?.audio) {
      try { await recording.deleteRecording(rec.audio.path); } catch { /* ignore */ }
    }
    const ok = store.deleteCall(id);
    if (ok) broadcast('app-event', { type: 'call:deleted', id });
    return ok;
  });

  ipcMain.handle('calls:create', (_e, partial: Partial<CallRecord>) => {
    const rec: CallRecord = {
      id: nanoid(),
      kind: partial.kind ?? 'call',
      startTime: partial.startTime ?? new Date().toISOString(),
      endTime: partial.endTime ?? null,
      durationSec: partial.durationSec ?? null,
      tag: partial.tag ?? null,
      memo: partial.memo ?? '',
      contactName: partial.contactName,
      phoneNumber: partial.phoneNumber,
      title: partial.title,
      participants: partial.participants,
      holds: partial.holds ?? [],
      holdSec: partial.holdSec ?? 0,
    };
    if (rec.startTime && rec.endTime && rec.durationSec === null) {
      rec.durationSec = Math.max(
        0,
        Math.round((new Date(rec.endTime).getTime() - new Date(rec.startTime).getTime()) / 1000),
      );
    }
    store.addCall(rec);
    broadcast('app-event', { type: 'call:updated', record: rec });
    return rec;
  });

  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:update', (_e, next: Settings) => {
    const prev = store.getSettings();
    store.setSettings(next);
    reRegisterShortcuts();
    setMinimizeToTray(next.minimizeToTray);
    if (prev.hudSize !== next.hudSize) setHudSize(next.hudSize);
    broadcast('app-event', { type: 'settings:updated', settings: next });
    return next;
  });

  ipcMain.handle('csv:export', async (_e, opts: CsvExportOptions) => {
    const result = await dialog.showSaveDialog({
      title: 'CSV をエクスポート',
      defaultPath: `callstack-${localDate(new Date())}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true } as const;
    const count = await exportCsv(result.filePath, store.getCalls(), opts);
    return { canceled: false, count, path: result.filePath } as const;
  });

  const importCsvText = async (raw: string): Promise<{ result: CsvImportResult; backupPath: string }> => {
    const parsed = parseCsv(raw);
    const errors: Array<{ row: number; message: string }> = [];
    const ok: CallRecord[] = [];
    let skipped = 0;
    for (const p of parsed) {
      if (p.error) { errors.push({ row: p.rowNumber, message: p.error }); continue; }
      if (!p.record || !p.record.startTime) { skipped += 1; continue; }
      const r: CallRecord = {
        id: p.record.id ?? nanoid(),
        kind: p.record.kind ?? 'call',
        startTime: p.record.startTime,
        endTime: p.record.endTime ?? null,
        durationSec: p.record.durationSec ?? null,
        tag: p.record.tag ?? null,
        memo: p.record.memo ?? '',
        contactName: p.record.contactName,
        phoneNumber: p.record.phoneNumber,
        title: p.record.title,
        participants: p.record.participants,
        holdSec: p.record.holdSec ?? 0,
      };
      ok.push(r);
    }
    const backupPath = await store.backupNow('pre-import');
    const { inserted, updated } = store.upsertMany(ok);
    for (const r of ok) broadcast('app-event', { type: 'call:updated', record: store.getCall(r.id)! });
    return { result: { inserted, updated, skipped, errors }, backupPath };
  };

  ipcMain.handle('csv:import', async (): Promise<{ canceled: true } | { canceled: false; result: CsvImportResult; backupPath: string }> => {
    const dlg = await dialog.showOpenDialog({
      title: 'CSV を読み込み',
      filters: [{ name: 'CSV', extensions: ['csv'] }],
      properties: ['openFile'],
    });
    if (dlg.canceled || dlg.filePaths.length === 0) return { canceled: true };
    const raw = await fs.readFile(dlg.filePaths[0], 'utf-8');
    const r = await importCsvText(raw);
    return { canceled: false, ...r };
  });

  ipcMain.handle('csv:import-text', async (_e, text: string) => {
    const r = await importCsvText(text);
    return { canceled: false as const, ...r };
  });

  ipcMain.handle('report:weekly', async () => {
    const md = buildWeeklyReport(store.getCalls());
    const result = await dialog.showSaveDialog({
      title: '週次レポートを保存',
      defaultPath: `report-${weekStamp()}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true } as const;
    await fs.writeFile(result.filePath, md, 'utf-8');
    return { canceled: false, path: result.filePath } as const;
  });

  ipcMain.handle('hud:end', () => endCall());
  ipcMain.handle('hud:open-main', () => showMainWindow());
  ipcMain.handle('hud:save-position', (_e, pos: { x: number; y: number }) => {
    const s = store.getSettings();
    store.setSettings({ ...s, hudPosition: pos });
  });
  ipcMain.handle('hud:cycle-size', () => {
    const s = store.getSettings();
    const next = nextHudSize(s.hudSize);
    const updated = { ...s, hudSize: next };
    store.setSettings(updated);
    setHudSize(next);
    broadcast('app-event', { type: 'settings:updated', settings: updated });
    return next;
  });
  ipcMain.handle('hud:assign-tag', (_e, tag: string | null) => assignTagToActive(tag));
  ipcMain.handle('hud:set-extra-height', (_e, extraPx: number) => {
    setHudExtraHeight(extraPx, store.getSettings().hudSize);
  });

  ipcMain.handle('hud:get-position', () => {
    const win = getHudWindow();
    if (!win) return null;
    const [x, y] = win.getPosition();
    return { x, y };
  });

  // ============ Recording ============
  ipcMain.handle('recording:append-chunk', async (_e, callId: string, buf: ArrayBuffer) => {
    await recording.appendChunk(callId, Buffer.from(buf));
    return true;
  });

  ipcMain.handle('recording:finalize', async (_e, callId: string, sourceLabel?: AudioSourceLabel) => {
    const s = store.getSettings();
    const r = await recording.finalize(callId, s.recording.mp3Bitrate);
    if (!r) return null;
    const updated = store.updateCall(callId, {
      audio: {
        path: r.path,
        format: 'mp3',
        bytes: r.bytes,
        durationSec: r.durationSec,
        source: sourceLabel ?? 'mic',
      },
    });
    if (updated) {
      broadcast('app-event', {
        type: 'recording:finalized',
        callId,
        path: r.path,
        bytes: r.bytes,
        durationSec: r.durationSec,
      });
      broadcast('app-event', { type: 'call:updated', record: updated });
      if (s.recording.autoTranscribe) {
        queueTranscription(callId);
      }
    }
    return updated;
  });

  ipcMain.handle('recording:abort', async (_e, callId: string) => {
    await recording.abort(callId);
    return true;
  });

  // HUD やショートカットからの一時停止指示を、録音中のレンダラへ中継する
  ipcMain.handle('recording:toggle-pause', () => {
    togglePauseRecording();
    return true;
  });

  // メイン窓のレコーダから届く録音レベルを HUD へ中継（約5Hz に間引き済み）
  ipcMain.handle('recording:report-level', (_e, level: number) => {
    const hud = getHudWindow();
    if (hud && !hud.isDestroyed()) {
      hud.webContents.send('app-event', { type: 'recording:level', level });
    }
    return true;
  });

  // システム音声のキャプチャ対象（画面全体 / 特定ウィンドウ）を設定
  ipcMain.handle('recording:set-capture-target', (_e, target: { type: 'screen' } | { type: 'window'; sourceId: string }) => {
    captureTarget = target;
    return true;
  });

  // キャプチャ可能なウィンドウ一覧（開始ダイアログのウィンドウ選択用）
  ipcMain.handle('capture:list-windows', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 192, height: 120 },
    });
    return sources
      .filter((s) => s.name && s.name !== 'CallStack')
      .map((s) => ({
        id: s.id,
        name: s.name,
        thumbnail: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
      }));
  });

  // 録音を実行しているレンダラが一時停止状態を確定させたら全ウィンドウへ通知
  ipcMain.handle('recording:set-paused', (_e, callId: string, paused: boolean) => {
    broadcast('app-event', { type: 'recording:paused', callId, paused });
    return true;
  });

  // 録音ファイル (MP3) を名前を付けて保存
  ipcMain.handle('recording:save-as', async (_e, callId: string): Promise<
    { canceled: true } | { canceled: false; path: string } | { canceled: false; error: string }
  > => {
    const rec = store.getCall(callId);
    if (!rec?.audio) return { canceled: false, error: 'この記録には録音がありません。' };
    const { recordings } = getDirs();
    const src = path.join(recordings, rec.audio.path);
    try {
      await fs.access(src);
    } catch {
      return { canceled: false, error: '録音ファイルが見つかりません（削除済みの可能性があります）。' };
    }
    const result = await dialog.showSaveDialog({
      title: '録音を保存',
      defaultPath: `${exportBaseName(rec)}.mp3`,
      filters: [{ name: 'MP3 音声', extensions: ['mp3'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    await fs.copyFile(src, result.filePath);
    return { canceled: false, path: result.filePath };
  });

  // 文字起こしをテキストファイルとして保存
  ipcMain.handle('transcript:save-as', async (_e, callId: string, withTimestamps: boolean): Promise<
    { canceled: true } | { canceled: false; path: string } | { canceled: false; error: string }
  > => {
    const rec = store.getCall(callId);
    if (!rec?.transcript) return { canceled: false, error: 'この記録には文字起こしがありません。' };
    const result = await dialog.showSaveDialog({
      title: '文字起こしを保存',
      defaultPath: `${exportBaseName(rec)}${withTimestamps ? '-時刻付き' : ''}.txt`,
      filters: [{ name: 'テキスト', extensions: ['txt'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    await fs.writeFile(result.filePath, buildTranscriptText(rec, withTimestamps), 'utf-8');
    return { canceled: false, path: result.filePath };
  });

  // 議事録 (Markdown) を保存 — メモ・マーカー・文字起こしをまとめて出力
  ipcMain.handle('minutes:save-as', async (_e, callId: string): Promise<
    { canceled: true } | { canceled: false; path: string } | { canceled: false; error: string }
  > => {
    const rec = store.getCall(callId);
    if (!rec) return { canceled: false, error: '記録が見つかりません。' };
    const result = await dialog.showSaveDialog({
      title: '議事録を保存',
      defaultPath: `議事録-${exportBaseName(rec).replace(/^(会議|通話)-/, '')}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    await fs.writeFile(result.filePath, buildMinutesMd(rec), 'utf-8');
    return { canceled: false, path: result.filePath };
  });

  // ============ Transcription ============
  ipcMain.handle('transcription:start', async (_e, callId: string) => {
    const rec = store.getCall(callId);
    if (!rec) return { ok: false, error: '通話記録が見つかりません。' };
    if (!rec.audio) return { ok: false, error: 'この通話には録音がありません。' };
    const s = store.getSettings();
    const setup = await checkTranscriptionSetup(s.transcription.model);
    if (!setup.ok) return setup;
    queueTranscription(callId);
    return { ok: true };
  });

  ipcMain.handle('transcription:cancel', (_e, callId: string) => {
    return cancelTranscription(callId);
  });

  ipcMain.handle('transcription:check-setup', async () => {
    const s = store.getSettings();
    return checkTranscriptionSetup(s.transcription.model);
  });

  ipcMain.handle('transcription:download-model', async (_e, model: WhisperModel) => {
    try {
      await downloadModel(model, (p) => {
        broadcast('app-event', {
          type: 'model:download',
          model,
          receivedBytes: p.receivedBytes,
          totalBytes: p.totalBytes,
          done: false,
        });
      });
      const s = store.getSettings();
      s.transcription.modelDownloaded = { ...s.transcription.modelDownloaded, [model]: true };
      store.setSettings(s);
      broadcast('app-event', {
        type: 'model:download',
        model,
        receivedBytes: 0,
        totalBytes: null,
        done: true,
      });
      return { ok: true };
    } catch (err) {
      const message = (err as Error).message;
      broadcast('app-event', {
        type: 'model:download',
        model,
        receivedBytes: 0,
        totalBytes: null,
        done: true,
        error: message,
      });
      return { ok: false, error: message };
    }
  });

  ipcMain.handle('transcription:model-status', async (_e, model: WhisperModel) => {
    return { downloaded: await isModelDownloaded(model), path: getModelPath(model) };
  });

  // ============ Devices ============
  // Renderer enumerates via navigator.mediaDevices, but the main process
  // controls whether the request is allowed via setPermissionRequestHandler.
  ipcMain.handle('retention:run-now', async () => {
    return cleanupExpiredRecordings(store, broadcast);
  });

  // ============ Backup / Restore ============
  ipcMain.handle('backup:create', async () => {
    return store.backupNow('manual');
  });

  ipcMain.handle('backup:restore', async (): Promise<
    { canceled: true } | { canceled: false; calls: number; backupPath: string }
  > => {
    const result = await dialog.showOpenDialog({
      title: 'バックアップ JSON を選択',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) return { canceled: true };
    const raw = await fs.readFile(result.filePaths[0], 'utf-8');
    const json = JSON.parse(raw);
    const { calls } = await store.restoreFromJson(json);
    const backupPath = path.join(
      app.getPath('userData'),
      'backups',
      `data-${localDate(new Date()).replace(/-/g, '')}-pre-restore.json`,
    );
    broadcast('app-event', { type: 'settings:updated', settings: store.getSettings() });
    broadcast('app-event', { type: 'data:restored' });
    return { canceled: false, calls, backupPath };
  });

  ipcMain.handle('backup:restore-json', async (_e, json: unknown): Promise<{ calls: number; backupPath: string }> => {
    const { calls } = await store.restoreFromJson(json);
    const backupPath = path.join(
      app.getPath('userData'),
      'backups',
      `data-${localDate(new Date()).replace(/-/g, '')}-pre-restore.json`,
    );
    broadcast('app-event', { type: 'settings:updated', settings: store.getSettings() });
    broadcast('app-event', { type: 'data:restored' });
    return { calls, backupPath };
  });
}

function queueTranscription(callId: string): void {
  const rec = store.getCall(callId);
  if (!rec || !rec.audio) return;
  const { recordings } = getDirs();
  const abs = path.join(recordings, rec.audio.path);
  const s = store.getSettings();
  const updated = store.updateCall(callId, { transcriptStatus: 'queued', transcriptError: undefined });
  if (updated) broadcast('app-event', { type: 'transcription:status', callId, status: 'queued' });
  enqueueTranscription(callId, {
    audioPath: abs,
    model: s.transcription.model,
    language: s.transcription.language,
    prompt: s.transcription.prompt,
  });
}

/** 保存ダイアログの既定ファイル名（例: 会議-20260613-1030-定例MTG） */
function exportBaseName(rec: CallRecord): string {
  const d = new Date(rec.startTime);
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  const label = rec.kind === 'meeting' ? '会議' : '通話';
  const name = (rec.kind === 'meeting' ? rec.title : rec.contactName) ?? '';
  const safe = name.replace(/[\\/:*?"<>|\r\n]+/g, '-').trim();
  return safe ? `${label}-${stamp}-${safe}` : `${label}-${stamp}`;
}

function buildTranscriptText(rec: CallRecord, withTimestamps: boolean): string {
  const t = rec.transcript!;
  const isMeeting = rec.kind === 'meeting';
  const lines: string[] = [];
  lines.push(`${isMeeting ? '会議' : '通話'}の文字起こし`);
  if (isMeeting && rec.title) lines.push(`タイトル: ${rec.title}`);
  if (isMeeting && rec.participants?.length) lines.push(`参加者: ${rec.participants.join('、')}`);
  if (!isMeeting && rec.contactName) lines.push(`連絡先: ${rec.contactName}`);
  if (!isMeeting && rec.phoneNumber) lines.push(`電話番号: ${rec.phoneNumber}`);
  lines.push(`日時: ${rec.startTime.slice(0, 16).replace('T', ' ')}`);
  if (rec.durationSec !== null) lines.push(`時間: ${formatHMS(rec.durationSec)}`);
  lines.push(`モデル: ${t.model} / 言語: ${t.language || '自動'}`);
  lines.push('');
  if (withTimestamps && t.segments && t.segments.length > 0) {
    for (const s of t.segments) {
      lines.push(`[${formatHMS(Math.floor(s.start))}] ${s.text}`);
    }
  } else {
    lines.push(t.text);
  }
  lines.push('');
  return lines.join('\r\n');
}

function buildMinutesMd(rec: CallRecord): string {
  const isMeeting = rec.kind === 'meeting';
  const dt = rec.startTime.slice(0, 16).replace('T', ' ');
  const lines: string[] = [];
  lines.push(`# ${isMeeting ? '議事録' : '通話記録'}: ${rec.title || rec.contactName || dt}`);
  lines.push('');
  lines.push(`- 日時: ${dt}`);
  if (rec.durationSec !== null) lines.push(`- 時間: ${formatHMS(rec.durationSec)}`);
  if (isMeeting && rec.participants?.length) lines.push(`- 参加者: ${rec.participants.join('、')}`);
  if (!isMeeting && rec.contactName) lines.push(`- 連絡先: ${rec.contactName}${rec.phoneNumber ? ` (${rec.phoneNumber})` : ''}`);
  if (rec.tag) lines.push(`- タグ: ${rec.tag}`);
  lines.push('');
  if (rec.memo) {
    lines.push('## メモ');
    lines.push('');
    lines.push(rec.memo);
    lines.push('');
  }
  if (rec.markers?.length) {
    lines.push('## マーカー');
    lines.push('');
    for (const m of rec.markers) {
      lines.push(`- \`${formatHMS(m.at)}\` ${m.label ?? ''}`.trimEnd());
    }
    lines.push('');
  }
  if (rec.transcript) {
    lines.push('## 文字起こし');
    lines.push('');
    lines.push(`（モデル: ${rec.transcript.model} / 言語: ${rec.transcript.language || '自動'}）`);
    lines.push('');
    const segments = rec.transcript.segments ?? [];
    if (segments.length > 0) {
      for (const s of segments) {
        lines.push(`\`${formatHMS(Math.floor(s.start))}\` ${s.text}`);
      }
    } else {
      lines.push(rec.transcript.text);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function setupTranscriptionHandlers(): void {
  setQueueHandlers({
    onStart: (callId) => {
      const updated = store.updateCall(callId, { transcriptStatus: 'running' });
      if (updated) broadcast('app-event', { type: 'transcription:status', callId, status: 'running' });
    },
    onProgress: (callId, percent) => {
      broadcast('app-event', { type: 'transcription:progress', callId, percent });
    },
    onCancelled: (callId) => {
      const rec = store.getCall(callId);
      // 過去の文字起こしが残っていれば done、なければ none に戻す
      const status = rec?.transcript ? 'done' : 'none';
      const updated = store.updateCall(callId, { transcriptStatus: status, transcriptError: undefined });
      if (updated) broadcast('app-event', { type: 'transcription:status', callId, status });
    },
    onDone: (callId, transcript) => {
      const updated = store.updateCall(callId, { transcript, transcriptStatus: 'done', transcriptError: undefined });
      if (updated) {
        broadcast('app-event', { type: 'transcription:status', callId, status: 'done', transcript });
        broadcast('app-event', { type: 'call:updated', record: updated });
      }
    },
    onError: (callId, err) => {
      const message = err instanceof WhisperMissingError
        ? `whisper.cpp の実行ファイルが見つかりません。READMEの「文字起こしの準備」を参照してください。\n(${err.binaryPath})`
        : err.message;
      const updated = store.updateCall(callId, { transcriptStatus: 'error', transcriptError: message });
      if (updated) broadcast('app-event', { type: 'transcription:status', callId, status: 'error', error: message });
    },
  });
}

function weekStamp(): string {
  const d = new Date();
  const onejan = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - onejan.getTime()) / 86400000 + onejan.getDay() + 1) / 7);
  return `${d.getFullYear()}W${String(week).padStart(2, '0')}`;
}

function buildWeeklyReport(calls: CallRecord[]): string {
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((day + 6) % 7));
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 7);

  const target = calls.filter((c) => {
    const t = new Date(c.startTime).getTime();
    return t >= monday.getTime() && t < sunday.getTime() && c.endTime;
  });
  const total = target.reduce((sum, c) => sum + (c.durationSec ?? 0), 0);
  const totalHold = target.reduce((sum, c) => sum + (c.holdSec ?? 0), 0);
  const avg = target.length ? Math.round(total / target.length) : 0;
  const byTag = new Map<string, { count: number; sec: number }>();
  for (const c of target) {
    const k = c.tag ?? '（タグなし）';
    const cur = byTag.get(k) ?? { count: 0, sec: 0 };
    cur.count += 1;
    cur.sec += c.durationSec ?? 0;
    byTag.set(k, cur);
  }
  const top3 = [...target].sort((a, b) => (b.durationSec ?? 0) - (a.durationSec ?? 0)).slice(0, 3);

  const fmt = (s: number) => formatHMS(s);
  const lines: string[] = [];
  lines.push(`# 週次レポート ${weekStamp()}`);
  lines.push('');
  lines.push(`期間: ${localDate(monday)} 〜 ${localDate(new Date(sunday.getTime() - 1))}`);
  lines.push('');
  lines.push('## サマリー');
  lines.push(`- 通話数: ${target.length}`);
  lines.push(`- 合計時間: ${fmt(total)}`);
  lines.push(`- 純通話時間: ${fmt(Math.max(0, total - totalHold))}`);
  lines.push(`- 保留合計: ${fmt(totalHold)}`);
  lines.push(`- 平均時間: ${fmt(avg)}`);
  lines.push('');
  lines.push('## タグ別');
  lines.push('| タグ | 件数 | 合計 |');
  lines.push('|------|------|------|');
  for (const [tag, v] of [...byTag.entries()].sort((a, b) => b[1].sec - a[1].sec)) {
    lines.push(`| ${tag} | ${v.count} | ${fmt(v.sec)} |`);
  }
  lines.push('');
  lines.push('## 最長通話 TOP3');
  for (const c of top3) {
    lines.push(`- ${c.startTime.slice(0, 16).replace('T', ' ')} — ${fmt(c.durationSec ?? 0)} — ${c.tag ?? 'タグなし'} — ${c.memo || ''}`);
  }
  lines.push('');
  return lines.join('\n');
}

function setupMediaPermissions(): void {
  // Allow media (microphone) and display capture requests from our windows.
  session.defaultSession.setPermissionRequestHandler((_wc: WebContents, permission, callback) => {
    if (permission === 'media' || permission === 'display-capture') {
      callback(true);
    } else {
      callback(false);
    }
  });
}

function setupDisplayCapture(): void {
  // Required so navigator.mediaDevices.getDisplayMedia({ audio: true }) actually
  // captures the system audio loopback. Without this handler, Chromium on
  // Windows silently drops the audio track and the user sees only the mic.
  type DisplayHandler = (
    req: unknown,
    cb: (streams: { video?: unknown; audio?: 'loopback' | 'loopbackWithMute' }) => void,
  ) => void;
  type SessionWithDisplay = typeof session.defaultSession & {
    setDisplayMediaRequestHandler?: (handler: DisplayHandler, opts?: { useSystemPicker?: boolean }) => void;
  };
  const s = session.defaultSession as SessionWithDisplay;
  if (typeof s.setDisplayMediaRequestHandler !== 'function') return;
  s.setDisplayMediaRequestHandler((_req, callback) => {
    const target = captureTarget;
    if (target.type === 'window') {
      // 指定ウィンドウを対象にする。見つからなければ画面全体へフォールバック。
      // 注: Windows の loopback 音声はシステム全体が対象のため、環境によっては
      // ウィンドウ選択でも全体の音声が録音される。
      desktopCapturer.getSources({ types: ['window', 'screen'] })
        .then((sources) => {
          const win = sources.find((src) => src.id === target.sourceId);
          const screenSrc = sources.find((src) => src.id.startsWith('screen:'));
          callback({ video: win ?? screenSrc, audio: 'loopback' });
        })
        .catch(() => callback({}));
      return;
    }
    desktopCapturer.getSources({ types: ['screen'] })
      .then((sources) => {
        callback({ video: sources[0], audio: 'loopback' });
      })
      .catch(() => callback({}));
  }, { useSystemPicker: false });
}

async function main() {
  // Establish the Windows AppUserModelID and product name BEFORE any window is
  // created, so the taskbar / notifications / jump lists show "CallStack"
  // instead of the generic "Electron".
  app.setName('CallStack');
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.callstack.app');
  }

  const gotTheLock = app.requestSingleInstanceLock();
  if (!gotTheLock) {
    app.quit();
    return;
  }
  app.on('second-instance', () => {
    showMainWindow();
  });

  await app.whenReady();
  await ensureAppDirs();
  await store.init();
  setupIpc();
  setupTranscriptionHandlers();
  setupMediaPermissions();
  setupDisplayCapture();
  registerAppProtocol();

  createTray(trayHandlers);
  updateTray({ active: false, today: todayStats() }, trayHandlers);

  reRegisterShortcuts();
  setMinimizeToTray(store.getSettings().minimizeToTray);
  createMainWindow();
  scheduleDailyCleanup(store, broadcast);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    } else {
      showMainWindow();
    }
  });

  // Restart tick + HUD if there's a stale active call from previous run
  if (getActive()) {
    createHudWindow(store.getSettings().hudPosition, store.getSettings().hudSize);
    updateTray({ active: true, elapsedSec: 0, today: todayStats() }, trayHandlers);
    startTickLoop();
  }
}

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') {
    // mac: do nothing, keep app alive
  }
});

app.on('will-quit', () => {
  unregisterAll();
  stopTickLoop();
  stopDailyCleanup();
  destroyTray();
});

app.on('before-quit', async () => {
  await store.flush().catch(() => {});
});

main().catch((err) => {
  console.error('[main] fatal:', err);
  app.exit(1);
});
