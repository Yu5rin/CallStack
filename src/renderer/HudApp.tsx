import { useEffect, useMemo, useRef, useState } from 'react';
import { useActiveCall } from './hooks/useActiveCall';
import { formatHMS } from './utils/format';
import { AppEvent, Settings, CallRecord } from '../shared/types';

export function HudApp() {
  const { active, elapsedSec, holding, holdSec } = useActiveCall();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [activeRecord, setActiveRecord] = useState<CallRecord | null>(null);
  const [memoOpen, setMemoOpen] = useState(false);
  const [memoDraft, setMemoDraft] = useState('');
  const memoTimer = useRef<number | null>(null);

  useEffect(() => {
    window.api.settings.get().then(setSettings);
    window.api.calls.getActive().then((r) => {
      setActiveRecord(r);
      setMemoDraft(r?.memo ?? '');
    });
    const off = window.api.onEvent((e: AppEvent) => {
      if (e.type === 'settings:updated') setSettings(e.settings);
      if (
        (e.type === 'call:started' || e.type === 'call:updated' || e.type === 'call:ended') &&
        e.record
      ) {
        setActiveRecord(e.record.endTime ? null : e.record);
        if (e.type === 'call:started') setMemoDraft(e.record.memo ?? '');
      }
    });
    return () => off();
  }, []);

  // Close the memo overlay when the call ends.
  useEffect(() => {
    if (!active) {
      setMemoOpen(false);
      if (memoTimer.current !== null) {
        window.clearTimeout(memoTimer.current);
        memoTimer.current = null;
      }
    }
  }, [active]);

  // Grow / shrink the HUD window so the textarea overlay is visible.
  useEffect(() => {
    void window.api.hud.setExtraHeight(memoOpen ? 92 : 0);
  }, [memoOpen]);

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
  const handleOpenMemo = () => setMemoOpen((v) => !v);
  const handleMemoChange = (text: string) => {
    setMemoDraft(text);
    if (!activeRecord) return;
    const id = activeRecord.id;
    if (memoTimer.current !== null) window.clearTimeout(memoTimer.current);
    // Debounce so we do not spam the IPC layer on every keystroke.
    memoTimer.current = window.setTimeout(() => {
      void window.api.calls.update(id, { memo: text });
      memoTimer.current = null;
    }, 400);
  };
  const handleMemoKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setMemoOpen(false);
    }
  };
  const memoOverlay = memoOpen ? (
    <div className="hud-no-drag absolute inset-x-1 top-full z-10 mt-1 rounded-lg bg-slate-900/95 p-2 shadow-2xl ring-1 ring-white/15">
      <textarea
        autoFocus
        value={memoDraft}
        onChange={(e) => handleMemoChange(e.target.value)}
        onKeyDown={handleMemoKey}
        rows={3}
        placeholder="メモを入力 (自動保存 / Esc で閉じる)"
        className="w-full resize-none rounded bg-slate-800 px-2 py-1 text-xs text-slate-100 placeholder-slate-500 outline-none ring-1 ring-slate-700 focus:ring-brand-500"
      />
    </div>
  ) : null;

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
        className="hud-drag relative flex h-full w-full select-none items-center gap-2 rounded-xl px-2 text-slate-100 shadow-2xl ring-1 ring-white/10"
        style={containerStyle}
        onDoubleClick={handleOpenMain}
        title="ダブルクリックでメイン窓 / 右上アイコンでサイズ切替"
      >
        <span className={`text-[10px] ${recording ? 'text-red-400' : holding ? 'text-amber-400' : 'text-emerald-400'}`}>●</span>
        <div className="font-mono text-sm font-semibold tabular-nums">{formatHMS(elapsedSec)}</div>
        <div className="flex-1" />
        <button
          onClick={handleOpenMemo}
          className={`hud-no-drag rounded px-1.5 py-0.5 text-[10px] ${memoOpen ? 'bg-brand-500 text-white' : 'text-slate-300 hover:bg-white/10'}`}
          title="メモを編集"
        >
          📝
        </button>
        {sizeButton}
        <button
          onClick={handleEnd}
          className="hud-no-drag rounded-md bg-red-500 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-red-600"
          title="通話を終了"
        >
          ✕
        </button>
        {memoOverlay}
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
              onClick={handleOpenMemo}
              className={`rounded-md px-2 py-0.5 text-[10px] font-semibold ${memoOpen ? 'bg-brand-500 text-white' : 'bg-slate-700 text-slate-100 hover:bg-slate-600'}`}
              title="メモを編集"
            >
              メモ
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
        {memoOverlay}
      </div>
    );
  }

  // full
  return (
    <div
      className="hud-drag relative h-full w-full select-none rounded-2xl px-4 py-2 text-slate-100 shadow-2xl ring-1 ring-white/10"
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
            onClick={handleOpenMemo}
            className={`rounded-lg px-3 py-1 text-xs ${memoOpen ? 'bg-brand-500 text-white' : 'bg-slate-700 text-slate-100 hover:bg-slate-600'}`}
            title="クリックでメモ入力 (ダブルクリックでメイン窓)"
          >
            メモ
          </button>
        </div>
      </div>
      {memoOverlay}
    </div>
  );
}
