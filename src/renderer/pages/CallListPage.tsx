import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Phone, Users, Mic, Bookmark, FileText, AlertTriangle, Loader2,
  FileAudio, Plus, Upload, Download, SlidersHorizontal, Trash2,
  Pencil, RefreshCw, Undo2, RotateCcw, ChevronUp, ChevronDown,
} from 'lucide-react';
import { AppEvent, CallRecord, Settings, CsvExportOptions, CsvImportResult, getRecordTags } from '../../shared/types';
import { CallEditDialog } from '../components/CallEditDialog';
import { AudioImportDialog, ImportFile } from '../components/AudioImportDialog';
import { deleteCallWithConfirm } from '../hooks/useCalls';
import { formatDateTime, formatHMS } from '../utils/format';
import { highlight } from '../utils/highlight';
import { useToast } from '../components/Toast';
import { toUserMessage } from '../utils/errorMessage';

interface Props {
  calls: CallRecord[];
  settings: Settings;
  /** 'trash' はゴミ箱タブとして動作（削除済みのみ表示） */
  mode?: 'normal' | 'trash';
  initialContactFilter?: string | null;
  onConsumeInitialFilter?: () => void;
  initialEditId?: string | null;
  onConsumeInitialEditId?: () => void;
}

// ============ 列定義（並び替え・表示/非表示・ソートの単位） ============

type ColKey = 'start' | 'end' | 'duration' | 'hold' | 'talk' | 'tag' | 'name' | 'media' | 'memo';

const DEFAULT_ORDER: ColKey[] = ['start', 'end', 'duration', 'hold', 'talk', 'tag', 'name', 'media', 'memo'];

const COL_LABELS: Record<ColKey, string> = {
  start: '開始',
  end: '終了',
  duration: '時間',
  hold: '保留',
  talk: '純通話',
  tag: 'タグ',
  name: '連絡先 / 会議名',
  media: '録音 / 文字起こし',
  memo: 'メモ',
};

const ORDER_KEY = 'callstack.columns.order';
const HIDDEN_KEY = 'callstack.columns.hidden';

function loadOrder(): ColKey[] {
  try {
    const raw = JSON.parse(localStorage.getItem(ORDER_KEY) ?? '[]') as ColKey[];
    const valid = raw.filter((k) => DEFAULT_ORDER.includes(k));
    const missing = DEFAULT_ORDER.filter((k) => !valid.includes(k));
    return [...valid, ...missing];
  } catch {
    return DEFAULT_ORDER;
  }
}

function loadHidden(): ColKey[] {
  try {
    const raw = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '[]') as ColKey[];
    return raw.filter((k) => DEFAULT_ORDER.includes(k));
  } catch {
    return [];
  }
}

const AUDIO_EXT = /\.(mp3|wav|m4a|webm|ogg|aac|flac)$/i;

export function CallListPage({
  calls, settings, mode = 'normal', initialContactFilter, onConsumeInitialFilter, initialEditId, onConsumeInitialEditId,
}: Props) {
  const showTrash = mode === 'trash';
  const toast = useToast();
  const [editing, setEditing] = useState<CallRecord | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filterKind, setFilterKind] = useState<'' | 'call' | 'meeting'>('');
  const [filterTag, setFilterTag] = useState<string>('');
  const [filterContact, setFilterContact] = useState<string>('');
  const [showUntagged, setShowUntagged] = useState(false);
  const [filterRange, setFilterRange] = useState<CsvExportOptions['range']>('all');
  const [importResult, setImportResult] = useState<CsvImportResult | null>(null);
  const [restoreResult, setRestoreResult] = useState<{ calls: number; backupPath: string } | null>(null);
  const [dropError, setDropError] = useState<string | null>(null);
  const [dragDepth, setDragDepth] = useState(0);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; call: CallRecord } | null>(null);
  const [colMenu, setColMenu] = useState<{ x: number; y: number } | null>(null);
  const [audioImport, setAudioImport] = useState<{ open: boolean; file: ImportFile | null }>({ open: false, file: null });
  // 詳細フィルタ
  const [showDetailFilter, setShowDetailFilter] = useState(false);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [hasAudio, setHasAudio] = useState<'' | 'yes' | 'no'>('');
  const [hasTranscript, setHasTranscript] = useState<'' | 'yes' | 'no'>('');

  // 列の並び・表示状態（この端末に保存）
  const [colOrder, setColOrder] = useState<ColKey[]>(loadOrder);
  const [hiddenCols, setHiddenCols] = useState<ColKey[]>(loadHidden);
  const [dragCol, setDragCol] = useState<ColKey | null>(null);
  const [dropTarget, setDropTarget] = useState<ColKey | null>(null);
  // ソート状態（左クリックで昇順⇄降順）
  const [sort, setSort] = useState<{ key: ColKey; dir: 'asc' | 'desc' }>({ key: 'start', dir: 'desc' });

  // 文字起こしの進捗 (callId -> %)
  const [progress, setProgress] = useState<Record<string, number>>({});

  // 検索はデバウンスして、キー入力ごとの全件走査を避ける
  const [debouncedQuery, setDebouncedQuery] = useState('');
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQuery(query), 200);
    return () => window.clearTimeout(t);
  }, [query]);

  // 検索対象テキストは記録ごとに事前結合しておく（文字起こし全文の join を検索のたびに行わない）
  const haystacks = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of calls) {
      m.set(c.id, [
        c.memo,
        c.contactName ?? '',
        c.phoneNumber ?? '',
        c.title ?? '',
        c.participants?.join(' ') ?? '',
        getRecordTags(c).join(' '),
        c.transcript?.text ?? '',
      ].join(' ').toLowerCase());
    }
    return m;
  }, [calls]);

  // 仮想スクロール（大量の記録でも一覧が軽いまま）
  const ROW_H = 45;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(600);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const obs = new ResizeObserver(() => setViewportH(el.clientHeight));
    obs.observe(el);
    setViewportH(el.clientHeight);
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    localStorage.setItem(ORDER_KEY, JSON.stringify(colOrder));
  }, [colOrder]);
  useEffect(() => {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(hiddenCols));
  }, [hiddenCols]);

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

  // ヘッダーの ︙ メニューからのアクションを受け付ける
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
  }, [filterRange]);

  // Receive cross-page contact filter
  useEffect(() => {
    if (initialContactFilter) {
      setFilterContact(initialContactFilter);
      onConsumeInitialFilter?.();
    }
  }, [initialContactFilter, onConsumeInitialFilter]);

  // HUD の編集ボタンなどから指定された記録の編集を開く
  useEffect(() => {
    if (!initialEditId) return;
    const target = calls.find((c) => c.id === initialEditId);
    if (target) {
      setEditing(target);
      onConsumeInitialEditId?.();
    }
  }, [initialEditId, calls, onConsumeInitialEditId]);

  // メニューは外側クリック・Esc・スクロールで閉じる
  useEffect(() => {
    if (!ctxMenu && !colMenu) return;
    const close = () => { setCtxMenu(null); setColMenu(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [ctxMenu, colMenu]);

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

  // ============ ソート ============

  const sortValue = (c: CallRecord, key: ColKey): string | number => {
    switch (key) {
      case 'start': return c.startTime;
      case 'end': return c.endTime ?? '￿';           // 進行中は最後へ
      case 'duration': return c.durationSec ?? -1;
      case 'hold': return c.holdSec ?? 0;
      case 'talk': return c.durationSec === null ? -1 : Math.max(0, c.durationSec - (c.holdSec ?? 0));
      case 'tag': return getRecordTags(c).join(', ');
      case 'name': return (c.kind === 'meeting' ? c.title : c.contactName) ?? '';
      case 'media': return (c.audio ? 2 : 0) + (c.transcript ? 1 : 0);
      case 'memo': return c.memo || c.transcript?.text || '';
    }
  };

  const filtered = useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase();
    const source = showTrash ? trashCalls : aliveCalls;
    const fromMs = dateFrom ? new Date(dateFrom).getTime() : null;
    const toMs = dateTo ? new Date(dateTo).getTime() + 24 * 60 * 60 * 1000 : null;
    // 期間セレクト（全期間/今週/今月）
    let rangeFrom: number | null = null;
    let rangeTo: number | null = null;
    if (filterRange === 'thisWeek') {
      const now = new Date();
      const monday = new Date(now);
      monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
      monday.setHours(0, 0, 0, 0);
      rangeFrom = monday.getTime();
      rangeTo = rangeFrom + 7 * 24 * 60 * 60 * 1000;
    } else if (filterRange === 'thisMonth') {
      const now = new Date();
      rangeFrom = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
      rangeTo = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
    }
    const base = source.filter((c) => {
      const kind = c.kind ?? 'call';
      if (filterKind && kind !== filterKind) return false;
      const cTags = getRecordTags(c);
      if (showUntagged && cTags.length > 0) return false;
      if (filterTag && !cTags.includes(filterTag)) return false;
      if (filterContact && c.contactName !== filterContact) return false;
      const t = new Date(c.startTime).getTime();
      if (fromMs !== null && t < fromMs) return false;
      if (toMs !== null && t >= toMs) return false;
      if (rangeFrom !== null && t < rangeFrom) return false;
      if (rangeTo !== null && t >= rangeTo) return false;
      if (hasAudio === 'yes' && !c.audio) return false;
      if (hasAudio === 'no' && c.audio) return false;
      if (hasTranscript === 'yes' && !c.transcript) return false;
      if (hasTranscript === 'no' && c.transcript) return false;
      if (!q) return true;
      return (haystacks.get(c.id) ?? '').includes(q);
    });
    const dir = sort.dir === 'asc' ? 1 : -1;
    return base.sort((a, b) => {
      const av = sortValue(a, sort.key);
      const bv = sortValue(b, sort.key);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      // 第2キーは開始日時の新しい順で安定させる
      return b.startTime.localeCompare(a.startTime);
    });
  }, [aliveCalls, trashCalls, showTrash, debouncedQuery, haystacks, filterKind, filterTag, filterContact, showUntagged, filterRange, dateFrom, dateTo, hasAudio, hasTranscript, sort]);

  // 仮想化の可視範囲（少件数では全件描画）
  const virtualized = filtered.length > 150;
  const startIdx = virtualized ? Math.max(0, Math.floor(scrollTop / ROW_H) - 10) : 0;
  const endIdx = virtualized ? Math.min(filtered.length, Math.ceil((scrollTop + viewportH) / ROW_H) + 10) : filtered.length;
  const visibleRows = filtered.slice(startIdx, endIdx);
  const padTop = startIdx * ROW_H;
  const padBottom = (filtered.length - endIdx) * ROW_H;

  // Delete-key handler with focus / dialog awareness.
  useEffect(() => {
    const handler = async (e: KeyboardEvent) => {
      if (e.key !== 'Delete') return;
      if (editing || importResult || audioImport.open) return;
      const t = document.activeElement as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return;
      if (!selectedId) return;
      const target = calls.find((c) => c.id === selectedId);
      if (!target) return;
      e.preventDefault();
      if (showTrash) {
        if (window.confirm('この記録を完全に削除しますか？録音ファイルも削除され、元に戻せません。')) {
          await window.api.calls.purge(selectedId);
          setSelectedId(null);
        }
        return;
      }
      const removed = await deleteCallWithConfirm(selectedId, settings.confirmCallDelete);
      if (removed) setSelectedId(null);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedId, calls, editing, importResult, audioImport.open, showTrash, settings.confirmCallDelete]);

  const handleExport = async () => {
    const r = await window.api.csv.export({ range: filterRange });
    if (!r.canceled) toast.success(`${r.count} 件を ${r.path} にエクスポートしました`);
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
        setAudioImport({
          open: true,
          file: { path: p, name: file.name, mtime: new Date(file.lastModified).toISOString() },
        });
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
    setEditing(rec);
  };

  const showSaveResult = (r: { canceled: boolean; path?: string; error?: string }) => {
    if (r.canceled) return;
    if (r.error) toast.error(r.error);
    else toast.success(`保存しました: ${r.path}`);
  };

  const ctxActions: Array<{ label: string; icon: React.ReactNode; danger?: boolean; run: () => void | Promise<void> }> = !ctxMenu
    ? []
    : showTrash
    ? [
        {
          label: '復元',
          icon: <Undo2 size={14} />,
          run: async () => {
            await window.api.calls.restore(ctxMenu.call.id);
            toast.success('記録を復元しました');
          },
        },
        {
          label: '完全に削除',
          icon: <Trash2 size={14} />,
          danger: true,
          run: async () => {
            if (!window.confirm('この記録を完全に削除しますか？録音ファイルも削除され、元に戻せません。')) return;
            await window.api.calls.purge(ctxMenu.call.id);
          },
        },
      ]
    : [
        {
          label: '編集',
          icon: <Pencil size={14} />,
          run: () => setEditing(ctxMenu.call),
        },
        ...(ctxMenu.call.audio && ctxMenu.call.transcriptStatus !== 'running' && ctxMenu.call.transcriptStatus !== 'queued'
          ? [{
              label: ctxMenu.call.transcript ? '再文字起こし' : '文字起こしを開始',
              icon: <RefreshCw size={14} />,
              run: async () => {
                const r = await window.api.transcription.start(ctxMenu.call.id);
                if (!r.ok) toast.error(r.error);
                else toast.info('文字起こしを開始しました');
              },
            }]
          : []),
        ...(ctxMenu.call.audio
          ? [{
              label: '録音 (MP3) を保存…',
              icon: <Download size={14} />,
              run: async () => showSaveResult(await window.api.recording.saveAs(ctxMenu.call.id)),
            }]
          : []),
        ...(ctxMenu.call.transcript
          ? [{
              label: '文字起こしを保存…',
              icon: <Download size={14} />,
              run: async () => showSaveResult(await window.api.transcript.saveAs(ctxMenu.call.id, false)),
            }]
          : []),
        {
          label: '議事録 (MD) を保存…',
          icon: <FileText size={14} />,
          run: async () => showSaveResult(await window.api.minutes.saveAs(ctxMenu.call.id)),
        },
        {
          label: '削除',
          icon: <Trash2 size={14} />,
          danger: true,
          run: async () => {
            const removed = await deleteCallWithConfirm(ctxMenu.call.id, settings.confirmCallDelete);
            if (removed && selectedId === ctxMenu.call.id) setSelectedId(null);
          },
        },
      ];

  // ============ セル描画 ============

  const renderCell = (c: CallRecord, key: ColKey): React.ReactNode => {
    switch (key) {
      case 'start':
        return (
          <td key={key} className="px-4 py-3 font-mono text-xs tabular-nums text-slate-700 dark:text-slate-300">
            <span className="mr-1.5 inline-block align-[-2px]" title={c.kind === 'meeting' ? '会議' : '通話'}>
              {c.kind === 'meeting'
                ? <Users size={13} className="text-violet-500" />
                : <Phone size={13} className="text-brand-600 dark:text-brand-400" />}
            </span>
            {formatDateTime(c.startTime)}
          </td>
        );
      case 'end':
        return (
          <td key={key} className="px-4 py-3 font-mono text-xs tabular-nums text-slate-700 dark:text-slate-300">
            {c.endTime ? formatDateTime(c.endTime) : <span className="text-emerald-600 dark:text-emerald-400">{c.kind === 'meeting' ? '会議中…' : '通話中…'}</span>}
          </td>
        );
      case 'duration':
        return (
          <td key={key} className="px-4 py-3 text-right font-mono tabular-nums text-slate-900 dark:text-slate-100">
            {c.durationSec === null ? '—' : formatHMS(c.durationSec)}
          </td>
        );
      case 'hold': {
        const hold = c.holdSec ?? 0;
        return (
          <td key={key} className="px-4 py-3 text-right font-mono tabular-nums text-amber-600 dark:text-amber-400">
            {hold ? formatHMS(hold) : '—'}
          </td>
        );
      }
      case 'talk': {
        const hold = c.holdSec ?? 0;
        const talk = c.durationSec === null ? null : Math.max(0, c.durationSec - hold);
        return (
          <td key={key} className="px-4 py-3 text-right font-mono tabular-nums text-slate-900 dark:text-slate-100">
            {talk === null ? '—' : formatHMS(talk)}
          </td>
        );
      }
      case 'tag': {
        const cTags = getRecordTags(c);
        return (
          <td key={key} className="px-4 py-3">
            {cTags.length > 0 ? (
              <span className="flex flex-wrap gap-1">
                {cTags.map((tn) => (
                  <span
                    key={tn}
                    className="inline-block rounded-full px-2 py-0.5 text-xs font-medium text-white"
                    style={{ backgroundColor: tagColor[tn] ?? '#94a3b8' }}
                  >
                    {highlight(tn, debouncedQuery)}
                  </span>
                ))}
              </span>
            ) : (
              <span className="text-xs text-slate-400">—</span>
            )}
          </td>
        );
      }
      case 'name':
        return (
          <td key={key} className="px-4 py-3 text-slate-700 dark:text-slate-300">
            {c.kind === 'meeting'
              ? (c.title ? highlight(c.title, debouncedQuery) : <span className="text-xs text-slate-400">（会議名未設定）</span>)
              : (c.contactName ? highlight(c.contactName, debouncedQuery) : '—')}
          </td>
        );
      case 'media': {
        const pct = progress[c.id];
        return (
          <td key={key} className="px-4 py-3 text-center">
            <span className="inline-flex items-center justify-center gap-1 whitespace-nowrap text-base">
              {c.audio && <span title="録音あり"><Mic size={14} className="text-slate-500 dark:text-slate-400" /></span>}
              {c.markers && c.markers.length > 0 && <span className="inline-flex items-center gap-0.5 text-xs text-slate-500 dark:text-slate-400" title={`マーカー ${c.markers.length} 個`}><Bookmark size={13} />{c.markers.length}</span>}
              {c.transcript && c.transcriptStatus !== 'running' && c.transcriptStatus !== 'queued' && <span title="文字起こし済"><FileText size={14} className="text-emerald-600 dark:text-emerald-400" /></span>}
              {c.transcriptStatus === 'queued' && <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-slate-500" title="文字起こし待機中"><Loader2 size={13} className="shrink-0 animate-spin" />待機</span>}
              {c.transcriptStatus === 'running' && (
                <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-semibold text-brand-600 dark:text-brand-300" title="文字起こし中">
                  <Loader2 size={13} className="shrink-0 animate-spin" />{pct ?? 0}%
                </span>
              )}
              {c.transcriptStatus === 'error' && (
                <span title={c.transcriptError ?? '文字起こしに失敗しました'}><AlertTriangle size={14} className="text-amber-500" /></span>
              )}
            </span>
          </td>
        );
      }
      case 'memo':
        return (
          <td key={key} className="max-w-xs truncate px-4 py-3 text-slate-700 dark:text-slate-300">
            {c.memo
              ? highlight(c.memo, debouncedQuery)
              : c.transcript?.text
                ? highlight(c.transcript.text, debouncedQuery)
                : '—'}
          </td>
        );
    }
  };

  const visibleCols = colOrder.filter((k) => !hiddenCols.includes(k));

  const moveColumn = (from: ColKey, to: ColKey) => {
    if (from === to) return;
    setColOrder((prev) => {
      const next = prev.filter((k) => k !== from);
      const idx = next.indexOf(to);
      next.splice(idx < 0 ? next.length : idx, 0, from);
      return next;
    });
  };

  const toggleColumn = (key: ColKey) => {
    setHiddenCols((prev) => {
      if (prev.includes(key)) return prev.filter((k) => k !== key);
      // 全列非表示は防ぐ
      if (visibleCols.length <= 1) return prev;
      return [...prev, key];
    });
  };

  const untaggedCount = calls.filter((c) => c.endTime && getRecordTags(c).length === 0).length;
  const thAlignRight = (k: ColKey) => k === 'duration' || k === 'hold' || k === 'talk';

  return (
    <div
      className="relative space-y-4 p-6"
      onDragEnter={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragDepth((d) => d + 1);
        }
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDragLeave={() => setDragDepth((d) => Math.max(0, d - 1))}
      onDrop={(e) => {
        e.preventDefault();
        setDragDepth(0);
        const file = e.dataTransfer.files?.[0];
        if (file) void handleDropFile(file);
      }}
    >
      {dragDepth > 0 && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-brand-500/20 backdrop-blur-sm">
          <div className="rounded-xl border-2 border-dashed border-brand-500 bg-white px-6 py-4 text-base font-semibold text-brand-700 shadow-2xl dark:bg-slate-900 dark:text-brand-200">
            ドロップで取り込み（CSV / JSON復元 / 音声ファイル）
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && query) {
              setQuery('');
              e.currentTarget.blur();
            }
          }}
          placeholder="検索（メモ・連絡先・会議名・文字起こし） — Esc でクリア"
          className="flex-1 min-w-[240px] rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
        />
        <select
          value={filterKind}
          onChange={(e) => setFilterKind(e.target.value as '' | 'call' | 'meeting')}
          className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
        >
          <option value="">通話+会議</option>
          <option value="call">通話のみ</option>
          <option value="meeting">会議のみ</option>
        </select>
        <select
          value={filterTag}
          onChange={(e) => { setFilterTag(e.target.value); setShowUntagged(false); }}
          className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
        >
          <option value="">すべてのタグ</option>
          {settings.tags.map((t) => (
            <option key={t.name} value={t.name}>{t.name}</option>
          ))}
        </select>
        <select
          value={filterContact}
          onChange={(e) => setFilterContact(e.target.value)}
          className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
        >
          <option value="">すべての連絡先</option>
          {allContacts.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <select
          value={filterRange}
          onChange={(e) => setFilterRange(e.target.value as CsvExportOptions['range'])}
          className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          title="期間で絞り込み（CSV エクスポートもこの範囲が対象）"
        >
          <option value="all">全期間</option>
          <option value="thisWeek">今週</option>
          <option value="thisMonth">今月</option>
        </select>
        <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
          <input
            type="checkbox"
            checked={showUntagged}
            onChange={(e) => { setShowUntagged(e.target.checked); if (e.target.checked) setFilterTag(''); }}
          />
          未タグのみ ({untaggedCount})
        </label>
        <button
          onClick={() => setShowDetailFilter((v) => !v)}
          className={`rounded-md border px-3 py-2 text-sm font-medium ${
            showDetailFilter || dateFrom || dateTo || hasAudio || hasTranscript
              ? 'border-brand-400 bg-brand-50 text-brand-700 dark:border-brand-700 dark:bg-brand-900/40 dark:text-brand-200'
              : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700'
          }`}
          title="期間・録音有無などで絞り込み"
        >
          <SlidersHorizontal size={14} className="mr-1 inline align-[-2px]" />詳細
        </button>
      </div>

      {showDetailFilter && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">期間</span>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          />
          <span className="text-slate-400">〜</span>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          />
          <span className="ml-2 text-xs font-semibold text-slate-500 dark:text-slate-400">録音</span>
          <select
            value={hasAudio}
            onChange={(e) => setHasAudio(e.target.value as '' | 'yes' | 'no')}
            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          >
            <option value="">指定なし</option>
            <option value="yes">あり</option>
            <option value="no">なし</option>
          </select>
          <span className="ml-2 text-xs font-semibold text-slate-500 dark:text-slate-400">文字起こし</span>
          <select
            value={hasTranscript}
            onChange={(e) => setHasTranscript(e.target.value as '' | 'yes' | 'no')}
            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          >
            <option value="">指定なし</option>
            <option value="yes">あり</option>
            <option value="no">なし</option>
          </select>
          <button
            onClick={() => { setDateFrom(''); setDateTo(''); setHasAudio(''); setHasTranscript(''); }}
            className="ml-auto text-xs text-slate-500 underline hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
          >
            クリア
          </button>
        </div>
      )}

      {showTrash && (
        <div className="flex items-center justify-between rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          <span className="inline-flex items-center gap-1.5"><Trash2 size={14} />削除から30日で自動的に完全削除されます。行を右クリックすると復元できます。</span>
          {trashCalls.length > 0 && (
            <button
              onClick={async () => {
                if (!window.confirm(`ゴミ箱の ${trashCalls.length} 件を完全に削除しますか？録音ファイルも削除され、元に戻せません。`)) return;
                const n = await window.api.calls.purgeTrash();
                toast.success(`${n} 件を完全に削除しました`);
              }}
              className="rounded-md border border-red-300 bg-white px-3 py-1 text-xs font-semibold text-red-700 hover:bg-red-100 dark:border-red-800 dark:bg-slate-900 dark:text-red-300 dark:hover:bg-red-900"
            >
              ゴミ箱を空にする
            </button>
          )}
        </div>
      )}

      <div
        ref={scrollRef}
        onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
        className="max-h-[calc(100vh-16rem)] overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900"
      >
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 shadow-sm dark:bg-slate-800 dark:text-slate-400">
            <tr
              onContextMenu={(e) => {
                e.preventDefault();
                setColMenu({ x: e.clientX, y: e.clientY });
              }}
            >
              {visibleCols.map((key) => (
                <th
                  key={key}
                  draggable
                  onDragStart={(e) => {
                    setDragCol(key);
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    if (dragCol && dragCol !== key) setDropTarget(key);
                  }}
                  onDragLeave={() => setDropTarget((t) => (t === key ? null : t))}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragCol) moveColumn(dragCol, key);
                    setDragCol(null);
                    setDropTarget(null);
                  }}
                  onDragEnd={() => { setDragCol(null); setDropTarget(null); }}
                  onClick={() => setSort((prev) => ({
                    key,
                    dir: prev.key === key && prev.dir === 'desc' ? 'asc' : prev.key === key ? 'desc' : 'desc',
                  }))}
                  className={`cursor-pointer select-none px-4 py-3 transition ${thAlignRight(key) ? 'text-right' : key === 'media' ? 'w-36 whitespace-nowrap text-center' : ''} ${
                    dropTarget === key ? 'bg-brand-100 dark:bg-brand-900/50' : 'hover:bg-slate-100 dark:hover:bg-slate-700/60'
                  } ${dragCol === key ? 'opacity-50' : ''}`}
                  title="クリックで並び替え / ドラッグで列を移動 / 右クリックで表示する列を選択"
                >
                  <span className="inline-flex items-center gap-1">
                    {COL_LABELS[key]}
                    {sort.key === key && (
                      sort.dir === 'asc'
                        ? <ChevronUp size={13} className="text-brand-600 dark:text-brand-300" />
                        : <ChevronDown size={13} className="text-brand-600 dark:text-brand-300" />
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={visibleCols.length} className="px-4 py-16 text-center">
                  {showTrash ? (
                    <div className="text-slate-400 dark:text-slate-500">ゴミ箱は空です</div>
                  ) : (
                    <div className="space-y-3">
                      <div className="flex justify-center"><Phone size={32} strokeWidth={1.5} className="text-slate-300 dark:text-slate-600" /></div>
                      <div className="text-sm text-slate-500 dark:text-slate-400">
                        {calls.length === 0 ? 'まだ記録がありません' : '条件に一致する記録がありません'}
                      </div>
                      {calls.length === 0 && (
                        <div className="text-xs text-slate-400 dark:text-slate-500">
                          右上の「録音」ボタン、または {settings.shortcuts.startCall}（通話）/ {settings.shortcuts.startMeeting}（会議）で開始できます。
                          <br />音声ファイルをこの画面にドラッグ&ドロップして取り込むこともできます。
                        </div>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            )}
            {padTop > 0 && <tr aria-hidden style={{ height: padTop }} />}
            {visibleRows.map((c) => {
              const selected = c.id === selectedId;
              return (
                <tr
                  key={c.id}
                  onClick={() => setSelectedId(c.id)}
                  onDoubleClick={() => setEditing(c)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setSelectedId(c.id);
                    setCtxMenu({ x: e.clientX, y: e.clientY, call: c });
                  }}
                  className={`cursor-pointer border-t border-slate-100 dark:border-slate-800 ${
                    selected
                      ? 'bg-brand-50 dark:bg-brand-900/40'
                      : 'hover:bg-slate-50 dark:hover:bg-slate-800/60'
                  }`}
                  title="クリックで選択 / ダブルクリックで編集 / 右クリックでメニュー / Delete キーで削除"
                >
                  {visibleCols.map((key) => renderCell(c, key))}
                </tr>
              );
            })}
            {padBottom > 0 && <tr aria-hidden style={{ height: padBottom }} />}
          </tbody>
        </table>
      </div>

      {/* 行の右クリックメニュー */}
      {ctxMenu && (
        <div
          className="fixed z-[90] min-w-[13rem] overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-xl dark:border-slate-700 dark:bg-slate-800"
          style={{
            left: Math.min(ctxMenu.x, window.innerWidth - 220),
            top: Math.min(ctxMenu.y, window.innerHeight - ctxActions.length * 34 - 12),
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {ctxActions.map((a, i) => (
            <button
              key={i}
              onClick={() => {
                setCtxMenu(null);
                void a.run();
              }}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${
                a.danger
                  ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950'
                  : 'text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-700'
              }`}
            >
              <span className="text-slate-400">{a.icon}</span>
              {a.label}
            </button>
          ))}
        </div>
      )}

      {/* ヘッダー右クリック: 列の表示/非表示 */}
      {colMenu && (
        <div
          className="fixed z-[90] min-w-[12rem] overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-xl dark:border-slate-700 dark:bg-slate-800"
          style={{
            left: Math.min(colMenu.x, window.innerWidth - 200),
            top: Math.min(colMenu.y, window.innerHeight - DEFAULT_ORDER.length * 30 - 60),
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="px-3 py-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400">表示する列</div>
          {colOrder.map((key) => (
            <label
              key={key}
              className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-700"
            >
              <input
                type="checkbox"
                checked={!hiddenCols.includes(key)}
                onChange={() => toggleColumn(key)}
              />
              {COL_LABELS[key]}
            </label>
          ))}
          <div className="mt-1 border-t border-slate-200 dark:border-slate-700">
            <button
              onClick={() => { setColOrder(DEFAULT_ORDER); setHiddenCols([]); setColMenu(null); }}
              className="block w-full px-3 py-1.5 text-left text-xs text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-700"
            >
              <RotateCcw size={12} className="mr-1 inline align-[-1px]" />列の並び・表示をリセット
            </button>
          </div>
        </div>
      )}

      {editing && (
        <CallEditDialog
          call={editing}
          settings={settings}
          allCalls={calls}
          onClose={() => setEditing(null)}
        />
      )}

      {audioImport.open && (
        <AudioImportDialog
          settings={settings}
          initialFile={audioImport.file}
          onClose={() => setAudioImport({ open: false, file: null })}
          onImported={(rec) => {
            toast.success('音声を取り込みました');
            setEditing(rec);
          }}
        />
      )}

      {importResult && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          onClick={() => setImportResult(null)}
        >
          <div
            className="w-full max-w-md rounded-xl bg-white p-6 shadow-2xl dark:bg-slate-900 dark:text-slate-100"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-3 text-lg font-bold">CSV インポート完了</h3>
            <ul className="space-y-1 text-sm text-slate-800 dark:text-slate-200">
              <li>新規追加: <span className="font-semibold">{importResult.inserted}</span></li>
              <li>更新: <span className="font-semibold">{importResult.updated}</span></li>
              <li>スキップ: <span className="font-semibold">{importResult.skipped}</span></li>
              <li>エラー: <span className="font-semibold">{importResult.errors.length}</span></li>
            </ul>
            {importResult.errors.length > 0 && (
              <div className="mt-3 max-h-40 overflow-auto rounded border border-red-200 bg-red-50 p-2 text-xs dark:border-red-900 dark:bg-red-950 dark:text-red-200">
                {importResult.errors.map((e, i) => (
                  <div key={i}>行 {e.row}: {e.message}</div>
                ))}
              </div>
            )}
            <div className="mt-5 flex justify-end">
              <button
                onClick={() => setImportResult(null)}
                className="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}

      {restoreResult && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          onClick={() => setRestoreResult(null)}
        >
          <div
            className="w-full max-w-md rounded-xl bg-white p-6 shadow-2xl dark:bg-slate-900 dark:text-slate-100"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-3 text-lg font-bold">JSON 復元完了</h3>
            <div className="space-y-2 text-sm text-slate-800 dark:text-slate-200">
              <p>{restoreResult.calls} 件の通話記録を読み込みました。</p>
              <p className="break-all text-xs text-slate-500 dark:text-slate-400">
                復元前のデータは {restoreResult.backupPath} にバックアップ済みです。
              </p>
            </div>
            <div className="mt-5 flex justify-end">
              <button
                onClick={() => setRestoreResult(null)}
                className="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}

      {dropError && (
        <div className="fixed bottom-14 right-4 z-50 max-w-sm rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 shadow-lg dark:border-red-700 dark:bg-red-950 dark:text-red-200">
          {dropError}
          <button
            onClick={() => setDropError(null)}
            className="ml-2 text-xs text-red-600 hover:underline dark:text-red-300"
          >
            閉じる
          </button>
        </div>
      )}
    </div>
  );
}
