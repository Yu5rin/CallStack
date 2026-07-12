import { promises as fs } from 'node:fs';
import { CallRecord, CsvExportOptions, getRecordTags, tagsPatch } from '../shared/types';
import { localIso } from './localTime';

const BOM = '﻿';
const CRLF = '\r\n';

const COLUMNS: Array<{ key: string; header: string }> = [
  { key: 'id', header: 'id' },
  { key: 'kind', header: 'kind' },
  { key: 'startTime', header: 'start_time' },
  { key: 'endTime', header: 'end_time' },
  { key: 'durationSec', header: 'duration_sec' },
  { key: 'durationHMS', header: 'duration_hms' },
  { key: 'holdSec', header: 'hold_sec' },
  { key: 'holdHMS', header: 'hold_hms' },
  { key: 'talkSec', header: 'talk_sec' },
  { key: 'talkHMS', header: 'talk_hms' },
  { key: 'tag', header: 'tag' },
  { key: 'memo', header: 'memo' },
  { key: 'contactName', header: 'contact_name' },
  { key: 'phoneNumber', header: 'phone_number' },
  { key: 'title', header: 'title' },
  { key: 'participants', header: 'participants' },
  { key: 'audioPath', header: 'audio_path' },
  { key: 'transcript', header: 'transcript' },
];

function escapeField(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function formatHMS(sec: number | null | undefined): string {
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
    const day = now.getDay();
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
    const hold = c.holdSec ?? 0;
    const talk = (c.durationSec ?? 0) - hold;
    const row = {
      id: c.id,
      kind: c.kind ?? 'call',
      startTime: localIso(c.startTime),
      endTime: c.endTime ? localIso(c.endTime) : '',
      durationSec: c.durationSec ?? '',
      durationHMS: formatHMS(c.durationSec),
      holdSec: hold,
      holdHMS: formatHMS(hold),
      talkSec: c.durationSec === null ? '' : Math.max(0, talk),
      talkHMS: c.durationSec === null ? '' : formatHMS(Math.max(0, talk)),
      tag: getRecordTags(c).join(';'),
      memo: c.memo ?? '',
      contactName: c.contactName ?? '',
      phoneNumber: c.phoneNumber ?? '',
      title: c.title ?? '',
      participants: c.participants?.join(';') ?? '',
      audioPath: c.audio?.path ?? '',
      transcript: c.transcript?.text ?? '',
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

// ============================================================
//   CSV Parser (RFC 4180 subset, handles quoted fields, BOM)
// ============================================================

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function splitCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(field);
        field = '';
      } else if (ch === '\r') {
        // ignore; handle on \n
      } else if (ch === '\n') {
        row.push(field);
        field = '';
        rows.push(row);
        row = [];
      } else {
        field += ch;
      }
    }
  }
  // Trailing field/row (no trailing newline)
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

export interface ParsedRow {
  rowNumber: number;
  record?: Partial<CallRecord> & { id?: string; startTime?: string };
  error?: string;
}

export function parseCsv(raw: string): ParsedRow[] {
  const text = stripBom(raw);
  const rows = splitCsv(text);
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim());
  const idx = (name: string) => header.indexOf(name);
  const idIdx = idx('id');
  const kindIdx = idx('kind');
  const startIdx = idx('start_time');
  const endIdx = idx('end_time');
  const tagIdx = idx('tag');
  const memoIdx = idx('memo');
  const contactIdx = idx('contact_name');
  const phoneIdx = idx('phone_number');
  const titleIdx = idx('title');
  const participantsIdx = idx('participants');
  const holdIdx = idx('hold_sec');
  if (startIdx < 0) {
    return [{ rowNumber: 1, error: 'ヘッダ行に start_time 列が見つかりません' }];
  }
  const out: ParsedRow[] = [];
  for (let r = 1; r < rows.length; r++) {
    const cols = rows[r];
    const startTime = cols[startIdx]?.trim();
    if (!startTime) {
      out.push({ rowNumber: r + 1, error: 'start_time が空です' });
      continue;
    }
    if (isNaN(new Date(startTime).getTime())) {
      out.push({ rowNumber: r + 1, error: `start_time が不正: ${startTime}` });
      continue;
    }
    const endTime = endIdx >= 0 ? cols[endIdx]?.trim() : '';
    let endVal: string | null = null;
    let durationSec: number | null = null;
    if (endTime) {
      if (isNaN(new Date(endTime).getTime())) {
        out.push({ rowNumber: r + 1, error: `end_time が不正: ${endTime}` });
        continue;
      }
      if (new Date(endTime).getTime() < new Date(startTime).getTime()) {
        out.push({ rowNumber: r + 1, error: `end_time が start_time より前です` });
        continue;
      }
      endVal = new Date(endTime).toISOString();
      durationSec = Math.max(
        0,
        Math.round((new Date(endTime).getTime() - new Date(startTime).getTime()) / 1000),
      );
    }
    const holdSec = holdIdx >= 0 ? Number(cols[holdIdx] ?? 0) : 0;
    const memo = memoIdx >= 0 ? (cols[memoIdx] ?? '') : '';
    if (memo.length > 10000) {
      out.push({ rowNumber: r + 1, error: 'memo が 10000 字を超えています' });
      continue;
    }
    const kindRaw = kindIdx >= 0 ? cols[kindIdx]?.trim() : '';
    const participantsRaw = participantsIdx >= 0 ? (cols[participantsIdx]?.trim() ?? '') : '';
    out.push({
      rowNumber: r + 1,
      record: {
        id: idIdx >= 0 ? (cols[idIdx]?.trim() || undefined) : undefined,
        kind: kindRaw === 'meeting' ? 'meeting' : 'call',
        startTime: new Date(startTime).toISOString(),
        endTime: endVal,
        durationSec,
        ...tagsPatch(tagIdx >= 0 ? (cols[tagIdx]?.split(';').map((t) => t.trim()).filter(Boolean) ?? []) : []),
        memo,
        contactName: contactIdx >= 0 ? (cols[contactIdx]?.trim() || undefined) : undefined,
        phoneNumber: phoneIdx >= 0 ? (cols[phoneIdx]?.trim() || undefined) : undefined,
        title: titleIdx >= 0 ? (cols[titleIdx]?.trim() || undefined) : undefined,
        participants: participantsRaw ? participantsRaw.split(';').map((p) => p.trim()).filter(Boolean) : undefined,
        holdSec: isNaN(holdSec) ? 0 : Math.max(0, Math.round(holdSec)),
      },
    });
  }
  return out;
}
