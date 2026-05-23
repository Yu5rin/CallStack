import { useEffect } from 'react';
import type { ThemePref } from '../../shared/types';

export function useTheme(pref: ThemePref | undefined): void {
  useEffect(() => {
    if (!pref) return;
    const root = document.documentElement;
    const apply = () => {
      const effective =
        pref === 'system'
          ? window.matchMedia('(prefers-color-scheme: dark)').matches
            ? 'dark'
            : 'light'
          : pref;
      const isDarkLike = effective === 'dark' || effective === 'black';
      root.classList.toggle('dark', isDarkLike);
      root.classList.toggle('black', effective === 'black');
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
