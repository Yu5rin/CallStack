import { CallTranscript } from '../../shared/types';
import { formatHMS } from '../utils/format';

interface Props {
  transcript: CallTranscript | undefined;
  onSeek?: (sec: number) => void;
}

export function TranscriptView({ transcript, onSeek }: Props) {
  if (!transcript) {
    return <div className="text-sm text-slate-400">文字起こしはまだありません</div>;
  }
  const segments = transcript.segments ?? [];
  return (
    <div className="space-y-2">
      <div className="text-xs text-slate-500">
        モデル: {transcript.model} / 言語: {transcript.language || '自動'} / 生成: {new Date(transcript.createdAt).toLocaleString()}
      </div>
      {segments.length > 0 ? (
        <div className="max-h-64 overflow-auto rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
          {segments.map((s, i) => (
            <div
              key={i}
              onClick={() => onSeek?.(s.start)}
              className="flex cursor-pointer gap-3 rounded px-1 py-0.5 hover:bg-brand-50"
              title="クリックで該当位置を再生"
            >
              <span className="shrink-0 font-mono text-xs tabular-nums text-slate-400">
                {formatHMS(Math.floor(s.start))}
              </span>
              <span className="text-slate-800">{s.text}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-800 whitespace-pre-wrap">
          {transcript.text || '（空）'}
        </div>
      )}
    </div>
  );
}
