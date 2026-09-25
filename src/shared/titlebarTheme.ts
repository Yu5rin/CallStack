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
 * ヘッダー（App.tsx）の bg-chrome / text-ink と同じ色を指すよう手で合わせて
 * ある（トークンの chrome / ink。src/renderer/index.css の CSS 変数が実体）。
 * main（初期表示・IPC 経由の更新）と renderer（IPC 送信元の値としての参照）
 * の両方がこの1箇所だけを見るため、色の定義がコード中に重複しない。
 * ヘッダーの配色を変えた場合はここも合わせて更新すること。
 */
export const TITLEBAR_COLORS: Record<EffectiveTheme, TitleBarOverlayColors> = {
  light: { color: '#EFF1F0', symbolColor: '#1F2428' }, // chrome / ink
  dark: { color: '#0E1012', symbolColor: '#E4E7E5' },  // chrome / ink
  black: { color: '#000000', symbolColor: '#E4E7E5' }, // chrome / ink
};

/**
 * ウィンドウの初期背景色（paper トークン）。BrowserWindow 生成時の
 * backgroundColor に使い、コンテンツ読み込み前の白フラッシュを防ぐ。
 */
export const PAPER_COLORS: Record<EffectiveTheme, string> = {
  light: '#FBFBFA',
  dark: '#14171A',
  black: '#000000',
};

/** タイトルバーの高さ(px)。App.tsx のタイトルバー（h-10 / 40px）と揃えること。 */
export const TITLEBAR_HEIGHT = 40;

/** ThemePref（'system' を含む）から実効テーマを解決する */
export function resolveEffectiveTheme(pref: ThemePref, systemPrefersDark: boolean): EffectiveTheme {
  if (pref === 'system') return systemPrefersDark ? 'dark' : 'light';
  return pref;
}
