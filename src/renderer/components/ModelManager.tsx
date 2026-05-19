import { useEffect, useState } from 'react';
import { WhisperModel, WHISPER_MODELS, AppEvent } from '../../shared/types';

interface Props {
  selected: WhisperModel;
  onSelect: (m: WhisperModel) => void;
  downloaded: Partial<Record<WhisperModel, boolean>>;
  onDownloaded: (m: WhisperModel) => void;
}

export function ModelManager({ selected, onSelect, downloaded, onDownloaded }: Props) {
  const [progress, setProgress] = useState<Partial<Record<WhisperModel, { rec: number; total: number | null; done?: boolean; error?: string }>>>({});

  useEffect(() => {
    const off = window.api.onEvent((e: AppEvent) => {
      if (e.type === 'model:download') {
        setProgress((prev) => ({
          ...prev,
          [e.model]: { rec: e.receivedBytes, total: e.totalBytes, done: e.done, error: e.error },
        }));
        if (e.done && !e.error) onDownloaded(e.model);
      }
    });
    return () => off();
  }, [onDownloaded]);

  const download = async (m: WhisperModel) => {
    setProgress((prev) => ({ ...prev, [m]: { rec: 0, total: null } }));
    await window.api.transcription.downloadModel(m);
  };

  return (
    <div className="space-y-2">
      {WHISPER_MODELS.map((m) => {
        const isDl = !!downloaded[m.id];
        const p = progress[m.id];
        const pct = p && p.total ? Math.round((p.rec / p.total) * 100) : null;
        return (
          <div key={m.id} className="flex items-center gap-3 rounded-md border border-slate-200 px-3 py-2">
            <input
              type="radio"
              name="whisper-model"
              checked={selected === m.id}
              onChange={() => onSelect(m.id)}
              disabled={!isDl}
            />
            <div className="flex-1">
              <div className="text-sm font-medium text-slate-800">{m.label}</div>
              {p && !p.done && pct !== null && (
                <div className="mt-1 h-1 w-full overflow-hidden rounded bg-slate-100">
                  <div className="h-full bg-brand-500 transition-all" style={{ width: `${pct}%` }} />
                </div>
              )}
              {p?.error && <div className="text-xs text-red-600">{p.error}</div>}
            </div>
            {isDl ? (
              <span className="text-xs text-emerald-600">ダウンロード済</span>
            ) : (
              <button
                onClick={() => download(m.id)}
                disabled={!!p && !p.done}
                className="rounded-md border border-brand-300 bg-white px-2 py-1 text-xs text-brand-700 hover:bg-brand-50 disabled:opacity-50"
              >
                {p && !p.done ? '取得中…' : 'ダウンロード'}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
