import { useEffect, useMemo, useState } from 'react';
import { CallRecord, RecordKind, RecordingSourceConfig, Settings } from '../../shared/types';
import { AudioDeviceSelect } from './AudioDeviceSelect';

interface CaptureWindow {
  id: string;
  name: string;
  thumbnail: string | null;
}

/** 開始時に入力する記録のメタ情報 */
export interface StartMeta {
  contactName?: string;
  phoneNumber?: string;
  title?: string;
  participants?: string[];
}

interface Props {
  /** 開くときの初期タブ（前回の種別） */
  initialKind: RecordKind;
  settings: Settings;
  /** 連絡先サジェスト用 */
  calls: CallRecord[];
  onCancel: () => void;
  /** 種別・メタ・録音構成を確定して開始。config が null のときは録音なしで開始 */
  onStart: (
    kind: RecordKind,
    meta: StartMeta,
    config: RecordingSourceConfig | null,
    windowId: string | null,
    micDeviceId: string | null,
    saveAsDefault: boolean,
  ) => void;
}

/** 通話/会議の統合開始ダイアログ。タブで種別を切り替え、メタ情報と録音ソースを選んで開始する */
export function StartRecordDialog({ initialKind, settings, calls, onCancel, onStart }: Props) {
  const [kind, setKind] = useState<RecordKind>(initialKind);
  const isMeeting = kind === 'meeting';

  // メタ情報（タブを切り替えても値は保持する）
  const [contactName, setContactName] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [title, setTitle] = useState('');
  const [participants, setParticipants] = useState('');

  // 録音ソース（タブごとに既定値から初期化し、タブ内の変更は保持）
  const [sources, setSources] = useState<Record<RecordKind, RecordingSourceConfig>>({
    call: { ...settings.recording.callSource },
    meeting: { ...settings.recording.meetingSource },
  });
  const cfg = sources[kind];
  const setCfg = (patch: Partial<RecordingSourceConfig>) =>
    setSources((prev) => ({ ...prev, [kind]: { ...prev[kind], ...patch } }));

  const [micDeviceId, setMicDeviceId] = useState<string | null>(settings.recording.micDeviceId);
  const [windows, setWindows] = useState<CaptureWindow[] | null>(null);
  const [windowId, setWindowId] = useState<string | null>(null);
  const [loadingWindows, setLoadingWindows] = useState(false);
  const [saveAsDefault, setSaveAsDefault] = useState(false);

  const recordingEnabled = settings.recording.enabled;
  const nothingSelected = !cfg.mic && !cfg.system;
  const needsWindow = recordingEnabled && cfg.system && cfg.systemScope === 'window';

  const contactSuggestions = useMemo(() => {
    const s = new Set<string>();
    for (const c of calls) if (c.contactName && !c.deletedAt) s.add(c.contactName);
    return [...s].sort();
  }, [calls]);

  const loadWindows = async () => {
    setLoadingWindows(true);
    try {
      const list = await window.api.capture.listWindows();
      setWindows(list);
      if (windowId && !list.some((w) => w.id === windowId)) setWindowId(null);
    } finally {
      setLoadingWindows(false);
    }
  };

  useEffect(() => {
    if (needsWindow && windows === null) void loadWindows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsWindow]);

  const handleStart = () => {
    const meta: StartMeta = isMeeting
      ? {
          title: title.trim() || undefined,
          participants: participants
            ? participants.split(/[、,]/).map((p) => p.trim()).filter(Boolean)
            : undefined,
        }
      : {
          contactName: contactName.trim() || undefined,
          phoneNumber: phoneNumber.trim() || undefined,
        };
    if (!recordingEnabled || nothingSelected) {
      onStart(kind, meta, null, null, null, saveAsDefault);
      return;
    }
    onStart(kind, meta, cfg, needsWindow ? windowId : null, micDeviceId, saveAsDefault);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      // 入力欄の Enter でも即開始できるようにする（textarea は無いので安全）
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        handleStart();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, contactName, phoneNumber, title, participants, sources, windowId, micDeviceId, saveAsDefault]);

  const inputClass =
    'w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100';

  const tabClass = (active: boolean, meeting: boolean) =>
    `flex-1 rounded-lg px-4 py-2.5 text-sm font-semibold transition ${
      active
        ? meeting
          ? 'bg-violet-600 text-white shadow-sm'
          : 'bg-brand-600 text-white shadow-sm'
        : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'
    }`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      onClick={onCancel}
    >
      <div
        className="w-[min(94vw,40rem)] max-h-[92vh] overflow-auto rounded-xl bg-white p-6 shadow-2xl dark:bg-slate-900 dark:text-slate-100"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 種別タブ */}
        <div className="mb-4 flex gap-2">
          <button onClick={() => setKind('call')} className={tabClass(!isMeeting, false)}>
            📞 通話
          </button>
          <button onClick={() => setKind('meeting')} className={tabClass(isMeeting, true)}>
            👥 会議
          </button>
        </div>

        {/* メタ情報（開始前に入れておける。あとから編集も可能） */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {isMeeting ? (
            <>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">会議タイトル（任意）</span>
                <input
                  autoFocus
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className={inputClass}
                  placeholder="例: 週次定例"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">参加者（読点区切り・任意）</span>
                <input
                  value={participants}
                  onChange={(e) => setParticipants(e.target.value)}
                  className={inputClass}
                  placeholder="例: 山田、佐藤"
                />
              </label>
            </>
          ) : (
            <>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">連絡先名（任意）</span>
                <input
                  autoFocus
                  value={contactName}
                  onChange={(e) => setContactName(e.target.value)}
                  list="start-contact-suggestions"
                  className={inputClass}
                  placeholder="例: 山田太郎"
                />
                <datalist id="start-contact-suggestions">
                  {contactSuggestions.map((n) => <option key={n} value={n} />)}
                </datalist>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">電話番号（任意）</span>
                <input
                  value={phoneNumber}
                  onChange={(e) => setPhoneNumber(e.target.value)}
                  className={inputClass}
                  placeholder="例: 090-1234-5678"
                />
              </label>
            </>
          )}
        </div>

        {/* 録音ソース */}
        {recordingEnabled ? (
          <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800">
            <div className="mb-2 text-xs font-semibold text-slate-600 dark:text-slate-300">🎙 録音ソース</div>
            <div className="flex flex-wrap items-center gap-4 text-sm text-slate-700 dark:text-slate-300">
              <label className="inline-flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={cfg.mic}
                  onChange={(e) => setCfg({ mic: e.target.checked })}
                />
                🎤 マイク
              </label>
              <label className="inline-flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={cfg.system}
                  onChange={(e) => setCfg({ system: e.target.checked })}
                />
                🔊 システム音声
              </label>
              {cfg.system && (
                <span className="inline-flex items-center gap-3 rounded-md bg-white px-2 py-1 text-xs ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-700">
                  <label className="inline-flex items-center gap-1">
                    <input
                      type="radio"
                      checked={cfg.systemScope === 'screen'}
                      onChange={() => setCfg({ systemScope: 'screen' })}
                    />
                    画面全体
                  </label>
                  <label className="inline-flex items-center gap-1">
                    <input
                      type="radio"
                      checked={cfg.systemScope === 'window'}
                      onChange={() => setCfg({ systemScope: 'window' })}
                    />
                    ウィンドウ選択
                  </label>
                </span>
              )}
            </div>
            {cfg.mic && (
              <div className="mt-2">
                <div className="mb-1 text-xs text-slate-500 dark:text-slate-400">使用するマイク</div>
                <AudioDeviceSelect value={micDeviceId} onChange={setMicDeviceId} />
              </div>
            )}
            {needsWindow && (
              <div className="mt-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    対象ウィンドウ{windowId ? '' : '（未選択の場合は画面全体になります）'}
                  </span>
                  <button
                    onClick={() => void loadWindows()}
                    disabled={loadingWindows}
                    className="rounded border border-slate-300 bg-white px-2 py-0.5 text-xs hover:bg-slate-100 disabled:opacity-50 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-700"
                  >
                    {loadingWindows ? '更新中…' : '🔄 更新'}
                  </button>
                </div>
                <div className="grid max-h-44 grid-cols-2 gap-2 overflow-auto">
                  {(windows ?? []).map((w) => (
                    <button
                      key={w.id}
                      onClick={() => setWindowId(windowId === w.id ? null : w.id)}
                      className={`rounded-lg border p-1.5 text-left transition ${
                        windowId === w.id
                          ? 'border-brand-400 ring-2 ring-brand-300 dark:border-brand-600 dark:ring-brand-700'
                          : 'border-slate-200 hover:border-slate-300 dark:border-slate-700 dark:hover:border-slate-600'
                      }`}
                      title={w.name}
                    >
                      {w.thumbnail ? (
                        <img src={w.thumbnail} alt="" className="h-14 w-full rounded object-cover" />
                      ) : (
                        <div className="flex h-14 w-full items-center justify-center rounded bg-slate-100 text-2xl dark:bg-slate-700">🪟</div>
                      )}
                      <div className="mt-1 truncate text-[11px] text-slate-700 dark:text-slate-300">{w.name}</div>
                    </button>
                  ))}
                  {windows !== null && windows.length === 0 && (
                    <div className="col-span-2 py-4 text-center text-xs text-slate-400">
                      キャプチャ可能なウィンドウがありません
                    </div>
                  )}
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
                  ⚠️ 実験的機能: Windows の仕様上、環境によっては全体の音声が録音される場合があります。
                </p>
              </div>
            )}
            {nothingSelected && (
              <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
                ⚠️ ソースが未選択のため、録音なしで時間だけを記録します。
              </p>
            )}
            <label className="mt-3 flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
              <input
                type="checkbox"
                checked={saveAsDefault}
                onChange={(e) => setSaveAsDefault(e.target.checked)}
              />
              この録音構成を{isMeeting ? '会議' : '通話'}の既定として保存する
            </label>
          </div>
        ) : (
          <p className="mt-4 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400">
            録音は無効です（時間の記録のみ）。録音するには設定の「録音」で有効化してください。
          </p>
        )}

        <div className="mt-5 flex items-center justify-between">
          <span className="text-[11px] text-slate-400 dark:text-slate-500">
            Enter で開始 / ショートカット {isMeeting ? settings.shortcuts.startMeeting : settings.shortcuts.startCall} は即開始
          </span>
          <div className="flex gap-2">
            <button
              onClick={onCancel}
              className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
            >
              キャンセル
            </button>
            <button
              onClick={handleStart}
              className={`rounded-md px-5 py-2 text-sm font-semibold text-white shadow-sm ${
                isMeeting ? 'bg-violet-600 hover:bg-violet-700' : 'bg-brand-600 hover:bg-brand-700'
              }`}
            >
              {recordingEnabled && !nothingSelected ? '🔴 録音して開始' : '▶ 開始'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
