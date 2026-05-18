import { useEffect, useState } from 'react';
import { CallRecord, Settings } from '../../shared/types';
import { formatHMS, toDatetimeLocalValue, fromDatetimeLocalValue } from '../utils/format';

export function CallEditDialog({
  call,
  settings,
  onClose,
}: {
  call: CallRecord;
  settings: Settings;
  onClose: () => void;
}) {
  const [startTime, setStartTime] = useState(toDatetimeLocalValue(call.startTime));
  const [endTime, setEndTime] = useState(toDatetimeLocalValue(call.endTime));
  const [tag, setTag] = useState(call.tag ?? '');
  const [memo, setMemo] = useState(call.memo);
  const [contactName, setContactName] = useState(call.contactName ?? '');
  const [phoneNumber, setPhoneNumber] = useState(call.phoneNumber ?? '');
  const [saving, setSaving] = useState(false);

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

  const handleSave = async () => {
    setSaving(true);
    try {
      await window.api.calls.update(call.id, {
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
    if (!confirm('この記録を削除しますか？')) return;
    setSaving(true);
    await window.api.calls.delete(call.id);
    setSaving(false);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" onClick={onClose}>
      <div
        className="w-full max-w-xl rounded-xl bg-white p-6 shadow-2xl"
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
