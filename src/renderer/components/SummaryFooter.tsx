import { useMemo } from 'react';
import { CallRecord } from '../../shared/types';
import { formatHMShort } from '../utils/format';

interface Bucket {
  count: number;
  totalSec: number;
}

function aggregate(calls: CallRecord[]): { today: Bucket; week: Bucket; month: Bucket } {
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  // ISO-style week starting Monday at 00:00.
  const dayOfWeek = (now.getDay() + 6) % 7; // 0 = Mon
  const weekStart = dayStart - dayOfWeek * 86_400_000;
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

  const make = (): Bucket => ({ count: 0, totalSec: 0 });
  const today = make();
  const week = make();
  const month = make();

  for (const c of calls) {
    if (!c.endTime) continue;
    const at = new Date(c.startTime).getTime();
    const dur = c.durationSec ?? 0;
    if (at >= monthStart) {
      month.count++;
      month.totalSec += dur;
    }
    if (at >= weekStart) {
      week.count++;
      week.totalSec += dur;
    }
    if (at >= dayStart) {
      today.count++;
      today.totalSec += dur;
    }
  }
  return { today, week, month };
}

export function SummaryFooter({ calls }: { calls: CallRecord[] }) {
  const stats = useMemo(() => aggregate(calls), [calls]);

  const cell = (label: string, b: Bucket) => (
    <div className="flex items-baseline gap-1.5 text-slate-700 dark:text-slate-300">
      <span className="text-xs text-slate-500 dark:text-slate-400">{label}</span>
      <span className="font-semibold tabular-nums">{b.count}</span>
      <span className="text-xs text-slate-500 dark:text-slate-400">件</span>
      <span className="font-mono text-xs tabular-nums text-slate-600 dark:text-slate-400">
        {b.totalSec > 0 ? formatHMShort(b.totalSec) : '—'}
      </span>
    </div>
  );

  return (
    <footer className="flex flex-shrink-0 items-center justify-between border-t border-slate-200 bg-white px-6 py-2 text-sm shadow-inner dark:border-slate-800 dark:bg-slate-900">
      <div className="flex gap-6">
        {cell('今日', stats.today)}
        {cell('今週', stats.week)}
        {cell('今月', stats.month)}
      </div>
    </footer>
  );
}
