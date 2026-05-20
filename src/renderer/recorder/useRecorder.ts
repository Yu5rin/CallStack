import { useEffect, useRef, useState } from 'react';
import { RecordingManager } from './RecordingManager';
import { Settings } from '../../shared/types';

interface ActiveLike {
  id: string;
}

export interface UseRecorderState {
  recording: boolean;
  level: number;
  error: string | null;
  clearError: () => void;
}

export function useRecorder(
  active: ActiveLike | null,
  settings: Settings | null,
): UseRecorderState {
  const [recording, setRecording] = useState(false);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const managerRef = useRef<RecordingManager | null>(null);
  const clearTimerRef = useRef<number | null>(null);

  const reportError = (msg: string) => {
    setError(msg);
    if (clearTimerRef.current !== null) window.clearTimeout(clearTimerRef.current);
    clearTimerRef.current = window.setTimeout(() => {
      setError(null);
      clearTimerRef.current = null;
    }, 8000);
  };

  const clearError = () => {
    setError(null);
    if (clearTimerRef.current !== null) {
      window.clearTimeout(clearTimerRef.current);
      clearTimerRef.current = null;
    }
  };

  useEffect(() => {
    if (!settings) return;
    const rec = settings.recording;

    if (active && rec.enabled && !managerRef.current) {
      const mgr = new RecordingManager();
      managerRef.current = mgr;
      clearError();
      mgr.start({
        callId: active.id,
        source: rec.source,
        micDeviceId: rec.micDeviceId,
        onLevel: (v) => setLevel(v),
        onError: (err) => {
          if (!/invoking remote method/i.test(err.message)) reportError(err.message);
          else console.warn('[recorder] IPC error:', err);
        },
      })
        .then(() => setRecording(true))
        .catch((err) => {
          reportError(err.message);
          managerRef.current = null;
          setRecording(false);
        });
    }

    if (!active && managerRef.current) {
      const mgr = managerRef.current;
      managerRef.current = null;
      setRecording(false);
      setLevel(0);
      mgr.stop().catch((err) => {
        // Recording finalize may fail with generic IPC errors that are not
        // actionable for the user. Log them but don't pollute the UI.
        console.warn('[recorder] stop failed:', err);
      });
    }
  }, [active?.id, settings?.recording.enabled, settings?.recording.source, settings?.recording.micDeviceId]);

  return { recording, level, error, clearError };
}
