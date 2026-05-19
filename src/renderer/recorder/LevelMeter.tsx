interface Props {
  level: number;          // 0..1
  className?: string;
}

export function LevelMeter({ level, className = '' }: Props) {
  const segments = 14;
  const filled = Math.round(level * segments);
  return (
    <div className={`flex items-end gap-0.5 ${className}`}>
      {Array.from({ length: segments }).map((_, i) => {
        const active = i < filled;
        const color = i < segments * 0.6 ? 'bg-emerald-400' : i < segments * 0.85 ? 'bg-amber-400' : 'bg-red-500';
        return (
          <div
            key={i}
            className={`w-1 rounded-sm transition-opacity ${active ? color : 'bg-white/20'}`}
            style={{ height: `${6 + i * 1.5}px`, opacity: active ? 1 : 0.4 }}
          />
        );
      })}
    </div>
  );
}
