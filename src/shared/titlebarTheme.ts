import type { ThemePref } from './types';

/**
 * ThemePref の 'system' を解決した後の実効テーマ。
 * useTheme フック（renderer）が computed する値と同じもので、
 * Windows のタイトルバーオーバーレイ（main プロセス）にもこれを使う。
 */
export type EffectiveTheme = 'light' | 'dark' | 'black';

export interface TitleBarOverlayColors {
  color: string;
  symbolColor: string;
}

/**
 * Windows の titleBarOverlay 用の色定義。
 *
 * ヘッダー（App.tsx）の Tailwind クラスと同じ色を指すよう手で合わせてある
 * （light: bg-white, dark: dark:bg-slate-900, black: index.css の
 * html.black 上書きで #000）。main（初期表示・IPC 経由の更新）と
 * renderer（IPC 送信元の値としての参照）の両方がこの1箇所だけを見るため、
 * 色の定義がコード中に重複しない。ヘッダーの配色を変えた場合はここも
 * 合わせて更新すること。
 */
export const TITLEBAR_COLORS: Record<EffectiveTheme, TitleBarOverlayColors> = {
  light: { color: '#ffffff', symbolColor: '#334155' }, // white / slate-700
  dark: { color: '#0f172a', symbolColor: '#e2e8f0' },  // slate-900 / slate-200
  black: { color: '#000000', symbolColor: '#e2e8f0' }, // black / slate-200
};

/** タイトルバーの高さ(px)。App.tsx のヘッダー（h-[52px]）と揃えること。 */
export const TITLEBAR_HEIGHT = 52;

/** ThemePref（'system' を含む）から実効テーマを解決する */
export function resolveEffectiveTheme(pref: ThemePref, systemPrefersDark: boolean): EffectiveTheme {
  if (pref === 'system') return systemPrefersDark ? 'dark' : 'light';
  return pref;
}
