import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, COMPLETION_MARKER_FILE_NAME, STALE_BACKUP_AGE_MS } from '../updateLeftoverPolicy.ts';

// 入れ替え（PowerShell スクリプト）が完了する前に電源断・強制終了が起きると、.old だけが
// 残った状態になりうる。無条件に削除すると「復旧の唯一の材料」を消してしまうため、
// 完了マーカーの有無・経過時間から安全に削除してよいかを決める。Pane の
// UpdateLeftoverPolicyTests.cs と同じ観点を CallStack 側の名前で固定する。

test('.old が無ければ None（通常の起動）', () => {
  assert.equal(decide({
    oldInstallDirExists: false,
    markerExists: false,
    backupAgeMs: null,
    currentExeIsNewerThanBackup: false,
  }), 'None');
  // マーカーだけ残っていても .old が無ければ None
  assert.equal(decide({
    oldInstallDirExists: false,
    markerExists: true,
    backupAgeMs: null,
    currentExeIsNewerThanBackup: false,
  }), 'None');
});

test('完了マーカーがあれば DeleteBackups（入れ替えは最後までやり遂げている）', () => {
  assert.equal(decide({
    oldInstallDirExists: true,
    markerExists: true,
    backupAgeMs: 1000,
    currentExeIsNewerThanBackup: false,
  }), 'DeleteBackups');
});

test('マーカーが無く、経過時間も分からなければ KeepBackups（安全側）', () => {
  assert.equal(decide({
    oldInstallDirExists: true,
    markerExists: false,
    backupAgeMs: null,
    currentExeIsNewerThanBackup: true,
  }), 'KeepBackups');
});

test('マーカーが無く、まだ新しければ KeepBackups（入れ替え直後の可能性がある）', () => {
  assert.equal(decide({
    oldInstallDirExists: true,
    markerExists: false,
    backupAgeMs: 60_000, // 1分
    currentExeIsNewerThanBackup: true,
  }), 'KeepBackups');
});

test('マーカーは無いが 24時間以上経ち、いま動いている exe が .old より新しければ DeleteStaleBackups', () => {
  assert.equal(decide({
    oldInstallDirExists: true,
    markerExists: false,
    backupAgeMs: STALE_BACKUP_AGE_MS,
    currentExeIsNewerThanBackup: true,
  }), 'DeleteStaleBackups');
  assert.equal(decide({
    oldInstallDirExists: true,
    markerExists: false,
    backupAgeMs: STALE_BACKUP_AGE_MS + 60_000,
    currentExeIsNewerThanBackup: true,
  }), 'DeleteStaleBackups');
});

test('24時間以上経っていても、いま動いている exe が .old より新しくなければ KeepBackups（片方だけでは足りない）', () => {
  assert.equal(decide({
    oldInstallDirExists: true,
    markerExists: false,
    backupAgeMs: STALE_BACKUP_AGE_MS + 60_000,
    currentExeIsNewerThanBackup: false,
  }), 'KeepBackups');
});

test('完了マーカーのファイル名は callstack-update.ok', () => {
  assert.equal(COMPLETION_MARKER_FILE_NAME, 'callstack-update.ok');
});
