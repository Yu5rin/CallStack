import { useMemo, useState } from 'react';
import { CallRecord, RecordKind, Settings } from '../../shared/types';
import { computeOverview, computeDaily, computeByTag, computeHourHistogram, computeByContact, computeByTitle } from '../utils/stats';
import { formatHMS, formatHMShort, formatDateTime } from '../utils/format';
import { HeatmapCalendar } from '../components/HeatmapCalendar';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  PieChart, Pie, Cell, Legend,
} from 'recharts';

interface Props {
  calls: CallRecord[];
  settings: Settings;
  onSelectContact?: (name: string) => void;
}

export function StatsPage({ calls, settings, onSelectContact }: Props) {
  // 通話と会議は性質が違うためタブで分けて集計する
  const [kindTab, setKindTab] = useState<RecordKind>('call');
  const isMeetingTab = kindTab === 'meeting';
  const target = useMemo(
    () => calls.filter((c) => (c.kind === 'meeting') === isMeetingTab),
    [calls, isMeetingTab],
  );
  const meetingCount = useMemo(() => calls.filter((c) => c.kind === 'meeting').length, [calls]);

  const overview = useMemo(() => computeOverview(target), [target]);
  const tagColors = useMemo(() => {
    const m: Record<string, string> = {};
    for (const t of settings.tags) m[t.name] = t.color;
    return m;
  }, [settings.tags]);
  const daily = useMemo(() => computeDaily(target, 30), [target]);
  const byTag = useMemo(() => computeByTag(target, tagColors), [target, tagColors]);
  const hourly = useMemo(() => computeHourHistogram(target), [target]);
  const byContact = useMemo(
    () => (isMeetingTab ? computeByTitle(target) : computeByContact(target)),
    [target, isMeetingTab],
  );
  const noun = isMeetingTab ? '会議' : '通話';

  const dailyChart = daily.map((d) => ({
    date: d.date.slice(5),
    minutes: Math.round((d.totalSec / 60) * 10) / 10,
    count: d.count,
  }));

  const tagPie = byTag.map((b) => ({ name: b.tag, value: b.totalSec, color: b.color }));
  const hourChart = hourly.map((h) => ({ hour: `${h.hour}時`, count: h.count }));
  const top10Contacts = byContact.slice(0, 10).map((b) => ({ name: b.name, minutes: Math.round(b.totalSec / 60) }));

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center gap-1">
        <button
          onClick={() => setKindTab('call')}
          className={`rounded-md px-4 py-1.5 text-sm font-semibold transition ${
            !isMeetingTab
              ? 'bg-brand-600 text-white shadow-sm'
              : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
          }`}
        >
          📞 通話
        </button>
        <button
          onClick={() => setKindTab('meeting')}
          className={`rounded-md px-4 py-1.5 text-sm font-semibold transition ${
            isMeetingTab
              ? 'bg-violet-600 text-white shadow-sm'
              : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
          }`}
        >
          👥 会議 ({meetingCount})
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label={`総${noun}数`} value={`${overview.totalCount}`} unit="件" />
        <StatCard label="合計時間" value={formatHMShort(overview.totalSec)} />
        <StatCard label="平均" value={formatHMShort(overview.avgSec)} />
        <StatCard label="最長" value={formatHMShort(overview.longestSec)} />
        <StatCard label="最短" value={formatHMShort(overview.shortestSec)} />
        <StatCard label="今日 / 今週 / 今月" value={`${overview.todayCount} / ${overview.weekCount} / ${overview.monthCount}`} unit="件" />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <h3 className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">過去30日の{noun}時間（分）</h3>
          <div className="h-64">
            <ResponsiveContainer>
              <BarChart data={dailyChart}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v: number | string) => [`${v} 分`, `${noun}時間`]} />
                <Bar dataKey="minutes" fill="#367aff" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <h3 className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">タグ別構成（時間）</h3>
          <div className="h-64">
            {tagPie.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-slate-400">データなし</div>
            ) : (
              <ResponsiveContainer>
                <PieChart>
                  <Pie data={tagPie} dataKey="value" nameKey="name" innerRadius={40} outerRadius={80}>
                    {tagPie.map((entry, idx) => (
                      <Cell key={idx} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v: number | string) => formatHMS(Number(v))} />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <h3 className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">過去90日のアクティビティ</h3>
        <HeatmapCalendar calls={target} />
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <h3 className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">時間帯別の発生件数</h3>
        <div className="h-56">
          <ResponsiveContainer>
            <BarChart data={hourChart}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="hour" tick={{ fontSize: 11 }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
              <Tooltip />
              <Bar dataKey="count" fill="#10b981" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <h3 className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">タグ別の詳細</h3>
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
            <tr>
              <th className="py-2">タグ</th>
              <th className="py-2 text-right">件数</th>
              <th className="py-2 text-right">合計時間</th>
              <th className="py-2 text-right">平均時間</th>
            </tr>
          </thead>
          <tbody>
            {byTag.length === 0 && (
              <tr><td colSpan={4} className="py-4 text-center text-slate-400">データなし</td></tr>
            )}
            {byTag.map((b) => (
              <tr key={b.tag} className="border-t border-slate-100 dark:border-slate-800">
                <td className="py-2">
                  <span
                    className="inline-block rounded-full px-2 py-0.5 text-xs font-medium text-white"
                    style={{ backgroundColor: b.color }}
                  >
                    {b.tag}
                  </span>
                </td>
                <td className="py-2 text-right tabular-nums">{b.count}</td>
                <td className="py-2 text-right font-mono tabular-nums">{formatHMS(b.totalSec)}</td>
                <td className="py-2 text-right font-mono tabular-nums">{formatHMS(Math.round(b.totalSec / b.count))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <h3 className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">{isMeetingTab ? '会議名別サマリー（上位 TOP10 時間）' : '連絡先別サマリー（上位 TOP10 通話時間）'}</h3>
        {top10Contacts.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-sm text-slate-400">{isMeetingTab ? '会議の記録がありません' : '連絡先名が設定された記録がありません'}</div>
        ) : (
          <div className="h-56">
            <ResponsiveContainer>
              <BarChart data={top10Contacts} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis type="number" tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={140} />
                <Tooltip formatter={(v: number | string) => [`${v} 分`, `${noun}時間`]} />
                <Bar dataKey="minutes" fill="#a855f7" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
        <table className="mt-4 w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
            <tr>
              <th className="py-2">{isMeetingTab ? '会議名' : '連絡先'}</th>
              <th className="py-2 text-right">件数</th>
              <th className="py-2 text-right">合計</th>
              <th className="py-2 text-right">平均</th>
              <th className="py-2">トップタグ</th>
              <th className="py-2">最終</th>
            </tr>
          </thead>
          <tbody>
            {byContact.length === 0 && (
              <tr><td colSpan={6} className="py-4 text-center text-slate-400">データなし</td></tr>
            )}
            {byContact.map((b) => (
              <tr
                key={b.name}
                onClick={() => { if (!isMeetingTab) onSelectContact?.(b.name); }}
                className="cursor-pointer border-t border-slate-100 hover:bg-brand-50 dark:border-slate-800 dark:hover:bg-brand-900/40"
              >
                <td className="py-2 font-medium text-brand-700 dark:text-brand-300">{b.name}</td>
                <td className="py-2 text-right tabular-nums">{b.count}</td>
                <td className="py-2 text-right font-mono tabular-nums">{formatHMS(b.totalSec)}</td>
                <td className="py-2 text-right font-mono tabular-nums">{formatHMS(b.avgSec)}</td>
                <td className="py-2 text-xs">{b.topTag ?? '—'}</td>
                <td className="py-2 text-xs text-slate-600 dark:text-slate-400">{formatDateTime(b.lastCallAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatCard({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="text-xs text-slate-500 dark:text-slate-400">{label}</div>
      <div className="mt-1 text-2xl font-bold text-slate-900 dark:text-slate-100">
        {value}{unit && <span className="ml-1 text-sm font-medium text-slate-500 dark:text-slate-400">{unit}</span>}
      </div>
    </div>
  );
}
