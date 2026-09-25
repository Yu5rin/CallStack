import dayjs from 'dayjs';

export function formatHMS(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return '—';
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rs = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(rs).padStart(2, '0')}`;
}

export function formatHMShort(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return '—';
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rs = s % 60;
  if (h > 0) return `${h}時間${m}分`;
  if (m > 0) return `${m}分${rs}秒`;
  return `${rs}秒`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return dayjs(iso).format('YYYY/MM/DD HH:mm:ss');
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return dayjs(iso).format('YYYY/MM/DD');
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return dayjs(iso).format('HH:mm:ss');
}

export function formatHM(iso: string | null | undefined): string {
  if (!iso) return '—';
  return dayjs(iso).format('HH:mm');
}

/** h:mm:ss（1時間未満なら m:ss）。記録一覧の日別合計など、短く読みやすい表記用 */
export function formatHMSCompact(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return '—';
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rs = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(rs).padStart(2, '0')}`;
  return `${m}:${String(rs).padStart(2, '0')}`;
}

/** mm:ss（1時間を超えても繰り上げず分表記のまま）。記録一覧の行の時間表示用 */
export function formatMSTotal(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return '—';
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${String(m).padStart(2, '0')}:${String(rs).padStart(2, '0')}`;
}

const WEEKDAYS_JA = ['日', '月', '火', '水', '木', '金', '土'];

export function dayKey(iso: string): string {
  return dayjs(iso).format('YYYY-MM-DD');
}

/** 日別グループの見出し。今日/昨日はプレフィックスを付け、それ以外は日付+曜日のみ */
export function formatDayHeader(iso: string): string {
  const d = dayjs(iso);
  const today = dayjs().startOf('day');
  const diffDays = d.startOf('day').diff(today, 'day');
  const base = `${d.month() + 1}月${d.date()}日（${WEEKDAYS_JA[d.day()]}）`;
  if (diffDays === 0) return `今日 ${base}`;
  if (diffDays === -1) return `昨日 ${base}`;
  return base;
}

export function toDatetimeLocalValue(iso: string | null | undefined): string {
  if (!iso) return '';
  return dayjs(iso).format('YYYY-MM-DDTHH:mm:ss');
}

export function fromDatetimeLocalValue(v: string): string {
  return dayjs(v).toISOString();
}
