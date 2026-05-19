import { BrowserWindow, screen } from 'electron';
import path from 'node:path';

const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const DIST_DIR = path.join(__dirname, '..', '..', 'dist');
const PRELOAD = path.join(__dirname, '..', 'preload', 'index.js');

let mainWindow: BrowserWindow | null = null;
let hudWindow: BrowserWindow | null = null;
let minimizeToTrayEnabled = false;

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

  mainWindow.on('close', (e) => {
    // Hide to tray instead of quitting (existing behavior)
    if (mainWindow && !(mainWindow as unknown as { _forceQuit?: boolean })._forceQuit) {
      e.preventDefault();
      mainWindow.hide();
    }
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

export function toggleMainWindow(): void {
  const win = createMainWindow();
  if (win.isVisible() && win.isFocused()) {
    win.hide();
  } else {
    win.show();
    win.focus();
  }
}

export function showMainWindow(): void {
  const win = createMainWindow();
  win.show();
  win.focus();
}

export function markForceQuit(): void {
  if (mainWindow) (mainWindow as unknown as { _forceQuit?: boolean })._forceQuit = true;
}

export function createHudWindow(position: { x: number; y: number } | null): BrowserWindow {
  if (hudWindow && !hudWindow.isDestroyed()) {
    hudWindow.show();
    return hudWindow;
  }
  const display = screen.getPrimaryDisplay();
  const { workArea } = display;
  const width = 340;
  const height = 96;
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
