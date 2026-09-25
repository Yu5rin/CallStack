import { useEffect, useState, useCallback } from 'react';
import { Settings, AppEvent } from '../../shared/types';

export function useSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(() => {
    let mounted = true;
    setError(null);
    window.api.settings.get().then((s) => {
      if (mounted) setSettings(s);
    }).catch((err) => {
      if (mounted) setError(err);
    });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const cancel = load();
    const off = window.api.onEvent((e: AppEvent) => {
      if (e.type === 'settings:updated') setSettings(e.settings);
    });
    return () => {
      cancel();
      off();
    };
  }, [load]);

  const save = useCallback(async (next: Settings) => {
    const saved = await window.api.settings.update(next);
    setSettings(saved);
  }, []);

  return { settings, save, error, reload: load };
}
