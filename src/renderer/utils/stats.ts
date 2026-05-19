import dayjs from 'dayjs';
import { CallRecord } from '../../shared/types';

export interface OverviewStats {
  totalCount: number;
  totalSec: number;
  avgSec: number;
  longestSec: number;
  shortestSec: number;
  todayCount: number;
  todaySec: number;
  weekCount: number;
  weekSec: number;
  monthCount: number;
  monthSec: number;
}

export function computeOverview(calls: CallRecord[]): OverviewStats {
  const done = calls.filter((c) => c.endTime && c.durationSec !== null);
  const total = done.reduce((a, b) => a + (b.durationSec ?? 0), 0);
  const today = dayjs().startOf('day');
  const week = dayjs().startOf('week');
  const month = dayjs().startOf('month');

  let todayCount = 0;
  let todaySec = 0;
  let weekCount = 0;
  let weekSec = 0;
  let monthCount = 0;
  let monthSec = 0;
  let longest = 0;
  let shortest = Number.MAX_SAFE_INTEGER;

  for (const c of done) {
    const start = dayjs(c.startTime);
    const d = c.durationSec ?? 0;
    longest = Math.max(longest, d);
    shortest = Math.min(shortest, d);
    if (start.isAfter(today) || start.isSame(today)) {
      todayCount += 1;
      todaySec += d;
    }
    if (start.isAfter(week) || start.isSame(week)) {
      weekCount += 1;
      weekSec += d;
    }
    if (start.isAfter(month) || start.isSame(month)) {
      monthCount += 1;
      monthSec += d;
    }
  }

  return {
    totalCount: done.length,
    totalSec: total,
    avgSec: done.length ? Math.round(total / done.length) : 0,
    longestSec: done.length ? longest : 0,
    shortestSec: done.length ? shortest : 0,
    todayCount,
    todaySec,
    weekCount,
    weekSec,
    monthCount,
    monthSec,
  };
}

export interface DailyBucket {
  date: string;        // YYYY-MM-DD
  totalSec: number;
  count: number;
}

export function computeDaily(calls: CallRecord[], days = 30): DailyBucket[] {
  const map = new Map<string, DailyBucket>();
  const start = dayjs().startOf('day').subtract(days - 1, 'day');
  for (let i = 0; i < days; i++) {
    const d = start.add(i, 'day').format('YYYY-MM-DD');
    map.set(d, { date: d, totalSec: 0, count: 0 });
  }
  for (const c of calls) {
    if (!c.endTime || c.durationSec === null) continue;
    const key = dayjs(c.startTime).format('YYYY-MM-DD');
    const b = map.get(key);
    if (b) {
      b.totalSec += c.durationSec;
      b.count += 1;
    }
  }
  return [...map.values()];
}

export interface TagBucket {
  tag: string;
  totalSec: number;
  count: number;
  color: string;
}

export function computeByTag(calls: CallRecord[], tagColors: Record<string, string>): TagBucket[] {
  const map = new Map<string, TagBucket>();
  for (const c of calls) {
    if (!c.endTime || c.durationSec === null) continue;
    const k = c.tag ?? '（タグなし）';
    const cur = map.get(k) ?? { tag: k, totalSec: 0, count: 0, color: tagColors[k] ?? '#94a3b8' };
    cur.totalSec += c.durationSec;
    cur.count += 1;
    map.set(k, cur);
  }
  return [...map.values()].sort((a, b) => b.totalSec - a.totalSec);
}

export interface ContactBucket {
  name: string;
  count: number;
  totalSec: number;
  avgSec: number;
  lastCallAt: string;
  topTag: string | null;
}

export function computeByContact(calls: CallRecord[]): ContactBucket[] {
  const map = new Map<string, { name: string; count: number; totalSec: number; last: string; tagCounts: Map<string, number> }>();
  for (const c of calls) {
    if (!c.contactName || !c.endTime || c.durationSec === null) continue;
    const cur = map.get(c.contactName) ?? {
      name: c.contactName,
      count: 0,
      totalSec: 0,
      last: c.startTime,
      tagCounts: new Map<string, number>(),
    };
    cur.count += 1;
    cur.totalSec += c.durationSec;
    if (c.startTime > cur.last) cur.last = c.startTime;
    if (c.tag) cur.tagCounts.set(c.tag, (cur.tagCounts.get(c.tag) ?? 0) + 1);
    map.set(c.contactName, cur);
  }
  return [...map.values()]
    .map((b) => {
      let topTag: string | null = null;
      let topCount = 0;
      for (const [t, n] of b.tagCounts) {
        if (n > topCount) { topTag = t; topCount = n; }
      }
      return {
        name: b.name,
        count: b.count,
        totalSec: b.totalSec,
        avgSec: Math.round(b.totalSec / b.count),
        lastCallAt: b.last,
        topTag,
      };
    })
    .sort((a, b) => b.totalSec - a.totalSec);
}

export function computeHourHistogram(calls: CallRecord[]): Array<{ hour: number; count: number; totalSec: number }> {
  const arr = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0, totalSec: 0 }));
  for (const c of calls) {
    if (!c.endTime || c.durationSec === null) continue;
    const h = dayjs(c.startTime).hour();
    arr[h].count += 1;
    arr[h].totalSec += c.durationSec;
  }
  return arr;
}
