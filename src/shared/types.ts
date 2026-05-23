export interface HoldSegment {
  start: string;          // ISO 8601
  end: string | null;
  sec: number;
}

export interface CallAudio {
  path: string;           // relative to recordings dir, e.g. 'abc.mp3'
  format: 'mp3';
  bytes: number;
  durationSec: number;
  source: 'mic' | 'mic+system';
}

export interface TranscriptSegment {
  start: number;          // seconds
  end: number;
  text: string;
}

export interface CallTranscript {
  text: string;
  language: string;
  model: string;
  createdAt: string;
  segments?: TranscriptSegment[];
}

export type TranscriptStatus = 'none' | 'queued' | 'running' | 'done' | 'error';

export interface CallRecord {
  id: string;
  startTime: string;          // ISO 8601
  endTime: string | null;
  durationSec: number | null;
  tag: string | null;
  memo: string;
  contactName?: string;
  phoneNumber?: string;
  holds?: HoldSegment[];
  holdSec?: number;
  audio?: CallAudio;
  transcript?: CallTranscript;
  transcriptStatus?: TranscriptStatus;
  transcriptError?: string;
}

export interface TagDef {
  name: string;
  color: string;
}

export interface ShortcutSettings {
  startCall: string;
  endCall: string;
  toggleWindow: string;
  toggleHold: string;
  openSettings: string;
}

export type WhisperModel = 'tiny' | 'base' | 'small' | 'medium';

export type ThemePref = 'system' | 'light' | 'dark';

export interface RecordingSettings {
  enabled: boolean;
  source: 'mic' | 'mic+system';
  micDeviceId: string | null;
  mp3Bitrate: 64 | 96 | 128 | 192;
  autoTranscribe: boolean;
  retentionDays: number | null;
}

export interface TranscriptionSettings {
  model: WhisperModel;
  language: 'auto' | 'ja' | 'en';
  modelDownloaded: Partial<Record<WhisperModel, boolean>>;
}

export interface Settings {
  shortcuts: ShortcutSettings;
  tags: TagDef[];
  longCallAlertMin: number | null;
  autoBackupDir: string | null;
  soundFeedback: boolean;
  hudPosition: { x: number; y: number } | null;
  recording: RecordingSettings;
  transcription: TranscriptionSettings;
  confirmRecordingEnable: boolean;
  minimizeToTray: boolean;
  confirmCallDelete: boolean;
  theme: ThemePref;
}

export type CallStartedEvent = { type: 'call:started'; record: CallRecord };
export type CallEndedEvent = { type: 'call:ended'; record: CallRecord };
export type CallUpdatedEvent = { type: 'call:updated'; record: CallRecord };
export type CallDeletedEvent = { type: 'call:deleted'; id: string };
export type SettingsUpdatedEvent = { type: 'settings:updated'; settings: Settings };
export type TickEvent = { type: 'tick'; activeId: string; elapsedSec: number; holding: boolean; holdSec: number };
export type HoldChangedEvent = { type: 'hold:changed'; callId: string; holding: boolean; holdSec: number };
export type RecordingFinalizedEvent = {
  type: 'recording:finalized';
  callId: string;
  path: string;
  bytes: number;
  durationSec: number;
};
export type TranscriptionStatusEvent = {
  type: 'transcription:status';
  callId: string;
  status: TranscriptStatus;
  transcript?: CallTranscript;
  error?: string;
};
export type ModelDownloadEvent = {
  type: 'model:download';
  model: WhisperModel;
  receivedBytes: number;
  totalBytes: number | null;
  done: boolean;
  error?: string;
};
export type NavigateEvent = { type: 'navigate'; page: 'list' | 'stats' | 'settings' };

export type AppEvent =
  | CallStartedEvent
  | CallEndedEvent
  | CallUpdatedEvent
  | CallDeletedEvent
  | SettingsUpdatedEvent
  | TickEvent
  | HoldChangedEvent
  | RecordingFinalizedEvent
  | TranscriptionStatusEvent
  | ModelDownloadEvent
  | NavigateEvent;

export interface CsvExportOptions {
  range: 'all' | 'thisWeek' | 'thisMonth' | 'custom';
  from?: string;
  to?: string;
}

export interface CsvImportResult {
  inserted: number;
  updated: number;
  skipped: number;
  errors: Array<{ row: number; message: string }>;
}

export const DEFAULT_SETTINGS: Settings = {
  shortcuts: {
    startCall: 'Control+Shift+S',
    endCall: 'Control+Shift+E',
    toggleWindow: 'Control+Shift+T',
    toggleHold: 'Control+Shift+H',
    openSettings: 'Control+Shift+,',
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
  recording: {
    enabled: false,
    source: 'mic',
    micDeviceId: null,
    mp3Bitrate: 96,
    autoTranscribe: false,
    retentionDays: 90,
  },
  transcription: {
    model: 'small',
    language: 'ja',
    modelDownloaded: {},
  },
  confirmRecordingEnable: true,
  minimizeToTray: false,
  confirmCallDelete: true,
  theme: 'system',
};

export const WHISPER_MODELS: Array<{ id: WhisperModel; sizeMb: number; label: string }> = [
  { id: 'tiny',   sizeMb: 75,   label: 'tiny (約 75MB, 速度優先)' },
  { id: 'base',   sizeMb: 142,  label: 'base (約 142MB)' },
  { id: 'small',  sizeMb: 466,  label: 'small (約 466MB, バランス・推奨)' },
  { id: 'medium', sizeMb: 1500, label: 'medium (約 1.5GB, 高精度)' },
];
