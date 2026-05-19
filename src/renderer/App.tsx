import { useState, useEffect, useRef } from 'react';
import { useCalls } from './hooks/useCalls';
import { useSettings } from './hooks/useSettings';
import { useActiveCall } from './hooks/useActiveCall';
import { CallListPage } from './pages/CallListPage';
import { StatsPage } from './pages/StatsPage';
import { SettingsPage } from './pages/SettingsPage';
import { formatHMS } from './utils/format';
import { beep } from './utils/beep';
import { AppEvent } from '../shared/types';

type Page = 'list' | 'stats' | 'settings';

export function App() {
  const [page, setPage] = useState<Page>('list');
  const [initialContactFilter, setInitialContactFilter] = useState<string | null>(null);
  const { calls, loading } = useCalls();
  const { settings, save } = useSettings();
  const { active, elapsedSec } = useActiveCall();

  const navigateToContact = (name: string) => {
    setInitialContactFilter(name);
    setPage('list');
  };

  const soundOn = useRef(true);
  soundOn.current = settings?.soundFeedback ?? true;
  useEffect(() => {
    const off = window.api.onEvent((e: AppEvent) => {
      if (!soundOn.current) return;
      if (e.type === 'call:started') beep('start');
      if (e.type === 'call:ended') beep('end');
    });
    return () => off();
  }, []);

  if (loading || !settings) {
    return <div className="flex h-full items-center justify-center text-slate-500">読み込み中…</div>;
  }

  return (
    <div className="flex h-full flex-col bg-slate-50">
      <header className="flex items-center justify-between border-b bg-white px-6 py-3 shadow-sm">
        <div className="flex items-center gap-4">
          <h1 className="text-lg font-bold tracking-tight text-slate-900">📞 TelTimeStack</h1>
          <nav className="flex gap-1">
            <TabButton active={page === 'list'} onClick={() => setPage('list')}>記録</TabButton>
            <TabButton active={page === 'stats'} onClick={() => setPage('stats')}>統計</TabButton>
            <TabButton active={page === 'settings'} onClick={() => setPage('settings')}>設定</TabButton>
          </nav>
        </div>
        <div className="flex items-center gap-3">
          {active ? (
            <span className="flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1 text-sm font-semibold text-emerald-700 ring-1 ring-emerald-200">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
              通話中 <span className="font-mono tabular-nums">{formatHMS(elapsedSec)}</span>
            </span>
          ) : (
            <span className="rounded-full bg-slate-100 px-3 py-1 text-sm text-slate-600">待機中</span>
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
        active ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-100'
      }`}
    >
      {children}
    </button>
  );
}
