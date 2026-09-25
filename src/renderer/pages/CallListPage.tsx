import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Search, Mic, FileText, AlertTriangle, Loader2, Clock3,
  Download, SlidersHorizontal, Trash2,
  Phone, Users, ChevronDown, Undo2, FolderOpen,
} from 'lucide-react';
import { AppEvent, CallRecord, Settings, CsvExportOptions, CsvImportResult, getRecordTags } from '../../shared/types';
import { RecordDetail } from '../components/RecordDetail';
import { AudioImportDialog, ImportFile } from '../components/AudioImportDialog';
import { TranscriptionStatusBar } from '../components/SummaryFooter';
import { deleteCallWithConfirm } from '../hooks/useCalls';
import { formatHM, formatMSTotal, formatHMSCompact, formatHMShort, formatDayHeader, dayKey } from '../utils/format';
import { highlight } from '../utils/highlight';
import { useToast } from '../components/Toast';
import { toUserMessage } from '../utils/errorMessage';

interface Props {
  calls: CallRecord[];
  settings: Settings;
  onSaveSettings: (next: Settings) => Promise<void>;
  initialContactFilter?: string | null;
  onConsumeInitialFilter?: () => void;
  initialEditId?: string | null;
  onConsumeInitialEditId?: () => void;
}

type SortMode = 'newest' | 'oldest' | 'longest';
type Period = 'today' | 'thisWeek' | 'thisMonth' | 'all' | 'custom';

const PERIOD_LABEL: Record<Period, string> = {
  today: '今日', thisWeek: '今週', thisMonth: '今月', all: '全期間', custom: 'カスタム',
};

const AUDIO_EXT = /\.(mp3|wav|m4a|webm|ogg|aac|flac)$/i;

export function CallListPage({
  calls, settings, onSaveSettings, initialContactFilter, onConsumeInitialFilter, initialEditId, onConsumeInitialEditId,
}: Props) {
  const toast = useToast();
  const [trashMode, setTrashMode] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filterKind, setFilterKind] = useState<'' | 'call' | 'meeting'>('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [showUntagged, setShowUntagged] = useState(false);
  const [hasAudioOnly, setHasAudioOnly] = useState(false);
  const [period, setPeriod] = useState<Period>('all');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [filterContact, setFilterContact] = useState('');
  const [hasTranscript, setHasTranscript] = useState<'' | 'yes' | 'no'>('');
  const [sortMode, setSortMode] = useState<SortMode>('newest');
  const [periodOpen, setPeriodOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; call: CallRecord } | null>(null);
  const [importResult, setImportResult] = useState<CsvImportResult | null>(null);
  const [restoreResult, setRestoreResult] = useState<{ calls: number; backupPath: string } | null>(null);
  const [dropError, setDropError] = useState<string | null>(null);
  const [dragDepth, setDragDepth] = useState(0);
  const [audioImport, setAudioImport] = useState<{ open: boolean; file: ImportFile | null }>({ open: false, file: null });
  const [progress, setProgress] = useState<Record<string, number>>({});

  const searchRef = useRef<HTMLInputElement | null>(null);
  const detailPaneRef = useRef<HTMLDivElement | null>(null);
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  // 「手動で追加」で作った記録を、一度も編集されないまま選択解除したら完全に削除する
  const pendingManualIdRef = useRef<string | null>(null);
  const manualTouchedRef = useRef(false);

  const [debouncedQuery, setDebouncedQuery] = useState('');
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQuery(query), 200);
    return () => window.clearTimeout(t);
  }, [query]);

  const haystacks = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of calls) {
      m.set(c.id, [
        c.memo, c.contactName ?? '', c.phoneNumber ?? '', c.title ?? '',
        c.participants?.join(' ') ?? '', getRecordTags(c).join(' '), c.transcript?.text ?? '',
      ].join(' ').toLowerCase());
    }
    return m;
  }, [calls]);

  useEffect(() => {
    const off = window.api.onEvent((e: AppEvent) => {
      if (e.type === 'transcription:progress') {
        setProgress((prev) => ({ ...prev, [e.callId]: e.percent }));
      } else if (e.type === 'transcription:status' && e.status !== 'running') {
        setProgress((prev) => {
          if (!(e.callId in prev)) return prev;
          const next = { ...prev };
          delete next[e.callId];
          return next;
        });
      }
    });
    return () => off();
  }, []);

  // タイトルバーの ︙ メニューからのアクションを受け付ける
  useEffect(() => {
    const handler = (e: Event) => {
      const action = (e as CustomEvent<string>).detail;
      if (action === 'audio-import') setAudioImport({ open: true, file: null });
      else if (action === 'manual-add') void handleAddManual();
      else if (action === 'csv-import') void handleImport();
      else if (action === 'csv-export') void handleExport();
    };
    window.addEventListener('callstack:list-action', handler);
    return () => window.removeEventListener('callstack:list-action', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, customFrom, customTo]);

  useEffect(() => {
    if (initialContactFilter) {
      setTrashMode(false);
      setFilterContact(initialContactFilter);
      onConsumeInitialFilter?.();
    }
  }, [initialContactFilter, onConsumeInitialFilter]);

  // HUD の編集ボタン・通知などから、指定された記録を一覧で選択する
  useEffect(() => {
    if (!initialEditId) return;
    const target = calls.find((c) => c.id === initialEditId);
    if (target) {
      setTrashMode(!!target.deletedAt);
      setSelectedId(target.id);
      onConsumeInitialEditId?.();
    }
  }, [initialEditId, calls, onConsumeInitialEditId]);

  // ポップオーバー・右クリックメニューは外側クリック・Esc・スクロールで閉じる
  useEffect(() => {
    if (!ctxMenu && !periodOpen && !filtersOpen) return;
    const close = () => { setCtxMenu(null); setPeriodOpen(false); setFiltersOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
    };
  }, [ctxMenu, periodOpen, filtersOpen]);

  const tagColor = useMemo(() => {
    const m: Record<string, string> = {};
    for (const t of settings.tags) m[t.name] = t.color;
    return m;
  }, [settings.tags]);

  const aliveCalls = useMemo(() => calls.filter((c) => !c.deletedAt), [calls]);
  const trashCalls = useMemo(() => calls.filter((c) => c.deletedAt), [calls]);

  const allContacts = useMemo(() => {
    const set = new Set<string>();
    for (const c of aliveCalls) if (c.contactName) set.add(c.contactName);
    return [...set].sort();
  }, [aliveCalls]);

  const untaggedCount = useMemo(
    () => aliveCalls.filter((c) => c.endTime && getRecordTags(c).length === 0).length,
    [aliveCalls],
  );

  const periodRange = useMemo(() => {
    const now = new Date();
    if (period === 'today') {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      return { from: start, to: start + 86_400_000 };
    }
    if (period === 'thisWeek') {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
      return { from: start.getTime(), to: start.getTime() + 7 * 86_400_000 };
    }
    if (period === 'thisMonth') {
      return {
        from: new Date(now.getFullYear(), now.getMonth(), 1).getTime(),
        to: new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime(),
      };
    }
    if (period === 'custom') {
      return {
        from: customFrom ? new Date(customFrom).getTime() : null,
        to: customTo ? new Date(customTo).getTime() + 86_400_000 : null,
      };
    }
    return { from: null as number | null, to: null as number | null };
  }, [period, customFrom, customTo]);

  const hasActiveFilters = !!(query || filterKind || selectedTags.length || showUntagged || hasAudioOnly
    || filterContact || hasTranscript || period !== 'all');

  const clearFilters = () => {
    setQuery(''); setFilterKind(''); setSelectedTags([]); setShowUntagged(false); setHasAudioOnly(false);
    setFilterContact(''); setHasTranscript(''); setPeriod('all'); setCustomFrom(''); setCustomTo('');
  };

  // ============ 絞り込み ============
  const filteredCalls = useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase();
    const source = trashMode ? trashCalls : aliveCalls;
    return source.filter((c) => {
      const kind = c.kind ?? 'call';
      if (filterKind && kind !== filterKind) return false;
      const cTags = getRecordTags(c);
      if (selectedTags.length > 0 || showUntagged) {
        const untaggedHit = showUntagged && cTags.length === 0;
        const tagHit = cTags.some((t) => selectedTags.includes(t));
        if (!untaggedHit && !tagHit) return false;
      }
      if (hasAudioOnly && !c.audio) return false;
      if (filterContact && c.contactName !== filterContact) return false;
      if (hasTranscript === 'yes' && !c.transcript) return false;
      if (hasTranscript === 'no' && c.transcript) return false;
      const t = new Date(c.startTime).getTime();
      if (periodRange.from !== null && t < periodRange.from) return false;
      if (periodRange.to !== null && t >= periodRange.to) return false;
      if (!q) return true;
      return (haystacks.get(c.id) ?? '').includes(q);
    });
  }, [trashMode, trashCalls, aliveCalls, debouncedQuery, haystacks, filterKind, selectedTags, showUntagged, hasAudioOnly, filterContact, hasTranscript, periodRange]);

  // ============ 日別グループ化・並び替え ============
  const dayGroups = useMemo(() => {
    const map = new Map<string, CallRecord[]>();
    for (const c of filteredCalls) {
      const k = dayKey(c.startTime);
      const arr = map.get(k);
      if (arr) arr.push(c); else map.set(k, [c]);
    }
    const keys = Array.from(map.keys()).sort((a, b) => (sortMode === 'oldest' ? a.localeCompare(b) : b.localeCompare(a)));
    const cmp = (a: CallRecord, b: CallRecord) => {
      if (sortMode === 'longest') return (b.durationSec ?? 0) - (a.durationSec ?? 0);
      const byTime = a.startTime.localeCompare(b.startTime);
      return sortMode === 'oldest' ? byTime : -byTime;
    };
    return keys.map((k) => {
      const items = map.get(k)!.slice().sort(cmp);
      const totalSec = items.reduce((s, c) => s + (c.durationSec ?? 0), 0);
      return { key: k, label: formatDayHeader(items[0].startTime), items, totalSec };
    });
  }, [filteredCalls, sortMode]);

  const flattenedOrder = useMemo(() => dayGroups.flatMap((g) => g.items.map((c) => c.id)), [dayGroups]);

  const footerSummary = useMemo(() => {
    let callCount = 0, callSec = 0, meetingCount = 0, meetingSec = 0;
    for (const c of filteredCalls) {
      if ((c.kind ?? 'call') === 'meeting') { meetingCount++; meetingSec += c.durationSec ?? 0; }
      else { callCount++; callSec += c.durationSec ?? 0; }
    }
    return { total: filteredCalls.length, callCount, callSec, meetingCount, meetingSec };
  }, [filteredCalls]);

  const selected = useMemo(() => calls.find((c) => c.id === selectedId) ?? null, [calls, selectedId]);

  // 選択が外れる（別の行を選ぶ・トラッシュへ切替 等）とき、直前の「手動で追加」記録が
  // 一度も編集されていなければ、意味のない記録として完全に削除する。
  useEffect(() => {
    const idAtRender = selectedId;
    return () => {
      if (idAtRender && idAtRender === pendingManualIdRef.current && !manualTouchedRef.current) {
        pendingManualIdRef.current = null;
        void window.api.calls.purge(idAtRender).catch(() => {});
      }
    };
  }, [selectedId]);

  // 選択行をリスト内で見える位置へスクロール
  useEffect(() => {
    if (!selectedId) return;
    rowRefs.current.get(selectedId)?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  const focusDetailTitle = () => {
    window.setTimeout(() => {
      detailPaneRef.current?.querySelector<HTMLInputElement>('input[aria-label="タイトル"]')?.focus();
    }, 30);
  };

  const handleDeleteSelected = async () => {
    if (!selected) return;
    if (trashMode) {
      if (!window.confirm('この記録を完全に削除しますか？録音ファイルも削除され、元に戻せません。')) return;
      await window.api.calls.purge(selected.id);
      setSelectedId(null);
      return;
    }
    const removed = await deleteCallWithConfirm(selected.id, settings.confirmCallDelete);
    if (removed) setSelectedId(null);
  };

  const onListKeyDown = (e: React.KeyboardEvent) => {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (flattenedOrder.length === 0) return;
      e.preventDefault();
      const idx = selectedId ? flattenedOrder.indexOf(selectedId) : -1;
      const next = e.key === 'ArrowDown'
        ? Math.min(flattenedOrder.length - 1, idx < 0 ? 0 : idx + 1)
        : Math.max(0, idx < 0 ? 0 : idx - 1);
      setSelectedId(flattenedOrder[next]);
    } else if (e.key === 'Enter') {
      if (!selectedId) return;
      e.preventDefault();
      focusDetailTitle();
    } else if (e.key === 'Delete') {
      if (!selectedId) return;
      e.preventDefault();
      void handleDeleteSelected();
    }
  };

  const handleExport = async () => {
    const opts: CsvExportOptions = period === 'today'
      ? { range: 'custom', from: new Date().toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) }
      : period === 'custom'
        ? { range: 'custom', from: customFrom || undefined, to: customTo || undefined }
        : { range: (period === 'thisWeek' || period === 'thisMonth') ? period : 'all' };
    const r = await window.api.csv.export(opts);
    if (!r.canceled) toast.success(`${r.count} 件を ${r.path} に書き出しました`);
  };

  const handleImport = async () => {
    const r = await window.api.csv.import();
    if (r.canceled) return;
    setImportResult(r.result);
  };

  const handleDropFile = async (file: File) => {
    setDropError(null);
    const name = file.name.toLowerCase();
    try {
      if (name.endsWith('.csv')) {
        const text = await file.text();
        const r = await window.api.csv.importText(text);
        setImportResult(r.result);
      } else if (name.endsWith('.json')) {
        if (!window.confirm('JSON ファイルから復元します。現在のデータは復元前に自動バックアップされます。続行しますか？')) return;
        const text = await file.text();
        const json = JSON.parse(text);
        const r = await window.api.backup.restoreJson(json);
        setRestoreResult({ calls: r.calls, backupPath: r.backupPath });
      } else if (AUDIO_EXT.test(name)) {
        const p = window.api.util.getFilePath(file);
        setAudioImport({ open: true, file: { path: p, name: file.name, mtime: new Date(file.lastModified).toISOString() } });
      } else {
        setDropError(`未対応のファイル形式: ${file.name}（.csv / .json / 音声ファイルに対応）`);
      }
    } catch (err) {
      setDropError(toUserMessage(err));
    }
  };

  const handleAddManual = async () => {
    const now = new Date().toISOString();
    const ago = new Date(Date.now() - 60_000).toISOString();
    const rec = await window.api.calls.create({ startTime: ago, endTime: now });
    pendingManualIdRef.current = rec.id;
    manualTouchedRef.current = false;
    setTrashMode(false);
    setSelectedId(rec.id);
    focusDetailTitle();
  };

  const showSaveResult = (r: { canceled: boolean; path?: string; error?: string }) => {
    if (r.canceled) return;
    if (r.error) toast.error(r.error);
    else toast.success(`保存しました: ${r.path}`);
  };

  // ============ 行の右クリックメニュー ============
  const ctxActions: Array<{ label: string; icon: React.ReactNode; danger?: boolean; header?: boolean; run?: () => void | Promise<void> }> = !ctxMenu
    ? []
    : trashMode
    ? [
        { label: '復元', icon: <Undo2 size={16} />, run: async () => { await window.api.calls.restore(ctxMenu.call.id); toast.success('記録を復元しました'); } },
        { label: '完全に削除', icon: <Trash2 size={16} />, danger: true, run: async () => {
            if (!window.confirm('この記録を完全に削除しますか？録音ファイルも削除され、元に戻せません。')) return;
            await window.api.calls.purge(ctxMenu.call.id);
          } },
      ]
    : [
        { label: '開く', icon: <FolderOpen size={16} />, run: () => setSelectedId(ctxMenu.call.id) },
        { label: '書き出し', icon: null, header: true },
        ...(ctxMenu.call.audio ? [{ label: '録音を書き出す（MP3）', icon: <Download size={16} />, run: async () => showSaveResult(await window.api.recording.saveAs(ctxMenu.call.id)) }] : []),
        ...(ctxMenu.call.transcript ? [{ label: '文字起こしを書き出す', icon: <FileText size={16} />, run: async () => showSaveResult(await window.api.transcript.saveAs(ctxMenu.call.id, false)) }] : []),
        ...(ctxMenu.call.transcript ? [{ label: '文字起こしを書き出す（時刻付き）', icon: <FileText size={16} />, run: async () => showSaveResult(await window.api.transcript.saveAs(ctxMenu.call.id, true)) }] : []),
        { label: '議事録を書き出す（Markdown）', icon: <FileText size={16} />, run: async () => showSaveResult(await window.api.minutes.saveAs(ctxMenu.call.id)) },
        { label: 'ゴミ箱へ移動', icon: <Trash2 size={16} />, danger: true, run: async () => {
            const removed = await deleteCallWithConfirm(ctxMenu.call.id, settings.confirmCallDelete);
            if (removed && selectedId === ctxMenu.call.id) setSelectedId(null);
          } },
      ];

  const periodLabel = period === 'custom' && (customFrom || customTo)
    ? `${customFrom || '…'} 〜 ${customTo || '…'}`
    : PERIOD_LABEL[period];

  return (
    <div
      className="flex h-full"
      onDragEnter={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragDepth((d) => d + 1); } }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }}
      onDragLeave={() => setDragDepth((d) => Math.max(0, d - 1))}
      onDrop={(e) => { e.preventDefault(); setDragDepth(0); const file = e.dataTransfer.files?.[0]; if (file) void handleDropFile(file); }}
    >
      {dragDepth > 0 && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-accent/20 backdrop-blur-sm">
          <div className="rounded-lg border-2 border-dashed border-accent bg-surface px-6 py-4 text-base font-medium text-accent-ink shadow-lg">
            ドロップで取り込み（CSV / JSON復元 / 音声ファイル）
          </div>
        </div>
      )}

      {/* ============ 一覧ペイン ============ */}
      <div className="flex w-80 min-[1000px]:w-[380px] flex-none flex-col border-r border-rule bg-surface">
        {trashMode ? (
          <div className="flex items-center justify-between gap-2 border-b border-rule px-3 py-2.5">
            <span className="inline-flex items-center gap-1.5 text-sm font-medium text-ink"><Trash2 size={14} />ゴミ箱</span>
            <button onClick={() => { setTrashMode(false); setSelectedId(null); }} className="text-xs font-medium text-accent-ink hover:underline">
              記録に戻る
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-2 border-b border-rule px-3 pb-2 pt-3">
            <div className="relative flex items-center">
              <Search size={14} className="pointer-events-none absolute left-2.5 text-ink-mute" />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape' && query) { setQuery(''); e.currentTarget.blur(); } }}
                placeholder="検索（メモ・連絡先・会議名・文字起こし）"
                className="w-full rounded-md border border-rule bg-paper py-1.5 pl-7 pr-2.5 text-[13px] text-ink placeholder:text-ink-mute focus:border-accent focus:outline-none"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex rounded-md border border-rule bg-surface p-0.5" role="tablist" aria-label="種類で絞り込み">
                {([['', 'すべて'], ['call', '通話'], ['meeting', '会議']] as const).map(([v, label]) => (
                  <button
                    key={v || 'all'}
                    role="tab"
                    aria-selected={filterKind === v}
                    onClick={() => setFilterKind(v)}
                    className={`rounded px-2.5 py-1 text-xs font-medium ${filterKind === v ? 'bg-accent-soft text-accent-ink' : 'text-ink-mute hover:text-ink'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="relative">
                <button
                  onClick={(e) => { e.stopPropagation(); setPeriodOpen((v) => !v); setFiltersOpen(false); }}
                  onMouseDown={(e) => e.stopPropagation()}
                  className="inline-flex items-center gap-1 rounded-md border border-rule bg-paper px-2.5 py-1 text-xs font-medium text-ink hover:bg-accent-soft"
                >
                  {periodLabel}<ChevronDown size={12} />
                </button>
                {periodOpen && (
                  <div className="absolute left-0 top-full z-30 mt-1.5 w-56 overflow-hidden rounded-lg border border-rule bg-surface p-1.5 shadow-lg" onMouseDown={(e) => e.stopPropagation()}>
                    {(['today', 'thisWeek', 'thisMonth', 'all'] as const).map((p) => (
                      <button key={p} onClick={() => { setPeriod(p); setPeriodOpen(false); }} className={`block w-full rounded-md px-2 py-1.5 text-left text-sm ${period === p ? 'bg-accent-soft text-accent-ink' : 'text-ink hover:bg-paper'}`}>
                        {PERIOD_LABEL[p]}
                      </button>
                    ))}
                    <div className="my-1 h-px bg-rule" />
                    <div className="px-2 py-1 text-xs text-ink-mute">カスタム範囲</div>
                    <div className="flex items-center gap-1 px-2 pb-1.5">
                      <input type="date" value={customFrom} onChange={(e) => { setCustomFrom(e.target.value); setPeriod('custom'); }} className="w-full rounded border border-rule bg-paper px-1.5 py-1 text-xs text-ink" />
                      <span className="text-ink-mute">〜</span>
                      <input type="date" value={customTo} onChange={(e) => { setCustomTo(e.target.value); setPeriod('custom'); }} className="w-full rounded border border-rule bg-paper px-1.5 py-1 text-xs text-ink" />
                    </div>
                  </div>
                )}
              </div>

              <div className="relative ml-auto">
                <button
                  onClick={(e) => { e.stopPropagation(); setFiltersOpen((v) => !v); setPeriodOpen(false); }}
                  onMouseDown={(e) => e.stopPropagation()}
                  className={`flex h-6 w-6 items-center justify-center rounded-md border ${filterContact || hasTranscript || sortMode !== 'newest' ? 'border-accent bg-accent-soft text-accent-ink' : 'border-rule bg-paper text-ink-mute hover:bg-accent-soft'}`}
                  title="連絡先・文字起こし有無・並び順"
                >
                  <SlidersHorizontal size={13} />
                </button>
                {filtersOpen && (
                  <div className="absolute right-0 top-full z-30 mt-1.5 w-64 overflow-hidden rounded-lg border border-rule bg-surface p-3 shadow-lg" onMouseDown={(e) => e.stopPropagation()}>
                    <label className="mb-2 block text-xs text-ink-mute">連絡先</label>
                    <select value={filterContact} onChange={(e) => setFilterContact(e.target.value)} className="mb-3 w-full rounded-md border border-rule bg-paper px-2 py-1.5 text-sm text-ink">
                      <option value="">すべての連絡先</option>
                      {allContacts.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                    <label className="mb-2 block text-xs text-ink-mute">文字起こし</label>
                    <select value={hasTranscript} onChange={(e) => setHasTranscript(e.target.value as '' | 'yes' | 'no')} className="mb-3 w-full rounded-md border border-rule bg-paper px-2 py-1.5 text-sm text-ink">
                      <option value="">指定なし</option>
                      <option value="yes">あり</option>
                      <option value="no">なし</option>
                    </select>
                    <label className="mb-2 block text-xs text-ink-mute">並び順</label>
                    <div className="inline-flex w-full rounded-md border border-rule bg-paper p-0.5">
                      {([['newest', '新しい順'], ['oldest', '古い順'], ['longest', '長い順']] as const).map(([v, label]) => (
                        <button key={v} onClick={() => setSortMode(v)} className={`flex-1 rounded px-2 py-1 text-xs font-medium ${sortMode === v ? 'bg-accent-soft text-accent-ink' : 'text-ink-mute hover:text-ink'}`}>
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {settings.tags.map((t) => {
                const on = selectedTags.includes(t.name);
                return (
                  <button
                    key={t.name}
                    aria-pressed={on}
                    onClick={() => setSelectedTags((prev) => (on ? prev.filter((x) => x !== t.name) : [...prev, t.name]))}
                    className={`rounded-full border px-2.5 py-1 text-xs font-medium ${on ? 'border-accent-soft bg-accent-soft text-accent-ink' : 'border-rule text-ink-mute hover:border-accent'}`}
                  >
                    {t.name}
                  </button>
                );
              })}
              <button
                aria-pressed={showUntagged}
                onClick={() => setShowUntagged((v) => !v)}
                className={`rounded-full border px-2.5 py-1 text-xs font-medium ${showUntagged ? 'border-accent-soft bg-accent-soft text-accent-ink' : 'border-rule text-ink-mute hover:border-accent'}`}
              >
                未タグ{untaggedCount > 0 ? `（${untaggedCount}）` : ''}
              </button>
              <button
                aria-pressed={hasAudioOnly}
                onClick={() => setHasAudioOnly((v) => !v)}
                className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium ${hasAudioOnly ? 'border-accent-soft bg-accent-soft text-accent-ink' : 'border-rule text-ink-mute hover:border-accent'}`}
              >
                <Mic size={11} />録音あり
              </button>
            </div>
          </div>
        )}

        <div
          ref={listScrollRef}
          tabIndex={0}
          onKeyDown={onListKeyDown}
          className="min-h-0 flex-1 overflow-y-auto focus:outline-none"
        >
          {filteredCalls.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
              {trashMode ? (
                <div className="text-sm text-ink-mute">ゴミ箱は空です</div>
              ) : calls.length === 0 ? (
                <>
                  <Phone size={28} strokeWidth={1.5} className="text-ink-mute" />
                  <div className="text-sm text-ink-mute">
                    まだ記録がありません。右上の「記録を開始」または {settings.shortcuts.startCall}（通話）/ {settings.shortcuts.startMeeting}（会議）で開始できます。
                  </div>
                </>
              ) : (
                <>
                  <div className="text-sm text-ink-mute">条件に合う記録はありません</div>
                  <button onClick={clearFilters} className="rounded-md border border-rule bg-surface px-3 py-1.5 text-xs font-medium text-ink hover:bg-paper">
                    絞り込みを解除
                  </button>
                </>
              )}
            </div>
          ) : (
            dayGroups.map((g) => (
              <div key={g.key}>
                <div className="sticky top-0 z-[1] flex items-baseline justify-between gap-2 border-b border-rule bg-surface px-3 py-1.5 text-xs font-medium text-ink-mute">
                  <span>{g.label}</span>
                  <span className="font-mono tabular-nums">{g.items.length}件・{formatHMSCompact(g.totalSec)}</span>
                </div>
                {g.items.map((c) => {
                  const isMeeting = (c.kind ?? 'call') === 'meeting';
                  const name = isMeeting ? (c.title || '（名前なし）') : (c.contactName || '（名前なし）');
                  const cTags = getRecordTags(c);
                  const pct = progress[c.id];
                  const selectedRow = c.id === selectedId;
                  return (
                    <button
                      key={c.id}
                      ref={(el) => { if (el) rowRefs.current.set(c.id, el); else rowRefs.current.delete(c.id); }}
                      type="button"
                      onClick={() => setSelectedId(c.id)}
                      onContextMenu={(e) => { e.preventDefault(); setSelectedId(c.id); setCtxMenu({ x: e.clientX, y: e.clientY, call: c }); }}
                      aria-selected={selectedRow}
                      className={`block w-full border-b border-l-2 border-rule px-3 py-2.5 text-left ${
                        selectedRow ? 'border-l-accent bg-accent-soft' : 'border-l-transparent hover:bg-paper'
                      }`}
                    >
                      <div className="flex items-center gap-1.5">
                        <span className={isMeeting ? 'text-meeting' : 'text-ink-mute'}>
                          {isMeeting ? <Users size={14} /> : <Phone size={14} />}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{highlight(name, debouncedQuery)}</span>
                        <span className="shrink-0 font-mono text-[12.5px] tabular-nums text-ink">{formatMSTotal(c.durationSec)}</span>
                      </div>
                      <div className="mt-1 flex items-center gap-1.5">
                        <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-mute">
                          {formatHM(c.startTime)}–{c.endTime ? formatHM(c.endTime) : '…'}
                        </span>
                        {cTags.slice(0, 2).map((tn) => (
                          <span key={tn} className="shrink-0 whitespace-nowrap rounded-full border border-rule px-1.5 py-0.5 text-[10.5px] text-ink-mute">{tn}</span>
                        ))}
                        <span className="ml-auto flex shrink-0 items-center gap-1 text-ink-mute">
                          {c.audio && <span title="録音あり"><Mic size={13} className="text-ink-mute" /></span>}
                          {c.transcript && c.transcriptStatus !== 'running' && c.transcriptStatus !== 'queued' && (
                            <span title="文字起こし済"><FileText size={13} className="text-accent-ink" /></span>
                          )}
                          {c.transcriptStatus === 'queued' && (
                            <span className="inline-flex items-center gap-0.5 whitespace-nowrap text-[10.5px] text-pending"><Clock3 size={12} />文字起こし待ち</span>
                          )}
                          {c.transcriptStatus === 'running' && (
                            <span className="inline-flex items-center gap-0.5 whitespace-nowrap text-[10.5px] font-medium text-accent-ink"><Loader2 size={12} className="animate-spin" />文字起こし中 {pct ?? 0}%</span>
                          )}
                          {c.transcriptStatus === 'error' && (
                            <span title={c.transcriptError ?? '文字起こしに失敗しました'}><AlertTriangle size={13} className="text-danger" /></span>
                          )}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="flex-none space-y-1 border-t border-rule px-3 py-2 text-[11.5px] text-ink-mute">
          <div className="flex items-center justify-between gap-2">
            <span>↑↓ で移動・Enter で開く・Delete でゴミ箱へ</span>
          </div>
          {!trashMode && (
            <div className="flex items-center justify-between gap-2">
              <button onClick={() => { setTrashMode(true); setSelectedId(null); }} className="shrink-0 whitespace-nowrap text-accent-ink hover:underline">
                ゴミ箱（{trashCalls.length}）
              </button>
              <span className="min-w-0 truncate">
                {periodLabel} {footerSummary.total}件・通話 {formatHMShort(footerSummary.callSec)}・会議 {formatHMShort(footerSummary.meetingSec)}
              </span>
            </div>
          )}
          <TranscriptionStatusBar />
        </div>
      </div>

      {/* ============ 詳細ペイン ============ */}
      <div ref={detailPaneRef} className="min-w-0 flex-1 overflow-y-auto bg-paper">
        {selected ? (
          <RecordDetail
            key={selected.id}
            call={selected}
            settings={settings}
            allCalls={calls}
            trashMode={trashMode}
            onUpdateSettings={onSaveSettings}
            onMoveToTrash={() => void (async () => {
              const removed = await deleteCallWithConfirm(selected.id, settings.confirmCallDelete);
              if (removed) setSelectedId(null);
            })()}
            onRestore={() => void (async () => {
              await window.api.calls.restore(selected.id);
              toast.success('記録を復元しました');
              setSelectedId(null);
            })()}
            onPurge={() => void (async () => {
              if (!window.confirm('この記録を完全に削除しますか？録音ファイルも削除され、元に戻せません。')) return;
              await window.api.calls.purge(selected.id);
              setSelectedId(null);
            })()}
            onDirtyChange={() => {
              if (pendingManualIdRef.current === selected.id) manualTouchedRef.current = true;
            }}
          />
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-ink-mute">
            左の一覧から記録を選んでください
          </div>
        )}
      </div>

      {/* 右クリックメニュー */}
      {ctxMenu && (
        <div
          className="fixed z-[90] min-w-[14rem] overflow-hidden rounded-lg border border-rule bg-surface py-1 shadow-lg"
          style={{ left: Math.min(ctxMenu.x, window.innerWidth - 230), top: Math.min(ctxMenu.y, window.innerHeight - ctxActions.length * 32 - 12) }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {ctxActions.map((a, i) =>
            a.header ? (
              <div key={i} className="px-3 py-1 text-[11px] font-medium text-ink-mute">{a.label}</div>
            ) : (
              <button
                key={i}
                onClick={() => { setCtxMenu(null); void a.run?.(); }}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${a.danger ? 'text-danger hover:bg-danger-soft' : 'text-ink hover:bg-accent-soft'}`}
              >
                <span className="text-ink-mute">{a.icon}</span>
                {a.label}
              </button>
            ),
          )}
        </div>
      )}

      {audioImport.open && (
        <AudioImportDialog
          settings={settings}
          initialFile={audioImport.file}
          onClose={() => setAudioImport({ open: false, file: null })}
          onImported={(rec) => { toast.success('音声を取り込みました'); setTrashMode(false); setSelectedId(rec.id); }}
        />
      )}

      {importResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" onClick={() => setImportResult(null)}>
          <div className="w-full max-w-md rounded-lg bg-surface p-6 shadow-lg text-ink" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-3 text-lg font-medium">CSV 取り込み完了</h3>
            <ul className="space-y-1 text-sm text-ink">
              <li>新規追加: <span className="font-medium">{importResult.inserted}</span></li>
              <li>更新: <span className="font-medium">{importResult.updated}</span></li>
              <li>スキップ: <span className="font-medium">{importResult.skipped}</span></li>
              <li>エラー: <span className="font-medium">{importResult.errors.length}</span></li>
            </ul>
            {importResult.errors.length > 0 && (
              <div className="mt-3 max-h-40 overflow-auto rounded border border-danger/30 bg-danger-soft p-2 text-xs text-danger">
                {importResult.errors.map((e, i) => <div key={i}>行 {e.row}: {e.message}</div>)}
              </div>
            )}
            <div className="mt-5 flex justify-end">
              <button onClick={() => setImportResult(null)} className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-on-accent hover:bg-accent/90">閉じる</button>
            </div>
          </div>
        </div>
      )}

      {restoreResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" onClick={() => setRestoreResult(null)}>
          <div className="w-full max-w-md rounded-lg bg-surface p-6 shadow-lg text-ink" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-3 text-lg font-medium">JSON 復元完了</h3>
            <div className="space-y-2 text-sm text-ink">
              <p>{restoreResult.calls} 件の記録を取り込みました。</p>
              <p className="break-all text-xs text-ink-mute">復元前のデータは {restoreResult.backupPath} にバックアップ済みです。</p>
            </div>
            <div className="mt-5 flex justify-end">
              <button onClick={() => setRestoreResult(null)} className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-on-accent hover:bg-accent/90">閉じる</button>
            </div>
          </div>
        </div>
      )}

      {dropError && (
        <div className="fixed bottom-14 right-4 z-50 max-w-sm rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger shadow-lg">
          {dropError}
          <button onClick={() => setDropError(null)} className="ml-2 text-xs text-danger hover:underline">閉じる</button>
        </div>
      )}
    </div>
  );
}
