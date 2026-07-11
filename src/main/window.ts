import { BrowserWindow, screen, app, Menu, MenuItemConstructorOptions, dialog } from 'electron';
import path from 'node:path';
import type { HudSize } from '../shared/types';

/**
 * テキスト編集・選択テキスト用の標準右クリックメニューを取り付ける。
 * （Electron は既定でコンテキストメニューを持たないため、コピー/貼り付け等を提供する）
 */
function attachEditContextMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', (_e, params) => {
    const items: MenuItemConstructorOptions[] = [];
    if (params.isEditable) {
      items.push(
        { label: '元に戻す', role: 'undo', enabled: params.editFlags.canUndo },
        { label: 'やり直し', role: 'redo', enabled: params.editFlags.canRedo },
        { type: 'separator' },
        { label: '切り取り', role: 'cut', enabled: params.editFlags.canCut },
        { label: 'コピー', role: 'copy', enabled: params.editFlags.canCopy },
        { label: '貼り付け', role: 'paste', enabled: params.editFlags.canPaste },
        { type: 'separator' },
        { label: 'すべて選択', role: 'selectAll' },
      );
    } else if (params.selectionText.trim()) {
      items.push({ label: 'コピー', role: 'copy' });
    }
    if (items.length > 0) {
      Menu.buildFromTemplate(items).popup({ window: win });
    }
  });
}

/** レンダラが応答不能になったときの保険。再読み込みを提案する。 */
function attachUnresponsiveRecovery(win: BrowserWindow, name: string): void {
  win.webContents.on('unresponsive', () => {
    console.error(`[window] ${name} renderer unresponsive`);
    if (win.isDestroyed()) return;
    dialog
      .showMessageBox(win, {
        type: 'warning',
        title: 'CallStack',
        message: '画面の応答がありません。再読み込みしますか？（記録データは失われません）',
        buttons: ['再読み込み', 'このまま待つ'],
        defaultId: 0,
      })
      .then((r) => {
        if (r.response === 0 && !win.isDestroyed()) win.webContents.reload();
      })
      .catch(() => {});
  });
}

const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const DIST_DIR = path.join(__dirname, '..', '..', 'dist');
const PRELOAD = path.join(__dirname, '..', 'preload', 'index.js');

let mainWindow: BrowserWindow | null = null;
let hudWindow: BrowserWindow | null = null;
let minimizeToTrayEnabled = false;

export const HUD_SIZES: Record<HudSize, { width: number; height: number }> = {
  mini:    { width: 200, height: 32 },
  compact: { width: 330, height: 64 },
  full:    { width: 400, height: 118 },
};

const HUD_SIZE_ORDER: HudSize[] = ['mini', 'compact', 'full'];

export function nextHudSize(s: HudSize): HudSize {
  return HUD_SIZE_ORDER[(HUD_SIZE_ORDER.indexOf(s) + 1) % HUD_SIZE_ORDER.length];
}

export function setMinimizeToTray(enabled: boolean): void {
  minimizeToTrayEnabled = enabled;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

export function getHudWindow(): BrowserWindow | null {
  return hudWindow;
}

export function createMainWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow;
  }
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: 'CallStack',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.on('close', () => {
    markForceQuit();
    app.quit();
  });

  mainWindow.on('minimize', () => {
    if (minimizeToTrayEnabled && mainWindow) {
      // The window has been minimized; hide it to remove from taskbar.
      mainWindow.hide();
    }
  });

  // backgroundThrottling: false のウィンドウは、最小化からの復帰時にコンポジタが
  // フレーム生成を再開せず「フリーズ」して見えることがある（Chromium の既知問題。
  // 最小化中に録音の画面キャプチャセッションが終了した場合に発生しやすい）。
  // 復帰時にスロットリングを一瞬入れ直してから強制再描画し、コンポジタを起こす。
  const wakeRenderer = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const wc = mainWindow.webContents;
    wc.setBackgroundThrottling(true);
    wc.setBackgroundThrottling(false);
    wc.invalidate();
  };
  mainWindow.on('show', wakeRenderer);
  mainWindow.on('focus', wakeRenderer);
  mainWindow.on('restore', () => {
    wakeRenderer();
    // invalidate で回復しない環境向けの最終手段: 1px リサイズで
    // コンポジタに新しいフレームの生成を強制する。
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
      const [w, h] = mainWindow.getSize();
      mainWindow.setSize(w, h + 1);
      mainWindow.setSize(w, h);
    }, 60);
  });

  attachEditContextMenu(mainWindow);
  attachUnresponsiveRecovery(mainWindow, 'main');

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  if (DEV_URL) {
    mainWindow.loadURL(DEV_URL);
  } else {
    mainWindow.loadFile(path.join(DIST_DIR, 'index.html'));
  }

  return mainWindow;
}

function bringToFront(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.moveTop();
  win.focus();
}

export function toggleMainWindow(): void {
  const win = createMainWindow();
  if (win.isVisible() && win.isFocused()) {
    win.hide();
  } else {
    bringToFront(win);
  }
}

export function showMainWindow(): void {
  bringToFront(createMainWindow());
}

export function showMainWindowAt(page: 'list' | 'stats' | 'settings'): void {
  const win = createMainWindow();
  bringToFront(win);
  win.webContents.send('app-event', { type: 'navigate', page });
}

export function markForceQuit(): void {
  if (mainWindow) (mainWindow as unknown as { _forceQuit?: boolean })._forceQuit = true;
}

export function createHudWindow(
  position: { x: number; y: number } | null,
  size: HudSize = 'compact',
): BrowserWindow {
  if (hudWindow && !hudWindow.isDestroyed()) {
    hudWindow.show();
    return hudWindow;
  }
  const display = screen.getPrimaryDisplay();
  const { workArea } = display;
  const { width, height } = HUD_SIZES[size];
  const defaultX = workArea.x + workArea.width - width - 20;
  const defaultY = workArea.y + 20;

  hudWindow = new BrowserWindow({
    width,
    height,
    x: position?.x ?? defaultX,
    y: position?.y ?? defaultY,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    focusable: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  hudWindow.setAlwaysOnTop(true, 'screen-saver');

  attachEditContextMenu(hudWindow);

  hudWindow.once('ready-to-show', () => {
    hudWindow?.show();
  });

  if (DEV_URL) {
    hudWindow.loadURL(`${DEV_URL.replace(/\/$/, '')}/hud.html`);
  } else {
    hudWindow.loadFile(path.join(DIST_DIR, 'hud.html'));
  }

  return hudWindow;
}

/**
 * Apply a new size to the existing HUD without moving it off-screen.
 * Anchors on the right edge so right-aligned default layout stays put.
 */
export function setHudSize(size: HudSize): void {
  if (!hudWindow || hudWindow.isDestroyed()) return;
  const [oldX, oldY] = hudWindow.getPosition();
  const [oldW] = hudWindow.getSize();
  const { width, height } = HUD_SIZES[size];
  const newX = oldX + (oldW - width);
  hudWindow.setBounds({ x: newX, y: oldY, width, height });
}

/** Add extra height (e.g. for memo overlay) while keeping the window anchored. */
export function setHudExtraHeight(extraPx: number, baseSize: HudSize): void {
  if (!hudWindow || hudWindow.isDestroyed()) return;
  const [x, y] = hudWindow.getPosition();
  const { width, height } = HUD_SIZES[baseSize];
  hudWindow.setBounds({ x, y, width, height: height + Math.max(0, extraPx) });
}

export function closeHudWindow(): void {
  if (hudWindow && !hudWindow.isDestroyed()) {
    hudWindow.close();
  }
  hudWindow = null;
}

export function broadcast(channel: string, payload: unknown): void {
  for (const win of [mainWindow, hudWindow]) {
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}
