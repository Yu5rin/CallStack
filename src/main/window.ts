import { BrowserWindow, screen, app } from 'electron';
import path from 'node:path';
import type { HudSize } from '../shared/types';

const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const DIST_DIR = path.join(__dirname, '..', '..', 'dist');
const PRELOAD = path.join(__dirname, '..', 'preload', 'index.js');

let mainWindow: BrowserWindow | null = null;
let hudWindow: BrowserWindow | null = null;
let minimizeToTrayEnabled = false;

export const HUD_SIZES: Record<HudSize, { width: number; height: number }> = {
  mini:    { width: 180, height: 32 },
  compact: { width: 260, height: 56 },
  full:    { width: 340, height: 96 },
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
    title: 'TelTimeStack',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
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
    },
  });

  hudWindow.setAlwaysOnTop(true, 'screen-saver');

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
