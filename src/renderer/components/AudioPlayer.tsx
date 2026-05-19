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

export const AudioPlayer = forwardRef<AudioPlayerHandle, Props>(function AudioPlayer({ src }, ref) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [speed, setSpeed] = useState(1);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="space-y-2">
      <audio
        ref={audioRef}
        src={src}
        controls
        preload="metadata"
        onError={() => setError('音声ファイルを読み込めませんでした')}
        className="w-full"
      />
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-slate-500">再生速度:</span>
        {SPEEDS.map((s) => (
          <button
            key={s}
            onClick={() => setSpeed(s)}
            className={`rounded px-2 py-0.5 ${speed === s ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}
          >
            {s}x
          </button>
        ))}
      </div>
      {error && <div className="text-xs text-red-600">{error}</div>}
    </div>
  );
});
