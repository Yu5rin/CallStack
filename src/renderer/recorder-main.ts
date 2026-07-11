import { RecordingManager } from './recorder/RecordingManager';
import { AppEvent, CallRecord } from '../shared/types';
import { beep } from './utils/beep';

/**
 * 録音サービスウィンドウ（不可視）のエントリポイント。
 *
 * メディアキャプチャ（getUserMedia / getDisplayMedia / MediaRecorder）を
 * メイン窓から分離してここで実行する。メイン窓の最小化・復帰・再読み込みが
 * 録音に一切影響しなくなり、最小化復帰時のフリーズ要因も取り除ける。
 *
 * main プロセスとの通信:
 * - call:started / call:ended イベントで録音を開始・停止
 * - recording:togglePause イベントで一時停止/再開
 * - recording:report-state / report-level / report-error で状態を報告
 */

let manager: RecordingManager | null = null;
let soundFeedback = true;
let lastLevelSent = 0;

function reportLevel(v: number): void {
  const now = performance.now();
  if (now - lastLevelSent < 200) return;
  lastLevelSent = now;
  void window.api.recording.reportLevel(v).catch(() => {});
}

async function startRecording(rec: CallRecord): Promise<void> {
  if (manager) return;
  const cfg = await window.api.recording.getStartConfig(rec.kind ?? 'call');
  if (!cfg.enabled) return;
  if (!cfg.config.mic && !cfg.config.system) return;

  const mgr = new RecordingManager();
  manager = mgr;
  try {
    await mgr.start({
      callId: rec.id,
      mic: cfg.config.mic,
      system: cfg.config.system,
      systemScope: cfg.config.systemScope,
      systemWindowId: cfg.windowId,
      micDeviceId: cfg.micDeviceId,
      onLevel: reportLevel,
      onWarning: (msg) => { void window.api.recording.reportError(msg); },
      onError: (err) => {
        if (!/invoking remote method/i.test(err.message)) {
          void window.api.recording.reportError(err.message);
        } else {
          console.warn('[recorder-window] IPC error:', err);
        }
      },
    });
    void window.api.recording.reportState(true, false);
  } catch (err) {
    manager = null;
    void window.api.recording.reportError((err as Error).message);
    void window.api.recording.reportState(false, false);
  }
}

function stopRecording(): void {
  const mgr = manager;
  manager = null;
  void window.api.recording.reportState(false, false);
  if (!mgr) return;
  mgr.stop().catch((err) => {
    console.warn('[recorder-window] stop failed:', err);
    void window.api.recording.reportError(`録音の保存に失敗しました: ${(err as Error).message}`);
  });
}

function togglePause(): void {
  if (!manager) return;
  const paused = manager.togglePause();
  if (paused === null) return;
  void window.api.recording.reportState(true, paused);
}

window.api.settings.get().then((s) => { soundFeedback = s.soundFeedback; });

window.api.onEvent((e: AppEvent) => {
  switch (e.type) {
    case 'settings:updated':
      soundFeedback = e.settings.soundFeedback;
      break;
    case 'call:started':
      if (soundFeedback) beep('start');
      void startRecording(e.record);
      break;
    case 'call:ended':
      if (soundFeedback) beep('end');
      stopRecording();
      break;
    case 'recording:togglePause':
      togglePause();
      break;
  }
});

// アプリ（または録音ウィンドウ）再起動時、進行中の記録があれば途中から録音を再開する
window.api.calls.getActive().then((active) => {
  if (active && !manager) void startRecording(active);
});
