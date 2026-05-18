export interface CallRecord {
  id: string;
  startTime: string;          // ISO 8601
  endTime: string | null;
  durationSec: number | null;
  tag: string | null;
  memo: string;
  contactName?: string;
  phoneNumber?: string;
}

export interface TagDef {
  name: string;
  color: string;
}

export interface ShortcutSettings {
  startCall: string;
  endCall: string;
  toggleWindow: string;
}

export interface Settings {
  shortcuts: ShortcutSettings;
  tags: TagDef[];
  longCallAlertMin: number | null;
  autoBackupDir: string | null;
  soundFeedback: boolean;
  hudPosition: { x: number; y: number } | null;
}

export type CallStartedEvent = { type: 'call:started'; record: CallRecord };
export type CallEndedEvent = { type: 'call:ended'; record: CallRecord };
export type CallUpdatedEvent = { type: 'call:updated'; record: CallRecord };
export type CallDeletedEvent = { type: 'call:deleted'; id: string };
export type SettingsUpdatedEvent = { type: 'settings:updated'; settings: Settings };
export type TickEvent = { type: 'tick'; activeId: string; elapsedSec: number };

export type AppEvent =
  | CallStartedEvent
  | CallEndedEvent
  | CallUpdatedEvent
  | CallDeletedEvent
  | SettingsUpdatedEvent
  | TickEvent;

export interface CsvExportOptions {
  range: 'all' | 'thisWeek' | 'thisMonth' | 'custom';
  from?: string;     // ISO date (inclusive)
  to?: string;       // ISO date (inclusive)
}

export const DEFAULT_SETTINGS: Settings = {
  shortcuts: {
    startCall: 'Control+Shift+S',
    endCall: 'Control+Shift+E',
    toggleWindow: 'Control+Shift+T',
  },
  tags: [
    { name: '営業',   color: '#367aff' },
    { name: 'サポート', color: '#10b981' },
    { name: '社内',   color: '#f59e0b' },
    { name: '個人',   color: '#a855f7' },
  ],
  longCallAlertMin: 30,
  autoBackupDir: null,
  soundFeedback: true,
  hudPosition: null,
};
