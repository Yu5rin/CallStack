import { globalShortcut } from 'electron';
import { ShortcutSettings } from '../shared/types';

export interface ShortcutHandlers {
  start: () => void;
  end: () => void;
  toggle: () => void;
}

export function registerShortcuts(shortcuts: ShortcutSettings, handlers: ShortcutHandlers): string[] {
  globalShortcut.unregisterAll();
  const failures: string[] = [];
  const attempts: Array<[string, () => void, string]> = [
    [shortcuts.startCall, handlers.start, 'startCall'],
    [shortcuts.endCall, handlers.end, 'endCall'],
    [shortcuts.toggleWindow, handlers.toggle, 'toggleWindow'],
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
