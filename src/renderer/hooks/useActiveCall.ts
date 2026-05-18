import { useEffect, useState } from 'react';
import { CallRecord, AppEvent } from '../../shared/types';

export function useActiveCall() {
  const [active, setActive] = useState<CallRecord | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);

  useEffect(() => {
    let mounted = true;
    window.api.calls.getActive().then((c) => {
      if (!mounted) return;
      setActive(c);
      if (c) setElapsedSec(Math.floor((Date.now() - new Date(c.startTime).getTime()) / 1000));
    });
    const off = window.api.onEvent((e: AppEvent) => {
      if (e.type === 'call:started') {
        setActive(e.record);
        setElapsedSec(0);
      } else if (e.type === 'call:ended') {
        setActive(null);
        setElapsedSec(0);
      } else if (e.type === 'tick') {
        setElapsedSec(e.elapsedSec);
      }
    });
    return () => {
      mounted = false;
      off();
    };
  }, []);

  return { active, elapsedSec };
}
