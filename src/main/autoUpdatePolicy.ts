/**
 * 自動入れ替え（再起動）をいま行ってよいかを決める純粋なロジック。
 * electron に依存しないので node:test でそのまま検証できる。
 *
 * 録音・記録・文字起こしを中断しないことが最優先なので、1つでも該当すれば待つ。
 */

/** 再起動を待たせている理由 */
export type AutoApplyBlockReason = 'call' | 'recording' | 'finalizing' | 'transcription';

export interface AutoApplyInput {
  /** 進行中の記録（通話・会議）がある */
  activeCall: boolean;
  /** 録音サービスが録音中（一時停止を含む） */
  recording: boolean;
  /** 録音の保存（webm→mp3 変換）が実行中 */
  finalizing: boolean;
  /** 文字起こしが実行中、または待機列にある */
  transcriptionBusy: boolean;
}

export type AutoApplyDecision =
  | { ok: true }
  | { ok: false; reason: AutoApplyBlockReason; message: string };

/** 確認の優先順。記録中を最優先で理由として伝える。 */
export function canAutoApply(input: AutoApplyInput): AutoApplyDecision {
  if (input.activeCall) return { ok: false, reason: 'call', message: '記録が進行中' };
  if (input.recording) return { ok: false, reason: 'recording', message: '録音中' };
  if (input.finalizing) return { ok: false, reason: 'finalizing', message: '録音の保存中' };
  if (input.transcriptionBusy) return { ok: false, reason: 'transcription', message: '文字起こしの実行中または待機中' };
  return { ok: true };
}

/** 画面の表示用: 何が終わるのを待っているか（「…が終わったら自動で再起動します」の「…」）。 */
export function waitingTargetLabel(reason: AutoApplyBlockReason): string {
  return reason === 'transcription' ? '文字起こし' : '記録';
}

/** 終了時に入れ替えスクリプトを起動すべきか（再起動はしない）。 */
export function shouldApplyOnQuit(input: {
  hasPreparedUpdate: boolean;
  autoInstallActive: boolean;
  postponed: boolean;
  alreadyApplying: boolean;
  /** 記録中・録音の保存中でない（終了が中断される可能性がない） */
  quietNow: boolean;
}): boolean {
  if (!input.hasPreparedUpdate || input.alreadyApplying || !input.quietNow) return false;
  return input.postponed || input.autoInstallActive;
}

/** 再起動までの猶予（秒） */
export const AUTO_RESTART_COUNTDOWN_SEC = 30;
