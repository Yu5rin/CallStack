import { useEffect, useState, useCallback } from 'react';
import { CallRecord, AppEvent } from '../../shared/types';

export function useCalls() {
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const list = await window.api.calls.list();
    setCalls(list);
  }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const list = await window.api.calls.list();
      if (!mounted) return;
      setCalls(list);
      setLoading(false);
    })();
    const off = window.api.onEvent((e: AppEvent) => {
      if (
        e.type === 'call:started' ||
        e.type === 'call:ended' ||
        e.type === 'call:updated'
      ) {
        setCalls((prev) => {
          const idx = prev.findIndex((c) => c.id === e.record.id);
          if (idx >= 0) {
            const next = prev.slice();
            next[idx] = e.record;
            return next;
          }
          return [...prev, e.record];
        });
      } else if (e.type === 'call:deleted') {
        setCalls((prev) => prev.filter((c) => c.id !== e.id));
      }
    });
    return () => {
      mounted = false;
      off();
    };
  }, []);

  return { calls, loading, reload };
}
