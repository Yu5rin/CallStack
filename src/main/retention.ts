import { Store } from './store';
import { deleteRecording } from './recording';

export async function cleanupExpiredRecordings(store: Store, broadcast: (channel: string, payload: unknown) => void): Promise<number> {
  const days = store.getSettings().recording.retentionDays;
  if (days === null || days === undefined || days <= 0) return 0;
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  let deleted = 0;
  for (const c of store.getCalls()) {
    if (!c.audio) continue;
    const t = new Date(c.startTime).getTime();
    if (t < cutoffMs) {
      try { await deleteRecording(c.audio.path); } catch { /* ignore */ }
      const updated = store.updateCall(c.id, { audio: undefined });
      if (updated) {
        broadcast('app-event', { type: 'call:updated', record: updated });
        deleted += 1;
      }
    }
  }
  return deleted;
}

let timer: NodeJS.Timeout | null = null;

export function scheduleDailyCleanup(store: Store, broadcast: (channel: string, payload: unknown) => void): void {
  if (timer) clearInterval(timer);
  // Run once at startup and every 12 hours
  void cleanupExpiredRecordings(store, broadcast).catch((err) => console.error('[retention]', err));
  timer = setInterval(() => {
    cleanupExpiredRecordings(store, broadcast).catch((err) => console.error('[retention]', err));
  }, 12 * 60 * 60 * 1000);
}

export function stopDailyCleanup(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
