import { useState, useEffect } from 'react';
import { Settings, TagDef } from '../../shared/types';
import { ShortcutInput } from '../components/ShortcutInput';

export function SettingsPage({ settings, onSave }: { settings: Settings; onSave: (s: Settings) => Promise<void> }) {
  const [draft, setDraft] = useState<Settings>(settings);
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    setDraft(settings);
    setDirty(false);
  }, [settings]);

  const update = (patch: Partial<Settings>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setDirty(true);
  };

  const updateShortcut = (key: keyof Settings['shortcuts'], v: string) => {
    setDraft((d) => ({ ...d, shortcuts: { ...d.shortcuts, [key]: v } }));
    setDirty(true);
  };

  const updateTag = (idx: number, patch: Partial<TagDef>) => {
    setDraft((d) => {
      const tags = d.tags.slice();
      tags[idx] = { ...tags[idx], ...patch };
      return { ...d, tags };
    });
    setDirty(true);
  };

  const removeTag = (idx: number) => {
    setDraft((d) => ({ ...d, tags: d.tags.filter((_, i) => i !== idx) }));
    setDirty(true);
  };

  const addTag = () => {
    setDraft((d) => ({ ...d, tags: [...d.tags, { name: '新規タグ', color: '#94a3b8' }] }));
    setDirty(true);
  };

  const handleSave = async () => {
    await onSave(draft);
    setDirty(false);
    setSavedAt(Date.now());
  };

  return (
    <div className="space-y-6 p-6">
      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="mb-1 text-base font-semibold text-slate-900">グローバルショートカット</h3>
        <p className="mb-4 text-xs text-slate-500">
          システム全体で有効。フォーカス中の入力欄にキーを押すと記録できます。
        </p>
        <div className="space-y-3">
          <Row label="通話を開始">
            <ShortcutInput value={draft.shortcuts.startCall} onChange={(v) => updateShortcut('startCall', v)} />
          </Row>
          <Row label="通話を終了">
            <ShortcutInput value={draft.shortcuts.endCall} onChange={(v) => updateShortcut('endCall', v)} />
          </Row>
          <Row label="メイン窓を表示/隠す">
            <ShortcutInput value={draft.shortcuts.toggleWindow} onChange={(v) => updateShortcut('toggleWindow', v)} />
          </Row>
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-semibold text-slate-900">タグ</h3>
          <button
            onClick={addTag}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50"
          >
            ＋ タグを追加
          </button>
        </div>
        <div className="space-y-2">
          {draft.tags.map((t, i) => (
            <div key={i} className="flex items-center gap-3">
              <input
                type="color"
                value={t.color}
                onChange={(e) => updateTag(i, { color: e.target.value })}
                className="h-9 w-9 cursor-pointer rounded border border-slate-300"
              />
              <input
                value={t.name}
                onChange={(e) => updateTag(i, { name: e.target.value })}
                className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
              <button
                onClick={() => removeTag(i)}
                className="rounded-md border border-red-300 bg-white px-2 py-1.5 text-xs text-red-700 hover:bg-red-50"
              >
                削除
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="mb-3 text-base font-semibold text-slate-900">その他</h3>
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
            className="w-32 rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <span className="ml-2 text-xs text-slate-500">空欄で無効化</span>
        </Row>
        <Row label="音声フィードバック">
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.soundFeedback}
              onChange={(e) => update({ soundFeedback: e.target.checked })}
            />
            開始/終了時にビープ音
          </label>
        </Row>
      </section>

      <div className="sticky bottom-0 flex items-center justify-end gap-3 border-t bg-slate-50/80 py-3 backdrop-blur">
        {savedAt && !dirty && <span className="text-xs text-emerald-600">保存しました</span>}
        <button
          onClick={handleSave}
          disabled={!dirty}
          className="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-brand-700 disabled:opacity-50"
        >
          設定を保存
        </button>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-4">
      <div className="w-44 text-sm text-slate-700">{label}</div>
      <div className="flex-1">{children}</div>
    </div>
  );
}
