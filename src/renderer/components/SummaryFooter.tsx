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

/** フッター右側の文字起こし状況（進捗 %・推定残り時間・待機数） */
function TranscriptionStatusBar() {
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
    <div className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
      <Loader2 size={13} className="animate-spin text-brand-600 dark:text-brand-300" />
      {summary.running ? (
        <span>
          文字起こし中 <span className="font-semibold tabular-nums">{summary.running.percent}%</span>
          {summary.running.etaSec !== null && (
            <span className="text-slate-500 dark:text-slate-400">（残り {formatEta(summary.running.etaSec)}）</span>
          )}
        </span>
      ) : (
        <span>文字起こしを準備中…</span>
      )}
      {summary.waiting > 0 && (
        <span className="text-slate-400 dark:text-slate-500">/ 待機 {summary.waiting} 件</span>
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
    <div className="flex items-baseline gap-1.5 text-slate-700 dark:text-slate-300">
      <span className="text-xs text-slate-500 dark:text-slate-400">{label}</span>
      <span className="font-semibold tabular-nums">{b.count}</span>
      <span className="text-xs text-slate-500 dark:text-slate-400">件</span>
      <span className="font-mono text-xs tabular-nums text-slate-600 dark:text-slate-400">
        {b.totalSec > 0 ? formatHMShort(b.totalSec) : '—'}
      </span>
    </div>
  );

  return (
    <footer className="flex flex-shrink-0 items-center justify-between border-t border-slate-200 bg-white px-6 py-2 text-sm shadow-inner dark:border-slate-800 dark:bg-slate-900">
      <div className="flex gap-6">
        {cell('今日', stats.today)}
        {cell('今週', stats.week)}
        {cell('今月', stats.month)}
      </div>
      <TranscriptionStatusBar />
    </footer>
  );
}
