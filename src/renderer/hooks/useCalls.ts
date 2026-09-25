import { useEffect, useState, useCallback } from 'react';
import { CallRecord, AppEvent } from '../../shared/types';

export function useCalls() {
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const list = await window.api.calls.list();
      setCalls(list);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const list = await window.api.calls.list();
        if (!mounted) return;
        setCalls(list);
        setError(null);
      } catch (err) {
        if (!mounted) return;
        setError(err);
      } finally {
        if (mounted) setLoading(false);
      }
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
      } else if (e.type === 'data:restored') {
        void reload();
      }
    });
    return () => {
      mounted = false;
      off();
    };
  }, []);

  return { calls, loading, error, reload };
}

/**
 * Centralised delete flow. Honours the `confirmCallDelete` setting so the
 * confirmation can be toggled off for both the list (Delete key) and the
 * edit dialog (削除 button).
 */
export async function deleteCallWithConfirm(
  id: string,
  confirmEnabled: boolean,
): Promise<boolean> {
  if (confirmEnabled) {
    const ok = window.confirm('この記録をゴミ箱に移動しますか？（30日以内なら復元できます）');
    if (!ok) return false;
  }
  await window.api.calls.delete(id);
  return true;
}
