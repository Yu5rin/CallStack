import { KeyboardEvent } from 'react';

/**
 * ON/OFF 設定用のスイッチ。role="switch" + aria-checked でスクリーンリーダーに状態を伝え、
 * Space/Enter でも切り替えられる（button 要素の既定動作でも対応済みだが明示しておく）。
 */
export function Switch({
  id,
  checked,
  onChange,
  disabled,
  label,
}: {
  id?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** 可視ラベルが別要素にある場合の aria-label（無くても動作する） */
  label?: string;
}) {
  const toggle = () => {
    if (disabled) return;
    onChange(!checked);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      toggle();
    }
  };

  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={toggle}
      onKeyDown={onKeyDown}
      className={`relative inline-flex h-[18px] w-8 flex-shrink-0 items-center rounded-full border transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? 'border-accent bg-accent' : 'border-rule bg-rule'
      }`}
    >
      <span
        aria-hidden="true"
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-surface shadow transition-transform ${
          checked ? 'translate-x-[15px]' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}
