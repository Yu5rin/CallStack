import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as nodeFs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  planDataDirMigration, migrateDataDir, isSameDir, MIGRATED_NOTICE_FILE_NAME, type MigrationFs,
} from '../dataDirMigration.ts';

async function write(p: string, content: string): Promise<void> {
  await nodeFs.mkdir(path.dirname(p), { recursive: true });
  await nodeFs.writeFile(p, content);
}

async function exists(p: string): Promise<boolean> {
  return nodeFs.access(p).then(() => true, () => false);
}

async function setup(): Promise<{ root: string; oldDir: string; newDir: string }> {
  const root = await nodeFs.mkdtemp(path.join(os.tmpdir(), 'callstack-datamig-'));
  return { root, oldDir: path.join(root, 'AppData', 'callstack'), newDir: path.join(root, 'App', 'data') };
}

async function putOldData(oldDir: string): Promise<void> {
  await write(path.join(oldDir, 'data.json'), '{"calls":[{"id":"a"}]}');
  await write(path.join(oldDir, 'recordings', 'a.mp3'), 'mp3');
  await write(path.join(oldDir, 'models', 'ggml-small.bin'), 'model');
  await write(path.join(oldDir, 'logs', 'app.log'), 'old log');
  await write(path.join(oldDir, 'Local Storage', 'leveldb', '000003.log'), 'ls');
  await write(path.join(oldDir, 'Cache', 'Cache_Data', 'f_000001'), 'cache');
  await write(path.join(oldDir, 'GPUCache', 'index'), 'gpu');
}

test('planDataDirMigration: 判断の組み合わせ', () => {
  // 新規インストール（旧フォルダに data.json が無い）
  assert.deepEqual(
    planDataDirMigration({ sameDir: false, oldHasData: false, newHasData: false, newState: 'absent' }),
    { action: 'none', reason: 'no-old-data' },
  );
  // 旧にあり、新が無い → rename
  assert.deepEqual(
    planDataDirMigration({ sameDir: false, oldHasData: true, newHasData: false, newState: 'absent' }),
    { action: 'migrate', tryRename: true },
  );
  // 新が空フォルダ → rename
  assert.deepEqual(
    planDataDirMigration({ sameDir: false, oldHasData: true, newHasData: false, newState: 'empty' }),
    { action: 'migrate', tryRename: true },
  );
  // 新に何かある（data.json は無い）→ コピー
  assert.deepEqual(
    planDataDirMigration({ sameDir: false, oldHasData: true, newHasData: false, newState: 'non-empty' }),
    { action: 'migrate', tryRename: false },
  );
  // 新に既にデータ → 何もしない
  assert.deepEqual(
    planDataDirMigration({ sameDir: false, oldHasData: true, newHasData: true, newState: 'non-empty' }),
    { action: 'none', reason: 'new-has-data' },
  );
  // 同じ場所
  assert.deepEqual(
    planDataDirMigration({ sameDir: true, oldHasData: true, newHasData: false, newState: 'absent' }),
    { action: 'none', reason: 'same-dir' },
  );
});

test('isSameDir: Windows では大文字小文字・末尾の区切りを無視する', () => {
  assert.equal(isSameDir('/a/CallStack', '/a/callstack/', true), true);
  assert.equal(isSameDir('/a/CallStack', '/a/callstack', false), false);
});

test('新規インストール: 旧フォルダが無ければ何もしない', async () => {
  const { root, oldDir, newDir } = await setup();
  try {
    const r = await migrateDataDir({ oldDir, newDir, fs: nodeFs, caseInsensitive: false });
    assert.equal(r.result, 'none');
    assert.equal(await exists(newDir), false);
  } finally {
    await nodeFs.rm(root, { recursive: true, force: true });
  }
});

test('旧フォルダに data.json が無ければ（記録の無い旧フォルダ）何もしない', async () => {
  const { root, oldDir, newDir } = await setup();
  try {
    await write(path.join(oldDir, 'Cache', 'x'), 'x');
    const r = await migrateDataDir({ oldDir, newDir, fs: nodeFs, caseInsensitive: false });
    assert.equal(r.result, 'none');
    assert.equal(await exists(path.join(oldDir, 'Cache', 'x')), true);
  } finally {
    await nodeFs.rm(root, { recursive: true, force: true });
  }
});

test('旧にデータあり・新が空フォルダ: フォルダごと rename で移る（旧フォルダは無くなる）', async () => {
  const { root, oldDir, newDir } = await setup();
  try {
    await putOldData(oldDir);
    await nodeFs.mkdir(newDir, { recursive: true }); // 書き込み確認で作られた空の data
    const r = await migrateDataDir({ oldDir, newDir, fs: nodeFs, caseInsensitive: false });
    assert.equal(r.result, 'renamed');
    assert.equal(await nodeFs.readFile(path.join(newDir, 'data.json'), 'utf-8'), '{"calls":[{"id":"a"}]}');
    assert.equal(await nodeFs.readFile(path.join(newDir, 'recordings', 'a.mp3'), 'utf-8'), 'mp3');
    assert.equal(await exists(path.join(newDir, 'Local Storage', 'leveldb', '000003.log')), true);
    assert.equal(await exists(oldDir), false);
  } finally {
    await nodeFs.rm(root, { recursive: true, force: true });
  }
});

test('旧にデータあり・新フォルダ自体が無い: rename で移る', async () => {
  const { root, oldDir, newDir } = await setup();
  try {
    await putOldData(oldDir);
    const r = await migrateDataDir({ oldDir, newDir, fs: nodeFs, caseInsensitive: false });
    assert.equal(r.result, 'renamed');
    assert.equal(await exists(path.join(newDir, 'data.json')), true);
  } finally {
    await nodeFs.rm(root, { recursive: true, force: true });
  }
});

test('rename が失敗したらコピーに切り替える: キャッシュ類は除き、旧フォルダは残して 移行済み.txt を置く', async () => {
  const { root, oldDir, newDir } = await setup();
  try {
    await putOldData(oldDir);
    await nodeFs.mkdir(newDir, { recursive: true });
    const failingFs: MigrationFs = {
      ...nodeFs,
      rename: async () => { throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' }); },
    };
    const r = await migrateDataDir({
      oldDir, newDir, fs: failingFs, caseInsensitive: false, now: () => new Date('2026-10-10T00:00:00.000Z'),
    });
    assert.equal(r.result, 'copied');
    assert.ok(r.logs.some((l) => l.includes('EXDEV')));
    // 本体・録音・モデル・ログはコピーされる
    assert.equal(await nodeFs.readFile(path.join(newDir, 'data.json'), 'utf-8'), '{"calls":[{"id":"a"}]}');
    assert.equal(await exists(path.join(newDir, 'recordings', 'a.mp3')), true);
    assert.equal(await exists(path.join(newDir, 'models', 'ggml-small.bin')), true);
    assert.equal(await exists(path.join(newDir, 'logs', 'app.log')), true);
    assert.equal(await exists(path.join(newDir, 'Local Storage', 'leveldb', '000003.log')), true);
    // Chromium のキャッシュ類は除く
    assert.equal(await exists(path.join(newDir, 'Cache')), false);
    assert.equal(await exists(path.join(newDir, 'GPUCache')), false);
    // 旧フォルダは残り、案内ファイルがある
    assert.equal(await exists(path.join(oldDir, 'data.json')), true);
    const notice = await nodeFs.readFile(path.join(oldDir, MIGRATED_NOTICE_FILE_NAME), 'utf-8');
    assert.ok(notice.includes(newDir));
  } finally {
    await nodeFs.rm(root, { recursive: true, force: true });
  }
});

test('新しい側に他のファイルがある（data.json は無い）: rename せずコピーで足す', async () => {
  const { root, oldDir, newDir } = await setup();
  try {
    await putOldData(oldDir);
    await write(path.join(newDir, 'logs', 'app.log'), 'new log');
    let renameCalled = false;
    const spyFs: MigrationFs = {
      ...nodeFs,
      rename: async (...a: Parameters<typeof nodeFs.rename>) => { renameCalled = true; return nodeFs.rename(...a); },
    };
    const r = await migrateDataDir({ oldDir, newDir, fs: spyFs, caseInsensitive: false });
    assert.equal(r.result, 'copied');
    assert.equal(renameCalled, false);
    assert.equal(await exists(path.join(newDir, 'data.json')), true);
  } finally {
    await nodeFs.rm(root, { recursive: true, force: true });
  }
});

test('新しい側に既にデータがあれば何もしない（旧フォルダもそのまま）', async () => {
  const { root, oldDir, newDir } = await setup();
  try {
    await putOldData(oldDir);
    await write(path.join(newDir, 'data.json'), '{"calls":[{"id":"new"}]}');
    const r = await migrateDataDir({ oldDir, newDir, fs: nodeFs, caseInsensitive: false });
    assert.equal(r.result, 'none');
    assert.equal(await nodeFs.readFile(path.join(newDir, 'data.json'), 'utf-8'), '{"calls":[{"id":"new"}]}');
    assert.equal(await exists(path.join(oldDir, 'data.json')), true);
    assert.equal(await exists(path.join(oldDir, MIGRATED_NOTICE_FILE_NAME)), false);
  } finally {
    await nodeFs.rm(root, { recursive: true, force: true });
  }
});

test('旧も新も空（どちらにも data.json が無い）: 何もしない', async () => {
  const { root, oldDir, newDir } = await setup();
  try {
    await nodeFs.mkdir(oldDir, { recursive: true });
    await nodeFs.mkdir(newDir, { recursive: true });
    const r = await migrateDataDir({ oldDir, newDir, fs: nodeFs, caseInsensitive: false });
    assert.equal(r.result, 'none');
    assert.deepEqual(await nodeFs.readdir(newDir), []);
  } finally {
    await nodeFs.rm(root, { recursive: true, force: true });
  }
});

test('コピーが途中で失敗したら failed。data.json は最後なので新しい側に残らず、次回やり直せる', async () => {
  const { root, oldDir, newDir } = await setup();
  try {
    await putOldData(oldDir);
    let failOnce = true;
    const failingFs: MigrationFs = {
      ...nodeFs,
      rename: async () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); },
      copyFile: async (src, dst, ...rest) => {
        if (failOnce && String(src).endsWith('a.mp3')) {
          failOnce = false;
          throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        }
        return (nodeFs.copyFile as (...a: unknown[]) => Promise<void>)(src, dst, ...rest);
      },
    };
    const r1 = await migrateDataDir({ oldDir, newDir, fs: failingFs, caseInsensitive: false });
    assert.equal(r1.result, 'failed');
    assert.equal(await exists(path.join(newDir, 'data.json')), false);
    assert.equal(await exists(path.join(oldDir, MIGRATED_NOTICE_FILE_NAME)), false);

    // 次回の起動: 続きからコピーして完了する
    const r2 = await migrateDataDir({ oldDir, newDir, fs: failingFs, caseInsensitive: false });
    assert.equal(r2.result, 'copied');
    assert.equal(await exists(path.join(newDir, 'recordings', 'a.mp3')), true);
    assert.equal(await exists(path.join(newDir, 'data.json')), true);
  } finally {
    await nodeFs.rm(root, { recursive: true, force: true });
  }
});

test('新旧が同じ場所なら何もしない', async () => {
  const { root, oldDir } = await setup();
  try {
    await putOldData(oldDir);
    const r = await migrateDataDir({ oldDir, newDir: oldDir, fs: nodeFs, caseInsensitive: false });
    assert.equal(r.result, 'none');
    assert.equal(r.detail, 'same-dir');
  } finally {
    await nodeFs.rm(root, { recursive: true, force: true });
  }
});
