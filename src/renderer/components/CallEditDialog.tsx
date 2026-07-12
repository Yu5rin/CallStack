import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Phone, Users, Bookmark, Play, Trash2, FileText, Download, Clock3, X,
  RefreshCw, Ban, Mic, AudioLines,
} from 'lucide-react';
import { CallRecord, Settings, WhisperModel, WHISPER_MODELS } from '../../shared/types';
import { formatHMS, toDatetimeLocalValue, fromDatetimeLocalValue, formatDateTime } from '../utils/format';
import { AudioPlayer, AudioPlayerHandle } from './AudioPlayer';
import { TranscriptView } from './TranscriptView';
import { deleteCallWithConfirm } from '../hooks/useCalls';

const inputClass =
  'w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100';
const smallBtn =
  'inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-700';

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
  // 文字起こしに使うモデル（既定は設定のモデル。編集画面で個別に選べる）
  const [transcribeModel, setTranscribeModel] = useState<WhisperModel>(settings.transcription.model);
  const [transcribeProgress, setTranscribeProgress] = useState<{ stage: 'convert' | 'transcribe'; percent: number } | null>(null);
  const [queuePos, setQueuePos] = useState<number | null>(null);
  // 再生位置（文字起こしの追従ハイライト用）
  const [playSec, setPlaySec] = useState<number | null>(null);
  // ライブ文字起こし（進行中の記録のみ）: 確定行 + 認識途中のテキスト
  const [liveLines, setLiveLines] = useState<Array<{ at: number; text: string }>>([]);
  const [livePartial, setLivePartial] = useState('');
  const liveScrollRef = useRef<HTMLDivElement | null>(null);
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const playerRef = useRef<AudioPlayerHandle | null>(null);
  // 種別は編集で変更できる（通話⇄会議）。保存時に反映される。
  const [kind, setKind] = useState<'call' | 'meeting'>(call.kind ?? 'call');
  const isMeeting = kind === 'meeting';

  useEffect(() => {
    const off = window.api.onEvent((e) => {
      if (e.type === 'transcription:progress' && e.callId === current.id) {
        setTranscribeProgress({ stage: e.stage, percent: e.percent });
        return;
      }
      if (e.type === 'live:segment' && e.callId === current.id) {
        if (e.final) {
          setLiveLines((prev) => [...prev, { at: e.at, text: e.text }]);
          setLivePartial('');
        } else {
          setLivePartial(e.text);
        }
        return;
      }
      if (
        (e.type === 'call:updated' && e.record.id === current.id) ||
        (e.type === 'transcription:status' && e.callId === current.id)
      ) {
        if (e.type === 'transcription:status') {
          if (e.status !== 'running') setTranscribeProgress(null);
          setQueuePos(e.status === 'queued' ? (e.queuePosition ?? null) : null);
        }
        window.api.calls.get(current.id).then((r) => {
          if (r) setCurrent(r);
        });
      }
    });
    return () => off();
  }, [current.id]);

  // 進行中の記録を途中から開いた場合、これまでのライブ認識結果を取得する
  useEffect(() => {
    if (current.endTime) return;
    window.api.live.get().then((s) => {
      if (s && s.callId === current.id) {
        setLiveLines(s.segments.map((x) => ({ at: x.start, text: x.text })));
      }
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current.id]);

  // ライブ表示は常に最下部（最新）へスクロール
  useEffect(() => {
    const el = liveScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [liveLines, livePartial]);

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
        kind,
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
      const result = await window.api.transcription.start(current.id, transcribeModel);
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
    setExportMessage(r.error ? `エラー: ${r.error}` : `保存しました: ${r.path}`);
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

  const kindToggle = (
    <div className="flex overflow-hidden rounded-lg border border-slate-300 text-xs font-semibold dark:border-slate-600">
      <button
        onClick={() => setKind('call')}
        className={`inline-flex items-center gap-1.5 px-3 py-1.5 transition ${
          !isMeeting
            ? 'bg-brand-600 text-white'
            : 'bg-white text-slate-600 hover:bg-slate-50 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'
        }`}
        title="この記録を通話として扱う"
      >
        <Phone size={12} /> 通話
      </button>
      <button
        onClick={() => setKind('meeting')}
        className={`inline-flex items-center gap-1.5 px-3 py-1.5 transition ${
          isMeeting
            ? 'bg-violet-600 text-white'
            : 'bg-white text-slate-600 hover:bg-slate-50 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'
        }`}
        title="この記録を会議として扱う"
      >
        <Users size={12} /> 会議
      </button>
    </div>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-3"
      onClick={onClose}
    >
      <div
        className="flex h-[94vh] w-[96vw] max-w-[110rem] flex-col overflow-hidden rounded-xl bg-white shadow-2xl dark:bg-slate-900 dark:text-slate-100"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ヘッダー */}
        <div className="flex flex-none items-center justify-between gap-3 border-b border-slate-200 px-6 py-3 dark:border-slate-800">
          <h2 className="inline-flex items-center gap-2 text-lg font-bold text-slate-900 dark:text-slate-100">
            {isMeeting ? <Users size={18} className="text-violet-500" /> : <Phone size={18} className="text-brand-600" />}
            {isMeeting ? '会議記録の編集' : '通話記録の編集'}
          </h2>
          <div className="flex items-center gap-3">
            {kind !== (current.kind ?? 'call') && (
              <span className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
                種別を{isMeeting ? '会議' : '通話'}に変更します（保存で確定）
              </span>
            )}
            {kindToggle}
            <button
              onClick={onClose}
              className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-200"
              title="閉じる (Esc)"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* 本文 2 カラム */}
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(22rem,28rem)_1fr]">
          {/* 左: 記録情報 */}
          <div className="min-h-0 overflow-y-auto border-b border-slate-200 px-6 py-4 lg:border-b-0 lg:border-r dark:border-slate-800">
            {isMeeting ? (
              <div className="grid grid-cols-1 gap-3">
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
              <div className="grid grid-cols-1 gap-3">
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

            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
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
            </div>
            <div className="mt-2 inline-flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
              <Clock3 size={14} className="text-slate-400" />
              {isMeeting ? '会議時間' : '通話時間'}:
              <span className="font-mono text-base font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                {computedDuration !== null ? formatHMS(computedDuration) : '—'}
              </span>
            </div>

            <div className="mt-4">
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
                  rows={5}
                  className={inputClass}
                  placeholder={isMeeting ? '会議の要点・決定事項など' : '通話内容のメモ'}
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

            {/* マーカー */}
            {(current.markers?.length ?? 0) > 0 && (
              <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800">
                <div className="mb-2 inline-flex items-center gap-1.5 text-sm font-semibold text-slate-700 dark:text-slate-200">
                  <Bookmark size={14} className="text-brand-600 dark:text-brand-300" />
                  マーカー ({current.markers!.length})
                </div>
                <ul className="space-y-1.5">
                  {current.markers!.map((m, i) => (
                    <li key={`${m.at}-${i}`} className="flex items-center gap-2">
                      <button
                        onClick={() => playerRef.current?.seekTo(Math.max(0, m.at - settings.transcriptSeekOffsetSec))}
                        disabled={!audioSrc}
                        className="inline-flex shrink-0 items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1 font-mono text-xs tabular-nums text-brand-700 hover:bg-brand-50 disabled:cursor-default disabled:text-slate-400 disabled:hover:bg-white dark:border-slate-600 dark:bg-slate-900 dark:text-brand-300 dark:hover:bg-brand-900/40"
                        title={audioSrc ? 'クリックで該当位置を再生' : '録音がないため再生できません'}
                      >
                        <Play size={10} /> {formatHMS(m.at)}
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
                        className="shrink-0 rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950"
                        title="このマーカーを削除"
                      >
                        <X size={12} />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* 右: 録音・文字起こし（広い領域で確認できる） */}
          <div className="flex min-h-0 flex-col px-6 py-4">
            {audioSrc ? (
              <>
                <div className="flex-none">
                  <div className="mb-2 flex items-center justify-between">
                    <div className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-700 dark:text-slate-200">
                      <Mic size={14} className="text-slate-400" />
                      録音 ({current.audio?.source === 'mic+system' ? 'マイク+システム' : current.audio?.source === 'system' ? 'システム音声' : 'マイク'})
                      <span className="ml-1 text-xs font-normal text-slate-500 dark:text-slate-400">
                        {formatHMS(current.audio?.durationSec ?? 0)} / {((current.audio?.bytes ?? 0) / 1024 / 1024).toFixed(2)} MB
                      </span>
                    </div>
                    <button onClick={handleSaveAudio} className={smallBtn} title="録音 (MP3) を名前を付けて保存">
                      <Download size={12} /> 録音を保存
                    </button>
                  </div>
                  <AudioPlayer ref={playerRef} src={audioSrc} onTimeUpdate={setPlaySec} />
                </div>

                <div className="mt-3 flex min-h-0 flex-1 flex-col border-t border-slate-200 pt-3 dark:border-slate-700">
                  <div className="mb-2 flex flex-none flex-wrap items-center justify-between gap-2">
                    <div className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-700 dark:text-slate-200">
                      <FileText size={14} className="text-slate-400" />
                      文字起こし
                    </div>
                    <div className="flex items-center gap-2">
                      {transcribing && !transcriptBusy && (
                        <span className="text-xs text-slate-500 dark:text-slate-400">開始しています…</span>
                      )}
                      {current.transcriptStatus === 'running' && (
                        <span className="text-xs font-medium text-brand-600 dark:text-brand-300">
                          {transcribeProgress === null
                            ? '準備中…'
                            : transcribeProgress.stage === 'convert'
                              ? '音声を変換中…'
                              : `文字起こし中 ${transcribeProgress.percent}%`}
                        </span>
                      )}
                      {current.transcriptStatus === 'queued' && (
                        <span className="text-xs text-slate-500 dark:text-slate-400">
                          待機中{queuePos && queuePos > 1 ? `（${queuePos} 番目）` : '（まもなく開始）'}
                        </span>
                      )}
                      {transcriptBusy && (
                        <button
                          onClick={handleCancelTranscribe}
                          className="inline-flex items-center gap-1 rounded-md border border-red-300 bg-white px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50 dark:border-red-800 dark:bg-slate-900 dark:text-red-300 dark:hover:bg-red-950"
                        >
                          <Ban size={12} /> キャンセル
                        </button>
                      )}
                      {current.transcript && !transcriptBusy && (
                        <>
                          <button onClick={() => handleSaveTranscript(false)} className={smallBtn} title="文字起こしをテキストファイルとして保存">
                            <Download size={12} /> テキスト
                          </button>
                          <button onClick={() => handleSaveTranscript(true)} className={smallBtn} title="[00:01:23] 形式のタイムスタンプ付きで保存">
                            <Download size={12} /> 時刻付き
                          </button>
                        </>
                      )}
                      {!transcriptBusy && (
                        <>
                          <select
                            value={transcribeModel}
                            onChange={(e) => setTranscribeModel(e.target.value as WhisperModel)}
                            className="rounded-md border border-slate-300 bg-white px-1.5 py-1 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                            title="文字起こしに使うモデルを選択（大きいほど高精度・低速）"
                          >
                            {WHISPER_MODELS.map((m) => (
                              <option key={m.id} value={m.id}>{m.id}</option>
                            ))}
                          </select>
                          <button
                            onClick={handleTranscribe}
                            disabled={transcribing}
                            className="inline-flex items-center gap-1 rounded-md bg-brand-600 px-3 py-1 text-xs font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
                          >
                            <RefreshCw size={12} />
                            {current.transcript ? '再文字起こし' : '文字起こし'}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  {(current.transcriptStatus === 'running' || current.transcriptStatus === 'queued') && (
                    <div className="mb-2 h-1.5 w-full flex-none overflow-hidden rounded bg-slate-200 dark:bg-slate-700">
                      <div
                        className={`h-full bg-brand-500 transition-all ${current.transcriptStatus === 'queued' ? 'animate-pulse' : ''}`}
                        style={{ width: `${current.transcriptStatus === 'queued' ? 100 : (transcribeProgress?.percent ?? 2)}%`, opacity: current.transcriptStatus === 'queued' ? 0.25 : 1 }}
                      />
                    </div>
                  )}
                  {current.transcriptStatus === 'error' && current.transcriptError && (
                    <div className="mb-2 flex-none rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700 whitespace-pre-wrap dark:border-red-900 dark:bg-red-950 dark:text-red-200">
                      {current.transcriptError}
                    </div>
                  )}
                  {transcribeError && (
                    <div className="mb-2 flex-none rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700 whitespace-pre-wrap dark:border-red-900 dark:bg-red-950 dark:text-red-200">
                      {transcribeError}
                    </div>
                  )}
                  <TranscriptView
                    className="min-h-0 flex-1"
                    transcript={current.transcript}
                    currentSec={playSec}
                    onSeek={(t) => playerRef.current?.seekTo(Math.max(0, t - settings.transcriptSeekOffsetSec))}
                    onEditSegment={(i, text) => void handleEditSegment(i, text)}
                  />
                </div>
              </>
            ) : !current.endTime ? (
              /* 進行中の記録: ライブ文字起こしのフィードを表示 */
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="mb-2 flex flex-none flex-wrap items-center gap-1.5 text-sm font-semibold text-slate-700 dark:text-slate-200">
                  <AudioLines size={14} className="text-sky-500" />
                  ライブ文字起こし（暫定）
                  <span className="text-xs font-normal text-slate-500 dark:text-slate-400">
                    録音終了後に whisper が確定版を生成します
                  </span>
                </div>
                <div
                  ref={liveScrollRef}
                  className="min-h-0 flex-1 overflow-y-auto rounded-md border border-slate-200 bg-slate-50 p-3 text-sm leading-relaxed dark:border-slate-700 dark:bg-slate-900"
                >
                  {liveLines.length === 0 && !livePartial ? (
                    <div className="text-xs text-slate-400 dark:text-slate-500">
                      記録中です。ライブ文字起こしが有効な場合、認識結果がここに順次表示されます。
                      <br />
                      （設定 → 文字起こし → ライブ文字起こし から有効化できます）
                    </div>
                  ) : (
                    <>
                      {liveLines.map((l, i) => (
                        <div key={i} className="mb-1.5 flex gap-2">
                          <span className="flex-none pt-0.5 font-mono text-[10px] text-slate-400 dark:text-slate-500">
                            {formatHMS(Math.floor(l.at))}
                          </span>
                          <span className="min-w-0 text-slate-700 dark:text-slate-200">{l.text}</span>
                        </div>
                      ))}
                      {livePartial && (
                        <div className="mb-1.5 flex gap-2 opacity-60">
                          <span className="flex-none pt-0.5 font-mono text-[10px] text-slate-400">…</span>
                          <span className="min-w-0 text-slate-600 dark:text-slate-300">{livePartial}</span>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 text-slate-400 dark:text-slate-500">
                <Mic size={32} strokeWidth={1.5} />
                <div className="text-sm">この記録には録音がありません</div>
              </div>
            )}
          </div>
        </div>

        {/* フッター */}
        <div className="flex flex-none items-center justify-between gap-3 border-t border-slate-200 px-6 py-3 dark:border-slate-800">
          <div className="flex items-center gap-2">
            <button
              onClick={handleDelete}
              disabled={saving}
              className="inline-flex items-center gap-1.5 rounded-md border border-red-300 bg-white px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50 dark:border-red-800 dark:bg-slate-900 dark:text-red-300 dark:hover:bg-red-950"
            >
              <Trash2 size={14} /> 削除
            </button>
            {isMeeting && (
              <button
                onClick={handleSaveMinutes}
                className="inline-flex items-center gap-1.5 rounded-md border border-violet-300 bg-violet-50 px-3 py-2 text-sm font-medium text-violet-700 hover:bg-violet-100 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-300 dark:hover:bg-violet-900"
                title="タイトル・参加者・メモ・マーカー・文字起こしをまとめた議事録を Markdown で保存"
              >
                <FileText size={14} /> 議事録 (MD) を保存
              </button>
            )}
            {exportMessage && (
              <span className="max-w-md truncate text-xs text-emerald-700 dark:text-emerald-300" title={exportMessage}>
                {exportMessage}
              </span>
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
              className="rounded-md bg-brand-600 px-5 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
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
