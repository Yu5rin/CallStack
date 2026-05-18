import { useMemo } from 'react';
import { CallRecord, Settings } from '../../shared/types';
import { computeOverview, computeDaily, computeByTag, computeHourHistogram } from '../utils/stats';
import { formatHMS, formatHMShort } from '../utils/format';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  PieChart, Pie, Cell, Legend,
} from 'recharts';

export function StatsPage({ calls, settings }: { calls: CallRecord[]; settings: Settings }) {
  const overview = useMemo(() => computeOverview(calls), [calls]);
  const tagColors = useMemo(() => {
    const m: Record<string, string> = {};
    for (const t of settings.tags) m[t.name] = t.color;
    return m;
  }, [settings.tags]);
  const daily = useMemo(() => computeDaily(calls, 30), [calls]);
  const byTag = useMemo(() => computeByTag(calls, tagColors), [calls, tagColors]);
  const hourly = useMemo(() => computeHourHistogram(calls), [calls]);

  const dailyChart = daily.map((d) => ({
    date: d.date.slice(5), // MM-DD
    minutes: Math.round((d.totalSec / 60) * 10) / 10,
    count: d.count,
  }));

  const tagPie = byTag.map((b) => ({ name: b.tag, value: b.totalSec, color: b.color }));
  const hourChart = hourly.map((h) => ({ hour: `${h.hour}時`, count: h.count }));

  return (
    <div className="space-y-6 p-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label="総通話数" value={`${overview.totalCount}`} unit="件" />
        <StatCard label="合計時間" value={formatHMShort(overview.totalSec)} />
        <StatCard label="平均" value={formatHMShort(overview.avgSec)} />
        <StatCard label="最長" value={formatHMShort(overview.longestSec)} />
        <StatCard label="最短" value={formatHMShort(overview.shortestSec)} />
        <StatCard label="今日 / 今週 / 今月" value={`${overview.todayCount} / ${overview.weekCount} / ${overview.monthCount}`} unit="件" />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <h3 className="mb-3 text-sm font-semibold text-slate-700">過去30日の通話時間（分）</h3>
          <div className="h-64">
            <ResponsiveContainer>
              <BarChart data={dailyChart}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v: number | string) => [`${v} 分`, '通話時間']} />
                <Bar dataKey="minutes" fill="#367aff" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <h3 className="mb-3 text-sm font-semibold text-slate-700">タグ別構成（時間）</h3>
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

      <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="mb-3 text-sm font-semibold text-slate-700">時間帯別の発生件数</h3>
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

      <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="mb-3 text-sm font-semibold text-slate-700">タグ別の詳細</h3>
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
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
              <tr key={b.tag} className="border-t border-slate-100">
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
    </div>
  );
}

function StatCard({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-bold text-slate-900">
        {value}{unit && <span className="ml-1 text-sm font-medium text-slate-500">{unit}</span>}
      </div>
    </div>
  );
}
