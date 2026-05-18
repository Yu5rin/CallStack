import { useActiveCall } from './hooks/useActiveCall';
import { formatHMS } from './utils/format';

export function HudApp() {
  const { active, elapsedSec } = useActiveCall();

  const handleEnd = async () => {
    await window.api.hud.end();
  };
  const handleOpenMain = () => {
    window.api.hud.openMain();
  };

  if (!active) {
    return (
      <div className="hud-drag h-full w-full rounded-2xl bg-slate-900/90 px-4 py-3 text-slate-100 shadow-2xl">
        <div className="text-xs opacity-70">通話なし</div>
      </div>
    );
  }

  return (
    <div className="hud-drag h-full w-full select-none rounded-2xl bg-slate-900/95 px-4 py-3 text-slate-100 shadow-2xl ring-1 ring-white/10">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-emerald-400">● 通話中</div>
          <div className="font-mono text-2xl font-bold tabular-nums">{formatHMS(elapsedSec)}</div>
        </div>
        <div className="hud-no-drag flex flex-col gap-1">
          <button
            onClick={handleEnd}
            className="rounded-lg bg-red-500 px-3 py-1 text-xs font-semibold text-white shadow hover:bg-red-600"
          >
            終了
          </button>
          <button
            onClick={handleOpenMain}
            className="rounded-lg bg-slate-700 px-3 py-1 text-xs text-slate-100 hover:bg-slate-600"
          >
            メモ
          </button>
        </div>
      </div>
    </div>
  );
}
