import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { AppEvent, CallRecord } from '../../shared/types';
import { formatHMShort } from '../utils/format';

function formatEta(sec: number): string {
  if (sec < 60) return `${sec}秒`;
  const m = Math.ceil(sec / 60);
  if (m < 60) return `約${m}分`;
  return `約${Math.floor(m / 60)}時間${m % 60 ? `${m % 60}分` : ''}`;
}

/** 文字起こし状況（進捗 %・推定残り時間・待機数）。記録一覧のフッターから再利用する。 */
export function TranscriptionStatusBar() {
  const [summary, setSummary] = useState<{
    running: { callId: string; percent: number; etaSec: number | null } | null;
    waiting: number;
  }>({ running: null, waiting: 0 });

  useEffect(() => {
    const off = window.api.onEvent((e: AppEvent) => {
      if (e.type === 'transcription:summary') {
        setSummary({ running: e.running, waiting: e.waiting });
      }
    });
    return () => off();
  }, []);

  if (!summary.running && summary.waiting === 0) return null;

  return (
    <div className="flex items-center gap-2 text-xs text-ink-mute">
      <Loader2 size={13} className="animate-spin text-accent-ink" />
      {summary.running ? (
        <span>
          文字起こし中 <span className="font-medium tabular-nums">{summary.running.percent}%</span>
          {summary.running.etaSec !== null && (
            <span className="text-ink-mute">（残り {formatEta(summary.running.etaSec)}）</span>
          )}
        </span>
      ) : (
        <span>文字起こしを準備中…</span>
      )}
      {summary.waiting > 0 && (
        <span className="text-ink-mute">/ 待機 {summary.waiting} 件</span>
      )}
    </div>
  );
}

interface Bucket {
  count: number;
  totalSec: number;
}

function aggregate(calls: CallRecord[]): { today: Bucket; week: Bucket; month: Bucket } {
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  // ISO-style week starting Monday at 00:00.
  const dayOfWeek = (now.getDay() + 6) % 7; // 0 = Mon
  const weekStart = dayStart - dayOfWeek * 86_400_000;
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

  const make = (): Bucket => ({ count: 0, totalSec: 0 });
  const today = make();
  const week = make();
  const month = make();

  for (const c of calls) {
    if (!c.endTime) continue;
    const at = new Date(c.startTime).getTime();
    const dur = c.durationSec ?? 0;
    if (at >= monthStart) {
      month.count++;
      month.totalSec += dur;
    }
    if (at >= weekStart) {
      week.count++;
      week.totalSec += dur;
    }
    if (at >= dayStart) {
      today.count++;
      today.totalSec += dur;
    }
  }
  return { today, week, month };
}

export function SummaryFooter({ calls }: { calls: CallRecord[] }) {
  const stats = useMemo(() => aggregate(calls), [calls]);

  const cell = (label: string, b: Bucket) => (
    <div className="flex items-baseline gap-1.5 text-ink">
      <span className="text-xs text-ink-mute">{label}</span>
      <span className="font-medium tabular-nums">{b.count}</span>
      <span className="text-xs text-ink-mute">件</span>
      <span className="font-mono text-xs tabular-nums text-ink-mute">
        {b.totalSec > 0 ? formatHMShort(b.totalSec) : '—'}
      </span>
    </div>
  );

  return (
    <footer className="flex flex-shrink-0 items-center justify-between border-t border-rule bg-chrome px-6 py-2 text-sm">
      <div className="flex gap-6">
        {cell('今日', stats.today)}
        {cell('今週', stats.week)}
        {cell('今月', stats.month)}
      </div>
      <TranscriptionStatusBar />
    </footer>
  );
}
