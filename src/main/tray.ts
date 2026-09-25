import { Tray, Menu, nativeImage, app } from 'electron';
import path from 'node:path';
import type { ThemePref } from '../shared/types';

let tray: Tray | null = null;

function buildIcon(active: boolean, recording = false): Electron.NativeImage {
  // 状態別トレイアイコン: 待機=グレー波形 / 通話・会議中=緑波形 / 録音中=緑波形+赤ドット
  const name = active ? (recording ? 'tray-rec.png' : 'tray-active.png') : 'tray-idle.png';
  const iconPath = path.join(__dirname, '..', '..', 'resources', name);
  const img = nativeImage.createFromPath(iconPath);
  if (!img.isEmpty()) return img;
  // Fallback 16x16 PNG generated inline (solid color square)
  const buf = makeSolidPng(16, 16, active ? 0xff367aff : 0xff64748b);
  return nativeImage.createFromBuffer(buf);
}

export interface TrayHandlers {
  onStart: () => void;
  onStartMeeting: () => void;
  onEnd: () => void;
  onOpen: () => void;
  onExport: () => void;
  onQuit: () => void;
  onSetTheme: (theme: ThemePref) => void;
  getTheme: () => ThemePref;
}

export interface TrayState {
  active: boolean;
  elapsedSec?: number;
  holding?: boolean;
  recording?: boolean;
  today?: {
    calls: { count: number; totalSec: number };
    meetings: { count: number; totalSec: number };
  };
}

export function createTray(handlers: TrayHandlers): Tray {
  if (tray) return tray;
  tray = new Tray(buildIcon(false));
  tray.setToolTip('CallStack — 待機中');
  tray.setContextMenu(buildMenu({ active: false }, handlers));
  tray.on('click', () => handlers.onOpen());
  return tray;
}

export function updateTray(state: TrayState, handlers: TrayHandlers): void {
  if (!tray) return;
  tray.setImage(buildIcon(state.active, state.recording));
  const parts: string[] = ['CallStack'];
  if (state.active) {
    parts.push(`${state.holding ? '保留中' : '通話中'} ${formatHMS(state.elapsedSec ?? 0)}`);
    if (state.recording) parts.push('録音中');
  } else {
    parts.push('待機中');
  }
  if (state.today) {
    const t: string[] = [];
    if (state.today.calls.count > 0) t.push(`通話${state.today.calls.count}件 ${formatHMSShort(state.today.calls.totalSec)}`);
    if (state.today.meetings.count > 0) t.push(`会議${state.today.meetings.count}件 ${formatHMSShort(state.today.meetings.totalSec)}`);
    if (t.length > 0) parts.push(`今日 ${t.join(' / ')}`);
  }
  tray.setToolTip(parts.join(' — '));
  tray.setContextMenu(buildMenu(state, handlers));
}

function formatHMSShort(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}

export function destroyTray(): void {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

function buildMenu(state: TrayState, h: TrayHandlers): Electron.Menu {
  const theme = h.getTheme();
  const themeItem = (label: string, value: ThemePref): Electron.MenuItemConstructorOptions => ({
    label,
    type: 'radio',
    checked: theme === value,
    click: () => h.onSetTheme(value),
  });
  return Menu.buildFromTemplate([
    ...(state.active
      ? [{ label: '記録を終了', click: h.onEnd }]
      : [
          { label: '通話を開始', click: h.onStart },
          { label: '会議を開始', click: h.onStartMeeting },
        ]),
    { type: 'separator' },
    { label: 'メインウィンドウを開く', click: h.onOpen },
    { label: 'CSV を書き出す…', click: h.onExport },
    { type: 'separator' },
    {
      label: '外観テーマ',
      submenu: [
        themeItem('システムに合わせる', 'system'),
        themeItem('ライト', 'light'),
        themeItem('ダーク', 'dark'),
      ],
    },
    { type: 'separator' },
    { label: `バージョン ${app.getVersion()}`, enabled: false },
    { label: '終了', click: h.onQuit },
  ]);
}

function formatHMS(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rs = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(rs).padStart(2, '0')}`;
}

// Minimal solid-color PNG generator (16x16 RGBA) — used as fallback icon.
function makeSolidPng(width: number, height: number, argb: number): Buffer {
  const a = (argb >>> 24) & 0xff;
  const r = (argb >>> 16) & 0xff;
  const g = (argb >>> 8) & 0xff;
  const b = argb & 0xff;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);    // bit depth
  ihdr.writeUInt8(6, 9);    // color type: RGBA
  ihdr.writeUInt8(0, 10);
  ihdr.writeUInt8(0, 11);
  ihdr.writeUInt8(0, 12);
  const ihdrChunk = makeChunk('IHDR', ihdr);

  const rowLen = width * 4;
  const raw = Buffer.alloc((rowLen + 1) * height);
  for (let y = 0; y < height; y++) {
    const off = y * (rowLen + 1);
    raw.writeUInt8(0, off); // filter: None
    for (let x = 0; x < width; x++) {
      const p = off + 1 + x * 4;
      raw.writeUInt8(r, p);
      raw.writeUInt8(g, p + 1);
      raw.writeUInt8(b, p + 2);
      raw.writeUInt8(a, p + 3);
    }
  }
  const compressed = zlibDeflate(raw);
  const idatChunk = makeChunk('IDAT', compressed);
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([sig, ihdrChunk, idatChunk, iendChunk]);
}

function makeChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

let crcTable: number[] | null = null;
function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

import { deflateSync } from 'node:zlib';
function zlibDeflate(buf: Buffer): Buffer {
  return deflateSync(buf);
}
