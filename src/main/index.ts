import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { promises as fs } from 'node:fs';
import { nanoid } from 'nanoid';
import { Store } from './store';
import { CallRecord, CsvExportOptions, Settings } from '../shared/types';
import { registerShortcuts, unregisterAll } from './shortcuts';
import {
  createMainWindow,
  toggleMainWindow,
  showMainWindow,
  createHudWindow,
  closeHudWindow,
  broadcast,
  getHudWindow,
  markForceQuit,
} from './window';
import { createTray, updateTray, destroyTray, TrayHandlers } from './tray';
import { exportCsv } from './csv';
import { notify } from './notifications';

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
    broadcast('app-event', { type: 'tick', activeId: active.id, elapsedSec });
    updateTray({ active: true, elapsedSec }, trayHandlers);

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

function endCall(): CallRecord | null {
  const active = getActive();
  if (!active) return null;
  const endTime = new Date().toISOString();
  const durationSec = Math.max(
    0,
    Math.round((new Date(endTime).getTime() - new Date(active.startTime).getTime()) / 1000),
  );
  const updated = store.updateCall(active.id, { endTime, durationSec });
  stopTickLoop();
  closeHudWindow();
  updateTray({ active: false }, trayHandlers);
  if (updated) {
    broadcast('app-event', { type: 'call:ended', record: updated });
    notify('通話を記録しました', `${formatHMS(durationSec)} — クリックで詳細編集`, () => showMainWindow());
  }
  return updated;
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
    defaultPath: `teltimestack-${new Date().toISOString().slice(0, 10)}.csv`,
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (result.canceled || !result.filePath) return null;
  const count = await exportCsv(result.filePath, store.getCalls(), { range: 'all' });
  return { count, path: result.filePath };
}

const trayHandlers: TrayHandlers = {
  onStart: () => startCall(),
  onEnd: () => endCall(),
  onOpen: () => showMainWindow(),
  onExport: async () => {
    const r = await chooseAndExport();
    if (r) notify('CSV エクスポート完了', `${r.count} 件を ${r.path} に書き出しました`);
  },
  onQuit: () => {
    markForceQuit();
    app.quit();
  },
};

function reRegisterShortcuts(): void {
  const s = store.getSettings();
  const failures = registerShortcuts(s.shortcuts, {
    start: () => startCall(),
    end: () => endCall(),
    toggle: () => toggleMainWindow(),
  });
  if (failures.length > 0) {
    notify('ショートカット登録失敗', `登録できませんでした: ${failures.join(', ')}`);
  }
}

function setupIpc(): void {
  ipcMain.handle('calls:list', () => store.getCalls());
  ipcMain.handle('calls:getActive', () => store.getActiveCall());

  ipcMain.handle('calls:startNow', () => startCall());
  ipcMain.handle('calls:endNow', () => endCall());

  ipcMain.handle('calls:update', (_e, id: string, patch: Partial<CallRecord>) => {
    const updated = store.updateCall(id, patch);
    if (updated) broadcast('app-event', { type: 'call:updated', record: updated });
    return updated;
  });

  ipcMain.handle('calls:delete', (_e, id: string) => {
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
    broadcast('app-event', { type: 'settings:updated', settings: next });
    return next;
  });

  ipcMain.handle('csv:export', async (_e, opts: CsvExportOptions) => {
    const result = await dialog.showSaveDialog({
      title: 'CSV をエクスポート',
      defaultPath: `teltimestack-${new Date().toISOString().slice(0, 10)}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true } as const;
    const count = await exportCsv(result.filePath, store.getCalls(), opts);
    return { canceled: false, count, path: result.filePath } as const;
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
  lines.push(`期間: ${monday.toISOString().slice(0, 10)} 〜 ${new Date(sunday.getTime() - 1).toISOString().slice(0, 10)}`);
  lines.push('');
  lines.push('## サマリー');
  lines.push(`- 通話数: ${target.length}`);
  lines.push(`- 合計時間: ${fmt(total)}`);
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

async function main() {
  await app.whenReady();
  await store.init();
  setupIpc();

  createTray(trayHandlers);
  updateTray({ active: false }, trayHandlers);

  reRegisterShortcuts();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    } else {
      showMainWindow();
    }
  });

  // restart tick loop if there's a stale active call from previous run
  if (getActive()) {
    createHudWindow(store.getSettings().hudPosition);
    updateTray({ active: true, elapsedSec: 0 }, trayHandlers);
    startTickLoop();
  }
}

app.on('window-all-closed', () => {
  // Keep running in tray on Windows / Linux
  if (process.platform === 'darwin') {
    // mac: do nothing, keep app alive
  }
});

app.on('will-quit', () => {
  unregisterAll();
  stopTickLoop();
  destroyTray();
});

app.on('before-quit', async () => {
  await store.flush().catch(() => {});
});

main().catch((err) => {
  console.error('[main] fatal:', err);
  app.exit(1);
});
