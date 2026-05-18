import { useMemo, useState } from 'react';
import { CallRecord, Settings, CsvExportOptions } from '../../shared/types';
import { CallEditDialog } from '../components/CallEditDialog';
import { formatDateTime, formatHMS } from '../utils/format';

export function CallListPage({ calls, settings }: { calls: CallRecord[]; settings: Settings }) {
  const [editing, setEditing] = useState<CallRecord | null>(null);
  const [query, setQuery] = useState('');
  const [filterTag, setFilterTag] = useState<string>('');
  const [showUntagged, setShowUntagged] = useState(false);
  const [exportRange, setExportRange] = useState<CsvExportOptions['range']>('all');

  const tagColor = useMemo(() => {
    const m: Record<string, string> = {};
    for (const t of settings.tags) m[t.name] = t.color;
    return m;
  }, [settings.tags]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return calls
      .slice()
      .sort((a, b) => b.startTime.localeCompare(a.startTime))
      .filter((c) => {
        if (showUntagged && c.tag) return false;
        if (filterTag && c.tag !== filterTag) return false;
        if (!q) return true;
        const hay = [
          c.memo,
          c.contactName ?? '',
          c.phoneNumber ?? '',
          c.tag ?? '',
        ].join(' ').toLowerCase();
        return hay.includes(q);
      });
  }, [calls, query, filterTag, showUntagged]);

  const handleExport = async () => {
    const r = await window.api.csv.export({ range: exportRange });
    if (!r.canceled) {
      alert(`${r.count} 件を ${r.path} にエクスポートしました`);
    }
  };

  const handleWeeklyReport = async () => {
    const r = await window.api.report.weekly();
    if (!r.canceled) {
      alert(`週次レポートを ${r.path} に保存しました`);
    }
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
          placeholder="検索（メモ・連絡先・電話番号）"
          className="flex-1 min-w-[240px] rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none"
        />
        <select
          value={filterTag}
          onChange={(e) => { setFilterTag(e.target.value); setShowUntagged(false); }}
          className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm"
        >
          <option value="">すべてのタグ</option>
          {settings.tags.map((t) => (
            <option key={t.name} value={t.name}>{t.name}</option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={showUntagged}
            onChange={(e) => { setShowUntagged(e.target.checked); if (e.target.checked) setFilterTag(''); }}
          />
          未タグのみ ({untaggedCount})
        </label>
        <div className="flex items-center gap-2 ml-auto">
          <button
            onClick={handleAddManual}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            手動追加
          </button>
          <select
            value={exportRange}
            onChange={(e) => setExportRange(e.target.value as CsvExportOptions['range'])}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm"
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
            className="rounded-md border border-brand-300 bg-brand-50 px-3 py-2 text-sm font-medium text-brand-700 hover:bg-brand-100"
          >
            週次レポート (MD)
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">開始時刻</th>
              <th className="px-4 py-3">終了時刻</th>
              <th className="px-4 py-3 text-right">通話時間</th>
              <th className="px-4 py-3">タグ</th>
              <th className="px-4 py-3">連絡先</th>
              <th className="px-4 py-3">メモ</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center text-slate-400">
                  まだ記録がありません。{settings.shortcuts.startCall} で通話を開始しましょう。
                </td>
              </tr>
            )}
            {filtered.map((c) => (
              <tr
                key={c.id}
                onClick={() => setEditing(c)}
                className="cursor-pointer border-t border-slate-100 hover:bg-slate-50"
              >
                <td className="px-4 py-3 font-mono text-xs tabular-nums text-slate-700">{formatDateTime(c.startTime)}</td>
                <td className="px-4 py-3 font-mono text-xs tabular-nums text-slate-700">
                  {c.endTime ? formatDateTime(c.endTime) : <span className="text-emerald-600">通話中…</span>}
                </td>
                <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-900">
                  {c.durationSec === null ? '—' : formatHMS(c.durationSec)}
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
                <td className="px-4 py-3 text-slate-700">{c.contactName || '—'}</td>
                <td className="px-4 py-3 text-slate-700 truncate max-w-xs">{c.memo || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <CallEditDialog
          call={editing}
          settings={settings}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
