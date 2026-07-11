import { useState } from 'react';
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
    <kbd className="rounded border border-slate-300 bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-700 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200">
      {s}
    </kbd>
  );

  const steps = [
    // Step 0: ようこそ
    <div key="welcome" className="space-y-4 text-center">
      <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-3xl bg-brand-600 shadow-lg">
        <div className="flex items-end gap-1">
          {[8, 14, 20, 14, 8].map((h, i) => (
            <div key={i} className="w-1.5 rounded-full bg-white" style={{ height: h * 2 }} />
          ))}
        </div>
      </div>
      <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100">CallStack へようこそ</h2>
      <p className="text-sm leading-relaxed text-slate-600 dark:text-slate-300">
        通話・会議の時間記録、録音、オフライン文字起こしをこれ1つで。
        <br />
        使い始める前に、いくつかだけ設定しましょう（あとで設定画面から変更できます）。
      </p>
    </div>,

    // Step 1: ショートカット
    <div key="shortcuts" className="space-y-4">
      <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100">⌨️ 基本のショートカット</h2>
      <p className="text-sm text-slate-600 dark:text-slate-300">
        どのアプリを使っていても、キー1つで記録を開始できます。
      </p>
      <ul className="space-y-2.5 text-sm text-slate-700 dark:text-slate-200">
        <li className="flex items-center gap-3">{kbd(settings.shortcuts.startCall)} <span>📞 通話を開始</span></li>
        <li className="flex items-center gap-3">{kbd(settings.shortcuts.startMeeting)} <span>👥 会議を開始</span></li>
        <li className="flex items-center gap-3">{kbd(settings.shortcuts.endCall)} <span>記録を終了</span></li>
        <li className="flex items-center gap-3">{kbd(settings.shortcuts.toggleHold)} <span>保留（通話のみ）</span></li>
        <li className="flex items-center gap-3">{kbd(settings.shortcuts.addMarker)} <span>🔖 マーカーを打つ</span></li>
        <li className="flex items-center gap-3">{kbd(settings.shortcuts.togglePauseRecording)} <span>録音の一時停止/再開</span></li>
      </ul>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        記録中は画面端に HUD（小窓）が表示され、そこからも操作できます。
      </p>
    </div>,

    // Step 2: 録音
    <div key="recording" className="space-y-4">
      <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100">🎙 録音を使いますか？</h2>
      <p className="text-sm text-slate-600 dark:text-slate-300">
        記録の開始と同時に、マイクや PC の音声（通話相手・会議アプリの音）を MP3 で録音できます。
      </p>
      <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800">
        <input
          type="checkbox"
          checked={enableRecording}
          onChange={(e) => setEnableRecording(e.target.checked)}
          className="mt-0.5"
        />
        <span className="text-sm text-slate-700 dark:text-slate-200">
          録音を有効にする
          <span className="mt-1 block text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            通話の録音には相手の同意が必要な場合があります。録音はこの PC 内にのみ保存され、外部に送信されません。
          </span>
        </span>
      </label>
      <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800">
        <input
          type="checkbox"
          checked={launchAtLogin}
          onChange={(e) => setLaunchAtLogin(e.target.checked)}
        />
        <span className="text-sm text-slate-700 dark:text-slate-200">Windows ログイン時に自動起動する</span>
      </label>
    </div>,

    // Step 3: 文字起こし
    <div key="transcribe" className="space-y-4">
      <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100">📝 文字起こし（オフライン）</h2>
      <p className="text-sm leading-relaxed text-slate-600 dark:text-slate-300">
        録音した音声は whisper.cpp で<strong>完全オフライン</strong>文字起こしできます。
        利用には初回のみ2つのダウンロードが必要です（設定画面のボタンで完結します）:
      </p>
      <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-700 dark:text-slate-200">
        <li>whisper.cpp 本体（約 10MB）</li>
        <li>認識モデル（small 約 466MB を推奨）</li>
      </ol>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        「設定を開く」を押すと、文字起こしセクションからすぐにセットアップできます。
        使わない場合はこのままスキップして構いません。
      </p>
    </div>,
  ];

  const isLast = step === steps.length - 1;

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-slate-900/60 p-4">
      <div className="w-[min(94vw,34rem)] rounded-2xl bg-white p-8 shadow-2xl dark:bg-slate-900">
        {steps[step]}

        <div className="mt-6 flex items-center justify-center gap-1.5">
          {steps.map((_, i) => (
            <span
              key={i}
              className={`h-1.5 rounded-full transition-all ${
                i === step ? 'w-6 bg-brand-600' : 'w-1.5 bg-slate-300 dark:bg-slate-600'
              }`}
            />
          ))}
        </div>

        <div className="mt-6 flex items-center justify-between">
          <button
            onClick={() => finish(false)}
            className="text-xs text-slate-400 hover:text-slate-600 hover:underline dark:hover:text-slate-300"
          >
            スキップ
          </button>
          <div className="flex gap-2">
            {step > 0 && (
              <button
                onClick={() => setStep((s) => s - 1)}
                className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
              >
                戻る
              </button>
            )}
            {isLast ? (
              <>
                <button
                  onClick={() => finish(false)}
                  className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                >
                  完了
                </button>
                <button
                  onClick={() => finish(true)}
                  className="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
                >
                  設定を開いてセットアップ
                </button>
              </>
            ) : (
              <button
                onClick={() => setStep((s) => s + 1)}
                className="rounded-md bg-brand-600 px-5 py-2 text-sm font-semibold text-white hover:bg-brand-700"
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
