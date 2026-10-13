import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as nodeFs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runApplyUpdate, encodeApplyArg, parseApplyArg, analyzeApplyLog, waitForPidExit,
  isBackupDirName, isPreservedEntryName, type ApplierFs, type ApplyUpdateArgs,
} from '../updateApplier.ts';

// 自動更新の入れ替え(新しい版の exe 自身が行う)を、実ファイルシステムの一時フォルダで検証する。

async function write(p: string, content: string): Promise<void> {
  await nodeFs.mkdir(path.dirname(p), { recursive: true });
  await nodeFs.writeFile(p, content);
}

async function listFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const e of await nodeFs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await listFiles(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

async function setup(): Promise<{ root: string; installDir: string; stagingDir: string; logFile: string; args: ApplyUpdateArgs }> {
  const root = await nodeFs.mkdtemp(path.join(os.tmpdir(), 'callstack-apply-'));
  const installDir = path.join(root, '追加', 'CallStack');
  const stagingDir = path.join(root, '追加', '.callstack-update-staging');
  const logFile = path.join(root, 'userData', 'logs', 'update-apply.log');
  await write(path.join(installDir, 'CallStack.exe'), 'old-exe');
  await write(path.join(installDir, 'resources', 'app.asar'), 'old-asar');
  await write(path.join(installDir, 'resources', 'whisper', 'whisper-cli.exe'), 'user-whisper');
  await write(path.join(installDir, 'resources', 'whisper', 'README.txt'), 'old-readme');
  await write(path.join(stagingDir, 'CallStack.exe'), 'new-exe');
  await write(path.join(stagingDir, 'resources', 'app.asar'), 'new-asar');
  await write(path.join(stagingDir, 'resources', 'whisper', 'README.txt'), 'new-readme');
  const args: ApplyUpdateArgs = { installDir, stagingDir, oldPid: 4242, relaunch: true, logFile, version: '2.11.0' };
  return { root, installDir, stagingDir, logFile, args };
}

function makeDeps(fs: ApplierFs, spawned: string[] = [], sleeps: number[] = []) {
  return {
    fs,
    waitForPidExit: async () => {},
    sleep: async (ms: number) => { sleeps.push(ms); },
    spawnApp: (exe: string) => { spawned.push(exe); },
    exeName: 'CallStack.exe',
    now: () => new Date('2026-10-10T01:02:03.456Z'),
  };
}

test('正常系: 新しい版が配置され、旧ファイルは退避フォルダに入り、手置きの whisper は引き継がれる', async () => {
  const { root, installDir, logFile, args } = await setup();
  try {
    const spawned: string[] = [];
    const res = await runApplyUpdate(args, makeDeps(nodeFs, spawned));
    assert.equal(res.ok, true);

    assert.equal(await nodeFs.readFile(path.join(installDir, 'CallStack.exe'), 'utf-8'), 'new-exe');
    assert.equal(await nodeFs.readFile(path.join(installDir, 'resources', 'app.asar'), 'utf-8'), 'new-asar');
    // 新しい版に同梱された README は新しい側が正
    assert.equal(await nodeFs.readFile(path.join(installDir, 'resources', 'whisper', 'README.txt'), 'utf-8'), 'new-readme');
    // 手で置いたファイルは引き継ぐ
    assert.equal(await nodeFs.readFile(path.join(installDir, 'resources', 'whisper', 'whisper-cli.exe'), 'utf-8'), 'user-whisper');

    // 退避フォルダに旧ファイルが残る
    const backups = (await nodeFs.readdir(installDir)).filter(isBackupDirName);
    assert.equal(backups.length, 1);
    assert.equal(backups[0], '.callstack-old-20261010T010203');
    const backupFiles = await listFiles(path.join(installDir, backups[0]));
    assert.ok(backupFiles.includes('CallStack.exe'));
    assert.ok(backupFiles.includes('resources/app.asar'));
    assert.equal(await nodeFs.readFile(path.join(installDir, backups[0], 'CallStack.exe'), 'utf-8'), 'old-exe');

    // マーカー
    const marker = await nodeFs.readFile(path.join(installDir, 'callstack-update.ok'), 'utf-8');
    assert.ok(marker.startsWith('2.11.0\n'));

    // 再起動
    assert.deepEqual(spawned, [path.join(installDir, 'CallStack.exe')]);

    // ログ
    const log = await nodeFs.readFile(logFile, 'utf-8');
    assert.match(log, /^\d{4}-\d\d-\d\dT.*Z apply start:/m);
    assert.match(log, /apply succeeded/);
    assert.match(log, /wrote completion marker/);
    assert.match(log, /relaunched app/);
    assert.equal(analyzeApplyLog(log).outcome, 'succeeded');
  } finally {
    await nodeFs.rm(root, { recursive: true, force: true });
  }
});

test('relaunch=false(終了時の適用)では入れ替えるだけで起動しない', async () => {
  const { root, installDir, args } = await setup();
  try {
    const spawned: string[] = [];
    const res = await runApplyUpdate({ ...args, relaunch: false }, makeDeps(nodeFs, spawned));
    assert.equal(res.ok, true);
    assert.deepEqual(spawned, []);
    assert.equal(await nodeFs.readFile(path.join(installDir, 'CallStack.exe'), 'utf-8'), 'new-exe');
  } finally {
    await nodeFs.rm(root, { recursive: true, force: true });
  }
});

test('ロールバック: コピーが途中で失敗したら、インストール先は元のファイルに戻り、元の版を起動する', async () => {
  const { root, installDir, logFile, args } = await setup();
  try {
    const failingFs: ApplierFs = {
      ...nodeFs,
      copyFile: async (src, dst, ...rest) => {
        if (String(src).endsWith('app.asar')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        return (nodeFs.copyFile as (...a: unknown[]) => Promise<void>)(src, dst, ...rest);
      },
    };
    const spawned: string[] = [];
    const res = await runApplyUpdate(args, makeDeps(failingFs, spawned));
    assert.equal(res.ok, false);
    assert.equal(res.rolledBack, true);

    assert.deepEqual(await listFiles(installDir), [
      'CallStack.exe', 'resources/app.asar', 'resources/whisper/README.txt', 'resources/whisper/whisper-cli.exe',
    ]);
    assert.equal(await nodeFs.readFile(path.join(installDir, 'CallStack.exe'), 'utf-8'), 'old-exe');
    assert.equal(await nodeFs.readFile(path.join(installDir, 'resources', 'app.asar'), 'utf-8'), 'old-asar');
    assert.equal(await nodeFs.readFile(path.join(installDir, 'resources', 'whisper', 'whisper-cli.exe'), 'utf-8'), 'user-whisper');
    assert.equal((await nodeFs.readdir(installDir)).some(isBackupDirName), false);
    // 失敗時も、元の版を起動する
    assert.deepEqual(spawned, [path.join(installDir, 'CallStack.exe')]);

    const log = await nodeFs.readFile(logFile, 'utf-8');
    assert.match(log, /apply FAILED: disk full/);
    assert.match(log, /rollback succeeded/);
    const summary = analyzeApplyLog(log);
    assert.equal(summary.outcome, 'failed');
    assert.equal(summary.error, 'disk full');
  } finally {
    await nodeFs.rm(root, { recursive: true, force: true });
  }
});

test('再試行: rename が EBUSY を 2 回返しても、その後成功すれば入れ替えが完了する', async () => {
  const { root, installDir, logFile, args } = await setup();
  try {
    let busy = 2;
    const flakyFs: ApplierFs = {
      ...nodeFs,
      rename: async (from, to) => {
        if (busy > 0 && String(from).endsWith('CallStack.exe')) {
          busy -= 1;
          throw Object.assign(new Error('resource busy'), { code: 'EBUSY' });
        }
        return nodeFs.rename(from, to);
      },
    };
    const sleeps: number[] = [];
    const res = await runApplyUpdate(args, makeDeps(flakyFs, [], sleeps));
    assert.equal(res.ok, true);
    assert.equal(busy, 0);
    assert.equal(await nodeFs.readFile(path.join(installDir, 'CallStack.exe'), 'utf-8'), 'new-exe');
    // バックオフ(250ms, 500ms)で待っている
    assert.ok(sleeps.includes(250) && sleeps.includes(500));
    assert.match(await nodeFs.readFile(logFile, 'utf-8'), /retry move CallStack\.exe: EBUSY/);
  } finally {
    await nodeFs.rm(root, { recursive: true, force: true });
  }
});

test('EBUSY が続いて上限を超えたら諦めてロールバックする', async () => {
  const { root, installDir, args } = await setup();
  try {
    const busyFs: ApplierFs = {
      ...nodeFs,
      rename: async (from, to) => {
        // resources だけが掴まれ続けている(exe は先に退避済み)
        if (String(from).endsWith(`${path.sep}resources`) && !String(to).includes('.callstack-old-')) return nodeFs.rename(from, to);
        if (String(from).endsWith(`${path.sep}resources`)) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        return nodeFs.rename(from, to);
      },
    };
    const res = await runApplyUpdate(args, { ...makeDeps(busyFs), retryTotalMs: 3000 });
    assert.equal(res.ok, false);
    assert.equal(res.rolledBack, true);
    assert.equal(await nodeFs.readFile(path.join(installDir, 'CallStack.exe'), 'utf-8'), 'old-exe');
    assert.equal(await nodeFs.readFile(path.join(installDir, 'resources', 'app.asar'), 'utf-8'), 'old-asar');
  } finally {
    await nodeFs.rm(root, { recursive: true, force: true });
  }
});

test('ステージングに exe が無ければ何も動かさずに失敗する', async () => {
  const { root, installDir, stagingDir, args } = await setup();
  try {
    await nodeFs.rm(path.join(stagingDir, 'CallStack.exe'));
    const res = await runApplyUpdate(args, makeDeps(nodeFs));
    assert.equal(res.ok, false);
    assert.equal(await nodeFs.readFile(path.join(installDir, 'CallStack.exe'), 'utf-8'), 'old-exe');
  } finally {
    await nodeFs.rm(root, { recursive: true, force: true });
  }
});

test('起動引数は 1 トークンの base64url で、日本語パスも往復できる', () => {
  const args: ApplyUpdateArgs = {
    installDir: 'C:\\追加\\CallStack', stagingDir: 'C:\\追加\\.callstack-update-staging', oldPid: 123,
    relaunch: true, logFile: 'C:\\Users\\山田\\AppData\\Roaming\\callstack\\logs\\update-apply.log', version: '2.11.0',
  };
  const token = encodeApplyArg(args);
  assert.match(token, /^--callstack-apply-update=[A-Za-z0-9_-]+$/);
  assert.deepEqual(parseApplyArg(['C:\\app\\CallStack.exe', '--flag', token]), args);
});

test('起動引数が無い・壊れている場合は通常起動(null)', () => {
  assert.equal(parseApplyArg(['CallStack.exe']), null);
  assert.equal(parseApplyArg(['CallStack.exe', '--callstack-apply-update=%%%']), null);
  const bad = `--callstack-apply-update=${Buffer.from(JSON.stringify({ installDir: 'x' })).toString('base64url')}`;
  assert.equal(parseApplyArg(['CallStack.exe', bad]), null);
});

test('waitForPidExit: ESRCH で終了を検知し、生きている間は間隔を空けて待つ。上限で諦める', async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const gone = await waitForPidExit(1, {
    kill: () => { calls += 1; if (calls >= 3) throw Object.assign(new Error('x'), { code: 'ESRCH' }); },
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(gone, true);
  assert.deepEqual(sleeps, [500, 500]);

  const alive = await waitForPidExit(1, { kill: () => {}, sleep: async () => {}, timeoutMs: 2000 });
  assert.equal(alive, false);
  // EPERM は生存扱い
  const eperm = await waitForPidExit(1, {
    kill: () => { throw Object.assign(new Error('x'), { code: 'EPERM' }); }, sleep: async () => {}, timeoutMs: 1000,
  });
  assert.equal(eperm, false);
});

test('analyzeApplyLog: 最後の試行だけを見る。開始のみなら incomplete、ログが空なら none', () => {
  const t = '2026-10-10T00:00:00.000Z';
  assert.equal(analyzeApplyLog('').outcome, 'none');
  const failedThenOk = [
    `${t} apply start: v2.11.0 ...`, `${t} apply FAILED: busy`, `${t} rollback succeeded`,
    `2026-10-11T00:00:00.000Z apply start: v2.11.0 ...`, `2026-10-11T00:00:01.000Z apply succeeded: v2.11.0`,
  ].join('\n');
  assert.equal(analyzeApplyLog(failedThenOk).outcome, 'succeeded');
  assert.equal(analyzeApplyLog(`${t} apply start: v2.11.0 ...\n${t} waiting for pid 1 to exit\n`).outcome, 'incomplete');
  const f = analyzeApplyLog(`${t} apply start: v1\n${t} apply FAILED: EBUSY x\n`);
  assert.equal(f.outcome, 'failed');
  assert.equal(f.startedAt, t);
});

// ---- データフォルダ（exe の隣の data）は入れ替えで絶対に動かさない ----

const DATA_JSON = '{"version":1,"calls":[{"id":"a"}],"settings":{}}';
const APP_LOG = '2026-10-10T00:00:00.000Z [app] hello\n';

async function putData(installDir: string): Promise<void> {
  await write(path.join(installDir, 'data', 'data.json'), DATA_JSON);
  await write(path.join(installDir, 'data', 'logs', 'app.log'), APP_LOG);
  await write(path.join(installDir, 'data', 'recordings', 'x.mp3'), 'mp3-bytes');
}

async function assertDataIntact(installDir: string): Promise<void> {
  assert.equal(await nodeFs.readFile(path.join(installDir, 'data', 'data.json'), 'utf-8'), DATA_JSON);
  assert.equal(await nodeFs.readFile(path.join(installDir, 'data', 'logs', 'app.log'), 'utf-8'), APP_LOG);
  assert.equal(await nodeFs.readFile(path.join(installDir, 'data', 'recordings', 'x.mp3'), 'utf-8'), 'mp3-bytes');
  assert.deepEqual(await listFiles(path.join(installDir, 'data')), ['data.json', 'logs/app.log', 'recordings/x.mp3']);
}

test('データ保護: 入れ替えに成功しても data は元の場所に同じ中身で残り、退避フォルダに入らない', async () => {
  const { root, installDir, args } = await setup();
  try {
    await putData(installDir);
    const res = await runApplyUpdate(args, makeDeps(nodeFs));
    assert.equal(res.ok, true);
    await assertDataIntact(installDir);
    assert.equal(await nodeFs.readFile(path.join(installDir, 'CallStack.exe'), 'utf-8'), 'new-exe');
    const backups = (await nodeFs.readdir(installDir)).filter(isBackupDirName);
    assert.equal(backups.length, 1);
    assert.equal((await nodeFs.readdir(path.join(installDir, backups[0]))).includes('data'), false);
  } finally {
    await nodeFs.rm(root, { recursive: true, force: true });
  }
});

test('データ保護: ロールバックしても data は同じ中身で残る', async () => {
  const { root, installDir, args } = await setup();
  try {
    await putData(installDir);
    const failingFs: ApplierFs = {
      ...nodeFs,
      copyFile: async (src, dst, ...rest) => {
        if (String(src).endsWith('app.asar')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        return (nodeFs.copyFile as (...a: unknown[]) => Promise<void>)(src, dst, ...rest);
      },
    };
    const res = await runApplyUpdate(args, makeDeps(failingFs));
    assert.equal(res.ok, false);
    assert.equal(res.rolledBack, true);
    await assertDataIntact(installDir);
    assert.equal(await nodeFs.readFile(path.join(installDir, 'CallStack.exe'), 'utf-8'), 'old-exe');
  } finally {
    await nodeFs.rm(root, { recursive: true, force: true });
  }
});

test('データ保護: ステージングに（想定外に）data があっても上書きしない', async () => {
  const { root, installDir, stagingDir, args } = await setup();
  try {
    await putData(installDir);
    await write(path.join(stagingDir, 'data', 'data.json'), '{"calls":[]}');
    await write(path.join(stagingDir, 'data', 'extra.txt'), 'should-not-appear');
    const res = await runApplyUpdate(args, makeDeps(nodeFs));
    assert.equal(res.ok, true);
    await assertDataIntact(installDir);
  } finally {
    await nodeFs.rm(root, { recursive: true, force: true });
  }
});

test('データ保護: ステージングに data があっても、ロールバックで消えない', async () => {
  const { root, installDir, stagingDir, args } = await setup();
  try {
    await putData(installDir);
    await write(path.join(stagingDir, 'data', 'data.json'), '{"calls":[]}');
    const failingFs: ApplierFs = {
      ...nodeFs,
      copyFile: async (src, dst, ...rest) => {
        if (String(src).endsWith('app.asar')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        return (nodeFs.copyFile as (...a: unknown[]) => Promise<void>)(src, dst, ...rest);
      },
    };
    const res = await runApplyUpdate(args, makeDeps(failingFs));
    assert.equal(res.rolledBack, true);
    await assertDataIntact(installDir);
  } finally {
    await nodeFs.rm(root, { recursive: true, force: true });
  }
});

test('isPreservedEntryName: data だけ（大文字小文字は区別しない）', () => {
  assert.equal(isPreservedEntryName('data'), true);
  assert.equal(isPreservedEntryName('Data'), true);
  assert.equal(isPreservedEntryName('data.json'), false);
  assert.equal(isPreservedEntryName('resources'), false);
});
