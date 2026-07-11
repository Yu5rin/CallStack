import { useEffect, useMemo, useRef, useState } from 'react';
import { CallRecord, Settings } from '../../shared/types';
import { formatHMS, toDatetimeLocalValue, fromDatetimeLocalValue, formatDateTime } from '../utils/format';
import { AudioPlayer, AudioPlayerHandle } from './AudioPlayer';
import { TranscriptView } from './TranscriptView';
import { deleteCallWithConfirm } from '../hooks/useCalls';

const inputClass =
  'w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100';

export function CallEditDialog({
  call,
  settings,
  allCalls,
  onClose,
}: {
  call: CallRecord;
  settings: Settings;
  allCalls: CallRecord[];
  onClose: () => void;
}) {
  const [current, setCurrent] = useState(call);
  const [startTime, setStartTime] = useState(toDatetimeLocalValue(call.startTime));
  const [endTime, setEndTime] = useState(toDatetimeLocalValue(call.endTime));
  const [tag, setTag] = useState(call.tag ?? '');
  const [memo, setMemo] = useState(call.memo);
  const [contactName, setContactName] = useState(call.contactName ?? '');
  const [phoneNumber, setPhoneNumber] = useState(call.phoneNumber ?? '');
  const [title, setTitle] = useState(call.title ?? '');
  const [participants, setParticipants] = useState((call.participants ?? []).join('、'));
  const [saving, setSaving] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [transcribeError, setTranscribeError] = useState<string | null>(null);
  const [transcribeProgress, setTranscribeProgress] = useState<number | null>(null);
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const playerRef = useRef<AudioPlayerHandle | null>(null);
  const isMeeting = current.kind === 'meeting';

  useEffect(() => {
    const off = window.api.onEvent((e) => {
      if (e.type === 'transcription:progress' && e.callId === current.id) {
        setTranscribeProgress(e.percent);
        return;
      }
      if (
        (e.type === 'call:updated' && e.record.id === current.id) ||
        (e.type === 'transcription:status' && e.callId === current.id)
      ) {
        if (e.type === 'transcription:status' && e.status !== 'running') setTranscribeProgress(null);
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

  const computedDuration = useMemo(() => {
    if (!startTime || !endTime) return null;
    const s = new Date(fromDatetimeLocalValue(startTime)).getTime();
    const e = new Date(fromDatetimeLocalValue(endTime)).getTime();
    if (isNaN(s) || isNaN(e)) return null;
    return Math.max(0, Math.round((e - s) / 1000));
  }, [startTime, endTime]);
  const holdTotal = current.holdSec ?? 0;

  const contactSuggestions = useMemo(() => {
    const s = new Set<string>();
    for (const c of allCalls) if (c.contactName) s.add(c.contactName);
    return Array.from(s).sort();
  }, [allCalls]);
  const phoneSuggestions = useMemo(() => {
    const s = new Set<string>();
    for (const c of allCalls) if (c.phoneNumber) s.add(c.phoneNumber);
    return Array.from(s).sort();
  }, [allCalls]);
  /** phone -> most-recent contact name with that number */
  const phoneToContact = useMemo(() => {
    const map = new Map<string, { name: string; at: number }>();
    for (const c of allCalls) {
      if (!c.phoneNumber || !c.contactName) continue;
      const at = new Date(c.startTime).getTime();
      const prev = map.get(c.phoneNumber);
      if (!prev || prev.at < at) map.set(c.phoneNumber, { name: c.contactName, at });
    }
    return map;
  }, [allCalls]);

  /** Look up the contact for the entered phone number when the user leaves the field. */
  const onPhoneBlur = () => {
    if (!phoneNumber || contactName) return;
    const hit = phoneToContact.get(phoneNumber);
    if (hit) setContactName(hit.name);
  };

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
        title: title || undefined,
        participants: participants
          ? participants.split(/[、,]/).map((p) => p.trim()).filter(Boolean)
          : undefined,
      });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setSaving(true);
    try {
      const removed = await deleteCallWithConfirm(current.id, settings.confirmCallDelete);
      if (removed) onClose();
    } finally {
      setSaving(false);
    }
  };

  const handleTranscribe = async () => {
    setTranscribing(true);
    setTranscribeError(null);
    try {
      const result = await window.api.transcription.start(current.id);
      if (!result.ok) setTranscribeError(result.error);
    } catch (err) {
      setTranscribeError((err as Error).message);
    } finally {
      setTimeout(() => setTranscribing(false), 500);
    }
  };

  const handleCancelTranscribe = async () => {
    await window.api.transcription.cancel(current.id);
  };

  const showExportResult = (r: { canceled: boolean; path?: string; error?: string }) => {
    if (r.canceled) return;
    setExportMessage(r.error ? `⚠️ ${r.error}` : `✅ 保存しました: ${r.path}`);
    window.setTimeout(() => setExportMessage(null), 6000);
  };

  const handleSaveAudio = async () => {
    showExportResult(await window.api.recording.saveAs(current.id));
  };

  const handleSaveTranscript = async (withTimestamps: boolean) => {
    showExportResult(await window.api.transcript.saveAs(current.id, withTimestamps));
  };

  const handleSaveMinutes = async () => {
    showExportResult(await window.api.minutes.saveAs(current.id));
  };

  const updateMarkers = async (markers: NonNullable<CallRecord['markers']>) => {
    const updated = await window.api.calls.update(current.id, { markers });
    if (updated) setCurrent(updated);
  };

  const handleMarkerLabel = (idx: number, label: string) => {
    const markers = (current.markers ?? []).map((m, i) => (i === idx ? { ...m, label: label || undefined } : m));
    void updateMarkers(markers);
  };

  const handleMarkerDelete = (idx: number) => {
    void updateMarkers((current.markers ?? []).filter((_, i) => i !== idx));
  };

  /** 文字起こしセグメントの手動修正。全文テキストも作り直して保存する */
  const handleEditSegment = async (index: number, text: string) => {
    if (!current.transcript?.segments) return;
    const segments = current.transcript.segments.map((s, i) => (i === index ? { ...s, text } : s));
    const transcript = {
      ...current.transcript,
      segments,
      text: segments.map((s) => s.text).join('\n').trim(),
    };
    const updated = await window.api.calls.update(current.id, { transcript });
    if (updated) setCurrent(updated);
  };

  const audioSrc = current.audio ? `app://recordings/${current.audio.path}` : null;
  const transcriptBusy = current.transcriptStatus === 'running' || current.transcriptStatus === 'queued';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-[min(96vw,60rem)] max-h-[92vh] overflow-auto rounded-xl bg-white p-6 shadow-2xl dark:bg-slate-900 dark:text-slate-100"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-lg font-bold text-slate-900 dark:text-slate-100">
          {isMeeting ? '👥 会議記録の編集' : '通話記録の編集'}
        </h2>

        {/* 通話: 連絡先名 / 電話番号、会議: タイトル / 参加者 を最上段に */}
        {isMeeting ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="会議タイトル">
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className={inputClass}
                placeholder="例: 週次定例"
              />
            </Field>
            <Field label="参加者（読点・カンマ区切り）">
              <input
                value={participants}
                onChange={(e) => setParticipants(e.target.value)}
                className={inputClass}
                placeholder="例: 山田、佐藤、鈴木"
              />
            </Field>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="連絡先名">
              <input
                value={contactName}
                onChange={(e) => setContactName(e.target.value)}
                list="contact-name-suggestions"
                className={inputClass}
                placeholder="例: 山田太郎"
              />
              <datalist id="contact-name-suggestions">
                {contactSuggestions.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </Field>
            <Field label="電話番号">
              <input
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
                onBlur={onPhoneBlur}
                list="phone-number-suggestions"
                className={inputClass}
                placeholder="例: 090-1234-5678"
              />
              <datalist id="phone-number-suggestions">
                {phoneSuggestions.map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
            </Field>
          </div>
        )}

        {/* 時刻系を 3 列でコンパクトに */}
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="開始時刻">
            <input
              type="datetime-local"
              step={1}
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="終了時刻">
            <input
              type="datetime-local"
              step={1}
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label={isMeeting ? '会議時間' : '通話時間'}>
            <div className="font-mono text-base font-semibold tabular-nums text-slate-900 dark:text-slate-100">
              {computedDuration !== null ? formatHMS(computedDuration) : '—'}
            </div>
          </Field>
        </div>

        <div className="mt-3">
          <Field label="タグ">
            <div className="flex flex-wrap gap-1.5">
              {settings.tags.map((t) => (
                <button
                  key={t.name}
                  onClick={() => setTag(tag === t.name ? '' : t.name)}
                  className={`rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${
                    tag === t.name
                      ? 'text-white ring-transparent'
                      : 'bg-white text-slate-700 ring-slate-300 hover:bg-slate-50 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-600 dark:hover:bg-slate-700'
                  }`}
                  style={tag === t.name ? { backgroundColor: t.color } : {}}
                >
                  {t.name}
                </button>
              ))}
              {tag && !settings.tags.find((t) => t.name === tag) && (
                <span className="rounded-full bg-slate-200 px-2.5 py-1 text-xs dark:bg-slate-700 dark:text-slate-200">{tag}</span>
              )}
            </div>
          </Field>
        </div>

        <div className="mt-3">
          <Field label="メモ">
            <textarea
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              rows={3}
              className={inputClass}
              placeholder="通話内容のメモ"
            />
          </Field>
        </div>

        {/* 保留区間 — 折りたたみ */}
        {current.holds && current.holds.length > 0 && (
          <details className="mt-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-700 dark:bg-slate-800">
            <summary className="cursor-pointer select-none text-xs font-medium text-slate-700 dark:text-slate-300">
              保留区間 ({current.holds.length} 件 / 合計 {formatHMS(holdTotal)})
            </summary>
            <ul className="mt-2 space-y-1 text-xs">
              {current.holds.map((h, i) => (
                <li
                  key={i}
                  className="flex items-center gap-3 rounded border border-slate-200 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
                >
                  <span className="font-mono text-slate-600 dark:text-slate-300">{formatDateTime(h.start)}</span>
                  <span className="text-slate-400">→</span>
                  <span className="font-mono text-slate-600 dark:text-slate-300">{h.end ? formatDateTime(h.end) : '進行中'}</span>
                  <span className="ml-auto font-mono text-amber-600 dark:text-amber-400">{formatHMS(h.sec)}</span>
                </li>
              ))}
            </ul>
          </details>
        )}

        {/* マーカー（録音中に打ったブックマーク） */}
        {(current.markers?.length ?? 0) > 0 && (
          <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800">
            <div className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
              🔖 マーカー ({current.markers!.length})
            </div>
            <ul className="space-y-1.5">
              {current.markers!.map((m, i) => (
                <li key={`${m.at}-${i}`} className="flex items-center gap-2">
                  <button
                    onClick={() => playerRef.current?.seekTo(Math.max(0, m.at - settings.transcriptSeekOffsetSec))}
                    disabled={!audioSrc}
                    className="shrink-0 rounded border border-slate-300 bg-white px-2 py-1 font-mono text-xs tabular-nums text-brand-700 hover:bg-brand-50 disabled:cursor-default disabled:text-slate-400 disabled:hover:bg-white dark:border-slate-600 dark:bg-slate-900 dark:text-brand-300 dark:hover:bg-brand-900/40"
                    title={audioSrc ? 'クリックで該当位置を再生' : '録音がないため再生できません'}
                  >
                    ▶ {formatHMS(m.at)}
                  </button>
                  <input
                    defaultValue={m.label ?? ''}
                    onBlur={(e) => {
                      if (e.target.value !== (m.label ?? '')) handleMarkerLabel(i, e.target.value.trim());
                    }}
                    placeholder="ラベルを入力（例: 決定事項、宿題）"
                    className="min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
                  />
                  <button
                    onClick={() => handleMarkerDelete(i)}
                    className="shrink-0 rounded px-1.5 py-1 text-xs text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950"
                    title="このマーカーを削除"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* 録音 — 折りたたみ可（既定で展開） */}
        {audioSrc && (
          <details
            open
            className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800"
          >
            <summary className="flex cursor-pointer select-none items-center justify-between">
              <div className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                🎙 録音 ({current.audio?.source === 'mic+system' ? 'マイク+システム' : 'マイク'})
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                {formatHMS(current.audio?.durationSec ?? 0)} / {((current.audio?.bytes ?? 0) / 1024 / 1024).toFixed(2)} MB
              </div>
            </summary>
            <div className="mt-2">
              <AudioPlayer ref={playerRef} src={audioSrc} />
              <div className="mt-2 flex items-center gap-2">
                <button
                  onClick={handleSaveAudio}
                  className="rounded-md border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-700"
                  title="録音 (MP3) を名前を付けて保存"
                >
                  ⬇ 録音を保存…
                </button>
              </div>
              <div className="mt-3 border-t border-slate-200 pt-3 dark:border-slate-700">
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-sm font-semibold text-slate-700 dark:text-slate-200">文字起こし</div>
                  <div className="flex items-center gap-2">
                    {current.transcriptStatus === 'running' && (
                      <span className="text-xs text-brand-600 dark:text-brand-300">
                        処理中… {transcribeProgress !== null ? `${transcribeProgress}%` : ''}
                      </span>
                    )}
                    {current.transcriptStatus === 'queued' && (
                      <span className="text-xs text-slate-500 dark:text-slate-400">待機中…</span>
                    )}
                    {transcriptBusy && (
                      <button
                        onClick={handleCancelTranscribe}
                        className="rounded-md border border-red-300 bg-white px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50 dark:border-red-800 dark:bg-slate-900 dark:text-red-300 dark:hover:bg-red-950"
                      >
                        キャンセル
                      </button>
                    )}
                    {current.transcript && !transcriptBusy && (
                      <>
                        <button
                          onClick={() => handleSaveTranscript(false)}
                          className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-700"
                          title="文字起こしをテキストファイルとして保存"
                        >
                          ⬇ テキスト保存…
                        </button>
                        <button
                          onClick={() => handleSaveTranscript(true)}
                          className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-700"
                          title="[00:01:23] 形式のタイムスタンプ付きで保存"
                        >
                          ⬇ 時刻付き…
                        </button>
                      </>
                    )}
                    <button
                      onClick={handleTranscribe}
                      disabled={transcribing || transcriptBusy}
                      className="rounded-md bg-brand-600 px-3 py-1 text-xs font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
                    >
                      {current.transcript ? '再文字起こし' : '文字起こし'}
                    </button>
                  </div>
                </div>
                {current.transcriptStatus === 'running' && transcribeProgress !== null && (
                  <div className="mb-2 h-1.5 w-full overflow-hidden rounded bg-slate-200 dark:bg-slate-700">
                    <div
                      className="h-full bg-brand-500 transition-all"
                      style={{ width: `${transcribeProgress}%` }}
                    />
                  </div>
                )}
                {current.transcriptStatus === 'error' && current.transcriptError && (
                  <div className="mb-2 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700 whitespace-pre-wrap dark:border-red-900 dark:bg-red-950 dark:text-red-200">
                    {current.transcriptError}
                  </div>
                )}
                {transcribeError && (
                  <div className="mb-2 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700 whitespace-pre-wrap dark:border-red-900 dark:bg-red-950 dark:text-red-200">
                    {transcribeError}
                  </div>
                )}
                <div>
                  <TranscriptView
                    transcript={current.transcript}
                    onSeek={(t) => playerRef.current?.seekTo(Math.max(0, t - settings.transcriptSeekOffsetSec))}
                    onEditSegment={(i, text) => void handleEditSegment(i, text)}
                  />
                </div>
              </div>
            </div>
          </details>
        )}

        {exportMessage && (
          <div className="mt-3 break-all rounded border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300">
            {exportMessage}
          </div>
        )}

        <div className="mt-5 flex justify-between">
          <div className="flex gap-2">
            <button
              onClick={handleDelete}
              disabled={saving}
              className="rounded-md border border-red-300 bg-white px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50 dark:border-red-800 dark:bg-slate-900 dark:text-red-300 dark:hover:bg-red-950"
            >
              削除
            </button>
            {isMeeting && (
              <button
                onClick={handleSaveMinutes}
                className="rounded-md border border-violet-300 bg-violet-50 px-3 py-2 text-sm font-medium text-violet-700 hover:bg-violet-100 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-300 dark:hover:bg-violet-900"
                title="タイトル・参加者・メモ・マーカー・文字起こしをまとめた議事録を Markdown で保存"
              >
                📄 議事録 (MD) を保存…
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              disabled={saving}
              className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
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
      <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">{label}</span>
      {children}
    </label>
  );
}
