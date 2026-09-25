import { ReactNode } from 'react';
import { highlightText } from './searchUtils';

/**
 * 設定1項目分の行。左にラベル+説明、右（または `full` 指定時は下）にコントロールを置く。
 * `controlId` を渡すとラベルを <label htmlFor> で直接結びつけ、単一のネイティブ入力に対応する。
 * 複合的なコントロール（サブコンポーネント）の場合は role="group" + aria-labelledby で関連付ける。
 */
export function SettingsRow({
  id,
  label,
  description,
  controlId,
  full,
  query,
  children,
}: {
  id: string;
  label: string;
  description?: string;
  /** 単一のネイティブ input/select/textarea に付けた id。指定するとラベルと htmlFor で結びつく */
  controlId?: string;
  /** true でコントロールを下段へ全幅表示（複雑な UI 向け） */
  full?: boolean;
  /** 検索中のハイライト対象文字列（未検索時は undefined） */
  query?: string;
  children: ReactNode;
}) {
  const labelId = `${id}-label`;
  const LabelTag = controlId ? 'label' : 'div';

  return (
    <div
      className={`border-b border-rule px-4 py-3.5 last:border-b-0 ${
        full ? '' : 'flex flex-wrap items-start justify-between gap-x-4 gap-y-2'
      }`}
    >
      <div className={full ? 'mb-3' : 'min-w-0 flex-1'}>
        <LabelTag id={labelId} htmlFor={controlId} className="block text-[13px] font-medium text-ink">
          {query ? highlightText(label, query) : label}
        </LabelTag>
        {description && (
          <div className="mt-0.5 text-xs text-ink-mute">
            {query ? highlightText(description, query) : description}
          </div>
        )}
      </div>
      <div
        className={full ? 'w-full' : 'flex min-w-0 flex-none flex-wrap items-center gap-2'}
        {...(controlId ? {} : { role: 'group', 'aria-labelledby': labelId })}
      >
        {children}
      </div>
    </div>
  );
}
