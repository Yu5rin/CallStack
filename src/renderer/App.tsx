import { useState, useEffect, useMemo, useRef } from 'react';
import { useCalls } from './hooks/useCalls';
import { useSettings } from './hooks/useSettings';
import { useActiveCall } from './hooks/useActiveCall';
import { useTheme } from './hooks/useTheme';
import { CallListPage } from './pages/CallListPage';
import { StatsPage } from './pages/StatsPage';
import { SettingsPage } from './pages/SettingsPage';
import { AppEvent, RecordKind, RecordingSourceConfig, Settings } from '../shared/types';
import { LiveStrip } from './components/LiveStrip';
import { formatHMS } from './utils/format';
import {
  Phone, Users, ChevronDown, MoreVertical, FileAudio, Plus, Upload, Download,
  Settings as SettingsIcon, AlertTriangle, Circle,
} from 'lucide-react';
import { ToastProvider, useToast } from './components/Toast';
import { StartRecordDialog, StartMeta } from './components/StartRecordDialog';
import { OnboardingDialog } from './components/OnboardingDialog';
import { toUserMessage } from './utils/errorMessage';

type Page = 'list' | 'stats' | 'settings';

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
  const [startMenuOpen, setStartMenuOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const { calls, loading, error: callsError, reload: reloadCalls } = useCalls();
  const { settings, save, error: settingsError, reload: reloadSettings } = useSettings();
  const { active, elapsedSec, holding, holdSec } = useActiveCall();
  const toast = useToast();
  useTheme(settings?.theme);

  // Windows では titleBarStyle:'hidden' + titleBarOverlay でタイトルバーを兼ねる
  // （main/window.ts 参照）。最小化/最大化/閉じるボタンは OS が右端に描画するため、
  // タイトルバー右側の内容と重ならないよう余白を空ける。
  const isWinTitleBarOverlay = useMemo(() => navigator.userAgent.includes('Windows'), []);

  // 録音は専用の不可視ウィンドウで実行される。ここでは状態表示のみを行う。
  const [recState, setRecState] = useState({ recording: false, paused: false });
  const [recLevel, setRecLevel] = useState(0);
  const [recError, setRecError] = useState<string | null>(null);
  const recErrorTimer = useRef<number | null>(null);

  // ゴミ箱の記録は集計から除外する。統計画面はこの一覧を対象にする。
  const callsAlive = useMemo(() => calls.filter((c) => !c.deletedAt), [calls]);

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

  /** 直近に使った種別で、既定の録音ソース設定のまま即座に記録を開始する（ショートカットと同じ挙動）。 */
  const startImmediately = (kind: RecordKind) => {
    localStorage.setItem(LAST_KIND_KEY, kind);
    setStartMenuOpen(false);
    void window.api.calls.startNow(kind);
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

  // ︙ メニュー・記録メニューは外側クリックで閉じる
  useEffect(() => {
    if (!moreMenuOpen && !startMenuOpen) return;
    const close = () => { setMoreMenuOpen(false); setStartMenuOpen(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [moreMenuOpen, startMenuOpen]);

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
      <div className="flex h-full items-center justify-center text-ink-mute">
        読み込み中…
      </div>
    );
  }

  const captionReserve = isWinTitleBarOverlay ? 'pr-[150px]' : 'pr-2';

  return (
    <div className="flex h-full flex-col bg-paper">
      {/* タイトルバー（40px。Windows では titleBarOverlay と重なるため右側に余白を確保する） */}
      <header
        className={`app-titlebar flex h-10 flex-none items-center gap-3 border-b border-rule bg-chrome pl-3 ${captionReserve}`}
      >
        <span className="app-titlebar-no-drag flex shrink-0 items-center gap-2">
          <span className="flex h-[18px] w-[18px] shrink-0 flex-col items-center justify-center gap-[2.5px] rounded-[5px] bg-accent">
            <span className="block h-[1.5px] w-2.5 rounded-full bg-on-accent" />
            <span className="block h-[1.5px] w-2.5 rounded-full bg-on-accent" />
          </span>
          <span className="text-[13px] font-medium text-ink">CallStack</span>
        </span>

        <nav className="app-titlebar-no-drag ml-1 flex h-full items-stretch" aria-label="画面切り替え">
          <TitleTab active={page === 'list'} onClick={() => setPage('list')}>記録</TitleTab>
          <TitleTab active={page === 'stats'} onClick={() => setPage('stats')}>統計</TitleTab>
        </nav>

        <div className="flex-1" />

        <div className="app-titlebar-no-drag flex shrink-0 items-center gap-1.5">
          {!active && (
            <div className="relative flex items-center">
              <button
                onClick={() => startImmediately(loadLastKind())}
                className="flex h-7 items-center gap-1.5 whitespace-nowrap rounded-l-md bg-accent px-3 text-[13px] font-medium text-on-accent hover:brightness-105"
                title={`記録を開始（前回: ${loadLastKind() === 'meeting' ? '会議' : '通話'} / 既定の録音ソースで即開始）`}
              >
                <Circle size={9} fill="currentColor" stroke="none" />
                記録を開始
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); setStartMenuOpen((v) => !v); }}
                onMouseDown={(e) => e.stopPropagation()}
                className="flex h-7 items-center rounded-r-md border-l border-on-accent/30 bg-accent px-1.5 text-on-accent hover:brightness-105"
                aria-haspopup="true"
                aria-expanded={startMenuOpen}
                aria-label="記録の開始方法を選ぶ"
              >
                <ChevronDown size={13} />
              </button>
              {startMenuOpen && (
                <div
                  className="absolute right-0 top-full z-[80] mt-1.5 w-64 overflow-hidden rounded-lg border border-rule bg-surface p-1.5 shadow-lg"
                  onMouseDown={(e) => e.stopPropagation()}
                  role="menu"
                >
                  <button
                    onClick={() => startImmediately('call')}
                    className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm text-ink hover:bg-accent-soft"
                    role="menuitem"
                  >
                    <span className="inline-flex items-center gap-2"><Phone size={15} className="text-ink-mute" />通話を開始</span>
                    <span className="font-mono text-[11px] text-ink-mute">{settings.shortcuts.startCall}</span>
                  </button>
                  <button
                    onClick={() => startImmediately('meeting')}
                    className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm text-ink hover:bg-accent-soft"
                    role="menuitem"
                  >
                    <span className="inline-flex items-center gap-2"><Users size={15} className="text-ink-mute" />会議を開始</span>
                    <span className="font-mono text-[11px] text-ink-mute">{settings.shortcuts.startMeeting}</span>
                  </button>
                  <div className="my-1 h-px bg-rule" />
                  <button
                    onClick={() => { setStartMenuOpen(false); setStartDialogOpen(true); }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-ink hover:bg-accent-soft"
                    role="menuitem"
                  >
                    録音ソースを選んで開始…
                  </button>
                </div>
              )}
            </div>
          )}
          <div className="relative shrink-0">
            <button
              onClick={(e) => { e.stopPropagation(); setMoreMenuOpen((v) => !v); }}
              onMouseDown={(e) => e.stopPropagation()}
              className="flex h-7 w-7 items-center justify-center rounded-md text-ink-mute hover:bg-accent-soft hover:text-ink"
              title="その他の操作"
            >
              <MoreVertical size={16} />
            </button>
            {moreMenuOpen && (
              <div
                className="absolute right-0 top-full z-[80] mt-1.5 w-52 overflow-hidden rounded-lg border border-rule bg-surface py-1 shadow-lg"
                onMouseDown={(e) => e.stopPropagation()}
              >
                {([
                  { action: 'audio-import', icon: <FileAudio size={16} />, label: '音声の取り込み…' },
                  { action: 'manual-add', icon: <Plus size={16} />, label: '手動で追加' },
                  { action: 'csv-import', icon: <Upload size={16} />, label: 'CSV インポート…' },
                  { action: 'csv-export', icon: <Download size={16} />, label: 'CSV エクスポート…' },
                ] as const).map((item) => (
                  <button
                    key={item.action}
                    onClick={() => dispatchListAction(item.action)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-ink hover:bg-accent-soft"
                  >
                    <span className="text-ink-mute">{item.icon}</span>
                    {item.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={() => setPage('settings')}
            className={`flex h-7 w-7 items-center justify-center rounded-md ${
              page === 'settings' ? 'bg-accent-soft text-accent-ink' : 'text-ink-mute hover:bg-accent-soft hover:text-ink'
            }`}
            title="設定"
          >
            <SettingsIcon size={16} />
          </button>
        </div>
      </header>

      {active && (
        <LiveStrip
          active={active}
          elapsedSec={elapsedSec}
          holding={holding}
          holdSec={holdSec}
          recording={recState.recording}
          paused={recState.paused}
          level={recLevel}
          error={recError}
          onDismissError={() => setRecError(null)}
          onAddMarker={handleAddMarker}
          onTogglePauseRecording={() => window.api.recording.togglePause()}
          onToggleHold={() => window.api.calls.toggleHold()}
          onEnd={() => window.api.calls.endNow()}
          shortcuts={settings.shortcuts}
        />
      )}

      <main className={`flex-1 ${page === 'list' ? 'overflow-hidden' : 'overflow-auto'}`}>
        {page === 'list' && (
          <CallListPage
            calls={calls}
            settings={settings}
            onSaveSettings={save}
            initialContactFilter={initialContactFilter}
            onConsumeInitialFilter={() => setInitialContactFilter(null)}
            initialEditId={initialEditId}
            onConsumeInitialEditId={() => setInitialEditId(null)}
          />
        )}
        {page === 'stats' && (
          <StatsPage calls={callsAlive} settings={settings} onSelectContact={navigateToContact} />
        )}
        {page === 'settings' && <SettingsPage settings={settings} onSave={save} />}
      </main>

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
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-paper px-6 text-center">
      <AlertTriangle size={28} className="text-danger" />
      <div className="text-base font-medium text-ink">データを読み込めませんでした</div>
      <div className="max-w-md text-sm text-ink-mute">{toUserMessage(error)}</div>
      <button
        onClick={onRetry}
        className="mt-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-on-accent hover:bg-accent/90"
      >
        再試行
      </button>
    </div>
  );
}

function TitleTab({
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
      className={`flex items-center border-b-2 px-3 text-[13px] font-medium transition ${
        active ? 'border-accent text-ink' : 'border-transparent text-ink-mute hover:text-ink'
      }`}
    >
      {children}
    </button>
  );
}
