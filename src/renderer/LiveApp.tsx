import { useEffect, useRef, useState } from 'react';
import { AudioLines, ChevronDown, X } from 'lucide-react';
import { AppEvent, LiveFontSize, Settings } from '../shared/types';
import { useTheme } from './hooks/useTheme';

const FONT: Record<LiveFontSize, { cls: string; label: string }> = {
  sm: { cls: 'text-[12px] leading-snug', label: '小' },
  md: { cls: 'text-[15px] leading-snug', label: '中' },
  lg: { cls: 'text-[19px] leading-relaxed', label: '大' },
};

/**
 * ライブ字幕ウィンドウ（独立・移動/リサイズ可能）。
 * 録音中の Vosk 暫定テキストをリアルタイム表示する。
 */
export function LiveApp() {
  const [lines, setLines] = useState<string[]>([]);
  const [partial, setPartial] = useState('');
  const [fontSize, setFontSize] = useState<LiveFontSize>('sm');
  const [autoFollow, setAutoFollow] = useState(true);
  const [theme, setTheme] = useState<Settings['theme']>();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const settingsRef = useRef<Settings | null>(null);
  // ライブ字幕ウィンドウ自身にもテーマ（トークンの light/dark/black）を適用する
  useTheme(theme);

  useEffect(() => {
    window.api.settings.get().then((s) => {
      settingsRef.current = s;
      setFontSize(s.liveFontSize ?? 'sm');
      setTheme(s.theme);
    });
    // 途中から開いた場合、これまでの認識結果を取得
    window.api.live.get().then((r) => {
      if (r) setLines(r.segments.map((x) => x.text).filter(Boolean));
    }).catch(() => {});

    const off = window.api.onEvent((e: AppEvent) => {
      if (e.type === 'settings:updated') {
        settingsRef.current = e.settings;
        setFontSize(e.settings.liveFontSize ?? 'sm');
        setTheme(e.settings.theme);
      }
      if (e.type === 'live:segment') {
        if (e.final) {
          if (e.text) setLines((prev) => [...prev, e.text]);
          setPartial('');
        } else {
          setPartial(e.text);
        }
      }
      if (e.type === 'call:started') {
        setLines([]);
        setPartial('');
      }
      if (e.type === 'call:ended') {
        setPartial('');
      }
    });
    return () => off();
  }, []);

  // 追従中は新しい行が来るたび最下部へスクロール
  useEffect(() => {
    if (!autoFollow) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, partial, autoFollow, fontSize]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAutoFollow(dist < 16);
  };
  const returnToLatest = () => {
    setAutoFollow(true);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };
  const setFont = (size: LiveFontSize) => {
    setFontSize(size);
    const s = settingsRef.current;
    if (s) void window.api.settings.update({ ...s, liveFontSize: size });
  };
  const handleClose = () => { void window.api.live.hide(); };

  const font = FONT[fontSize];
  const hasContent = lines.length > 0 || partial.length > 0;

  return (
    <div className="flex h-screen w-screen flex-col bg-paper text-ink">
      {/* ヘッダー: ドラッグで移動。フォントサイズ切替と × */}
      <div className="hud-drag flex flex-none select-none items-center gap-1.5 border-b border-rule bg-chrome px-2 py-1">
        <AudioLines size={12} strokeWidth={2.25} className="flex-none text-accent-ink" />
        <span className="text-[10px] font-medium text-ink-mute">ライブ字幕</span>
        <div className="hud-no-drag ml-auto flex items-center gap-0.5">
          {(['sm', 'md', 'lg'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setFont(s)}
              className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition ${
                fontSize === s ? 'bg-accent text-on-accent' : 'text-ink-mute hover:bg-ink/10 hover:text-ink'
              }`}
              title={`文字サイズ: ${FONT[s].label}`}
            >
              {FONT[s].label}
            </button>
          ))}
          <button
            onClick={handleClose}
            className="ml-1 rounded p-0.5 text-ink-mute transition hover:bg-danger hover:text-on-accent"
            title="ライブ字幕を閉じる（HUD の「字幕」ボタンで再表示）"
          >
            <X size={14} strokeWidth={2.5} />
          </button>
        </div>
      </div>

      {/* 字幕本文: スクロールで全文確認 */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className={`h-full overflow-y-auto px-3 py-2 ${font.cls}`}
        >
          {!hasContent ? (
            <div className="text-[11px] text-ink-mute">
              録音中の音声をここに文字起こしします…
            </div>
          ) : (
            <>
              {lines.map((t, i) => (
                <div key={i} className="whitespace-pre-wrap break-words text-ink">{t}</div>
              ))}
              {partial && (
                <div className="whitespace-pre-wrap break-words italic text-ink-mute">{partial}</div>
              )}
            </>
          )}
        </div>
        {!autoFollow && (
          <button
            onClick={returnToLatest}
            className="hud-no-drag absolute bottom-2 right-3 inline-flex items-center gap-0.5 rounded-full bg-accent px-2.5 py-1 text-[11px] font-medium text-on-accent shadow-lg hover:bg-accent/90"
          >
            <ChevronDown size={12} strokeWidth={2.5} /> 最新へ
          </button>
        )}
      </div>
    </div>
  );
}
