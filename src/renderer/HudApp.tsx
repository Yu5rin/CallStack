import { useEffect, useRef, useState } from 'react';
import { useActiveCall } from './hooks/useActiveCall';
import { formatHMS } from './utils/format';
import { RecordingManager } from './recorder/RecordingManager';
import { LevelMeter } from './recorder/LevelMeter';
import { AppEvent, Settings } from '../shared/types';

export function HudApp() {
  const { active, elapsedSec, holding, holdSec } = useActiveCall();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [recording, setRecording] = useState(false);
  const [level, setLevel] = useState(0);
  const [recError, setRecError] = useState<string | null>(null);
  const managerRef = useRef<RecordingManager | null>(null);

  useEffect(() => {
    window.api.settings.get().then(setSettings);
    const off = window.api.onEvent((e: AppEvent) => {
      if (e.type === 'settings:updated') setSettings(e.settings);
    });
    return () => off();
  }, []);

  // Start / stop recording based on active call + settings
  useEffect(() => {
    if (!settings) return;
    const rec = settings.recording;

    if (active && rec.enabled && !managerRef.current) {
      const mgr = new RecordingManager();
      managerRef.current = mgr;
      setRecError(null);
      mgr.start({
        callId: active.id,
        source: rec.source,
        micDeviceId: rec.micDeviceId,
        onLevel: (v) => setLevel(v),
        onError: (err) => setRecError(err.message),
      }).then(() => setRecording(true))
        .catch((err) => {
          setRecError(err.message);
          managerRef.current = null;
        });
    }

    if (!active && managerRef.current) {
      const mgr = managerRef.current;
      managerRef.current = null;
      setRecording(false);
      setLevel(0);
      mgr.stop().catch((err) => setRecError(err.message));
    }
  }, [active?.id, settings?.recording.enabled, settings?.recording.source, settings?.recording.micDeviceId]);

  const handleEnd = async () => {
    await window.api.hud.end();
  };
  const handleOpenMain = () => {
    window.api.hud.openMain();
  };
  const handleToggleHold = () => {
    window.api.calls.toggleHold();
  };

  if (!active) {
    return (
      <div className="hud-drag h-full w-full rounded-2xl bg-slate-900/90 px-4 py-3 text-slate-100 shadow-2xl">
        <div className="text-xs opacity-70">通話なし</div>
      </div>
    );
  }

  return (
    <div className="hud-drag h-full w-full select-none rounded-2xl bg-slate-900/95 px-4 py-2 text-slate-100 shadow-2xl ring-1 ring-white/10">
      <div className="flex items-center justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider">
            {holding ? (
              <span className="text-amber-400">⏸ HOLD {formatHMS(holdSec)}</span>
            ) : (
              <span className="text-emerald-400">● 通話中</span>
            )}
            {recording && <span className="text-red-400">● REC</span>}
          </div>
          <div className="flex items-center gap-2">
            <div className="font-mono text-2xl font-bold tabular-nums">{formatHMS(elapsedSec)}</div>
            {recording && <LevelMeter level={level} className="ml-1" />}
          </div>
          {recError && (
            <div className="truncate text-[10px] text-red-300" title={recError}>録音エラー: {recError}</div>
          )}
        </div>
        <div className="hud-no-drag flex flex-col gap-1">
          <button
            onClick={handleEnd}
            className="rounded-lg bg-red-500 px-3 py-1 text-xs font-semibold text-white shadow hover:bg-red-600"
          >
            終了
          </button>
          <button
            onClick={handleToggleHold}
            className={`rounded-lg px-3 py-1 text-xs ${holding ? 'bg-amber-500 text-white hover:bg-amber-600' : 'bg-slate-700 text-slate-100 hover:bg-slate-600'}`}
          >
            {holding ? '解除' : '保留'}
          </button>
          <button
            onClick={handleOpenMain}
            className="rounded-lg bg-slate-700 px-3 py-1 text-xs text-slate-100 hover:bg-slate-600"
          >
            メモ
          </button>
        </div>
      </div>
    </div>
  );
}
