import { useEffect, useRef, useState } from 'react';
import { CallRecord, Settings } from '../../shared/types';
import { formatHMS, toDatetimeLocalValue, fromDatetimeLocalValue, formatDateTime } from '../utils/format';
import { AudioPlayer, AudioPlayerHandle } from './AudioPlayer';
import { TranscriptView } from './TranscriptView';

export function CallEditDialog({
  call,
  settings,
  onClose,
}: {
  call: CallRecord;
  settings: Settings;
  onClose: () => void;
}) {
  const [current, setCurrent] = useState(call);
  const [startTime, setStartTime] = useState(toDatetimeLocalValue(call.startTime));
  const [endTime, setEndTime] = useState(toDatetimeLocalValue(call.endTime));
  const [tag, setTag] = useState(call.tag ?? '');
  const [memo, setMemo] = useState(call.memo);
  const [contactName, setContactName] = useState(call.contactName ?? '');
  const [phoneNumber, setPhoneNumber] = useState(call.phoneNumber ?? '');
  const [saving, setSaving] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const playerRef = useRef<AudioPlayerHandle | null>(null);

  useEffect(() => {
    const off = window.api.onEvent((e) => {
      if (
        (e.type === 'call:updated' && e.record.id === current.id) ||
        (e.type === 'transcription:status' && e.callId === current.id)
      ) {
        window.api.calls.get(current.id).then((r) => {
          if (r) setCurrent(r);
        });
      }
    });
    return () => off();
  }, [current.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const computedDuration = (() => {
    if (!startTime || !endTime) return null;
    const s = new Date(fromDatetimeLocalValue(startTime)).getTime();
    const e = new Date(fromDatetimeLocalValue(endTime)).getTime();
    if (isNaN(s) || isNaN(e)) return null;
    return Math.max(0, Math.round((e - s) / 1000));
  })();
  const hold = current.holdSec ?? 0;

  const handleSave = async () => {
    setSaving(true);
    try {
      await window.api.calls.update(current.id, {
        startTime: fromDatetimeLocalValue(startTime),
        endTime: endTime ? fromDatetimeLocalValue(endTime) : null,
        tag: tag || null,
        memo,
        contactName: contactName || undefined,
        phoneNumber: phoneNumber || undefined,
      });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm('この記録を削除しますか？録音ファイルも削除されます。')) return;
    setSaving(true);
    await window.api.calls.delete(current.id);
    setSaving(false);
    onClose();
  };

  const handleTranscribe = async () => {
    setTranscribing(true);
    await window.api.transcription.start(current.id);
    // 状態は app-event 経由で更新される
    setTimeout(() => setTranscribing(false), 500);
  };

  const audioSrc = current.audio ? `app://recordings/${current.audio.path}` : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" onClick={onClose}>
      <div
        className="w-full max-w-2xl max-h-[90vh] overflow-auto rounded-xl bg-white p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-lg font-bold text-slate-900">通話記録の編集</h2>

        <div className="grid grid-cols-2 gap-4">
          <Field label="開始時刻">
            <input
              type="datetime-local"
              step={1}
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </Field>
          <Field label="終了時刻">
            <input
              type="datetime-local"
              step={1}
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </Field>
          <Field label="通話時間">
            <div className="font-mono text-base font-semibold tabular-nums text-slate-900">
              {computedDuration !== null ? formatHMS(computedDuration) : '—'}
            </div>
          </Field>
          <Field label="保留合計 / 純通話">
            <div className="font-mono text-sm tabular-nums">
              <span className="text-amber-600">{formatHMS(hold)}</span>
              <span className="mx-1 text-slate-400">/</span>
              <span className="text-slate-900">
                {computedDuration !== null ? formatHMS(Math.max(0, computedDuration - hold)) : '—'}
              </span>
            </div>
          </Field>
          <Field label="タグ">
            <div className="flex flex-wrap gap-1.5">
              {settings.tags.map((t) => (
                <button
                  key={t.name}
                  onClick={() => setTag(tag === t.name ? '' : t.name)}
                  className={`rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${
                    tag === t.name ? 'text-white ring-transparent' : 'text-slate-700 ring-slate-300 bg-white hover:bg-slate-50'
                  }`}
                  style={tag === t.name ? { backgroundColor: t.color } : {}}
                >
                  {t.name}
                </button>
              ))}
              {tag && !settings.tags.find((t) => t.name === tag) && (
                <span className="rounded-full bg-slate-200 px-2.5 py-1 text-xs">{tag}</span>
              )}
            </div>
          </Field>
          <Field label="連絡先名">
            <input
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              placeholder="例: 山田太郎"
            />
          </Field>
          <Field label="電話番号">
            <input
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              placeholder="例: 090-1234-5678"
            />
          </Field>
        </div>

        <div className="mt-4">
          <Field label="メモ">
            <textarea
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              rows={4}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              placeholder="通話内容のメモ"
            />
          </Field>
        </div>

        {current.holds && current.holds.length > 0 && (
          <div className="mt-4">
            <div className="mb-1 text-xs font-medium text-slate-600">保留区間</div>
            <ul className="space-y-1 text-xs">
              {current.holds.map((h, i) => (
                <li key={i} className="flex items-center gap-3 rounded border border-slate-200 bg-slate-50 px-2 py-1">
                  <span className="font-mono text-slate-600">{formatDateTime(h.start)}</span>
                  <span className="text-slate-400">→</span>
                  <span className="font-mono text-slate-600">{h.end ? formatDateTime(h.end) : '進行中'}</span>
                  <span className="ml-auto font-mono text-amber-600">{formatHMS(h.sec)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {audioSrc && (
          <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-sm font-semibold text-slate-700">録音 ({current.audio?.source === 'mic+system' ? 'マイク+システム' : 'マイク'})</div>
              <div className="text-xs text-slate-500">
                {formatHMS(current.audio?.durationSec ?? 0)} / {((current.audio?.bytes ?? 0) / 1024 / 1024).toFixed(2)} MB
              </div>
            </div>
            <AudioPlayer ref={playerRef} src={audioSrc} />
            <div className="mt-3 border-t border-slate-200 pt-3">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-sm font-semibold text-slate-700">文字起こし</div>
                <div className="flex items-center gap-2">
                  {current.transcriptStatus === 'running' && <span className="text-xs text-brand-600">処理中…</span>}
                  {current.transcriptStatus === 'queued' && <span className="text-xs text-slate-500">待機中…</span>}
                  <button
                    onClick={handleTranscribe}
                    disabled={transcribing || current.transcriptStatus === 'running' || current.transcriptStatus === 'queued'}
                    className="rounded-md bg-brand-600 px-3 py-1 text-xs font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
                  >
                    {current.transcript ? '再文字起こし' : '文字起こし'}
                  </button>
                </div>
              </div>
              {current.transcriptStatus === 'error' && current.transcriptError && (
                <div className="mb-2 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700 whitespace-pre-wrap">
                  {current.transcriptError}
                </div>
              )}
              <TranscriptView
                transcript={current.transcript}
                onSeek={(t) => playerRef.current?.seekTo(t)}
              />
            </div>
          </div>
        )}

        <div className="mt-6 flex justify-between">
          <button
            onClick={handleDelete}
            disabled={saving}
            className="rounded-md border border-red-300 bg-white px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50"
          >
            削除
          </button>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              disabled={saving}
              className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              キャンセル
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-600">{label}</span>
      {children}
    </label>
  );
}
