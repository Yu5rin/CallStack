import { MutableRefObject, useEffect, useRef, useState } from 'react';
import { RecordingManager } from './RecordingManager';
import { AppEvent, RecordKind, RecordingSourceConfig, Settings } from '../../shared/types';

interface ActiveLike {
  id: string;
  kind?: RecordKind;
}

/** 開始ダイアログで選んだ、次の録音1回分のソース上書き */
export interface SourceOverride {
  config: RecordingSourceConfig;
  windowId: string | null;
}

export interface UseRecorderState {
  recording: boolean;
  paused: boolean;
  level: number;
  error: string | null;
  clearError: () => void;
}

export function useRecorder(
  active: ActiveLike | null,
  settings: Settings | null,
  sourceOverrideRef?: MutableRefObject<SourceOverride | null>,
): UseRecorderState {
  const [recording, setRecording] = useState(false);
  const [paused, setPaused] = useState(false);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const managerRef = useRef<RecordingManager | null>(null);
  const clearTimerRef = useRef<number | null>(null);
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = active?.id ?? null;

  // HUD やグローバルショートカットからの一時停止トグル指示を受ける。
  // 録音の実体（MediaRecorder）はこのウィンドウにしかないため、ここで処理して
  // 確定した状態を main 経由で全ウィンドウへ通知する。
  useEffect(() => {
    const off = window.api.onEvent((e: AppEvent) => {
      if (e.type !== 'recording:togglePause') return;
      const mgr = managerRef.current;
      const callId = activeIdRef.current;
      if (!mgr || !callId) return;
      const p = mgr.togglePause();
      if (p === null) return;
      setPaused(p);
      void window.api.recording.setPaused(callId, p);
    });
    return () => off();
  }, []);

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

  // レベルは HUD へも中継する（IPC を圧迫しないよう 200ms に間引き）
  const lastLevelSentRef = useRef(0);
  const handleLevel = (v: number) => {
    setLevel(v);
    const now = performance.now();
    if (now - lastLevelSentRef.current >= 200) {
      lastLevelSentRef.current = now;
      void window.api.recording.reportLevel(v).catch(() => {});
    }
  };

  useEffect(() => {
    if (!settings) return;
    const rec = settings.recording;

    if (active && rec.enabled && !managerRef.current) {
      // 優先順: 開始ダイアログでの選択（1回限り）→ 種別ごとの既定設定
      const override = sourceOverrideRef?.current ?? null;
      if (sourceOverrideRef) sourceOverrideRef.current = null;
      const cfg = override?.config
        ?? (active.kind === 'meeting' ? rec.meetingSource : rec.callSource);
      if (!cfg.mic && !cfg.system) {
        // ソースがすべて OFF の場合はこの記録では録音しない
        return;
      }
      const mgr = new RecordingManager();
      managerRef.current = mgr;
      clearError();
      mgr.start({
        callId: active.id,
        mic: cfg.mic,
        system: cfg.system,
        systemScope: cfg.systemScope,
        systemWindowId: override?.windowId ?? null,
        micDeviceId: rec.micDeviceId,
        onLevel: handleLevel,
        onWarning: (msg) => reportError(msg),
        onError: (err) => {
          if (!/invoking remote method/i.test(err.message)) reportError(err.message);
          else console.warn('[recorder] IPC error:', err);
        },
      })
        .then(() => { setRecording(true); setPaused(false); })
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
      setPaused(false);
      setLevel(0);
      mgr.stop().catch((err) => {
        // Recording finalize may fail with generic IPC errors that are not
        // actionable for the user. Log them but don't pollute the UI.
        console.warn('[recorder] stop failed:', err);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, active?.kind, settings?.recording.enabled, settings?.recording.micDeviceId, settings?.recording.callSource, settings?.recording.meetingSource]);

  return { recording, paused, level, error, clearError };
}
