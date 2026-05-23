import { app, BrowserWindow, ipcMain, dialog, session, WebContents, desktopCapturer } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { Store } from './store';
import {
  CallRecord, CsvExportOptions, CsvImportResult, Settings,
  CallTranscript, WhisperModel,
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
} from './window';
import { createTray, updateTray, destroyTray, TrayHandlers } from './tray';
import { exportCsv, parseCsv } from './csv';
import { notify } from './notifications';
import { ensureAppDirs, getDirs } from './paths';
import { registerAppProtocol, registerAppProtocolPrivilege } from './protocol';
import * as recording from './recording';
import { enqueue as enqueueTranscription, setQueueHandlers, WhisperMissingError, checkSetup as checkTranscriptionSetup } from './transcription';
import { downloadModel, isModelDownloaded, getModelPath } from './whisperModels';
import { scheduleDailyCleanup, stopDailyCleanup, cleanupExpiredRecordings } from './retention';
import { localDate } from './localTime';

registerAppProtocolPrivilege();

const store = new Store();

let tickInterval: NodeJS.Timeout | null = null;
let longCallAlertFired = false;

function getActive(): CallRecord | null {
  return store.getActiveCall();
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
      { active: true, elapsedSec, holding, recording: store.getSettings().recording.enabled },
      trayHandlers,
    );

    const alertMin = store.getSettings().longCallAlertMin;
    if (alertMin && alertMin > 0 && !longCallAlertFired && elapsedSec >= alertMin * 60) {
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

function startCall(): CallRecord | null {
  if (getActive()) {
    notify('TelTimeStack', '進行中の通話があります。先に終了してください。');
    return null;
  }
  const now = new Date().toISOString();
  const rec: CallRecord = {
    id: nanoid(),
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
  createHudWindow(settings.hudPosition);
  updateTray({ active: true, elapsedSec: 0 }, trayHandlers);
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
  updateTray({ active: false }, trayHandlers);
  if (updated) {
    broadcast('app-event', { type: 'call:ended', record: updated });
    notify('通話を記録しました', `${formatHMS(durationSec)} — クリックで詳細編集`, () => showMainWindow());
  }
  return updated;
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
    defaultPath: `teltimestack-${localDate(new Date())}.csv`,
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (result.canceled || !result.filePath) return null;
  const count = await exportCsv(result.filePath, store.getCalls(), { range: 'all' });
  return { count, path: result.filePath };
}

const trayHandlers: TrayHandlers = {
  onStart: () => startCall(),
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
    updateTray({ active: !!getActive() }, trayHandlers);
  },
  getTheme: () => store.getSettings().theme,
};

function reRegisterShortcuts(): void {
  const s = store.getSettings();
  const failures = registerShortcuts(s.shortcuts, {
    start: () => startCall(),
    end: () => { void endCall(); },
    toggle: () => toggleMainWindow(),
    toggleHold: () => toggleHold(),
    openSettings: () => showMainWindowAt('settings'),
  });
  if (failures.length > 0) {
    notify('ショートカット登録失敗', `登録できませんでした: ${failures.join(', ')}`);
  }
}

function setupIpc(): void {
  ipcMain.handle('calls:list', () => store.getCalls());
  ipcMain.handle('calls:getActive', () => store.getActiveCall());
  ipcMain.handle('calls:get', (_e, id: string) => store.getCall(id));

  ipcMain.handle('calls:startNow', () => startCall());
  ipcMain.handle('calls:endNow', () => endCall());
  ipcMain.handle('calls:toggleHold', () => toggleHold());

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
      startTime: partial.startTime ?? new Date().toISOString(),
      endTime: partial.endTime ?? null,
      durationSec: partial.durationSec ?? null,
      tag: partial.tag ?? null,
      memo: partial.memo ?? '',
      contactName: partial.contactName,
      phoneNumber: partial.phoneNumber,
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
    store.setSettings(next);
    reRegisterShortcuts();
    setMinimizeToTray(next.minimizeToTray);
    broadcast('app-event', { type: 'settings:updated', settings: next });
    return next;
  });

  ipcMain.handle('csv:export', async (_e, opts: CsvExportOptions) => {
    const result = await dialog.showSaveDialog({
      title: 'CSV をエクスポート',
      defaultPath: `teltimestack-${localDate(new Date())}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true } as const;
    const count = await exportCsv(result.filePath, store.getCalls(), opts);
    return { canceled: false, count, path: result.filePath } as const;
  });

  ipcMain.handle('csv:import', async (): Promise<{ canceled: true } | { canceled: false; result: CsvImportResult; backupPath: string }> => {
    const dlg = await dialog.showOpenDialog({
      title: 'CSV を読み込み',
      filters: [{ name: 'CSV', extensions: ['csv'] }],
      properties: ['openFile'],
    });
    if (dlg.canceled || dlg.filePaths.length === 0) return { canceled: true };
    const filePath = dlg.filePaths[0];
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = parseCsv(raw);
    const errors: Array<{ row: number; message: string }> = [];
    const ok: CallRecord[] = [];
    let skipped = 0;
    for (const p of parsed) {
      if (p.error) { errors.push({ row: p.rowNumber, message: p.error }); continue; }
      if (!p.record || !p.record.startTime) { skipped += 1; continue; }
      const r: CallRecord = {
        id: p.record.id ?? nanoid(),
        startTime: p.record.startTime,
        endTime: p.record.endTime ?? null,
        durationSec: p.record.durationSec ?? null,
        tag: p.record.tag ?? null,
        memo: p.record.memo ?? '',
        contactName: p.record.contactName,
        phoneNumber: p.record.phoneNumber,
        holdSec: p.record.holdSec ?? 0,
      };
      ok.push(r);
    }
    const backupPath = await store.backupNow('pre-import');
    const { inserted, updated } = store.upsertMany(ok);
    // Broadcast a generic settings refresh so renderer reloads list
    for (const r of ok) broadcast('app-event', { type: 'call:updated', record: store.getCall(r.id)! });
    return { canceled: false, result: { inserted, updated, skipped, errors }, backupPath };
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

  ipcMain.handle('recording:finalize', async (_e, callId: string) => {
    const s = store.getSettings();
    const source = s.recording.source;
    const r = await recording.finalize(callId, s.recording.mp3Bitrate);
    if (!r) return null;
    const updated = store.updateCall(callId, {
      audio: {
        path: r.path,
        format: 'mp3',
        bytes: r.bytes,
        durationSec: r.durationSec,
        source,
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
  });
}

function setupTranscriptionHandlers(): void {
  setQueueHandlers({
    onStart: (callId) => {
      const updated = store.updateCall(callId, { transcriptStatus: 'running' });
      if (updated) broadcast('app-event', { type: 'transcription:status', callId, status: 'running' });
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
    desktopCapturer.getSources({ types: ['screen'] })
      .then((sources) => {
        callback({ video: sources[0], audio: 'loopback' });
      })
      .catch(() => callback({}));
  }, { useSystemPicker: false });
}

async function main() {
  // Establish the Windows AppUserModelID and product name BEFORE any window is
  // created, so the taskbar / notifications / jump lists show "TelTimeStack"
  // instead of the generic "Electron".
  app.setName('TelTimeStack');
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.teltimestack.app');
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
  updateTray({ active: false }, trayHandlers);

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
    createHudWindow(store.getSettings().hudPosition);
    updateTray({ active: true, elapsedSec: 0 }, trayHandlers);
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
