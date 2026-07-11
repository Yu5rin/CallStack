import { app, BrowserWindow, ipcMain, dialog, session, shell, powerSaveBlocker, WebContents, desktopCapturer } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { Store } from './store';
import {
  CallRecord, CsvExportOptions, CsvImportResult, Settings,
  CallTranscript, WhisperModel, RecordKind, AudioSourceLabel, Marker,
  RecordingSourceConfig,
} from '../shared/types';
import { registerShortcuts, unregisterAll } from './shortcuts';
import {
  createMainWindow,
  toggleMainWindow,
  showMainWindow,
  showMainWindowAt,
  createHudWindow,
  closeHudWindow,
  createRecorderWindow,
  destroyRecorderWindow,
  broadcast,
  getHudWindow,
  markForceQuit,
  setBeforeCloseHandler,
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
import { convertWebmToMp3, probeDurationSec } from './ffmpeg';
import {
  enqueue as enqueueTranscription, cancel as cancelTranscription,
  setQueueHandlers, WhisperMissingError, checkSetup as checkTranscriptionSetup,
  queueLength as transcriptionQueueLength, shutdownQueue as shutdownTranscription,
} from './transcription';
import { downloadModel, isModelDownloaded, getModelPath } from './whisperModels';
import { scheduleDailyCleanup, stopDailyCleanup, cleanupExpiredRecordings } from './retention';
import { localDate } from './localTime';
import { getLogPath, logInfo } from './log';
import { downloadWhisperBinary, isBinaryInstalled } from './whisperBinary';
import { checkForUpdate, checkOnStartup } from './updates';

registerAppProtocolPrivilege();

const store = new Store();

let tickInterval: NodeJS.Timeout | null = null;
let longCallAlertFired = false;

/** システム音声キャプチャの対象。録音開始前にレンダラから設定される */
let captureTarget: { type: 'screen' } | { type: 'window'; sourceId: string } = { type: 'screen' };

/** 開始ダイアログで選択された、次の録音1回分のソース上書き */
let pendingSourceOverride: {
  config: RecordingSourceConfig;
  windowId: string | null;
  micDeviceId: string | null;
} | null = null;

/** 録音サービスウィンドウが報告する現在の録音状態（HUD 等の初期表示用） */
let lastRecordingState = { recording: false, paused: false };

/** 実行中の finalize（webm→mp3 変換）数。終了時にこれを待つ */
let finalizingCount = 0;

/** アプリ終了フロー中フラグ */
let shuttingDown = false;

// ============ スリープ抑止 ============
// 記録中（=録音の可能性あり）または文字起こし中は PC のスリープを防ぐ。
// スリープすると録音が途切れ、whisper も中断されるため。
let powerBlockerId: number | null = null;

function updatePowerBlocker(): void {
  const needed = !!store.getActiveCall() || transcriptionQueueLength() > 0 || finalizingCount > 0;
  if (needed && powerBlockerId === null) {
    powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    logInfo('power', 'sleep blocker ON');
  } else if (!needed && powerBlockerId !== null) {
    powerSaveBlocker.stop(powerBlockerId);
    powerBlockerId = null;
    logInfo('power', 'sleep blocker OFF');
  }
}

function getActive(): CallRecord | null {
  return store.getActiveCall();
}

function todayStats(): { calls: { count: number; totalSec: number }; meetings: { count: number; totalSec: number } } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const calls = { count: 0, totalSec: 0 };
  const meetings = { count: 0, totalSec: 0 };
  for (const c of store.getCalls()) {
    if (!c.endTime || c.deletedAt) continue;
    if (new Date(c.startTime).getTime() < start) continue;
    const bucket = c.kind === 'meeting' ? meetings : calls;
    bucket.count++;
    bucket.totalSec += c.durationSec ?? 0;
  }
  return { calls, meetings };
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

/** 記録を開始する。meta で開始前に入力されたタイトル・連絡先などを反映できる */
function startCall(kind: RecordKind = 'call', meta?: Partial<CallRecord>): CallRecord | null {
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
    tag: meta?.tag ?? null,
    memo: meta?.memo ?? '',
    contactName: meta?.contactName,
    phoneNumber: meta?.phoneNumber,
    title: meta?.title,
    participants: meta?.participants,
    holds: [],
    holdSec: 0,
  };
  store.addCall(rec);
  longCallAlertFired = false;
  logInfo('call', `started ${kind} ${rec.id}`);
  const settings = store.getSettings();
  createHudWindow(settings.hudPosition, settings.hudSize);
  updateTray({ active: true, elapsedSec: 0, today: todayStats() }, trayHandlers);
  startTickLoop();
  updatePowerBlocker();
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
  updatePowerBlocker();
  logInfo('call', `ended ${active.id} (${durationSec}s)`);
  if (updated) {
    broadcast('app-event', { type: 'call:ended', record: updated });
    const label = updated.kind === 'meeting' ? '会議を記録しました' : '通話を記録しました';
    notify(label, `${formatHMS(durationSec)} — クリックで詳細編集`, () => showMainWindow());
  }
  return updated;
}

/** 指定（または進行中）の記録に現在時刻のマーカーを追加する */
function addMarkerTo(callId?: string, label?: string): CallRecord | null {
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

/**
 * 前回の保存先フォルダを既定にする保存ダイアログ。
 * 保存が確定したらフォルダを記憶する。
 */
async function showSaveDialogRemembered(
  title: string,
  fileName: string,
  filters: Electron.FileFilter[],
): Promise<string | null> {
  const s = store.getSettings();
  // fixed: 設定で決めたフォルダを常に既定にする / auto: 前回の保存先を記憶
  const baseDir = (s.saveDirMode === 'fixed' && s.fixedSaveDir)
    ? s.fixedSaveDir
    : (s.lastSaveDir ?? app.getPath('documents'));
  const result = await dialog.showSaveDialog({
    title,
    defaultPath: path.join(baseDir, fileName),
    filters,
  });
  if (result.canceled || !result.filePath) return null;
  if (s.saveDirMode !== 'fixed') {
    store.setSettings({ ...store.getSettings(), lastSaveDir: path.dirname(result.filePath) });
  }
  return result.filePath;
}

async function chooseAndExport(): Promise<{ count: number; path: string } | null> {
  const filePath = await showSaveDialogRemembered(
    'CSV をエクスポート',
    `callstack-${localDate(new Date())}.csv`,
    [{ name: 'CSV', extensions: ['csv'] }],
  );
  if (!filePath) return null;
  const count = await exportCsv(filePath, store.getCalls().filter((c) => !c.deletedAt), { range: 'all' });
  return { count, path: filePath };
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
    addMarker: () => { addMarkerTo(); },
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

  ipcMain.handle('calls:startNow', (_e, kind?: RecordKind, meta?: Partial<CallRecord>) =>
    startCall(kind ?? 'call', meta));
  ipcMain.handle('calls:endNow', () => endCall());
  ipcMain.handle('calls:toggleHold', () => toggleHold());

  // 進行中の記録に現在時刻のマーカーを打つ（HUD・ヘッダー・ショートカットから）
  ipcMain.handle('calls:add-marker', (_e, callId?: string, label?: string) =>
    addMarkerTo(callId, label));

  ipcMain.handle('calls:update', (_e, id: string, patch: Partial<CallRecord>) => {
    const updated = store.updateCall(id, patch);
    if (updated) broadcast('app-event', { type: 'call:updated', record: updated });
    return updated;
  });

  // 削除はまずゴミ箱へ（ソフトデリート）。録音ファイルは完全削除まで保持する。
  ipcMain.handle('calls:delete', async (_e, id: string) => {
    const updated = store.updateCall(id, { deletedAt: new Date().toISOString() });
    if (updated) broadcast('app-event', { type: 'call:updated', record: updated });
    return !!updated;
  });

  // ゴミ箱から復元
  ipcMain.handle('calls:restore', (_e, id: string) => {
    const updated = store.updateCall(id, { deletedAt: undefined });
    if (updated) broadcast('app-event', { type: 'call:updated', record: updated });
    return updated;
  });

  // 完全削除（録音ファイルごと）
  ipcMain.handle('calls:purge', async (_e, id: string) => {
    const rec = store.getCall(id);
    if (rec?.audio) {
      try { await recording.deleteRecording(rec.audio.path); } catch { /* ignore */ }
    }
    const ok = store.deleteCall(id);
    if (ok) broadcast('app-event', { type: 'call:deleted', id });
    return ok;
  });

  // ゴミ箱を空にする
  ipcMain.handle('calls:purge-trash', async () => {
    const trash = store.getCalls().filter((c) => c.deletedAt);
    for (const rec of trash) {
      if (rec.audio) {
        try { await recording.deleteRecording(rec.audio.path); } catch { /* ignore */ }
      }
      store.deleteCall(rec.id);
      broadcast('app-event', { type: 'call:deleted', id: rec.id });
    }
    return trash.length;
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
    if (prev.launchAtLogin !== next.launchAtLogin) applyLaunchAtLogin(next.launchAtLogin);
    broadcast('app-event', { type: 'settings:updated', settings: next });
    return next;
  });

  // ============ アプリ情報・更新チェック ============
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    logPath: getLogPath(),
    dataDir: app.getPath('userData'),
  }));

  ipcMain.handle('app:open-path', async (_e, target: 'logs' | 'data' | 'recordings') => {
    const p = target === 'logs'
      ? path.dirname(getLogPath())
      : target === 'recordings'
        ? getDirs().recordings
        : app.getPath('userData');
    await shell.openPath(p);
    return true;
  });

  ipcMain.handle('update:check', () => checkForUpdate());
  ipcMain.handle('update:open-releases', async (_e, url?: string) => {
    await shell.openExternal(url ?? 'https://github.com/Yu5rin/CallStack/releases/latest');
    return true;
  });

  ipcMain.handle('csv:export', async (_e, opts: CsvExportOptions) => {
    const filePath = await showSaveDialogRemembered(
      'CSV をエクスポート',
      `callstack-${localDate(new Date())}.csv`,
      [{ name: 'CSV', extensions: ['csv'] }],
    );
    if (!filePath) return { canceled: true } as const;
    const count = await exportCsv(filePath, store.getCalls().filter((c) => !c.deletedAt), opts);
    return { canceled: false, count, path: filePath } as const;
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
    const md = buildWeeklyReport(store.getCalls().filter((c) => !c.deletedAt));
    const filePath = await showSaveDialogRemembered(
      '週次レポートを保存',
      `report-${weekStamp()}.md`,
      [{ name: 'Markdown', extensions: ['md'] }],
    );
    if (!filePath) return { canceled: true } as const;
    await fs.writeFile(filePath, md, 'utf-8');
    return { canceled: false, path: filePath } as const;
  });

  ipcMain.handle('hud:end', () => endCall());
  ipcMain.handle('hud:open-main', () => showMainWindow());
  // HUD の編集ボタン: メイン窓を前面に出して該当記録の編集ダイアログを開く
  ipcMain.handle('hud:open-edit', (_e, callId?: string) => {
    const id = callId ?? getActive()?.id;
    if (!id) return;
    showMainWindow();
    broadcast('app-event', { type: 'edit:record', callId: id });
    // ウィンドウ復帰直後の取りこぼしに備えて少し遅れて再送する
    setTimeout(() => broadcast('app-event', { type: 'edit:record', callId: id }), 400);
  });
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
    logInfo('recorder', `finalize start ${callId}`);
    finalizingCount += 1;
    updatePowerBlocker();
    let r: recording.FinalizeResult | null;
    try {
      r = await recording.finalize(callId, s.recording.mp3Bitrate);
    } finally {
      finalizingCount -= 1;
      updatePowerBlocker();
    }
    logInfo('recorder', `finalize done ${callId} (${r ? `${r.bytes}B ${r.durationSec}s` : 'no data'})`);
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

  // 録音サービスウィンドウから届く録音レベルを各ウィンドウへ中継（約5Hz に間引き済み）
  ipcMain.handle('recording:report-level', (_e, level: number) => {
    broadcast('app-event', { type: 'recording:level', level });
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
      thumbnailSize: { width: 360, height: 225 },
    });
    return sources
      .filter((s) => s.name && s.name !== 'CallStack')
      .map((s) => ({
        id: s.id,
        name: s.name,
        thumbnail: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
      }));
  });

  // 録音サービスウィンドウが録音状態（録音中/一時停止）を報告 → 全ウィンドウへ配信
  ipcMain.handle('recording:report-state', (_e, recording: boolean, paused: boolean) => {
    lastRecordingState = { recording, paused };
    broadcast('app-event', { type: 'recording:state', recording, paused });
    return true;
  });

  // HUD 等が起動直後に現在の録音状態を取得する
  ipcMain.handle('recording:get-state', () => lastRecordingState);

  // 録音サービスウィンドウからのエラー報告 → メイン窓の表示用に配信
  ipcMain.handle('recording:report-error', (_e, message: string) => {
    logInfo('recorder', `error: ${message}`);
    broadcast('app-event', { type: 'recording:error', message });
    return true;
  });

  // 開始ダイアログで選んだソースを「次の録音1回分」として登録
  ipcMain.handle('recording:set-next-source', (_e, payload: {
    config: RecordingSourceConfig;
    windowId: string | null;
    micDeviceId: string | null;
  } | null) => {
    pendingSourceOverride = payload;
    return true;
  });

  // 録音サービスウィンドウが録音開始時に使う構成を解決する
  // （ダイアログの上書きがあれば消費し、なければ種別ごとの既定値）
  ipcMain.handle('recording:get-start-config', (_e, kind: RecordKind) => {
    const s = store.getSettings();
    const override = pendingSourceOverride;
    pendingSourceOverride = null;
    const config = override?.config
      ?? (kind === 'meeting' ? s.recording.meetingSource : s.recording.callSource);
    return {
      enabled: s.recording.enabled,
      config,
      windowId: override?.windowId ?? null,
      micDeviceId: override?.micDeviceId ?? s.recording.micDeviceId,
      soundFeedback: s.soundFeedback,
    };
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
    const filePath = await showSaveDialogRemembered(
      '録音を保存',
      `${exportBaseName(rec)}.mp3`,
      [{ name: 'MP3 音声', extensions: ['mp3'] }],
    );
    if (!filePath) return { canceled: true };
    await fs.copyFile(src, filePath);
    return { canceled: false, path: filePath };
  });

  // 文字起こしをテキストファイルとして保存
  ipcMain.handle('transcript:save-as', async (_e, callId: string, withTimestamps: boolean): Promise<
    { canceled: true } | { canceled: false; path: string } | { canceled: false; error: string }
  > => {
    const rec = store.getCall(callId);
    if (!rec?.transcript) return { canceled: false, error: 'この記録には文字起こしがありません。' };
    const filePath = await showSaveDialogRemembered(
      '文字起こしを保存',
      `${exportBaseName(rec)}${withTimestamps ? '-時刻付き' : ''}.txt`,
      [{ name: 'テキスト', extensions: ['txt'] }],
    );
    if (!filePath) return { canceled: true };
    await fs.writeFile(filePath, buildTranscriptText(rec, withTimestamps), 'utf-8');
    return { canceled: false, path: filePath };
  });

  // 議事録 (Markdown) を保存 — メモ・マーカー・文字起こしをまとめて出力
  ipcMain.handle('minutes:save-as', async (_e, callId: string): Promise<
    { canceled: true } | { canceled: false; path: string } | { canceled: false; error: string }
  > => {
    const rec = store.getCall(callId);
    if (!rec) return { canceled: false, error: '記録が見つかりません。' };
    const filePath = await showSaveDialogRemembered(
      '議事録を保存',
      `議事録-${exportBaseName(rec).replace(/^(会議|通話)-/, '')}.md`,
      [{ name: 'Markdown', extensions: ['md'] }],
    );
    if (!filePath) return { canceled: true };
    await fs.writeFile(filePath, buildMinutesMd(rec), 'utf-8');
    return { canceled: false, path: filePath };
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

  // モデルファイルの削除（ディスク節約）
  ipcMain.handle('transcription:delete-model', async (_e, model: WhisperModel) => {
    try {
      await fs.unlink(getModelPath(model));
      const s = store.getSettings();
      s.transcription.modelDownloaded = { ...s.transcription.modelDownloaded, [model]: false };
      store.setSettings(s);
      logInfo('model', `deleted ${model}`);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // ============ 音声ファイルの取り込み ============
  // 音声ファイルを選択（開始ダイアログの「参照」用）
  ipcMain.handle('audio:pick', async (): Promise<
    { canceled: true } | { canceled: false; path: string; name: string; sizeBytes: number; mtime: string }
  > => {
    const dlg = await dialog.showOpenDialog({
      title: '取り込む音声ファイルを選択',
      filters: [
        { name: '音声ファイル', extensions: ['mp3', 'wav', 'm4a', 'webm', 'ogg', 'aac', 'flac'] },
        { name: 'すべてのファイル', extensions: ['*'] },
      ],
      properties: ['openFile'],
    });
    if (dlg.canceled || dlg.filePaths.length === 0) return { canceled: true };
    const p = dlg.filePaths[0];
    const stat = await fs.stat(p);
    return { canceled: false, path: p, name: path.basename(p), sizeBytes: stat.size, mtime: stat.mtime.toISOString() };
  });

  // 音声ファイルを通話/会議の記録として取り込む（MP3 へ変換して保存し、必要なら文字起こし）
  ipcMain.handle('audio:import', async (_e, opts: {
    filePath: string;
    kind: RecordKind;
    title?: string;
    contactName?: string;
    startTime?: string;      // ISO。省略時はファイルの更新日時
    autoTranscribe: boolean;
  }): Promise<{ ok: true; record: CallRecord } | { ok: false; error: string }> => {
    try {
      const stat = await fs.stat(opts.filePath);
      const s = store.getSettings();
      const id = nanoid();
      const { recordings } = getDirs();
      const rel = `${id}.mp3`;
      const abs = path.join(recordings, rel);

      let durationSec: number;
      if (/\.mp3$/i.test(opts.filePath)) {
        // MP3 はそのままコピーして長さだけ取得（再エンコードによる劣化を避ける）
        durationSec = Math.round(await probeDurationSec(opts.filePath));
        await fs.copyFile(opts.filePath, abs);
      } else {
        const r = await convertWebmToMp3(opts.filePath, abs, s.recording.mp3Bitrate);
        durationSec = Math.round(r.durationSec);
      }
      const outStat = await fs.stat(abs);

      const startTime = opts.startTime ?? stat.mtime.toISOString();
      const endTime = new Date(new Date(startTime).getTime() + durationSec * 1000).toISOString();
      const rec: CallRecord = {
        id,
        kind: opts.kind,
        startTime,
        endTime,
        durationSec,
        tag: null,
        memo: `（音声ファイル取り込み: ${path.basename(opts.filePath)}）`,
        title: opts.kind === 'meeting' ? (opts.title || path.basename(opts.filePath).replace(/\.[^.]+$/, '')) : undefined,
        contactName: opts.kind === 'call' ? (opts.contactName || undefined) : undefined,
        holds: [],
        holdSec: 0,
        audio: { path: rel, format: 'mp3', bytes: outStat.size, durationSec, source: 'mic+system' },
      };
      store.addCall(rec);
      broadcast('app-event', { type: 'call:updated', record: rec });
      logInfo('import', `audio imported ${opts.filePath} -> ${rel} (${durationSec}s)`);
      if (opts.autoTranscribe) {
        const setup = await checkTranscriptionSetup(s.transcription.model);
        if (setup.ok) queueTranscription(id);
        else broadcast('app-event', { type: 'recording:error', message: `文字起こしを開始できません: ${setup.error}` });
      }
      return { ok: true, record: rec };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // ============ whisper.cpp 実行ファイルのダウンロード ============
  ipcMain.handle('whisper:binary-status', async () => {
    return { installed: await isBinaryInstalled() };
  });

  ipcMain.handle('whisper:download-binary', async () => {
    try {
      await downloadWhisperBinary((p) => {
        broadcast('app-event', {
          type: 'whisperbin:download',
          step: p.step,
          receivedBytes: p.receivedBytes,
          totalBytes: p.totalBytes,
        });
      });
      broadcast('app-event', {
        type: 'whisperbin:download', step: 'done', receivedBytes: 0, totalBytes: null,
      });
      return { ok: true };
    } catch (err) {
      const message = (err as Error).message;
      broadcast('app-event', {
        type: 'whisperbin:download', step: 'error', receivedBytes: 0, totalBytes: null, error: message,
      });
      return { ok: false, error: message };
    }
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

  // 汎用のフォルダ選択（保存先の固定フォルダなど）
  ipcMain.handle('app:choose-dir', async (_e, title: string): Promise<{ canceled: true } | { canceled: false; dir: string }> => {
    const r = await dialog.showOpenDialog({ title, properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || r.filePaths.length === 0) return { canceled: true };
    return { canceled: false, dir: r.filePaths[0] };
  });

  // 自動バックアップの複製先フォルダを選択（OneDrive 等を指定すれば実質クラウドバックアップになる）
  ipcMain.handle('backup:choose-dir', async (): Promise<{ canceled: true } | { canceled: false; dir: string }> => {
    const r = await dialog.showOpenDialog({
      title: '自動バックアップの複製先フォルダを選択',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || r.filePaths.length === 0) return { canceled: true };
    return { canceled: false, dir: r.filePaths[0] };
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
  if (updated) {
    broadcast('app-event', {
      type: 'transcription:status', callId, status: 'queued',
      queuePosition: transcriptionQueueLength() + 1,
    });
  }
  enqueueTranscription(callId, {
    audioPath: abs,
    model: s.transcription.model,
    language: s.transcription.language,
    prompt: s.transcription.prompt,
  });
  updatePowerBlocker();
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
    onProgress: (callId, stage, percent) => {
      // 全体進捗: 変換フェーズを 0-2%、whisper 実行を 2-100% に割り当てる
      const overall = stage === 'convert' ? 2 : Math.min(100, 2 + Math.round(percent * 0.98));
      broadcast('app-event', { type: 'transcription:progress', callId, stage, percent: overall });
    },
    onCancelled: (callId) => {
      const rec = store.getCall(callId);
      // 過去の文字起こしが残っていれば done、なければ none に戻す
      const status = rec?.transcript ? 'done' : 'none';
      const updated = store.updateCall(callId, { transcriptStatus: status, transcriptError: undefined });
      if (updated) broadcast('app-event', { type: 'transcription:status', callId, status });
      updatePowerBlocker();
    },
    onDone: (callId, transcript) => {
      const updated = store.updateCall(callId, { transcript, transcriptStatus: 'done', transcriptError: undefined });
      if (updated) {
        broadcast('app-event', { type: 'transcription:status', callId, status: 'done', transcript });
        broadcast('app-event', { type: 'call:updated', record: updated });
      }
      updatePowerBlocker();
    },
    onError: (callId, err) => {
      const message = err instanceof WhisperMissingError
        ? `whisper.cpp の実行ファイルが見つかりません。設定画面の「whisper.cpp をダウンロード」で自動セットアップできます。`
        : err.message;
      const updated = store.updateCall(callId, { transcriptStatus: 'error', transcriptError: message });
      if (updated) broadcast('app-event', { type: 'transcription:status', callId, status: 'error', error: message });
      updatePowerBlocker();
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

/**
 * 録音中にウィンドウを閉じようとしたときの保護。
 * 確認のうえ記録を終了し、録音の保存（finalize）を待ってから終了する。
 */
function setupSafeShutdown(): void {
  setBeforeCloseHandler(() => {
    if (shuttingDown) return 'close';
    if (!lastRecordingState.recording && finalizingCount === 0) return 'close';

    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      title: 'CallStack',
      message: '録音中です。記録を終了して録音を保存してから終了しますか？',
      detail: 'このまま終了すると録音が失われる可能性があります。',
      buttons: ['保存して終了', 'キャンセル'],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice === 1) return 'prevent';

    shuttingDown = true;
    logInfo('app', 'safe shutdown: ending call and waiting for finalize');
    void (async () => {
      try {
        await endCall();
        // 録音停止 → finalize 完了を待つ（最大 20 秒）
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
          if (!lastRecordingState.recording && finalizingCount === 0) break;
          await new Promise((r) => setTimeout(r, 200));
        }
        // finalize の IPC が届く前に閉じないよう少しだけ余裕を持たせる
        await new Promise((r) => setTimeout(r, 500));
        await store.flush().catch(() => {});
      } finally {
        logInfo('app', 'safe shutdown: done, quitting');
        markForceQuit();
        app.quit();
      }
    })();
    return 'prevent';
  });
}

/**
 * 前回クラッシュ・強制終了などで残った録音断片 (.webm) を起動時に回収する。
 * 対応する記録があり録音が未保存なら MP3 化して添付、そうでなければ削除する。
 */
async function recoverOrphanRecordings(): Promise<void> {
  const { tmpRecordings, recordings } = getDirs();
  let files: string[] = [];
  try {
    files = await fs.readdir(tmpRecordings);
  } catch {
    return;
  }
  let recovered = 0;
  for (const name of files) {
    if (!name.endsWith('.webm')) continue;
    const callId = name.replace(/\.webm$/, '');
    const tmpPath = path.join(tmpRecordings, name);
    const rec = store.getCall(callId);
    // 進行中の記録の断片には触れない（録音サービスが追記中）
    if (rec && !rec.endTime) continue;
    try {
      if (rec && !rec.audio && rec.endTime) {
        const rel = `${callId}.mp3`;
        const abs = path.join(recordings, rel);
        const { durationSec } = await convertWebmToMp3(tmpPath, abs, store.getSettings().recording.mp3Bitrate);
        const stat = await fs.stat(abs);
        const updated = store.updateCall(callId, {
          audio: { path: rel, format: 'mp3', bytes: stat.size, durationSec: Math.round(durationSec), source: 'mic' },
        });
        if (updated) {
          broadcast('app-event', { type: 'call:updated', record: updated });
          recovered += 1;
          logInfo('recover', `salvaged orphan recording ${name} (${Math.round(durationSec)}s)`);
        }
      }
      await fs.unlink(tmpPath).catch(() => {});
    } catch (err) {
      logInfo('recover', `failed to salvage ${name}: ${(err as Error).message}`);
      await fs.unlink(tmpPath).catch(() => {});
    }
  }
  if (recovered > 0) {
    notify('録音を復元しました', `前回保存されなかった録音 ${recovered} 件を復元しました。`, () => showMainWindow());
  }
}

/** Windows ログイン時の自動起動を設定する */
function applyLaunchAtLogin(enabled: boolean): void {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  app.setLoginItemSettings({ openAtLogin: enabled });
  logInfo('app', `launchAtLogin = ${enabled}`);
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
  applyLaunchAtLogin(store.getSettings().launchAtLogin);
  setupSafeShutdown();
  createMainWindow();
  createRecorderWindow();
  logInfo('app', `started v${app.getVersion()}`);
  scheduleDailyCleanup(store, broadcast);
  // 前回終了時に保存されなかった録音断片を回収（進行中の記録は除く）
  setTimeout(() => { void recoverOrphanRecordings(); }, 3000);

  // 前回のセッションで待機中・処理中のまま終了した文字起こしを自動再開する
  // （これが無いと記録が「待機中」のまま永久に止まって見える）
  setTimeout(() => {
    const stale = store.getCalls().filter((c) =>
      !c.deletedAt && c.audio && (c.transcriptStatus === 'queued' || c.transcriptStatus === 'running'));
    for (const c of stale) {
      logInfo('transcribe', `requeue stale job ${c.id} (was ${c.transcriptStatus})`);
      queueTranscription(c.id);
    }
  }, 4000);

  // 起動時の更新チェック（通知型。取得できない環境では静かにスキップ）
  if (store.getSettings().checkUpdatesOnStartup) {
    setTimeout(() => {
      void checkOnStartup().then((r) => {
        if (r?.hasUpdate) {
          notify(
            `新しいバージョン v${r.latest} があります`,
            `現在 v${r.current} — クリックでダウンロードページを開く`,
            () => { void shell.openExternal(r.url!); },
          );
        }
      });
    }, 5000);
  }

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
  destroyRecorderWindow();
  // 実行中の whisper プロセスを残さない
  shutdownTranscription();
  if (powerBlockerId !== null) powerSaveBlocker.stop(powerBlockerId);
});

app.on('before-quit', async () => {
  await store.flush().catch(() => {});
});

main().catch((err) => {
  console.error('[main] fatal:', err);
  app.exit(1);
});
