import { useEffect, useRef, useState } from 'react';
import {
  AppEvent, RecordingSourceConfig, Settings, TagDef, ThemePref, WhisperModel,
  VoskLiveModel, VOSK_MODELS, TranscriptionSettings, TermReplacement,
} from '../../shared/types';
import {
  Palette, AppWindow, Keyboard, Tag, Mic, FileText, Bell, Database, Info,
  Download, RefreshCw, FolderOpen, CircleCheck, AlertTriangle, Volume2, AudioLines, Plus, X, Video,
  ChevronUp, ChevronDown,
} from 'lucide-react';
import { ShortcutInput } from '../components/ShortcutInput';
import { AudioDeviceSelect } from '../components/AudioDeviceSelect';
import { ModelManager } from '../components/ModelManager';
import { useToast } from '../components/Toast';
import { toUserMessage } from '../utils/errorMessage';

const sectionClass =
  'rounded-lg border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900';
const inputClass =
  'rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100';
const ghostBtn =
  'rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700';

/** whisper.cpp のセットアップ状態 + 実行ファイルのアプリ内ダウンロード */
function WhisperSetup({
  gpuUnlocked,
  useGpu,
  onToggleGpu,
}: {
  gpuUnlocked: boolean;
  useGpu: boolean;
  onToggleGpu: (v: boolean) => void;
}) {
  const [status, setStatus] = useState<{ ok: true } | { ok: false; error: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [downloading, setDownloading] = useState<null | 'cpu' | 'gpu'>(null);
  const [progress, setProgress] = useState<{ step: string; rec: number; total: number | null } | null>(null);
  const [dlError, setDlError] = useState<string | null>(null);
  const [gpuInstalled, setGpuInstalled] = useState(false);

  const run = async () => {
    setChecking(true);
    try {
      setStatus(await window.api.transcription.checkSetup());
      setGpuInstalled((await window.api.whisper.binaryStatus('gpu')).installed);
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    run();
    const off = window.api.onEvent((e: AppEvent) => {
      if (e.type !== 'whisperbin:download') return;
      if (e.step === 'done') {
        setDownloading(null);
        setProgress(null);
        void run();
      } else if (e.step === 'error') {
        setDownloading(null);
        setProgress(null);
        setDlError(toUserMessage(e.error, 'ダウンロードに失敗しました'));
      } else {
        setProgress({ step: e.step, rec: e.receivedBytes, total: e.totalBytes });
      }
    });
    return () => off();
  }, []);

  const download = async (variant: 'cpu' | 'gpu' = 'cpu') => {
    setDlError(null);
    setDownloading(variant);
    setProgress({ step: 'download', rec: 0, total: null });
    await window.api.whisper.downloadBinary(variant);
  };

  const pct = progress?.total ? Math.round((progress.rec / progress.total) * 100) : null;
  const mb = (n: number) => (n / 1024 / 1024).toFixed(1);

  return (
    <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800">
      <div className="mb-1 flex items-center justify-between">
        <div className="text-xs font-medium text-slate-700 dark:text-slate-300">セットアップ状態</div>
        <button
          onClick={run}
          disabled={checking}
          className="rounded border border-slate-300 bg-white px-2 py-0.5 text-xs hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-700"
        >
          再チェック
        </button>
      </div>
      {status === null && <div className="text-xs text-slate-500">確認中…</div>}
      {status && status.ok && (
        <div className="inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-300"><CircleCheck size={13} />文字起こしの準備が整っています。</div>
      )}
      {status && !status.ok && (
        <div className="space-y-2">
          <div className="whitespace-pre-wrap text-xs text-red-700 dark:text-red-300">{toUserMessage(status.error, '文字起こしの準備を確認できませんでした')}</div>
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          onClick={() => download('cpu')}
          disabled={downloading !== null}
          className="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
          title="whisper.cpp の Windows ビルドを GitHub から取得して自動配置します"
        >
          {downloading === 'cpu' ? '取得中…' : <><Download size={12} className="mr-1 inline align-[-1px]" />whisper.cpp をダウンロード</>}
        </button>
        {gpuUnlocked && (
          <button
            onClick={() => download('gpu')}
            disabled={downloading !== null}
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
            title="NVIDIA CUDA 対応ビルド（大容量）。NVIDIA GPU が必要です"
          >
            {downloading === 'gpu' ? '取得中…' : <><Download size={12} className="mr-1 inline align-[-1px]" />GPU (CUDA) 版をダウンロード</>}
          </button>
        )}
        {progress && (
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {progress.step === 'extract'
              ? '展開中…'
              : pct !== null
                ? `ダウンロード中 ${pct}% (${mb(progress.rec)} MB)`
                : `ダウンロード中 ${mb(progress.rec)} MB`}
          </span>
        )}
      </div>
      {gpuUnlocked && (
        <label className="mt-2 flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300">
          <input
            type="checkbox"
            checked={useGpu}
            onChange={(e) => onToggleGpu(e.target.checked)}
            disabled={!gpuInstalled}
          />
          GPU (CUDA) 版を使用する
          <span className="text-slate-500 dark:text-slate-400">
            {gpuInstalled ? '— 文字起こしが数倍高速になります（NVIDIA GPU 必須）' : '— 先に GPU 版をダウンロードしてください'}
          </span>
        </label>
      )}
      {progress && pct !== null && progress.step === 'download' && (
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-slate-200 dark:bg-slate-700">
          <div className="h-full bg-brand-500 transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}
      {dlError && (
        <div className="mt-2 whitespace-pre-wrap text-xs text-red-700 dark:text-red-300">{dlError}</div>
      )}
    </div>
  );
}

/** ライブ文字起こし（Vosk）の設定 + エンジン・モデルのアプリ内ダウンロード */
function LiveTranscribeSetup({
  recordingEnabled,
  transcription,
  onChange,
}: {
  recordingEnabled: boolean;
  transcription: TranscriptionSettings;
  onChange: (patch: Partial<TranscriptionSettings>) => void;
}) {
  const enabled = transcription.liveEnabled ?? false;
  const model = transcription.liveModel ?? 'small-ja';
  const [status, setStatus] = useState<{ engine: boolean; models: Record<VoskLiveModel, boolean> } | null>(null);
  const [downloading, setDownloading] = useState<null | 'engine' | 'engine-legacy' | VoskLiveModel>(null);
  const [progress, setProgress] = useState<{ step: string; rec: number; total: number | null } | null>(null);
  const [dlError, setDlError] = useState<string | null>(null);

  const refresh = () => { void window.api.vosk.status().then(setStatus).catch(() => {}); };

  useEffect(() => {
    refresh();
    const off = window.api.onEvent((e: AppEvent) => {
      if (e.type !== 'vosk:download') return;
      if (e.step === 'done') {
        setDownloading(null);
        setProgress(null);
        refresh();
      } else if (e.step === 'error') {
        setDownloading(null);
        setProgress(null);
        setDlError(toUserMessage(e.error, 'ダウンロードに失敗しました'));
      } else {
        setProgress({ step: e.step, rec: e.receivedBytes, total: e.totalBytes });
      }
    });
    return () => off();
  }, []);

  const download = async (what: 'engine' | 'engine-legacy' | VoskLiveModel) => {
    setDlError(null);
    setDownloading(what);
    setProgress({ step: 'download', rec: 0, total: null });
    await window.api.vosk.download(what);
  };

  const pct = progress?.total ? Math.round((progress.rec / progress.total) * 100) : null;
  const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
  const engineOk = status?.engine ?? false;
  const modelOk = status?.models?.[model] ?? false;
  const ready = engineOk && modelOk;

  return (
    <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800">
      <div className="mb-1 flex items-center justify-between">
        <div className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-700 dark:text-slate-300">
          <AudioLines size={13} className="text-sky-500" />
          ライブ文字起こし（実験的 / Vosk）
        </div>
        <button
          onClick={refresh}
          className="rounded border border-slate-300 bg-white px-2 py-0.5 text-xs hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-700"
        >
          再チェック
        </button>
      </div>
      <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">
        録音中の音声をその場で認識し、HUD と編集画面に暫定テキストを表示します（オフライン動作）。
        録音終了後は従来どおり whisper が高精度の確定版を生成します。
      </p>
      <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
        <input
          type="checkbox"
          checked={enabled}
          disabled={!recordingEnabled || (!ready && !enabled)}
          onChange={(e) => onChange({ liveEnabled: e.target.checked })}
        />
        録音中にライブ文字起こしを表示する
        {!recordingEnabled && <span className="text-xs text-slate-500 dark:text-slate-400">— 先に録音を有効にしてください</span>}
        {recordingEnabled && !ready && <span className="text-xs text-slate-500 dark:text-slate-400">— 下のエンジンとモデルの配置が必要です</span>}
      </label>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className={`inline-flex items-center gap-1 text-xs ${engineOk ? 'text-emerald-700 dark:text-emerald-300' : 'text-slate-500 dark:text-slate-400'}`}>
          {engineOk ? <CircleCheck size={13} /> : <AlertTriangle size={13} />}
          エンジン (libvosk)
        </span>
        {!engineOk && (
          <button
            onClick={() => download('engine')}
            disabled={downloading !== null}
            className="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {downloading === 'engine' ? '取得中…' : <><Download size={12} className="mr-1 inline align-[-1px]" />エンジンをダウンロード (約7MB)</>}
          </button>
        )}
        {engineOk && (
          <button
            onClick={() => download('engine-legacy')}
            disabled={downloading !== null}
            className="rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-700"
            title="ライブ文字起こしの開始に失敗する（エンジンがクラッシュする）場合、互換性の高い旧バージョン (0.3.42) に入れ替えて試せます"
          >
            {downloading === 'engine-legacy' ? '取得中…' : '動かない場合: 旧バージョン (0.3.42) に入れ替える'}
          </button>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          value={model}
          onChange={(e) => onChange({ liveModel: e.target.value as VoskLiveModel })}
          className={`w-64 ${inputClass}`}
          disabled={downloading !== null}
        >
          {VOSK_MODELS.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
        <span className={`inline-flex items-center gap-1 text-xs ${modelOk ? 'text-emerald-700 dark:text-emerald-300' : 'text-slate-500 dark:text-slate-400'}`}>
          {modelOk ? <><CircleCheck size={13} />配置済み</> : <><AlertTriangle size={13} />未ダウンロード</>}
        </span>
        {!modelOk && (
          <button
            onClick={() => download(model)}
            disabled={downloading !== null}
            className="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {downloading === model ? '取得中…' : <><Download size={12} className="mr-1 inline align-[-1px]" />モデルをダウンロード</>}
          </button>
        )}
      </div>
      {progress && (
        <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          {progress.step === 'extract'
            ? '展開中…'
            : pct !== null
              ? `ダウンロード中 ${pct}% (${mb(progress.rec)} MB)`
              : `ダウンロード中 ${mb(progress.rec)} MB`}
        </div>
      )}
      {progress && pct !== null && progress.step === 'download' && (
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-slate-200 dark:bg-slate-700">
          <div className="h-full bg-brand-500 transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}
      {dlError && (
        <div className="mt-2 whitespace-pre-wrap text-xs text-red-700 dark:text-red-300">{dlError}</div>
      )}
    </div>
  );
}

/** 単語登録（置換辞書）の編集 UI。誤り → 正しい語 のペアを増減・編集できる */
function TermReplacementEditor({
  list,
  onChange,
}: {
  list: TermReplacement[];
  onChange: (next: TermReplacement[]) => void;
}) {
  const setAt = (i: number, patch: Partial<TermReplacement>) => {
    onChange(list.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  };
  const remove = (i: number) => onChange(list.filter((_, idx) => idx !== i));
  const add = () => onChange([...list, { from: '', to: '' }]);

  return (
    <div className="w-full space-y-1.5">
      {list.length > 0 && (
        <div className="space-y-1.5">
          {list.map((r, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <input
                value={r.from}
                onChange={(e) => setAt(i, { from: e.target.value })}
                placeholder="誤り（認識される語）"
                className={`min-w-0 flex-1 ${inputClass}`}
              />
              <span className="flex-none text-slate-400">→</span>
              <input
                value={r.to}
                onChange={(e) => setAt(i, { to: e.target.value })}
                placeholder="正しい語"
                className={`min-w-0 flex-1 ${inputClass}`}
              />
              <button
                onClick={() => remove(i)}
                className="flex-none rounded p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950"
                title="この行を削除"
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      <button
        onClick={add}
        className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
      >
        <Plus size={12} /> 単語を追加
      </button>
    </div>
  );
}

/** 現在のウィンドウ名を一覧表示（Teams 検知の調整・診断用） */
function TeamsWindowProbe() {
  const [wins, setWins] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const probe = async () => {
    setLoading(true);
    try {
      setWins(await window.api.teams.listWindows());
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="w-full">
      <button onClick={probe} disabled={loading} className={ghostBtn}>
        {loading ? '取得中…' : '現在のウィンドウ名を表示'}
      </button>
      {wins && (
        <div className="mt-2 max-h-40 overflow-y-auto rounded-md border border-slate-200 bg-slate-50 p-2 text-xs dark:border-slate-700 dark:bg-slate-800">
          {wins.length === 0 ? (
            <div className="text-slate-500 dark:text-slate-400">ウィンドウが取得できませんでした</div>
          ) : (
            <ul className="space-y-0.5">
              {wins.map((w, i) => (
                <li key={i} className={`truncate ${/teams/i.test(w) ? 'font-semibold text-brand-600 dark:text-brand-300' : 'text-slate-600 dark:text-slate-300'}`} title={w}>
                  {w}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
            Teams 会議/通話を開いた状態でこのボタンを押すと、その名前が一覧に出ます（青字は「teams」を含む候補）。
            上の「Teams ウィンドウ判定語」を、会議中だけ現れるウィンドウ名に共通する語に合わせてください。
          </div>
        </div>
      )}
    </div>
  );
}

const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
const GPU_UNLOCK_KEY = 'callstack.gpuUnlocked';

export function SettingsPage({ settings, onSave }: { settings: Settings; onSave: (s: Settings) => Promise<void> }) {
  const toast = useToast();
  const [draft, setDraft] = useState<Settings>(settings);
  const [showRecordingWarning, setShowRecordingWarning] = useState(false);
  // 隠しコマンド (↑↑↓↓←→←→BA) で GPU 版のオプションを解放
  const [gpuUnlocked, setGpuUnlocked] = useState(
    () => localStorage.getItem(GPU_UNLOCK_KEY) === '1' || !!settings.transcription.useGpu,
  );
  const konamiPos = useRef(0);
  useEffect(() => {
    if (gpuUnlocked) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (key === KONAMI[konamiPos.current]) {
        konamiPos.current += 1;
        if (konamiPos.current === KONAMI.length) {
          konamiPos.current = 0;
          setGpuUnlocked(true);
          localStorage.setItem(GPU_UNLOCK_KEY, '1');
          toast.success('隠しオプションを解放しました: GPU (CUDA) 版 whisper が利用できます');
        }
      } else {
        konamiPos.current = key === KONAMI[0] ? 1 : 0;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gpuUnlocked]);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const lastIncoming = useRef<Settings>(settings);

  // Adopt remote updates only when they actually differ from what we just
  // saved — avoids fighting the user mid-edit while still reflecting changes
  // from other surfaces (tray, HUD, etc.).
  useEffect(() => {
    if (settings !== lastIncoming.current) {
      lastIncoming.current = settings;
      setDraft(settings);
    }
  }, [settings]);

  // Persist the draft as soon as it differs from the latest incoming settings.
  // 200ms debounce keeps text fields (tag names, numbers) from spamming IPC.
  const saveTimer = useRef<number | null>(null);
  const commit = (next: Settings) => {
    setDraft(next);
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      lastIncoming.current = next;
      void onSave(next);
    }, 200);
  };

  const update = (patch: Partial<Settings>) => commit({ ...draftRef.current, ...patch });
  const updateShortcut = (key: keyof Settings['shortcuts'], v: string) =>
    commit({ ...draftRef.current, shortcuts: { ...draftRef.current.shortcuts, [key]: v } });
  const updateRecording = (patch: Partial<Settings['recording']>) =>
    commit({ ...draftRef.current, recording: { ...draftRef.current.recording, ...patch } });
  const updateTranscription = (patch: Partial<Settings['transcription']>) =>
    commit({ ...draftRef.current, transcription: { ...draftRef.current.transcription, ...patch } });
  const updateTag = (idx: number, patch: Partial<TagDef>) => {
    const tags = draftRef.current.tags.slice();
    tags[idx] = { ...tags[idx], ...patch };
    commit({ ...draftRef.current, tags });
  };
  const removeTag = (idx: number) =>
    commit({ ...draftRef.current, tags: draftRef.current.tags.filter((_, i) => i !== idx) });
  const addTag = () =>
    commit({ ...draftRef.current, tags: [...draftRef.current.tags, { name: '新規タグ', color: '#94a3b8' }] });
  const moveTag = (idx: number, dir: -1 | 1) => {
    const tags = draftRef.current.tags.slice();
    const j = idx + dir;
    if (j < 0 || j >= tags.length) return;
    [tags[idx], tags[j]] = [tags[j], tags[idx]];
    commit({ ...draftRef.current, tags });
  };

  const handleToggleRecording = (checked: boolean) => {
    if (checked) {
      if (draft.confirmRecordingEnable) {
        setShowRecordingWarning(true);
      } else {
        updateRecording({ enabled: true });
      }
    } else {
      updateRecording({ enabled: false });
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      {/* ============ 外観 ============ */}
      <section className={sectionClass}>
        <h3 className="mb-3 inline-flex items-center gap-2 text-base font-semibold text-slate-900 dark:text-slate-100"><Palette size={16} className="text-slate-400" />外観</h3>
        <Row label="テーマ">
          <div className="flex gap-3 text-sm">
            {(['system', 'light', 'dark', 'black'] as ThemePref[]).map((t) => (
              <label key={t} className="inline-flex items-center gap-1 text-slate-700 dark:text-slate-300">
                <input
                  type="radio"
                  name="theme"
                  checked={draft.theme === t}
                  onChange={() => update({ theme: t })}
                />
                {t === 'system' ? 'システムに合わせる' : t === 'light' ? 'ライト' : t === 'dark' ? 'ダーク' : '黒'}
              </label>
            ))}
          </div>
        </Row>
      </section>

      {/* ============ ウィンドウと HUD ============ */}
      <section className={sectionClass}>
        <h3 className="mb-3 inline-flex items-center gap-2 text-base font-semibold text-slate-900 dark:text-slate-100"><AppWindow size={16} className="text-slate-400" />ウィンドウと HUD</h3>
        <Row label="自動起動">
          <label className="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              checked={draft.launchAtLogin}
              onChange={(e) => update({ launchAtLogin: e.target.checked })}
            />
            Windows ログイン時に CallStack を自動起動する
          </label>
        </Row>
        <Row label="最小化の動作">
          <label className="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              checked={draft.minimizeToTray}
              onChange={(e) => update({ minimizeToTray: e.target.checked })}
            />
            最小化時にタスクトレイに格納する
          </label>
          <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">
            オフなら通常通りタスクバーに最小化されます (×ボタンは常にアプリ終了)
          </span>
        </Row>
        <Row label="HUD のサイズ">
          <div className="flex gap-3 text-sm text-slate-700 dark:text-slate-300">
            {(['mini', 'compact', 'full'] as const).map((s) => (
              <label key={s} className="inline-flex items-center gap-1">
                <input
                  type="radio"
                  checked={draft.hudSize === s}
                  onChange={() => update({ hudSize: s })}
                />
                {s === 'mini' ? 'ミニ (240×34)' : s === 'compact' ? 'コンパクト (400×70)' : 'フル (470×122)'}
              </label>
            ))}
          </div>
          <span className="ml-2 block text-xs text-slate-500 dark:text-slate-400">
            HUD 右上のアイコンでもサイズを循環できます
          </span>
        </Row>
        <Row label="HUD の透明度">
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={30}
              max={100}
              step={5}
              value={Math.round((draft.hudOpacity ?? 1) * 100)}
              onChange={(e) => update({ hudOpacity: Number(e.target.value) / 100 })}
              className="w-56 accent-brand-600"
            />
            <span className="w-12 text-right font-mono text-sm tabular-nums text-slate-700 dark:text-slate-300">
              {Math.round((draft.hudOpacity ?? 1) * 100)}%
            </span>
          </div>
          <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
            カーソルを HUD に乗せている間は自動的に不透明になります
          </span>
        </Row>
        <Row label="HUD のライブ字幕">
          <div className="flex flex-wrap items-center gap-4">
            <label className="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
              <input
                type="checkbox"
                checked={draft.hudLiveVisible ?? true}
                onChange={(e) => update({ hudLiveVisible: e.target.checked })}
              />
              ライブ字幕ウィンドウを表示する
            </label>
            <label className="inline-flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
              文字サイズ
              <select
                value={draft.liveFontSize ?? 'sm'}
                onChange={(e) => update({ liveFontSize: e.target.value as 'sm' | 'md' | 'lg' })}
                className={`w-24 ${inputClass}`}
              >
                <option value="sm">小</option>
                <option value="md">中</option>
                <option value="lg">大</option>
              </select>
            </label>
          </div>
          <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
            録音中のライブ文字起こしを独立したウィンドウに表示します。ウィンドウは自由に移動・リサイズでき、
            文字サイズ（小/中/大）はウィンドウ上でも切り替えられます。表示 ON/OFF は HUD の「字幕」ボタンや
            ウィンドウの × でも操作できます
          </span>
        </Row>
      </section>

      {/* ============ ショートカット ============ */}
      <section className={sectionClass}>
        <h3 className="mb-1 inline-flex items-center gap-2 text-base font-semibold text-slate-900 dark:text-slate-100"><Keyboard size={16} className="text-slate-400" />グローバルショートカット</h3>
        <p className="mb-4 text-xs text-slate-500 dark:text-slate-400">
          システム全体で有効。フォーカス中の入力欄にキーを押すと記録できます。
        </p>
        <div className="space-y-3">
          <Row label="通話を開始">
            <ShortcutInput value={draft.shortcuts.startCall} onChange={(v) => updateShortcut('startCall', v)} />
          </Row>
          <Row label="会議を開始">
            <ShortcutInput value={draft.shortcuts.startMeeting} onChange={(v) => updateShortcut('startMeeting', v)} />
          </Row>
          <Row label="通話/会議を終了">
            <ShortcutInput value={draft.shortcuts.endCall} onChange={(v) => updateShortcut('endCall', v)} />
          </Row>
          <Row label="保留トグル">
            <ShortcutInput value={draft.shortcuts.toggleHold} onChange={(v) => updateShortcut('toggleHold', v)} />
          </Row>
          <Row label="録音の一時停止/再開">
            <ShortcutInput value={draft.shortcuts.togglePauseRecording} onChange={(v) => updateShortcut('togglePauseRecording', v)} />
          </Row>
          <Row label="マーカーを打つ">
            <ShortcutInput value={draft.shortcuts.addMarker} onChange={(v) => updateShortcut('addMarker', v)} />
          </Row>
          <Row label="メイン窓を表示/隠す">
            <ShortcutInput value={draft.shortcuts.toggleWindow} onChange={(v) => updateShortcut('toggleWindow', v)} />
          </Row>
          <Row label="設定画面を開く">
            <ShortcutInput value={draft.shortcuts.openSettings} onChange={(v) => updateShortcut('openSettings', v)} />
          </Row>
          {([1, 2, 3, 4] as const).map((n) => {
            const key = `assignTag${n}` as const;
            const tagName = draft.tags[n - 1]?.name ?? '(未設定)';
            return (
              <Row key={key} label={`クイックタグ ${n} (${tagName})`}>
                <ShortcutInput
                  value={draft.shortcuts[key]}
                  onChange={(v) => updateShortcut(key, v)}
                />
              </Row>
            );
          })}
        </div>
      </section>

      {/* ============ タグ ============ */}
      <section className={sectionClass}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="inline-flex items-center gap-2 text-base font-semibold text-slate-900 dark:text-slate-100"><Tag size={16} className="text-slate-400" />タグ</h3>
          <button onClick={addTag} className={ghostBtn}>＋ タグを追加</button>
        </div>
        <div className="space-y-2">
          {draft.tags.map((t, i) => (
            <div key={i} className="flex items-center gap-3">
              <input
                type="color"
                value={t.color}
                onChange={(e) => updateTag(i, { color: e.target.value })}
                className="h-9 w-9 cursor-pointer rounded border border-slate-300 dark:border-slate-700"
              />
              <input
                value={t.name}
                onChange={(e) => updateTag(i, { name: e.target.value })}
                className={`flex-1 ${inputClass}`}
              />
              <div className="flex items-center">
                <button
                  onClick={() => moveTag(i, -1)}
                  disabled={i === 0}
                  className="rounded p-1 text-slate-400 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-700"
                  title="上へ"
                >
                  <ChevronUp size={16} />
                </button>
                <button
                  onClick={() => moveTag(i, 1)}
                  disabled={i === draft.tags.length - 1}
                  className="rounded p-1 text-slate-400 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-700"
                  title="下へ"
                >
                  <ChevronDown size={16} />
                </button>
              </div>
              <button
                onClick={() => removeTag(i)}
                className="rounded-md border border-red-300 bg-white px-2 py-1.5 text-xs text-red-700 hover:bg-red-50 dark:border-red-800 dark:bg-slate-900 dark:text-red-300 dark:hover:bg-red-950"
              >
                削除
              </button>
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          ▲▼ で並び替えできます。記録には複数のタグを付けられます（記録の編集・HUD の「情報」から選択）。
          上位4つはクイックタグ（{'Ctrl+Shift+1〜4'}）に割り当てられます。
        </p>
      </section>

      {/* ============ 録音 ============ */}
      <section className={sectionClass}>
        <h3 className="mb-3 inline-flex items-center gap-2 text-base font-semibold text-slate-900 dark:text-slate-100"><Mic size={16} className="text-slate-400" />録音</h3>
        <Row label="通話と同時に録音">
          <label className="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              checked={draft.recording.enabled}
              onChange={(e) => handleToggleRecording(e.target.checked)}
            />
            録音を有効にする
          </label>
        </Row>
        <SourceConfigRow
          label="通話の録音ソース"
          value={draft.recording.callSource}
          disabled={!draft.recording.enabled}
          onChange={(v) => updateRecording({ callSource: v })}
        />
        <SourceConfigRow
          label="会議の録音ソース"
          value={draft.recording.meetingSource}
          disabled={!draft.recording.enabled}
          onChange={(v) => updateRecording({ meetingSource: v })}
        />
        <Row label="開始ダイアログ">
          <label className="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              checked={draft.recording.askSourceOnStart}
              onChange={(e) => updateRecording({ askSourceOnStart: e.target.checked })}
            />
            「▶ 開始」ボタンで通話/会議・録音ソースの選択ダイアログを表示する
          </label>
          <span className="ml-2 block text-xs text-slate-500 dark:text-slate-400">
            オフにするとボタンは前回の種別で即開始します。ショートカット・トレイからは常に既定ソースで即開始です
          </span>
        </Row>
        <Row label="マイクデバイス">
          <AudioDeviceSelect
            value={draft.recording.micDeviceId}
            onChange={(id) => updateRecording({ micDeviceId: id })}
          />
        </Row>
        <Row label="MP3 ビットレート">
          <select
            value={draft.recording.mp3Bitrate}
            onChange={(e) => updateRecording({ mp3Bitrate: Number(e.target.value) as 64 | 96 | 128 | 192 })}
            className={`w-32 ${inputClass}`}
            disabled={!draft.recording.enabled}
          >
            {[64, 96, 128, 192].map((b) => (
              <option key={b} value={b}>{b} kbps</option>
            ))}
          </select>
          <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">96kbps で約 700KB/分</span>
        </Row>
        <Row label="録音の保管期限（日）">
          <input
            type="number"
            min={0}
            value={draft.recording.retentionDays ?? ''}
            placeholder="無制限"
            onChange={(e) => {
              const v = e.target.value === '' ? null : Math.max(0, Number(e.target.value));
              updateRecording({ retentionDays: v });
            }}
            className={`w-32 ${inputClass}`}
            disabled={!draft.recording.enabled}
          />
          <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">空欄で無制限。期限切れの音声のみ削除（記録は残ります）</span>
        </Row>
        <Row label="有効化時の同意確認">
          <label className="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              checked={draft.confirmRecordingEnable}
              onChange={(e) => update({ confirmRecordingEnable: e.target.checked })}
            />
            録音を有効化する時に確認モーダルを表示する
          </label>
        </Row>
      </section>

      {/* ============ Teams 連携（実験的） ============ */}
      <section className={sectionClass}>
        <h3 className="mb-1 inline-flex items-center gap-2 text-base font-semibold text-slate-900 dark:text-slate-100"><Video size={16} className="text-slate-400" />Teams 連携（実験的）</h3>
        <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
          Microsoft Teams の会議/通話ウィンドウを監視して自動で記録・録音を開始します（完全オフライン・サインイン不要）。
          Teams のバージョンや表示言語によってはウィンドウ名の書式が異なり、検知精度が変わる場合があります。録音を有効にしてご利用ください。
        </p>
        <Row label="Teams を検知して自動録音">
          <label className="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              checked={draft.teamsDetectEnabled ?? false}
              onChange={(e) => update({ teamsDetectEnabled: e.target.checked })}
              disabled={!draft.recording.enabled}
            />
            会議/通話を検知したら記録を開始する
            {!draft.recording.enabled && <span className="text-xs text-slate-500 dark:text-slate-400">— 先に録音を有効にしてください</span>}
          </label>
        </Row>
        <Row label="検知時の動作">
          <div className="flex gap-4 text-sm text-slate-700 dark:text-slate-300">
            {([['confirm', '通知をクリックで開始'], ['auto', '自動で即開始']] as const).map(([v, label]) => (
              <label key={v} className="inline-flex items-center gap-1.5">
                <input
                  type="radio"
                  checked={(draft.teamsDetectMode ?? 'confirm') === v}
                  onChange={() => update({ teamsDetectMode: v })}
                />
                {label}
              </label>
            ))}
          </div>
        </Row>
        <Row label="判別できないときの種別">
          <div className="flex gap-4 text-sm text-slate-700 dark:text-slate-300">
            {([['meeting', '会議'], ['call', '通話']] as const).map(([v, label]) => (
              <label key={v} className="inline-flex items-center gap-1.5">
                <input
                  type="radio"
                  checked={(draft.teamsDefaultKind ?? 'meeting') === v}
                  onChange={() => update({ teamsDefaultKind: v })}
                />
                {label}
              </label>
            ))}
          </div>
          <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">種別は記録の編集で後から変更できます</span>
        </Row>
        <Row label="会議と判定する語">
          <input
            value={draft.teamsMeetingKeywords ?? '会議,ミーティング,meeting'}
            onChange={(e) => update({ teamsMeetingKeywords: e.target.value })}
            className={`w-full ${inputClass}`}
            placeholder="会議,ミーティング,meeting"
          />
          <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
            Teams のウィンドウ名にこれらの語が含まれれば「会議」、なければ上の既定の種別として開始します（読点・カンマ区切り）
          </span>
        </Row>
        <Row label="Teams ウィンドウ判定語">
          <input
            value={draft.teamsWindowMatch ?? 'Microsoft Teams'}
            onChange={(e) => update({ teamsWindowMatch: e.target.value })}
            className={`w-full ${inputClass}`}
            placeholder="Microsoft Teams"
          />
          <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
            この文字を含むウィンドウを Teams とみなします（部分一致）。検知されない場合は、下の一覧で実際の
            Teams ウィンドウ名を確認し、共通する語（例: 「Teams」）に変更してください
          </span>
        </Row>
        <Row label="ウィンドウ名を確認">
          <TeamsWindowProbe />
        </Row>
      </section>

      {/* ============ 文字起こし ============ */}
      <section className={sectionClass}>
        <h3 className="mb-1 inline-flex items-center gap-2 text-base font-semibold text-slate-900 dark:text-slate-100"><FileText size={16} className="text-slate-400" />文字起こし (whisper.cpp ローカル)</h3>
        <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
          すべてオフラインで動作します。初回のみ whisper.cpp 本体とモデルのダウンロードが必要です（下のボタンで完結します）。
        </p>
        <WhisperSetup
          gpuUnlocked={gpuUnlocked}
          useGpu={draft.transcription.useGpu ?? false}
          onToggleGpu={(v) => updateTranscription({ useGpu: v })}
        />
        <LiveTranscribeSetup
          recordingEnabled={draft.recording.enabled}
          transcription={draft.transcription}
          onChange={(patch) => updateTranscription(patch)}
        />
        <div className="mt-4 space-y-3">
          <Row label="自動文字起こし">
            <label className="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
              <input
                type="checkbox"
                checked={draft.recording.autoTranscribe}
                onChange={(e) => updateRecording({ autoTranscribe: e.target.checked })}
              />
              録音完了後に自動で文字起こし
            </label>
          </Row>
          <Row label="無音の自動カット">
            <label className="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
              <input
                type="checkbox"
                checked={draft.recording.trimSilence ?? true}
                onChange={(e) => updateRecording({ trimSilence: e.target.checked })}
              />
              録音の前後の無音を自動でカットする
            </label>
            <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">
              録音終了時に先頭・末尾の無音を削除します（マーカー位置も自動で補正）
            </span>
          </Row>
          <Row label="言語">
            <select
              value={draft.transcription.language}
              onChange={(e) => updateTranscription({ language: e.target.value as 'auto' | 'ja' | 'en' })}
              className={`w-40 ${inputClass}`}
            >
              <option value="auto">自動判定</option>
              <option value="ja">日本語</option>
              <option value="en">英語</option>
            </select>
          </Row>
          <Row label="用語ヒント">
            <textarea
              value={draft.transcription.prompt}
              onChange={(e) => updateTranscription({ prompt: e.target.value })}
              rows={2}
              className={`w-full ${inputClass}`}
              placeholder="例: CallStack、山田太郎、御見積、リスケ"
            />
            <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
              社名・人名・専門用語を読点区切りで書くと、whisper（確定版）の固有名詞の認識精度が上がります。
              ※ ライブ文字起こし（Vosk）にはこのヒントは効きません。下の「単語登録」をお使いください
            </span>
          </Row>
          <Row label="単語登録（置換辞書）">
            <TermReplacementEditor
              list={draft.transcription.termReplacements ?? []}
              onChange={(termReplacements) => updateTranscription({ termReplacements })}
            />
            <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
              認識結果の誤変換を「誤り → 正しい語」で自動置換します。<b>ライブ（Vosk）にも whisper の確定版にも適用</b>されます。
              ライブで専門用語が別の語に誤認識されるときは、その誤認識語を左に、正しい語を右に登録してください
              （例: 「コールスタック → CallStack」）
            </span>
          </Row>
        </div>
        <div className="mt-3">
          <div className="mb-2 text-xs font-medium text-slate-600 dark:text-slate-300">モデル</div>
          <ModelManager
            selected={draft.transcription.model}
            onSelect={(m: WhisperModel) => updateTranscription({ model: m })}
            downloaded={draft.transcription.modelDownloaded}
            onDownloaded={(m) => updateTranscription({
              modelDownloaded: { ...draft.transcription.modelDownloaded, [m]: true },
            })}
            onDeleted={(m) => updateTranscription({
              modelDownloaded: { ...draft.transcription.modelDownloaded, [m]: false },
            })}
          />
        </div>
      </section>

      {/* ============ 通知と確認 ============ */}
      <section className={sectionClass}>
        <h3 className="mb-3 inline-flex items-center gap-2 text-base font-semibold text-slate-900 dark:text-slate-100"><Bell size={16} className="text-slate-400" />通知と確認</h3>
        <Row label="長電話アラート（分）">
          <input
            type="number"
            min={0}
            value={draft.longCallAlertMin ?? ''}
            placeholder="無効"
            onChange={(e) => {
              const v = e.target.value === '' ? null : Math.max(0, Number(e.target.value));
              update({ longCallAlertMin: v });
            }}
            className={`w-32 ${inputClass}`}
          />
          <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">空欄で無効化。会議は対象外です</span>
        </Row>
        <Row label="音声フィードバック">
          <label className="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              checked={draft.soundFeedback}
              onChange={(e) => update({ soundFeedback: e.target.checked })}
            />
            開始/終了時にビープ音
          </label>
        </Row>
        <Row label="記録削除時の確認">
          <label className="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              checked={draft.confirmCallDelete}
              onChange={(e) => update({ confirmCallDelete: e.target.checked })}
            />
            削除前に確認モーダルを表示する
          </label>
          <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">
            オフにすると Delete キーや削除ボタンで即削除されます
          </span>
        </Row>
        <Row label="文字起こしクリック巻き戻し">
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              max={10}
              step={0.1}
              value={draft.transcriptSeekOffsetSec}
              onChange={(e) => update({ transcriptSeekOffsetSec: Math.round(Number(e.target.value) * 10) / 10 })}
              className="w-20 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
            />
            <span className="text-sm text-slate-600 dark:text-slate-400">秒前から再生（0 = クリック位置から）</span>
          </div>
        </Row>
      </section>

      {/* ============ データ ============ */}
      <section className={sectionClass}>
        <h3 className="mb-1 inline-flex items-center gap-2 text-base font-semibold text-slate-900 dark:text-slate-100"><Database size={16} className="text-slate-400" />データのバックアップ</h3>
        <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
          全データ (記録 + 設定) を JSON でバックアップ・復元します。録音ファイル本体は含まれません。
        </p>
        <Row label="ファイルの保存先">
          <div className="space-y-2 text-sm text-slate-700 dark:text-slate-300">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                checked={(draft.saveDirMode ?? 'auto') === 'auto'}
                onChange={() => update({ saveDirMode: 'auto' })}
              />
              自動（前回の保存先を記憶して既定にする）
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                checked={draft.saveDirMode === 'fixed'}
                onChange={() => update({ saveDirMode: 'fixed' })}
              />
              自分で決める（常に指定フォルダを既定にする）
            </label>
            {draft.saveDirMode === 'fixed' && (
              <div className="ml-6 flex flex-wrap items-center gap-2">
                <span className="max-w-md truncate rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
                  {draft.fixedSaveDir ?? '（未設定 — ドキュメントフォルダを使用）'}
                </span>
                <button
                  onClick={async () => {
                    const r = await window.api.app.chooseDir('保存先フォルダを選択');
                    if (!r.canceled) update({ fixedSaveDir: r.dir });
                  }}
                  className={ghostBtn}
                >
                  <FolderOpen size={13} className="mr-1 inline align-[-2px]" />フォルダを選択…
                </button>
              </div>
            )}
            <span className="block text-xs text-slate-500 dark:text-slate-400">
              CSV・録音・文字起こし・議事録などの保存ダイアログの既定フォルダに使われます
            </span>
          </div>
        </Row>
        <Row label="バックアップの複製先">
          <div className="flex flex-wrap items-center gap-2">
            <span className="max-w-md truncate rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
              {draft.autoBackupDir ?? '（未設定）'}
            </span>
            <button
              onClick={async () => {
                const r = await window.api.backup.chooseDir();
                if (!r.canceled) update({ autoBackupDir: r.dir });
              }}
              className={ghostBtn}
            >
              <FolderOpen size={13} className="mr-1 inline align-[-2px]" />フォルダを選択…
            </button>
            {draft.autoBackupDir && (
              <button
                onClick={() => update({ autoBackupDir: null })}
                className="text-xs text-slate-500 underline hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
              >
                解除
              </button>
            )}
          </div>
          <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
            日次・手動バックアップをこのフォルダにも複製します。OneDrive / Google Drive のフォルダを指定すれば実質クラウドバックアップになります
          </span>
        </Row>
        <BackupRestoreRow />
      </section>

      {/* ============ バージョン情報 ============ */}
      <section className={sectionClass}>
        <h3 className="mb-3 inline-flex items-center gap-2 text-base font-semibold text-slate-900 dark:text-slate-100"><Info size={16} className="text-slate-400" />バージョン情報</h3>
        <AboutSection
          checkOnStartup={draft.checkUpdatesOnStartup}
          onToggleCheckOnStartup={(v) => update({ checkUpdatesOnStartup: v })}
          autoUpdateEnabled={draft.autoUpdateEnabled ?? false}
          onToggleAutoUpdate={(v) => update({ autoUpdateEnabled: v })}
        />
      </section>

      {showRecordingWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="w-[min(94vw,32rem)] rounded-xl bg-white p-6 shadow-2xl dark:bg-slate-900 dark:text-slate-100">
            <h3 className="mb-2 inline-flex items-center gap-2 text-lg font-bold text-slate-900 dark:text-slate-100"><AlertTriangle size={18} className="text-amber-500" />録音に関する重要な注意</h3>
            <ul className="mb-4 list-disc space-y-1 pl-5 text-sm text-slate-700 dark:text-slate-300">
              <li>通話の録音には<strong>相手の同意が必要</strong>な場合があります（地域・業務上のルールを確認してください）</li>
              <li>録音ファイルはこの PC 内にのみ保存され、外部に送信されません</li>
              <li>機密情報を扱う際は適切なアクセス制御を行ってください</li>
              <li>不要になった録音は速やかに削除するか、保管期限を設定してください</li>
            </ul>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowRecordingWarning(false)}
                className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
              >
                キャンセル
              </button>
              <button
                onClick={() => {
                  updateRecording({ enabled: true });
                  setShowRecordingWarning(false);
                }}
                className="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
              >
                同意して有効化
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AboutSection({
  checkOnStartup,
  onToggleCheckOnStartup,
  autoUpdateEnabled,
  onToggleAutoUpdate,
}: {
  checkOnStartup: boolean;
  onToggleCheckOnStartup: (v: boolean) => void;
  autoUpdateEnabled: boolean;
  onToggleAutoUpdate: (v: boolean) => void;
}) {
  const [info, setInfo] = useState<{ version: string; logPath: string; dataDir: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [updateUrl, setUpdateUrl] = useState<string | null>(null);
  // 自己更新（ダウンロード→検証→展開→適用）の進行状況
  const [selfStatus, setSelfStatus] = useState<{ status: string; version?: string; pct?: number | null; error?: string }>({ status: 'idle' });
  const [applyError, setApplyError] = useState<string | null>(null);

  useEffect(() => {
    window.api.app.info().then(setInfo).catch(() => {});
    // 画面を開き直した場合に、進行中/準備済みの更新状態を復元する
    window.api.update.selfStatus().then((s) => setSelfStatus({ status: s.status, version: s.version ?? undefined })).catch(() => {});
    const off = window.api.onEvent((e: AppEvent) => {
      if (e.type !== 'selfupdate:status') return;
      const pct = e.totalBytes ? Math.round(((e.receivedBytes ?? 0) / e.totalBytes) * 100) : null;
      setSelfStatus({ status: e.status, version: e.version, pct, error: e.error ? toUserMessage(e.error, '更新に失敗しました') : e.error });
    });
    return () => off();
  }, []);

  const check = async () => {
    setChecking(true);
    setResult(null);
    setUpdateUrl(null);
    try {
      const r = await window.api.update.check();
      if (!r.ok) {
        setResult(`更新を確認できませんでした（${toUserMessage(r.error, '不明なエラー')}）。リリースページで直接確認してください。`);
        setUpdateUrl('https://github.com/Yu5rin/CallStack/releases/latest');
      } else if (r.hasUpdate) {
        setResult(`新しいバージョン v${r.latest} が利用できます（現在 v${r.current}）`);
        setUpdateUrl(r.url ?? null);
      } else {
        setResult(`最新です（v${r.current}）`);
      }
    } finally {
      setChecking(false);
    }
  };

  const prepareNow = async () => {
    setApplyError(null);
    setSelfStatus({ status: 'downloading' });
    const r = await window.api.update.prepareNow();
    if (!r.ok) setSelfStatus({ status: 'error', error: toUserMessage(r.error, '更新の準備に失敗しました') });
    else if (!r.hasUpdate) setSelfStatus({ status: 'idle' });
    // hasUpdate=true の場合、以降の進行状況は selfupdate:status イベントで更新される
  };

  const applyNow = async () => {
    setApplyError(null);
    const r = await window.api.update.applyNow();
    if (!r.ok) setApplyError(toUserMessage(r.error, '適用に失敗しました'));
    // 成功時はアプリが終了するため、ここには戻ってこない
  };

  const selfStatusLabel: Record<string, string> = {
    idle: '',
    downloading: 'ダウンロード中…',
    verifying: '検証中…',
    extracting: '展開中…',
    ready: '適用の準備ができました',
    error: 'エラー',
  };

  return (
    <div className="space-y-3">
      <Row label="バージョン">
        <div className="flex items-center gap-3">
          <span className="font-mono text-sm text-slate-800 dark:text-slate-200">
            CallStack v{info?.version ?? '…'}
          </span>
          <button
            onClick={check}
            disabled={checking}
            className="rounded-md border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
          >
            {checking ? '確認中…' : <><RefreshCw size={12} className="mr-1 inline align-[-1px]" />更新を確認</>}
          </button>
          {updateUrl && (
            <button
              onClick={() => void window.api.update.openReleases(updateUrl)}
              className="rounded-md bg-brand-600 px-3 py-1 text-xs font-semibold text-white hover:bg-brand-700"
            >
              ダウンロードページを開く
            </button>
          )}
        </div>
        {result && <div className="mt-1 text-xs text-slate-600 dark:text-slate-400">{result}</div>}
      </Row>
      <Row label="更新の自動確認">
        <label className="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
          <input
            type="checkbox"
            checked={checkOnStartup}
            onChange={(e) => onToggleCheckOnStartup(e.target.checked)}
          />
          起動時に新しいバージョンを確認して通知する
        </label>
      </Row>
      <Row label="自動更新（実験的・Windows限定）">
        <label className="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
          <input
            type="checkbox"
            checked={autoUpdateEnabled}
            disabled={!checkOnStartup}
            onChange={(e) => onToggleAutoUpdate(e.target.checked)}
          />
          新しいバージョンを自動でダウンロード・検証・展開まで済ませる
        </label>
        <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
          OFF の場合は従来どおり通知のみです。ON でも実際にアプリを再起動して適用するのは、
          下のボタンを押すか通知をクリックしたときだけです（記録中は適用されません）。
        </span>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            onClick={prepareNow}
            disabled={selfStatus.status === 'downloading' || selfStatus.status === 'verifying' || selfStatus.status === 'extracting'}
            className="rounded-md border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
          >
            今すぐ更新を確認して準備
          </button>
          {selfStatus.status === 'ready' && (
            <button
              onClick={applyNow}
              className="rounded-md bg-brand-600 px-3 py-1 text-xs font-semibold text-white hover:bg-brand-700"
            >
              v{selfStatus.version} を適用して再起動
            </button>
          )}
          {selfStatus.status !== 'idle' && (
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {selfStatusLabel[selfStatus.status] ?? selfStatus.status}
              {selfStatus.status === 'downloading' && selfStatus.pct != null && ` ${selfStatus.pct}%`}
            </span>
          )}
        </div>
        {selfStatus.status === 'error' && selfStatus.error && (
          <div className="mt-1 text-xs text-red-600 dark:text-red-400">{selfStatus.error}</div>
        )}
        {applyError && <div className="mt-1 text-xs text-red-600 dark:text-red-400">{applyError}</div>}
      </Row>
      <Row label="フォルダ">
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => void window.api.app.openPath('data')}
            className="rounded-md border border-slate-300 bg-white px-3 py-1 text-xs text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
          >
            <FolderOpen size={12} className="mr-1 inline align-[-1px]" />データフォルダを開く
          </button>
          <button
            onClick={() => void window.api.app.openPath('recordings')}
            className="rounded-md border border-slate-300 bg-white px-3 py-1 text-xs text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
          >
            <Mic size={12} className="mr-1 inline align-[-1px]" />録音フォルダを開く
          </button>
          <button
            onClick={() => void window.api.app.openPath('logs')}
            className="rounded-md border border-slate-300 bg-white px-3 py-1 text-xs text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
          >
            <FileText size={12} className="mr-1 inline align-[-1px]" />ログフォルダを開く
          </button>
        </div>
        <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
          不具合報告の際はログフォルダの app.log を添えていただくと調査がスムーズです
        </span>
      </Row>
    </div>
  );
}

function BackupRestoreRow() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const backup = async () => {
    setBusy(true);
    setError(null);
    try {
      const path = await window.api.backup.create();
      setMessage(`バックアップを保存しました: ${path}`);
    } catch (err) {
      setError(toUserMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const restore = async () => {
    if (!window.confirm('JSON ファイルから復元します。現在のデータは復元前に自動バックアップされます。続行しますか？')) return;
    setBusy(true);
    setError(null);
    try {
      const r = await window.api.backup.restore();
      if (r.canceled) {
        setMessage(null);
      } else {
        setMessage(`復元しました (${r.calls} 件)。直前のデータは ${r.backupPath} にあります。`);
      }
    } catch (err) {
      setError(toUserMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <button
          onClick={backup}
          disabled={busy}
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700 disabled:opacity-50"
        >
          今すぐバックアップ
        </button>
        <button
          onClick={restore}
          disabled={busy}
          className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 dark:border-red-700 dark:bg-slate-800 dark:hover:bg-red-950 disabled:opacity-50"
        >
          JSON から復元…
        </button>
      </div>
      {message && (
        <div className="break-all rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300">
          {message}
        </div>
      )}
      {error && (
        <div className="break-all rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}
    </div>
  );
}

function SourceConfigRow({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: RecordingSourceConfig;
  disabled: boolean;
  onChange: (v: RecordingSourceConfig) => void;
}) {
  return (
    <Row label={label}>
      <div className={`flex flex-wrap items-center gap-4 text-sm text-slate-700 dark:text-slate-300 ${disabled ? 'opacity-50' : ''}`}>
        <label className="inline-flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={value.mic}
            onChange={(e) => onChange({ ...value, mic: e.target.checked })}
            disabled={disabled}
          />
          <Mic size={14} className="text-slate-500" /> マイク
        </label>
        <label className="inline-flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={value.system}
            onChange={(e) => onChange({ ...value, system: e.target.checked })}
            disabled={disabled}
          />
          <Volume2 size={14} className="text-slate-500" /> システム音声
        </label>
        {value.system && (
          <span className="inline-flex items-center gap-3 rounded-md bg-slate-100 px-2 py-1 text-xs dark:bg-slate-800">
            <label className="inline-flex items-center gap-1">
              <input
                type="radio"
                checked={value.systemScope === 'screen'}
                onChange={() => onChange({ ...value, systemScope: 'screen' })}
                disabled={disabled}
              />
              画面全体
            </label>
            <label className="inline-flex items-center gap-1">
              <input
                type="radio"
                checked={value.systemScope === 'window'}
                onChange={() => onChange({ ...value, systemScope: 'window' })}
                disabled={disabled}
              />
              ウィンドウ選択（開始時に選ぶ）
            </label>
          </span>
        )}
        {!value.mic && !value.system && (
          <span className="text-xs text-amber-600 dark:text-amber-400">両方 OFF のため録音されません</span>
        )}
      </div>
    </Row>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-start gap-4">
      <div className="w-44 shrink-0 pt-1.5 text-sm text-slate-700 dark:text-slate-300">{label}</div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
