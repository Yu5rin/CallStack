import { ComponentType, ReactNode, useEffect, useRef, useState } from 'react';
import {
  AppEvent, RecordingSourceConfig, Settings, TagDef, ThemePref, WhisperModel,
  VoskLiveModel, VOSK_MODELS, TranscriptionSettings, TermReplacement,
} from '../../shared/types';
import {
  SlidersHorizontal, Mic, FileText, Video, Keyboard, Tag, Database, Info,
  Download, RefreshCw, FolderOpen, CircleCheck, AlertTriangle, Volume2, AudioLines,
  Plus, X, ChevronUp, ChevronDown, Search,
} from 'lucide-react';
import { ShortcutInput } from '../components/ShortcutInput';
import { AudioDeviceSelect } from '../components/AudioDeviceSelect';
import { ModelManager } from '../components/ModelManager';
import { useToast } from '../components/Toast';
import { toUserMessage } from '../utils/errorMessage';
import { Switch } from '../components/settings/Switch';
import { Segmented } from '../components/settings/Segmented';
import { SettingsRow } from '../components/settings/SettingsRow';
import { rowMatches, RowMeta } from '../components/settings/searchUtils';

const inputClass =
  'rounded-md border border-rule bg-surface px-3 py-2 text-sm text-ink';
const ghostBtn =
  'rounded-md border border-rule bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-paper';
const groupClass = 'overflow-hidden rounded-lg border border-rule bg-surface';
const subheadingClass = 'mb-2 mt-6 text-[11px] font-medium uppercase tracking-wide text-ink-mute first:mt-0';

type IconComp = ComponentType<{ size?: number | string; className?: string }>;

interface RowDef extends RowMeta {
  id: string;
  /** 単一のネイティブ input/select/textarea に付けた id（ラベルと htmlFor で結びつける） */
  controlId?: string;
  /** true でコントロールをラベルの下に全幅表示（複雑な UI 向け） */
  full?: boolean;
  render: () => ReactNode;
}
interface GroupDef {
  heading?: string;
  rows: RowDef[];
}
interface CategoryDef {
  id: string;
  title: string;
  icon: IconComp;
  intro?: string;
  groups: GroupDef[];
}

// ============================================================================
// 設定画面をまだマウントしていないタイミング（例: 初回起動オンボーディング直後）でも
// 「文字起こしセットアップへ誘導」の deep link を取りこぼさないよう、モジュール読み込み時点
// （App 起動時、この画面のマウント有無に関係なく）からグローバルにイベントを監視しておく。
// ============================================================================
let pendingDeepLinkCategory: string | null = null;
let activeDeepLinkHandler: ((category: string) => void) | null = null;
if (typeof window !== 'undefined') {
  window.addEventListener('callstack:navigate-settings', () => {
    // 現状の発火元はオンボーディングのみ（文字起こしセットアップへ誘導）
    const category = 'transcription';
    if (activeDeepLinkHandler) activeDeepLinkHandler(category);
    else pendingDeepLinkCategory = category;
  });
}

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
    <div className="rounded-md border border-rule bg-paper p-3">
      <div className="mb-1 flex items-center justify-between">
        <div className="text-xs font-medium text-ink">セットアップ状態</div>
        <button
          onClick={run}
          disabled={checking}
          className="rounded border border-rule bg-surface px-2 py-0.5 text-xs hover:bg-paper disabled:opacity-50"
        >
          再チェック
        </button>
      </div>
      {status === null && <div className="text-xs text-ink-mute">確認中…</div>}
      {status && status.ok && (
        <div className="inline-flex items-center gap-1 text-xs text-ok"><CircleCheck size={13} />文字起こしの準備が整っています。</div>
      )}
      {status && !status.ok && (
        <div className="space-y-2">
          <div className="whitespace-pre-wrap text-xs text-danger">{toUserMessage(status.error, '文字起こしの準備を確認できませんでした')}</div>
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          onClick={() => download('cpu')}
          disabled={downloading !== null}
          className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-on-accent hover:bg-accent/90 disabled:opacity-50"
          title="whisper.cpp の Windows ビルドを GitHub から取得して自動配置します"
        >
          {downloading === 'cpu' ? '取得中…' : <><Download size={12} className="mr-1 inline align-[-1px]" />whisper.cpp をダウンロード</>}
        </button>
        {gpuUnlocked && (
          <button
            onClick={() => download('gpu')}
            disabled={downloading !== null}
            className="rounded-md border border-rule bg-surface px-3 py-1.5 text-xs font-medium text-ink hover:bg-paper disabled:opacity-50"
            title="NVIDIA CUDA 対応ビルド（大容量）。NVIDIA GPU が必要です"
          >
            {downloading === 'gpu' ? '取得中…' : <><Download size={12} className="mr-1 inline align-[-1px]" />GPU (CUDA) 版をダウンロード</>}
          </button>
        )}
        {progress && (
          <span className="text-xs text-ink-mute">
            {progress.step === 'extract'
              ? '展開中…'
              : pct !== null
                ? `ダウンロード中 ${pct}% (${mb(progress.rec)} MB)`
                : `ダウンロード中 ${mb(progress.rec)} MB`}
          </span>
        )}
      </div>
      {gpuUnlocked && (
        <div className="mt-2 flex items-center gap-2 text-xs text-ink">
          <Switch id="swWhisperGpu" checked={useGpu} disabled={!gpuInstalled} onChange={onToggleGpu} />
          <label htmlFor="swWhisperGpu" className="cursor-pointer">GPU (CUDA) 版を使用する</label>
          <span className="text-ink-mute">
            {gpuInstalled ? '— 文字起こしが数倍高速になります（NVIDIA GPU 必須）' : '— 先に GPU 版をダウンロードしてください'}
          </span>
        </div>
      )}
      {progress && pct !== null && progress.step === 'download' && (
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-rule">
          <div className="h-full bg-accent transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}
      {dlError && (
        <div className="mt-2 whitespace-pre-wrap text-xs text-danger">{dlError}</div>
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
    <div className="rounded-md border border-rule bg-paper p-3">
      <div className="mb-1 flex items-center justify-between">
        <div className="inline-flex items-center gap-1.5 text-xs font-medium text-ink">
          <AudioLines size={13} className="text-accent-ink" />
          ライブ文字起こし（実験的 / Vosk）
        </div>
        <button
          onClick={refresh}
          className="rounded border border-rule bg-surface px-2 py-0.5 text-xs hover:bg-paper"
        >
          再チェック
        </button>
      </div>
      <p className="mb-2 text-xs text-ink-mute">
        録音中の音声をその場で認識し、HUD と編集画面に暫定テキストを表示します（オフライン動作）。
        録音終了後は従来どおり whisper が高精度の確定版を生成します。
      </p>
      <div className="flex flex-wrap items-center gap-2 text-sm text-ink">
        <Switch
          id="swLiveEnabled"
          checked={enabled}
          disabled={!recordingEnabled || (!ready && !enabled)}
          onChange={(v) => onChange({ liveEnabled: v })}
        />
        <label htmlFor="swLiveEnabled" className="cursor-pointer">録音中にライブ文字起こしを表示する</label>
        {!recordingEnabled && <span className="text-xs text-ink-mute">— 先に録音を有効にしてください</span>}
        {recordingEnabled && !ready && <span className="text-xs text-ink-mute">— 下のエンジンとモデルの配置が必要です</span>}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className={`inline-flex items-center gap-1 text-xs ${engineOk ? 'text-ok' : 'text-ink-mute'}`}>
          {engineOk ? <CircleCheck size={13} /> : <AlertTriangle size={13} />}
          エンジン (libvosk)
        </span>
        {!engineOk && (
          <button
            onClick={() => download('engine')}
            disabled={downloading !== null}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-on-accent hover:bg-accent/90 disabled:opacity-50"
          >
            {downloading === 'engine' ? '取得中…' : <><Download size={12} className="mr-1 inline align-[-1px]" />エンジンをダウンロード (約7MB)</>}
          </button>
        )}
        {engineOk && (
          <button
            onClick={() => download('engine-legacy')}
            disabled={downloading !== null}
            className="rounded border border-rule bg-surface px-2 py-1 text-xs text-ink-mute hover:bg-paper disabled:opacity-50"
            title="ライブ文字起こしの開始に失敗する（エンジンがクラッシュする）場合、互換性の高い旧バージョン (0.3.42) に入れ替えて試せます"
          >
            {downloading === 'engine-legacy' ? '取得中…' : '動かない場合: 旧バージョン (0.3.42) に入れ替える'}
          </button>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          id="selLiveModel"
          value={model}
          onChange={(e) => onChange({ liveModel: e.target.value as VoskLiveModel })}
          className={`w-64 ${inputClass}`}
          disabled={downloading !== null}
        >
          {VOSK_MODELS.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
        <span className={`inline-flex items-center gap-1 text-xs ${modelOk ? 'text-ok' : 'text-ink-mute'}`}>
          {modelOk ? <><CircleCheck size={13} />配置済み</> : <><AlertTriangle size={13} />未ダウンロード</>}
        </span>
        {!modelOk && (
          <button
            onClick={() => download(model)}
            disabled={downloading !== null}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-on-accent hover:bg-accent/90 disabled:opacity-50"
          >
            {downloading === model ? '取得中…' : <><Download size={12} className="mr-1 inline align-[-1px]" />モデルをダウンロード</>}
          </button>
        )}
      </div>
      {progress && (
        <div className="mt-2 text-xs text-ink-mute">
          {progress.step === 'extract'
            ? '展開中…'
            : pct !== null
              ? `ダウンロード中 ${pct}% (${mb(progress.rec)} MB)`
              : `ダウンロード中 ${mb(progress.rec)} MB`}
        </div>
      )}
      {progress && pct !== null && progress.step === 'download' && (
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-rule">
          <div className="h-full bg-accent transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}
      {dlError && (
        <div className="mt-2 whitespace-pre-wrap text-xs text-danger">{dlError}</div>
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
              <span className="flex-none text-ink-mute">→</span>
              <input
                value={r.to}
                onChange={(e) => setAt(i, { to: e.target.value })}
                placeholder="正しい語"
                className={`min-w-0 flex-1 ${inputClass}`}
              />
              <button
                onClick={() => remove(i)}
                className="flex-none rounded p-1.5 text-ink-mute hover:bg-danger-soft hover:text-danger"
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
        className="inline-flex items-center gap-1 rounded-md border border-rule bg-surface px-2.5 py-1 text-xs font-medium text-ink hover:bg-paper"
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
        <div className="mt-2 max-h-40 overflow-y-auto rounded-md border border-rule bg-paper p-2 text-xs">
          {wins.length === 0 ? (
            <div className="text-ink-mute">ウィンドウが取得できませんでした</div>
          ) : (
            <ul className="space-y-0.5">
              {wins.map((w, i) => (
                <li key={i} className={`truncate ${/teams/i.test(w) ? 'font-medium text-accent-ink' : 'text-ink-mute'}`} title={w}>
                  {w}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-1 text-[11px] text-ink-mute">
            Teams 会議/通話を開いた状態でこのボタンを押すと、その名前が一覧に出ます（青字は「teams」を含む候補）。
            上の「Teams ウィンドウ判定語」を、会議中だけ現れるウィンドウ名に共通する語に合わせてください。
          </div>
        </div>
      )}
    </div>
  );
}

/** データ・録音・ログの各フォルダを開くボタン列 */
function AppFoldersRow() {
  return (
    <div className="w-full">
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => void window.api.app.openPath('data')}
          className="rounded-md border border-rule bg-surface px-3 py-1 text-xs text-ink hover:bg-paper"
        >
          <FolderOpen size={12} className="mr-1 inline align-[-1px]" />データフォルダを開く
        </button>
        <button
          onClick={() => void window.api.app.openPath('recordings')}
          className="rounded-md border border-rule bg-surface px-3 py-1 text-xs text-ink hover:bg-paper"
        >
          <Mic size={12} className="mr-1 inline align-[-1px]" />録音フォルダを開く
        </button>
        <button
          onClick={() => void window.api.app.openPath('logs')}
          className="rounded-md border border-rule bg-surface px-3 py-1 text-xs text-ink hover:bg-paper"
        >
          <FileText size={12} className="mr-1 inline align-[-1px]" />ログフォルダを開く
        </button>
      </div>
      <span className="mt-1 block text-xs text-ink-mute">
        不具合報告の際はログフォルダの app.log を添えていただくと調査がスムーズです
      </span>
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
    <div className="w-full space-y-2">
      <div className="flex gap-2">
        <button
          onClick={backup}
          disabled={busy}
          className="rounded-md border border-rule bg-surface px-3 py-1.5 text-sm hover:bg-paper disabled:opacity-50"
        >
          今すぐバックアップ
        </button>
        <button
          onClick={restore}
          disabled={busy}
          className="rounded-md border border-danger/40 bg-surface px-3 py-1.5 text-sm text-danger hover:bg-danger-soft disabled:opacity-50"
        >
          JSON から復元…
        </button>
      </div>
      {message && (
        <div className="break-all rounded border border-ok/30 bg-ok-soft px-2 py-1 text-xs text-ok">
          {message}
        </div>
      )}
      {error && (
        <div className="break-all rounded border border-danger/30 bg-danger-soft px-2 py-1 text-xs text-danger">
          {error}
        </div>
      )}
    </div>
  );
}

function SourceConfigRow({
  value,
  disabled,
  onChange,
}: {
  value: RecordingSourceConfig;
  disabled: boolean;
  onChange: (v: RecordingSourceConfig) => void;
}) {
  return (
    <div className={`flex w-full flex-wrap items-center gap-4 text-sm text-ink ${disabled ? 'opacity-50' : ''}`}>
      <label className="inline-flex items-center gap-1.5">
        <input
          type="checkbox"
          checked={value.mic}
          onChange={(e) => onChange({ ...value, mic: e.target.checked })}
          disabled={disabled}
        />
        <Mic size={14} className="text-ink-mute" /> マイク
      </label>
      <label className="inline-flex items-center gap-1.5">
        <input
          type="checkbox"
          checked={value.system}
          onChange={(e) => onChange({ ...value, system: e.target.checked })}
          disabled={disabled}
        />
        <Volume2 size={14} className="text-ink-mute" /> システム音声
      </label>
      {value.system && (
        <span className="inline-flex items-center gap-3 rounded-md bg-ink/5 px-2 py-1 text-xs">
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
        <span className="text-xs text-pending">両方 OFF のため録音されません</span>
      )}
    </div>
  );
}

/** バージョン確認・自動更新・通信診断 */
function UpdateVersionSection({
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
  const [checkFailed, setCheckFailed] = useState(false);
  const [latestCheck, setLatestCheck] = useState<{ latest?: string; hasUpdate?: boolean } | null>(null);
  const [sha256Missing, setSha256Missing] = useState(false);
  // 自己更新（ダウンロード→検証→展開→適用）の進行状況
  const [selfStatus, setSelfStatus] = useState<{ status: string; version?: string; pct?: number | null; error?: string }>({ status: 'idle' });
  const [applyError, setApplyError] = useState<string | null>(null);
  const [connChecking, setConnChecking] = useState(false);
  const [connResult, setConnResult] = useState<{ ok: boolean; message: string } | null>(null);

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
    setCheckFailed(false);
    setLatestCheck(null);
    setSha256Missing(false);
    try {
      const r = await window.api.update.check();
      if (!r.ok) {
        setResult(`更新を確認できませんでした（${toUserMessage(r.error, '不明なエラー')}）`);
        setUpdateUrl('https://github.com/Yu5rin/CallStack/releases/latest');
        setCheckFailed(true);
      } else if (r.hasUpdate) {
        setResult(`新しいバージョン v${r.latest} が利用できます（現在 v${r.current}）`);
        setUpdateUrl(r.url ?? null);
        setLatestCheck({ latest: r.latest, hasUpdate: true });
        setSha256Missing(!!r.sha256Missing);
      } else {
        setResult(`最新です（v${r.current}）`);
      }
    } finally {
      setChecking(false);
    }
  };

  const updateNow = async () => {
    setApplyError(null);
    setCheckFailed(false);
    setSelfStatus({ status: 'downloading' });
    const r = await window.api.update.prepareNow();
    if (!r.ok) {
      setSelfStatus({ status: 'error', error: toUserMessage(r.error, '更新の準備に失敗しました') });
      setCheckFailed(true);
      setUpdateUrl('https://github.com/Yu5rin/CallStack/releases/latest');
    } else if (!r.hasUpdate) {
      setSelfStatus({ status: 'idle' });
    }
    // hasUpdate=true の場合、以降の進行状況は selfupdate:status イベントで更新される
  };

  const applyNow = async () => {
    setApplyError(null);
    const r = await window.api.update.applyNow();
    if (!r.ok) {
      setApplyError(toUserMessage(r.error, '適用に失敗しました'));
      setUpdateUrl('https://github.com/Yu5rin/CallStack/releases/latest');
    }
    // 成功時はアプリが終了するため、ここには戻ってこない
  };

  const checkConnection = async () => {
    setConnChecking(true);
    setConnResult(null);
    try {
      const r = await window.api.update.checkConnection();
      setConnResult(r);
    } catch (err) {
      setConnResult({ ok: false, message: toUserMessage(err, '通信の確認に失敗しました') });
    } finally {
      setConnChecking(false);
    }
  };

  const selfStatusLabel: Record<string, string> = {
    idle: '',
    downloading: 'ダウンロード中…',
    verifying: '検証中…',
    extracting: '展開中…',
    ready: '適用の準備ができました',
    error: 'エラー',
  };
  const preparing = selfStatus.status === 'downloading' || selfStatus.status === 'verifying' || selfStatus.status === 'extracting';
  const anyFailed = checkFailed || selfStatus.status === 'error' || !!applyError;

  return (
    <div className="w-full space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-mono text-sm text-ink">
          CallStack v{info?.version ?? '…'}
        </span>
        <button
          onClick={check}
          disabled={checking}
          className="rounded-md border border-rule bg-surface px-3 py-1 text-xs font-medium text-ink hover:bg-paper disabled:opacity-50"
        >
          {checking ? '確認中…' : <><RefreshCw size={12} className="mr-1 inline align-[-1px]" />更新を確認</>}
        </button>
        {latestCheck?.hasUpdate && selfStatus.status !== 'ready' && (
          <button
            onClick={updateNow}
            disabled={preparing}
            className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-on-accent hover:bg-accent/90 disabled:opacity-50"
          >
            今すぐ更新
          </button>
        )}
        {selfStatus.status === 'ready' && (
          <button
            onClick={applyNow}
            className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-on-accent hover:bg-accent/90"
          >
            v{selfStatus.version} を適用して再起動
          </button>
        )}
        {preparing && (
          <span className="text-xs text-ink-mute">
            {selfStatusLabel[selfStatus.status]}
            {selfStatus.status === 'downloading' && selfStatus.pct != null && ` ${selfStatus.pct}%`}
          </span>
        )}
        {anyFailed && updateUrl && (
          <button
            onClick={() => void window.api.update.openReleases(updateUrl)}
            className="rounded-md border border-rule bg-surface px-3 py-1 text-xs text-ink hover:bg-paper"
          >
            リリースページを開く
          </button>
        )}
      </div>
      {result && <div className="text-xs text-ink-mute">{result}</div>}
      {sha256Missing && (
        <div className="text-xs text-pending">
          配布元が混み合っていたため、ダウンロード内容の照合（SHA256）は省いて更新します（HTTPS通信のため転送中の破損は防げます）。
        </div>
      )}
      {selfStatus.status === 'error' && selfStatus.error && (
        <div className="text-xs text-danger">{selfStatus.error}</div>
      )}
      {applyError && <div className="text-xs text-danger">{applyError}</div>}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          onClick={checkConnection}
          disabled={connChecking}
          className="rounded-md border border-rule bg-surface px-3 py-1 text-xs font-medium text-ink hover:bg-paper disabled:opacity-50"
        >
          {connChecking ? '確認中…' : '通信を確かめる'}
        </button>
      </div>
      {connResult && (
        <div className={`text-xs ${connResult.ok ? 'text-ink-mute' : 'text-danger'}`}>
          {connResult.message}
        </div>
      )}
      <p className="text-xs text-ink-mute">
        配布物の置き場まで実際に通信が届くかだけを確かめます（更新はしません）。
        詳しい内訳は「フォルダを開く」のログフォルダの app.log に残ります。会社のネットワークなど、
        同じ回線を多くの人が使う環境では、GitHub への問い合わせが回数の上限に達して
        自動更新が失敗し続けることがあります（README の「自動更新について」参照）。
      </p>

      <div className="flex items-center gap-2 pt-1 text-sm text-ink">
        <Switch id="swCheckOnStartup" checked={checkOnStartup} onChange={onToggleCheckOnStartup} />
        <label htmlFor="swCheckOnStartup" className="cursor-pointer">起動時に新しいバージョンを確認して通知する</label>
      </div>
      <div>
        <div className="flex items-center gap-2 text-sm text-ink">
          <Switch id="swAutoUpdate" checked={autoUpdateEnabled} disabled={!checkOnStartup} onChange={onToggleAutoUpdate} />
          <label htmlFor="swAutoUpdate" className="cursor-pointer">新しい版を見つけたら、ダウンロードまで自動で済ませておく</label>
        </div>
        <p className="mt-1 text-xs text-ink-mute">
          OFF でも「今すぐ更新」自体は変わらず使えます。ON にすると、通知をクリックしたときに
          待たされないよう、ダウンロード・検証・展開までを先に済ませておきます。
          実際にアプリを再起動して適用するのは、通知をクリックするか上のボタンを押したときだけです
          （記録中は適用されません）。
        </p>
      </div>
    </div>
  );
}

const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
const GPU_UNLOCK_KEY = 'callstack.gpuUnlocked';
const LAST_CATEGORY_KEY = 'callstack.settingsLastCategory';

export function SettingsPage({ settings, onSave }: { settings: Settings; onSave: (s: Settings) => Promise<void> }) {
  const toast = useToast();
  const [draft, setDraft] = useState<Settings>(settings);
  const [showRecordingWarning, setShowRecordingWarning] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>(() => {
    try {
      return localStorage.getItem(LAST_CATEGORY_KEY) || 'general';
    } catch {
      return 'general';
    }
  });
  // 保存状態: 「自動で保存されます」⇄「保存しました」⇄ エラー表示
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const savedTimer = useRef<number | null>(null);

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

  // カテゴリ選択を localStorage に記憶（次回開いたとき同じカテゴリを表示）
  useEffect(() => {
    try {
      localStorage.setItem(LAST_CATEGORY_KEY, selectedCategory);
    } catch {
      // プライベートブラウジング等で書き込めない場合は無視
    }
  }, [selectedCategory]);

  // オンボーディング等からの deep link（文字起こしセットアップへ誘導）を受け取る
  useEffect(() => {
    activeDeepLinkHandler = (category) => {
      setSelectedCategory(category);
      setQuery('');
    };
    if (pendingDeepLinkCategory) {
      const c = pendingDeepLinkCategory;
      pendingDeepLinkCategory = null;
      setSelectedCategory(c);
      setQuery('');
    }
    return () => {
      activeDeepLinkHandler = null;
    };
  }, []);

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

  useEffect(() => () => {
    if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
  }, []);

  // Persist the draft as soon as it differs from the latest incoming settings.
  // 200ms debounce keeps text fields (tag names, numbers) from spamming IPC.
  const saveTimer = useRef<number | null>(null);
  const commit = (next: Settings) => {
    setDraft(next);
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      lastIncoming.current = next;
      onSave(next)
        .then(() => {
          setSaveError(null);
          setSaveStatus('saved');
          if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
          savedTimer.current = window.setTimeout(() => setSaveStatus('idle'), 2200);
        })
        .catch((err) => {
          setSaveStatus('error');
          setSaveError(toUserMessage(err, '保存に失敗しました'));
        });
    }, 200);
  };

  const update = (patch: Partial<Settings>) => commit({ ...draftRef.current, ...patch });
  const updateShortcut = (key: keyof Settings['shortcuts'], v: string) =>
    commit({ ...draftRef.current, shortcuts: { ...draftRef.current.shortcuts, [key]: v } });
  const updateRecording = (patch: Partial<Settings['recording']>) =>
    commit({ ...draftRef.current, recording: { ...draftRef.current.recording, ...patch } });
  const updateTranscription = (patch: Partial<Settings['transcription']>) =>
    commit({ ...draftRef.current, transcription: { ...draftRef.current.transcription, ...patch } });

  // タグ名の妥当性（空文字・重複は禁止）。無効な間はディスクへの保存を見送り、表示だけ更新する。
  const tagsValid = (tags: TagDef[]) => {
    const seen = new Set<string>();
    for (const t of tags) {
      const n = t.name.trim().toLowerCase();
      if (!n || seen.has(n)) return false;
      seen.add(n);
    }
    return true;
  };
  const commitTags = (tags: TagDef[]) => {
    const next = { ...draftRef.current, tags };
    if (tagsValid(tags)) commit(next);
    else setDraft(next);
  };
  const updateTag = (idx: number, patch: Partial<TagDef>) => {
    const tags = draftRef.current.tags.slice();
    tags[idx] = { ...tags[idx], ...patch };
    commitTags(tags);
  };
  const removeTag = (idx: number) =>
    commitTags(draftRef.current.tags.filter((_, i) => i !== idx));
  const addTag = () => {
    const base = '新規タグ';
    const existing = new Set(draftRef.current.tags.map((t) => t.name.trim().toLowerCase()));
    let name = base;
    let n = 2;
    while (existing.has(name.toLowerCase())) name = `${base} ${n++}`;
    commitTags([...draftRef.current.tags, { name, color: '#8A9296' }]);
  };
  const moveTag = (idx: number, dir: -1 | 1) => {
    const tags = draftRef.current.tags.slice();
    const j = idx + dir;
    if (j < 0 || j >= tags.length) return;
    [tags[idx], tags[j]] = [tags[j], tags[idx]];
    commitTags(tags);
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

  // ---- テーマ: セグメント（システム/ライト/ダーク）+ ダーク系のときだけ出す標準/黒スウォッチ ----
  const themeSegment: 'system' | 'light' | 'dark' = draft.theme === 'black' ? 'dark' : draft.theme;
  const onThemeSegment = (v: 'system' | 'light' | 'dark') => {
    if (v === 'dark' && (draft.theme === 'dark' || draft.theme === 'black')) return; // 黒を選んでいれば維持
    update({ theme: v });
  };

  // タグ名の重複判定用（各行のインライン警告に使う）
  const tagNameCounts = new Map<string, number>();
  draft.tags.forEach((t) => {
    const key = t.name.trim().toLowerCase();
    tagNameCounts.set(key, (tagNameCounts.get(key) ?? 0) + 1);
  });

  // ==========================================================================
  // カテゴリ定義（すべての設定行をここにマッピングする）
  // ==========================================================================
  const categories: CategoryDef[] = [
    {
      id: 'general',
      title: '一般',
      icon: SlidersHorizontal,
      groups: [
        {
          heading: '外観 / テーマ',
          rows: [
            {
              id: 'theme',
              label: 'テーマ',
              description: 'アプリの配色を選びます',
              keywords: ['外観', 'ダークモード', 'カラー', '黒', 'ハイコントラスト'],
              render: () => (
                <div className="flex flex-col gap-2">
                  <Segmented
                    ariaLabel="テーマ"
                    value={themeSegment}
                    onChange={onThemeSegment}
                    options={[
                      { value: 'system', label: 'システム' },
                      { value: 'light', label: 'ライト' },
                      { value: 'dark', label: 'ダーク' },
                    ]}
                  />
                  {themeSegment === 'dark' && (
                    <div className="flex gap-3">
                      {([['dark', '標準'], ['black', '黒']] as const).map(([v, label]) => (
                        <button
                          key={v}
                          type="button"
                          aria-pressed={draft.theme === v}
                          onClick={() => update({ theme: v as ThemePref })}
                          className={`flex flex-col items-center gap-1 text-[11px] ${draft.theme === v ? 'text-ink' : 'text-ink-mute'}`}
                        >
                          <span
                            className={`h-5 w-5 rounded-full border border-rule ${v === 'black' ? 'bg-black' : 'bg-ink/70'} ${
                              draft.theme === v ? 'ring-2 ring-accent ring-offset-2 ring-offset-paper' : ''
                            }`}
                          />
                          {label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ),
            },
          ],
        },
        {
          heading: '起動',
          rows: [
            {
              id: 'launchAtLogin',
              label: 'Windows ログイン時に起動',
              description: 'サインイン後、自動的にバックグラウンドで起動します',
              keywords: ['起動', 'スタートアップ', '自動起動', 'ログイン'],
              controlId: 'swLaunchAtLogin',
              render: () => (
                <Switch id="swLaunchAtLogin" checked={draft.launchAtLogin} onChange={(v) => update({ launchAtLogin: v })} />
              ),
            },
          ],
        },
        {
          heading: 'ウィンドウと小窓（HUD）の設定',
          rows: [
            {
              id: 'minimizeToTray',
              label: '閉じるボタンで最小化してトレイに常駐',
              description: 'ウィンドウを閉じても記録・文字起こしはバックグラウンドで継続します',
              keywords: ['トレイ', '常駐', '最小化', 'タスクバー'],
              render: () => (
                <Segmented
                  ariaLabel="最小化の動作"
                  value={draft.minimizeToTray ? 'tray' : 'taskbar'}
                  onChange={(v) => update({ minimizeToTray: v === 'tray' })}
                  options={[
                    { value: 'taskbar', label: 'タスクバー' },
                    { value: 'tray', label: 'トレイに格納' },
                  ]}
                />
              ),
            },
            {
              id: 'hudSize',
              label: '小窓（HUD）のサイズ',
              description: 'HUD 右上のアイコンでもサイズを循環できます',
              keywords: ['HUD', '小窓', 'サイズ'],
              render: () => (
                <Segmented
                  ariaLabel="HUD のサイズ"
                  value={draft.hudSize}
                  onChange={(v) => update({ hudSize: v })}
                  options={[
                    { value: 'mini', label: 'ミニ (240×34)' },
                    { value: 'compact', label: 'コンパクト (400×70)' },
                    { value: 'full', label: 'フル (470×122)' },
                  ]}
                />
              ),
            },
            {
              id: 'hudOpacity',
              label: '小窓（HUD）の透明度',
              description: 'カーソルを HUD に乗せている間は自動的に不透明になります',
              keywords: ['HUD', '透明度', '不透明度'],
              controlId: 'rangeHudOpacity',
              render: () => (
                <div className="flex items-center gap-3">
                  <input
                    id="rangeHudOpacity"
                    type="range"
                    min={30}
                    max={100}
                    step={5}
                    value={Math.round((draft.hudOpacity ?? 1) * 100)}
                    onChange={(e) => update({ hudOpacity: Number(e.target.value) / 100 })}
                    className="w-40 accent-accent"
                  />
                  <span className="w-12 text-right font-mono text-sm tabular-nums text-ink">
                    {Math.round((draft.hudOpacity ?? 1) * 100)}%
                  </span>
                </div>
              ),
            },
            {
              id: 'hudLiveVisible',
              label: 'ライブ字幕ウィンドウを表示する',
              description: '録音中のライブ文字起こしを独立したウィンドウに表示します。自由に移動・リサイズでき、HUD の「字幕」ボタンやウィンドウの × でも表示 ON/OFF できます',
              keywords: ['字幕', 'ライブ文字起こし', 'HUD'],
              controlId: 'swHudLiveVisible',
              render: () => (
                <Switch id="swHudLiveVisible" checked={draft.hudLiveVisible ?? true} onChange={(v) => update({ hudLiveVisible: v })} />
              ),
            },
            {
              id: 'liveFontSize',
              label: 'ライブ字幕の文字サイズ',
              description: 'ライブ字幕ウィンドウ上でも切り替えられます',
              keywords: ['字幕', '文字サイズ', 'フォント'],
              render: () => (
                <Segmented
                  ariaLabel="ライブ字幕の文字サイズ"
                  value={draft.liveFontSize ?? 'sm'}
                  onChange={(v) => update({ liveFontSize: v })}
                  options={[
                    { value: 'sm', label: '小' },
                    { value: 'md', label: '中' },
                    { value: 'lg', label: '大' },
                  ]}
                />
              ),
            },
          ],
        },
        {
          heading: '通知と確認',
          rows: [
            {
              id: 'longCallAlertMin',
              label: '長電話アラート（分）',
              description: '空欄で無効化。会議は対象外です',
              keywords: ['通知', 'アラート', '長電話'],
              controlId: 'numLongCallAlert',
              render: () => (
                <input
                  id="numLongCallAlert"
                  type="number"
                  min={0}
                  value={draft.longCallAlertMin ?? ''}
                  placeholder="無効"
                  onChange={(e) => {
                    const v = e.target.value === '' ? null : Math.max(0, Number(e.target.value));
                    update({ longCallAlertMin: v });
                  }}
                  className={`w-28 ${inputClass}`}
                />
              ),
            },
            {
              id: 'soundFeedback',
              label: '音声フィードバック',
              description: '開始/終了時にビープ音',
              keywords: ['通知', 'サウンド', 'ビープ'],
              controlId: 'swSoundFeedback',
              render: () => <Switch id="swSoundFeedback" checked={draft.soundFeedback} onChange={(v) => update({ soundFeedback: v })} />,
            },
            {
              id: 'confirmCallDelete',
              label: '記録削除時の確認',
              description: 'オフにすると Delete キーや削除ボタンで即削除されます',
              keywords: ['確認', '削除', 'ダイアログ'],
              controlId: 'swConfirmCallDelete',
              render: () => <Switch id="swConfirmCallDelete" checked={draft.confirmCallDelete} onChange={(v) => update({ confirmCallDelete: v })} />,
            },
            {
              id: 'transcriptSeekOffsetSec',
              label: '文字起こしクリック巻き戻し',
              description: '秒前から再生（0 = クリック位置から）',
              keywords: ['文字起こし', '再生', '巻き戻し'],
              controlId: 'numSeekOffset',
              render: () => (
                <input
                  id="numSeekOffset"
                  type="number"
                  min={0}
                  max={10}
                  step={0.1}
                  value={draft.transcriptSeekOffsetSec}
                  onChange={(e) => update({ transcriptSeekOffsetSec: Math.round(Number(e.target.value) * 10) / 10 })}
                  className={`w-20 ${inputClass}`}
                />
              ),
            },
          ],
        },
      ],
    },
    {
      id: 'recording',
      title: '記録と録音',
      icon: Mic,
      groups: [
        {
          rows: [
            {
              id: 'recordingEnabled',
              label: '通話と同時に録音',
              description: '録音を有効にする',
              keywords: ['録音', '同意'],
              controlId: 'swRecordingEnabled',
              render: () => <Switch id="swRecordingEnabled" checked={draft.recording.enabled} onChange={handleToggleRecording} />,
            },
            {
              id: 'callSource',
              label: '通話の録音ソース',
              keywords: ['録音ソース', 'マイク', 'システム音声'],
              full: true,
              render: () => (
                <SourceConfigRow
                  value={draft.recording.callSource}
                  disabled={!draft.recording.enabled}
                  onChange={(v) => updateRecording({ callSource: v })}
                />
              ),
            },
            {
              id: 'meetingSource',
              label: '会議の録音ソース',
              keywords: ['録音ソース', 'マイク', 'システム音声', '会議'],
              full: true,
              render: () => (
                <SourceConfigRow
                  value={draft.recording.meetingSource}
                  disabled={!draft.recording.enabled}
                  onChange={(v) => updateRecording({ meetingSource: v })}
                />
              ),
            },
            {
              id: 'askSourceOnStart',
              label: '開始ダイアログ',
              description: '「▶ 開始」ボタンで通話/会議・録音ソースの選択ダイアログを表示する。オフにするとボタンは前回の種別で即開始します。ショートカット・トレイからは常に既定ソースで即開始です',
              keywords: ['開始ダイアログ', '録音ソース'],
              controlId: 'swAskSourceOnStart',
              render: () => (
                <Switch id="swAskSourceOnStart" checked={draft.recording.askSourceOnStart} onChange={(v) => updateRecording({ askSourceOnStart: v })} />
              ),
            },
            {
              id: 'micDeviceId',
              label: 'マイクデバイス',
              keywords: ['マイク', 'デバイス', '入力'],
              render: () => (
                <AudioDeviceSelect value={draft.recording.micDeviceId} onChange={(id) => updateRecording({ micDeviceId: id })} />
              ),
            },
            {
              id: 'mp3Bitrate',
              label: 'MP3 ビットレート',
              description: '96kbps で約 700KB/分',
              keywords: ['ビットレート', '音質', 'MP3'],
              render: () => (
                <Segmented
                  ariaLabel="MP3 ビットレート"
                  value={String(draft.recording.mp3Bitrate)}
                  onChange={(v) => updateRecording({ mp3Bitrate: Number(v) as 64 | 96 | 128 | 192 })}
                  disabled={!draft.recording.enabled}
                  options={[64, 96, 128, 192].map((b) => ({ value: String(b), label: `${b}kbps` }))}
                />
              ),
            },
            {
              id: 'retentionDays',
              label: '録音の保管期限（日）',
              description: '空欄で無制限。期限切れの音声のみ削除（記録は残ります）',
              keywords: ['保管期限', '自動削除'],
              controlId: 'numRetentionDays',
              render: () => (
                <input
                  id="numRetentionDays"
                  type="number"
                  min={0}
                  value={draft.recording.retentionDays ?? ''}
                  placeholder="無制限"
                  onChange={(e) => {
                    const v = e.target.value === '' ? null : Math.max(0, Number(e.target.value));
                    updateRecording({ retentionDays: v });
                  }}
                  className={`w-28 ${inputClass}`}
                  disabled={!draft.recording.enabled}
                />
              ),
            },
            {
              id: 'confirmRecordingEnable',
              label: '有効化時の同意確認',
              description: '録音を有効化する時に確認モーダルを表示する',
              keywords: ['同意', '確認', '録音'],
              controlId: 'swConfirmRecordingEnable',
              render: () => (
                <Switch id="swConfirmRecordingEnable" checked={draft.confirmRecordingEnable} onChange={(v) => update({ confirmRecordingEnable: v })} />
              ),
            },
          ],
        },
      ],
    },
    {
      id: 'transcription',
      title: '文字起こし',
      icon: FileText,
      intro: 'すべてオフラインで動作します。初回のみ whisper.cpp 本体とモデルのダウンロードが必要です。',
      groups: [
        {
          heading: 'whisper.cpp（確定版の文字起こしエンジン）',
          rows: [
            {
              id: 'whisperSetup',
              label: 'whisper.cpp のセットアップ',
              description: '実行ファイルのダウンロードと GPU (CUDA) 版の利用可否',
              keywords: ['whisper', 'エンジン', 'GPU', 'CUDA', 'NVIDIA', 'ダウンロード'],
              full: true,
              render: () => (
                <WhisperSetup
                  gpuUnlocked={gpuUnlocked}
                  useGpu={draft.transcription.useGpu ?? false}
                  onToggleGpu={(v) => updateTranscription({ useGpu: v })}
                />
              ),
            },
            {
              id: 'autoTranscribe',
              label: '自動文字起こし',
              description: '録音完了後に自動で文字起こし',
              keywords: ['自動', '文字起こし'],
              controlId: 'swAutoTranscribe',
              render: () => (
                <Switch id="swAutoTranscribe" checked={draft.recording.autoTranscribe} onChange={(v) => updateRecording({ autoTranscribe: v })} />
              ),
            },
            {
              id: 'trimSilence',
              label: '無音の自動カット',
              description: '録音終了時に先頭・末尾の無音を削除します（マーカー位置も自動で補正）',
              keywords: ['無音', 'カット', 'トリム'],
              controlId: 'swTrimSilence',
              render: () => (
                <Switch id="swTrimSilence" checked={draft.recording.trimSilence ?? true} onChange={(v) => updateRecording({ trimSilence: v })} />
              ),
            },
            {
              id: 'language',
              label: '言語',
              keywords: ['言語', '日本語', '英語'],
              render: () => (
                <Segmented
                  ariaLabel="文字起こしの言語"
                  value={draft.transcription.language}
                  onChange={(v) => updateTranscription({ language: v })}
                  options={[
                    { value: 'auto', label: '自動判定' },
                    { value: 'ja', label: '日本語' },
                    { value: 'en', label: '英語' },
                  ]}
                />
              ),
            },
          ],
        },
        {
          heading: 'ライブ文字起こし（実験的 / Vosk）',
          rows: [
            {
              id: 'liveTranscribe',
              label: 'ライブ文字起こしの設定',
              description: '録音中に暫定テキストを HUD・編集画面へ表示するための engine/model の準備',
              keywords: ['ライブ文字起こし', 'vosk', 'モデル'],
              full: true,
              render: () => (
                <LiveTranscribeSetup
                  recordingEnabled={draft.recording.enabled}
                  transcription={draft.transcription}
                  onChange={(patch) => updateTranscription(patch)}
                />
              ),
            },
          ],
        },
        {
          heading: '用語ヒントと単語登録',
          rows: [
            {
              id: 'transcriptionPrompt',
              label: '用語ヒント',
              description: '社名・人名・専門用語を読点区切りで書くと、whisper（確定版）の固有名詞の認識精度が上がります。※ ライブ文字起こし（Vosk）にはこのヒントは効きません。下の「単語登録」をお使いください',
              keywords: ['用語ヒント', 'プロンプト', '固有名詞'],
              full: true,
              controlId: 'taPrompt',
              render: () => (
                <textarea
                  id="taPrompt"
                  value={draft.transcription.prompt}
                  onChange={(e) => updateTranscription({ prompt: e.target.value })}
                  rows={2}
                  className={`w-full ${inputClass}`}
                  placeholder="例: CallStack、山田太郎、御見積、リスケ"
                />
              ),
            },
            {
              id: 'termReplacements',
              label: '単語登録（置換辞書）',
              description: '認識結果の誤変換を「誤り → 正しい語」で自動置換します。ライブ（Vosk）にも whisper の確定版にも適用されます。ライブで専門用語が別の語に誤認識されるときは、その誤認識語を左に、正しい語を右に登録してください（例: 「コールスタック → CallStack」）',
              keywords: ['単語登録', '置換辞書', '誤変換'],
              full: true,
              render: () => (
                <TermReplacementEditor
                  list={draft.transcription.termReplacements ?? []}
                  onChange={(termReplacements) => updateTranscription({ termReplacements })}
                />
              ),
            },
          ],
        },
        {
          heading: 'モデル',
          rows: [
            {
              id: 'whisperModel',
              label: 'whisper モデル',
              description: '精度と速度のバランスをモデルごとに選べます',
              keywords: ['モデル', 'whisper', 'ダウンロード', '精度'],
              full: true,
              render: () => (
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
              ),
            },
          ],
        },
      ],
    },
    {
      id: 'teams',
      title: 'Teams 連携',
      icon: Video,
      intro: 'Microsoft Teams の会議/通話ウィンドウを監視して自動で記録・録音を開始します（完全オフライン・サインイン不要）。Teams のバージョンや表示言語によってはウィンドウ名の書式が異なり、検知精度が変わる場合があります。録音を有効にしてご利用ください。',
      groups: [
        {
          rows: [
            {
              id: 'teamsDetectEnabled',
              label: 'Teams を検知して自動録音',
              description: '会議/通話を検知したら記録を開始する',
              keywords: ['teams', '検知', '自動録音'],
              controlId: 'swTeamsDetect',
              render: () => (
                <div className="flex items-center gap-2">
                  <Switch
                    id="swTeamsDetect"
                    checked={draft.teamsDetectEnabled ?? false}
                    disabled={!draft.recording.enabled}
                    onChange={(v) => update({ teamsDetectEnabled: v })}
                  />
                  {!draft.recording.enabled && <span className="text-xs text-ink-mute">先に録音を有効にしてください</span>}
                </div>
              ),
            },
            {
              id: 'teamsDetectMode',
              label: '検知時の動作',
              keywords: ['teams', '検知', '自動開始'],
              render: () => (
                <Segmented
                  ariaLabel="検知時の動作"
                  value={draft.teamsDetectMode ?? 'confirm'}
                  onChange={(v) => update({ teamsDetectMode: v })}
                  options={[
                    { value: 'confirm', label: '通知をクリックで開始' },
                    { value: 'auto', label: '自動で即開始' },
                  ]}
                />
              ),
            },
            {
              id: 'teamsDefaultKind',
              label: '判別できないときの種別',
              description: '種別は記録の編集で後から変更できます',
              keywords: ['teams', '会議', '通話'],
              render: () => (
                <Segmented
                  ariaLabel="判別できないときの種別"
                  value={draft.teamsDefaultKind ?? 'meeting'}
                  onChange={(v) => update({ teamsDefaultKind: v })}
                  options={[
                    { value: 'meeting', label: '会議' },
                    { value: 'call', label: '通話' },
                  ]}
                />
              ),
            },
            {
              id: 'teamsMeetingKeywords',
              label: '会議と判定する語',
              description: 'Teams のウィンドウ名にこれらの語が含まれれば「会議」、なければ上の既定の種別として開始します（読点・カンマ区切り）',
              keywords: ['teams', '会議', '判定語'],
              full: true,
              controlId: 'inpTeamsMeetingKeywords',
              render: () => (
                <input
                  id="inpTeamsMeetingKeywords"
                  value={draft.teamsMeetingKeywords ?? '会議,ミーティング,meeting'}
                  onChange={(e) => update({ teamsMeetingKeywords: e.target.value })}
                  className={`w-full ${inputClass}`}
                  placeholder="会議,ミーティング,meeting"
                />
              ),
            },
            {
              id: 'teamsWindowMatch',
              label: 'Teams ウィンドウ判定語',
              description: 'この文字を含むウィンドウを Teams とみなします（部分一致）。検知されない場合は、下の一覧で実際の Teams ウィンドウ名を確認し、共通する語（例: 「Teams」）に変更してください',
              keywords: ['teams', 'ウィンドウ', '判定語'],
              full: true,
              controlId: 'inpTeamsWindowMatch',
              render: () => (
                <input
                  id="inpTeamsWindowMatch"
                  value={draft.teamsWindowMatch ?? 'Microsoft Teams'}
                  onChange={(e) => update({ teamsWindowMatch: e.target.value })}
                  className={`w-full ${inputClass}`}
                  placeholder="Microsoft Teams"
                />
              ),
            },
            {
              id: 'teamsWindowProbe',
              label: 'ウィンドウ名を確認',
              keywords: ['teams', 'ウィンドウ', '診断'],
              full: true,
              render: () => <TeamsWindowProbe />,
            },
          ],
        },
      ],
    },
    {
      id: 'shortcuts',
      title: 'ショートカット',
      icon: Keyboard,
      intro: 'システム全体で有効。フォーカス中の入力欄にキーを押すと記録できます。',
      groups: [
        {
          rows: [
            { id: 'sc-startCall', label: '通話を開始', keywords: ['ショートカット', '開始'], render: () => <ShortcutInput value={draft.shortcuts.startCall} onChange={(v) => updateShortcut('startCall', v)} /> },
            { id: 'sc-startMeeting', label: '会議を開始', keywords: ['ショートカット', '開始'], render: () => <ShortcutInput value={draft.shortcuts.startMeeting} onChange={(v) => updateShortcut('startMeeting', v)} /> },
            { id: 'sc-endCall', label: '通話/会議を終了', keywords: ['ショートカット', '終了'], render: () => <ShortcutInput value={draft.shortcuts.endCall} onChange={(v) => updateShortcut('endCall', v)} /> },
            { id: 'sc-toggleHold', label: '保留トグル', keywords: ['ショートカット', '保留'], render: () => <ShortcutInput value={draft.shortcuts.toggleHold} onChange={(v) => updateShortcut('toggleHold', v)} /> },
            { id: 'sc-togglePauseRecording', label: '録音の一時停止/再開', keywords: ['ショートカット', '録音', '一時停止'], render: () => <ShortcutInput value={draft.shortcuts.togglePauseRecording} onChange={(v) => updateShortcut('togglePauseRecording', v)} /> },
            { id: 'sc-addMarker', label: 'マーカーを打つ', keywords: ['ショートカット', 'マーカー'], render: () => <ShortcutInput value={draft.shortcuts.addMarker} onChange={(v) => updateShortcut('addMarker', v)} /> },
            { id: 'sc-toggleWindow', label: 'メインウィンドウを表示/隠す', keywords: ['ショートカット', 'ウィンドウ'], render: () => <ShortcutInput value={draft.shortcuts.toggleWindow} onChange={(v) => updateShortcut('toggleWindow', v)} /> },
            { id: 'sc-openSettings', label: '設定画面を開く', keywords: ['ショートカット', '設定'], render: () => <ShortcutInput value={draft.shortcuts.openSettings} onChange={(v) => updateShortcut('openSettings', v)} /> },
            ...([1, 2, 3, 4] as const).map((n) => {
              const key = `assignTag${n}` as const;
              const tagName = draft.tags[n - 1]?.name ?? '(未設定)';
              const row: RowDef = {
                id: `sc-${key}`,
                label: `クイックタグ ${n} (${tagName})`,
                keywords: ['ショートカット', 'タグ', 'クイックタグ'],
                render: () => <ShortcutInput value={draft.shortcuts[key]} onChange={(v) => updateShortcut(key, v)} />,
              };
              return row;
            }),
          ],
        },
      ],
    },
    {
      id: 'tags',
      title: 'タグ',
      icon: Tag,
      groups: [
        {
          rows: [
            {
              id: 'tagEditor',
              label: 'タグの管理',
              description: '▲▼ で並び替えできます。記録には複数のタグを付けられます（記録の編集・HUD の「情報」から選択）。上位4つはクイックタグ（Ctrl+Shift+1〜4）に割り当てられます。',
              keywords: ['タグ', '色分け', 'クイックタグ', 'ラベル'],
              full: true,
              render: () => (
                <div className="w-full">
                  <div className="mb-2 flex justify-end">
                    <button onClick={addTag} className={ghostBtn}>＋ タグを追加</button>
                  </div>
                  <div className="space-y-2">
                    {draft.tags.map((t, i) => {
                      const trimmed = t.name.trim();
                      const isEmpty = trimmed.length === 0;
                      const isDup = !isEmpty && (tagNameCounts.get(trimmed.toLowerCase()) ?? 0) > 1;
                      const err = isEmpty ? 'タグ名を入力してください' : isDup ? '同じ名前のタグが既にあります' : null;
                      return (
                        <div key={i} className="flex items-start gap-3">
                          <input
                            type="color"
                            value={t.color}
                            onChange={(e) => updateTag(i, { color: e.target.value })}
                            className="mt-0.5 h-9 w-9 flex-none cursor-pointer rounded border border-rule"
                            aria-label={`タグ${i + 1}の色`}
                          />
                          <div className="min-w-0 flex-1">
                            <input
                              value={t.name}
                              onChange={(e) => updateTag(i, { name: e.target.value })}
                              onBlur={() => {
                                const v = t.name.trim();
                                if (v !== t.name) updateTag(i, { name: v });
                              }}
                              aria-invalid={!!err}
                              className={`w-full ${inputClass} ${err ? 'border-danger' : ''}`}
                            />
                            {err && <div className="mt-1 text-xs text-danger">{err}</div>}
                          </div>
                          <div className="flex flex-none items-center">
                            <button
                              onClick={() => moveTag(i, -1)}
                              disabled={i === 0}
                              className="rounded p-1 text-ink-mute hover:bg-paper disabled:opacity-30"
                              title="上へ"
                            >
                              <ChevronUp size={16} />
                            </button>
                            <button
                              onClick={() => moveTag(i, 1)}
                              disabled={i === draft.tags.length - 1}
                              className="rounded p-1 text-ink-mute hover:bg-paper disabled:opacity-30"
                              title="下へ"
                            >
                              <ChevronDown size={16} />
                            </button>
                          </div>
                          <button
                            onClick={() => removeTag(i)}
                            className="flex-none rounded-md border border-danger/40 bg-surface px-2 py-1.5 text-xs text-danger hover:bg-danger-soft"
                          >
                            削除
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ),
            },
          ],
        },
      ],
    },
    {
      id: 'data',
      title: 'データとバックアップ',
      icon: Database,
      intro: '全データ (記録 + 設定) を JSON でバックアップ・復元します。録音ファイル本体は含まれません。',
      groups: [
        {
          rows: [
            {
              id: 'saveDir',
              label: 'ファイルの保存先',
              description: 'CSV・録音・文字起こし・議事録などの保存ダイアログの既定フォルダに使われます',
              keywords: ['保存先', 'フォルダ'],
              full: true,
              render: () => (
                <div className="space-y-2 text-sm text-ink">
                  <label className="flex items-center gap-2">
                    <input type="radio" checked={(draft.saveDirMode ?? 'auto') === 'auto'} onChange={() => update({ saveDirMode: 'auto' })} />
                    自動（前回の保存先を記憶して既定にする）
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="radio" checked={draft.saveDirMode === 'fixed'} onChange={() => update({ saveDirMode: 'fixed' })} />
                    自分で決める（常に指定フォルダを既定にする）
                  </label>
                  {draft.saveDirMode === 'fixed' && (
                    <div className="ml-6 flex flex-wrap items-center gap-2">
                      <span className="max-w-md truncate rounded-md border border-rule bg-paper px-2 py-1 text-xs text-ink-mute">
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
                </div>
              ),
            },
            {
              id: 'autoBackupDir',
              label: 'バックアップの複製先',
              description: '日次・手動バックアップをこのフォルダにも複製します。OneDrive / Google Drive のフォルダを指定すれば実質クラウドバックアップになります',
              keywords: ['複製先', 'バックアップ', 'クラウド', 'OneDrive', 'Google Drive'],
              full: true,
              render: () => (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="max-w-md truncate rounded-md border border-rule bg-paper px-2 py-1 text-xs text-ink-mute">
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
                    <button onClick={() => update({ autoBackupDir: null })} className="text-xs text-ink-mute underline hover:text-ink">
                      解除
                    </button>
                  )}
                </div>
              ),
            },
            {
              id: 'backupRestore',
              label: 'バックアップと復元',
              description: '手動でバックアップを作成、または JSON ファイルから復元します',
              keywords: ['バックアップ', '復元', 'JSON', '書き出す', '取り込む'],
              full: true,
              render: () => <BackupRestoreRow />,
            },
            {
              id: 'appFolders',
              label: 'フォルダを開く',
              keywords: ['フォルダ', 'ログ', '録音', 'データ'],
              full: true,
              render: () => <AppFoldersRow />,
            },
          ],
        },
      ],
    },
    {
      id: 'update',
      title: '更新とバージョン',
      icon: Info,
      groups: [
        {
          rows: [
            {
              id: 'updateVersion',
              label: 'バージョン情報と更新',
              description: '更新の確認・自動更新の設定・通信の診断',
              keywords: ['更新', 'バージョン', '通信を確かめる', 'アップデート'],
              full: true,
              render: () => (
                <UpdateVersionSection
                  checkOnStartup={draft.checkUpdatesOnStartup}
                  onToggleCheckOnStartup={(v) => update({ checkUpdatesOnStartup: v })}
                  autoUpdateEnabled={draft.autoUpdateEnabled ?? false}
                  onToggleAutoUpdate={(v) => update({ autoUpdateEnabled: v })}
                />
              ),
            },
          ],
        },
      ],
    },
  ];

  const trimmedQuery = query.trim();
  const searching = trimmedQuery.length > 0;
  const counts: Record<string, number> = {};
  categories.forEach((c) => {
    counts[c.id] = c.groups.reduce((sum, g) => sum + g.rows.filter((r) => rowMatches(r, trimmedQuery)).length, 0);
  });
  const totalMatches = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <div className="flex h-full min-h-0">
      {/* ============ 左ナビ: 検索 + カテゴリ一覧 ============ */}
      <aside className="flex w-[200px] flex-none flex-col gap-3 overflow-y-auto border-r border-rule bg-surface p-3">
        <div className="relative">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-mute" />
          <input
            id="settingsSearch"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                setQuery('');
              }
            }}
            placeholder="設定を検索"
            aria-label="設定を検索"
            className="w-full rounded-md border border-rule bg-paper py-1.5 pl-7 pr-2 text-xs text-ink placeholder:text-ink-mute focus-visible:border-accent focus:outline-none"
          />
        </div>
        <ul className="flex flex-col gap-0.5">
          {categories.map((c) => {
            const Icon = c.icon;
            const count = searching ? counts[c.id] : null;
            return (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedCategory(c.id);
                    setQuery('');
                  }}
                  aria-current={!searching && selectedCategory === c.id ? 'page' : undefined}
                  className={`flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors ${
                    !searching && selectedCategory === c.id
                      ? 'bg-accent-soft font-medium text-accent-ink'
                      : 'text-ink-mute hover:bg-paper hover:text-ink'
                  }`}
                >
                  <span className="inline-flex min-w-0 items-center gap-2 truncate">
                    <Icon size={14} className="shrink-0" />
                    <span className="truncate">{c.title}</span>
                  </span>
                  {count !== null && count > 0 && (
                    <span className="flex-none rounded-full bg-accent px-1.5 py-0.5 font-mono text-[10px] leading-none text-on-accent">
                      {count}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      {/* ============ 右コンテンツ: 選択中カテゴリ or 検索結果 ============ */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex flex-none flex-wrap items-center justify-between gap-3 border-b border-rule px-6 py-3">
          <div className="text-sm text-ink-mute">
            {searching ? `「${trimmedQuery}」の検索結果${totalMatches > 0 ? `（${totalMatches} 件）` : ''}` : ''}
          </div>
          <div className="flex items-center gap-1.5 text-xs">
            {saveStatus === 'error' ? (
              <span className="inline-flex items-center gap-1.5 text-danger" role="status">
                <AlertTriangle size={13} />{saveError}
              </span>
            ) : saveStatus === 'saved' ? (
              <span className="inline-flex items-center gap-1.5 text-ok" role="status">
                <CircleCheck size={13} />保存しました
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-ink-mute">
                <CircleCheck size={13} className="text-accent-ink" />変更は自動で保存されます
              </span>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {searching && totalMatches === 0 ? (
            <div className="py-12 text-center text-sm text-ink-mute">一致する設定はありません</div>
          ) : (
            <div className="space-y-8">
              {categories.map((c) => {
                const isActive = !searching && selectedCategory === c.id;
                if (!searching && !isActive) return null;
                const groups = c.groups
                  .map((g) => ({ heading: g.heading, rows: g.rows.filter((r) => rowMatches(r, trimmedQuery)) }))
                  .filter((g) => g.rows.length > 0);
                if (groups.length === 0) return null;
                const Icon = c.icon;
                return (
                  <section key={c.id}>
                    <h2 className="mb-1 inline-flex items-center gap-2 text-base font-medium text-ink">
                      <Icon size={16} className="text-ink-mute" />{c.title}
                    </h2>
                    {!searching && c.intro && (
                      <p className="mb-4 mt-1 text-xs text-ink-mute">{c.intro}</p>
                    )}
                    <div className="mt-3 space-y-4">
                      {groups.map((g, gi) => (
                        <div key={g.heading ?? gi}>
                          {g.heading && <div className={subheadingClass}>{g.heading}</div>}
                          <div className={groupClass}>
                            {g.rows.map((r) => (
                              <SettingsRow
                                key={r.id}
                                id={r.id}
                                label={r.label}
                                description={r.description}
                                controlId={r.controlId}
                                full={r.full}
                                query={searching ? trimmedQuery : undefined}
                              >
                                {r.render()}
                              </SettingsRow>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {showRecordingWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4">
          <div className="w-[min(94vw,32rem)] rounded-lg bg-surface p-6 shadow-lg">
            <h3 className="mb-2 inline-flex items-center gap-2 text-lg font-medium text-ink"><AlertTriangle size={18} className="text-pending" />録音に関する重要な注意</h3>
            <ul className="mb-4 list-disc space-y-1 pl-5 text-sm text-ink">
              <li>通話の録音には<strong>相手の同意が必要</strong>な場合があります（地域・業務上のルールを確認してください）</li>
              <li>録音ファイルはこの PC 内にのみ保存され、外部に送信されません</li>
              <li>機密情報を扱う際は適切なアクセス制御を行ってください</li>
              <li>不要になった録音は速やかに削除するか、保管期限を設定してください</li>
            </ul>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowRecordingWarning(false)}
                className="rounded-md border border-rule bg-surface px-4 py-2 text-sm font-medium text-ink hover:bg-paper"
              >
                キャンセル
              </button>
              <button
                onClick={() => {
                  updateRecording({ enabled: true });
                  setShowRecordingWarning(false);
                }}
                className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-on-accent hover:bg-accent/90"
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
