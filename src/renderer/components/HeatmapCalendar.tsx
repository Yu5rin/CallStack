import { useMemo } from 'react';
import { CallRecord } from '../../shared/types';
import { formatHMShort } from '../utils/format';

interface DayCell {
  date: Date;
  key: string;
  count: number;
  totalSec: number;
}

function dateKey(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function intensityClass(count: number): string {
  if (count === 0) return 'bg-slate-200 dark:bg-slate-800';
  if (count <= 2) return 'bg-emerald-200 dark:bg-emerald-900';
  if (count <= 5) return 'bg-emerald-400 dark:bg-emerald-700';
  return 'bg-emerald-600 dark:bg-emerald-500';
}

export function HeatmapCalendar({ calls, days = 91 }: { calls: CallRecord[]; days?: number }) {
  const cells = useMemo<DayCell[]>(() => {
    const map = new Map<string, { count: number; totalSec: number }>();
    for (const c of calls) {
      if (!c.endTime) continue;
      const k = dateKey(new Date(c.startTime));
      const prev = map.get(k) ?? { count: 0, totalSec: 0 };
      prev.count++;
      prev.totalSec += c.durationSec ?? 0;
      map.set(k, prev);
    }
    // End on today (inclusive), back-pad so the column count is whole weeks
    // and the grid always starts on a Sunday — same convention as GitHub.
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    start.setDate(today.getDate() - (days - 1));
    // Pad backwards to nearest Sunday so the grid is rectangular.
    const startDow = start.getDay(); // 0 = Sun
    start.setDate(start.getDate() - startDow);
    const list: DayCell[] = [];
    for (let d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
      const k = dateKey(d);
      const v = map.get(k) ?? { count: 0, totalSec: 0 };
      list.push({ date: new Date(d), key: k, count: v.count, totalSec: v.totalSec });
    }
    return list;
  }, [calls, days]);

  // Group by week — each column is a week, rows are Sun..Sat.
  const weeks: DayCell[][] = [];
  for (let i = 0; i < cells.length; i += 7) {
    weeks.push(cells.slice(i, i + 7));
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
        <span>{cells[0]?.date.toLocaleDateString()} 〜 {cells[cells.length - 1]?.date.toLocaleDateString()}</span>
        <div className="flex items-center gap-1">
          <span>少</span>
          <span className={`h-3 w-3 rounded-sm ${intensityClass(0)}`} />
          <span className={`h-3 w-3 rounded-sm ${intensityClass(1)}`} />
          <span className={`h-3 w-3 rounded-sm ${intensityClass(3)}`} />
          <span className={`h-3 w-3 rounded-sm ${intensityClass(6)}`} />
          <span>多</span>
        </div>
      </div>
      <div className="flex gap-[3px] overflow-x-auto">
        {weeks.map((week, wi) => (
          <div key={wi} className="flex flex-col gap-[3px]">
            {week.map((cell) => (
              <div
                key={cell.key}
                className={`h-3 w-3 rounded-sm ${intensityClass(cell.count)}`}
                title={`${cell.key} : ${cell.count} 件${cell.count > 0 ? ' / ' + formatHMShort(cell.totalSec) : ''}`}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
