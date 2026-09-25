import { Fragment, ReactNode } from 'react';

/** 検索対象になる1行分の情報（見出しに使う label / description に加え、同義語 keywords も対象） */
export interface RowMeta {
  label: string;
  description?: string;
  keywords?: string[];
}

/** 行がクエリに一致するか（ラベル・説明・キーワードのいずれかに部分一致） */
export function rowMatches(row: RowMeta, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  if (row.label.toLowerCase().includes(q)) return true;
  if (row.description && row.description.toLowerCase().includes(q)) return true;
  if (row.keywords && row.keywords.some((k) => k.toLowerCase().includes(q))) return true;
  return false;
}

/** 一致箇所を <mark> でハイライトする（最初の一致のみ。大文字小文字を区別しない） */
export function highlightText(text: string, query: string): ReactNode {
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <Fragment>
      {text.slice(0, idx)}
      <mark className="rounded-sm bg-pending/30 text-inherit">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </Fragment>
  );
}
