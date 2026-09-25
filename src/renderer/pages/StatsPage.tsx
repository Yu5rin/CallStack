import { useMemo, useState } from 'react';
import { CallRecord, Settings } from '../../shared/types';
import {
  computeOverview, computeDaily, computeByTag, computeHourHistogram,
  computeByContact, computeByTitle, computeByContactOrTitle,
} from '../utils/stats';
import { formatHMS, formatHMShort, formatDateTime } from '../utils/format';
import { Phone, Users } from 'lucide-react';
import { HeatmapCalendar } from '../components/HeatmapCalendar';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, LabelList,
} from 'recharts';

interface Props {
  calls: CallRecord[];
  settings: Settings;
  onSelectContact?: (name: string) => void;
}

type KindTab = 'call' | 'meeting' | 'all';

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
  // 通話・会議・すべてはタブで切り替える（連絡先/会議名別のクリック選択は通話タブのみ有効）
  const [kindTab, setKindTab] = useState<KindTab>('call');
  const isMeetingTab = kindTab === 'meeting';
  const isCallTab = kindTab === 'call';
  const target = useMemo(
    () => (kindTab === 'all' ? calls : calls.filter((c) => (c.kind === 'meeting') === isMeetingTab)),
    [calls, kindTab, isMeetingTab],
  );
  const meetingCount = useMemo(() => calls.filter((c) => c.kind === 'meeting').length, [calls]);

  const overview = useMemo(() => computeOverview(target), [target]);
  const hasData = overview.totalCount > 0;
  const tagColors = useMemo(() => {
    const m: Record<string, string> = {};
    for (const t of settings.tags) m[t.name] = t.color;
    return m;
  }, [settings.tags]);
  const daily = useMemo(() => computeDaily(target, 30), [target]);
  const byTag = useMemo(() => computeByTag(target, tagColors), [target, tagColors]);
  const hourly = useMemo(() => computeHourHistogram(target), [target]);
  const byContact = useMemo(
    () => (isMeetingTab ? computeByTitle(target) : kindTab === 'all' ? computeByContactOrTitle(target) : computeByContact(target)),
    [target, isMeetingTab, kindTab],
  );
  const noun = isMeetingTab ? '会議' : isCallTab ? '通話' : '記録';

  const dailyChart = daily.map((d) => ({
    date: d.date.slice(5),
    minutes: Math.round((d.totalSec / 60) * 10) / 10,
    count: d.count,
  }));
  const dailyHasData = dailyChart.some((d) => d.count > 0);

  const hourChart = hourly.map((h) => ({ hour: `${h.hour}時`, count: h.count }));
  const hourlyHasData = hourChart.some((h) => h.count > 0);
  const top10Contacts = byContact.slice(0, 10).map((b) => ({ name: b.name, minutes: Math.round(b.totalSec / 60) }));

  /** データが無いときは「0秒」「0件」ではなく「—」を表示する */
  const tileTime = (sec: number) => (hasData ? formatHMShort(sec) : '—');

  return (
    <div className="space-y-6 p-6">
      <div className="inline-flex items-center gap-0.5 rounded-md border border-rule bg-surface p-0.5" role="tablist" aria-label="種類">
        <button
          role="tab"
          aria-selected={isCallTab}
          onClick={() => setKindTab('call')}
          className={`rounded px-3 py-1.5 text-sm font-medium transition ${
            isCallTab ? 'bg-accent-soft text-accent-ink' : 'text-ink-mute hover:text-ink'
          }`}
        >
          <Phone size={14} className="mr-1.5 inline align-[-2px]" />通話
        </button>
        <button
          role="tab"
          aria-selected={isMeetingTab}
          onClick={() => setKindTab('meeting')}
          className={`rounded px-3 py-1.5 text-sm font-medium transition ${
            isMeetingTab ? 'bg-accent-soft text-accent-ink' : 'text-ink-mute hover:text-ink'
          }`}
        >
          <Users size={14} className="mr-1.5 inline align-[-2px]" />会議 ({meetingCount})
        </button>
        <button
          role="tab"
          aria-selected={kindTab === 'all'}
          onClick={() => setKindTab('all')}
          className={`rounded px-3 py-1.5 text-sm font-medium transition ${
            kindTab === 'all' ? 'bg-accent-soft text-accent-ink' : 'text-ink-mute hover:text-ink'
          }`}
        >
          すべて
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label={`総${noun}数`} value={hasData ? `${overview.totalCount}` : '—'} unit={hasData ? '件' : undefined} />
        <StatCard label="合計時間" value={tileTime(overview.totalSec)} />
        <StatCard label="平均" value={tileTime(overview.avgSec)} />
        <StatCard label="最長" value={tileTime(overview.longestSec)} />
        <StatCard label="最短" value={tileTime(overview.shortestSec)} />
        <StatCard
          label="今日 / 今週 / 今月"
          value={
            overview.todayCount === 0 && overview.weekCount === 0 && overview.monthCount === 0
              ? '—'
              : `${overview.todayCount} / ${overview.weekCount} / ${overview.monthCount}`
          }
          unit={overview.todayCount || overview.weekCount || overview.monthCount ? '件' : undefined}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 rounded-lg border border-rule bg-surface p-4">
          <h3 className="mb-3 text-sm font-medium text-ink">過去30日の{noun}時間（分）</h3>
          {dailyHasData ? (
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
          ) : (
            <div className="flex h-64 items-center justify-center text-sm text-ink-mute">この期間の記録はありません</div>
          )}
        </div>

        <div className="rounded-lg border border-rule bg-surface p-4">
          <h3 className="mb-3 text-sm font-medium text-ink">タグ別の時間</h3>
          {byTag.length === 0 ? (
            <div className="flex h-64 items-center justify-center text-sm text-ink-mute">この期間の記録はありません</div>
          ) : (
            <div style={{ height: Math.max(64 * 4, byTag.length * 32) }}>
              <ResponsiveContainer>
                <BarChart data={byTag} layout="vertical" margin={{ left: 8, right: 48 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--c-rule))" horizontal={false} />
                  <XAxis type="number" hide />
                  <YAxis
                    type="category"
                    dataKey="tag"
                    width={88}
                    tick={{ fontSize: 12, fill: 'rgb(var(--c-ink))' }}
                    stroke="rgb(var(--c-rule))"
                  />
                  <Tooltip formatter={(v: number | string) => formatHMS(Number(v))} contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL_STYLE} />
                  <Bar dataKey="totalSec" fill="rgb(var(--c-accent))" radius={[0, 4, 4, 0]} barSize={18}>
                    <LabelList
                      dataKey="totalSec"
                      position="right"
                      formatter={(v: number) => formatHMShort(v)}
                      style={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 11, fill: 'rgb(var(--c-ink-mute))' }}
                    />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-rule bg-surface p-4">
        <h3 className="mb-3 text-sm font-medium text-ink">過去90日のアクティビティ</h3>
        <HeatmapCalendar calls={target} />
      </div>

      <div className="rounded-lg border border-rule bg-surface p-4">
        <h3 className="mb-3 text-sm font-medium text-ink">時間帯別の発生件数</h3>
        {hourlyHasData ? (
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
        ) : (
          <div className="flex h-56 items-center justify-center text-sm text-ink-mute">この期間の記録はありません</div>
        )}
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
              <tr><td colSpan={4} className="py-4 text-center text-ink-mute">この期間の記録はありません</td></tr>
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
                <td className="py-2 text-right font-mono tabular-nums">{b.count}</td>
                <td className="py-2 text-right font-mono tabular-nums">{formatHMS(b.totalSec)}</td>
                <td className="py-2 text-right font-mono tabular-nums">{formatHMS(Math.round(b.totalSec / b.count))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="rounded-lg border border-rule bg-surface p-4">
        <h3 className="mb-3 text-sm font-medium text-ink">{isMeetingTab ? '会議名別（上位）' : '連絡先別（上位）'}</h3>
        {top10Contacts.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-sm text-ink-mute">この期間の記録はありません</div>
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
              <th className="py-2">{isMeetingTab ? '会議名' : isCallTab ? '連絡先' : '連絡先 / 会議名'}</th>
              <th className="py-2 text-right">件数</th>
              <th className="py-2 text-right">合計</th>
              <th className="py-2 text-right">平均</th>
              <th className="py-2">トップタグ</th>
              <th className="py-2">最終</th>
            </tr>
          </thead>
          <tbody>
            {byContact.length === 0 && (
              <tr><td colSpan={6} className="py-4 text-center text-ink-mute">この期間の記録はありません</td></tr>
            )}
            {byContact.map((b) => (
              <tr
                key={b.name}
                onClick={isCallTab ? () => onSelectContact?.(b.name) : undefined}
                className={`border-t border-rule ${isCallTab ? 'cursor-pointer hover:bg-accent-soft' : ''}`}
              >
                <td className={`py-2 font-medium ${isCallTab ? 'text-accent-ink' : 'text-ink'}`}>{b.name}</td>
                <td className="py-2 text-right font-mono tabular-nums">{b.count}</td>
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
