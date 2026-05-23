import { useState } from 'react';

interface Props {
  value: string;
  onChange: (next: string) => void;
}

const MOD_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta']);

function eventToAccelerator(e: React.KeyboardEvent): string | null {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Control');
  if (e.shiftKey) parts.push('Shift');
  if (e.altKey) parts.push('Alt');
  if (e.metaKey) parts.push('Super');
  const key = e.key;
  if (MOD_KEYS.has(key)) return null;
  let token = key;
  if (key === ' ') token = 'Space';
  else if (key.length === 1) token = key.toUpperCase();
  else if (key.startsWith('Arrow')) token = key.replace('Arrow', '');
  parts.push(token);
  return parts.join('+');
}

export function ShortcutInput({ value, onChange }: Props) {
  const [recording, setRecording] = useState(false);

  return (
    <div className="flex items-center gap-2">
      <input
        readOnly
        value={value}
        placeholder="未設定"
        onKeyDown={(e) => {
          if (!recording) return;
          e.preventDefault();
          const accel = eventToAccelerator(e);
          if (accel) {
            onChange(accel);
            setRecording(false);
          }
        }}
        onFocus={() => setRecording(true)}
        onBlur={() => setRecording(false)}
        className={`w-48 rounded-md border px-3 py-2 font-mono text-sm tabular-nums ${
          recording
            ? 'border-brand-500 bg-brand-50 ring-2 ring-brand-200 dark:bg-brand-900/40 dark:text-slate-100'
            : 'border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100'
        }`}
      />
      <button
        type="button"
        onClick={() => onChange('')}
        className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
      >
        クリア
      </button>
      {recording && <span className="text-xs text-brand-600 dark:text-brand-300">キーを押してください…</span>}
    </div>
  );
}
