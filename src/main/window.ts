import { BrowserWindow, screen, app, Menu, MenuItemConstructorOptions, dialog, BrowserWindowConstructorOptions } from 'electron';
import path from 'node:path';
import type { HudSize } from '../shared/types';
import { TITLEBAR_COLORS, TITLEBAR_HEIGHT, PAPER_COLORS, EffectiveTheme } from '../shared/titlebarTheme';
import { logInfo } from './log';

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
let recorderWindow: BrowserWindow | null = null;
let liveWindow: BrowserWindow | null = null;
let liveBoundsHandler: ((b: { x: number; y: number; width: number; height: number }) => void) | null = null;
let minimizeToTrayEnabled = false;

/** ウィンドウを閉じる前の確認フック。'prevent' を返すと閉じない */
let beforeCloseHandler: (() => 'close' | 'prevent') | null = null;

export function setBeforeCloseHandler(h: (() => 'close' | 'prevent') | null): void {
  beforeCloseHandler = h;
}

/**
 * メイン窓を新規作成する際、Windows のタイトルバーオーバーレイに使う実効テーマ
 * （'system' 解決済み）を取得するための関数。index.ts から起動時に登録される。
 * 登録前・未登録時は 'light' にフォールバックする。
 */
let themeProvider: (() => EffectiveTheme) | null = null;

export function setThemeProvider(fn: () => EffectiveTheme): void {
  themeProvider = fn;
}

// 第5段階のデザイン見直しで最小文字サイズ(12px)・アイコンボタンの当たり判定(28px角)を
// 満たすよう、旧サイズ（mini 240×34 / compact 400×70 / full 470×122）から拡大した。
export const HUD_SIZES: Record<HudSize, { width: number; height: number }> = {
  mini:    { width: 320, height: 40 },
  compact: { width: 400, height: 80 },
  full:    { width: 560, height: 132 },
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
  const winOpts: BrowserWindowConstructorOptions = {
    width: 1100,
    height: 720,
    minWidth: 760,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    title: 'CallStack',
    icon: path.join(__dirname, '..', '..', 'resources', 'app-icon-512.png'),
    // 読み込み完了前の白フラッシュを防ぐため、現在の実効テーマの paper 色で初期化する
    backgroundColor: PAPER_COLORS[themeProvider ? themeProvider() : 'light'],
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  };
  // Windows のみ: ネイティブタイトルバーを、アプリのテーマ色に連動する
  // カスタムオーバーレイ（最小化/最大化/閉じるボタンは Windows 側が描画）に
  // 置き換える。macOS/Linux は titleBarOverlay 非対応のため、これまでどおり
  // 何も指定しない標準のタイトルバーのままにする（既存動作を変えない）。
  if (process.platform === 'win32') {
    const effective = themeProvider ? themeProvider() : 'light';
    winOpts.titleBarStyle = 'hidden';
    winOpts.titleBarOverlay = {
      ...TITLEBAR_COLORS[effective],
      height: TITLEBAR_HEIGHT,
    };
  }
  mainWindow = new BrowserWindow(winOpts);

  mainWindow.on('close', (e) => {
    // 録音中の終了確認などのため、index.ts 側のフックに判断を委ねる
    if (beforeCloseHandler && beforeCloseHandler() === 'prevent') {
      e.preventDefault();
      return;
    }
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
  // 復帰（最小化解除・トレイからの再表示）後の自己修復。トレイに格納すると
  // hide()→show() で戻るため 'restore' が発火しない。'show' でも同じ回復処理を行う。
  const healAfterAppear = () => {
    wakeRenderer();
    // invalidate で回復しない環境向けの最終手段: 1px リサイズで
    // コンポジタに新しいフレームの生成を強制する。
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized() || !mainWindow.isVisible()) return;
      const [w, h] = mainWindow.getSize();
      mainWindow.setSize(w, h + 1);
      mainWindow.setSize(w, h);
    }, 60);
    // 自己修復: 復帰後にレンダラが応答するか確認し、死んでいれば再読み込みする。
    // 記録データは main プロセス側にあるため失われない。
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized() || !mainWindow.isVisible()) return;
      const wc = mainWindow.webContents;
      let alive = false;
      wc.executeJavaScript('1').then(() => { alive = true; }).catch(() => {});
      setTimeout(() => {
        if (alive || !mainWindow || mainWindow.isDestroyed()) return;
        logInfo('window', 'main renderer did not answer after appear — reloading');
        wc.reload();
      }, 4000);
    }, 500);
  };
  mainWindow.on('show', () => { logInfo('window', 'main shown'); healAfterAppear(); });
  mainWindow.on('focus', wakeRenderer);
  mainWindow.on('minimize', () => logInfo('window', 'main minimized'));
  mainWindow.on('restore', () => { logInfo('window', 'main restored'); healAfterAppear(); });

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

/**
 * テーマ切り替え時に、開いているメイン窓の Windows タイトルバー色を
 * 即座に更新する。Windows 以外では何もしない（titleBarOverlay 非対応）。
 */
export function updateTitleBarOverlay(effective: EffectiveTheme): void {
  if (process.platform !== 'win32') return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setTitleBarOverlay(TITLEBAR_COLORS[effective]);
}

function bringToFront(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  // Windows では他アプリにフォーカスがあると focus() だけでは前面に来ない
  // ことがあるため、一瞬 always-on-top にして確実に最前面へ出す。
  win.setAlwaysOnTop(true);
  win.moveTop();
  win.focus();
  win.setAlwaysOnTop(false);
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

/**
 * 保存された HUD 位置を現在のディスプレイ構成の作業領域内へ収める。
 * モニタ構成が変わって画面外座標になっていても HUD が見えなくならないように。
 */
function clampHudPosition(pos: { x: number; y: number }, width: number, height: number): { x: number; y: number } {
  const display = screen.getDisplayNearestPoint(pos);
  const wa = display.workArea;
  return {
    x: Math.min(Math.max(pos.x, wa.x), wa.x + wa.width - width),
    y: Math.min(Math.max(pos.y, wa.y), wa.y + wa.height - height),
  };
}

/** HUD 上のカーソル監視。drag 領域では DOM の mouseenter が発火しないため main 側で判定する */
let hudHoverTimer: NodeJS.Timeout | null = null;
let hudHovered = false;

function startHudHoverWatch(): void {
  stopHudHoverWatch();
  hudHovered = false;
  hudHoverTimer = setInterval(() => {
    if (!hudWindow || hudWindow.isDestroyed()) return;
    const cur = screen.getCursorScreenPoint();
    const b = hudWindow.getBounds();
    const inside = cur.x >= b.x && cur.x < b.x + b.width && cur.y >= b.y && cur.y < b.y + b.height;
    if (inside !== hudHovered) {
      hudHovered = inside;
      hudWindow.webContents.send('app-event', { type: 'hud:hover', hovered: inside });
    }
  }, 200);
}

function stopHudHoverWatch(): void {
  if (hudHoverTimer) {
    clearInterval(hudHoverTimer);
    hudHoverTimer = null;
  }
}

export function createHudWindow(
  position: { x: number; y: number } | null,
  size: HudSize = 'compact',
): BrowserWindow {
  if (hudWindow && !hudWindow.isDestroyed()) {
    hudWindow.show();
    return hudWindow;
  }
  hudExtraPx = 0;   // 新規作成時は追加高さをリセット
  const display = screen.getPrimaryDisplay();
  const { workArea } = display;
  const { width, height } = HUD_SIZES[size];
  const defaultX = workArea.x + workArea.width - width - 20;
  const defaultY = workArea.y + 20;
  const pos = position
    ? clampHudPosition(position, width, height)
    : { x: defaultX, y: defaultY };

  hudWindow = new BrowserWindow({
    width,
    height,
    x: pos.x,
    y: pos.y,
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
  startHudHoverWatch();
  hudWindow.on('closed', () => stopHudHoverWatch());

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
/** メモ・ライブ字幕などで追加された HUD の高さ（px）。サイズ切替でも保持する */
let hudExtraPx = 0;

export function setHudSize(size: HudSize): void {
  if (!hudWindow || hudWindow.isDestroyed()) return;
  const [oldX, oldY] = hudWindow.getPosition();
  const [oldW] = hudWindow.getSize();
  const { width, height } = HUD_SIZES[size];
  const newX = oldX + (oldW - width);
  // サイズ切替時も追加高さ（ライブ字幕・メモ）を維持する
  hudWindow.setBounds({ x: newX, y: oldY, width, height: height + Math.max(0, hudExtraPx) });
}

/** Add extra height (e.g. for memo overlay / live caption) while keeping the window anchored. */
export function setHudExtraHeight(extraPx: number, baseSize: HudSize): void {
  if (!hudWindow || hudWindow.isDestroyed()) return;
  hudExtraPx = Math.max(0, extraPx);
  const [x, y] = hudWindow.getPosition();
  const { width, height } = HUD_SIZES[baseSize];
  hudWindow.setBounds({ x, y, width, height: height + hudExtraPx });
}

export function closeHudWindow(): void {
  if (hudWindow && !hudWindow.isDestroyed()) {
    hudWindow.close();
  }
  hudWindow = null;
}

/**
 * 録音サービス用の不可視ウィンドウ。
 * メディアキャプチャ（getUserMedia / getDisplayMedia / MediaRecorder）を
 * メイン窓から分離することで、メイン窓の最小化・復帰がキャプチャ
 * パイプラインに影響しない（最小化復帰フリーズの根本対策）。
 */
export function createRecorderWindow(): BrowserWindow {
  if (recorderWindow && !recorderWindow.isDestroyed()) {
    return recorderWindow;
  }
  recorderWindow = new BrowserWindow({
    width: 320,
    height: 180,
    show: false,
    frame: false,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  recorderWindow.webContents.on('render-process-gone', (_e, details) => {
    logInfo('window', `recorder renderer gone: ${details.reason} — recreating`);
    recorderWindow?.destroy();
    recorderWindow = null;
    setTimeout(() => createRecorderWindow(), 500);
  });

  if (DEV_URL) {
    recorderWindow.loadURL(`${DEV_URL.replace(/\/$/, '')}/recorder.html`);
  } else {
    recorderWindow.loadFile(path.join(DIST_DIR, 'recorder.html'));
  }
  logInfo('window', 'recorder window created');
  return recorderWindow;
}

export function getRecorderWindow(): BrowserWindow | null {
  return recorderWindow;
}

export function destroyRecorderWindow(): void {
  if (recorderWindow && !recorderWindow.isDestroyed()) {
    recorderWindow.destroy();
  }
  recorderWindow = null;
}

export function broadcast(channel: string, payload: unknown): void {
  for (const win of [mainWindow, hudWindow, recorderWindow, liveWindow]) {
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

// ============ ライブ字幕ウィンドウ（独立・移動/リサイズ可能） ============
export interface LiveBounds { x: number; y: number; width: number; height: number }

/** 移動・リサイズされたときに保存するためのハンドラを登録する */
export function setLiveBoundsHandler(fn: (b: LiveBounds) => void): void {
  liveBoundsHandler = fn;
}

export function getLiveWindow(): BrowserWindow | null {
  return liveWindow;
}

export function showLiveWindow(bounds?: LiveBounds | null): BrowserWindow {
  if (liveWindow && !liveWindow.isDestroyed()) {
    liveWindow.show();
    return liveWindow;
  }
  const { workArea } = screen.getPrimaryDisplay();
  const width = bounds?.width ?? 380;
  const height = bounds?.height ?? 200;
  // 画面内に収める（保存座標がモニタ構成変更で画面外になっていても見えるように）
  const x = bounds
    ? Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - width)
    : workArea.x + workArea.width - width - 20;
  const y = bounds
    ? Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - height)
    : workArea.y + 120;

  liveWindow = new BrowserWindow({
    width, height, x, y,
    minWidth: 220,
    minHeight: 90,
    frame: false,
    transparent: false,
    resizable: true,      // 枠なしでも端からリサイズ可能（横・縦とも）
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    focusable: true,
    backgroundColor: PAPER_COLORS[themeProvider ? themeProvider() : 'light'],
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  liveWindow.setAlwaysOnTop(true, 'screen-saver');
  attachEditContextMenu(liveWindow);

  const persist = () => {
    if (!liveWindow || liveWindow.isDestroyed()) return;
    const [bx, by] = liveWindow.getPosition();
    const [bw, bh] = liveWindow.getSize();
    liveBoundsHandler?.({ x: bx, y: by, width: bw, height: bh });
  };
  liveWindow.on('moved', persist);
  liveWindow.on('resized', persist);
  liveWindow.on('closed', () => { liveWindow = null; });

  liveWindow.once('ready-to-show', () => liveWindow?.show());
  if (DEV_URL) {
    liveWindow.loadURL(`${DEV_URL.replace(/\/$/, '')}/live.html`);
  } else {
    liveWindow.loadFile(path.join(DIST_DIR, 'live.html'));
  }
  return liveWindow;
}

export function hideLiveWindow(): void {
  if (liveWindow && !liveWindow.isDestroyed()) {
    liveWindow.close();
  }
  liveWindow = null;
}
