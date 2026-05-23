import { useState, useEffect, useRef } from 'react';
import { useCalls } from './hooks/useCalls';
import { useSettings } from './hooks/useSettings';
import { useActiveCall } from './hooks/useActiveCall';
import { useTheme } from './hooks/useTheme';
import { CallListPage } from './pages/CallListPage';
import { StatsPage } from './pages/StatsPage';
import { SettingsPage } from './pages/SettingsPage';
import { formatHMS } from './utils/format';
import { beep } from './utils/beep';
import { AppEvent } from '../shared/types';
import { useRecorder } from './recorder/useRecorder';
import { LevelMeter } from './recorder/LevelMeter';
import { SummaryFooter } from './components/SummaryFooter';

type Page = 'list' | 'stats' | 'settings';

export function App() {
  const [page, setPage] = useState<Page>('list');
  const [initialContactFilter, setInitialContactFilter] = useState<string | null>(null);
  const { calls, loading } = useCalls();
  const { settings, save } = useSettings();
  const { active, elapsedSec } = useActiveCall();
  const recorder = useRecorder(active, settings);
  useTheme(settings?.theme);

  const navigateToContact = (name: string) => {
    setInitialContactFilter(name);
    setPage('list');
  };

  const soundOn = useRef(true);
  soundOn.current = settings?.soundFeedback ?? true;
  useEffect(() => {
    const off = window.api.onEvent((e: AppEvent) => {
      if (e.type === 'navigate') {
        setPage(e.page);
        return;
      }
      if (!soundOn.current) return;
      if (e.type === 'call:started') beep('start');
      if (e.type === 'call:ended') beep('end');
    });
    return () => off();
  }, []);

  if (loading || !settings) {
    return (
      <div className="flex h-full items-center justify-center text-slate-500 dark:text-slate-400">
        読み込み中…
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-slate-50 dark:bg-slate-950">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <nav className="flex gap-1">
          <TabButton active={page === 'list'} onClick={() => setPage('list')}>記録</TabButton>
          <TabButton active={page === 'stats'} onClick={() => setPage('stats')}>統計</TabButton>
          <TabButton active={page === 'settings'} onClick={() => setPage('settings')}>設定</TabButton>
        </nav>
        <div className="flex items-center gap-3">
          {active ? (
            <span className="flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1 text-sm font-semibold text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-900">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
              通話中 <span className="font-mono tabular-nums">{formatHMS(elapsedSec)}</span>
            </span>
          ) : (
            <span className="rounded-full bg-slate-100 px-3 py-1 text-sm text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              待機中
            </span>
          )}
          {recorder.recording && (
            <span className="flex items-center gap-2 rounded-full bg-red-50 px-3 py-1 text-xs font-semibold text-red-700 ring-1 ring-red-200 dark:bg-red-950 dark:text-red-300 dark:ring-red-900">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-red-500" />
              REC
              <LevelMeter level={recorder.level} />
            </span>
          )}
          {recorder.error && (
            <button
              onClick={recorder.clearError}
              className="max-w-[14rem] truncate rounded-full bg-amber-50 px-3 py-1 text-xs text-amber-800 ring-1 ring-amber-200 hover:bg-amber-100 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-900 dark:hover:bg-amber-900"
              title={`${recorder.error}\n(クリックで閉じる)`}
            >
              録音エラー: {recorder.error} ✕
            </button>
          )}
          {active ? (
            <button
              onClick={() => window.api.calls.endNow()}
              className="rounded-md bg-red-500 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-red-600"
            >
              終了 ({settings.shortcuts.endCall})
            </button>
          ) : (
            <button
              onClick={() => window.api.calls.startNow()}
              className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-brand-700"
            >
              開始 ({settings.shortcuts.startCall})
            </button>
          )}
        </div>
      </header>

      <main className="flex-1 overflow-auto">
        {page === 'list' && (
          <CallListPage
            calls={calls}
            settings={settings}
            initialContactFilter={initialContactFilter}
            onConsumeInitialFilter={() => setInitialContactFilter(null)}
          />
        )}
        {page === 'stats' && (
          <StatsPage calls={calls} settings={settings} onSelectContact={navigateToContact} />
        )}
        {page === 'settings' && <SettingsPage settings={settings} onSave={save} />}
      </main>
      <SummaryFooter calls={calls} />
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
