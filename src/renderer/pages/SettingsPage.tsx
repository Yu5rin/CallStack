import { useEffect, useRef, useState } from 'react';
import { AppEvent, RecordingSourceConfig, Settings, TagDef, ThemePref, WhisperModel } from '../../shared/types';
import { ShortcutInput } from '../components/ShortcutInput';
import { AudioDeviceSelect } from '../components/AudioDeviceSelect';
import { ModelManager } from '../components/ModelManager';

const sectionClass =
  'rounded-lg border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900';
const inputClass =
  'rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100';
const ghostBtn =
  'rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700';

/** whisper.cpp のセットアップ状態 + 実行ファイルのアプリ内ダウンロード */
function WhisperSetup() {
  const [status, setStatus] = useState<{ ok: true } | { ok: false; error: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<{ step: string; rec: number; total: number | null } | null>(null);
  const [dlError, setDlError] = useState<string | null>(null);

  const run = async () => {
    setChecking(true);
    try {
      setStatus(await window.api.transcription.checkSetup());
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    run();
    const off = window.api.onEvent((e: AppEvent) => {
      if (e.type !== 'whisperbin:download') return;
      if (e.step === 'done') {
        setDownloading(false);
        setProgress(null);
        void run();
      } else if (e.step === 'error') {
        setDownloading(false);
        setProgress(null);
        setDlError(e.error ?? 'ダウンロードに失敗しました');
      } else {
        setProgress({ step: e.step, rec: e.receivedBytes, total: e.totalBytes });
      }
    });
    return () => off();
  }, []);

  const download = async () => {
    setDlError(null);
    setDownloading(true);
    setProgress({ step: 'download', rec: 0, total: null });
    await window.api.whisper.downloadBinary();
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
        <div className="text-xs text-emerald-700 dark:text-emerald-300">✅ 文字起こしの準備が整っています。</div>
      )}
      {status && !status.ok && (
        <div className="space-y-2">
          <div className="whitespace-pre-wrap text-xs text-red-700 dark:text-red-300">⚠️ {status.error}</div>
        </div>
      )}
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={download}
          disabled={downloading}
          className="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
          title="whisper.cpp の Windows ビルドを GitHub から取得して自動配置します"
        >
          {downloading ? '取得中…' : '⬇ whisper.cpp をダウンロード'}
        </button>
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
      {progress && pct !== null && progress.step === 'download' && (
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-slate-200 dark:bg-slate-700">
          <div className="h-full bg-brand-500 transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}
      {dlError && (
        <div className="mt-2 whitespace-pre-wrap text-xs text-red-700 dark:text-red-300">⚠️ {dlError}</div>
      )}
    </div>
  );
}

export function SettingsPage({ settings, onSave }: { settings: Settings; onSave: (s: Settings) => Promise<void> }) {
  const [draft, setDraft] = useState<Settings>(settings);
  const [showRecordingWarning, setShowRecordingWarning] = useState(false);
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
        <h3 className="mb-3 text-base font-semibold text-slate-900 dark:text-slate-100">🎨 外観</h3>
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
        <h3 className="mb-3 text-base font-semibold text-slate-900 dark:text-slate-100">🪟 ウィンドウと HUD</h3>
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
                {s === 'mini' ? 'ミニ (200×32)' : s === 'compact' ? 'コンパクト (330×64)' : 'フル (400×118)'}
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
      </section>

      {/* ============ ショートカット ============ */}
      <section className={sectionClass}>
        <h3 className="mb-1 text-base font-semibold text-slate-900 dark:text-slate-100">⌨️ グローバルショートカット</h3>
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
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">🏷 タグ</h3>
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
              <button
                onClick={() => removeTag(i)}
                className="rounded-md border border-red-300 bg-white px-2 py-1.5 text-xs text-red-700 hover:bg-red-50 dark:border-red-800 dark:bg-slate-900 dark:text-red-300 dark:hover:bg-red-950"
              >
                削除
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* ============ 録音 ============ */}
      <section className={sectionClass}>
        <h3 className="mb-3 text-base font-semibold text-slate-900 dark:text-slate-100">🎙 録音</h3>
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

      {/* ============ 文字起こし ============ */}
      <section className={sectionClass}>
        <h3 className="mb-1 text-base font-semibold text-slate-900 dark:text-slate-100">📝 文字起こし (whisper.cpp ローカル)</h3>
        <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
          すべてオフラインで動作します。初回のみ whisper.cpp 本体とモデルのダウンロードが必要です（下のボタンで完結します）。
        </p>
        <WhisperSetup />
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
              社名・人名・専門用語を読点区切りで書くと、固有名詞の認識精度が上がります
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
          />
        </div>
      </section>

      {/* ============ 通知と確認 ============ */}
      <section className={sectionClass}>
        <h3 className="mb-3 text-base font-semibold text-slate-900 dark:text-slate-100">🔔 通知と確認</h3>
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
        <h3 className="mb-1 text-base font-semibold text-slate-900 dark:text-slate-100">💾 データのバックアップ</h3>
        <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
          全データ (記録 + 設定) を JSON でバックアップ・復元します。録音ファイル本体は含まれません。
        </p>
        <BackupRestoreRow />
      </section>

      {/* ============ バージョン情報 ============ */}
      <section className={sectionClass}>
        <h3 className="mb-3 text-base font-semibold text-slate-900 dark:text-slate-100">ℹ️ バージョン情報</h3>
        <AboutSection
          checkOnStartup={draft.checkUpdatesOnStartup}
          onToggleCheckOnStartup={(v) => update({ checkUpdatesOnStartup: v })}
        />
      </section>

      {showRecordingWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="w-[min(94vw,32rem)] rounded-xl bg-white p-6 shadow-2xl dark:bg-slate-900 dark:text-slate-100">
            <h3 className="mb-2 text-lg font-bold text-slate-900 dark:text-slate-100">⚠️ 録音に関する重要な注意</h3>
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
}: {
  checkOnStartup: boolean;
  onToggleCheckOnStartup: (v: boolean) => void;
}) {
  const [info, setInfo] = useState<{ version: string; logPath: string; dataDir: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [updateUrl, setUpdateUrl] = useState<string | null>(null);

  useEffect(() => {
    window.api.app.info().then(setInfo).catch(() => {});
  }, []);

  const check = async () => {
    setChecking(true);
    setResult(null);
    setUpdateUrl(null);
    try {
      const r = await window.api.update.check();
      if (!r.ok) {
        setResult(`更新を確認できませんでした（${r.error ?? '不明なエラー'}）。リリースページで直接確認してください。`);
        setUpdateUrl('https://github.com/Yu5rin/CallStack/releases/latest');
      } else if (r.hasUpdate) {
        setResult(`🎉 新しいバージョン v${r.latest} が利用できます（現在 v${r.current}）`);
        setUpdateUrl(r.url ?? null);
      } else {
        setResult(`✅ 最新です（v${r.current}）`);
      }
    } finally {
      setChecking(false);
    }
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
            {checking ? '確認中…' : '🔄 更新を確認'}
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
      <Row label="フォルダ">
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => void window.api.app.openPath('data')}
            className="rounded-md border border-slate-300 bg-white px-3 py-1 text-xs text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
          >
            📁 データフォルダを開く
          </button>
          <button
            onClick={() => void window.api.app.openPath('recordings')}
            className="rounded-md border border-slate-300 bg-white px-3 py-1 text-xs text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
          >
            🎙 録音フォルダを開く
          </button>
          <button
            onClick={() => void window.api.app.openPath('logs')}
            className="rounded-md border border-slate-300 bg-white px-3 py-1 text-xs text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
          >
            📋 ログフォルダを開く
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
      setError((err as Error).message);
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
      setError((err as Error).message);
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
          🎤 マイク
        </label>
        <label className="inline-flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={value.system}
            onChange={(e) => onChange({ ...value, system: e.target.checked })}
            disabled={disabled}
          />
          🔊 システム音声
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
          <span className="text-xs text-amber-600 dark:text-amber-400">⚠️ 両方 OFF のため録音されません</span>
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
