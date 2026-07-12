import { useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';

interface Props {
  src: string;
  /** 再生位置の通知（文字起こしの追従ハイライト用） */
  onTimeUpdate?: (sec: number) => void;
}

export interface AudioPlayerHandle {
  seekTo: (sec: number) => void;
  play: () => void;
}

const SPEEDS = [0.75, 1, 1.25, 1.5, 2];
const VOL_KEY = 'callstack.playbackVolume';
const SPEED_KEY = 'callstack.playbackSpeed';

export const AudioPlayer = forwardRef<AudioPlayerHandle, Props>(function AudioPlayer({ src, onTimeUpdate }, ref) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // 再生速度・音量は前回の設定を引き継ぐ（localStorage に保存）
  const [speed, setSpeed] = useState(() => {
    const v = Number(localStorage.getItem(SPEED_KEY));
    return SPEEDS.includes(v) ? v : 1;
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = speed;
    localStorage.setItem(SPEED_KEY, String(speed));
  }, [speed]);

  // 音量の初期値を復元（音声要素が用意できたら適用）
  const applyStoredVolume = (el: HTMLAudioElement | null) => {
    audioRef.current = el;
    if (!el) return;
    const v = Number(localStorage.getItem(VOL_KEY));
    if (!Number.isNaN(v) && v >= 0 && v <= 1) el.volume = v;
    el.playbackRate = speed;
  };
  const handleVolumeChange = (el: HTMLAudioElement) => {
    localStorage.setItem(VOL_KEY, String(el.volume));
  };

  useImperativeHandle(ref, () => ({
    seekTo: (sec: number) => {
      if (audioRef.current) {
        audioRef.current.currentTime = sec;
        audioRef.current.play().catch(() => {});
      }
    },
    play: () => {
      audioRef.current?.play().catch(() => {});
    },
  }));

  return (
    <div className="space-y-2">
      <audio
        ref={applyStoredVolume}
        src={src}
        controls
        preload="metadata"
        onTimeUpdate={(e) => onTimeUpdate?.(e.currentTarget.currentTime)}
        onVolumeChange={(e) => handleVolumeChange(e.currentTarget)}
        onLoadedMetadata={(e) => applyStoredVolume(e.currentTarget)}
        onError={() => setError('音声ファイルを読み込めませんでした')}
        className="w-full"
      />
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-slate-500 dark:text-slate-400">再生速度:</span>
        {SPEEDS.map((s) => (
          <button
            key={s}
            onClick={() => setSpeed(s)}
            className={`rounded px-2 py-0.5 ${
              speed === s
                ? 'bg-brand-600 text-white'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700'
            }`}
          >
            {s}x
          </button>
        ))}
      </div>
      {error && <div className="text-xs text-red-600 dark:text-red-400">{error}</div>}
    </div>
  );
});
