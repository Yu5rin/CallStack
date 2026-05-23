import { useEffect, useMemo, useState } from 'react';
import { useActiveCall } from './hooks/useActiveCall';
import { formatHMS } from './utils/format';
import { AppEvent, Settings, CallRecord } from '../shared/types';

export function HudApp() {
  const { active, elapsedSec, holding, holdSec } = useActiveCall();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [activeRecord, setActiveRecord] = useState<CallRecord | null>(null);

  useEffect(() => {
    window.api.settings.get().then(setSettings);
    window.api.calls.getActive().then(setActiveRecord);
    const off = window.api.onEvent((e: AppEvent) => {
      if (e.type === 'settings:updated') setSettings(e.settings);
      if (
        (e.type === 'call:started' || e.type === 'call:updated' || e.type === 'call:ended') &&
        e.record
      ) {
        setActiveRecord(e.record.endTime ? null : e.record);
      }
    });
    return () => off();
  }, []);

  const recording = !!(active && settings?.recording.enabled);
  const size = settings?.hudSize ?? 'compact';
  const opacity = settings?.hudOpacity ?? 1.0;

  const containerStyle = useMemo(
    () => ({ background: `rgba(15, 23, 42, ${opacity * 0.95})` }),
    [opacity],
  );

  const handleEnd = () => { void window.api.hud.end(); };
  const handleOpenMain = () => { void window.api.hud.openMain(); };
  const handleToggleHold = () => { void window.api.calls.toggleHold(); };
  const handleCycleSize = () => { void window.api.hud.cycleSize(); };
  const handleAssignTag = (tag: string) => {
    const currentTag = activeRecord?.tag;
    void window.api.hud.assignTag(currentTag === tag ? null : tag);
  };

  if (!active) {
    return (
      <div
        className="hud-drag h-full w-full rounded-2xl px-4 py-3 text-slate-100 shadow-2xl"
        style={containerStyle}
      >
        <div className="text-xs opacity-70">通話なし</div>
      </div>
    );
  }

  const status = holding
    ? <span className="text-amber-400">⏸ HOLD {formatHMS(holdSec)}</span>
    : <span className="text-emerald-400">● 通話中</span>;

  const sizeButton = (
    <button
      onClick={handleCycleSize}
      className="hud-no-drag rounded p-0.5 text-slate-400 hover:bg-white/10 hover:text-slate-100"
      title="サイズ切替 (mini / compact / full)"
    >
      <svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor"><path d="M3 3h6v2H5v4H3V3zm14 0v6h-2V5h-4V3h6zM3 17v-6h2v4h4v2H3zm14 0h-6v-2h4v-4h2v6z"/></svg>
    </button>
  );

  if (size === 'mini') {
    return (
      <div
        className="hud-drag flex h-full w-full select-none items-center gap-2 rounded-xl px-2 text-slate-100 shadow-2xl ring-1 ring-white/10"
        style={containerStyle}
        onDoubleClick={handleOpenMain}
        title="ダブルクリックでメイン窓 / 右上アイコンでサイズ切替"
      >
        <span className={`text-[10px] ${recording ? 'text-red-400' : holding ? 'text-amber-400' : 'text-emerald-400'}`}>●</span>
        <div className="font-mono text-sm font-semibold tabular-nums">{formatHMS(elapsedSec)}</div>
        <div className="flex-1" />
        {sizeButton}
        <button
          onClick={handleEnd}
          className="hud-no-drag rounded-md bg-red-500 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-red-600"
          title="通話を終了"
        >
          ✕
        </button>
      </div>
    );
  }

  if (size === 'compact') {
    return (
      <div
        className="hud-drag relative h-full w-full select-none rounded-xl px-3 py-1.5 text-slate-100 shadow-2xl ring-1 ring-white/10"
        style={containerStyle}
        onDoubleClick={handleOpenMain}
        title="ダブルクリックでメイン窓を開く"
      >
        <div className="flex items-center gap-2">
          <div className="flex flex-col leading-tight">
            <div className="flex items-center gap-1 text-[9px] uppercase tracking-wider">
              {status}
              {recording && <span className="text-red-400">● REC</span>}
            </div>
            <div className="font-mono text-base font-bold tabular-nums">{formatHMS(elapsedSec)}</div>
          </div>
          <div className="hud-no-drag ml-auto flex items-center gap-1">
            {settings?.tags.slice(0, 3).map((t) => (
              <button
                key={t.name}
                onClick={() => handleAssignTag(t.name)}
                className={`h-5 w-5 rounded-full ring-1 transition ${
                  activeRecord?.tag === t.name ? 'ring-white' : 'ring-white/30 hover:ring-white/70'
                }`}
                style={{ backgroundColor: t.color }}
                title={`タグ: ${t.name}${activeRecord?.tag === t.name ? '（解除）' : ''}`}
              />
            ))}
            <button
              onClick={handleToggleHold}
              className={`rounded-md px-2 py-0.5 text-[10px] font-semibold ${holding ? 'bg-amber-500 text-white' : 'bg-slate-700 text-slate-100 hover:bg-slate-600'}`}
              title="保留トグル"
            >
              {holding ? '解除' : '保留'}
            </button>
            <button
              onClick={handleEnd}
              className="rounded-md bg-red-500 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-red-600"
              title="通話を終了"
            >
              終了
            </button>
            {sizeButton}
          </div>
        </div>
      </div>
    );
  }

  // full
  return (
    <div
      className="hud-drag h-full w-full select-none rounded-2xl px-4 py-2 text-slate-100 shadow-2xl ring-1 ring-white/10"
      style={containerStyle}
      onDoubleClick={handleOpenMain}
      title="ダブルクリックでメイン窓を開く"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider">
            {status}
            {recording && <span className="text-red-400">● REC</span>}
            <div className="ml-auto flex items-center gap-1">
              {settings?.tags.slice(0, 4).map((t) => (
                <button
                  key={t.name}
                  onClick={() => handleAssignTag(t.name)}
                  className={`h-4 w-4 rounded-full ring-1 transition ${
                    activeRecord?.tag === t.name ? 'ring-white' : 'ring-white/30 hover:ring-white/70'
                  }`}
                  style={{ backgroundColor: t.color }}
                  title={`タグ: ${t.name}`}
                />
              ))}
              {sizeButton}
            </div>
          </div>
          <div className="font-mono text-2xl font-bold tabular-nums">{formatHMS(elapsedSec)}</div>
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
