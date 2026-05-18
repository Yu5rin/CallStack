import { promises as fs } from 'node:fs';
import { CallRecord, CsvExportOptions } from '../shared/types';

const BOM = '﻿';
const CRLF = '\r\n';

const COLUMNS: Array<{ key: string; header: string }> = [
  { key: 'id', header: 'id' },
  { key: 'startTime', header: 'start_time' },
  { key: 'endTime', header: 'end_time' },
  { key: 'durationSec', header: 'duration_sec' },
  { key: 'durationHMS', header: 'duration_hms' },
  { key: 'tag', header: 'tag' },
  { key: 'memo', header: 'memo' },
  { key: 'contactName', header: 'contact_name' },
  { key: 'phoneNumber', header: 'phone_number' },
];

function escapeField(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function formatHMS(sec: number | null): string {
  if (sec === null || sec === undefined) return '';
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rs = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(rs).padStart(2, '0')}`;
}

export function filterByRange(calls: CallRecord[], opts: CsvExportOptions): CallRecord[] {
  if (opts.range === 'all') return calls;
  const now = new Date();
  let from: Date;
  let to: Date;
  if (opts.range === 'thisWeek') {
    const day = now.getDay(); // 0=Sun
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((day + 6) % 7));
    monday.setHours(0, 0, 0, 0);
    from = monday;
    to = new Date(monday);
    to.setDate(monday.getDate() + 7);
  } else if (opts.range === 'thisMonth') {
    from = new Date(now.getFullYear(), now.getMonth(), 1);
    to = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  } else {
    from = opts.from ? new Date(opts.from) : new Date(0);
    to = opts.to ? new Date(opts.to) : new Date(8640000000000000);
    // make 'to' inclusive of the whole day if it looks like a date-only
    if (opts.to && /^\d{4}-\d{2}-\d{2}$/.test(opts.to)) {
      to.setDate(to.getDate() + 1);
    }
  }
  return calls.filter((c) => {
    const t = new Date(c.startTime).getTime();
    return t >= from.getTime() && t < to.getTime();
  });
}

export function buildCsv(calls: CallRecord[]): string {
  const lines: string[] = [];
  lines.push(COLUMNS.map((c) => escapeField(c.header)).join(','));
  for (const c of calls) {
    const row = {
      id: c.id,
      startTime: c.startTime,
      endTime: c.endTime ?? '',
      durationSec: c.durationSec ?? '',
      durationHMS: formatHMS(c.durationSec),
      tag: c.tag ?? '',
      memo: c.memo ?? '',
      contactName: c.contactName ?? '',
      phoneNumber: c.phoneNumber ?? '',
    };
    lines.push(COLUMNS.map((col) => escapeField((row as Record<string, unknown>)[col.key])).join(','));
  }
  return BOM + lines.join(CRLF) + CRLF;
}

export async function exportCsv(filePath: string, calls: CallRecord[], opts: CsvExportOptions): Promise<number> {
  const filtered = filterByRange(calls, opts);
  const text = buildCsv(filtered);
  await fs.writeFile(filePath, text, 'utf-8');
  return filtered.length;
}
