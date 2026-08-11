import { useEffect } from 'react';
import type { ThemePref } from '../../shared/types';
import type { EffectiveTheme } from '../../shared/titlebarTheme';

export function useTheme(pref: ThemePref | undefined): void {
  useEffect(() => {
    if (!pref) return;
    const root = document.documentElement;
    const apply = () => {
      const effective: EffectiveTheme =
        pref === 'system'
          ? window.matchMedia('(prefers-color-scheme: dark)').matches
            ? 'dark'
            : 'light'
          : pref;
      const isDarkLike = effective === 'dark' || effective === 'black';
      root.classList.toggle('dark', isDarkLike);
      root.classList.toggle('black', effective === 'black');
      // Windows のタイトルバー色をテーマに連動させる（main プロセスへ通知）
      window.api.theme.changed(effective);
    };
    apply();
    if (pref === 'system') {
      const media = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = () => apply();
      media.addEventListener('change', handler);
      return () => media.removeEventListener('change', handler);
    }
  }, [pref]);
}
