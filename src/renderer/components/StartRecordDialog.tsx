import { useEffect, useState } from 'react';
import { RecordKind, RecordingSourceConfig, Settings } from '../../shared/types';

interface CaptureWindow {
  id: string;
  name: string;
  thumbnail: string | null;
}

interface Props {
  kind: RecordKind;
  settings: Settings;
  onCancel: () => void;
  /** 録音構成を確定して開始。config が null のときは録音なしで開始 */
  onStart: (config: RecordingSourceConfig | null, windowId: string | null, saveAsDefault: boolean) => void;
}

export function StartRecordDialog({ kind, settings, onCancel, onStart }: Props) {
  const defaults = kind === 'meeting' ? settings.recording.meetingSource : settings.recording.callSource;
  const [mic, setMic] = useState(defaults.mic);
  const [system, setSystem] = useState(defaults.system);
  const [scope, setScope] = useState<'screen' | 'window'>(defaults.systemScope);
  const [windows, setWindows] = useState<CaptureWindow[] | null>(null);
  const [windowId, setWindowId] = useState<string | null>(null);
  const [loadingWindows, setLoadingWindows] = useState(false);
  const [saveAsDefault, setSaveAsDefault] = useState(false);

  const isMeeting = kind === 'meeting';
  const nothingSelected = !mic && !system;
  const needsWindow = system && scope === 'window';

  const loadWindows = async () => {
    setLoadingWindows(true);
    try {
      const list = await window.api.capture.listWindows();
      setWindows(list);
      // 前回の選択が消えていたら解除
      if (windowId && !list.some((w) => w.id === windowId)) setWindowId(null);
    } finally {
      setLoadingWindows(false);
    }
  };

  useEffect(() => {
    if (needsWindow && windows === null) void loadWindows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsWindow]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const handleStart = () => {
    if (nothingSelected) {
      onStart(null, null, saveAsDefault);
      return;
    }
    onStart({ mic, system, systemScope: scope }, needsWindow ? windowId : null, saveAsDefault);
  };

  const checkboxCard = (
    checked: boolean,
    onChange: (v: boolean) => void,
    icon: string,
    label: string,
    desc: string,
  ) => (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition ${
        checked
          ? 'border-brand-400 bg-brand-50 ring-1 ring-brand-300 dark:border-brand-600 dark:bg-brand-900/30 dark:ring-brand-700'
          : 'border-slate-200 bg-white hover:border-slate-300 dark:border-slate-700 dark:bg-slate-800 dark:hover:border-slate-600'
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5"
      />
      <div className="min-w-0">
        <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">
          {icon} {label}
        </div>
        <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{desc}</div>
      </div>
    </label>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-lg max-h-[90vh] overflow-auto rounded-xl bg-white p-6 shadow-2xl dark:bg-slate-900 dark:text-slate-100"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-1 text-lg font-bold text-slate-900 dark:text-slate-100">
          {isMeeting ? '👥 会議を開始' : '📞 通話を開始'}
        </h2>
        <p className="mb-4 text-xs text-slate-500 dark:text-slate-400">
          録音するソースを選択してください（{isMeeting ? '会議' : '通話'}の既定値が選択されています）
        </p>

        <div className="space-y-2">
          {checkboxCard(mic, setMic, '🎤', 'マイク', '自分の声を録音します')}
          {checkboxCard(
            system,
            setSystem,
            '🔊',
            'システム音声',
            'PC で再生されている音（通話相手・会議アプリの音声）を録音します',
          )}
        </div>

        {system && (
          <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800">
            <div className="mb-2 text-xs font-semibold text-slate-600 dark:text-slate-300">システム音声の対象</div>
            <div className="flex gap-4 text-sm text-slate-700 dark:text-slate-300">
              <label className="inline-flex items-center gap-1.5">
                <input type="radio" checked={scope === 'screen'} onChange={() => setScope('screen')} />
                画面全体
              </label>
              <label className="inline-flex items-center gap-1.5">
                <input type="radio" checked={scope === 'window'} onChange={() => setScope('window')} />
                ウィンドウを選択
              </label>
            </div>
            {scope === 'window' && (
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
                <div className="grid max-h-48 grid-cols-2 gap-2 overflow-auto">
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
                        <img src={w.thumbnail} alt="" className="h-16 w-full rounded object-cover" />
                      ) : (
                        <div className="flex h-16 w-full items-center justify-center rounded bg-slate-100 text-2xl dark:bg-slate-700">🪟</div>
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
                  ⚠️ 実験的機能: Windows の仕様上、ウィンドウを選択しても環境によっては
                  システム全体の音声が録音される場合があります。
                </p>
              </div>
            )}
          </div>
        )}

        {nothingSelected && (
          <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
            ソースが未選択のため、録音なしで時間だけを記録します。
          </p>
        )}

        <label className="mt-4 flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
          <input
            type="checkbox"
            checked={saveAsDefault}
            onChange={(e) => setSaveAsDefault(e.target.checked)}
          />
          この選択を{isMeeting ? '会議' : '通話'}の既定として保存する
        </label>

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
          >
            キャンセル
          </button>
          <button
            onClick={handleStart}
            className={`rounded-md px-4 py-2 text-sm font-semibold text-white shadow-sm ${
              isMeeting ? 'bg-violet-600 hover:bg-violet-700' : 'bg-brand-600 hover:bg-brand-700'
            }`}
          >
            {nothingSelected ? '録音せずに開始' : '🔴 録音して開始'}
          </button>
        </div>
      </div>
    </div>
  );
}
