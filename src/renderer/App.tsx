import { useState, useEffect, useMemo, useRef } from 'react';
import { useCalls } from './hooks/useCalls';
import { useSettings } from './hooks/useSettings';
import { useActiveCall } from './hooks/useActiveCall';
import { useTheme } from './hooks/useTheme';
import { CallListPage } from './pages/CallListPage';
import { StatsPage } from './pages/StatsPage';
import { SettingsPage } from './pages/SettingsPage';
import { formatHMS } from './utils/format';
import { AppEvent, RecordKind, RecordingSourceConfig, Settings } from '../shared/types';
import { LevelMeter } from './recorder/LevelMeter';
import { SummaryFooter } from './components/SummaryFooter';
import { Phone, Users, Bookmark, Play, Pause, Square, Circle, MoreVertical, FileAudio, Plus, Upload, Download, Settings as SettingsIcon, AlertTriangle } from 'lucide-react';
import { ToastProvider, useToast } from './components/Toast';
import { StartRecordDialog, StartMeta } from './components/StartRecordDialog';
import { OnboardingDialog } from './components/OnboardingDialog';
import { toUserMessage } from './utils/errorMessage';

type Page = 'list' | 'trash' | 'stats' | 'settings';

const LAST_KIND_KEY = 'callstack.lastStartKind';

function loadLastKind(): RecordKind {
  return localStorage.getItem(LAST_KIND_KEY) === 'meeting' ? 'meeting' : 'call';
}

export function App() {
  return (
    <ToastProvider>
      <AppContent />
    </ToastProvider>
  );
}

function AppContent() {
  const [page, setPage] = useState<Page>('list');
  const [initialContactFilter, setInitialContactFilter] = useState<string | null>(null);
  const [initialEditId, setInitialEditId] = useState<string | null>(null);
  const [startDialogOpen, setStartDialogOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const { calls, loading, error: callsError, reload: reloadCalls } = useCalls();
  const { settings, save, error: settingsError, reload: reloadSettings } = useSettings();
  const { active, elapsedSec } = useActiveCall();
  const toast = useToast();
  useTheme(settings?.theme);

  // Windows では titleBarStyle:'hidden' + titleBarOverlay でヘッダーが
  // タイトルバーを兼ねる（main/window.ts 参照）。最小化/最大化/閉じるボタンは
  // OS が右端に描画するため、ヘッダー右側の内容と重ならないよう余白を空ける。
  const isWinTitleBarOverlay = useMemo(() => navigator.userAgent.includes('Windows'), []);

  // 録音は専用の不可視ウィンドウで実行される。ここでは状態表示のみを行う。
  const [recState, setRecState] = useState({ recording: false, paused: false });
  const [recLevel, setRecLevel] = useState(0);
  const [recError, setRecError] = useState<string | null>(null);
  const recErrorTimer = useRef<number | null>(null);

  // ゴミ箱の記録は集計から除外する。フッターは通話＋会議の両方を対象にする。
  const callsAlive = useMemo(() => calls.filter((c) => !c.deletedAt), [calls]);
  const isMeeting = active?.kind === 'meeting';

  const navigateToContact = (name: string) => {
    setInitialContactFilter(name);
    setPage('list');
  };

  useEffect(() => {
    window.api.recording.getState().then(setRecState).catch(() => {});
    const off = window.api.onEvent((e: AppEvent) => {
      if (e.type === 'navigate') {
        setPage(e.page);
        return;
      }
      if (e.type === 'edit:record') {
        setPage('list');
        setInitialEditId(e.callId);
        return;
      }
      if (e.type === 'marker:added') {
        toast.info(`マーカーを追加しました（${e.count} 個目 / ${formatHMS(e.marker.at)}）`);
        return;
      }
      if (e.type === 'recording:state') {
        setRecState({ recording: e.recording, paused: e.paused });
        if (!e.recording) setRecLevel(0);
        return;
      }
      if (e.type === 'recording:level') {
        setRecLevel(e.level);
        return;
      }
      if (e.type === 'recording:error') {
        setRecError(e.message);
        if (recErrorTimer.current !== null) window.clearTimeout(recErrorTimer.current);
        recErrorTimer.current = window.setTimeout(() => setRecError(null), 10000);
        return;
      }
    });
    return () => off();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleStartClick = () => {
    if (settings && !settings.recording.askSourceOnStart) {
      // ダイアログを使わない設定なら前回の種別・既定ソースで即開始
      void window.api.calls.startNow(loadLastKind());
      return;
    }
    setStartDialogOpen(true);
  };

  const handleDialogStart = async (
    kind: RecordKind,
    meta: StartMeta,
    config: RecordingSourceConfig | null,
    windowId: string | null,
    micDeviceId: string | null,
    saveAsDefault: boolean,
  ) => {
    setStartDialogOpen(false);
    localStorage.setItem(LAST_KIND_KEY, kind);
    if (config && saveAsDefault && settings) {
      const next = {
        ...settings,
        recording: {
          ...settings.recording,
          micDeviceId,
          ...(kind === 'meeting' ? { meetingSource: config } : { callSource: config }),
        },
      };
      await save(next);
    }
    await window.api.recording.setNextSource(
      config
        ? { config, windowId, micDeviceId }
        : { config: { mic: false, system: false, systemScope: 'screen' }, windowId: null, micDeviceId: null },
    );
    await window.api.calls.startNow(kind, meta);
  };

  const handleAddMarker = () => {
    if (active) void window.api.calls.addMarker(active.id);
  };

  // ︙ メニューは外側クリックで閉じる
  useEffect(() => {
    if (!moreMenuOpen) return;
    const close = () => setMoreMenuOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [moreMenuOpen]);

  /** ︙ メニューの項目: 記録一覧ページ側にアクションを依頼する */
  const dispatchListAction = (action: string) => {
    setMoreMenuOpen(false);
    setPage('list');
    // CallListPage がマウントされてから処理されるよう次フレームで発火
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('callstack:list-action', { detail: action }));
    }, 50);
  };

  // オンボーディングの「設定を開いてセットアップ」
  useEffect(() => {
    const onNav = () => setPage('settings');
    window.addEventListener('callstack:navigate-settings', onNav);
    return () => window.removeEventListener('callstack:navigate-settings', onNav);
  }, []);

  const handleOnboardingFinish = async (patch: Partial<Settings>) => {
    if (!settings) return;
    await save({ ...settings, ...patch });
  };

  if (callsError || settingsError) {
    return (
      <LoadErrorScreen
        error={settingsError ?? callsError}
        onRetry={() => {
          void reloadCalls();
          void reloadSettings();
        }}
      />
    );
  }

  if (loading || !settings) {
    return (
      <div className="flex h-full items-center justify-center text-slate-500 dark:text-slate-400">
        読み込み中…
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-slate-50 dark:bg-slate-950">
      <header
        className={`app-titlebar flex h-[52px] flex-none items-center justify-between gap-2 border-b border-slate-200 bg-white pl-6 shadow-sm dark:border-slate-800 dark:bg-slate-900 ${
          isWinTitleBarOverlay ? 'pr-[150px]' : 'pr-6'
        }`}
      >
        <nav className="app-titlebar-no-drag flex shrink-0 gap-1">
          <TabButton active={page === 'list'} onClick={() => setPage('list')}>記録</TabButton>
          <TabButton active={page === 'stats'} onClick={() => setPage('stats')}>統計</TabButton>
          <TabButton active={page === 'trash'} onClick={() => setPage('trash')}>ゴミ箱</TabButton>
        </nav>
        <div className="app-titlebar-no-drag flex min-w-0 flex-1 flex-nowrap items-center justify-end gap-1 sm:gap-1.5 md:gap-2">
          {active ? (
            <span
              className={`flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-sm font-semibold ring-1 sm:px-3 ${
                isMeeting
                  ? 'bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-950 dark:text-violet-300 dark:ring-violet-900'
                  : 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-900'
              }`}
            >
              <span className={`inline-block h-2 w-2 animate-pulse rounded-full ${isMeeting ? 'bg-violet-500' : 'bg-emerald-500'}`} />
              {isMeeting ? <Users size={14} /> : <Phone size={14} />}
              <span className="hidden md:inline">{isMeeting ? '会議中' : '通話中'}</span>
              <span className="font-mono tabular-nums">{formatHMS(elapsedSec)}</span>
            </span>
          ) : (
            <span className="hidden shrink-0 rounded-full bg-slate-100 px-3 py-1 text-sm text-slate-600 dark:bg-slate-800 dark:text-slate-300 sm:inline-block">
              待機中
            </span>
          )}
          {recState.recording && (
            <span className={`flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-xs font-semibold ring-1 sm:px-3 ${
              recState.paused
                ? 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-900'
                : 'bg-red-50 text-red-700 ring-red-200 dark:bg-red-950 dark:text-red-300 dark:ring-red-900'
            }`}>
              <span className={`inline-block h-2 w-2 rounded-full ${recState.paused ? 'bg-amber-500' : 'animate-pulse bg-red-500'}`} />
              <span className="hidden md:inline">{recState.paused ? '一時停止中' : 'REC'}</span>
              {!recState.paused && <span className="hidden md:inline-flex"><LevelMeter level={recLevel} /></span>}
              <button
                onClick={() => window.api.recording.togglePause()}
                className="rounded px-1 hover:bg-black/10 dark:hover:bg-white/10"
                title={recState.paused ? `録音を再開 (${settings.shortcuts.togglePauseRecording})` : `録音を一時停止 (${settings.shortcuts.togglePauseRecording})`}
              >
                {recState.paused ? <Play size={12} /> : <Pause size={12} />}
              </button>
            </span>
          )}
          {recError && (
            <button
              onClick={() => setRecError(null)}
              className="max-w-[6rem] shrink truncate rounded-full bg-amber-50 px-2 py-1 text-xs text-amber-800 ring-1 ring-amber-200 hover:bg-amber-100 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-900 dark:hover:bg-amber-900 sm:max-w-[9rem] sm:px-3 lg:max-w-[14rem]"
              title={`${toUserMessage(recError)}\n(クリックで閉じる)`}
            >
              <span className="hidden lg:inline">録音エラー: </span>{toUserMessage(recError)}
            </button>
          )}
          {active ? (
            <>
              <button
                onClick={handleAddMarker}
                className="shrink-0 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700 sm:px-3"
                title="現在時刻にマーカーを打つ（あとで該当箇所へジャンプできます）"
              >
                <Bookmark size={14} className="inline align-[-2px] lg:mr-1" /><span className="hidden lg:inline">マーカー</span>
              </button>
              <button
                onClick={() => window.api.calls.endNow()}
                className="shrink-0 whitespace-nowrap rounded-md bg-red-500 px-2 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-red-600 sm:px-3"
              >
                <Square size={12} fill="currentColor" className="mr-1 inline align-[-1px]" />終了<span className="hidden lg:inline"> ({settings.shortcuts.endCall})</span>
              </button>
            </>
          ) : (
            <button
              onClick={handleStartClick}
              className="shrink-0 whitespace-nowrap rounded-md bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-brand-700 sm:px-4"
              title={`記録・録音を開始（ダイアログで通話/会議を選択）\nショートカット即開始: 通話 ${settings.shortcuts.startCall} / 会議 ${settings.shortcuts.startMeeting}`}
            >
              <Circle size={11} fill="#f87171" stroke="none" className="mr-1.5 inline align-[-1px]" />録音
            </button>
          )}
          <div className="relative shrink-0">
            <button
              onClick={(e) => { e.stopPropagation(); setMoreMenuOpen((v) => !v); }}
              onMouseDown={(e) => e.stopPropagation()}
              className="rounded-md border border-slate-300 bg-white p-1.5 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
              title="その他の操作"
            >
              <MoreVertical size={16} />
            </button>
            {moreMenuOpen && (
              <div
                className="absolute right-0 top-full z-[80] mt-1 w-52 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-xl dark:border-slate-700 dark:bg-slate-800"
                onMouseDown={(e) => e.stopPropagation()}
              >
                {([
                  { action: 'audio-import', icon: <FileAudio size={14} />, label: '音声を取り込み…' },
                  { action: 'manual-add', icon: <Plus size={14} />, label: '手動追加' },
                  { action: 'csv-import', icon: <Upload size={14} />, label: 'CSV インポート…' },
                  { action: 'csv-export', icon: <Download size={14} />, label: 'CSV エクスポート…' },
                ] as const).map((item) => (
                  <button
                    key={item.action}
                    onClick={() => dispatchListAction(item.action)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-700"
                  >
                    <span className="text-slate-400">{item.icon}</span>
                    {item.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={() => setPage('settings')}
            className={`shrink-0 rounded-md border p-1.5 transition ${
              page === 'settings'
                ? 'border-brand-500 bg-brand-50 text-brand-700 dark:border-brand-500 dark:bg-brand-950 dark:text-brand-300'
                : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'
            }`}
            title="設定"
          >
            <SettingsIcon size={16} />
          </button>
        </div>
      </header>

      <main className="flex-1 overflow-auto">
        {page === 'list' && (
          <CallListPage
            calls={calls}
            settings={settings}
            initialContactFilter={initialContactFilter}
            onConsumeInitialFilter={() => setInitialContactFilter(null)}
            initialEditId={initialEditId}
            onConsumeInitialEditId={() => setInitialEditId(null)}
          />
        )}
        {page === 'trash' && (
          <CallListPage calls={calls} settings={settings} mode="trash" />
        )}
        {page === 'stats' && (
          <StatsPage calls={callsAlive} settings={settings} onSelectContact={navigateToContact} />
        )}
        {page === 'settings' && <SettingsPage settings={settings} onSave={save} />}
      </main>
      <SummaryFooter calls={callsAlive} />

      {startDialogOpen && settings && (
        <StartRecordDialog
          initialKind={loadLastKind()}
          settings={settings}
          calls={callsAlive}
          onCancel={() => setStartDialogOpen(false)}
          onStart={(kind, meta, config, windowId, micDeviceId, saveAsDefault) =>
            void handleDialogStart(kind, meta, config, windowId, micDeviceId, saveAsDefault)}
        />
      )}

      {!settings.onboardingDone && (
        <OnboardingDialog settings={settings} onFinish={(p) => void handleOnboardingFinish(p)} />
      )}
    </div>
  );
}

/** 初回のデータ読み込みに失敗した場合の案内画面 */
function LoadErrorScreen({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-slate-50 px-6 text-center dark:bg-slate-950">
      <AlertTriangle size={28} className="text-red-500" />
      <div className="text-base font-semibold text-slate-800 dark:text-slate-100">データを読み込めませんでした</div>
      <div className="max-w-md text-sm text-slate-500 dark:text-slate-400">{toUserMessage(error)}</div>
      <button
        onClick={onRetry}
        className="mt-2 rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-brand-700"
      >
        再試行
      </button>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
        active
          ? 'bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-200'
          : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
      }`}
    >
      {children}
    </button>
  );
}
