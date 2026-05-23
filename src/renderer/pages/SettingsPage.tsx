import { useEffect, useRef, useState } from 'react';
import { Settings, TagDef, ThemePref, WhisperModel } from '../../shared/types';
import { ShortcutInput } from '../components/ShortcutInput';
import { AudioDeviceSelect } from '../components/AudioDeviceSelect';
import { ModelManager } from '../components/ModelManager';

const sectionClass =
  'rounded-lg border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900';
const inputClass =
  'rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100';
const ghostBtn =
  'rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700';

function SetupCheck() {
  const [status, setStatus] = useState<{ ok: true } | { ok: false; error: string } | null>(null);
  const [checking, setChecking] = useState(false);

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
  }, []);

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
        <div className="whitespace-pre-wrap text-xs text-red-700 dark:text-red-300">⚠️ {status.error}</div>
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
    <div className="space-y-6 p-6">
      <section className={sectionClass}>
        <h3 className="mb-3 text-base font-semibold text-slate-900 dark:text-slate-100">外観</h3>
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

      <section className={sectionClass}>
        <h3 className="mb-1 text-base font-semibold text-slate-900 dark:text-slate-100">グローバルショートカット</h3>
        <p className="mb-4 text-xs text-slate-500 dark:text-slate-400">
          システム全体で有効。フォーカス中の入力欄にキーを押すと記録できます。
        </p>
        <div className="space-y-3">
          <Row label="通話を開始">
            <ShortcutInput value={draft.shortcuts.startCall} onChange={(v) => updateShortcut('startCall', v)} />
          </Row>
          <Row label="通話を終了">
            <ShortcutInput value={draft.shortcuts.endCall} onChange={(v) => updateShortcut('endCall', v)} />
          </Row>
          <Row label="保留トグル">
            <ShortcutInput value={draft.shortcuts.toggleHold} onChange={(v) => updateShortcut('toggleHold', v)} />
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

      <section className={sectionClass}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">タグ</h3>
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

      <section className={sectionClass}>
        <h3 className="mb-3 text-base font-semibold text-slate-900 dark:text-slate-100">録音</h3>
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
        <Row label="音声ソース">
          <div className="flex gap-3 text-sm text-slate-700 dark:text-slate-300">
            <label className="inline-flex items-center gap-1">
              <input
                type="radio"
                checked={draft.recording.source === 'mic'}
                onChange={() => updateRecording({ source: 'mic' })}
                disabled={!draft.recording.enabled}
              />
              マイクのみ
            </label>
            <label className="inline-flex items-center gap-1">
              <input
                type="radio"
                checked={draft.recording.source === 'mic+system'}
                onChange={() => updateRecording({ source: 'mic+system' })}
                disabled={!draft.recording.enabled}
              />
              マイク + システム音声 (PC で流れている音も録音)
            </label>
          </div>
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
        <Row label="自動文字起こし">
          <label className="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              checked={draft.recording.autoTranscribe}
              onChange={(e) => updateRecording({ autoTranscribe: e.target.checked })}
              disabled={!draft.recording.enabled}
            />
            録音完了後に自動で文字起こし
          </label>
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
      </section>

      <section className={sectionClass}>
        <h3 className="mb-1 text-base font-semibold text-slate-900 dark:text-slate-100">文字起こし (whisper.cpp ローカル)</h3>
        <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
          すべてオフラインで動作します。初回利用時にモデルファイルをダウンロードしてください。
          whisper.cpp 実行ファイルは README「文字起こしの準備」に従ってセットアップしてください。
        </p>
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
        <SetupCheck />
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

      <section className={sectionClass}>
        <h3 className="mb-3 text-base font-semibold text-slate-900 dark:text-slate-100">ウィンドウ</h3>
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
                {s === 'mini' ? 'ミニ (180×32)' : s === 'compact' ? 'コンパクト (260×56)' : 'フル (340×96)'}
              </label>
            ))}
          </div>
          <span className="ml-2 block text-xs text-slate-500 dark:text-slate-400">
            HUD 右上のアイコンでもサイズを循環できます
          </span>
        </Row>
        <Row label="HUD の透明度">
          <div className="flex gap-3 text-sm text-slate-700 dark:text-slate-300">
            {([1.0, 0.75, 0.5] as const).map((o) => (
              <label key={o} className="inline-flex items-center gap-1">
                <input
                  type="radio"
                  checked={draft.hudOpacity === o}
                  onChange={() => update({ hudOpacity: o })}
                />
                {Math.round(o * 100)}%
              </label>
            ))}
          </div>
        </Row>
      </section>

      <section className={sectionClass}>
        <h3 className="mb-1 text-base font-semibold text-slate-900 dark:text-slate-100">データのバックアップ</h3>
        <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
          全データ (記録 + 設定) を JSON でバックアップ・復元します。録音ファイル本体は含まれません。
        </p>
        <BackupRestoreRow />
      </section>

      <section className={sectionClass}>
        <h3 className="mb-3 text-base font-semibold text-slate-900 dark:text-slate-100">その他</h3>
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
          <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">空欄で無効化</span>
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

      {showRecordingWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-2xl dark:bg-slate-900 dark:text-slate-100">
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

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center gap-4">
      <div className="w-44 text-sm text-slate-700 dark:text-slate-300">{label}</div>
      <div className="flex-1">{children}</div>
    </div>
  );
}
