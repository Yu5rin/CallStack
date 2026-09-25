import { useState } from 'react';
import { Phone, Users, Bookmark, Mic, FileText, Square } from 'lucide-react';
import { Settings } from '../../shared/types';

interface Props {
  settings: Settings;
  onFinish: (patch: Partial<Settings>) => void;
}

/** 初回起動時のセットアップウィザード */
export function OnboardingDialog({ settings, onFinish }: Props) {
  const [step, setStep] = useState(0);
  const [enableRecording, setEnableRecording] = useState(false);
  const [launchAtLogin, setLaunchAtLogin] = useState(false);

  const finish = (openSettings = false) => {
    onFinish({
      onboardingDone: true,
      launchAtLogin,
      recording: { ...settings.recording, enabled: enableRecording },
    });
    if (openSettings) {
      // 文字起こしセットアップへ誘導
      window.dispatchEvent(new CustomEvent('callstack:navigate-settings'));
    }
  };

  const kbd = (s: string) => (
    <kbd className="rounded border border-rule bg-ink/5 px-1.5 py-0.5 font-mono text-xs text-ink">
      {s}
    </kbd>
  );

  const steps = [
    // Step 0: ようこそ
    <div key="welcome" className="space-y-4 text-center">
      <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-lg bg-accent">
        <div className="flex items-end gap-1">
          {[8, 14, 20, 14, 8].map((h, i) => (
            <div key={i} className="w-1.5 rounded-full bg-on-accent" style={{ height: h * 2 }} />
          ))}
        </div>
      </div>
      <h2 className="text-xl font-medium text-ink">CallStack へようこそ</h2>
      <p className="text-sm leading-relaxed text-ink-mute">
        通話・会議の時間記録、録音、オフライン文字起こしをこれ1つで。
        <br />
        使い始める前に、いくつかだけ設定しましょう（あとで設定画面から変更できます）。
      </p>
    </div>,

    // Step 1: ショートカット
    <div key="shortcuts" className="space-y-4">
      <h2 className="text-lg font-medium text-ink">基本のショートカット</h2>
      <p className="text-sm text-ink-mute">
        どのアプリを使っていても、キー1つで記録を開始できます。
      </p>
      <ul className="space-y-2.5 text-sm text-ink">
        <li className="flex items-center gap-3">{kbd(settings.shortcuts.startCall)} <span className="inline-flex items-center gap-1.5"><Phone size={14} className="text-accent-ink" />通話を開始</span></li>
        <li className="flex items-center gap-3">{kbd(settings.shortcuts.startMeeting)} <span className="inline-flex items-center gap-1.5"><Users size={14} className="text-meeting" />会議を開始</span></li>
        <li className="flex items-center gap-3">{kbd(settings.shortcuts.endCall)} <span className="inline-flex items-center gap-1.5"><Square size={12} className="text-danger" />記録を終了</span></li>
        <li className="flex items-center gap-3">{kbd(settings.shortcuts.toggleHold)} <span>保留（通話のみ）</span></li>
        <li className="flex items-center gap-3">{kbd(settings.shortcuts.addMarker)} <span className="inline-flex items-center gap-1.5"><Bookmark size={14} className="text-ink-mute" />マーカーを打つ</span></li>
        <li className="flex items-center gap-3">{kbd(settings.shortcuts.togglePauseRecording)} <span>録音の一時停止/再開</span></li>
      </ul>
      <p className="text-xs text-ink-mute">
        記録中は画面端に HUD（小窓）が表示され、そこからも操作できます。
      </p>
    </div>,

    // Step 2: 録音
    <div key="recording" className="space-y-4">
      <h2 className="inline-flex items-center gap-2 text-lg font-medium text-ink"><Mic size={18} className="text-ink-mute" />録音を使いますか？</h2>
      <p className="text-sm text-ink-mute">
        記録の開始と同時に、マイクや PC の音声（通話相手・会議アプリの音）を MP3 で録音できます。
      </p>
      <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-rule bg-paper p-3">
        <input
          type="checkbox"
          checked={enableRecording}
          onChange={(e) => setEnableRecording(e.target.checked)}
          className="mt-0.5"
        />
        <span className="text-sm text-ink">
          録音を有効にする
          <span className="mt-1 block text-xs leading-relaxed text-ink-mute">
            通話の録音には相手の同意が必要な場合があります。録音はこの PC 内にのみ保存され、外部に送信されません。
          </span>
        </span>
      </label>
      <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-rule bg-paper p-3">
        <input
          type="checkbox"
          checked={launchAtLogin}
          onChange={(e) => setLaunchAtLogin(e.target.checked)}
        />
        <span className="text-sm text-ink">Windows ログイン時に自動起動する</span>
      </label>
    </div>,

    // Step 3: 文字起こし
    <div key="transcribe" className="space-y-4">
      <h2 className="inline-flex items-center gap-2 text-lg font-medium text-ink"><FileText size={18} className="text-ink-mute" />文字起こし（オフライン）</h2>
      <p className="text-sm leading-relaxed text-ink-mute">
        録音した音声は whisper.cpp で<strong>完全オフライン</strong>文字起こしできます。
        利用には初回のみ2つのダウンロードが必要です（設定画面のボタンで完結します）:
      </p>
      <ol className="list-decimal space-y-1 pl-5 text-sm text-ink">
        <li>whisper.cpp 本体（約 10MB）</li>
        <li>認識モデル（small 約 466MB を推奨）</li>
      </ol>
      <p className="text-xs text-ink-mute">
        「設定を開く」を押すと、文字起こしセクションからすぐにセットアップできます。
        使わない場合はこのままスキップして構いません。
      </p>
    </div>,
  ];

  const isLast = step === steps.length - 1;

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-ink/40 p-4">
      <div className="w-[min(94vw,34rem)] rounded-lg bg-surface p-8 shadow-lg">
        {steps[step]}

        <div className="mt-6 flex items-center justify-center gap-1.5">
          {steps.map((_, i) => (
            <span
              key={i}
              className={`h-1.5 rounded-full transition-all ${
                i === step ? 'w-6 bg-accent' : 'w-1.5 bg-rule'
              }`}
            />
          ))}
        </div>

        <div className="mt-6 flex items-center justify-between">
          <button
            onClick={() => finish(false)}
            className="text-xs text-ink-mute hover:text-ink-mute hover:underline"
          >
            スキップ
          </button>
          <div className="flex gap-2">
            {step > 0 && (
              <button
                onClick={() => setStep((s) => s - 1)}
                className="rounded-md border border-rule bg-surface px-4 py-2 text-sm font-medium text-ink hover:bg-paper"
              >
                戻る
              </button>
            )}
            {isLast ? (
              <>
                <button
                  onClick={() => finish(false)}
                  className="rounded-md border border-rule bg-surface px-4 py-2 text-sm font-medium text-ink hover:bg-paper"
                >
                  完了
                </button>
                <button
                  onClick={() => finish(true)}
                  className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-on-accent hover:bg-accent/90"
                >
                  設定を開いてセットアップ
                </button>
              </>
            ) : (
              <button
                onClick={() => setStep((s) => s + 1)}
                className="rounded-md bg-accent px-5 py-2 text-sm font-medium text-on-accent hover:bg-accent/90"
              >
                次へ
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
