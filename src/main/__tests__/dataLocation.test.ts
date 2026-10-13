import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  planDataLocation, resolveDataLocation, probeWritableDir, PORTABLE_DATA_DIR_NAME,
  type DataLocationInput,
} from '../dataLocation.ts';

const base: DataLocationInput = {
  isPackaged: true,
  platform: 'win32',
  execPath: 'C:\\Tools\\CallStack\\CallStack.exe',
  applyMode: false,
  defaultDir: 'C:\\Users\\u\\AppData\\Roaming\\callstack',
  tmpDir: 'C:\\Users\\u\\AppData\\Local\\Temp',
  pid: 4242,
};

test('製品版の Windows: exe の隣の data を使う', () => {
  assert.deepEqual(planDataLocation(base), { kind: 'portable', dir: 'C:\\Tools\\CallStack\\data' });
  assert.equal(PORTABLE_DATA_DIR_NAME, 'data');
});

test('開発モード・Windows 以外は従来どおり', () => {
  assert.equal(planDataLocation({ ...base, isPackaged: false }).kind, 'default');
  assert.equal(planDataLocation({ ...base, platform: 'linux', execPath: '/opt/callstack/callstack' }).kind, 'default');
  assert.equal(planDataLocation({ ...base, platform: 'darwin' }).kind, 'default');
});

test('更新の適用モード: exe の隣ではなく一時フォルダ（pid ごと）を使う', () => {
  const plan = planDataLocation({ ...base, applyMode: true, execPath: 'C:\\Tools\\.callstack-update-staging\\CallStack.exe' });
  assert.deepEqual(plan, { kind: 'applier', dir: 'C:\\Users\\u\\AppData\\Local\\Temp\\callstack-applier-4242' });
  // 開発モードでも適用モードなら一時フォルダ
  assert.equal(planDataLocation({ ...base, applyMode: true, isPackaged: false }).kind, 'applier');
});

test('単一 exe のポータブル版は元の exe の置き場所を使う', () => {
  const plan = planDataLocation({ ...base, execPath: 'C:\\Temp\\abc\\CallStack.exe', portableExecutableDir: 'E:\\USB' });
  assert.deepEqual(plan, { kind: 'portable', dir: 'E:\\USB\\data' });
});

test('インストーラ版は exe の隣に data を置かない', () => {
  assert.equal(planDataLocation({ ...base, installedByInstaller: true }).kind, 'default');
});

test('resolveDataLocation: 書き込めれば portable、書き込めなければ従来の場所に fallback して理由を残す', () => {
  const plan = planDataLocation(base);
  const ok = resolveDataLocation(plan, base.defaultDir, { ok: true });
  assert.equal(ok.mode, 'portable');
  assert.equal(ok.dir, 'C:\\Tools\\CallStack\\data');
  assert.equal(ok.reason, null);
  assert.equal(ok.defaultDir, base.defaultDir);

  const ng = resolveDataLocation(plan, base.defaultDir, { ok: false, error: 'EACCES: permission denied' });
  assert.equal(ng.mode, 'fallback');
  assert.equal(ng.dir, base.defaultDir);
  assert.match(ng.reason ?? '', /C:\\Tools\\CallStack\\data/);
  assert.match(ng.reason ?? '', /EACCES/);

  const dev = resolveDataLocation(planDataLocation({ ...base, isPackaged: false }), base.defaultDir, null);
  assert.equal(dev.mode, 'default');
  assert.equal(dev.dir, base.defaultDir);

  const applier = resolveDataLocation(planDataLocation({ ...base, applyMode: true }), base.defaultDir, { ok: true });
  assert.equal(applier.mode, 'applier');
  assert.match(applier.dir, /callstack-applier-4242$/);
});

test('probeWritableDir: 書ける場所では true で確認ファイルを残さない。書けない場所では false', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'callstack-probe-'));
  try {
    const dir = path.join(root, 'sub', 'data');
    assert.deepEqual(probeWritableDir(dir, fs, 1), { ok: true });
    assert.deepEqual(fs.readdirSync(dir), []);

    // data が「ファイル」で作れない場合
    const blocked = path.join(root, 'blocked');
    fs.writeFileSync(blocked, 'x');
    const r = probeWritableDir(path.join(blocked, 'data'), fs, 1);
    assert.equal(r.ok, false);
    assert.ok(r.error);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
