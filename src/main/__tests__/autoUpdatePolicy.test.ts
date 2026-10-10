import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canAutoApply, waitingTargetLabel, shouldApplyOnQuit, AUTO_RESTART_COUNTDOWN_SEC } from '../autoUpdatePolicy.ts';

const idle = { activeCall: false, recording: false, finalizing: false, transcriptionBusy: false };

test('何も動いていなければ適用してよい', () => {
  assert.deepEqual(canAutoApply(idle), { ok: true });
});

test('記録中は待つ', () => {
  const r = canAutoApply({ ...idle, activeCall: true });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'call');
});

test('録音中・録音の保存中・文字起こし中もそれぞれ待つ', () => {
  const rec = canAutoApply({ ...idle, recording: true });
  const fin = canAutoApply({ ...idle, finalizing: true });
  const tr = canAutoApply({ ...idle, transcriptionBusy: true });
  assert.ok(!rec.ok && rec.reason === 'recording');
  assert.ok(!fin.ok && fin.reason === 'finalizing');
  assert.ok(!tr.ok && tr.reason === 'transcription');
});

test('複数該当するときは記録中を優先して伝える', () => {
  const r = canAutoApply({ activeCall: true, recording: true, finalizing: true, transcriptionBusy: true });
  assert.ok(!r.ok && r.reason === 'call');
  const r2 = canAutoApply({ ...idle, finalizing: true, transcriptionBusy: true });
  assert.ok(!r2.ok && r2.reason === 'finalizing');
});

test('待ち対象の表示ラベル', () => {
  assert.equal(waitingTargetLabel('transcription'), '文字起こし');
  assert.equal(waitingTargetLabel('call'), '記録');
  assert.equal(waitingTargetLabel('finalizing'), '記録');
});

test('終了時の適用: 自動入れ替えON・準備済み・静かなときだけ', () => {
  const base = { hasPreparedUpdate: true, autoInstallActive: true, postponed: false, alreadyApplying: false, quietNow: true };
  assert.equal(shouldApplyOnQuit(base), true);
  assert.equal(shouldApplyOnQuit({ ...base, hasPreparedUpdate: false }), false);
  assert.equal(shouldApplyOnQuit({ ...base, alreadyApplying: true }), false);
  assert.equal(shouldApplyOnQuit({ ...base, quietNow: false }), false);
});

test('終了時の適用: OFFでも「あとで」を選んでいれば適用する', () => {
  const base = { hasPreparedUpdate: true, autoInstallActive: false, postponed: false, alreadyApplying: false, quietNow: true };
  assert.equal(shouldApplyOnQuit(base), false);
  assert.equal(shouldApplyOnQuit({ ...base, postponed: true }), true);
});

test('猶予は30秒', () => {
  assert.equal(AUTO_RESTART_COUNTDOWN_SEC, 30);
});
