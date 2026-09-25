import { Phone, Users, Bookmark, Play, Pause, Square, PhoneOff } from 'lucide-react';
import { CallRecord, ShortcutSettings } from '../../shared/types';
import { formatHMS } from '../utils/format';
import { LevelMeter } from '../recorder/LevelMeter';
import { toUserMessage } from '../utils/errorMessage';

interface Props {
  active: CallRecord;
  elapsedSec: number;
  holding: boolean;
  holdSec: number;
  recording: boolean;
  paused: boolean;
  level: number;
  error: string | null;
  onDismissError: () => void;
  onAddMarker: () => void;
  onTogglePauseRecording: () => void;
  onToggleHold: () => void;
  onEnd: () => void;
  shortcuts: ShortcutSettings;
}

/**
 * タイトルバー直下に表示するライブストリップ。記録（通話/会議）が進行中の間、
 * 旧ヘッダーにあった状態ピル・REC ピル・マーカー/終了ボタンをここへ集約する。
 * 左端の 3px ボーダーで状態を示す: 録音中=danger / 一時停止中=pending / 録音なし=accent。
 */
export function LiveStrip({
  active, elapsedSec, holding, holdSec, recording, paused, level, error,
  onDismissError, onAddMarker, onTogglePauseRecording, onToggleHold, onEnd, shortcuts,
}: Props) {
  const isMeeting = active.kind === 'meeting';
  const name = isMeeting ? (active.title || '（会議名未設定）') : (active.contactName || '（連絡先未設定）');
  const borderColor = recording && !paused ? 'border-l-danger' : recording && paused ? 'border-l-pending' : 'border-l-accent';

  return (
    <div
      className={`flex h-11 flex-none items-center gap-3 border-b border-l-[3px] border-rule bg-surface px-3 ${borderColor}`}
    >
      {recording && (
        <span className="flex shrink-0 items-center gap-1.5">
          <span
            className={`h-2 w-2 rounded-full ${paused ? 'bg-pending' : 'animate-pulse bg-danger'}`}
            aria-hidden
          />
          <span className={`hidden text-[11px] font-semibold tracking-wide md:inline ${paused ? 'text-pending' : 'text-danger'}`}>
            {paused ? '一時停止中' : 'REC'}
          </span>
        </span>
      )}

      <span className="shrink-0 text-ink-mute">
        {isMeeting ? <Users size={16} className="text-meeting" /> : <Phone size={16} />}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink sm:flex-none sm:max-w-[14rem]">{name}</span>
      <span className="hidden shrink-0 text-xs text-ink-mute md:inline">{isMeeting ? '会議' : '通話'}</span>
      {holding && (
        <span className="hidden shrink-0 text-xs font-medium text-pending md:inline">保留中 {formatHMS(holdSec)}</span>
      )}

      <span className="shrink-0 font-mono text-xl font-semibold tabular-nums text-ink">{formatHMS(elapsedSec)}</span>

      {recording && !paused && (
        <span className="hidden shrink-0 sm:inline-flex">
          <LevelMeter level={level} />
        </span>
      )}

      {error && (
        <button
          onClick={onDismissError}
          className="min-w-0 max-w-[10rem] shrink truncate rounded-md bg-danger-soft px-2 py-1 text-xs text-danger hover:bg-danger/20 lg:max-w-[18rem]"
          title={`${toUserMessage(error)}\n（クリックで閉じる）`}
        >
          {toUserMessage(error)}
        </button>
      )}

      <span className="flex-1" />

      <button
        onClick={onAddMarker}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-rule bg-surface px-2 py-1.5 text-xs font-medium text-ink hover:bg-accent-soft"
        title={`現在時刻にマーカーを打つ${shortcuts.addMarker ? ` (${shortcuts.addMarker})` : ''}`}
      >
        <Bookmark size={13} /><span className="hidden md:inline">マーカー</span>
      </button>

      {recording && (
        <button
          onClick={onTogglePauseRecording}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-rule bg-surface px-2 py-1.5 text-xs font-medium text-ink hover:bg-accent-soft"
          title={paused ? `録音を再開 (${shortcuts.togglePauseRecording})` : `録音を一時停止 (${shortcuts.togglePauseRecording})`}
        >
          {paused ? <Play size={13} /> : <Pause size={13} />}
          <span className="hidden md:inline">{paused ? '再開' : '一時停止'}</span>
        </button>
      )}

      {!isMeeting && (
        <button
          onClick={onToggleHold}
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1.5 text-xs font-medium ${
            holding ? 'border-pending bg-pending/10 text-pending' : 'border-rule bg-surface text-ink hover:bg-accent-soft'
          }`}
          title={`${holding ? '保留を解除' : '保留にする'}${shortcuts.toggleHold ? ` (${shortcuts.toggleHold})` : ''}`}
        >
          <PhoneOff size={13} /><span className="hidden md:inline">{holding ? '保留解除' : '保留'}</span>
        </button>
      )}

      <button
        onClick={onEnd}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-danger px-2 py-1.5 text-xs font-medium text-danger hover:bg-danger-soft"
        title={`記録を終了 (${shortcuts.endCall})`}
      >
        <Square size={11} fill="currentColor" /><span className="hidden md:inline">終了</span>
        <span className="hidden font-mono text-[10px] text-danger/70 lg:inline">{shortcuts.endCall}</span>
      </button>
    </div>
  );
}
