import { useMemo, useState } from 'react';
import { CallRecord, RecordKind, Settings } from '../../shared/types';
import { computeOverview, computeDaily, computeByTag, computeHourHistogram, computeByContact, computeByTitle } from '../utils/stats';
import { formatHMS, formatHMShort, formatDateTime } from '../utils/format';
import { Phone, Users } from 'lucide-react';
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

// recharts のツールチップはインラインスタイルで渡す必要があるため、
// トークン（CSS 変数）をそのまま文字列として使う（テーマ切り替えに自動追従する）
const TOOLTIP_STYLE: React.CSSProperties = {
  background: 'rgb(var(--c-surface))',
  border: '1px solid rgb(var(--c-rule))',
  borderRadius: 8,
  fontSize: 12,
  color: 'rgb(var(--c-ink))',
};
const TOOLTIP_LABEL_STYLE: React.CSSProperties = { color: 'rgb(var(--c-ink-mute))' };

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
          className={`rounded-md px-4 py-1.5 text-sm font-medium transition ${
            !isMeetingTab ? 'bg-accent text-on-accent' : 'text-ink-mute hover:bg-paper'
          }`}
        >
          <Phone size={14} className="mr-1.5 inline align-[-2px]" />通話
        </button>
        <button
          onClick={() => setKindTab('meeting')}
          className={`rounded-md px-4 py-1.5 text-sm font-medium transition ${
            isMeetingTab ? 'bg-accent text-on-accent' : 'text-ink-mute hover:bg-paper'
          }`}
        >
          <Users size={14} className="mr-1.5 inline align-[-2px]" />会議 ({meetingCount})
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
        <div className="lg:col-span-2 rounded-lg border border-rule bg-surface p-4">
          <h3 className="mb-3 text-sm font-medium text-ink">過去30日の{noun}時間（分）</h3>
          <div className="h-64">
            <ResponsiveContainer>
              <BarChart data={dailyChart}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--c-rule))" />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'rgb(var(--c-ink-mute))' }} stroke="rgb(var(--c-rule))" />
                <YAxis tick={{ fontSize: 11, fill: 'rgb(var(--c-ink-mute))' }} stroke="rgb(var(--c-rule))" />
                <Tooltip formatter={(v: number | string) => [`${v} 分`, `${noun}時間`]} contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL_STYLE} />
                <Bar dataKey="minutes" fill="rgb(var(--c-accent))" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="rounded-lg border border-rule bg-surface p-4">
          <h3 className="mb-3 text-sm font-medium text-ink">タグ別構成（時間）</h3>
          <div className="h-64">
            {tagPie.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-ink-mute">データなし</div>
            ) : (
              <ResponsiveContainer>
                <PieChart>
                  <Pie data={tagPie} dataKey="value" nameKey="name" innerRadius={40} outerRadius={80}>
                    {tagPie.map((entry, idx) => (
                      <Cell key={idx} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v: number | string) => formatHMS(Number(v))} contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL_STYLE} />
                  <Legend wrapperStyle={{ color: 'rgb(var(--c-ink-mute))', fontSize: 12 }} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-rule bg-surface p-4">
        <h3 className="mb-3 text-sm font-medium text-ink">過去90日のアクティビティ</h3>
        <HeatmapCalendar calls={target} />
      </div>

      <div className="rounded-lg border border-rule bg-surface p-4">
        <h3 className="mb-3 text-sm font-medium text-ink">時間帯別の発生件数</h3>
        <div className="h-56">
          <ResponsiveContainer>
            <BarChart data={hourChart}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--c-rule))" />
              <XAxis dataKey="hour" tick={{ fontSize: 11, fill: 'rgb(var(--c-ink-mute))' }} stroke="rgb(var(--c-rule))" />
              <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: 'rgb(var(--c-ink-mute))' }} stroke="rgb(var(--c-rule))" />
              <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL_STYLE} />
              <Bar dataKey="count" fill="rgb(var(--c-accent))" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="rounded-lg border border-rule bg-surface p-4">
        <h3 className="mb-3 text-sm font-medium text-ink">タグ別の詳細</h3>
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-ink-mute">
            <tr>
              <th className="py-2">タグ</th>
              <th className="py-2 text-right">件数</th>
              <th className="py-2 text-right">合計時間</th>
              <th className="py-2 text-right">平均時間</th>
            </tr>
          </thead>
          <tbody>
            {byTag.length === 0 && (
              <tr><td colSpan={4} className="py-4 text-center text-ink-mute">データなし</td></tr>
            )}
            {byTag.map((b) => (
              <tr key={b.tag} className="border-t border-rule">
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

      <div className="rounded-lg border border-rule bg-surface p-4">
        <h3 className="mb-3 text-sm font-medium text-ink">{isMeetingTab ? '会議名別サマリー（上位 TOP10 時間）' : '連絡先別サマリー（上位 TOP10 通話時間）'}</h3>
        {top10Contacts.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-sm text-ink-mute">{isMeetingTab ? '会議の記録がありません' : '連絡先名が設定された記録がありません'}</div>
        ) : (
          <div className="h-56">
            <ResponsiveContainer>
              <BarChart data={top10Contacts} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--c-rule))" />
                <XAxis type="number" tick={{ fontSize: 11, fill: 'rgb(var(--c-ink-mute))' }} stroke="rgb(var(--c-rule))" />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: 'rgb(var(--c-ink-mute))' }} stroke="rgb(var(--c-rule))" width={140} />
                <Tooltip formatter={(v: number | string) => [`${v} 分`, `${noun}時間`]} contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL_STYLE} />
                <Bar dataKey="minutes" fill="rgb(var(--c-accent))" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
        <table className="mt-4 w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-ink-mute">
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
              <tr><td colSpan={6} className="py-4 text-center text-ink-mute">データなし</td></tr>
            )}
            {byContact.map((b) => (
              <tr
                key={b.name}
                onClick={() => { if (!isMeetingTab) onSelectContact?.(b.name); }}
                className="cursor-pointer border-t border-rule hover:bg-accent-soft"
              >
                <td className="py-2 font-medium text-accent-ink">{b.name}</td>
                <td className="py-2 text-right tabular-nums">{b.count}</td>
                <td className="py-2 text-right font-mono tabular-nums">{formatHMS(b.totalSec)}</td>
                <td className="py-2 text-right font-mono tabular-nums">{formatHMS(b.avgSec)}</td>
                <td className="py-2 text-xs">{b.topTag ?? '—'}</td>
                <td className="py-2 text-xs text-ink-mute">{formatDateTime(b.lastCallAt)}</td>
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
    <div className="rounded-lg border border-rule bg-surface p-4">
      <div className="text-xs text-ink-mute">{label}</div>
      <div className="mt-1 font-mono text-2xl font-semibold tabular-nums text-ink">
        {value}{unit && <span className="ml-1 font-sans text-sm font-medium text-ink-mute">{unit}</span>}
      </div>
    </div>
  );
}
