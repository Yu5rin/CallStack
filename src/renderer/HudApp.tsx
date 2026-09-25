import { useEffect, useMemo, useRef, useState } from 'react';
import { AudioLines, Bookmark, Pause, Play, Pencil, StickyNote, X, Square, Contact, Hand } from 'lucide-react';
import { useActiveCall } from './hooks/useActiveCall';
import { useTheme } from './hooks/useTheme';
import { formatHMS } from './utils/format';
import { AppEvent, Settings, CallRecord, getRecordTags } from '../shared/types';

/** HUD 内蔵の小型レベルメータ（recording:level イベント駆動） */
function MiniLevel({ level, segments = 10 }: { level: number; segments?: number }) {
  const filled = Math.round(level * segments);
  return (
    <div className="flex items-end gap-px" title="録音レベル">
      {Array.from({ length: segments }).map((_, i) => {
        const active = i < filled;
        const color = i < segments * 0.6 ? 'bg-accent' : i < segments * 0.85 ? 'bg-pending' : 'bg-danger';
        return (
          <div
            key={i}
            className={`w-0.5 rounded-sm ${active ? color : 'bg-ink/15'}`}
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
  // HUD 自身のウィンドウにもテーマ（トークンの light/dark/black）を適用する
  useTheme(settings?.theme);
  const [activeRecord, setActiveRecord] = useState<CallRecord | null>(null);
  const [recState, setRecState] = useState({ recording: false, paused: false });
  const [level, setLevel] = useState(0);
  const [markerCount, setMarkerCount] = useState(0);
  const [markerFlash, setMarkerFlash] = useState(false);
  const [memoOpen, setMemoOpen] = useState(false);
  const [memoDraft, setMemoDraft] = useState('');
  const [hovered, setHovered] = useState(false);
  // 情報（タイトル/参加者 or 連絡先/電話番号）の追記オーバーレイ
  const [infoOpen, setInfoOpen] = useState(false);
  const [infoDraft, setInfoDraft] = useState({ title: '', participants: '', contactName: '', phoneNumber: '' });
  const memoTimer = useRef<number | null>(null);
  const infoTimer = useRef<number | null>(null);
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
      if (e.type === 'call:started') {
        setLevel(0);
        setActiveRecord(e.record);
        setMemoDraft(e.record.memo ?? '');
        setMarkerCount(e.record.markers?.length ?? 0);
      }
      if (e.type === 'call:ended') {
        setActiveRecord(null);
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

  // Close the memo / info overlays when the call ends.
  useEffect(() => {
    if (!active) {
      setMemoOpen(false);
      setInfoOpen(false);
      if (memoTimer.current !== null) {
        window.clearTimeout(memoTimer.current);
        memoTimer.current = null;
      }
    }
  }, [active]);

  // ライブ字幕は独立ウィンドウで表示する。HUD の「字幕」ボタンは表示 ON/OFF の切替。
  const liveVisible = settings?.hudLiveVisible ?? true;
  const liveEnabled = settings?.transcription.liveEnabled ?? false;

  // Grow / shrink the HUD window so the memo / info overlays are visible.
  useEffect(() => {
    void window.api.hud.setExtraHeight((memoOpen ? 92 : 0) + (infoOpen ? 156 : 0));
  }, [memoOpen, infoOpen]);

  const recording = recState.recording;
  const paused = recState.paused;
  const isMeeting = activeRecord?.kind === 'meeting';
  const size = settings?.hudSize ?? 'compact';
  // カーソルを乗せている間は透明度を解除して操作しやすくする
  const opacity = hovered ? 1.0 : Math.min(1, Math.max(0.3, settings?.hudOpacity ?? 1.0));

  // surface トークン（テーマに応じて自動的に light/dark/black が切り替わる）を
  // 半透明で使う。カーソルを乗せている間ほど不透明になる。
  const containerStyle = useMemo(() => ({
    background: `rgb(var(--c-surface) / ${opacity * 0.95})`,
    transition: 'background 0.15s ease',
  }), [opacity]);

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
  const handleToggleLive = () => {
    if (!settings) return;
    void window.api.settings.update({ ...settings, hudLiveVisible: !liveVisible });
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

  // 情報オーバーレイ: 開くとき現在値を読み込む（メモは閉じる）
  const handleOpenInfo = () => {
    setInfoOpen((v) => {
      const next = !v;
      if (next) {
        setInfoDraft({
          title: activeRecord?.title ?? '',
          participants: (activeRecord?.participants ?? []).join('、'),
          contactName: activeRecord?.contactName ?? '',
          phoneNumber: activeRecord?.phoneNumber ?? '',
        });
        setMemoOpen(false);
      }
      return next;
    });
  };
  const handleInfoField = (field: 'title' | 'participants' | 'contactName' | 'phoneNumber', value: string) => {
    setInfoDraft((d) => ({ ...d, [field]: value }));
    const id = activeRecord?.id;
    if (!id) return;
    if (infoTimer.current !== null) window.clearTimeout(infoTimer.current);
    infoTimer.current = window.setTimeout(() => {
      if (field === 'participants') {
        void window.api.calls.update(id, {
          participants: value.split(/[、,]/).map((s) => s.trim()).filter(Boolean),
        });
      } else {
        void window.api.calls.update(id, { [field]: value || undefined });
      }
      infoTimer.current = null;
    }, 400);
  };
  // main 側でトグル（未付与なら追加・付与済みなら解除。複数タグ可）
  const curTags = activeRecord ? getRecordTags(activeRecord) : [];
  const handleAssignTag = (tagName: string) => {
    void window.api.hud.assignTag(tagName);
  };

  const inputCls = 'w-full rounded bg-paper px-2 py-1 text-xs text-ink placeholder-ink-mute ring-1 ring-rule';
  const infoBox = infoOpen ? (
    <div className="hud-no-drag mt-1 flex-none space-y-1.5 rounded-lg bg-surface p-2 shadow-lg ring-1 ring-rule">
      {isMeeting ? (
        <>
          <input
            autoFocus
            value={infoDraft.title}
            onChange={(e) => handleInfoField('title', e.target.value)}
            placeholder="会議タイトル"
            className={inputCls}
          />
          <input
            value={infoDraft.participants}
            onChange={(e) => handleInfoField('participants', e.target.value)}
            placeholder="参加者（読点・カンマ区切り）"
            className={inputCls}
          />
        </>
      ) : (
        <>
          <input
            autoFocus
            value={infoDraft.contactName}
            onChange={(e) => handleInfoField('contactName', e.target.value)}
            placeholder="連絡先名"
            className={inputCls}
          />
          <input
            value={infoDraft.phoneNumber}
            onChange={(e) => handleInfoField('phoneNumber', e.target.value)}
            placeholder="電話番号"
            className={inputCls}
          />
        </>
      )}
      <div className="flex flex-wrap gap-1 pt-0.5">
        {(settings?.tags ?? []).map((t) => {
          const on = curTags.includes(t.name);
          return (
            <button
              key={t.name}
              onClick={() => handleAssignTag(t.name)}
              className={`rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 transition ${
                on ? 'text-on-accent' : 'text-ink-mute ring-rule hover:bg-ink/10'
              }`}
              style={on ? { backgroundColor: t.color, borderColor: t.color } : undefined}
              title={on ? 'タグを外す' : `タグ「${t.name}」を付ける`}
            >
              {t.name}
            </button>
          );
        })}
      </div>
    </div>
  ) : null;

  const memoBox = memoOpen ? (
    <div className="hud-no-drag mt-1 flex-1 min-h-0 rounded-lg bg-surface p-2 shadow-lg ring-1 ring-rule">
      <textarea
        autoFocus
        value={memoDraft}
        onChange={(e) => handleMemoChange(e.target.value)}
        onKeyDown={handleMemoKey}
        placeholder="メモを入力 (自動保存 / Esc で閉じる)"
        className="h-full w-full resize-none rounded bg-paper px-2 py-1 text-xs text-ink placeholder-ink-mute ring-1 ring-rule"
      />
    </div>
  ) : null;

  if (!active) {
    return (
      <div
        className="hud-drag h-full w-full rounded-lg px-4 py-3 text-ink shadow-lg ring-1 ring-rule"
        style={containerStyle}
      >
        <div className="text-xs text-ink-mute">記録なし</div>
      </div>
    );
  }

  const statusLabel = holding
    ? <span className="inline-flex items-center gap-1 font-medium text-pending"><Pause size={10} strokeWidth={2.5} /> 保留 {formatHMS(holdSec)}</span>
    : (
      <span className={`inline-flex items-center gap-1 font-medium ${isMeeting ? 'text-meeting' : 'text-accent-ink'}`}>
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${isMeeting ? 'bg-meeting' : 'bg-accent'}`} />
        {isMeeting ? '会議中' : '通話中'}
      </span>
    );

  const recBadge = recording && (
    paused
      ? <span className="inline-flex items-center gap-1 rounded bg-pending/20 px-1 py-px font-medium text-pending"><Pause size={9} strokeWidth={2.5} /> PAUSE</span>
      : <span className="inline-flex items-center gap-1 rounded bg-danger/20 px-1 py-px font-medium text-danger"><span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-danger" /> REC</span>
  );

  const btnBase = 'hud-no-drag inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-medium transition';
  const btnGhost = `${btnBase} bg-ink/10 text-ink hover:bg-ink/15`;

  const markerButton = (compact = false) => (
    <button
      onClick={handleMarker}
      className={`${btnBase} ${markerFlash ? 'bg-accent text-on-accent' : 'bg-ink/10 text-ink hover:bg-ink/15'}`}
      title="マーカーを打つ（あとで該当箇所へジャンプできます）"
    >
      <Bookmark size={11} strokeWidth={2.25} />
      {markerCount > 0 ? `${markerCount}` : compact ? '' : 'マーカー'}
    </button>
  );

  const pauseButton = recording ? (
    <button
      onClick={handleTogglePause}
      className={`${btnBase} ${paused ? 'bg-pending text-on-accent hover:bg-pending/90' : 'bg-ink/10 text-ink hover:bg-ink/15'}`}
      title={paused ? '録音を再開' : '録音を一時停止'}
    >
      {paused ? <><Play size={11} strokeWidth={2.25} /> 再開</> : <Pause size={11} strokeWidth={2.25} />}
    </button>
  ) : null;

  const holdButton = !isMeeting ? (
    <button
      onClick={handleToggleHold}
      className={`${btnBase} ${holding ? 'bg-pending text-on-accent hover:bg-pending/90' : 'bg-ink/10 text-ink hover:bg-ink/15'}`}
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
      className={`${btnBase} ${memoOpen ? 'bg-accent text-on-accent' : 'bg-ink/10 text-ink hover:bg-ink/15'}`}
      title="メモを編集（自動保存）"
    >
      <StickyNote size={11} strokeWidth={2.25} />
      メモ
    </button>
  );

  const infoButton = (
    <button
      onClick={handleOpenInfo}
      className={`${btnBase} ${infoOpen ? 'bg-accent text-on-accent' : 'bg-ink/10 text-ink hover:bg-ink/15'}`}
      title={isMeeting ? 'タイトル・参加者・タグを追記' : '連絡先・電話番号・タグを追記'}
    >
      <Contact size={11} strokeWidth={2.25} />
      情報
    </button>
  );

  // ライブ字幕の表示 ON/OFF（ライブ文字起こしが有効なときのみ表示）
  const liveToggleButton = liveEnabled ? (
    <button
      onClick={handleToggleLive}
      className={`${btnBase} ${liveVisible ? 'bg-accent text-on-accent hover:bg-accent/90' : 'bg-ink/10 text-ink hover:bg-ink/15'}`}
      title={liveVisible ? 'ライブ字幕を隠す' : 'ライブ字幕を表示'}
    >
      <AudioLines size={11} strokeWidth={2.25} />
      字幕
    </button>
  ) : null;

  const endButton = (
    <button
      onClick={handleEnd}
      className={`${btnBase} bg-danger text-on-accent hover:bg-danger/90`}
      title="記録を終了"
    >
      <Square size={10} strokeWidth={2.5} fill="currentColor" />
      終了
    </button>
  );

  const sizeButton = (
    <button
      onClick={handleCycleSize}
      className="hud-no-drag rounded p-0.5 text-ink-mute transition hover:bg-ink/10 hover:text-ink"
      title="サイズ切替 (mini / compact / full)"
    >
      <svg viewBox="0 0 20 20" width="13" height="13" fill="currentColor"><path d="M3 3h6v2H5v4H3V3zm14 0v6h-2V5h-4V3h6zM3 17v-6h2v4h4v2H3zm14 0h-6v-2h4v-4h2v6z"/></svg>
    </button>
  );

  // 密集アイコンボタン（compact 用）
  const dense = (on: boolean) =>
    `hud-no-drag inline-flex flex-none items-center rounded-md p-1 transition ${
      on ? 'bg-accent text-on-accent' : 'bg-ink/10 text-ink hover:bg-ink/15'
    }`;

  // ============ mini (240×34) ============
  if (size === 'mini') {
    return (
      <div className="flex h-full w-full flex-col">
        <div
          className="hud-drag flex h-[34px] w-full flex-none select-none items-center gap-1 rounded-lg px-2 text-ink shadow-lg ring-1 ring-rule"
          style={containerStyle}
          onDoubleClick={handleOpenMain}
          title={`${isMeeting ? '会議中' : '通話中'}${displayName ? ` — ${displayName}` : ''}\nダブルクリックでメイン窓`}
        >
          <span className={`inline-block h-2 w-2 rounded-full ${recording && !paused ? 'animate-pulse bg-danger' : holding || paused ? 'bg-pending' : isMeeting ? 'bg-meeting' : 'bg-accent'}`} />
          <div className="font-mono text-sm font-semibold tabular-nums">{formatHMS(elapsedSec)}</div>
          <div className="min-w-0 flex-1 truncate text-[9px] text-ink-mute">{displayName}</div>
          <button
            onClick={handleMarker}
            className={`hud-no-drag rounded p-0.5 ${markerFlash ? 'bg-accent text-on-accent' : 'text-ink-mute hover:bg-ink/10'}`}
            title="マーカーを打つ"
          >
            <Bookmark size={12} strokeWidth={2.25} />
          </button>
          <button
            onClick={handleOpenMemo}
            className={`hud-no-drag rounded p-0.5 ${memoOpen ? 'bg-accent text-on-accent' : 'text-ink-mute hover:bg-ink/10'}`}
            title="メモを編集"
          >
            <StickyNote size={12} strokeWidth={2.25} />
          </button>
          <button
            onClick={handleOpenInfo}
            className={`hud-no-drag rounded p-0.5 ${infoOpen ? 'bg-accent text-on-accent' : 'text-ink-mute hover:bg-ink/10'}`}
            title={isMeeting ? 'タイトル・参加者・タグを追記' : '連絡先・電話番号・タグを追記'}
          >
            <Contact size={12} strokeWidth={2.25} />
          </button>
          {liveEnabled && (
            <button
              onClick={handleToggleLive}
              className={`hud-no-drag rounded p-0.5 ${liveVisible ? 'bg-accent text-on-accent' : 'text-ink-mute hover:bg-ink/10'}`}
              title={liveVisible ? 'ライブ字幕を隠す' : 'ライブ字幕を表示'}
            >
              <AudioLines size={12} strokeWidth={2.25} />
            </button>
          )}
          {sizeButton}
          <button
            onClick={handleEnd}
            className="hud-no-drag rounded-md bg-danger p-0.5 text-on-accent hover:bg-danger/90"
            title="記録を終了"
          >
            <X size={12} strokeWidth={2.5} />
          </button>
        </div>
        {infoBox}
        {memoBox}
      </div>
    );
  }

  // ============ compact (400×70) ============
  if (size === 'compact') {
    return (
      <div className="flex h-full w-full flex-col">
        <div
          className="hud-drag h-[70px] w-full flex-none select-none rounded-lg px-3 py-1.5 text-ink shadow-lg ring-1 ring-rule"
          style={containerStyle}
          onDoubleClick={handleOpenMain}
          title="ダブルクリックでメイン窓を開く"
        >
          <div className="flex items-center gap-2 text-[10px]">
            {statusLabel}
            <span className="min-w-0 flex-1 truncate text-ink-mute">{displayName}</span>
            {recBadge}
            {recording && !paused && <MiniLevel level={level} />}
            {sizeButton}
          </div>
          <div className="mt-1 flex items-center gap-1.5">
            <div className="font-mono text-lg font-semibold leading-none tabular-nums">{formatHMS(elapsedSec)}</div>
            {/* アイコンのみで省スペース化し、終了ボタンまで必ず表示されるようにする */}
            <div className="hud-no-drag ml-auto flex flex-none items-center gap-0.5">
              <button onClick={handleMarker} className={dense(markerFlash)} title="マーカーを打つ">
                <Bookmark size={13} strokeWidth={2.25} />
                {markerCount > 0 && <span className="ml-0.5 text-[9px] font-medium">{markerCount}</span>}
              </button>
              {recording && (
                <button onClick={handleTogglePause} className={dense(paused)} title={paused ? '録音を再開' : '録音を一時停止'}>
                  {paused ? <Play size={13} strokeWidth={2.25} /> : <Pause size={13} strokeWidth={2.25} />}
                </button>
              )}
              {!isMeeting && (
                <button onClick={handleToggleHold} className={dense(holding)} title={holding ? '保留を解除' : '保留にする'}>
                  <Hand size={13} strokeWidth={2.25} />
                </button>
              )}
              <button onClick={handleOpenEdit} className={dense(false)} title="記録の編集を開く">
                <Pencil size={13} strokeWidth={2.25} />
              </button>
              {liveEnabled && (
                <button
                  onClick={handleToggleLive}
                  className={`hud-no-drag inline-flex flex-none items-center rounded-md p-1 transition ${liveVisible ? 'bg-accent text-on-accent' : 'bg-ink/10 text-ink hover:bg-ink/15'}`}
                  title={liveVisible ? 'ライブ字幕を隠す' : 'ライブ字幕を表示'}
                >
                  <AudioLines size={13} strokeWidth={2.25} />
                </button>
              )}
              <button onClick={handleOpenInfo} className={dense(infoOpen)} title={isMeeting ? 'タイトル・参加者・タグ' : '連絡先・電話番号・タグ'}>
                <Contact size={13} strokeWidth={2.25} />
              </button>
              <button onClick={handleOpenMemo} className={dense(memoOpen)} title="メモを編集">
                <StickyNote size={13} strokeWidth={2.25} />
              </button>
              <button onClick={handleEnd} className="hud-no-drag inline-flex flex-none items-center rounded-md bg-danger p-1 text-on-accent hover:bg-danger/90" title="記録を終了">
                <Square size={12} strokeWidth={2.5} fill="currentColor" />
              </button>
            </div>
          </div>
        </div>
        {infoBox}
        {memoBox}
      </div>
    );
  }

  // ============ full (470×122) ============
  return (
    <div className="flex h-full w-full flex-col">
      <div
        className="hud-drag w-full flex-none select-none rounded-lg px-4 py-2.5 text-ink shadow-lg ring-1 ring-rule"
        style={{ ...containerStyle, height: 122 }}
        onDoubleClick={handleOpenMain}
        title="ダブルクリックでメイン窓を開く"
      >
        <div className="flex items-center gap-2 text-[11px]">
          {statusLabel}
          <span className="min-w-0 flex-1 truncate text-ink-mute">{displayName}</span>
          {recBadge}
          {recording && !paused && <MiniLevel level={level} segments={14} />}
          {sizeButton}
        </div>
        <div className="mt-1 flex items-center gap-2">
          <div className="font-mono text-3xl font-semibold leading-none tabular-nums">{formatHMS(elapsedSec)}</div>
          {holding && (
            <span className="text-[10px] text-pending">保留 {formatHMS(holdSec)}</span>
          )}
        </div>
        <div className="hud-no-drag mt-1.5 flex items-center gap-1.5">
          {markerButton()}
          {pauseButton}
          {holdButton}
          {editButton}
          {liveToggleButton}
          {infoButton}
          {memoButton}
          <div className="flex-1" />
          {endButton}
        </div>
      </div>
        {infoBox}
        {memoBox}
    </div>
  );
}
