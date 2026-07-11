import { useEffect, useMemo, useRef, useState } from 'react';
import { useActiveCall } from './hooks/useActiveCall';
import { formatHMS } from './utils/format';
import { AppEvent, Settings, CallRecord } from '../shared/types';

export function HudApp() {
  const { active, elapsedSec, holding, holdSec } = useActiveCall();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [activeRecord, setActiveRecord] = useState<CallRecord | null>(null);
  const [paused, setPaused] = useState(false);
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
      if (e.type === 'recording:paused') setPaused(e.paused);
      if (e.type === 'call:started') setPaused(false);
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
  const isMeeting = activeRecord?.kind === 'meeting';
  const size = settings?.hudSize ?? 'compact';
  const opacity = settings?.hudOpacity ?? 1.0;

  const containerStyle = useMemo(() => {
    const isBlack = settings?.theme === 'black';
    const bgRgb = isBlack ? '0, 0, 0' : '15, 23, 42';
    return { background: `rgba(${bgRgb}, ${opacity * 0.95})` };
  }, [settings?.theme, opacity]);

  const handleEnd = () => { void window.api.hud.end(); };
  const handleOpenMain = () => { void window.api.hud.openMain(); };
  const handleToggleHold = () => { void window.api.calls.toggleHold(); };
  const handleTogglePause = () => { void window.api.recording.togglePause(); };
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
  const memoBox = memoOpen ? (
    <div className="hud-no-drag mt-1 flex-1 min-h-0 rounded-lg bg-slate-900/95 p-2 shadow-2xl ring-1 ring-white/15">
      <textarea
        autoFocus
        value={memoDraft}
        onChange={(e) => handleMemoChange(e.target.value)}
        onKeyDown={handleMemoKey}
        placeholder="メモを入力 (自動保存 / Esc で閉じる)"
        className="h-full w-full resize-none rounded bg-slate-800 px-2 py-1 text-xs text-slate-100 placeholder-slate-500 outline-none ring-1 ring-slate-700 focus:ring-brand-500"
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
    : <span className="text-emerald-400">● {isMeeting ? '会議中' : '通話中'}</span>;

  const recIndicator = recording && (
    paused
      ? <span className="text-amber-400">⏸ PAUSE</span>
      : <span className="text-red-400">● REC</span>
  );

  const pauseButton = recording ? (
    <button
      onClick={handleTogglePause}
      className={`rounded-md px-2 py-0.5 text-[10px] font-semibold ${paused ? 'bg-amber-500 text-white' : 'bg-slate-700 text-slate-100 hover:bg-slate-600'}`}
      title={paused ? '録音を再開' : '録音を一時停止'}
    >
      {paused ? '再開' : '⏸'}
    </button>
  ) : null;

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
      <div className="flex h-full w-full flex-col">
        <div
          className="hud-drag flex h-8 w-full flex-none select-none items-center gap-2 rounded-xl px-2 text-slate-100 shadow-2xl ring-1 ring-white/10"
          style={containerStyle}
          onDoubleClick={handleOpenMain}
          title="ダブルクリックでメイン窓 / 右上アイコンでサイズ切替"
        >
          <span className={`text-[10px] ${recording && !paused ? 'text-red-400' : holding || paused ? 'text-amber-400' : 'text-emerald-400'}`}>●</span>
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
        </div>
        {memoBox}
      </div>
    );
  }

  if (size === 'compact') {
    return (
      <div className="flex h-full w-full flex-col">
        <div
          className="hud-drag h-14 w-full flex-none select-none rounded-xl px-3 py-1.5 text-slate-100 shadow-2xl ring-1 ring-white/10"
          style={containerStyle}
          onDoubleClick={handleOpenMain}
          title="ダブルクリックでメイン窓を開く"
        >
          <div className="flex items-center gap-2">
            <div className="flex flex-col leading-tight">
              <div className="flex items-center gap-1 text-[9px] uppercase tracking-wider">
                {status}
                {recIndicator}
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
              {!isMeeting && (
                <button
                  onClick={handleToggleHold}
                  className={`rounded-md px-2 py-0.5 text-[10px] font-semibold ${holding ? 'bg-amber-500 text-white' : 'bg-slate-700 text-slate-100 hover:bg-slate-600'}`}
                  title="保留トグル"
                >
                  {holding ? '解除' : '保留'}
                </button>
              )}
              {isMeeting && pauseButton}
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
        </div>
        {memoBox}
      </div>
    );
  }

  // full
  return (
    <div className="flex h-full w-full flex-col">
      <div
        className="hud-drag h-24 w-full flex-none select-none rounded-2xl px-4 py-2 text-slate-100 shadow-2xl ring-1 ring-white/10"
        style={containerStyle}
        onDoubleClick={handleOpenMain}
        title="ダブルクリックでメイン窓を開く"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider">
              {status}
              {recIndicator}
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
            {isMeeting ? (
              recording && (
                <button
                  onClick={handleTogglePause}
                  className={`rounded-lg px-3 py-1 text-xs ${paused ? 'bg-amber-500 text-white hover:bg-amber-600' : 'bg-slate-700 text-slate-100 hover:bg-slate-600'}`}
                >
                  {paused ? '再開' : '一時停止'}
                </button>
              )
            ) : (
              <button
                onClick={handleToggleHold}
                className={`rounded-lg px-3 py-1 text-xs ${holding ? 'bg-amber-500 text-white hover:bg-amber-600' : 'bg-slate-700 text-slate-100 hover:bg-slate-600'}`}
              >
                {holding ? '解除' : '保留'}
              </button>
            )}
            <button
              onClick={handleOpenMemo}
              className={`rounded-lg px-3 py-1 text-xs ${memoOpen ? 'bg-brand-500 text-white' : 'bg-slate-700 text-slate-100 hover:bg-slate-600'}`}
              title="クリックでメモ入力 (ダブルクリックでメイン窓)"
            >
              メモ
            </button>
          </div>
        </div>
      </div>
      {memoBox}
    </div>
  );
}
