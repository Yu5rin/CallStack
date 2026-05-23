import { useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';

interface Props {
  src: string;
  onSeekedTo?: (t: number) => void;
}

export interface AudioPlayerHandle {
  seekTo: (sec: number) => void;
  play: () => void;
}

const SPEEDS = [0.75, 1, 1.25, 1.5, 2];

function formatTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export const AudioPlayer = forwardRef<AudioPlayerHandle, Props>(function AudioPlayer({ src }, ref) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [speed, setSpeed] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = speed;
  }, [speed]);

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

  const togglePlay = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) a.play().catch(() => {});
    else a.pause();
  };

  const onSeekInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value);
    if (audioRef.current) audioRef.current.currentTime = v;
    setCurrentTime(v);
  };

  return (
    <div className="space-y-2">
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onError={() => setError('音声ファイルを読み込めませんでした')}
        onLoadedMetadata={(e) => setDuration((e.currentTarget as HTMLAudioElement).duration || 0)}
        onTimeUpdate={(e) => setCurrentTime((e.currentTarget as HTMLAudioElement).currentTime || 0)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      />
      <div className="flex items-center gap-3">
        <button
          onClick={togglePlay}
          className="h-8 w-8 rounded-full bg-brand-600 text-white shadow hover:bg-brand-700"
          title={playing ? '一時停止' : '再生'}
        >
          {playing ? '❚❚' : '▶'}
        </button>
        <input
          type="range"
          min={0}
          max={Math.max(duration, 0.01)}
          step={0.1}
          value={Math.min(currentTime, duration || currentTime)}
          onChange={onSeekInput}
          className="h-2 flex-1 cursor-pointer rounded-full bg-slate-200 accent-brand-600 dark:bg-slate-700"
        />
        <div className="font-mono text-xs tabular-nums text-slate-600 dark:text-slate-400">
          {formatTime(currentTime)} / {formatTime(duration)}
        </div>
      </div>
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
