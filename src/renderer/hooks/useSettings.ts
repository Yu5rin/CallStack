import { useEffect, useState, useCallback } from 'react';
import { Settings, AppEvent } from '../../shared/types';

export function useSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    let mounted = true;
    window.api.settings.get().then((s) => {
      if (mounted) setSettings(s);
    });
    const off = window.api.onEvent((e: AppEvent) => {
      if (e.type === 'settings:updated') setSettings(e.settings);
    });
    return () => {
      mounted = false;
      off();
    };
  }, []);

  const save = useCallback(async (next: Settings) => {
    const saved = await window.api.settings.update(next);
    setSettings(saved);
  }, []);

  return { settings, save };
}
