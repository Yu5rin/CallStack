import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  classifyCurrentData,
  type EntryKind,
  LEGACY_APP_DIR_NAMES,
  legacyDirCandidates,
  MIGRATION_ORDER,
  planLegacyDataMigration,
  setAsideName,
} from '../legacyDataMigration.ts';

// v1.3.0 で製品名を TelTimeStack → CallStack に変えたとき、Electron の userData が
// %APPDATA%\TelTimeStack から %APPDATA%\CallStack に変わったのに引き継ぎ処理が無く、
// 旧版の記録・設定・録音・モデルが読まれなくなっていた。その引き継ぎの判断を固定する。

const LEGACY = 'C:\\Users\\u\\AppData\\Roaming\\TelTimeStack';
const entries = (obj: Record<string, EntryKind>) => new Map(Object.entries(obj));
const fullLegacy = entries({
  'data.json': 'file',
  recordings: 'dir',
  backups: 'dir',
  models: 'dir',
  whisper: 'dir',
  'whisper-gpu': 'dir',
  vosk: 'dir',
  'vosk-models': 'dir',
  logs: 'dir',
});

test('旧フォルダの候補は %APPDATA% 直下の TelTimeStack（旧 package.json の name も念のため）', () => {
  assert.deepEqual([...LEGACY_APP_DIR_NAMES], ['TelTimeStack', 'teltimestack']);
  // Windows では大文字小文字を区別しないので、同じ場所を二度調べない
  assert.deepEqual(
    legacyDirCandidates('C:\\Users\\u\\AppData\\Roaming', 'C:\\Users\\u\\AppData\\Roaming\\CallStack', path.win32.join, true),
    [LEGACY],
  );
  // 区別するファイルシステムでは両方を候補にする
  assert.deepEqual(
    legacyDirCandidates('/home/u/.config', '/home/u/.config/CallStack', path.posix.join, false),
    ['/home/u/.config/TelTimeStack', '/home/u/.config/teltimestack'],
  );
});

test('今のデータフォルダ自身は旧フォルダの候補にしない', () => {
  assert.deepEqual(
    legacyDirCandidates('C:\\AppData', 'C:\\AppData\\teltimestack', path.win32.join, true),
    [],
  );
});

test('新しい側が未使用なら、旧フォルダの記録・録音・モデル等をすべて移し、data.json は最後に移す', () => {
  const plan = planLegacyDataMigration({
    currentData: 'none',
    current: entries({}),
    legacy: [{ dir: LEGACY, entries: fullLegacy }],
  });
  assert.equal(plan.action, 'migrate');
  if (plan.action !== 'migrate') return;
  assert.equal(plan.from, LEGACY);
  assert.deepEqual(plan.setAside, []);
  assert.deepEqual(plan.moves, ['models', 'whisper', 'whisper-gpu', 'vosk', 'vosk-models', 'recordings', 'backups', 'data.json']);
  // 途中で失敗しても次回起動時に続きから試みられるよう、data.json は必ず最後
  assert.equal(plan.moves.at(-1), 'data.json');
  assert.equal(MIGRATION_ORDER.at(-1), 'data.json');
});

test('logs は移さない（引き継ぎ処理自身のログで新しい側に logs ができ、rename が失敗して止まるため）', () => {
  assert.ok(!(MIGRATION_ORDER as readonly string[]).includes('logs'));
});

test('新しい側に記録が1件でもあれば、何もしない（上書き・混ぜ合わせをしない）', () => {
  const plan = planLegacyDataMigration({
    currentData: 'has-calls',
    current: entries({ 'data.json': 'file', recordings: 'dir' }),
    legacy: [{ dir: LEGACY, entries: fullLegacy }],
  });
  assert.deepEqual(plan, { action: 'none', reason: 'current-has-data' });
});

test('新しい側の data.json が読めない・壊れているときも、中身が分からないので何もしない', () => {
  const plan = planLegacyDataMigration({
    currentData: 'unreadable',
    current: entries({ 'data.json': 'file' }),
    legacy: [{ dir: LEGACY, entries: fullLegacy }],
  });
  assert.deepEqual(plan, { action: 'none', reason: 'current-has-data' });
});

test('旧フォルダに data.json が無ければ引き継ぎ元とみなさない', () => {
  const plan = planLegacyDataMigration({
    currentData: 'none',
    current: entries({}),
    legacy: [{ dir: LEGACY, entries: entries({ logs: 'dir', models: 'dir' }) }],
  });
  assert.deepEqual(plan, { action: 'none', reason: 'no-legacy-data' });
  assert.deepEqual(planLegacyDataMigration({ currentData: 'none', current: entries({}), legacy: [] }),
    { action: 'none', reason: 'no-legacy-data' });
});

test('v1.3.0 以降を起動しただけ（記録0件の data.json が自動で書き出された）なら、退避してから旧データを移す', () => {
  // store.init() は data.json が無いと既定値で書き出し、backup() も作る。
  // これを「データあり」とみなすと、一度でも起動した人は永久に引き継がれない。
  const plan = planLegacyDataMigration({
    currentData: 'no-calls',
    current: entries({ 'data.json': 'file', backups: 'dir', recordings: 'emptyDir', models: 'emptyDir', logs: 'dir' }),
    legacy: [{ dir: LEGACY, entries: fullLegacy }],
  });
  assert.equal(plan.action, 'migrate');
  if (plan.action !== 'migrate') return;
  // 記録側（data.json と、それと組になる backups）は消さずに退避する
  assert.deepEqual(plan.setAside, ['backups', 'data.json']);
  // ensureAppDirs() が作った空フォルダ（recordings\.tmp だけ等）は置き換えてよい
  assert.deepEqual(plan.replaceEmptyDirs, ['models', 'recordings']);
  assert.deepEqual(plan.moves, ['models', 'whisper', 'whisper-gpu', 'vosk', 'vosk-models', 'recordings', 'backups', 'data.json']);
});

test('新しい側で改めてダウンロードした whisper.cpp やモデルは残し、旧フォルダのものと混ぜない', () => {
  const plan = planLegacyDataMigration({
    currentData: 'no-calls',
    current: entries({ 'data.json': 'file', whisper: 'dir', models: 'dir' }),
    legacy: [{ dir: LEGACY, entries: fullLegacy }],
  });
  assert.equal(plan.action, 'migrate');
  if (plan.action !== 'migrate') return;
  assert.ok(!plan.moves.includes('whisper'));
  assert.ok(!plan.moves.includes('models'));
  assert.ok(!plan.setAside.includes('whisper'));
  assert.ok(!plan.setAside.includes('models'));
  assert.deepEqual(plan.moves, ['whisper-gpu', 'vosk', 'vosk-models', 'recordings', 'backups', 'data.json']);
});

test('前回の引き継ぎが途中で止まっていたら、残りだけを移す（移し済みの録音を退避し直さない）', () => {
  // 前回: recordings まで移したところで失敗（data.json は旧フォルダに残っている）
  const plan = planLegacyDataMigration({
    currentData: 'none',
    current: entries({ models: 'dir', recordings: 'dir' }),
    legacy: [{ dir: LEGACY, entries: entries({ 'data.json': 'file', backups: 'dir' }) }],
  });
  assert.equal(plan.action, 'migrate');
  if (plan.action !== 'migrate') return;
  assert.deepEqual(plan.setAside, []);
  assert.deepEqual(plan.moves, ['backups', 'data.json']);
});

test('旧フォルダ側の空フォルダは移さない', () => {
  const plan = planLegacyDataMigration({
    currentData: 'none',
    current: entries({}),
    legacy: [{ dir: LEGACY, entries: entries({ 'data.json': 'file', recordings: 'emptyDir' }) }],
  });
  assert.equal(plan.action, 'migrate');
  if (plan.action !== 'migrate') return;
  assert.deepEqual(plan.moves, ['data.json']);
});

test('候補が複数あるときは、data.json のある最初の旧フォルダを引き継ぎ元にする', () => {
  const plan = planLegacyDataMigration({
    currentData: 'none',
    current: entries({}),
    legacy: [
      { dir: '/cfg/TelTimeStack', entries: entries({ logs: 'dir' }) },
      { dir: '/cfg/teltimestack', entries: entries({ 'data.json': 'file' }) },
    ],
  });
  assert.equal(plan.action, 'migrate');
  if (plan.action !== 'migrate') return;
  assert.equal(plan.from, '/cfg/teltimestack');
});

test('data.json の状態の判定（記録0件だけを「未使用」とみなす）', () => {
  assert.equal(classifyCurrentData(null), 'none');
  assert.equal(classifyCurrentData(JSON.stringify({ version: 1, calls: [], settings: {} })), 'no-calls');
  assert.equal(classifyCurrentData(JSON.stringify({ version: 1, calls: [{ id: 'a' }], settings: {} })), 'has-calls');
  // 削除済み（ゴミ箱）の記録も記録として数える
  assert.equal(classifyCurrentData(JSON.stringify({ calls: [{ id: 'a', deletedAt: '2026-01-01' }] })), 'has-calls');
  assert.equal(classifyCurrentData('{ broken'), 'unreadable');
  assert.equal(classifyCurrentData(JSON.stringify({ settings: {} })), 'unreadable');
  assert.equal(classifyCurrentData('null'), 'unreadable');
});

test('退避先の名前は元の名前に日時を付けたもの（消さずに残す）', () => {
  assert.equal(setAsideName('data.json', '20260925-120000'), 'data.json.before-migration-20260925-120000');
});
