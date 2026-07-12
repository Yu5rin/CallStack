import { useEffect, useMemo, useRef, useState } from 'react';
import { Pencil, X, LocateFixed } from 'lucide-react';
import { CallTranscript } from '../../shared/types';
import { formatHMS } from '../utils/format';

interface Props {
  transcript: CallTranscript | undefined;
  onSeek?: (sec: number) => void;
  /** セグメントのテキスト修正（whisper の誤認識をその場で直す） */
  onEditSegment?: (index: number, text: string) => void;
  /** 再生位置（秒）。指定すると該当セグメントをハイライトし自動追従する */
  currentSec?: number | null;
  /** ルート要素の追加クラス（min-h-0 flex-1 などレイアウト指定用） */
  className?: string;
}

export function TranscriptView({ transcript, onSeek, onEditSegment, currentSec = null, className = '' }: Props) {
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  // 自動追従: ユーザーが自分でスクロールしたら解除し、ボタンで復帰できる（Teams 風）
  const [autoFollow, setAutoFollow] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef<HTMLDivElement | null>(null);
  const progScrollUntil = useRef(0);

  const segments = transcript?.segments ?? [];

  /** 再生位置に対応するセグメント（開始時刻が currentSec 以下の最後の行） */
  const activeIdx = useMemo(() => {
    if (currentSec === null || segments.length === 0) return -1;
    let idx = -1;
    for (let i = 0; i < segments.length; i++) {
      if (segments[i].start <= currentSec + 0.05) idx = i;
      else break;
    }
    return idx;
  }, [currentSec, segments]);

  // 追従スクロール（プログラム起因のスクロールはユーザー操作と区別する）
  useEffect(() => {
    if (!autoFollow || activeIdx < 0) return;
    const el = activeRef.current;
    if (!el) return;
    progScrollUntil.current = Date.now() + 600;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [activeIdx, autoFollow]);

  const handleScroll = () => {
    if (Date.now() < progScrollUntil.current) return;
    if (currentSec !== null && autoFollow) setAutoFollow(false);
  };

  const returnToPlayhead = () => {
    setAutoFollow(true);
    const el = activeRef.current;
    if (el) {
      progScrollUntil.current = Date.now() + 600;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  if (!transcript) {
    return <div className={`text-sm text-slate-400 dark:text-slate-500 ${className}`}>文字起こしはまだありません</div>;
  }

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
    <div className={`relative flex min-h-0 flex-col ${className}`}>
      <div className="flex-none pb-2 text-xs text-slate-500 dark:text-slate-400">
        モデル: {transcript.model} / 言語: {transcript.language || '自動'} / 生成: {new Date(transcript.createdAt).toLocaleString()}
        {onEditSegment && segments.length > 0 && (
          <span className="ml-2 text-slate-400 dark:text-slate-500">— 各行の鉛筆アイコンで誤認識を修正できます</span>
        )}
      </div>
      {segments.length > 0 ? (
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="min-h-0 flex-1 overflow-y-auto rounded-md border border-slate-200 bg-slate-50 p-3 text-sm dark:border-slate-700 dark:bg-slate-800"
        >
          {segments.map((s, i) => {
            const isActive = i === activeIdx;
            return (
              <div
                key={i}
                ref={isActive ? activeRef : undefined}
                className={`group flex gap-3 rounded px-1.5 py-1 transition-colors ${
                  isActive
                    ? 'bg-brand-100 ring-1 ring-brand-300 dark:bg-brand-900/60 dark:ring-brand-700'
                    : 'hover:bg-brand-50 dark:hover:bg-brand-900/40'
                }`}
              >
                <button
                  onClick={() => onSeek?.(s.start)}
                  className={`shrink-0 cursor-pointer font-mono text-xs tabular-nums ${
                    isActive
                      ? 'font-semibold text-brand-700 dark:text-brand-300'
                      : 'text-slate-400 hover:text-brand-600 dark:text-slate-500 dark:hover:text-brand-300'
                  }`}
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
                      <X size={12} />
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
                        <Pencil size={12} />
                      </button>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-800 whitespace-pre-wrap dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
          {transcript.text || '（空）'}
        </div>
      )}

      {/* 追従から離れたとき、再生位置へ戻るボタン（Teams のトランスクリプト風） */}
      {!autoFollow && currentSec !== null && activeIdx >= 0 && (
        <button
          onClick={returnToPlayhead}
          className="absolute bottom-3 right-4 inline-flex items-center gap-1.5 rounded-full bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white shadow-lg hover:bg-brand-700"
          title="自動追従を再開して再生中の行へ戻る"
        >
          <LocateFixed size={13} />
          再生位置へ戻る
        </button>
      )}
    </div>
  );
}
