import { useEffect, useMemo, useRef, useState } from 'react';
import { useActiveCall } from './hooks/useActiveCall';
import { formatHMS } from './utils/format';
import { AppEvent, Settings, CallRecord } from '../shared/types';

/** HUD 内蔵の小型レベルメータ（recording:level イベント駆動） */
function MiniLevel({ level, segments = 10 }: { level: number; segments?: number }) {
  const filled = Math.round(level * segments);
  return (
    <div className="flex items-end gap-px" title="録音レベル">
      {Array.from({ length: segments }).map((_, i) => {
        const active = i < filled;
        const color = i < segments * 0.6 ? 'bg-emerald-400' : i < segments * 0.85 ? 'bg-amber-400' : 'bg-red-500';
        return (
          <div
            key={i}
            className={`w-0.5 rounded-sm ${active ? color : 'bg-white/15'}`}
            style={{ height: `${4 + i * 1.2}px` }}
          />
        );
      })}
    </div>
  );
}

export function HudApp() {
  const { active, elapsedSec, holding, holdSec } = useActiveCall();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [activeRecord, setActiveRecord] = useState<CallRecord | null>(null);
  const [recState, setRecState] = useState({ recording: false, paused: false });
  const [level, setLevel] = useState(0);
  const [markerCount, setMarkerCount] = useState(0);
  const [markerFlash, setMarkerFlash] = useState(false);
  const [memoOpen, setMemoOpen] = useState(false);
  const [memoDraft, setMemoDraft] = useState('');
  const [hovered, setHovered] = useState(false);
  const memoTimer = useRef<number | null>(null);
  const flashTimer = useRef<number | null>(null);

  useEffect(() => {
    window.api.settings.get().then(setSettings);
    window.api.recording.getState().then(setRecState).catch(() => {});
    window.api.calls.getActive().then((r) => {
      setActiveRecord(r);
      setMemoDraft(r?.memo ?? '');
      setMarkerCount(r?.markers?.length ?? 0);
    });
    const off = window.api.onEvent((e: AppEvent) => {
      if (e.type === 'settings:updated') setSettings(e.settings);
      if (e.type === 'recording:state') {
        setRecState({ recording: e.recording, paused: e.paused });
        if (!e.recording) setLevel(0);
      }
      if (e.type === 'recording:level') setLevel(e.level);
      if (e.type === 'marker:added') {
        setMarkerCount(e.count);
        setMarkerFlash(true);
        if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
        flashTimer.current = window.setTimeout(() => setMarkerFlash(false), 1200);
      }
      if (e.type === 'call:started') {
        setLevel(0);
        setMarkerCount(e.record.markers?.length ?? 0);
      }
      if (
        (e.type === 'call:started' || e.type === 'call:updated' || e.type === 'call:ended') &&
        e.record
      ) {
        setActiveRecord(e.record.endTime ? null : e.record);
        if (e.type === 'call:started') setMemoDraft(e.record.memo ?? '');
        if (e.type === 'call:updated' && !e.record.endTime) setMarkerCount(e.record.markers?.length ?? 0);
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

  const recording = recState.recording;
  const paused = recState.paused;
  const isMeeting = activeRecord?.kind === 'meeting';
  const size = settings?.hudSize ?? 'compact';
  // カーソルを乗せている間は透明度を解除して操作しやすくする
  const opacity = hovered ? 1.0 : Math.min(1, Math.max(0.3, settings?.hudOpacity ?? 1.0));

  const containerStyle = useMemo(() => {
    const isBlack = settings?.theme === 'black';
    const bgRgb = isBlack ? '0, 0, 0' : '15, 23, 42';
    return {
      background: `rgba(${bgRgb}, ${opacity * 0.95})`,
      transition: 'background 0.15s ease',
    };
  }, [settings?.theme, opacity]);

  /** 表示名: 会議はタイトル、通話は連絡先（未設定なら空） */
  const displayName = isMeeting
    ? (activeRecord?.title || '会議')
    : (activeRecord?.contactName || '');

  const handleEnd = () => { void window.api.hud.end(); };
  const handleOpenMain = () => { void window.api.hud.openMain(); };
  const handleToggleHold = () => { void window.api.calls.toggleHold(); };
  const handleTogglePause = () => { void window.api.recording.togglePause(); };
  const handleMarker = () => {
    if (activeRecord) void window.api.calls.addMarker(activeRecord.id);
  };
  const handleCycleSize = () => { void window.api.hud.cycleSize(); };
  const handleOpenEdit = () => {
    if (activeRecord) void window.api.hud.openEdit(activeRecord.id);
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

  const hoverProps = {
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => setHovered(false),
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
        {...hoverProps}
        className="hud-drag h-full w-full rounded-2xl px-4 py-3 text-slate-100 shadow-2xl ring-1 ring-white/10"
        style={containerStyle}
      >
        <div className="text-xs opacity-70">記録なし</div>
      </div>
    );
  }

  const statusLabel = holding
    ? <span className="font-semibold text-amber-400">⏸ 保留 {formatHMS(holdSec)}</span>
    : (
      <span className={`font-semibold ${isMeeting ? 'text-violet-300' : 'text-emerald-400'}`}>
        ● {isMeeting ? '会議中' : '通話中'}
      </span>
    );

  const recBadge = recording && (
    paused
      ? <span className="rounded bg-amber-500/20 px-1 py-px font-semibold text-amber-400">⏸ PAUSE</span>
      : <span className="rounded bg-red-500/20 px-1 py-px font-semibold text-red-400 animate-pulse">● REC</span>
  );

  const btnBase = 'hud-no-drag rounded-md px-2 py-0.5 text-[10px] font-semibold transition';
  const btnGhost = `${btnBase} bg-slate-700/80 text-slate-100 hover:bg-slate-600`;

  const markerButton = (compact = false) => (
    <button
      onClick={handleMarker}
      className={`${btnBase} ${markerFlash ? 'bg-brand-500 text-white' : 'bg-slate-700/80 text-slate-100 hover:bg-slate-600'}`}
      title="マーカーを打つ（あとで該当箇所へジャンプできます）"
    >
      🔖{markerCount > 0 ? ` ${markerCount}` : compact ? '' : ' マーカー'}
    </button>
  );

  const pauseButton = recording ? (
    <button
      onClick={handleTogglePause}
      className={`${btnBase} ${paused ? 'bg-amber-500 text-white hover:bg-amber-600' : 'bg-slate-700/80 text-slate-100 hover:bg-slate-600'}`}
      title={paused ? '録音を再開' : '録音を一時停止'}
    >
      {paused ? '▶ 再開' : '⏸'}
    </button>
  ) : null;

  const holdButton = !isMeeting ? (
    <button
      onClick={handleToggleHold}
      className={`${btnBase} ${holding ? 'bg-amber-500 text-white hover:bg-amber-600' : 'bg-slate-700/80 text-slate-100 hover:bg-slate-600'}`}
      title="保留トグル"
    >
      {holding ? '解除' : '保留'}
    </button>
  ) : null;

  const memoButton = (
    <button
      onClick={handleOpenMemo}
      className={`${btnBase} ${memoOpen ? 'bg-brand-500 text-white' : 'bg-slate-700/80 text-slate-100 hover:bg-slate-600'}`}
      title="メモを編集（自動保存）"
    >
      メモ
    </button>
  );

  const endButton = (
    <button
      onClick={handleEnd}
      className={`${btnBase} bg-red-500 text-white hover:bg-red-600`}
      title="記録を終了"
    >
      終了
    </button>
  );

  const sizeButton = (
    <button
      onClick={handleCycleSize}
      className="hud-no-drag rounded p-0.5 text-slate-400 transition hover:bg-white/10 hover:text-slate-100"
      title="サイズ切替 (mini / compact / full)"
    >
      <svg viewBox="0 0 20 20" width="13" height="13" fill="currentColor"><path d="M3 3h6v2H5v4H3V3zm14 0v6h-2V5h-4V3h6zM3 17v-6h2v4h4v2H3zm14 0h-6v-2h4v-4h2v6z"/></svg>
    </button>
  );

  const editButton = (
    <button
      onClick={handleOpenEdit}
      className={btnGhost}
      title={`${isMeeting ? '会議' : '通話'}記録の編集を開く（メイン窓が前面に出ます）`}
    >
      ✏️ 編集
    </button>
  );

  // ============ mini (200×32) ============
  if (size === 'mini') {
    return (
      <div {...hoverProps} className="flex h-full w-full flex-col">
        <div
          className="hud-drag flex h-8 w-full flex-none select-none items-center gap-1.5 rounded-xl px-2 text-slate-100 shadow-2xl ring-1 ring-white/10"
          style={containerStyle}
          onDoubleClick={handleOpenMain}
          title={`${isMeeting ? '会議中' : '通話中'}${displayName ? ` — ${displayName}` : ''}\nダブルクリックでメイン窓`}
        >
          <span className={`text-[10px] ${recording && !paused ? 'animate-pulse text-red-400' : holding || paused ? 'text-amber-400' : isMeeting ? 'text-violet-300' : 'text-emerald-400'}`}>●</span>
          <div className="font-mono text-sm font-semibold tabular-nums">{formatHMS(elapsedSec)}</div>
          <div className="min-w-0 flex-1 truncate text-[9px] text-slate-400">{displayName}</div>
          <button
            onClick={handleMarker}
            className={`hud-no-drag rounded px-1 py-0.5 text-[10px] ${markerFlash ? 'bg-brand-500 text-white' : 'text-slate-300 hover:bg-white/10'}`}
            title="マーカーを打つ"
          >
            🔖
          </button>
          <button
            onClick={handleOpenMemo}
            className={`hud-no-drag rounded px-1 py-0.5 text-[10px] ${memoOpen ? 'bg-brand-500 text-white' : 'text-slate-300 hover:bg-white/10'}`}
            title="メモを編集"
          >
            📝
          </button>
          {sizeButton}
          <button
            onClick={handleEnd}
            className="hud-no-drag rounded-md bg-red-500 px-1.5 py-0.5 text-[10px] font-semibold text-white hover:bg-red-600"
            title="記録を終了"
          >
            ✕
          </button>
        </div>
        {memoBox}
      </div>
    );
  }

  // ============ compact (330×64) ============
  if (size === 'compact') {
    return (
      <div {...hoverProps} className="flex h-full w-full flex-col">
        <div
          className="hud-drag h-16 w-full flex-none select-none rounded-xl px-3 py-1.5 text-slate-100 shadow-2xl ring-1 ring-white/10"
          style={containerStyle}
          onDoubleClick={handleOpenMain}
          title="ダブルクリックでメイン窓を開く"
        >
          <div className="flex items-center gap-2 text-[10px]">
            {statusLabel}
            <span className="min-w-0 flex-1 truncate text-slate-300">{displayName}</span>
            {recBadge}
            {recording && !paused && <MiniLevel level={level} />}
            {sizeButton}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5">
            <div className="font-mono text-lg font-bold leading-none tabular-nums">{formatHMS(elapsedSec)}</div>
            <div className="hud-no-drag ml-auto flex items-center gap-1">
              {markerButton(true)}
              {pauseButton}
              {holdButton}
              {editButton}
              {memoButton}
              {endButton}
            </div>
          </div>
        </div>
        {memoBox}
      </div>
    );
  }

  // ============ full (400×118) ============
  return (
    <div {...hoverProps} className="flex h-full w-full flex-col">
      <div
        className="hud-drag w-full flex-none select-none rounded-2xl px-4 py-2.5 text-slate-100 shadow-2xl ring-1 ring-white/10"
        style={{ ...containerStyle, height: 118 }}
        onDoubleClick={handleOpenMain}
        title="ダブルクリックでメイン窓を開く"
      >
        <div className="flex items-center gap-2 text-[11px]">
          {statusLabel}
          <span className="min-w-0 flex-1 truncate text-slate-300">{displayName}</span>
          {recBadge}
          {recording && !paused && <MiniLevel level={level} segments={14} />}
          {sizeButton}
        </div>
        <div className="mt-1 flex items-center gap-2">
          <div className="font-mono text-3xl font-bold leading-none tabular-nums">{formatHMS(elapsedSec)}</div>
          {holding && (
            <span className="text-[10px] text-amber-400">保留 {formatHMS(holdSec)}</span>
          )}
        </div>
        <div className="hud-no-drag mt-1.5 flex items-center gap-1.5">
          {markerButton()}
          {pauseButton}
          {holdButton}
          {editButton}
          {memoButton}
          <div className="flex-1" />
          {endButton}
        </div>
      </div>
      {memoBox}
    </div>
  );
}
