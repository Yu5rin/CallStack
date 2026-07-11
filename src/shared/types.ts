/** 記録の種別。省略時は 'call'（旧バージョンのデータ互換） */
export type RecordKind = 'call' | 'meeting';

export interface HoldSegment {
  start: string;          // ISO 8601
  end: string | null;
  sec: number;
}

export type AudioSourceLabel = 'mic' | 'system' | 'mic+system';

export interface CallAudio {
  path: string;           // relative to recordings dir, e.g. 'abc.mp3'
  format: 'mp3';
  bytes: number;
  durationSec: number;
  source: AudioSourceLabel;
}

/** 録音中に打つマーカー（ブックマーク）。at は記録開始からの秒数 */
export interface Marker {
  at: number;
  label?: string;
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
  kind?: RecordKind;          // 省略時は 'call'
  startTime: string;          // ISO 8601
  endTime: string | null;
  durationSec: number | null;
  tag: string | null;
  memo: string;
  contactName?: string;
  phoneNumber?: string;
  /** 会議用: タイトル */
  title?: string;
  /** 会議用: 参加者 */
  participants?: string[];
  /** 録音中に打ったマーカー */
  markers?: Marker[];
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
  startMeeting: string;
  endCall: string;
  toggleWindow: string;
  toggleHold: string;
  togglePauseRecording: string;
  openSettings: string;
  assignTag1: string;
  assignTag2: string;
  assignTag3: string;
  assignTag4: string;
}

export type WhisperModel = 'tiny' | 'base' | 'small' | 'medium' | 'large-v3-turbo';

export type ThemePref = 'system' | 'light' | 'dark' | 'black';

export type HudSize = 'mini' | 'compact' | 'full';
/** HUD の不透明度 0.3〜1.0（設定のスライダーで変更） */
export type HudOpacity = number;

/** 録音ソースの構成。mic / system は独立に ON/OFF できる */
export interface RecordingSourceConfig {
  mic: boolean;
  system: boolean;
  /** システム音声の範囲。'window' はキャプチャ対象ウィンドウを選択（環境により全体音声になる場合あり） */
  systemScope: 'screen' | 'window';
}

export interface RecordingSettings {
  enabled: boolean;
  /** 通話の既定ソース */
  callSource: RecordingSourceConfig;
  /** 会議の既定ソース */
  meetingSource: RecordingSourceConfig;
  /** 画面のボタンから開始したとき、録音ソースの確認ダイアログを出す（ショートカット開始時は既定で即開始） */
  askSourceOnStart: boolean;
  micDeviceId: string | null;
  mp3Bitrate: 64 | 96 | 128 | 192;
  autoTranscribe: boolean;
  retentionDays: number | null;
}

export interface TranscriptionSettings {
  model: WhisperModel;
  language: 'auto' | 'ja' | 'en';
  modelDownloaded: Partial<Record<WhisperModel, boolean>>;
  /** 用語ヒント: 社名・専門用語・参加者名などを whisper の初期プロンプトとして渡し、固有名詞の認識を改善する */
  prompt: string;
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
  hudSize: HudSize;
  hudOpacity: HudOpacity;
  transcriptSeekOffsetSec: number;
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
export type TranscriptionProgressEvent = {
  type: 'transcription:progress';
  callId: string;
  percent: number;            // 0-100
};
/** 録音中ウィンドウへの一時停止/再開の指示（HUD・ショートカットから発火） */
export type RecordingTogglePauseEvent = { type: 'recording:togglePause' };
/** 録音状態の通知（録音サービスウィンドウが報告し、全ウィンドウへ配信される） */
export type RecordingStateEvent = { type: 'recording:state'; recording: boolean; paused: boolean };
/** 録音エラーの通知（録音サービスウィンドウ → メイン窓の表示用） */
export type RecordingErrorEvent = { type: 'recording:error'; message: string };
/** 録音レベルの共有（録音サービスウィンドウ → 各ウィンドウ、約5Hzに間引き） */
export type RecordingLevelEvent = { type: 'recording:level'; level: number };
/** whisper.cpp 実行ファイルのダウンロード進捗 */
export type WhisperBinDownloadEvent = {
  type: 'whisperbin:download';
  step: 'download' | 'extract' | 'done' | 'error';
  receivedBytes: number;
  totalBytes: number | null;
  error?: string;
};
/** マーカー追加の通知 */
export type MarkerAddedEvent = { type: 'marker:added'; callId: string; marker: Marker; count: number };
export type ModelDownloadEvent = {
  type: 'model:download';
  model: WhisperModel;
  receivedBytes: number;
  totalBytes: number | null;
  done: boolean;
  error?: string;
};
export type NavigateEvent = { type: 'navigate'; page: 'list' | 'stats' | 'settings' };
/** 指定した記録の編集ダイアログを開く（HUD の編集ボタンなどから） */
export type EditRecordEvent = { type: 'edit:record'; callId: string };
export type DataRestoredEvent = { type: 'data:restored' };

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
  | TranscriptionProgressEvent
  | RecordingTogglePauseEvent
  | RecordingStateEvent
  | RecordingErrorEvent
  | RecordingLevelEvent
  | MarkerAddedEvent
  | ModelDownloadEvent
  | WhisperBinDownloadEvent
  | NavigateEvent
  | EditRecordEvent
  | DataRestoredEvent;

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
    startMeeting: 'Control+Shift+M',
    endCall: 'Control+Shift+E',
    toggleWindow: 'Control+Shift+T',
    toggleHold: 'Control+Shift+H',
    togglePauseRecording: 'Control+Shift+P',
    openSettings: 'Control+Shift+,',
    assignTag1: 'Control+Shift+1',
    assignTag2: 'Control+Shift+2',
    assignTag3: 'Control+Shift+3',
    assignTag4: 'Control+Shift+4',
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
    callSource: { mic: true, system: false, systemScope: 'screen' },
    meetingSource: { mic: true, system: true, systemScope: 'screen' },
    askSourceOnStart: true,
    micDeviceId: null,
    mp3Bitrate: 96,
    autoTranscribe: true,
    retentionDays: 90,
  },
  transcription: {
    model: 'small',
    language: 'ja',
    modelDownloaded: {},
    prompt: '',
  },
  confirmRecordingEnable: true,
  minimizeToTray: false,
  confirmCallDelete: true,
  theme: 'system',
  hudSize: 'compact',
  hudOpacity: 1.0,
  transcriptSeekOffsetSec: 1.0,
};

/** ソース構成から保存用ラベルを導出。両方 OFF なら null（録音しない） */
export function audioSourceLabel(cfg: RecordingSourceConfig): AudioSourceLabel | null {
  if (cfg.mic && cfg.system) return 'mic+system';
  if (cfg.mic) return 'mic';
  if (cfg.system) return 'system';
  return null;
}

export const WHISPER_MODELS: Array<{ id: WhisperModel; sizeMb: number; label: string }> = [
  { id: 'tiny',   sizeMb: 75,   label: 'tiny (約 75MB, 速度優先)' },
  { id: 'base',   sizeMb: 142,  label: 'base (約 142MB)' },
  { id: 'small',  sizeMb: 466,  label: 'small (約 466MB, バランス・推奨)' },
  { id: 'medium', sizeMb: 1500, label: 'medium (約 1.5GB, 高精度)' },
  { id: 'large-v3-turbo', sizeMb: 1620, label: 'large-v3-turbo (約 1.6GB, 最高精度・medium より高速。会議向け)' },
];
