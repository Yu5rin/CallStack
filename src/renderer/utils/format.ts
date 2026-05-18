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

export function toDatetimeLocalValue(iso: string | null | undefined): string {
  if (!iso) return '';
  return dayjs(iso).format('YYYY-MM-DDTHH:mm:ss');
}

export function fromDatetimeLocalValue(v: string): string {
  return dayjs(v).toISOString();
}
