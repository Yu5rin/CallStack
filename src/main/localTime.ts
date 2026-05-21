/**
 * Format a Date or ISO string as an ISO 8601 timestamp using the local
 * timezone (e.g. "2026-05-21T15:32:45+09:00"). Round-trips through
 * `new Date(...)` without losing the instant.
 */
export function localIso(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  const pad = (n: number) => n.toString().padStart(2, '0');
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const oh = pad(Math.floor(Math.abs(offsetMin) / 60));
  const om = pad(Math.abs(offsetMin) % 60);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${oh}:${om}`
  );
}

/** Local-date "YYYY-MM-DD" (date part of localIso). */
export function localDate(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local "YYYYMMDD" stamp (no separators). */
export function localDateStamp(value: Date | string): string {
  return localDate(value).replace(/-/g, '');
}
