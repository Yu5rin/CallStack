import { useEffect, useState } from 'react';
import { CallRecord, RecordKind, Settings } from '../../shared/types';
import { FileAudio, FolderOpen, Phone, Users } from 'lucide-react';
import { toDatetimeLocalValue, fromDatetimeLocalValue } from '../utils/format';
import { toUserMessage } from '../utils/errorMessage';

export interface ImportFile {
  path: string;
  name: string;
  mtime: string;   // ISO
}

interface Props {
  settings: Settings;
  /** ドラッグ&ドロップで開いた場合の初期ファイル */
  initialFile?: ImportFile | null;
  onClose: () => void;
  /** 取り込み完了。編集ダイアログを開くなどの後続処理へ */
  onImported: (rec: CallRecord) => void;
}

/** 音声ファイルを通話/会議の記録として取り込むダイアログ */
export function AudioImportDialog({ settings, initialFile, onClose, onImported }: Props) {
  const [file, setFile] = useState<ImportFile | null>(initialFile ?? null);
  const [kind, setKind] = useState<RecordKind>('meeting');
  const [title, setTitle] = useState('');
  const [contactName, setContactName] = useState('');
  const [startTime, setStartTime] = useState('');
  const [autoTranscribe, setAutoTranscribe] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (file) setStartTime(toDatetimeLocalValue(file.mtime));
  }, [file]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const pick = async () => {
    const r = await window.api.audio.pick();
    if (!r.canceled) setFile({ path: r.path, name: r.name, mtime: r.mtime });
  };

  const runImport = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const r = await window.api.audio.import({
        filePath: file.path,
        kind,
        title: kind === 'meeting' ? (title || undefined) : undefined,
        contactName: kind === 'call' ? (contactName || undefined) : undefined,
        startTime: startTime ? fromDatetimeLocalValue(startTime) : undefined,
        autoTranscribe,
      });
      if (!r.ok) {
        setError(toUserMessage(r.error));
        return;
      }
      onImported(r.record);
      onClose();
    } catch (err) {
      setError(toUserMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const inputClass =
    'w-full rounded-md border border-rule bg-surface px-3 py-2 text-sm text-ink';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
      onClick={() => !busy && onClose()}
    >
      <div
        className="w-[min(94vw,38rem)] max-h-[92vh] overflow-auto rounded-lg bg-surface p-6 shadow-lg text-ink"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-1 inline-flex items-center gap-2 text-lg font-medium text-ink"><FileAudio size={18} className="text-accent-ink" />音声ファイルを取り込む</h2>
        <p className="mb-4 text-xs text-ink-mute">
          録音済みの音声ファイル（会議の録音など）を通話/会議の記録として登録し、文字起こしできます。
          MP3 以外は自動で MP3 に変換されます。
        </p>

        <div className="mb-3 flex items-center gap-2">
          <button
            onClick={pick}
            disabled={busy}
            className="rounded-md border border-rule bg-surface px-3 py-2 text-sm font-medium text-ink hover:bg-paper disabled:opacity-50"
          >
            <FolderOpen size={14} className="mr-1.5 inline align-[-2px]" />ファイルを選択…
          </button>
          <span className="min-w-0 flex-1 truncate text-sm text-ink-mute">
            {file ? file.name : '未選択（ドラッグ&ドロップでも取り込めます）'}
          </span>
        </div>

        <div className="mb-3 flex gap-4 text-sm text-ink">
          <label className="inline-flex items-center gap-1.5">
            <input type="radio" checked={kind === 'meeting'} onChange={() => setKind('meeting')} />
            <Users size={14} className="text-meeting" /> 会議として取り込む
          </label>
          <label className="inline-flex items-center gap-1.5">
            <input type="radio" checked={kind === 'call'} onChange={() => setKind('call')} />
            <Phone size={14} className="text-accent-ink" /> 通話として取り込む
          </label>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {kind === 'meeting' ? (
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-ink-mute">会議タイトル</span>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className={inputClass}
                placeholder={file ? file.name.replace(/\.[^.]+$/, '') : '例: 週次定例'}
              />
            </label>
          ) : (
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-ink-mute">連絡先名</span>
              <input
                value={contactName}
                onChange={(e) => setContactName(e.target.value)}
                className={inputClass}
                placeholder="例: 山田太郎"
              />
            </label>
          )}
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ink-mute">開始日時</span>
            <input
              type="datetime-local"
              step={1}
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              className={inputClass}
            />
          </label>
        </div>

        <label className="mt-3 flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={autoTranscribe}
            onChange={(e) => setAutoTranscribe(e.target.checked)}
          />
          取り込み後に文字起こしを開始する（モデル: {settings.transcription.model}）
        </label>

        {error && (
          <div className="mt-3 whitespace-pre-wrap rounded border border-danger/30 bg-danger-soft p-2 text-xs text-danger">
            {error}
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={busy}
            className="rounded-md border border-rule bg-surface px-4 py-2 text-sm font-medium text-ink hover:bg-paper disabled:opacity-50"
          >
            キャンセル
          </button>
          <button
            onClick={runImport}
            disabled={!file || busy}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-on-accent hover:bg-accent/90 disabled:opacity-50"
          >
            {busy ? '取り込み中…（変換に少し時間がかかります）' : '取り込む'}
          </button>
        </div>
      </div>
    </div>
  );
}
