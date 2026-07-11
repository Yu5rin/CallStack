import { useEffect, useState } from 'react';
import { CallRecord, AppEvent } from '../../shared/types';

export function useActiveCall() {
  const [active, setActive] = useState<CallRecord | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [holding, setHolding] = useState(false);
  const [holdSec, setHoldSec] = useState(0);

  useEffect(() => {
    let mounted = true;
    window.api.calls.getActive().then((c) => {
      if (!mounted) return;
      setActive(c);
      if (c) {
        setElapsedSec(Math.floor((Date.now() - new Date(c.startTime).getTime()) / 1000));
        const lastHold = c.holds && c.holds.length ? c.holds[c.holds.length - 1] : null;
        setHolding(!!lastHold && lastHold.end === null);
        setHoldSec(c.holdSec ?? 0);
      }
    });
    const off = window.api.onEvent((e: AppEvent) => {
      if (e.type === 'call:started') {
        setActive(e.record);
        setElapsedSec(0);
        setHolding(false);
        setHoldSec(0);
      } else if (e.type === 'call:ended') {
        setActive(null);
        setElapsedSec(0);
        setHolding(false);
        setHoldSec(0);
      } else if (e.type === 'tick') {
        setElapsedSec(e.elapsedSec);
        setHolding(e.holding);
        setHoldSec(e.holdSec);
      } else if (e.type === 'hold:changed') {
        setHolding(e.holding);
        setHoldSec(e.holdSec);
      } else if (e.type === 'call:updated') {
        // クロージャの active は古いので関数型更新で照合する。
        // 進行中の記録に対する更新（種別変更・タイトル入力など）のみ反映する。
        setActive((prev) => (prev && e.record.id === prev.id && !e.record.endTime ? e.record : prev));
      }
    });
    return () => {
      mounted = false;
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { active, elapsedSec, holding, holdSec };
}
