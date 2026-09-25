import { useState } from 'react';

interface Props {
  value: string;
  onChange: (next: string) => void;
}

const MOD_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta']);

function eventToAccelerator(e: React.KeyboardEvent): string | null {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
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
        className={`w-48 rounded-md border px-3 py-2 font-mono text-sm tabular-nums text-ink ${
          recording ? 'border-accent bg-accent-soft ring-2 ring-accent/30' : 'border-rule bg-surface'
        }`}
      />
      <button
        type="button"
        onClick={() => onChange('')}
        className="rounded-md border border-rule bg-surface px-2 py-1 text-xs text-ink-mute hover:bg-paper"
      >
        クリア
      </button>
      {recording && <span className="text-xs text-accent-ink">キーを押してください…</span>}
    </div>
  );
}
