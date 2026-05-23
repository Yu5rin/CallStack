import { ReactNode } from 'react';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Wrap every case-insensitive occurrence of `query` in `text` with a <mark>.
 * Returns the original text untouched when the query is empty or has no hit.
 */
export function highlight(text: string | null | undefined, query: string): ReactNode {
  const value = text ?? '';
  const q = query.trim();
  if (!q) return value;
  const re = new RegExp(escapeRegExp(q), 'gi');
  const parts: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    if (m.index > last) parts.push(value.slice(last, m.index));
    parts.push(
      <mark
        key={`m-${m.index}`}
        className="rounded bg-yellow-200 px-0.5 text-inherit dark:bg-yellow-700/60"
      >
        {m[0]}
      </mark>,
    );
    last = m.index + m[0].length;
    // Guard against zero-width matches (impossible here, but safe).
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  if (last < value.length) parts.push(value.slice(last));
  return parts.length === 0 ? value : parts;
}
