import { useEffect, useMemo, useRef, useState } from 'react';
import { AudioLines, Bookmark, Pause, Play, Pencil, StickyNote, X, Square } from 'lucide-react';
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
  // ライブ文字起こし: 確定した行を蓄積（末尾が最新）＋ 認識途中の1行
  const [liveLines, setLiveLines] = useState<string[]>([]);
  const [livePartial, setLivePartial] = useState('');
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
      // drag 領域では DOM の mouseenter が発火しないため、main からのカーソル監視で判定
      if (e.type === 'hud:hover') setHovered(e.hovered);
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
      // ライブ文字起こし: final で行を確定して蓄積、partial は認識途中の1行を差し替え。
      // 表示は直近 N 行だけに絞るため、蓄積は上限を設けて古い行を捨てる。
      if (e.type === 'live:segment') {
        if (e.final) {
          if (e.text) setLiveLines((prev) => [...prev, e.text].slice(-30));
          setLivePartial('');
        } else {
          setLivePartial(e.text);
        }
      }
      if (e.type === 'call:started') {
        setLevel(0);
        setLiveLines([]);
        setLivePartial('');
        setActiveRecord(e.record);
        setMemoDraft(e.record.memo ?? '');
        setMarkerCount(e.record.markers?.length ?? 0);
      }
      if (e.type === 'call:ended') {
        setActiveRecord(null);
        setLiveLines([]);
        setLivePartial('');
      }
      if (e.type === 'call:updated') {
        // 進行中の記録に対する更新のみ反映する。
        // （終了済みの別記録の更新（文字起こし完了など）で activeRecord を消さない）
        setActiveRecord((prev) => {
          if (!prev || e.record.id !== prev.id) return prev;
          if (e.record.endTime) return null;
          setMarkerCount(e.record.markers?.length ?? 0);
          return e.record;
        });
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

  // 設定行数に収まる直近のライブ字幕（確定行＋認識途中の行）。少ないほど新しい行が優先される。
  const maxLiveLines = settings?.hudLiveLines ?? 2;
  const liveItems = useMemo(() => {
    if (maxLiveLines <= 0) return [] as Array<{ text: string; partial: boolean }>;
    const items = liveLines.map((t) => ({ text: t, partial: false }));
    if (livePartial) items.push({ text: livePartial, partial: true });
    return items.filter((x) => x.text).slice(-maxLiveLines);
  }, [liveLines, livePartial, maxLiveLines]);
  const hasLive = liveItems.length > 0;

  // Grow / shrink the HUD window so the textarea / live caption overlay is visible.
  // ライブ字幕は 1 行あたり約 15px ＋ 枠の余白。
  const liveExtra = hasLive ? liveItems.length * 15 + 12 : 0;
  useEffect(() => {
    void window.api.hud.setExtraHeight((memoOpen ? 92 : 0) + liveExtra);
  }, [memoOpen, liveExtra]);

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
    // activeRecord が未取得でも main 側で進行中の記録に打てる
    void window.api.calls.addMarker(activeRecord?.id);
  };
  const handleOpenEdit = () => {
    // activeRecord 未取得でも main 側が進行中の記録を解決する
    void window.api.hud.openEdit(activeRecord?.id);
  };
  const handleCycleSize = () => { void window.api.hud.cycleSize(); };
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

  // ライブ文字起こし（Vosk の暫定テキスト）。設定した行数ぶんを縦に並べ、
  // 最新行を下に表示。収まらない古い行は自動的に押し出される。
  const liveBox = hasLive && active ? (
    <div className="hud-no-drag mt-1 flex flex-none flex-col justify-end gap-px rounded-lg bg-slate-900/95 px-2 py-1 shadow-2xl ring-1 ring-white/15">
      {liveItems.map((item, i) => {
        const isLast = i === liveItems.length - 1;
        return (
          <div key={i} className="flex items-center gap-1.5" title={item.text}>
            {isLast
              ? <AudioLines size={10} strokeWidth={2.25} className="flex-none text-sky-300" />
              : <span className="w-2.5 flex-none" />}
            <span className={`min-w-0 flex-1 truncate text-[10px] leading-none ${item.partial ? 'text-slate-400 italic' : 'text-slate-200'}`}>
              {item.text}
            </span>
          </div>
        );
      })}
    </div>
  ) : null;

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
        className="hud-drag h-full w-full rounded-2xl px-4 py-3 text-slate-100 shadow-2xl ring-1 ring-white/10"
        style={containerStyle}
      >
        <div className="text-xs opacity-70">記録なし</div>
      </div>
    );
  }

  const statusLabel = holding
    ? <span className="inline-flex items-center gap-1 font-semibold text-amber-400"><Pause size={10} strokeWidth={2.5} /> 保留 {formatHMS(holdSec)}</span>
    : (
      <span className={`inline-flex items-center gap-1 font-semibold ${isMeeting ? 'text-violet-300' : 'text-emerald-400'}`}>
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${isMeeting ? 'bg-violet-400' : 'bg-emerald-400'}`} />
        {isMeeting ? '会議中' : '通話中'}
      </span>
    );

  const recBadge = recording && (
    paused
      ? <span className="inline-flex items-center gap-1 rounded bg-amber-500/20 px-1 py-px font-semibold text-amber-400"><Pause size={9} strokeWidth={2.5} /> PAUSE</span>
      : <span className="inline-flex items-center gap-1 rounded bg-red-500/20 px-1 py-px font-semibold text-red-400"><span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-red-500" /> REC</span>
  );

  const btnBase = 'hud-no-drag inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-semibold transition';
  const btnGhost = `${btnBase} bg-slate-700/80 text-slate-100 hover:bg-slate-600`;

  const markerButton = (compact = false) => (
    <button
      onClick={handleMarker}
      className={`${btnBase} ${markerFlash ? 'bg-brand-500 text-white' : 'bg-slate-700/80 text-slate-100 hover:bg-slate-600'}`}
      title="マーカーを打つ（あとで該当箇所へジャンプできます）"
    >
      <Bookmark size={11} strokeWidth={2.25} />
      {markerCount > 0 ? `${markerCount}` : compact ? '' : 'マーカー'}
    </button>
  );

  const pauseButton = recording ? (
    <button
      onClick={handleTogglePause}
      className={`${btnBase} ${paused ? 'bg-amber-500 text-white hover:bg-amber-600' : 'bg-slate-700/80 text-slate-100 hover:bg-slate-600'}`}
      title={paused ? '録音を再開' : '録音を一時停止'}
    >
      {paused ? <><Play size={11} strokeWidth={2.25} /> 再開</> : <Pause size={11} strokeWidth={2.25} />}
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

  const editButton = (
    <button
      onClick={handleOpenEdit}
      className={btnGhost}
      title={`${isMeeting ? '会議' : '通話'}記録の編集を開く（メイン窓が前面に出ます）`}
    >
      <Pencil size={11} strokeWidth={2.25} />
      編集
    </button>
  );

  const memoButton = (
    <button
      onClick={handleOpenMemo}
      className={`${btnBase} ${memoOpen ? 'bg-brand-500 text-white' : 'bg-slate-700/80 text-slate-100 hover:bg-slate-600'}`}
      title="メモを編集（自動保存）"
    >
      <StickyNote size={11} strokeWidth={2.25} />
      メモ
    </button>
  );

  const endButton = (
    <button
      onClick={handleEnd}
      className={`${btnBase} bg-red-500 text-white hover:bg-red-600`}
      title="記録を終了"
    >
      <Square size={10} strokeWidth={2.5} fill="currentColor" />
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

  // ============ mini (200×32) ============
  if (size === 'mini') {
    return (
      <div className="flex h-full w-full flex-col">
        <div
          className="hud-drag flex h-8 w-full flex-none select-none items-center gap-1.5 rounded-xl px-2 text-slate-100 shadow-2xl ring-1 ring-white/10"
          style={containerStyle}
          onDoubleClick={handleOpenMain}
          title={`${isMeeting ? '会議中' : '通話中'}${displayName ? ` — ${displayName}` : ''}\nダブルクリックでメイン窓`}
        >
          <span className={`inline-block h-2 w-2 rounded-full ${recording && !paused ? 'animate-pulse bg-red-500' : holding || paused ? 'bg-amber-400' : isMeeting ? 'bg-violet-400' : 'bg-emerald-400'}`} />
          <div className="font-mono text-sm font-semibold tabular-nums">{formatHMS(elapsedSec)}</div>
          <div className="min-w-0 flex-1 truncate text-[9px] text-slate-400">{displayName}</div>
          <button
            onClick={handleMarker}
            className={`hud-no-drag rounded p-0.5 ${markerFlash ? 'bg-brand-500 text-white' : 'text-slate-300 hover:bg-white/10'}`}
            title="マーカーを打つ"
          >
            <Bookmark size={12} strokeWidth={2.25} />
          </button>
          <button
            onClick={handleOpenMemo}
            className={`hud-no-drag rounded p-0.5 ${memoOpen ? 'bg-brand-500 text-white' : 'text-slate-300 hover:bg-white/10'}`}
            title="メモを編集"
          >
            <StickyNote size={12} strokeWidth={2.25} />
          </button>
          {sizeButton}
          <button
            onClick={handleEnd}
            className="hud-no-drag rounded-md bg-red-500 p-0.5 text-white hover:bg-red-600"
            title="記録を終了"
          >
            <X size={12} strokeWidth={2.5} />
          </button>
        </div>
        {liveBox}
        {memoBox}
      </div>
    );
  }

  // ============ compact (330×64) ============
  if (size === 'compact') {
    return (
      <div className="flex h-full w-full flex-col">
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
        {liveBox}
        {memoBox}
      </div>
    );
  }

  // ============ full (400×118) ============
  return (
    <div className="flex h-full w-full flex-col">
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
      {liveBox}
        {memoBox}
    </div>
  );
}
