import { useState } from 'react';
import { CallTranscript } from '../../shared/types';
import { formatHMS } from '../utils/format';

interface Props {
  transcript: CallTranscript | undefined;
  onSeek?: (sec: number) => void;
  /** セグメントのテキスト修正（whisper の誤認識をその場で直す） */
  onEditSegment?: (index: number, text: string) => void;
}

export function TranscriptView({ transcript, onSeek, onEditSegment }: Props) {
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [draft, setDraft] = useState('');

  if (!transcript) {
    return <div className="text-sm text-slate-400 dark:text-slate-500">文字起こしはまだありません</div>;
  }
  const segments = transcript.segments ?? [];

  const startEdit = (i: number, text: string) => {
    setEditIdx(i);
    setDraft(text);
  };
  const commitEdit = () => {
    if (editIdx !== null && onEditSegment) {
      const text = draft.trim();
      if (text) onEditSegment(editIdx, text);
    }
    setEditIdx(null);
  };

  return (
    <div className="space-y-2">
      <div className="text-xs text-slate-500 dark:text-slate-400">
        モデル: {transcript.model} / 言語: {transcript.language || '自動'} / 生成: {new Date(transcript.createdAt).toLocaleString()}
        {onEditSegment && segments.length > 0 && (
          <span className="ml-2 text-slate-400 dark:text-slate-500">— ✏️ で誤認識を修正できます</span>
        )}
      </div>
      {segments.length > 0 ? (
        <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm dark:border-slate-700 dark:bg-slate-800">
          {segments.map((s, i) => (
            <div
              key={i}
              className="group flex gap-3 rounded px-1 py-0.5 hover:bg-brand-50 dark:hover:bg-brand-900/40"
            >
              <button
                onClick={() => onSeek?.(s.start)}
                className="shrink-0 cursor-pointer font-mono text-xs tabular-nums text-slate-400 hover:text-brand-600 dark:text-slate-500 dark:hover:text-brand-300"
                title="クリックで該当位置を再生"
              >
                {formatHMS(Math.floor(s.start))}
              </button>
              {editIdx === i ? (
                <span className="flex min-w-0 flex-1 items-start gap-1.5">
                  <textarea
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitEdit(); }
                      if (e.key === 'Escape') setEditIdx(null);
                    }}
                    rows={Math.max(1, Math.ceil(draft.length / 60))}
                    className="min-w-0 flex-1 resize-y rounded border border-brand-300 bg-white px-2 py-0.5 text-sm dark:border-brand-700 dark:bg-slate-900 dark:text-slate-100"
                  />
                  <button
                    onClick={commitEdit}
                    className="shrink-0 rounded bg-brand-600 px-2 py-0.5 text-xs font-semibold text-white hover:bg-brand-700"
                    title="保存 (Enter)"
                  >
                    保存
                  </button>
                  <button
                    onClick={() => setEditIdx(null)}
                    className="shrink-0 rounded px-1.5 py-0.5 text-xs text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-700"
                    title="キャンセル (Esc)"
                  >
                    ✕
                  </button>
                </span>
              ) : (
                <>
                  <span
                    className="min-w-0 flex-1 cursor-pointer text-slate-800 dark:text-slate-200"
                    onClick={() => onSeek?.(s.start)}
                    title="クリックで該当位置を再生"
                  >
                    {s.text}
                  </span>
                  {onEditSegment && (
                    <button
                      onClick={() => startEdit(i, s.text)}
                      className="invisible shrink-0 rounded px-1 text-xs text-slate-400 hover:text-brand-600 group-hover:visible dark:hover:text-brand-300"
                      title="このセグメントを修正"
                    >
                      ✏️
                    </button>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-800 whitespace-pre-wrap dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
          {transcript.text || '（空）'}
        </div>
      )}
    </div>
  );
}
