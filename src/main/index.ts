import { app, BrowserWindow, ipcMain, dialog, session, shell, powerSaveBlocker, WebContents, desktopCapturer, nativeTheme } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { Store } from './store';
import {
  CallRecord, CsvExportOptions, CsvImportResult, Settings,
  CallTranscript, WhisperModel, RecordKind, AudioSourceLabel, Marker,
  RecordingSourceConfig, VoskLiveModel, TranscriptSegment,
  getRecordTags, tagsPatch,
} from '../shared/types';
import { registerShortcuts, unregisterAll } from './shortcuts';
import {
  createMainWindow,
  toggleMainWindow,
  showMainWindow,
  showMainWindowAt,
  createHudWindow,
  closeHudWindow,
  createRecorderWindow,
  destroyRecorderWindow,
  broadcast,
  getHudWindow,
  markForceQuit,
  setBeforeCloseHandler,
  setMinimizeToTray,
  setHudSize,
  setHudExtraHeight,
  nextHudSize,
  showLiveWindow,
  hideLiveWindow,
  getLiveWindow,
  setLiveBoundsHandler,
  setThemeProvider,
  updateTitleBarOverlay,
} from './window';
import { resolveEffectiveTheme, EffectiveTheme } from '../shared/titlebarTheme';
import { createTray, updateTray, destroyTray, TrayHandlers } from './tray';
import { exportCsv, parseCsv } from './csv';
import { notify } from './notifications';
import { ensureAppDirs, getDirs } from './paths';
import { registerAppProtocol, registerAppProtocolPrivilege } from './protocol';
import * as recording from './recording';
import { convertWebmToMp3, probeDurationSec } from './ffmpeg';
import {
  enqueue as enqueueTranscription, cancel as cancelTranscription,
  setQueueHandlers, WhisperMissingError, checkSetup as checkTranscriptionSetup,
  queueLength as transcriptionQueueLength, shutdownQueue as shutdownTranscription,
  isActive as isTranscriptionActive,
} from './transcription';
import { downloadModel, isModelDownloaded, getModelPath } from './whisperModels';
import { scheduleDailyCleanup, stopDailyCleanup, cleanupExpiredRecordings } from './retention';
import { localDate } from './localTime';
import { getLogPath, logInfo } from './log';
import { downloadWhisperBinary, isBinaryInstalled } from './whisperBinary';
import {
  isVoskEngineInstalled, isVoskModelInstalled, downloadVosk,
  startLive as voskStartLive, stopLive as voskStopLive, feedPcm as voskFeedPcm,
  unloadModel as voskUnloadModel, shutdownVosk,
} from './vosk';
import { checkForUpdate, checkOnStartup, UpdateCheckResult } from './updates';
import {
  isSelfUpdateSupported, prepareUpdate, applyPreparedUpdate, cleanupOldInstallDir,
  getSelfUpdateStatus,
} from './selfUpdate';

registerAppProtocolPrivilege();

// Windows のネイティブ・オクルージョン検知は、最小化・遮蔽されたウィンドウの
// 描画を停止させ、復帰時に画面が固まる原因になる（録音の有無に関わらず発生）。
// この機能を無効化して、復帰時のフリーズを根本的に防ぐ。
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
// 遮蔽ウィンドウのバックグラウンド化（レンダラのスロットリング/停止）も抑止する。
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

const store = new Store();

let tickInterval: NodeJS.Timeout | null = null;
let longCallAlertFired = false;

/** システム音声キャプチャの対象。録音開始前にレンダラから設定される */
let captureTarget: { type: 'screen' } | { type: 'window'; sourceId: string } = { type: 'screen' };

/** 開始ダイアログで選択された、次の録音1回分のソース上書き */
let pendingSourceOverride: {
  config: RecordingSourceConfig;
  windowId: string | null;
  micDeviceId: string | null;
} | null = null;

/** 録音サービスウィンドウが報告する現在の録音状態（HUD 等の初期表示用） */
let lastRecordingState = { recording: false, paused: false };

/** 実行中の finalize（webm→mp3 変換）数。終了時にこれを待つ */
let finalizingCount = 0;

/** アプリ終了フロー中フラグ */
let shuttingDown = false;

// ============ スリープ抑止 ============
// 記録中（=録音の可能性あり）または文字起こし中は PC のスリープを防ぐ。
// スリープすると録音が途切れ、whisper も中断されるため。
let powerBlockerId: number | null = null;

function updatePowerBlocker(): void {
  const needed = !!store.getActiveCall() || transcriptionQueueLength() > 0 || finalizingCount > 0;
  if (needed && powerBlockerId === null) {
    powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    logInfo('power', 'sleep blocker ON');
  } else if (!needed && powerBlockerId !== null) {
    powerSaveBlocker.stop(powerBlockerId);
    powerBlockerId = null;
    logInfo('power', 'sleep blocker OFF');
  }
}

function getActive(): CallRecord | null {
  return store.getActiveCall();
}

function todayStats(): { calls: { count: number; totalSec: number }; meetings: { count: number; totalSec: number } } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const calls = { count: 0, totalSec: 0 };
  const meetings = { count: 0, totalSec: 0 };
  for (const c of store.getCalls()) {
    if (!c.endTime || c.deletedAt) continue;
    if (new Date(c.startTime).getTime() < start) continue;
    const bucket = c.kind === 'meeting' ? meetings : calls;
    bucket.count++;
    bucket.totalSec += c.durationSec ?? 0;
  }
  return { calls, meetings };
}

function startTickLoop() {
  if (tickInterval) return;
  tickInterval = setInterval(() => {
    const active = getActive();
    if (!active) return;
    const elapsedSec = Math.floor((Date.now() - new Date(active.startTime).getTime()) / 1000);
    const holding = store.isHolding();
    const holdSec = store.getLiveHoldSec();
    broadcast('app-event', { type: 'tick', activeId: active.id, elapsedSec, holding, holdSec });
    updateTray(
      { active: true, elapsedSec, holding, recording: store.getSettings().recording.enabled, today: todayStats() },
      trayHandlers,
    );

    // 長電話アラートは通話のみ（会議は長時間が通常のため対象外）
    const alertMin = store.getSettings().longCallAlertMin;
    if (alertMin && alertMin > 0 && !longCallAlertFired && elapsedSec >= alertMin * 60 && active.kind !== 'meeting') {
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

/** 記録を開始する。meta で開始前に入力されたタイトル・連絡先などを反映できる */
function startCall(kind: RecordKind = 'call', meta?: Partial<CallRecord>): CallRecord | null {
  if (getActive()) {
    notify('CallStack', '進行中の記録があります。先に終了してください。');
    return null;
  }
  const now = new Date().toISOString();
  const rec: CallRecord = {
    id: nanoid(),
    kind,
    startTime: now,
    endTime: null,
    durationSec: null,
    tag: meta?.tag ?? null,
    memo: meta?.memo ?? '',
    contactName: meta?.contactName,
    phoneNumber: meta?.phoneNumber,
    title: meta?.title,
    participants: meta?.participants,
    holds: [],
    holdSec: 0,
  };
  store.addCall(rec);
  longCallAlertFired = false;
  logInfo('call', `started ${kind} ${rec.id}`);
  const settings = store.getSettings();
  createHudWindow(settings.hudPosition, settings.hudSize);
  updateTray({ active: true, elapsedSec: 0, today: todayStats() }, trayHandlers);
  startTickLoop();
  updatePowerBlocker();
  broadcast('app-event', { type: 'call:started', record: rec });
  void startLiveSession(rec);
  updateLiveWindow();
  return rec;
}

async function endCall(): Promise<CallRecord | null> {
  const active = getActive();
  if (!active) return null;
  // Close any open hold first
  if (store.isHolding()) store.endHold();
  void stopLiveSession();
  const endTime = new Date().toISOString();
  const durationSec = Math.max(
    0,
    Math.round((new Date(endTime).getTime() - new Date(active.startTime).getTime()) / 1000),
  );
  const updated = store.updateCall(active.id, { endTime, durationSec });

  // Wait briefly for recording to finalize (HUD pushes last chunk + finalize)
  // Then ask the renderer to stop and provide chunks.
  // Recording stop is initiated by the renderer reacting to call:ended event,
  // so we just broadcast and let it call recording:finalize.
  stopTickLoop();
  closeHudWindow();
  hideLiveWindow();
  updateTray({ active: false, today: todayStats() }, trayHandlers);
  updatePowerBlocker();
  logInfo('call', `ended ${active.id} (${durationSec}s)`);
  if (updated) {
    broadcast('app-event', { type: 'call:ended', record: updated });
    const label = updated.kind === 'meeting' ? '会議を記録しました' : '通話を記録しました';
    notify(label, `${formatHMS(durationSec)} — クリックで詳細編集`, () => showMainWindow());
  }
  return updated;
}

/** 指定（または進行中）の記録に現在時刻のマーカーを追加する */
function addMarkerTo(callId?: string, label?: string): CallRecord | null {
  const rec = callId ? store.getCall(callId) : getActive();
  if (!rec) return null;
  const at = rec.endTime
    ? 0
    : Math.max(0, Math.round((Date.now() - new Date(rec.startTime).getTime()) / 1000));
  const marker: Marker = label ? { at, label } : { at };
  const markers = [...(rec.markers ?? []), marker].sort((a, b) => a.at - b.at);
  const updated = store.updateCall(rec.id, { markers });
  if (updated) {
    broadcast('app-event', { type: 'call:updated', record: updated });
    broadcast('app-event', { type: 'marker:added', callId: rec.id, marker, count: markers.length });
  }
  return updated;
}

/** 録音中のレンダラへ一時停止/再開のトグルを指示する */
function togglePauseRecording(): void {
  if (!getActive()) return;
  if (!store.getSettings().recording.enabled) return;
  broadcast('app-event', { type: 'recording:togglePause' });
}

function toggleHold(): void {
  if (!getActive()) return;
  if (store.isHolding()) {
    const r = store.endHold();
    if (r.record) broadcast('app-event', { type: 'hold:changed', callId: r.record.id, holding: false, holdSec: r.record.holdSec ?? 0 });
  } else {
    const r = store.startHold();
    if (r.record) broadcast('app-event', { type: 'hold:changed', callId: r.record.id, holding: true, holdSec: r.record.holdSec ?? 0 });
  }
}

function formatHMS(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rs = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(rs).padStart(2, '0')}`;
}

// ============ ライブ文字起こし（Vosk） ============
// 録音サービスウィンドウから 16kHz PCM を受け取り、Vosk で暫定テキストを生成する。
// 確定版は従来どおり録音終了後に whisper が生成し、暫定 transcript を置き換える。
interface LiveSession {
  callId: string;
  segments: TranscriptSegment[];
  /** モデルロード完了前に届いた PCM の一時バッファ（約30秒分まで） */
  pending: Buffer[];
  ready: boolean;
  stopped: boolean;
}
let liveSession: LiveSession | null = null;

// ============ Teams 会議/通話の自動検知（実験的・ウィンドウタイトル監視） ============
let teamsPollTimer: NodeJS.Timeout | null = null;
let teamsPresentCount = 0;
let teamsAbsentCount = 0;
/** 検知によって自動開始した記録の ID（手動開始の記録を勝手に終了しないため） */
let teamsAutoCallId: string | null = null;
let teamsNotifiedForSession = false;
let teamsLastDiagLog = 0;

/** ウィンドウタイトル群から Teams の会議/通話セッションを推定する */
function findTeamsSession(
  titles: string[],
  s: Settings,
): { kind: RecordKind; title: string | undefined } | null {
  const match = (s.teamsWindowMatch ?? 'Microsoft Teams').toLowerCase();
  const teams = titles.filter((t) => t.toLowerCase().includes(match));
  if (teams.length === 0) return null;
  // メイン窓・各タブ（チャット/予定表/通話 一覧 等）は録音対象外
  const isBaseWindow = (t: string): boolean => {
    const n = t.trim();
    if (/^Microsoft Teams$/i.test(n)) return true;
    return /(チャット|Chat|アクティビティ|Activity|予定表|Calendar|通話|Calls|ファイル|Files|設定|Settings|Teams と Outlook|Home)\s*[|｜]\s*Microsoft Teams$/i.test(n);
  };
  const sessionWins = teams.filter((t) => !isBaseWindow(t));
  if (sessionWins.length === 0) return null;
  const kws = (s.teamsMeetingKeywords ?? '会議,ミーティング,meeting')
    .split(/[、,]/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  const meetingWin = sessionWins.find((t) => kws.some((k) => t.toLowerCase().includes(k)));
  const chosen = meetingWin ?? sessionWins[0];
  const kind: RecordKind = meetingWin ? 'meeting' : (s.teamsDefaultKind ?? 'meeting');
  const title = chosen.replace(/\s*[|｜]\s*Microsoft Teams\s*$/i, '').trim() || undefined;
  return { kind, title };
}

async function pollTeamsDetection(): Promise<void> {
  const s = store.getSettings();
  if (!s.teamsDetectEnabled || !s.recording.enabled) return;
  let sources: Electron.DesktopCapturerSource[];
  try {
    sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
  } catch {
    return;
  }
  const titles = sources.map((x) => x.name).filter(Boolean);
  const sess = findTeamsSession(titles, s);
  if (!sess) {
    // 検知できないときは、原因調査のため現在のウィンドウ名を app.log に記録（30秒に1回）
    const now = Date.now();
    if (now - teamsLastDiagLog > 30_000) {
      teamsLastDiagLog = now;
      logInfo('teams', `no match. match="${s.teamsWindowMatch ?? 'Microsoft Teams'}" windows=[${titles.join(' | ')}]`);
    }
  }
  if (sess) {
    teamsAbsentCount = 0;
    teamsPresentCount += 1;
    // 立ち上がり（2 回連続で検知）かつ 進行中の記録がなければ開始
    if (teamsPresentCount >= 2 && !getActive() && !teamsAutoCallId) {
      const meta = sess.kind === 'meeting' ? { title: sess.title } : undefined;
      if (s.teamsDetectMode === 'auto') {
        const rec = startCall(sess.kind, meta);
        if (rec) {
          teamsAutoCallId = rec.id;
          logInfo('teams', `auto-started ${sess.kind} for "${sess.title ?? ''}"`);
        }
      } else if (!teamsNotifiedForSession) {
        teamsNotifiedForSession = true;
        notify(
          `Teams${sess.kind === 'meeting' ? '会議' : '通話'}を検知しました`,
          'クリックで録音を開始します',
          () => {
            if (!getActive()) {
              const rec = startCall(sess.kind, meta);
              if (rec) teamsAutoCallId = rec.id;
            }
          },
        );
      }
    }
  } else {
    teamsPresentCount = 0;
    teamsNotifiedForSession = false;
    teamsAbsentCount += 1;
    // 立ち下がり（2 回連続で不在）で、自動開始した記録を終了する
    if (teamsAbsentCount >= 2 && teamsAutoCallId) {
      const id = teamsAutoCallId;
      teamsAutoCallId = null;
      if (getActive()?.id === id) {
        logInfo('teams', `session ended — stopping auto-started ${id}`);
        void endCall();
      }
    }
  }
}

function startTeamsPolling(): void {
  if (teamsPollTimer) return;
  teamsPollTimer = setInterval(() => { void pollTeamsDetection(); }, 4000);
  logInfo('teams', 'detection polling started');
}

function stopTeamsPolling(): void {
  if (teamsPollTimer) {
    clearInterval(teamsPollTimer);
    teamsPollTimer = null;
  }
  teamsPresentCount = 0;
  teamsAbsentCount = 0;
  teamsNotifiedForSession = false;
}

/** 置換辞書（単語登録）を適用して認識結果の表記を補正する。ライブ・whisper 共通 */
function applyTermReplacements(text: string): string {
  const list = store.getSettings().transcription.termReplacements ?? [];
  let out = text;
  for (const { from, to } of list) {
    if (from) out = out.split(from).join(to);
  }
  return out;
}

/** ライブ文字起こしが使える構成か（設定 ON + エンジン・モデル配置済み） */
async function isLiveReady(s: Settings): Promise<boolean> {
  if (!s.recording.enabled || !s.transcription.liveEnabled) return false;
  const model = s.transcription.liveModel ?? 'small-ja';
  return (await isVoskEngineInstalled()) && (await isVoskModelInstalled(model));
}

/**
 * ライブ字幕ウィンドウの表示/非表示を現在の状態に合わせる。
 * 記録中 かつ ライブ文字起こし有効 かつ 表示設定 ON のときだけ出す。
 */
function updateLiveWindow(): void {
  const s = store.getSettings();
  const shouldShow = !!getActive()
    && s.recording.enabled
    && !!s.transcription.liveEnabled
    && (s.hudLiveVisible ?? true);
  if (shouldShow) {
    showLiveWindow(s.liveWindowBounds ?? null);
  } else {
    hideLiveWindow();
  }
}

async function startLiveSession(rec: CallRecord): Promise<void> {
  const s = store.getSettings();
  if (!(await isLiveReady(s))) return;
  const modelId = s.transcription.liveModel ?? 'small-ja';
  const sess: LiveSession = {
    callId: rec.id,
    segments: [],
    pending: [],
    ready: false,
    stopped: false,
  };
  liveSession = sess;
  try {
    await voskStartLive(modelId, {
      onSegment: (seg) => {
        if (liveSession !== sess) return;
        // 単語登録（置換辞書）で専門用語・固有名詞の表記を補正する
        const text = applyTermReplacements(seg.text);
        // タイムスタンプはワーカーが消費した音声位置（秒）。壁時計の遅延を受けない。
        if (seg.final) {
          sess.segments.push({ start: seg.startSec, end: seg.endSec, text });
        }
        broadcast('app-event', {
          type: 'live:segment', callId: sess.callId, text, final: seg.final, at: seg.startSec,
        });
      },
      onError: (message) => {
        // ワーカーの異常終了など。録音・記録には影響しないため通知のみ。
        // セッションは残し、既に得られたセグメントは終了時に暫定保存される。
        if (liveSession !== sess) return;
        logInfo('live', `session error: ${message}`);
        broadcast('app-event', { type: 'live:state', callId: sess.callId, active: false, error: message });
        broadcast('app-event', {
          type: 'recording:error',
          message: `ライブ文字起こしが停止しました（録音は継続しています）: ${message}`,
        });
      },
    });
    if (liveSession !== sess || sess.stopped) {
      // モデルロード中に記録が終了した
      await voskStopLive().catch(() => {});
      return;
    }
    sess.ready = true;
    for (const buf of sess.pending) voskFeedPcm(buf);
    sess.pending = [];
    broadcast('app-event', { type: 'live:state', callId: sess.callId, active: true });
    logInfo('live', `session started for ${rec.id} (model=${modelId})`);
  } catch (err) {
    const message = (err as Error).message;
    if (liveSession === sess) liveSession = null;
    logInfo('live', `start failed: ${message}`);
    broadcast('app-event', { type: 'live:state', callId: rec.id, active: false, error: message });
    broadcast('app-event', {
      type: 'recording:error',
      message: `ライブ文字起こしを開始できませんでした（録音は継続しています）: ${message}\n`
        + '設定 → 文字起こし → ライブ文字起こしから、エンジンの旧バージョン (0.3.42) への入れ替えをお試しください。',
    });
  }
}

async function stopLiveSession(): Promise<void> {
  const sess = liveSession;
  if (!sess) return;
  sess.stopped = true;
  liveSession = null;
  if (!sess.ready) return;   // startLiveSession 側が後始末する
  const tail = await voskStopLive().catch(() => null);
  if (tail && tail.text) {
    sess.segments.push({ start: tail.startSec, end: tail.endSec, text: applyTermReplacements(tail.text) });
  }
  broadcast('app-event', { type: 'live:state', callId: sess.callId, active: false });
  logInfo('live', `session stopped for ${sess.callId} (${sess.segments.length} segments)`);
  // 暫定の文字起こしとして保存する（whisper が完了したら置き換わる）。
  // whisper 側のステータス (queued/running) が先に付いていたら上書きしない。
  const rec = store.getCall(sess.callId);
  if (!rec || sess.segments.length === 0 || rec.transcript) return;
  const status = (!rec.transcriptStatus || rec.transcriptStatus === 'none' || rec.transcriptStatus === 'error')
    ? 'done' as const
    : rec.transcriptStatus;
  const transcript: CallTranscript = {
    text: sess.segments.map((x) => x.text).join('\n'),
    language: 'ja',
    model: 'vosk ライブ（暫定）',
    createdAt: new Date().toISOString(),
    segments: sess.segments,
  };
  setTranscriptStatus(sess.callId, { transcript, transcriptStatus: status }, { status, transcript });
}

/**
 * 前回の保存先フォルダを既定にする保存ダイアログ。
 * 保存が確定したらフォルダを記憶する。
 */
async function showSaveDialogRemembered(
  title: string,
  fileName: string,
  filters: Electron.FileFilter[],
): Promise<string | null> {
  const s = store.getSettings();
  // fixed: 設定で決めたフォルダを常に既定にする / auto: 前回の保存先を記憶
  const baseDir = (s.saveDirMode === 'fixed' && s.fixedSaveDir)
    ? s.fixedSaveDir
    : (s.lastSaveDir ?? app.getPath('documents'));
  const result = await dialog.showSaveDialog({
    title,
    defaultPath: path.join(baseDir, fileName),
    filters,
  });
  if (result.canceled || !result.filePath) return null;
  if (s.saveDirMode !== 'fixed') {
    store.setSettings({ ...store.getSettings(), lastSaveDir: path.dirname(result.filePath) });
  }
  return result.filePath;
}

async function chooseAndExport(): Promise<{ count: number; path: string } | null> {
  const filePath = await showSaveDialogRemembered(
    'CSV をエクスポート',
    `callstack-${localDate(new Date())}.csv`,
    [{ name: 'CSV', extensions: ['csv'] }],
  );
  if (!filePath) return null;
  const count = await exportCsv(filePath, store.getCalls().filter((c) => !c.deletedAt), { range: 'all' });
  return { count, path: filePath };
}

const trayHandlers: TrayHandlers = {
  onStart: () => startCall(),
  onStartMeeting: () => startCall('meeting'),
  onEnd: () => { void endCall(); },
  onOpen: () => showMainWindow(),
  onExport: async () => {
    const r = await chooseAndExport();
    if (r) notify('CSV エクスポート完了', `${r.count} 件を ${r.path} に書き出しました`);
  },
  onQuit: () => {
    markForceQuit();
    app.quit();
  },
  onSetTheme: (theme) => {
    const cur = store.getSettings();
    if (cur.theme === theme) return;
    const next = { ...cur, theme };
    store.setSettings(next);
    broadcast('app-event', { type: 'settings:updated', settings: next });
    updateTray({ active: !!getActive(), today: todayStats() }, trayHandlers);
    // トレイからのテーマ変更は renderer を経由しないため、ここで直接
    // タイトルバー色を更新する（renderer からは別途 theme:changed が届く）
    updateTitleBarOverlay(resolveEffectiveTheme(next.theme, nativeTheme.shouldUseDarkColors));
  },
  getTheme: () => store.getSettings().theme,
};

function assignTagToActive(tag: string | null): CallRecord | null {
  const active = getActive();
  if (!active) return null;
  const cur = getRecordTags(active);
  let next: string[];
  if (tag === null) {
    next = [];   // クリア
  } else if (cur.includes(tag)) {
    next = cur.filter((t) => t !== tag);   // トグルで外す
  } else {
    next = [...cur, tag];                   // 追加（複数可）
  }
  const updated = store.updateCall(active.id, tagsPatch(next));
  if (updated) broadcast('app-event', { type: 'call:updated', record: updated });
  return updated;
}

function assignTagByIndex(idx: number): void {
  const s = store.getSettings();
  const tag = s.tags[idx]?.name;
  if (!tag) return;
  assignTagToActive(tag);
}

function reRegisterShortcuts(): void {
  const s = store.getSettings();
  const failures = registerShortcuts(s.shortcuts, {
    start: () => startCall(),
    startMeeting: () => startCall('meeting'),
    end: () => { void endCall(); },
    toggle: () => toggleMainWindow(),
    toggleHold: () => toggleHold(),
    togglePauseRecording: () => togglePauseRecording(),
    addMarker: () => { addMarkerTo(); },
    openSettings: () => showMainWindowAt('settings'),
    assignTag: (idx) => assignTagByIndex(idx),
  });
  if (failures.length > 0) {
    notify('ショートカット登録失敗', `登録できませんでした: ${failures.join(', ')}`);
  }
}

function setupIpc(): void {
  // renderer 側でテーマ（'system' 解決後の実効テーマ）が確定/変化するたびに
  // 届く。Windows のタイトルバーオーバーレイ色をその場で更新する。
  ipcMain.on('theme:changed', (_e, effective: EffectiveTheme) => {
    updateTitleBarOverlay(effective);
  });

  ipcMain.handle('calls:list', () => store.getCalls());
  ipcMain.handle('calls:getActive', () => store.getActiveCall());
  ipcMain.handle('calls:get', (_e, id: string) => store.getCall(id));

  ipcMain.handle('calls:startNow', (_e, kind?: RecordKind, meta?: Partial<CallRecord>) =>
    startCall(kind ?? 'call', meta));
  ipcMain.handle('calls:endNow', () => endCall());
  ipcMain.handle('calls:toggleHold', () => toggleHold());

  // 進行中の記録に現在時刻のマーカーを打つ（HUD・ヘッダー・ショートカットから）
  ipcMain.handle('calls:add-marker', (_e, callId?: string, label?: string) =>
    addMarkerTo(callId, label));

  ipcMain.handle('calls:update', (_e, id: string, patch: Partial<CallRecord>) => {
    const updated = store.updateCall(id, patch);
    if (updated) broadcast('app-event', { type: 'call:updated', record: updated });
    return updated;
  });

  // 削除はまずゴミ箱へ（ソフトデリート）。録音ファイルは完全削除まで保持する。
  ipcMain.handle('calls:delete', async (_e, id: string) => {
    // ゴミ箱の記録は文字起こし対象外。進行中・待機中なら中止する。
    if (isTranscriptionActive(id)) cancelTranscription(id);
    const updated = store.updateCall(id, { deletedAt: new Date().toISOString() });
    if (updated) broadcast('app-event', { type: 'call:updated', record: updated });
    return !!updated;
  });

  // ゴミ箱から復元
  ipcMain.handle('calls:restore', (_e, id: string) => {
    const updated = store.updateCall(id, { deletedAt: undefined });
    if (updated) broadcast('app-event', { type: 'call:updated', record: updated });
    return updated;
  });

  // 完全削除（録音ファイルごと）
  ipcMain.handle('calls:purge', async (_e, id: string) => {
    const rec = store.getCall(id);
    if (rec?.audio) {
      try { await recording.deleteRecording(rec.audio.path); } catch { /* ignore */ }
    }
    const ok = store.deleteCall(id);
    if (ok) broadcast('app-event', { type: 'call:deleted', id });
    return ok;
  });

  // ゴミ箱を空にする
  ipcMain.handle('calls:purge-trash', async () => {
    const trash = store.getCalls().filter((c) => c.deletedAt);
    for (const rec of trash) {
      if (rec.audio) {
        try { await recording.deleteRecording(rec.audio.path); } catch { /* ignore */ }
      }
      store.deleteCall(rec.id);
      broadcast('app-event', { type: 'call:deleted', id: rec.id });
    }
    return trash.length;
  });

  ipcMain.handle('calls:create', (_e, partial: Partial<CallRecord>) => {
    const rec: CallRecord = {
      id: nanoid(),
      kind: partial.kind ?? 'call',
      startTime: partial.startTime ?? new Date().toISOString(),
      endTime: partial.endTime ?? null,
      durationSec: partial.durationSec ?? null,
      tag: partial.tag ?? null,
      memo: partial.memo ?? '',
      contactName: partial.contactName,
      phoneNumber: partial.phoneNumber,
      title: partial.title,
      participants: partial.participants,
      holds: partial.holds ?? [],
      holdSec: partial.holdSec ?? 0,
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
    const prev = store.getSettings();
    store.setSettings(next);
    reRegisterShortcuts();
    setMinimizeToTray(next.minimizeToTray);
    if (prev.hudSize !== next.hudSize) setHudSize(next.hudSize);
    if (prev.launchAtLogin !== next.launchAtLogin) applyLaunchAtLogin(next.launchAtLogin);
    // ライブ文字起こしを無効化したらモデルをメモリから解放（セッション中は保持）
    if (prev.transcription.liveEnabled && !next.transcription.liveEnabled && !liveSession) {
      voskUnloadModel();
    }
    broadcast('app-event', { type: 'settings:updated', settings: next });
    // 表示切替・ライブ有効切替に追随してライブ字幕ウィンドウを出し入れ
    if (prev.hudLiveVisible !== next.hudLiveVisible
      || prev.transcription.liveEnabled !== next.transcription.liveEnabled) {
      updateLiveWindow();
    }
    // Teams 検知の ON/OFF に追随
    if (prev.teamsDetectEnabled !== next.teamsDetectEnabled) {
      if (next.teamsDetectEnabled) startTeamsPolling();
      else stopTeamsPolling();
    }
    return next;
  });

  // ============ アプリ情報・更新チェック ============
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    logPath: getLogPath(),
    dataDir: app.getPath('userData'),
  }));

  ipcMain.handle('app:open-path', async (_e, target: 'logs' | 'data' | 'recordings') => {
    const p = target === 'logs'
      ? path.dirname(getLogPath())
      : target === 'recordings'
        ? getDirs().recordings
        : app.getPath('userData');
    await shell.openPath(p);
    return true;
  });

  ipcMain.handle('update:check', () => checkForUpdate());
  ipcMain.handle('update:open-releases', async (_e, url?: string) => {
    await shell.openExternal(url ?? 'https://github.com/Yu5rin/CallStack/releases/latest');
    return true;
  });

  // 手動で「今すぐ更新を確認して準備する」（設定画面のボタンから）
  ipcMain.handle('update:prepareNow', async () => {
    const r = await checkForUpdate();
    if (!r.ok) return { ok: false, error: r.error };
    if (!r.hasUpdate) return { ok: true, hasUpdate: false as const };
    if (!isSelfUpdateSupported()) {
      return { ok: false, error: 'この環境では自動更新に対応していません（開発モード、または Windows 以外）。' };
    }
    void prepareUpdateFlow(r);
    return { ok: true, hasUpdate: true as const, version: r.latest };
  });

  ipcMain.handle('update:applyNow', () => applyUpdateNow());
  ipcMain.handle('update:selfStatus', () => getSelfUpdateStatus());

  ipcMain.handle('csv:export', async (_e, opts: CsvExportOptions) => {
    const filePath = await showSaveDialogRemembered(
      'CSV をエクスポート',
      `callstack-${localDate(new Date())}.csv`,
      [{ name: 'CSV', extensions: ['csv'] }],
    );
    if (!filePath) return { canceled: true } as const;
    const count = await exportCsv(filePath, store.getCalls().filter((c) => !c.deletedAt), opts);
    return { canceled: false, count, path: filePath } as const;
  });

  const importCsvText = async (raw: string): Promise<{ result: CsvImportResult; backupPath: string }> => {
    const parsed = parseCsv(raw);
    const errors: Array<{ row: number; message: string }> = [];
    const ok: CallRecord[] = [];
    let skipped = 0;
    for (const p of parsed) {
      if (p.error) { errors.push({ row: p.rowNumber, message: p.error }); continue; }
      if (!p.record || !p.record.startTime) { skipped += 1; continue; }
      const r: CallRecord = {
        id: p.record.id ?? nanoid(),
        kind: p.record.kind ?? 'call',
        startTime: p.record.startTime,
        endTime: p.record.endTime ?? null,
        durationSec: p.record.durationSec ?? null,
        tag: p.record.tag ?? null,
        tags: p.record.tags,
        memo: p.record.memo ?? '',
        contactName: p.record.contactName,
        phoneNumber: p.record.phoneNumber,
        title: p.record.title,
        participants: p.record.participants,
        holdSec: p.record.holdSec ?? 0,
      };
      ok.push(r);
    }
    const backupPath = await store.backupNow('pre-import');
    const { inserted, updated } = store.upsertMany(ok);
    for (const r of ok) broadcast('app-event', { type: 'call:updated', record: store.getCall(r.id)! });
    return { result: { inserted, updated, skipped, errors }, backupPath };
  };

  ipcMain.handle('csv:import', async (): Promise<{ canceled: true } | { canceled: false; result: CsvImportResult; backupPath: string }> => {
    const dlg = await dialog.showOpenDialog({
      title: 'CSV を読み込み',
      filters: [{ name: 'CSV', extensions: ['csv'] }],
      properties: ['openFile'],
    });
    if (dlg.canceled || dlg.filePaths.length === 0) return { canceled: true };
    const raw = await fs.readFile(dlg.filePaths[0], 'utf-8');
    const r = await importCsvText(raw);
    return { canceled: false, ...r };
  });

  ipcMain.handle('csv:import-text', async (_e, text: string) => {
    const r = await importCsvText(text);
    return { canceled: false as const, ...r };
  });

  ipcMain.handle('report:weekly', async () => {
    const md = buildWeeklyReport(store.getCalls().filter((c) => !c.deletedAt));
    const filePath = await showSaveDialogRemembered(
      '週次レポートを保存',
      `report-${weekStamp()}.md`,
      [{ name: 'Markdown', extensions: ['md'] }],
    );
    if (!filePath) return { canceled: true } as const;
    await fs.writeFile(filePath, md, 'utf-8');
    return { canceled: false, path: filePath } as const;
  });

  ipcMain.handle('hud:end', () => endCall());
  ipcMain.handle('hud:open-main', () => showMainWindow());
  // HUD の編集ボタン: メイン窓を前面に出して該当記録の編集ダイアログを開く
  ipcMain.handle('hud:open-edit', (_e, callId?: string) => {
    const id = callId ?? getActive()?.id;
    if (!id) return;
    showMainWindow();
    broadcast('app-event', { type: 'edit:record', callId: id });
    // ウィンドウ復帰直後の取りこぼしに備えて少し遅れて再送する
    setTimeout(() => broadcast('app-event', { type: 'edit:record', callId: id }), 400);
  });
  ipcMain.handle('hud:save-position', (_e, pos: { x: number; y: number }) => {
    const s = store.getSettings();
    store.setSettings({ ...s, hudPosition: pos });
  });
  ipcMain.handle('hud:cycle-size', () => {
    const s = store.getSettings();
    const next = nextHudSize(s.hudSize);
    const updated = { ...s, hudSize: next };
    store.setSettings(updated);
    setHudSize(next);
    broadcast('app-event', { type: 'settings:updated', settings: updated });
    return next;
  });
  ipcMain.handle('hud:assign-tag', (_e, tag: string | null) => assignTagToActive(tag));
  ipcMain.handle('hud:set-extra-height', (_e, extraPx: number) => {
    setHudExtraHeight(extraPx, store.getSettings().hudSize);
  });

  ipcMain.handle('hud:get-position', () => {
    const win = getHudWindow();
    if (!win) return null;
    const [x, y] = win.getPosition();
    return { x, y };
  });

  // ============ Recording ============
  ipcMain.handle('recording:append-chunk', async (_e, callId: string, buf: ArrayBuffer) => {
    await recording.appendChunk(callId, Buffer.from(buf));
    return true;
  });

  ipcMain.handle('recording:finalize', async (_e, callId: string, sourceLabel?: AudioSourceLabel) => {
    const s = store.getSettings();
    logInfo('recorder', `finalize start ${callId}`);
    finalizingCount += 1;
    updatePowerBlocker();
    let r: recording.FinalizeResult | null;
    try {
      r = await recording.finalize(callId, s.recording.mp3Bitrate, s.recording.trimSilence ?? true);
    } finally {
      finalizingCount -= 1;
      updatePowerBlocker();
    }
    logInfo('recorder', `finalize done ${callId} (${r ? `${r.bytes}B ${r.durationSec}s trim=${r.leadingTrimSec.toFixed(2)}s` : 'no data'})`);
    if (!r) return null;
    // 先頭無音をカットした分だけマーカー位置を前へずらす（音声とずれないように）
    const rec0 = store.getCall(callId);
    const shiftedMarkers = (r.leadingTrimSec > 0 && rec0?.markers?.length)
      ? rec0.markers
          .map((m) => ({ ...m, at: Math.max(0, m.at - r!.leadingTrimSec) }))
          .sort((a, b) => a.at - b.at)
      : undefined;
    const updated = store.updateCall(callId, {
      audio: {
        path: r.path,
        format: 'mp3',
        bytes: r.bytes,
        durationSec: r.durationSec,
        source: sourceLabel ?? 'mic',
      },
      ...(shiftedMarkers ? { markers: shiftedMarkers } : {}),
    });
    if (updated) {
      broadcast('app-event', {
        type: 'recording:finalized',
        callId,
        path: r.path,
        bytes: r.bytes,
        durationSec: r.durationSec,
      });
      broadcast('app-event', { type: 'call:updated', record: updated });
      if (s.recording.autoTranscribe) {
        queueTranscription(callId);
      }
    }
    return updated;
  });

  ipcMain.handle('recording:abort', async (_e, callId: string) => {
    await recording.abort(callId);
    return true;
  });

  // HUD やショートカットからの一時停止指示を、録音中のレンダラへ中継する
  ipcMain.handle('recording:toggle-pause', () => {
    togglePauseRecording();
    return true;
  });

  // 録音サービスウィンドウから届く録音レベルを各ウィンドウへ中継（約5Hz に間引き済み）
  ipcMain.handle('recording:report-level', (_e, level: number) => {
    broadcast('app-event', { type: 'recording:level', level });
    return true;
  });

  // システム音声のキャプチャ対象（画面全体 / 特定ウィンドウ）を設定
  ipcMain.handle('recording:set-capture-target', (_e, target: { type: 'screen' } | { type: 'window'; sourceId: string }) => {
    captureTarget = target;
    return true;
  });

  // キャプチャ可能なウィンドウ一覧（開始ダイアログのウィンドウ選択用）
  ipcMain.handle('capture:list-windows', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 360, height: 225 },
    });
    return sources
      .filter((s) => s.name && s.name !== 'CallStack')
      .map((s) => ({
        id: s.id,
        name: s.name,
        thumbnail: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
      }));
  });

  // 録音サービスウィンドウが録音状態（録音中/一時停止）を報告 → 全ウィンドウへ配信
  ipcMain.handle('recording:report-state', (_e, recording: boolean, paused: boolean) => {
    lastRecordingState = { recording, paused };
    broadcast('app-event', { type: 'recording:state', recording, paused });
    return true;
  });

  // HUD 等が起動直後に現在の録音状態を取得する
  ipcMain.handle('recording:get-state', () => lastRecordingState);

  // 録音サービスウィンドウからのエラー報告 → メイン窓の表示用に配信
  ipcMain.handle('recording:report-error', (_e, message: string) => {
    logInfo('recorder', `error: ${message}`);
    broadcast('app-event', { type: 'recording:error', message });
    return true;
  });

  // 開始ダイアログで選んだソースを「次の録音1回分」として登録
  ipcMain.handle('recording:set-next-source', (_e, payload: {
    config: RecordingSourceConfig;
    windowId: string | null;
    micDeviceId: string | null;
  } | null) => {
    pendingSourceOverride = payload;
    return true;
  });

  // 録音サービスウィンドウが録音開始時に使う構成を解決する
  // （ダイアログの上書きがあれば消費し、なければ種別ごとの既定値）
  ipcMain.handle('recording:get-start-config', async (_e, kind: RecordKind) => {
    const s = store.getSettings();
    const override = pendingSourceOverride;
    pendingSourceOverride = null;
    const config = override?.config
      ?? (kind === 'meeting' ? s.recording.meetingSource : s.recording.callSource);
    return {
      enabled: s.recording.enabled,
      config,
      windowId: override?.windowId ?? null,
      micDeviceId: override?.micDeviceId ?? s.recording.micDeviceId,
      soundFeedback: s.soundFeedback,
      // ライブ文字起こし用の PCM タップを有効にするか
      live: await isLiveReady(s),
    };
  });

  // ============ ライブ文字起こし（Vosk） ============
  // 現在のウィンドウ名一覧（Teams 検知の調整・診断用）
  ipcMain.handle('teams:list-windows', async (): Promise<string[]> => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
      return sources.map((s) => s.name).filter(Boolean);
    } catch {
      return [];
    }
  });

  ipcMain.handle('vosk:status', async () => ({
    engine: await isVoskEngineInstalled(),
    models: {
      'small-ja': await isVoskModelInstalled('small-ja'),
      ja: await isVoskModelInstalled('ja'),
    } as Record<VoskLiveModel, boolean>,
  }));

  ipcMain.handle('vosk:download', async (_e, what: 'engine' | 'engine-legacy' | VoskLiveModel) => {
    try {
      await downloadVosk(what, (p) => {
        broadcast('app-event', {
          type: 'vosk:download', what, step: p.step,
          receivedBytes: p.receivedBytes, totalBytes: p.totalBytes,
        });
      });
      broadcast('app-event', {
        type: 'vosk:download', what, step: 'done', receivedBytes: 0, totalBytes: null,
      });
      return { ok: true };
    } catch (err) {
      const message = (err as Error).message;
      broadcast('app-event', {
        type: 'vosk:download', what, step: 'error', receivedBytes: 0, totalBytes: null, error: message,
      });
      return { ok: false, error: message };
    }
  });

  // 編集ダイアログ・ライブ字幕ウィンドウが途中から開いたとき、これまでの結果を取得する
  ipcMain.handle('live:get', () => {
    if (!liveSession) return null;
    return { callId: liveSession.callId, segments: liveSession.segments };
  });

  // ライブ字幕ウィンドウの × ボタン: 表示設定を OFF にして閉じる
  ipcMain.handle('live:hide', () => {
    const s = store.getSettings();
    const next = { ...s, hudLiveVisible: false };
    store.setSettings(next);
    hideLiveWindow();
    broadcast('app-event', { type: 'settings:updated', settings: next });
    return true;
  });

  // 録音サービスウィンドウからの 16kHz/mono/Int16 PCM（fire-and-forget で高頻度に届く）
  ipcMain.on('live:pcm', (_e, buf: ArrayBuffer) => {
    const sess = liveSession;
    if (!sess || sess.stopped) return;
    const b = Buffer.from(buf);
    if (!sess.ready) {
      // モデルロード完了までバッファ（8KB×120 ≒ 30秒で頭打ち）
      if (sess.pending.length < 120) sess.pending.push(b);
      return;
    }
    voskFeedPcm(b);
  });

  // 録音ファイル (MP3) を名前を付けて保存
  ipcMain.handle('recording:save-as', async (_e, callId: string): Promise<
    { canceled: true } | { canceled: false; path: string } | { canceled: false; error: string }
  > => {
    const rec = store.getCall(callId);
    if (!rec?.audio) return { canceled: false, error: 'この記録には録音がありません。' };
    const { recordings } = getDirs();
    const src = path.join(recordings, rec.audio.path);
    try {
      await fs.access(src);
    } catch {
      return { canceled: false, error: '録音ファイルが見つかりません（削除済みの可能性があります）。' };
    }
    const filePath = await showSaveDialogRemembered(
      '録音を保存',
      `${exportBaseName(rec)}.mp3`,
      [{ name: 'MP3 音声', extensions: ['mp3'] }],
    );
    if (!filePath) return { canceled: true };
    await fs.copyFile(src, filePath);
    return { canceled: false, path: filePath };
  });

  // 文字起こしをテキストファイルとして保存
  ipcMain.handle('transcript:save-as', async (_e, callId: string, withTimestamps: boolean): Promise<
    { canceled: true } | { canceled: false; path: string } | { canceled: false; error: string }
  > => {
    const rec = store.getCall(callId);
    if (!rec?.transcript) return { canceled: false, error: 'この記録には文字起こしがありません。' };
    const filePath = await showSaveDialogRemembered(
      '文字起こしを保存',
      `${exportBaseName(rec)}${withTimestamps ? '-時刻付き' : ''}.txt`,
      [{ name: 'テキスト', extensions: ['txt'] }],
    );
    if (!filePath) return { canceled: true };
    await fs.writeFile(filePath, buildTranscriptText(rec, withTimestamps), 'utf-8');
    return { canceled: false, path: filePath };
  });

  // 議事録 (Markdown) を保存 — メモ・マーカー・文字起こしをまとめて出力
  ipcMain.handle('minutes:save-as', async (_e, callId: string): Promise<
    { canceled: true } | { canceled: false; path: string } | { canceled: false; error: string }
  > => {
    const rec = store.getCall(callId);
    if (!rec) return { canceled: false, error: '記録が見つかりません。' };
    const filePath = await showSaveDialogRemembered(
      '議事録を保存',
      `議事録-${exportBaseName(rec).replace(/^(会議|通話)-/, '')}.md`,
      [{ name: 'Markdown', extensions: ['md'] }],
    );
    if (!filePath) return { canceled: true };
    await fs.writeFile(filePath, buildMinutesMd(rec), 'utf-8');
    return { canceled: false, path: filePath };
  });

  // ============ Transcription ============
  ipcMain.handle('transcription:start', async (_e, callId: string, model?: WhisperModel) => {
    const rec = store.getCall(callId);
    if (!rec) return { ok: false, error: '通話記録が見つかりません。' };
    if (!rec.audio) return { ok: false, error: 'この通話には録音がありません。' };
    if (rec.deletedAt) return { ok: false, error: 'ゴミ箱の記録は文字起こしできません。' };
    // 二重開始の防止（すでに待機中・実行中なら受け付けない）
    if (isTranscriptionActive(callId) || rec.transcriptStatus === 'queued' || rec.transcriptStatus === 'running') {
      return { ok: false, error: 'この記録の文字起こしはすでに進行中です。' };
    }
    // 押した瞬間に状況が見えるよう、セットアップ確認の前に「待機中」を即時表示する
    setTranscriptStatus(
      callId,
      { transcriptStatus: 'queued', transcriptError: undefined },
      { status: 'queued', queuePosition: transcriptionQueueLength() + 1 },
    );
    const s = store.getSettings();
    // 編集画面でモデルを指定された場合はそれを使う（既定は設定のモデル）
    const useModel = model ?? s.transcription.model;
    const setup = await checkTranscriptionSetup(useModel, s.transcription.useGpu ?? false);
    if (!setup.ok) {
      setTranscriptStatus(callId, { transcriptStatus: 'error', transcriptError: setup.error }, { status: 'error', error: setup.error });
      return setup;
    }
    queueTranscription(callId, useModel);
    return { ok: true };
  });

  ipcMain.handle('transcription:cancel', (_e, callId: string) => {
    return cancelTranscription(callId);
  });

  ipcMain.handle('transcription:check-setup', async () => {
    const s = store.getSettings();
    return checkTranscriptionSetup(s.transcription.model, s.transcription.useGpu ?? false);
  });

  ipcMain.handle('transcription:download-model', async (_e, model: WhisperModel) => {
    try {
      await downloadModel(model, (p) => {
        broadcast('app-event', {
          type: 'model:download',
          model,
          receivedBytes: p.receivedBytes,
          totalBytes: p.totalBytes,
          done: false,
        });
      });
      const s = store.getSettings();
      s.transcription.modelDownloaded = { ...s.transcription.modelDownloaded, [model]: true };
      store.setSettings(s);
      broadcast('app-event', {
        type: 'model:download',
        model,
        receivedBytes: 0,
        totalBytes: null,
        done: true,
      });
      return { ok: true };
    } catch (err) {
      const message = (err as Error).message;
      broadcast('app-event', {
        type: 'model:download',
        model,
        receivedBytes: 0,
        totalBytes: null,
        done: true,
        error: message,
      });
      return { ok: false, error: message };
    }
  });

  ipcMain.handle('transcription:model-status', async (_e, model: WhisperModel) => {
    return { downloaded: await isModelDownloaded(model), path: getModelPath(model) };
  });

  // モデルファイルの削除（ディスク節約）
  ipcMain.handle('transcription:delete-model', async (_e, model: WhisperModel) => {
    try {
      await fs.unlink(getModelPath(model));
      const s = store.getSettings();
      s.transcription.modelDownloaded = { ...s.transcription.modelDownloaded, [model]: false };
      store.setSettings(s);
      logInfo('model', `deleted ${model}`);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // ============ 音声ファイルの取り込み ============
  // 音声ファイルを選択（開始ダイアログの「参照」用）
  ipcMain.handle('audio:pick', async (): Promise<
    { canceled: true } | { canceled: false; path: string; name: string; sizeBytes: number; mtime: string }
  > => {
    const dlg = await dialog.showOpenDialog({
      title: '取り込む音声ファイルを選択',
      filters: [
        { name: '音声ファイル', extensions: ['mp3', 'wav', 'm4a', 'webm', 'ogg', 'aac', 'flac'] },
        { name: 'すべてのファイル', extensions: ['*'] },
      ],
      properties: ['openFile'],
    });
    if (dlg.canceled || dlg.filePaths.length === 0) return { canceled: true };
    const p = dlg.filePaths[0];
    const stat = await fs.stat(p);
    return { canceled: false, path: p, name: path.basename(p), sizeBytes: stat.size, mtime: stat.mtime.toISOString() };
  });

  // 音声ファイルを通話/会議の記録として取り込む（MP3 へ変換して保存し、必要なら文字起こし）
  ipcMain.handle('audio:import', async (_e, opts: {
    filePath: string;
    kind: RecordKind;
    title?: string;
    contactName?: string;
    startTime?: string;      // ISO。省略時はファイルの更新日時
    autoTranscribe: boolean;
  }): Promise<{ ok: true; record: CallRecord } | { ok: false; error: string }> => {
    try {
      const stat = await fs.stat(opts.filePath);
      const s = store.getSettings();
      const id = nanoid();
      const { recordings } = getDirs();
      const rel = `${id}.mp3`;
      const abs = path.join(recordings, rel);

      let durationSec: number;
      if (/\.mp3$/i.test(opts.filePath)) {
        // MP3 はそのままコピーして長さだけ取得（再エンコードによる劣化を避ける）
        durationSec = Math.round(await probeDurationSec(opts.filePath));
        await fs.copyFile(opts.filePath, abs);
      } else {
        const r = await convertWebmToMp3(opts.filePath, abs, s.recording.mp3Bitrate);
        durationSec = Math.round(r.durationSec);
      }
      const outStat = await fs.stat(abs);

      const startTime = opts.startTime ?? stat.mtime.toISOString();
      const endTime = new Date(new Date(startTime).getTime() + durationSec * 1000).toISOString();
      const rec: CallRecord = {
        id,
        kind: opts.kind,
        startTime,
        endTime,
        durationSec,
        tag: null,
        memo: `（音声ファイル取り込み: ${path.basename(opts.filePath)}）`,
        title: opts.kind === 'meeting' ? (opts.title || path.basename(opts.filePath).replace(/\.[^.]+$/, '')) : undefined,
        contactName: opts.kind === 'call' ? (opts.contactName || undefined) : undefined,
        holds: [],
        holdSec: 0,
        audio: { path: rel, format: 'mp3', bytes: outStat.size, durationSec, source: 'mic+system' },
      };
      store.addCall(rec);
      broadcast('app-event', { type: 'call:updated', record: rec });
      logInfo('import', `audio imported ${opts.filePath} -> ${rel} (${durationSec}s)`);
      if (opts.autoTranscribe) {
        const setup = await checkTranscriptionSetup(s.transcription.model, s.transcription.useGpu ?? false);
        if (setup.ok) queueTranscription(id);
        else broadcast('app-event', { type: 'recording:error', message: `文字起こしを開始できません: ${setup.error}` });
      }
      return { ok: true, record: rec };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // ============ whisper.cpp 実行ファイルのダウンロード ============
  ipcMain.handle('whisper:binary-status', async (_e, variant?: 'cpu' | 'gpu') => {
    return { installed: await isBinaryInstalled(variant ?? 'cpu') };
  });

  ipcMain.handle('whisper:download-binary', async (_e, variant?: 'cpu' | 'gpu') => {
    const v = variant ?? 'cpu';
    try {
      await downloadWhisperBinary((p) => {
        broadcast('app-event', {
          type: 'whisperbin:download',
          step: p.step,
          variant: v,
          receivedBytes: p.receivedBytes,
          totalBytes: p.totalBytes,
        });
      }, v);
      broadcast('app-event', {
        type: 'whisperbin:download', step: 'done', variant: v, receivedBytes: 0, totalBytes: null,
      });
      return { ok: true };
    } catch (err) {
      const message = (err as Error).message;
      broadcast('app-event', {
        type: 'whisperbin:download', step: 'error', variant: v, receivedBytes: 0, totalBytes: null, error: message,
      });
      return { ok: false, error: message };
    }
  });

  // ============ Devices ============
  // Renderer enumerates via navigator.mediaDevices, but the main process
  // controls whether the request is allowed via setPermissionRequestHandler.
  ipcMain.handle('retention:run-now', async () => {
    return cleanupExpiredRecordings(store, broadcast);
  });

  // ============ Backup / Restore ============
  ipcMain.handle('backup:create', async () => {
    return store.backupNow('manual');
  });

  // 汎用のフォルダ選択（保存先の固定フォルダなど）
  ipcMain.handle('app:choose-dir', async (_e, title: string): Promise<{ canceled: true } | { canceled: false; dir: string }> => {
    const r = await dialog.showOpenDialog({ title, properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || r.filePaths.length === 0) return { canceled: true };
    return { canceled: false, dir: r.filePaths[0] };
  });

  // 自動バックアップの複製先フォルダを選択（OneDrive 等を指定すれば実質クラウドバックアップになる）
  ipcMain.handle('backup:choose-dir', async (): Promise<{ canceled: true } | { canceled: false; dir: string }> => {
    const r = await dialog.showOpenDialog({
      title: '自動バックアップの複製先フォルダを選択',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || r.filePaths.length === 0) return { canceled: true };
    return { canceled: false, dir: r.filePaths[0] };
  });

  ipcMain.handle('backup:restore', async (): Promise<
    { canceled: true } | { canceled: false; calls: number; backupPath: string }
  > => {
    const result = await dialog.showOpenDialog({
      title: 'バックアップ JSON を選択',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) return { canceled: true };
    const raw = await fs.readFile(result.filePaths[0], 'utf-8');
    const json = JSON.parse(raw);
    const { calls } = await store.restoreFromJson(json);
    const backupPath = path.join(
      app.getPath('userData'),
      'backups',
      `data-${localDate(new Date()).replace(/-/g, '')}-pre-restore.json`,
    );
    broadcast('app-event', { type: 'settings:updated', settings: store.getSettings() });
    broadcast('app-event', { type: 'data:restored' });
    return { canceled: false, calls, backupPath };
  });

  ipcMain.handle('backup:restore-json', async (_e, json: unknown): Promise<{ calls: number; backupPath: string }> => {
    const { calls } = await store.restoreFromJson(json);
    const backupPath = path.join(
      app.getPath('userData'),
      'backups',
      `data-${localDate(new Date()).replace(/-/g, '')}-pre-restore.json`,
    );
    broadcast('app-event', { type: 'settings:updated', settings: store.getSettings() });
    broadcast('app-event', { type: 'data:restored' });
    return { calls, backupPath };
  });
}

function queueTranscription(callId: string, modelOverride?: WhisperModel): void {
  const rec = store.getCall(callId);
  if (!rec || !rec.audio) return;
  if (rec.deletedAt) return;   // ゴミ箱の記録は文字起こししない
  const { recordings } = getDirs();
  const abs = path.join(recordings, rec.audio.path);
  const s = store.getSettings();
  setTranscriptStatus(
    callId,
    { transcriptStatus: 'queued', transcriptError: undefined },
    { status: 'queued', queuePosition: transcriptionQueueLength() + 1 },
  );
  enqueueTranscription(callId, {
    audioPath: abs,
    model: modelOverride ?? s.transcription.model,
    language: s.transcription.language,
    prompt: s.transcription.prompt,
    useGpu: s.transcription.useGpu ?? false,
  });
  updatePowerBlocker();
  // 実行中ジョブがあればその進捗込みで、なければ待機数のみサマリーを更新
  if (jobProgress) broadcastTranscriptionProgress();
  else broadcastTranscriptionIdleSummary();
}

/** 保存ダイアログの既定ファイル名（例: 会議-20260613-1030-定例MTG） */
function exportBaseName(rec: CallRecord): string {
  const d = new Date(rec.startTime);
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  const label = rec.kind === 'meeting' ? '会議' : '通話';
  const name = (rec.kind === 'meeting' ? rec.title : rec.contactName) ?? '';
  const safe = name.replace(/[\\/:*?"<>|\r\n]+/g, '-').trim();
  return safe ? `${label}-${stamp}-${safe}` : `${label}-${stamp}`;
}

function buildTranscriptText(rec: CallRecord, withTimestamps: boolean): string {
  const t = rec.transcript!;
  const isMeeting = rec.kind === 'meeting';
  const lines: string[] = [];
  lines.push(`${isMeeting ? '会議' : '通話'}の文字起こし`);
  if (isMeeting && rec.title) lines.push(`タイトル: ${rec.title}`);
  if (isMeeting && rec.participants?.length) lines.push(`参加者: ${rec.participants.join('、')}`);
  if (!isMeeting && rec.contactName) lines.push(`連絡先: ${rec.contactName}`);
  if (!isMeeting && rec.phoneNumber) lines.push(`電話番号: ${rec.phoneNumber}`);
  lines.push(`日時: ${rec.startTime.slice(0, 16).replace('T', ' ')}`);
  if (rec.durationSec !== null) lines.push(`時間: ${formatHMS(rec.durationSec)}`);
  lines.push(`モデル: ${t.model} / 言語: ${t.language || '自動'}`);
  lines.push('');
  if (withTimestamps && t.segments && t.segments.length > 0) {
    for (const s of t.segments) {
      lines.push(`[${formatHMS(Math.floor(s.start))}] ${s.text}`);
    }
  } else {
    lines.push(t.text);
  }
  lines.push('');
  return lines.join('\r\n');
}

function buildMinutesMd(rec: CallRecord): string {
  const isMeeting = rec.kind === 'meeting';
  const dt = rec.startTime.slice(0, 16).replace('T', ' ');
  const lines: string[] = [];
  lines.push(`# ${isMeeting ? '議事録' : '通話記録'}: ${rec.title || rec.contactName || dt}`);
  lines.push('');
  lines.push(`- 日時: ${dt}`);
  if (rec.durationSec !== null) lines.push(`- 時間: ${formatHMS(rec.durationSec)}`);
  if (isMeeting && rec.participants?.length) lines.push(`- 参加者: ${rec.participants.join('、')}`);
  if (!isMeeting && rec.contactName) lines.push(`- 連絡先: ${rec.contactName}${rec.phoneNumber ? ` (${rec.phoneNumber})` : ''}`);
  { const tg = getRecordTags(rec); if (tg.length) lines.push(`- タグ: ${tg.join('、')}`); }
  lines.push('');
  if (rec.memo) {
    lines.push('## メモ');
    lines.push('');
    lines.push(rec.memo);
    lines.push('');
  }
  if (rec.markers?.length) {
    lines.push('## マーカー');
    lines.push('');
    for (const m of rec.markers) {
      lines.push(`- \`${formatHMS(m.at)}\` ${m.label ?? ''}`.trimEnd());
    }
    lines.push('');
  }
  if (rec.transcript) {
    lines.push('## 文字起こし');
    lines.push('');
    lines.push(`（モデル: ${rec.transcript.model} / 言語: ${rec.transcript.language || '自動'}）`);
    lines.push('');
    const segments = rec.transcript.segments ?? [];
    if (segments.length > 0) {
      for (const s of segments) {
        lines.push(`\`${formatHMS(Math.floor(s.start))}\` ${s.text}`);
      }
    } else {
      lines.push(rec.transcript.text);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * 文字起こしステータスの更新。transcription:status に加えて必ず call:updated も
 * 配信する（一覧・編集ダイアログは記録データの transcriptStatus を表示しているため、
 * これがないと表示が古いまま「開始」も押せてしまう）。
 */
function setTranscriptStatus(
  callId: string,
  patch: Partial<CallRecord>,
  statusEvent: { status: CallRecord['transcriptStatus']; error?: string; queuePosition?: number; transcript?: CallTranscript },
): void {
  const updated = store.updateCall(callId, patch);
  if (!updated) return;
  broadcast('app-event', { type: 'transcription:status', callId, ...statusEvent });
  broadcast('app-event', { type: 'call:updated', record: updated });
}

// ============ 文字起こし進捗マネージャ ============
// whisper の進捗通知は約5%刻みのため、直近の進行速度から1秒ごとに補間して
// 1%単位の進捗と推定残り時間を全ウィンドウへ配信する。
interface JobProgress {
  callId: string;
  stage: 'convert' | 'transcribe';
  startedAt: number;
  lastTickAt: number;
  lastTickPercent: number;
  /** %/秒。2回目の実測値から算出 */
  rate: number | null;
  displayPercent: number;
}
let jobProgress: JobProgress | null = null;
let progressTimer: NodeJS.Timeout | null = null;

function transcriptionWaitingCount(): number {
  return Math.max(0, transcriptionQueueLength() - (jobProgress ? 1 : 0));
}

function jobEtaSec(): number | null {
  if (!jobProgress || !jobProgress.rate || jobProgress.rate <= 0) return null;
  return Math.max(1, Math.round((100 - jobProgress.displayPercent) / jobProgress.rate));
}

function broadcastTranscriptionProgress(): void {
  if (!jobProgress) return;
  broadcast('app-event', {
    type: 'transcription:progress',
    callId: jobProgress.callId,
    stage: jobProgress.stage,
    percent: Math.round(jobProgress.displayPercent),
    etaSec: jobEtaSec(),
  });
  broadcast('app-event', {
    type: 'transcription:summary',
    running: {
      callId: jobProgress.callId,
      percent: Math.round(jobProgress.displayPercent),
      etaSec: jobEtaSec(),
    },
    waiting: transcriptionWaitingCount(),
  });
}

function broadcastTranscriptionIdleSummary(): void {
  broadcast('app-event', {
    type: 'transcription:summary',
    running: null,
    waiting: transcriptionWaitingCount(),
  });
}

function startProgressTicker(): void {
  if (progressTimer) return;
  progressTimer = setInterval(() => {
    if (!jobProgress) return;
    // 実測値の間を速度で補間（次の実測 5% 手前と 99% で頭打ち）
    if (jobProgress.rate && jobProgress.rate > 0) {
      const elapsed = (Date.now() - jobProgress.lastTickAt) / 1000;
      const cap = Math.min(99, jobProgress.lastTickPercent + 4.5);
      jobProgress.displayPercent = Math.min(cap, jobProgress.lastTickPercent + jobProgress.rate * elapsed);
    }
    broadcastTranscriptionProgress();
  }, 1000);
}

function stopProgressTicker(): void {
  if (progressTimer) {
    clearInterval(progressTimer);
    progressTimer = null;
  }
}

function endJobProgress(callId: string): void {
  if (jobProgress?.callId === callId) jobProgress = null;
  if (transcriptionQueueLength() === 0) stopProgressTicker();
  broadcastTranscriptionIdleSummary();
}

function setupTranscriptionHandlers(): void {
  setQueueHandlers({
    onStart: (callId) => {
      setTranscriptStatus(callId, { transcriptStatus: 'running' }, { status: 'running' });
      const now = Date.now();
      jobProgress = {
        callId, stage: 'convert', startedAt: now,
        lastTickAt: now, lastTickPercent: 1, rate: null, displayPercent: 1,
      };
      startProgressTicker();
      broadcastTranscriptionProgress();
    },
    onProgress: (callId, stage, percent) => {
      // 全体進捗: 変換フェーズを 0-2%、whisper 実行を 2-100% に割り当てる
      const overall = stage === 'convert' ? 2 : Math.min(100, 2 + percent * 0.98);
      if (jobProgress?.callId === callId) {
        const now = Date.now();
        const dt = (now - jobProgress.lastTickAt) / 1000;
        if (overall > jobProgress.lastTickPercent && dt > 0.5) {
          jobProgress.rate = (overall - jobProgress.lastTickPercent) / dt;
        }
        jobProgress.stage = stage;
        jobProgress.lastTickAt = now;
        jobProgress.lastTickPercent = overall;
        jobProgress.displayPercent = Math.max(jobProgress.displayPercent, overall);
      }
      broadcastTranscriptionProgress();
    },
    onIdle: () => {
      // キューが空になった最終状態を配信（完了直後の「待機 1 件」残り対策）
      stopProgressTicker();
      jobProgress = null;
      broadcastTranscriptionIdleSummary();
    },
    onCancelled: (callId) => {
      const rec = store.getCall(callId);
      // 過去の文字起こしが残っていれば done、なければ none に戻す
      const status = rec?.transcript ? 'done' : 'none';
      setTranscriptStatus(callId, { transcriptStatus: status, transcriptError: undefined }, { status });
      endJobProgress(callId);
      updatePowerBlocker();
    },
    onDone: (callId, transcript) => {
      // 単語登録（置換辞書）を whisper の確定版にも適用する
      const segments = (transcript.segments ?? []).map((s) => ({ ...s, text: applyTermReplacements(s.text) }));
      const corrected: CallTranscript = {
        ...transcript,
        segments,
        text: segments.length > 0 ? segments.map((s) => s.text).join('\n') : applyTermReplacements(transcript.text),
      };
      setTranscriptStatus(
        callId,
        { transcript: corrected, transcriptStatus: 'done', transcriptError: undefined },
        { status: 'done', transcript: corrected },
      );
      endJobProgress(callId);
      updatePowerBlocker();
    },
    onError: (callId, err) => {
      const message = err instanceof WhisperMissingError
        ? `whisper.cpp の実行ファイルが見つかりません。設定画面の「whisper.cpp をダウンロード」で自動セットアップできます。`
        : err.message;
      setTranscriptStatus(callId, { transcriptStatus: 'error', transcriptError: message }, { status: 'error', error: message });
      endJobProgress(callId);
      updatePowerBlocker();
    },
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
  const totalHold = target.reduce((sum, c) => sum + (c.holdSec ?? 0), 0);
  const avg = target.length ? Math.round(total / target.length) : 0;
  const byTag = new Map<string, { count: number; sec: number }>();
  for (const c of target) {
    const tags = getRecordTags(c);
    const keys = tags.length ? tags : ['（タグなし）'];
    for (const k of keys) {
      const cur = byTag.get(k) ?? { count: 0, sec: 0 };
      cur.count += 1;
      cur.sec += c.durationSec ?? 0;
      byTag.set(k, cur);
    }
  }
  const top3 = [...target].sort((a, b) => (b.durationSec ?? 0) - (a.durationSec ?? 0)).slice(0, 3);

  const fmt = (s: number) => formatHMS(s);
  const lines: string[] = [];
  lines.push(`# 週次レポート ${weekStamp()}`);
  lines.push('');
  lines.push(`期間: ${localDate(monday)} 〜 ${localDate(new Date(sunday.getTime() - 1))}`);
  lines.push('');
  lines.push('## サマリー');
  lines.push(`- 通話数: ${target.length}`);
  lines.push(`- 合計時間: ${fmt(total)}`);
  lines.push(`- 純通話時間: ${fmt(Math.max(0, total - totalHold))}`);
  lines.push(`- 保留合計: ${fmt(totalHold)}`);
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

/**
 * 更新のダウンロード→検証→展開までを行い、準備ができたら通知する。
 * 失敗しても記録・録音には一切影響しない（ログに残すのみ）。
 */
async function prepareUpdateFlow(result: UpdateCheckResult): Promise<void> {
  broadcast('app-event', { type: 'selfupdate:status', status: 'downloading', version: result.latest });
  const ok = await prepareUpdate(result, (s) => {
    broadcast('app-event', {
      type: 'selfupdate:status',
      status: s.status,
      version: result.latest,
      receivedBytes: s.receivedBytes,
      totalBytes: s.totalBytes,
      error: s.error,
    });
  });
  if (ok) {
    notify(
      `アップデート v${result.latest} の準備ができました`,
      'クリックで今すぐ再起動して適用します',
      () => { void applyUpdateNow(); },
    );
  }
}

/**
 * 準備済みの更新を適用する。記録中・録音の保存待ち中は拒否し、
 * データを危険に晒さない（このアプリにおける「未保存の作業」の扱い）。
 */
async function applyUpdateNow(): Promise<{ ok: boolean; error?: string }> {
  if (getActive()) {
    return { ok: false, error: '記録が進行中です。記録を終了してから適用してください。' };
  }
  if (lastRecordingState.recording || finalizingCount > 0) {
    return { ok: false, error: '録音の保存が完了するまでお待ちください。' };
  }
  try {
    await applyPreparedUpdate();
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  logInfo('app', 'applying self-update — quitting');
  markForceQuit();
  app.quit();
  return { ok: true };
}

/**
 * 録音中にウィンドウを閉じようとしたときの保護。
 * 確認のうえ記録を終了し、録音の保存（finalize）を待ってから終了する。
 */
function setupSafeShutdown(): void {
  setBeforeCloseHandler(() => {
    if (shuttingDown) return 'close';
    if (!lastRecordingState.recording && finalizingCount === 0) return 'close';

    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      title: 'CallStack',
      message: '録音中です。記録を終了して録音を保存してから終了しますか？',
      detail: 'このまま終了すると録音が失われる可能性があります。',
      buttons: ['保存して終了', 'キャンセル'],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice === 1) return 'prevent';

    shuttingDown = true;
    logInfo('app', 'safe shutdown: ending call and waiting for finalize');
    void (async () => {
      try {
        await endCall();
        // 録音停止 → finalize 完了を待つ（最大 20 秒）
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
          if (!lastRecordingState.recording && finalizingCount === 0) break;
          await new Promise((r) => setTimeout(r, 200));
        }
        // finalize の IPC が届く前に閉じないよう少しだけ余裕を持たせる
        await new Promise((r) => setTimeout(r, 500));
        await store.flush().catch(() => {});
      } finally {
        logInfo('app', 'safe shutdown: done, quitting');
        markForceQuit();
        app.quit();
      }
    })();
    return 'prevent';
  });
}

/**
 * 前回クラッシュ・強制終了などで残った録音断片 (.webm) を起動時に回収する。
 * 対応する記録があり録音が未保存なら MP3 化して添付、そうでなければ削除する。
 */
async function recoverOrphanRecordings(): Promise<void> {
  const { tmpRecordings, recordings } = getDirs();
  let files: string[] = [];
  try {
    files = await fs.readdir(tmpRecordings);
  } catch {
    return;
  }
  let recovered = 0;
  for (const name of files) {
    if (!name.endsWith('.webm')) continue;
    const callId = name.replace(/\.webm$/, '');
    const tmpPath = path.join(tmpRecordings, name);
    const rec = store.getCall(callId);
    // 進行中の記録の断片には触れない（録音サービスが追記中）
    if (rec && !rec.endTime) continue;
    try {
      if (rec && !rec.audio && rec.endTime) {
        const rel = `${callId}.mp3`;
        const abs = path.join(recordings, rel);
        const { durationSec } = await convertWebmToMp3(tmpPath, abs, store.getSettings().recording.mp3Bitrate);
        const stat = await fs.stat(abs);
        const updated = store.updateCall(callId, {
          audio: { path: rel, format: 'mp3', bytes: stat.size, durationSec: Math.round(durationSec), source: 'mic' },
        });
        if (updated) {
          broadcast('app-event', { type: 'call:updated', record: updated });
          recovered += 1;
          logInfo('recover', `salvaged orphan recording ${name} (${Math.round(durationSec)}s)`);
        }
      }
      await fs.unlink(tmpPath).catch(() => {});
    } catch (err) {
      logInfo('recover', `failed to salvage ${name}: ${(err as Error).message}`);
      await fs.unlink(tmpPath).catch(() => {});
    }
  }
  if (recovered > 0) {
    notify('録音を復元しました', `前回保存されなかった録音 ${recovered} 件を復元しました。`, () => showMainWindow());
  }
}

/** Windows ログイン時の自動起動を設定する */
function applyLaunchAtLogin(enabled: boolean): void {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  app.setLoginItemSettings({ openAtLogin: enabled });
  logInfo('app', `launchAtLogin = ${enabled}`);
}

function setupMediaPermissions(): void {
  // Allow media (microphone) and display capture requests from our windows.
  session.defaultSession.setPermissionRequestHandler((_wc: WebContents, permission, callback) => {
    if (permission === 'media' || permission === 'display-capture') {
      callback(true);
    } else {
      callback(false);
    }
  });
}

function setupDisplayCapture(): void {
  // Required so navigator.mediaDevices.getDisplayMedia({ audio: true }) actually
  // captures the system audio loopback. Without this handler, Chromium on
  // Windows silently drops the audio track and the user sees only the mic.
  type DisplayHandler = (
    req: unknown,
    cb: (streams: { video?: unknown; audio?: 'loopback' | 'loopbackWithMute' }) => void,
  ) => void;
  type SessionWithDisplay = typeof session.defaultSession & {
    setDisplayMediaRequestHandler?: (handler: DisplayHandler, opts?: { useSystemPicker?: boolean }) => void;
  };
  const s = session.defaultSession as SessionWithDisplay;
  if (typeof s.setDisplayMediaRequestHandler !== 'function') return;
  s.setDisplayMediaRequestHandler((_req, callback) => {
    const target = captureTarget;
    if (target.type === 'window') {
      // 指定ウィンドウを対象にする。見つからなければ画面全体へフォールバック。
      // 注: Windows の loopback 音声はシステム全体が対象のため、環境によっては
      // ウィンドウ選択でも全体の音声が録音される。
      desktopCapturer.getSources({ types: ['window', 'screen'] })
        .then((sources) => {
          const win = sources.find((src) => src.id === target.sourceId);
          const screenSrc = sources.find((src) => src.id.startsWith('screen:'));
          callback({ video: win ?? screenSrc, audio: 'loopback' });
        })
        .catch(() => callback({}));
      return;
    }
    desktopCapturer.getSources({ types: ['screen'] })
      .then((sources) => {
        callback({ video: sources[0], audio: 'loopback' });
      })
      .catch(() => callback({}));
  }, { useSystemPicker: false });
}

async function main() {
  // Establish the Windows AppUserModelID and product name BEFORE any window is
  // created, so the taskbar / notifications / jump lists show "CallStack"
  // instead of the generic "Electron".
  app.setName('CallStack');
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.callstack.app');
  }

  // 二重起動の防止。ロックを取得できない＝既に起動中なので、
  // このプロセスは終了し、既存インスタンスを最前面へ出す。
  const gotTheLock = app.requestSingleInstanceLock();
  if (!gotTheLock) {
    logInfo('app', 'another instance is already running — quitting this one');
    // app.quit() は will-quit を発火させ、アプリ準備前に globalShortcut 等へ触れて
    // 例外ダイアログが出てしまう。exit なら後片付けイベントを発火せず即終了できる。
    app.exit(0);
    return;
  }
  app.on('second-instance', () => {
    // 2つ目の起動が試みられた: 既存のメイン窓を復元して最前面に出す
    logInfo('app', 'second instance detected — focusing existing window');
    showMainWindow();
  });

  await app.whenReady();
  await ensureAppDirs();
  await store.init();
  setupIpc();
  setupTranscriptionHandlers();
  setupMediaPermissions();
  setupDisplayCapture();
  registerAppProtocol();

  // ライブ字幕ウィンドウの移動・リサイズを設定に保存する
  setLiveBoundsHandler((bounds) => {
    store.setSettings({ ...store.getSettings(), liveWindowBounds: bounds });
  });

  // Windows のタイトルバーオーバーレイの初期色を、保存済みのテーマ設定から
  // 解決する（createMainWindow() より前に登録し、起動直後から正しい色で
  // 表示されるようにする＝既定色が一瞬見えてから切り替わる状態を避ける）。
  setThemeProvider(() => resolveEffectiveTheme(store.getSettings().theme, nativeTheme.shouldUseDarkColors));

  // Teams 検知が有効なら監視を開始
  if (store.getSettings().teamsDetectEnabled) startTeamsPolling();

  createTray(trayHandlers);
  updateTray({ active: false, today: todayStats() }, trayHandlers);

  reRegisterShortcuts();
  setMinimizeToTray(store.getSettings().minimizeToTray);
  applyLaunchAtLogin(store.getSettings().launchAtLogin);
  setupSafeShutdown();
  createMainWindow();
  createRecorderWindow();
  logInfo('app', `started v${app.getVersion()}`);
  scheduleDailyCleanup(store, broadcast);
  // 前回終了時に保存されなかった録音断片を回収（進行中の記録は除く）
  setTimeout(() => { void recoverOrphanRecordings(); }, 3000);

  // 前回のセッションで待機中・処理中のまま終了した文字起こしを自動再開する
  // （これが無いと記録が「待機中」のまま永久に止まって見える）
  setTimeout(() => {
    const stale = store.getCalls().filter((c) =>
      !c.deletedAt && c.audio && (c.transcriptStatus === 'queued' || c.transcriptStatus === 'running'));
    for (const c of stale) {
      logInfo('transcribe', `requeue stale job ${c.id} (was ${c.transcriptStatus})`);
      queueTranscription(c.id);
    }
  }, 4000);

  // 前回の更新適用で残った .old フォルダがあれば掃除する（失敗しても次回また試みる）
  setTimeout(() => { void cleanupOldInstallDir(); }, 2000);

  // 起動時の更新チェック（既定は通知型。autoUpdateEnabled が ON なら自動で
  // ダウンロード・検証・展開まで済ませ、適用（再起動）だけユーザー操作にする）
  if (store.getSettings().checkUpdatesOnStartup) {
    setTimeout(() => {
      void checkOnStartup().then((r) => {
        if (!r?.hasUpdate) return;
        if (store.getSettings().autoUpdateEnabled && isSelfUpdateSupported()) {
          void prepareUpdateFlow(r);
        } else {
          notify(
            `新しいバージョン v${r.latest} があります`,
            `現在 v${r.current} — クリックでダウンロードページを開く`,
            () => { void shell.openExternal(r.url!); },
          );
        }
      });
    }, 5000);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    } else {
      showMainWindow();
    }
  });

  // Restart tick + HUD if there's a stale active call from previous run
  if (getActive()) {
    createHudWindow(store.getSettings().hudPosition, store.getSettings().hudSize);
    updateTray({ active: true, elapsedSec: 0, today: todayStats() }, trayHandlers);
    startTickLoop();
  }
}

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') {
    // mac: do nothing, keep app alive
  }
});

app.on('will-quit', () => {
  // アプリ準備前（二重起動で即終了する場合など）は初期化していないので後片付け不要。
  // globalShortcut 等を ready 前に触ると例外になるためガードする。
  if (!app.isReady()) return;
  unregisterAll();
  stopTickLoop();
  stopTeamsPolling();
  stopDailyCleanup();
  destroyTray();
  destroyRecorderWindow();
  // 実行中の whisper プロセスを残さない
  shutdownTranscription();
  // Vosk ライブ認識ワーカーも残さない
  shutdownVosk();
  if (powerBlockerId !== null) powerSaveBlocker.stop(powerBlockerId);
});

app.on('before-quit', async () => {
  await store.flush().catch(() => {});
});

main().catch((err) => {
  console.error('[main] fatal:', err);
  app.exit(1);
});
