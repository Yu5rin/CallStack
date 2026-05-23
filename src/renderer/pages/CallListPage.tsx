import { useEffect, useMemo, useState } from 'react';
import { CallRecord, Settings, CsvExportOptions, CsvImportResult } from '../../shared/types';
import { CallEditDialog } from '../components/CallEditDialog';
import { deleteCallWithConfirm } from '../hooks/useCalls';
import { formatDateTime, formatHMS } from '../utils/format';

interface Props {
  calls: CallRecord[];
  settings: Settings;
  initialContactFilter?: string | null;
  onConsumeInitialFilter?: () => void;
}

export function CallListPage({ calls, settings, initialContactFilter, onConsumeInitialFilter }: Props) {
  const [editing, setEditing] = useState<CallRecord | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filterTag, setFilterTag] = useState<string>('');
  const [filterContact, setFilterContact] = useState<string>('');
  const [showUntagged, setShowUntagged] = useState(false);
  const [exportRange, setExportRange] = useState<CsvExportOptions['range']>('all');
  const [importResult, setImportResult] = useState<CsvImportResult | null>(null);

  // Receive cross-page contact filter
  useEffect(() => {
    if (initialContactFilter) {
      setFilterContact(initialContactFilter);
      onConsumeInitialFilter?.();
    }
  }, [initialContactFilter, onConsumeInitialFilter]);

  const tagColor = useMemo(() => {
    const m: Record<string, string> = {};
    for (const t of settings.tags) m[t.name] = t.color;
    return m;
  }, [settings.tags]);

  const allContacts = useMemo(() => {
    const set = new Set<string>();
    for (const c of calls) if (c.contactName) set.add(c.contactName);
    return [...set].sort();
  }, [calls]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return calls
      .slice()
      .sort((a, b) => b.startTime.localeCompare(a.startTime))
      .filter((c) => {
        if (showUntagged && c.tag) return false;
        if (filterTag && c.tag !== filterTag) return false;
        if (filterContact && c.contactName !== filterContact) return false;
        if (!q) return true;
        const hay = [
          c.memo,
          c.contactName ?? '',
          c.phoneNumber ?? '',
          c.tag ?? '',
          c.transcript?.text ?? '',
        ].join(' ').toLowerCase();
        return hay.includes(q);
      });
  }, [calls, query, filterTag, filterContact, showUntagged]);

  // Delete-key handler with focus / dialog awareness.
  useEffect(() => {
    const handler = async (e: KeyboardEvent) => {
      if (e.key !== 'Delete') return;
      if (editing || importResult) return;
      const t = document.activeElement as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return;
      if (!selectedId) return;
      const target = calls.find((c) => c.id === selectedId);
      if (!target) return;
      e.preventDefault();
      const removed = await deleteCallWithConfirm(selectedId, settings.confirmCallDelete);
      if (removed) setSelectedId(null);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedId, calls, editing, importResult, settings.confirmCallDelete]);

  const handleExport = async () => {
    const r = await window.api.csv.export({ range: exportRange });
    if (!r.canceled) alert(`${r.count} 件を ${r.path} にエクスポートしました`);
  };

  const handleImport = async () => {
    const r = await window.api.csv.import();
    if (r.canceled) return;
    setImportResult(r.result);
  };

  const handleWeeklyReport = async () => {
    const r = await window.api.report.weekly();
    if (!r.canceled) alert(`週次レポートを ${r.path} に保存しました`);
  };

  const handleAddManual = async () => {
    const now = new Date().toISOString();
    const ago = new Date(Date.now() - 60_000).toISOString();
    const rec = await window.api.calls.create({ startTime: ago, endTime: now });
    setEditing(rec);
  };

  const untaggedCount = calls.filter((c) => c.endTime && !c.tag).length;

  return (
    <div className="space-y-4 p-6">
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
          placeholder="検索（メモ・連絡先・電話・文字起こし） — Esc でクリア"
          className="flex-1 min-w-[240px] rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
        />
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
        <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
          <input
            type="checkbox"
            checked={showUntagged}
            onChange={(e) => { setShowUntagged(e.target.checked); if (e.target.checked) setFilterTag(''); }}
          />
          未タグのみ ({untaggedCount})
        </label>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={handleAddManual}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
          >
            手動追加
          </button>
          <button
            onClick={handleImport}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
          >
            CSV インポート
          </button>
          <select
            value={exportRange}
            onChange={(e) => setExportRange(e.target.value as CsvExportOptions['range'])}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          >
            <option value="all">全期間</option>
            <option value="thisWeek">今週</option>
            <option value="thisMonth">今月</option>
          </select>
          <button
            onClick={handleExport}
            className="rounded-md bg-brand-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-brand-700"
          >
            CSV エクスポート
          </button>
          <button
            onClick={handleWeeklyReport}
            className="rounded-md border border-brand-300 bg-brand-50 px-3 py-2 text-sm font-medium text-brand-700 hover:bg-brand-100 dark:border-brand-700 dark:bg-brand-900/40 dark:text-brand-200 dark:hover:bg-brand-900/60"
          >
            週次レポート (MD)
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            <tr>
              <th className="px-4 py-3">開始</th>
              <th className="px-4 py-3">終了</th>
              <th className="px-4 py-3 text-right">通話</th>
              <th className="px-4 py-3 text-right">保留</th>
              <th className="px-4 py-3 text-right">純通話</th>
              <th className="px-4 py-3">タグ</th>
              <th className="px-4 py-3">連絡先</th>
              <th className="px-4 py-3 w-10 text-center">録音</th>
              <th className="px-4 py-3">メモ / 文字起こし</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-12 text-center text-slate-400 dark:text-slate-500">
                  記録がありません。{settings.shortcuts.startCall} で通話を開始しましょう。
                </td>
              </tr>
            )}
            {filtered.map((c) => {
              const hold = c.holdSec ?? 0;
              const talk = c.durationSec === null ? null : Math.max(0, c.durationSec - hold);
              const selected = c.id === selectedId;
              return (
                <tr
                  key={c.id}
                  onClick={() => setSelectedId(c.id)}
                  onDoubleClick={() => setEditing(c)}
                  className={`cursor-pointer border-t border-slate-100 dark:border-slate-800 ${
                    selected
                      ? 'bg-brand-50 dark:bg-brand-900/40'
                      : 'hover:bg-slate-50 dark:hover:bg-slate-800/60'
                  }`}
                  title="クリックで選択 / ダブルクリックで編集 / Delete キーで削除"
                >
                  <td className="px-4 py-3 font-mono text-xs tabular-nums text-slate-700 dark:text-slate-300">{formatDateTime(c.startTime)}</td>
                  <td className="px-4 py-3 font-mono text-xs tabular-nums text-slate-700 dark:text-slate-300">
                    {c.endTime ? formatDateTime(c.endTime) : <span className="text-emerald-600 dark:text-emerald-400">通話中…</span>}
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-900 dark:text-slate-100">
                    {c.durationSec === null ? '—' : formatHMS(c.durationSec)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums text-amber-600 dark:text-amber-400">
                    {hold ? formatHMS(hold) : '—'}
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-900 dark:text-slate-100">
                    {talk === null ? '—' : formatHMS(talk)}
                  </td>
                  <td className="px-4 py-3">
                    {c.tag ? (
                      <span
                        className="inline-block rounded-full px-2 py-0.5 text-xs font-medium text-white"
                        style={{ backgroundColor: tagColor[c.tag] ?? '#94a3b8' }}
                      >
                        {c.tag}
                      </span>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-700 dark:text-slate-300">{c.contactName || '—'}</td>
                  <td className="px-4 py-3 text-center text-base">
                    {c.audio && <span title="録音あり">🎤</span>}
                    {c.transcript && <span title="文字起こし済">📝</span>}
                    {c.transcriptStatus === 'queued' && <span title="文字起こし待機">⏳</span>}
                    {c.transcriptStatus === 'running' && <span title="文字起こし中">⏳</span>}
                    {c.transcriptStatus === 'error' && (
                      <span title={c.transcriptError ?? '文字起こしに失敗しました'}>⚠️</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-700 dark:text-slate-300 max-w-xs truncate">
                    {c.memo || c.transcript?.text || '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editing && (
        <CallEditDialog
          call={editing}
          settings={settings}
          allCalls={calls}
          onClose={() => setEditing(null)}
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
              <li>✅ 新規追加: <span className="font-semibold">{importResult.inserted}</span></li>
              <li>🔄 更新: <span className="font-semibold">{importResult.updated}</span></li>
              <li>⏭ スキップ: <span className="font-semibold">{importResult.skipped}</span></li>
              <li>⚠️ エラー: <span className="font-semibold">{importResult.errors.length}</span></li>
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
    </div>
  );
}
