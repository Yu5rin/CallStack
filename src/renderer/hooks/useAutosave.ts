import { useCallback, useEffect, useRef, useState } from 'react';

export type AutosaveStatus =
  | { state: 'idle' }
  | { state: 'saving' }
  | { state: 'saved'; at: string }
  | { state: 'error'; message: string };

const DEBOUNCE_MS = 600;

/**
 * フィールド単位の差分（dirty）を溜めておき、デバウンス後・blur時・レコード切替時に
 * まとめて保存する自動保存ユーティリティ。詳細ペイン（RecordDetail）から使う。
 *
 * - markDirty: 編集したフィールドだけを蓄積する（未編集フィールドは送らない）
 * - flush: 今すぐ保存する（blur・選択切替・アンマウント・ウィンドウ blur で呼ぶ）
 */
export function useAutosave<T extends object>(save: (patch: Partial<T>) => Promise<void>) {
  const dirtyRef = useRef<Partial<T>>({});
  const timerRef = useRef<number | null>(null);
  const saveRef = useRef(save);
  saveRef.current = save;
  const [status, setStatus] = useState<AutosaveStatus>({ state: 'idle' });

  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const patch = dirtyRef.current;
    if (Object.keys(patch).length === 0) return;
    dirtyRef.current = {};
    setStatus({ state: 'saving' });
    saveRef.current(patch)
      .then(() => setStatus({ state: 'saved', at: new Date().toISOString() }))
      .catch((err) => setStatus({ state: 'error', message: err instanceof Error ? err.message : String(err) }));
  }, []);

  const markDirty = useCallback(<K extends keyof T>(key: K, value: T[K]) => {
    dirtyRef.current = { ...dirtyRef.current, [key]: value };
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(flush, DEBOUNCE_MS);
  }, [flush]);

  const hasDirty = useCallback(() => Object.keys(dirtyRef.current).length > 0, []);
  const isDirty = useCallback(<K extends keyof T>(key: K) => key in dirtyRef.current, []);

  // ウィンドウが背面に回ったとき（blur）・アプリ終了直前（beforeunload）にも保存する
  useEffect(() => {
    window.addEventListener('blur', flush);
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('blur', flush);
      window.removeEventListener('beforeunload', flush);
    };
  }, [flush]);

  // アンマウント（＝選択レコードの切り替え）時にも未保存分を必ず送る
  useEffect(() => () => flush(), [flush]);

  return { markDirty, flush, status, hasDirty, isDirty };
}
