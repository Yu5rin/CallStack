import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Phone, Users, Bookmark, Play, Trash2, FileText, Download, X,
  RefreshCw, Ban, Mic, AudioLines, MoreHorizontal, Check, Loader2, Undo2, AlertTriangle,
} from 'lucide-react';
import { CallRecord, Settings, WhisperModel, WHISPER_MODELS, getRecordTags, tagsPatch } from '../../shared/types';
import { formatHMS, toDatetimeLocalValue, fromDatetimeLocalValue, formatDateTime } from '../utils/format';
import { AudioPlayer, AudioPlayerHandle } from './AudioPlayer';
import { TranscriptView } from './TranscriptView';
import { useAutosave } from '../hooks/useAutosave';
import { toUserMessage } from '../utils/errorMessage';

const inputClass =
  'w-full rounded-md border border-rule bg-surface px-2.5 py-1.5 text-sm text-ink disabled:bg-paper disabled:text-ink-mute';
const smallBtn =
  'inline-flex items-center gap-1.5 rounded-md border border-rule bg-surface px-2.5 py-1 text-xs font-medium text-ink hover:bg-paper';
const NEW_TAG_COLOR = '#8A9296'; // 設定画面の「＋ タグを追加」と同じ既定色

interface Props {
  /** key={call.id} で選択レコードが変わるたびに再マウントされる想定 */
  call: CallRecord;
  settings: Settings;
  allCalls: CallRecord[];
  /** ゴミ箱内の記録を表示している（編集不可・復元/完全削除のみ） */
  trashMode?: boolean;
  onUpdateSettings: (next: Settings) => Promise<void>;
  /** 通常モード: ゴミ箱へ移動 */
  onMoveToTrash: () => void;
  /** ゴミ箱モード: 復元 */
  onRestore: () => void;
  /** ゴミ箱モード: 完全に削除 */
  onPurge: () => void;
  /** 何らかのフィールドが初めて編集されたら一度だけ通知する（「手動で追加」の未編集判定用） */
  onDirtyChange?: () => void;
}

export function RecordDetail({
  call, settings, allCalls, trashMode = false, onUpdateSettings, onMoveToTrash, onRestore, onPurge, onDirtyChange,
}: Props) {
  const readOnly = trashMode;
  const [current, setCurrent] = useState(call);
  const [startTime, setStartTime] = useState(toDatetimeLocalValue(call.startTime));
  const [endTime, setEndTime] = useState(toDatetimeLocalValue(call.endTime));
  const [tags, setTags] = useState<string[]>(getRecordTags(call));
  const [memo, setMemo] = useState(call.memo);
  const [contactName, setContactName] = useState(call.contactName ?? '');
  const [phoneNumber, setPhoneNumber] = useState(call.phoneNumber ?? '');
  const [title, setTitle] = useState(call.title ?? '');
  const [participants, setParticipants] = useState((call.participants ?? []).join('、'));
  const [kind, setKind] = useState<'call' | 'meeting'>(call.kind ?? 'call');
  const isMeeting = kind === 'meeting';

  const [tagDraft, setTagDraft] = useState('');
  const [transcribing, setTranscribing] = useState(false);
  const [transcribeError, setTranscribeError] = useState<string | null>(null);
  const [transcribeModel, setTranscribeModel] = useState<WhisperModel>(settings.transcription.model);
  const [transcribeProgress, setTranscribeProgress] = useState<{ stage: 'convert' | 'transcribe'; percent: number } | null>(null);
  const [queuePos, setQueuePos] = useState<number | null>(null);
  const [playSec, setPlaySec] = useState<number | null>(null);
  const [liveLines, setLiveLines] = useState<Array<{ at: number; text: string }>>([]);
  const [livePartial, setLivePartial] = useState('');
  const liveScrollRef = useRef<HTMLDivElement | null>(null);
  const [exportMessage, setExportMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const playerRef = useRef<AudioPlayerHandle | null>(null);
  const dirtyNotified = useRef(false);

  const notifyDirty = () => {
    if (!dirtyNotified.current) {
      dirtyNotified.current = true;
      onDirtyChange?.();
    }
  };

  // ============ 自動保存 ============
  const autosave = useAutosave<CallRecord>(async (patch) => {
    await window.api.calls.update(current.id, patch);
  });
  const markDirty = <K extends keyof CallRecord>(key: K, value: CallRecord[K]) => {
    if (readOnly) return;
    notifyDirty();
    autosave.markDirty(key, value);
  };
  /** 空文字を未設定（undefined）として保存する（空欄にしたら本当にクリアされるように） */
  const orUndef = (v: string): string | undefined => v || undefined;

  useEffect(() => {
    if (readOnly) return;
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
        ((e.type === 'call:updated' || e.type === 'call:ended') && e.record.id === current.id) ||
        (e.type === 'transcription:status' && e.callId === current.id)
      ) {
        if (e.type === 'transcription:status') {
          if (e.status !== 'running') setTranscribeProgress(null);
          setQueuePos(e.status === 'queued' ? (e.queuePosition ?? null) : null);
        }
        window.api.calls.get(current.id).then((r) => {
          if (!r) return;
          setCurrent(r);
          // ユーザーが編集していないフィールドだけ、最新の記録内容に追従させる
          // （例: 通話中に開いたまま通話が終了した、HUD でメモ・タグを編集した等）
          if (!autosave.isDirty('startTime')) setStartTime(toDatetimeLocalValue(r.startTime));
          if (!autosave.isDirty('endTime')) setEndTime(toDatetimeLocalValue(r.endTime));
          if (!autosave.isDirty('tags')) setTags(getRecordTags(r));
          if (!autosave.isDirty('memo')) setMemo(r.memo);
          if (!autosave.isDirty('contactName')) setContactName(r.contactName ?? '');
          if (!autosave.isDirty('phoneNumber')) setPhoneNumber(r.phoneNumber ?? '');
          if (!autosave.isDirty('title')) setTitle(r.title ?? '');
          if (!autosave.isDirty('participants')) setParticipants((r.participants ?? []).join('、'));
          if (!autosave.isDirty('kind')) setKind(r.kind ?? 'call');
        });
      }
    });
    return () => off();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current.id, readOnly]);

  // 進行中の記録を途中から開いた場合、これまでのライブ認識結果を取得する
  useEffect(() => {
    if (readOnly || current.endTime) return;
    window.api.live.get().then((s) => {
      if (s && s.callId === current.id) {
        setLiveLines(s.segments.map((x) => ({ at: x.start, text: x.text })));
      }
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current.id]);

  useEffect(() => {
    const el = liveScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [liveLines, livePartial]);

  // ⋯ メニューは外側クリックで閉じる
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [menuOpen]);

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

  const onPhoneBlur = () => {
    if (!phoneNumber || contactName) return;
    const hit = phoneToContact.get(phoneNumber);
    if (hit) { setContactName(hit.name); markDirty('contactName', hit.name); }
  };

  const handleTranscribe = async () => {
    setTranscribing(true);
    setTranscribeError(null);
    try {
      const result = await window.api.transcription.start(current.id, transcribeModel);
      if (!result.ok) setTranscribeError(result.error);
    } catch (err) {
      setTranscribeError(toUserMessage(err));
    } finally {
      setTimeout(() => setTranscribing(false), 500);
    }
  };
  const handleCancelTranscribe = async () => {
    await window.api.transcription.cancel(current.id);
  };

  const showExportResult = (r: { canceled: boolean; path?: string; error?: string }) => {
    if (r.canceled) return;
    setExportMessage(
      r.error
        ? { text: toUserMessage(r.error), error: true }
        : { text: `保存しました: ${r.path}`, error: false },
    );
    window.setTimeout(() => setExportMessage(null), 6000);
  };
  const handleSaveAudio = async () => showExportResult(await window.api.recording.saveAs(current.id));
  const handleSaveTranscript = async (withTimestamps: boolean) =>
    showExportResult(await window.api.transcript.saveAs(current.id, withTimestamps));
  const handleSaveMinutes = async () => showExportResult(await window.api.minutes.saveAs(current.id));

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

  const handleEditSegment = async (index: number, text: string) => {
    if (!current.transcript?.segments) return;
    const segments = current.transcript.segments.map((s, i) => (i === index ? { ...s, text } : s));
    const transcript = { ...current.transcript, segments, text: segments.map((s) => s.text).join('\n').trim() };
    const updated = await window.api.calls.update(current.id, { transcript });
    if (updated) setCurrent(updated);
  };

  // ============ タグの追加・新規作成 ============
  const existingTagNames = settings.tags.map((t) => t.name);
  const tagSuggestions = useMemo(() => {
    const q = tagDraft.trim().toLowerCase();
    return existingTagNames.filter((n) => !tags.includes(n) && (!q || n.toLowerCase().includes(q)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tagDraft, tags, settings.tags]);
  const tagDraftIsNew = tagDraft.trim() !== '' && !existingTagNames.includes(tagDraft.trim());

  // tags を更新する際は tag（互換用の単一タグ）も一緒に送る
  const applyTags = (next: string[]) => {
    setTags(next);
    const patch = tagsPatch(next);
    markDirty('tags', patch.tags);
    markDirty('tag', patch.tag);
  };
  const addExistingTag = (name: string) => {
    if (!tags.includes(name)) applyTags([...tags, name]);
    setTagDraft('');
  };
  const createAndAddTag = async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (!existingTagNames.includes(trimmed)) {
      await onUpdateSettings({ ...settings, tags: [...settings.tags, { name: trimmed, color: NEW_TAG_COLOR }] });
    }
    addExistingTag(trimmed);
  };
  const removeTag = (name: string) => applyTags(tags.filter((t) => t !== name));
  const commitTagDraft = () => {
    const trimmed = tagDraft.trim();
    if (trimmed) void createAndAddTag(trimmed);
  };

  const audioSrc = current.audio ? `app://recordings/${current.audio.path}` : null;
  const transcriptBusy = current.transcriptStatus === 'running' || current.transcriptStatus === 'queued';

  const autosaveLabel = () => {
    if (readOnly) return null;
    switch (autosave.status.state) {
      case 'saving':
        return <span className="inline-flex items-center gap-1.5 text-xs text-ink-mute"><Loader2 size={13} className="animate-spin" />保存中…</span>;
      case 'saved':
        return (
          <span className="inline-flex items-center gap-1.5 text-xs text-ink-mute">
            <Check size={14} className="text-accent-ink" />
            保存しました {new Date(autosave.status.at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}
          </span>
        );
      case 'error':
        return <span className="inline-flex items-center gap-1.5 text-xs text-danger" title={autosave.status.message}><AlertTriangle size={13} />保存に失敗しました</span>;
      default:
        return null;
    }
  };

  return (
    <div className="mx-auto max-w-[720px] px-6 py-6 sm:px-8">
      {/* ヘッダー: タイトル・種別・自動保存状態・メニュー */}
      <div className="mb-4 flex flex-wrap items-start gap-3">
        <input
          value={isMeeting ? title : contactName}
          onChange={(e) => {
            if (isMeeting) { setTitle(e.target.value); markDirty('title', orUndef(e.target.value)); }
            else { setContactName(e.target.value); markDirty('contactName', orUndef(e.target.value)); }
          }}
          disabled={readOnly}
          placeholder={isMeeting ? '会議タイトルを入力' : '連絡先名を入力'}
          aria-label="タイトル"
          className="min-w-[14rem] flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-1 text-xl font-medium text-ink hover:bg-surface hover:border-rule focus:border-accent focus:bg-surface focus:outline-none disabled:hover:bg-transparent disabled:hover:border-transparent"
        />
        {!readOnly && (
          <div className="flex overflow-hidden rounded-md border border-rule text-xs font-medium">
            <button
              onClick={() => { setKind('call'); markDirty('kind', 'call'); }}
              className={`px-2.5 py-1.5 transition ${!isMeeting ? 'bg-accent text-on-accent' : 'bg-surface text-ink-mute hover:bg-paper'}`}
            >
              <Phone size={12} className="mr-1 inline align-[-1px]" />通話
            </button>
            <button
              onClick={() => { setKind('meeting'); markDirty('kind', 'meeting'); }}
              className={`px-2.5 py-1.5 transition ${isMeeting ? 'bg-accent text-on-accent' : 'bg-surface text-ink-mute hover:bg-paper'}`}
            >
              <Users size={12} className="mr-1 inline align-[-1px]" />会議
            </button>
          </div>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {autosaveLabel()}
          {readOnly ? (
            <>
              <button
                onClick={onRestore}
                className="inline-flex items-center gap-1.5 rounded-md border border-rule bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-paper"
              >
                <Undo2 size={14} />復元
              </button>
              <button
                onClick={onPurge}
                className="inline-flex items-center gap-1.5 rounded-md border border-danger/40 bg-surface px-3 py-1.5 text-sm font-medium text-danger hover:bg-danger-soft"
              >
                <Trash2 size={14} />完全に削除
              </button>
            </>
          ) : (
            <div className="relative">
              <button
                onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
                onMouseDown={(e) => e.stopPropagation()}
                className="flex h-7 w-7 items-center justify-center rounded-md text-ink-mute hover:bg-accent-soft hover:text-ink"
                title="その他の操作"
                aria-haspopup="true"
                aria-expanded={menuOpen}
              >
                <MoreHorizontal size={16} />
              </button>
              {menuOpen && (
                <div
                  className="absolute right-0 top-full z-20 mt-1.5 w-56 overflow-hidden rounded-lg border border-rule bg-surface p-1.5 shadow-lg"
                  onMouseDown={(e) => e.stopPropagation()}
                  role="menu"
                >
                  {current.audio && (
                    <button onClick={() => { setMenuOpen(false); void handleSaveAudio(); }} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-ink hover:bg-accent-soft" role="menuitem">
                      <Download size={14} className="text-ink-mute" />録音を書き出す（MP3）
                    </button>
                  )}
                  {current.transcript && (
                    <button onClick={() => { setMenuOpen(false); void handleSaveTranscript(false); }} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-ink hover:bg-accent-soft" role="menuitem">
                      <FileText size={14} className="text-ink-mute" />文字起こしを書き出す
                    </button>
                  )}
                  {current.transcript && (
                    <button onClick={() => { setMenuOpen(false); void handleSaveTranscript(true); }} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-ink hover:bg-accent-soft" role="menuitem">
                      <FileText size={14} className="text-ink-mute" />文字起こしを書き出す（時刻付き）
                    </button>
                  )}
                  {isMeeting && (
                    <button onClick={() => { setMenuOpen(false); void handleSaveMinutes(); }} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-ink hover:bg-accent-soft" role="menuitem">
                      <FileText size={14} className="text-ink-mute" />議事録を書き出す（Markdown）
                    </button>
                  )}
                  <div className="my-1 h-px bg-rule" />
                  <button
                    onClick={() => { setMenuOpen(false); onMoveToTrash(); }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-danger hover:bg-danger-soft"
                    role="menuitem"
                  >
                    <Trash2 size={14} />ゴミ箱へ移動
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {exportMessage && (
        <div className={`mb-3 text-xs ${exportMessage.error ? 'text-danger' : 'text-ok'}`}>{exportMessage.text}</div>
      )}

      {/* メタ情報 */}
      <div className="mb-6 grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
        {/* 日時: 開始・終了の2入力を横に並べ、幅が足りない場合はここだけで折り返す（時間欄とは重ならない） */}
        <div className="sm:col-span-2">
          <div className="mb-1 text-xs text-ink-mute">日時</div>
          <div className="flex flex-wrap items-center gap-1.5">
            <input
              type="datetime-local"
              step={1}
              value={startTime}
              disabled={readOnly}
              onChange={(e) => { setStartTime(e.target.value); markDirty('startTime', fromDatetimeLocalValue(e.target.value)); }}
              className={`${inputClass} min-w-0 flex-1 basis-[13rem] font-mono text-xs`}
            />
            <span className="shrink-0 text-ink-mute">–</span>
            <input
              type="datetime-local"
              step={1}
              value={endTime}
              disabled={readOnly}
              onChange={(e) => {
                setEndTime(e.target.value);
                markDirty('endTime', (e.target.value ? fromDatetimeLocalValue(e.target.value) : null) as CallRecord['endTime']);
              }}
              className={`${inputClass} min-w-0 flex-1 basis-[13rem] font-mono text-xs`}
            />
          </div>
        </div>
        <div className="sm:col-span-2">
          <div className="mb-1 text-xs text-ink-mute">時間</div>
          <div className="py-1.5 font-mono text-sm tabular-nums text-ink">
            {computedDuration !== null ? formatHMS(computedDuration) : '—'}
            {holdTotal > 0 && <span className="ml-2 text-xs text-pending">（保留 {formatHMS(holdTotal)}）</span>}
          </div>
        </div>
        {isMeeting ? (
          <div className="sm:col-span-2">
            <label className="mb-1 block text-xs text-ink-mute">参加者（読点・カンマ区切り）</label>
            <input
              value={participants}
              disabled={readOnly}
              onChange={(e) => { setParticipants(e.target.value); markDirty('participants', e.target.value ? e.target.value.split(/[、,]/).map((p) => p.trim()).filter(Boolean) : undefined); }}
              placeholder="例: 山田、佐藤、鈴木"
              className={inputClass}
            />
          </div>
        ) : (
          <>
            <div>
              <label className="mb-1 block text-xs text-ink-mute">連絡先</label>
              <input
                value={contactName}
                disabled={readOnly}
                onChange={(e) => { setContactName(e.target.value); markDirty('contactName', orUndef(e.target.value)); }}
                list="record-detail-contact-suggestions"
                placeholder="例: 山田太郎"
                className={inputClass}
              />
              <datalist id="record-detail-contact-suggestions">
                {contactSuggestions.map((n) => <option key={n} value={n} />)}
              </datalist>
            </div>
            <div>
              <label className="mb-1 block text-xs text-ink-mute">電話番号</label>
              <input
                value={phoneNumber}
                disabled={readOnly}
                onChange={(e) => { setPhoneNumber(e.target.value); markDirty('phoneNumber', orUndef(e.target.value)); }}
                onBlur={onPhoneBlur}
                list="record-detail-phone-suggestions"
                placeholder="例: 090-1234-5678"
                className={`${inputClass} font-mono`}
              />
              <datalist id="record-detail-phone-suggestions">
                {phoneSuggestions.map((p) => <option key={p} value={p} />)}
              </datalist>
            </div>
          </>
        )}
      </div>

      {/* タグ */}
      <div className="mb-6">
        <div className="mb-2 text-xs text-ink-mute">タグ</div>
        <div className="flex flex-wrap items-center gap-1.5">
          {tags.map((tn) => {
            const color = settings.tags.find((t) => t.name === tn)?.color ?? NEW_TAG_COLOR;
            return (
              <span key={tn} className="inline-flex items-center gap-1.5 rounded-full py-1 pl-2.5 pr-1 text-xs font-medium text-white" style={{ backgroundColor: color }}>
                {tn}
                {!readOnly && (
                  <button onClick={() => removeTag(tn)} aria-label={`タグ「${tn}」を削除`} className="flex h-3.5 w-3.5 items-center justify-center rounded-full hover:bg-black/15">
                    <X size={9} />
                  </button>
                )}
              </span>
            );
          })}
          {!readOnly && (
            <div className="relative">
              <input
                value={tagDraft}
                onChange={(e) => setTagDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); commitTagDraft(); }
                  if (e.key === 'Escape') setTagDraft('');
                }}
                placeholder="タグを追加…"
                className="w-32 rounded-full border border-dashed border-rule bg-transparent px-2.5 py-1 text-xs text-ink placeholder:text-ink-mute focus:border-accent focus:outline-none"
              />
              {tagDraft.trim() !== '' && (
                <div className="absolute left-0 top-full z-10 mt-1 min-w-[10rem] rounded-md border border-rule bg-surface p-1 text-xs shadow-lg">
                  {tagDraftIsNew && (
                    <button onClick={commitTagDraft} className="block w-full rounded px-2 py-1.5 text-left text-ink hover:bg-accent-soft">
                      ＋ 新しいタグ「<b className="font-medium text-accent-ink">{tagDraft.trim()}</b>」を作成
                    </button>
                  )}
                  {tagSuggestions.map((n) => (
                    <button key={n} onClick={() => addExistingTag(n)} className="block w-full rounded px-2 py-1.5 text-left text-ink hover:bg-accent-soft">
                      {n}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* メモ */}
      <div className="mb-6">
        <div className="mb-2 text-xs text-ink-mute">メモ</div>
        <textarea
          value={memo}
          disabled={readOnly}
          onChange={(e) => { setMemo(e.target.value); markDirty('memo', e.target.value); }}
          rows={4}
          placeholder={isMeeting ? '会議の要点・決定事項など' : '通話内容のメモ'}
          className={`${inputClass} leading-relaxed`}
        />
      </div>

      {/* 保留区間 */}
      {current.holds && current.holds.length > 0 && (
        <details className="mb-4 rounded-md border border-rule bg-surface px-3 py-2">
          <summary className="cursor-pointer select-none text-xs font-medium text-ink">
            保留区間 ({current.holds.length} 件 / 合計 {formatHMS(holdTotal)})
          </summary>
          <ul className="mt-2 space-y-1 text-xs">
            {current.holds.map((h, i) => (
              <li key={i} className="flex items-center gap-3 rounded border border-rule bg-paper px-2 py-1">
                <span className="font-mono text-ink-mute">{formatDateTime(h.start)}</span>
                <span className="text-ink-mute">→</span>
                <span className="font-mono text-ink-mute">{h.end ? formatDateTime(h.end) : '進行中'}</span>
                <span className="ml-auto font-mono text-pending">{formatHMS(h.sec)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* 録音 */}
      {audioSrc && (
        <div className="mb-6">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-mute">
              <Mic size={14} />
              録音（{current.audio?.source === 'mic+system' ? 'マイク+システム' : current.audio?.source === 'system' ? 'システム音声' : 'マイク'}）
              <span className="font-normal">{formatHMS(current.audio?.durationSec ?? 0)} / {((current.audio?.bytes ?? 0) / 1024 / 1024).toFixed(2)} MB</span>
            </div>
            {!readOnly && (
              <button onClick={handleSaveAudio} className={smallBtn} title="録音 (MP3) を名前を付けて保存">
                <Download size={12} /> 録音を保存
              </button>
            )}
          </div>
          <AudioPlayer ref={playerRef} src={audioSrc} onTimeUpdate={setPlaySec} />
        </div>
      )}

      {/* マーカー */}
      {(current.markers?.length ?? 0) > 0 && (
        <div className="mb-6 rounded-lg border border-rule bg-surface p-3">
          <div className="mb-2 inline-flex items-center gap-1.5 text-sm font-medium text-ink">
            <Bookmark size={14} className="text-accent-ink" />
            マーカー ({current.markers!.length})
          </div>
          <ul className="space-y-1.5">
            {current.markers!.map((m, i) => (
              <li key={`${m.at}-${i}`} className="flex items-center gap-2">
                <button
                  onClick={() => playerRef.current?.seekTo(Math.max(0, m.at - settings.transcriptSeekOffsetSec))}
                  disabled={!audioSrc}
                  className="inline-flex shrink-0 items-center gap-1 rounded border border-rule bg-surface px-2 py-1 font-mono text-xs tabular-nums text-accent-ink hover:bg-accent-soft disabled:cursor-default disabled:text-ink-mute disabled:hover:bg-surface"
                >
                  <Play size={10} /> {formatHMS(m.at)}
                </button>
                {readOnly ? (
                  <span className="min-w-0 flex-1 truncate text-xs text-ink-mute">{m.label ?? ''}</span>
                ) : (
                  <input
                    defaultValue={m.label ?? ''}
                    onBlur={(e) => { if (e.target.value !== (m.label ?? '')) handleMarkerLabel(i, e.target.value.trim()); }}
                    placeholder="ラベルを入力（例: 決定事項、宿題）"
                    className="min-w-0 flex-1 rounded-md border border-rule bg-surface px-2 py-1 text-xs"
                  />
                )}
                {!readOnly && (
                  <button onClick={() => handleMarkerDelete(i)} className="shrink-0 rounded p-1 text-ink-mute hover:bg-danger-soft hover:text-danger" title="このマーカーを削除">
                    <X size={12} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 文字起こし / ライブ文字起こし */}
      {audioSrc ? (
        <div className="mb-2 flex min-h-[16rem] flex-col">
          <div className="mb-2 flex flex-none flex-wrap items-center justify-between gap-2">
            <div className="inline-flex items-center gap-1.5 text-sm font-medium text-ink">
              <FileText size={14} className="text-ink-mute" />文字起こし
              {current.transcript && <span className="rounded-full border border-rule px-2 py-0.5 text-[11px] text-ink-mute">{current.transcript.model}・{current.transcript.language || '自動'}</span>}
            </div>
            {!readOnly && (
              <div className="flex items-center gap-2">
                {transcribing && !transcriptBusy && <span className="text-xs text-ink-mute">開始しています…</span>}
                {current.transcriptStatus === 'running' && (
                  <span className="text-xs font-medium text-accent-ink">
                    {transcribeProgress === null ? '準備中…' : transcribeProgress.stage === 'convert' ? '音声を変換中…' : `文字起こし中 ${transcribeProgress.percent}%`}
                  </span>
                )}
                {current.transcriptStatus === 'queued' && (
                  <span className="text-xs text-ink-mute">待機中{queuePos && queuePos > 1 ? `（${queuePos} 番目）` : '（まもなく開始）'}</span>
                )}
                {transcriptBusy && (
                  <button onClick={handleCancelTranscribe} className="inline-flex items-center gap-1 rounded-md border border-danger/40 bg-surface px-2 py-1 text-xs font-medium text-danger hover:bg-danger-soft">
                    <Ban size={12} /> キャンセル
                  </button>
                )}
                {!transcriptBusy && (
                  <>
                    <select
                      value={transcribeModel}
                      onChange={(e) => setTranscribeModel(e.target.value as WhisperModel)}
                      className="rounded-md border border-rule bg-surface px-1.5 py-1 text-xs text-ink"
                      title="文字起こしに使うモデルを選択（大きいほど高精度・低速）"
                    >
                      {WHISPER_MODELS.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
                    </select>
                    <button
                      onClick={handleTranscribe}
                      disabled={transcribing}
                      className="inline-flex items-center gap-1 rounded-md bg-accent px-3 py-1 text-xs font-medium text-on-accent hover:bg-accent/90 disabled:opacity-50"
                    >
                      <RefreshCw size={12} />{current.transcript ? '再実行' : '文字起こし'}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
          {(current.transcriptStatus === 'running' || current.transcriptStatus === 'queued') && (
            <div className="mb-2 h-1.5 w-full flex-none overflow-hidden rounded bg-rule">
              <div
                className={`h-full bg-accent transition-all ${current.transcriptStatus === 'queued' ? 'animate-pulse' : ''}`}
                style={{ width: `${current.transcriptStatus === 'queued' ? 100 : (transcribeProgress?.percent ?? 2)}%`, opacity: current.transcriptStatus === 'queued' ? 0.25 : 1 }}
              />
            </div>
          )}
          {current.transcriptStatus === 'error' && current.transcriptError && (
            <div className="mb-2 flex-none rounded border border-danger/30 bg-danger-soft p-2 text-xs text-danger whitespace-pre-wrap">{current.transcriptError}</div>
          )}
          {transcribeError && (
            <div className="mb-2 flex-none rounded border border-danger/30 bg-danger-soft p-2 text-xs text-danger whitespace-pre-wrap">{transcribeError}</div>
          )}
          <TranscriptView
            className="min-h-[14rem] flex-1"
            transcript={current.transcript}
            currentSec={playSec}
            onSeek={(t) => playerRef.current?.seekTo(Math.max(0, t - settings.transcriptSeekOffsetSec))}
            onEditSegment={readOnly ? undefined : (i, text) => void handleEditSegment(i, text)}
          />
        </div>
      ) : !current.endTime && !readOnly ? (
        <div className="flex min-h-[10rem] flex-col">
          <div className="mb-2 flex flex-none flex-wrap items-center gap-1.5 text-sm font-medium text-ink">
            <AudioLines size={14} className="text-accent-ink" />ライブ文字起こし（暫定）
            <span className="text-xs font-normal text-ink-mute">録音終了後に whisper が確定版を生成します</span>
          </div>
          <div ref={liveScrollRef} className="min-h-0 flex-1 overflow-y-auto rounded-md border border-rule bg-surface p-3 text-sm leading-relaxed">
            {liveLines.length === 0 && !livePartial ? (
              <div className="text-xs text-ink-mute">
                記録中です。ライブ文字起こしが有効な場合、認識結果がここに順次表示されます。
                <br />（設定 → 文字起こし → ライブ文字起こし から有効化できます）
              </div>
            ) : (
              <>
                {liveLines.map((l, i) => (
                  <div key={i} className="mb-1.5 flex gap-2">
                    <span className="flex-none pt-0.5 font-mono text-[10px] text-ink-mute">{formatHMS(Math.floor(l.at))}</span>
                    <span className="min-w-0 text-ink">{l.text}</span>
                  </div>
                ))}
                {livePartial && (
                  <div className="mb-1.5 flex gap-2 opacity-60">
                    <span className="flex-none pt-0.5 font-mono text-[10px] text-ink-mute">…</span>
                    <span className="min-w-0 text-ink-mute">{livePartial}</span>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
