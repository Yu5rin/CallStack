/**
 * 少数の選択肢を横並びのボタン群で切り替えるセグメントコントロール。
 * セレクトボックスより読みやすい小さな enum（テーマ・HUD サイズなど）向け。
 */
export function Segmented<T extends string>({
  id,
  value,
  options,
  onChange,
  disabled,
  ariaLabel,
  size = 'md',
}: {
  id?: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (next: T) => void;
  disabled?: boolean;
  ariaLabel?: string;
  size?: 'sm' | 'md';
}) {
  return (
    <div
      id={id}
      role="tablist"
      aria-label={ariaLabel}
      className={`inline-flex flex-wrap gap-0.5 rounded-md border border-rule bg-surface p-0.5 ${disabled ? 'opacity-50' : ''}`}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          disabled={disabled}
          onClick={() => onChange(o.value)}
          className={`rounded font-medium transition-colors ${
            size === 'sm' ? 'px-2 py-1 text-[11px]' : 'px-2.5 py-1.5 text-xs'
          } ${
            value === o.value
              ? 'bg-accent-soft text-accent-ink'
              : 'text-ink-mute hover:bg-paper hover:text-ink'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
