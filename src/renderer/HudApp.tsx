import { useEffect, useState } from 'react';
import { useActiveCall } from './hooks/useActiveCall';
import { formatHMS } from './utils/format';
import { AppEvent, Settings } from '../shared/types';

export function HudApp() {
  const { active, elapsedSec, holding, holdSec } = useActiveCall();
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    window.api.settings.get().then(setSettings);
    const off = window.api.onEvent((e: AppEvent) => {
      if (e.type === 'settings:updated') setSettings(e.settings);
    });
    return () => off();
  }, []);

  const recording = !!(active && settings?.recording.enabled);

  const handleEnd = async () => {
    await window.api.hud.end();
  };
  const handleOpenMain = () => {
    window.api.hud.openMain();
  };
  const handleToggleHold = () => {
    window.api.calls.toggleHold();
  };

  if (!active) {
    return (
      <div className="hud-drag h-full w-full rounded-2xl bg-slate-900/90 px-4 py-3 text-slate-100 shadow-2xl">
        <div className="text-xs opacity-70">通話なし</div>
      </div>
    );
  }

  return (
    <div
      className="hud-drag h-full w-full select-none rounded-2xl bg-slate-900/95 px-4 py-2 text-slate-100 shadow-2xl ring-1 ring-white/10"
      onDoubleClick={handleOpenMain}
      title="ダブルクリックでメイン窓を開く"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider">
            {holding ? (
              <span className="text-amber-400">⏸ HOLD {formatHMS(holdSec)}</span>
            ) : (
              <span className="text-emerald-400">● 通話中</span>
            )}
            {recording && <span className="text-red-400">● REC</span>}
          </div>
          <div className="flex items-center gap-2">
            <div className="font-mono text-2xl font-bold tabular-nums">{formatHMS(elapsedSec)}</div>
          </div>
        </div>
        <div className="hud-no-drag flex flex-col gap-1">
          <button
            onClick={handleEnd}
            className="rounded-lg bg-red-500 px-3 py-1 text-xs font-semibold text-white shadow hover:bg-red-600"
          >
            終了
          </button>
          <button
            onClick={handleToggleHold}
            className={`rounded-lg px-3 py-1 text-xs ${holding ? 'bg-amber-500 text-white hover:bg-amber-600' : 'bg-slate-700 text-slate-100 hover:bg-slate-600'}`}
          >
            {holding ? '解除' : '保留'}
          </button>
          <button
            onClick={handleOpenMain}
            className="rounded-lg bg-slate-700 px-3 py-1 text-xs text-slate-100 hover:bg-slate-600"
          >
            メモ
          </button>
        </div>
      </div>
    </div>
  );
}
