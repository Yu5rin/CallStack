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
}

export function useRecorder(
  active: ActiveLike | null,
  settings: Settings | null,
): UseRecorderState {
  const [recording, setRecording] = useState(false);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const managerRef = useRef<RecordingManager | null>(null);

  useEffect(() => {
    if (!settings) return;
    const rec = settings.recording;

    if (active && rec.enabled && !managerRef.current) {
      const mgr = new RecordingManager();
      managerRef.current = mgr;
      setError(null);
      mgr.start({
        callId: active.id,
        source: rec.source,
        micDeviceId: rec.micDeviceId,
        onLevel: (v) => setLevel(v),
        onError: (err) => setError(err.message),
      })
        .then(() => setRecording(true))
        .catch((err) => {
          setError(err.message);
          managerRef.current = null;
          setRecording(false);
        });
    }

    if (!active && managerRef.current) {
      const mgr = managerRef.current;
      managerRef.current = null;
      setRecording(false);
      setLevel(0);
      mgr.stop().catch((err) => setError(err.message));
    }
  }, [active?.id, settings?.recording.enabled, settings?.recording.source, settings?.recording.micDeviceId]);

  return { recording, level, error };
}
