import { globalShortcut } from 'electron';
import { ShortcutSettings } from '../shared/types';

export interface ShortcutHandlers {
  start: () => void;
  startMeeting: () => void;
  end: () => void;
  toggle: () => void;
  toggleHold: () => void;
  togglePauseRecording: () => void;
  openSettings: () => void;
  assignTag: (idx: number) => void;
}

export function registerShortcuts(shortcuts: ShortcutSettings, handlers: ShortcutHandlers): string[] {
  globalShortcut.unregisterAll();
  const failures: string[] = [];
  const attempts: Array<[string, () => void, string]> = [
    [shortcuts.startCall, handlers.start, 'startCall'],
    [shortcuts.startMeeting, handlers.startMeeting, 'startMeeting'],
    [shortcuts.endCall, handlers.end, 'endCall'],
    [shortcuts.toggleWindow, handlers.toggle, 'toggleWindow'],
    [shortcuts.toggleHold, handlers.toggleHold, 'toggleHold'],
    [shortcuts.togglePauseRecording, handlers.togglePauseRecording, 'togglePauseRecording'],
    [shortcuts.openSettings, handlers.openSettings, 'openSettings'],
    [shortcuts.assignTag1, () => handlers.assignTag(0), 'assignTag1'],
    [shortcuts.assignTag2, () => handlers.assignTag(1), 'assignTag2'],
    [shortcuts.assignTag3, () => handlers.assignTag(2), 'assignTag3'],
    [shortcuts.assignTag4, () => handlers.assignTag(3), 'assignTag4'],
  ];
  for (const [accel, handler, label] of attempts) {
    if (!accel) continue;
    try {
      const ok = globalShortcut.register(accel, handler);
      if (!ok) failures.push(`${label} (${accel})`);
    } catch (err) {
      console.error(`[shortcuts] failed to register ${label}=${accel}:`, err);
      failures.push(`${label} (${accel})`);
    }
  }
  return failures;
}

export function unregisterAll(): void {
  globalShortcut.unregisterAll();
}
