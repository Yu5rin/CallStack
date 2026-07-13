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
  /** 旧: 単一タグ（互換のため残す。tags の先頭をミラー） */
  tag: string | null;
  /** 複数タグ */
  tags?: string[];
  memo: string;
  contactName?: string;
  phoneNumber?: string;
  /** 会議用: タイトル */
  title?: string;
  /** 会議用: 参加者 */
  participants?: string[];
  /** 録音中に打ったマーカー */
  markers?: Marker[];
  /** ゴミ箱に入れた日時（設定されている間は一覧・統計から除外。30日後に完全削除） */
  deletedAt?: string;
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

/** 記録に付いたタグの配列を取得（旧形式 tag: string|null との互換） */
export function getRecordTags(rec: Pick<CallRecord, 'tag' | 'tags'>): string[] {
  if (rec.tags && rec.tags.length > 0) return rec.tags;
  return rec.tag ? [rec.tag] : [];
}

/** タグ配列を保存用のパッチに変換（旧 tag も先頭タグでミラーして互換維持） */
export function tagsPatch(tags: string[]): { tags: string[]; tag: string | null } {
  return { tags, tag: tags[0] ?? null };
}

export interface ShortcutSettings {
  startCall: string;
  startMeeting: string;
  endCall: string;
  toggleWindow: string;
  toggleHold: string;
  togglePauseRecording: string;
  addMarker: string;
  openSettings: string;
  assignTag1: string;
  assignTag2: string;
  assignTag3: string;
  assignTag4: string;
}

export type WhisperModel = 'tiny' | 'base' | 'small' | 'medium' | 'large-v3-turbo';

export type ThemePref = 'system' | 'light' | 'dark' | 'black';

export type HudSize = 'mini' | 'compact' | 'full';
/** ライブ字幕ウィンドウの文字サイズ */
export type LiveFontSize = 'sm' | 'md' | 'lg';
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
  /** 録音の前後の無音を自動でカットする */
  trimSilence?: boolean;
}

export interface TranscriptionSettings {
  model: WhisperModel;
  language: 'auto' | 'ja' | 'en';
  modelDownloaded: Partial<Record<WhisperModel, boolean>>;
  /** 用語ヒント: 社名・専門用語・参加者名などを whisper の初期プロンプトとして渡し、固有名詞の認識を改善する */
  prompt: string;
  /** GPU (CUDA) 版 whisper を使用する（隠しコマンドで解放される上級者向けオプション） */
  useGpu?: boolean;
  /** ライブ文字起こし（Vosk）を有効にする。録音が有効なことが前提 */
  liveEnabled?: boolean;
  /** ライブ文字起こしに使う Vosk モデル */
  liveModel?: VoskLiveModel;
  /**
   * 単語登録（置換辞書）。認識結果に含まれる誤変換を from → to で自動置換する。
   * ライブ（Vosk）にも whisper の確定版にも適用され、専門用語・固有名詞の表記を補正する。
   */
  termReplacements?: TermReplacement[];
}

/** 置換辞書の1エントリ（誤り from を正しい語 to に置換） */
export interface TermReplacement {
  from: string;
  to: string;
}

export type VoskLiveModel = 'small-ja' | 'ja';

export const VOSK_MODELS: Array<{ id: VoskLiveModel; sizeMb: number; label: string }> = [
  { id: 'small-ja', sizeMb: 48,   label: 'small-ja (約 48MB, 軽量・推奨)' },
  { id: 'ja',       sizeMb: 1024, label: 'ja (約 1GB, 高精度)' },
];

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
  /** Windows ログイン時に自動起動する */
  launchAtLogin: boolean;
  /** 起動時に新バージョンを確認して通知する */
  checkUpdatesOnStartup: boolean;
  /** 初回セットアップウィザードを完了したか */
  onboardingDone: boolean;
  confirmCallDelete: boolean;
  theme: ThemePref;
  hudSize: HudSize;
  hudOpacity: HudOpacity;
  /** ライブ字幕ウィンドウを表示するか（HUD の「字幕」ボタン・×ボタンからも切替可能） */
  hudLiveVisible?: boolean;
  /** ライブ字幕ウィンドウの位置とサイズ（移動・リサイズで保存） */
  liveWindowBounds?: { x: number; y: number; width: number; height: number };
  /** ライブ字幕ウィンドウの文字サイズ */
  liveFontSize?: LiveFontSize;
  /** （旧）HUD 内ライブ字幕の行数・高さ。独立ウィンドウ化に伴い未使用 */
  hudLiveLines?: number;
  hudLivePanelPx?: number;
  transcriptSeekOffsetSec: number;
  /** 保存ダイアログで前回使ったフォルダ（auto モードで使用） */
  lastSaveDir?: string | null;
  /** 保存先の決め方。auto=前回の保存先を記憶 / fixed=固定フォルダ */
  saveDirMode?: 'auto' | 'fixed';
  /** saveDirMode='fixed' のときの保存先フォルダ */
  fixedSaveDir?: string | null;
  /** Teams 会議/通話を検知して自動録音する（実験的・ウィンドウタイトル監視） */
  teamsDetectEnabled?: boolean;
  /** 検知時の動作。auto=即録音開始 / confirm=通知をクリックで開始 */
  teamsDetectMode?: 'auto' | 'confirm';
  /** タイトルから会議/通話を判別できないときの既定の種別 */
  teamsDefaultKind?: RecordKind;
  /** 会議と判定するキーワード（読点・カンマ区切り）。既定「会議,ミーティング,meeting」 */
  teamsMeetingKeywords?: string;
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
  /** queued のとき、何番目の処理か（1=次に実行） */
  queuePosition?: number;
};
export type TranscriptionProgressEvent = {
  type: 'transcription:progress';
  callId: string;
  /** 処理段階。convert=音声変換, transcribe=whisper 実行 */
  stage: 'convert' | 'transcribe';
  /** 変換〜完了までを通した全体進捗 (0-100)。1秒ごとに補間して配信される */
  percent: number;
  /** 推定残り秒数（進捗速度から算出。算出前は null） */
  etaSec?: number | null;
};

/** 文字起こしキュー全体の状況（フッター表示用。進捗・状態変化のたびに配信） */
export type TranscriptionSummaryEvent = {
  type: 'transcription:summary';
  running: { callId: string; percent: number; etaSec: number | null } | null;
  /** 実行中を除く待機ジョブ数 */
  waiting: number;
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
  variant?: 'cpu' | 'gpu';
  receivedBytes: number;
  totalBytes: number | null;
  error?: string;
};
/** Vosk エンジン・モデルのダウンロード進捗 */
export type VoskDownloadEvent = {
  type: 'vosk:download';
  what: 'engine' | 'engine-legacy' | VoskLiveModel;
  step: 'download' | 'extract' | 'done' | 'error';
  receivedBytes: number;
  totalBytes: number | null;
  error?: string;
};
/** ライブ文字起こしの暫定テキスト（Vosk）。final=false は途中経過で、次の同 final=false を置き換える */
export type LiveSegmentEvent = {
  type: 'live:segment';
  callId: string;
  text: string;
  final: boolean;
  /** 記録開始からの経過秒 */
  at: number;
};
/** ライブ文字起こしセッションの状態通知 */
export type LiveStateEvent = { type: 'live:state'; callId: string; active: boolean; error?: string };
/** マーカー追加の通知 */
export type MarkerAddedEvent = { type: 'marker:added'; callId: string; marker: Marker; count: number };
/** HUD 上にカーソルがあるか（main がカーソル位置を監視して通知。drag 領域では DOM イベントが発火しないため） */
export type HudHoverEvent = { type: 'hud:hover'; hovered: boolean };
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
  | TranscriptionSummaryEvent
  | RecordingTogglePauseEvent
  | RecordingStateEvent
  | RecordingErrorEvent
  | RecordingLevelEvent
  | VoskDownloadEvent
  | LiveSegmentEvent
  | LiveStateEvent
  | MarkerAddedEvent
  | HudHoverEvent
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
    startCall: 'Ctrl+Shift+S',
    startMeeting: 'Ctrl+Shift+M',
    endCall: 'Ctrl+Shift+E',
    toggleWindow: 'Ctrl+Shift+T',
    toggleHold: 'Ctrl+Shift+H',
    togglePauseRecording: 'Ctrl+Shift+P',
    addMarker: 'Ctrl+Shift+K',
    openSettings: 'Ctrl+Shift+,',
    assignTag1: 'Ctrl+Shift+1',
    assignTag2: 'Ctrl+Shift+2',
    assignTag3: 'Ctrl+Shift+3',
    assignTag4: 'Ctrl+Shift+4',
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
    trimSilence: true,
  },
  transcription: {
    model: 'small',
    language: 'ja',
    modelDownloaded: {},
    prompt: '',
  },
  confirmRecordingEnable: true,
  minimizeToTray: false,
  launchAtLogin: false,
  checkUpdatesOnStartup: true,
  onboardingDone: false,
  confirmCallDelete: true,
  theme: 'system',
  hudSize: 'compact',
  hudOpacity: 1.0,
  hudLiveVisible: true,
  liveFontSize: 'sm',
  transcriptSeekOffsetSec: 1.0,
  teamsDetectEnabled: false,
  teamsDetectMode: 'confirm',
  teamsDefaultKind: 'meeting',
  teamsMeetingKeywords: '会議,ミーティング,meeting',
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
