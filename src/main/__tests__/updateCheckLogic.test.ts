import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVersion,
  isNewer,
  isNewerThanCurrent,
  stripVersionPrefix,
  tryBuildAtomUrlFromApiUrl,
  buildAtomUrl,
  buildAssetFileName,
  buildDownloadUrl,
  buildReleasePageUrl,
  buildLatestReleasePageUrl,
  extractLatestTagFromAtom,
  isAllowedUpdateUrl,
} from '../updateCheckLogic.ts';

// GitHub の API には 1 時間 60 回（未認証・IP単位）の上限があり、会社のような共有回線では
// 常に使い切られていて releases/latest が 403 を返し続ける（一度も更新できない）。
// Atom フィード（上限とは別枠）で最新タグだけ確認し、新しい版があるときだけ API を呼ぶ。
// API が失敗してもダウンロード URL を規則から組み立てて続行できるよう、これらの純粋な
// ロジックを固定する。

test('parseVersion: 先頭の v を吸収し、数値として比較できる形にする', () => {
  assert.deepEqual(parseVersion('v1.0.4'), [1, 0, 4, 0]);
  assert.deepEqual(parseVersion('1.0.4'), [1, 0, 4, 0]);
  assert.deepEqual(parseVersion('V2.6.0'), [2, 6, 0, 0]);
});

test('parseVersion: +メタ情報 / -プレリリース表記は無視する', () => {
  assert.deepEqual(parseVersion('v1.2.3+abcdef'), [1, 2, 3, 0]);
  assert.deepEqual(parseVersion('v1.2.3-beta.1'), [1, 2, 3, 0]);
});

test('parseVersion: 桁数の違いは同じものとして扱う', () => {
  assert.deepEqual(parseVersion('1.0.1'), parseVersion('1.0.1.0'));
});

test('parseVersion: 読めないものは null', () => {
  assert.equal(parseVersion(''), null);
  assert.equal(parseVersion(undefined), null);
  assert.equal(parseVersion('latest'), null);
  assert.equal(parseVersion('release-2024'), null);
});

test('isNewer: 文字列比較では壊れる桁上がりを正しく扱う（1.0.10 > 1.0.9）', () => {
  const a = parseVersion('1.0.10')!;
  const b = parseVersion('1.0.9')!;
  assert.equal(isNewer(a, b), true);
  assert.equal(isNewer(b, a), false);
});

test('isNewer: 同じ版は新しくない', () => {
  const v = parseVersion('v2.6.0')!;
  assert.equal(isNewer(v, v), false);
});

test('isNewerThanCurrent: v プレフィックスの有無を吸収して比較する', () => {
  assert.equal(isNewerThanCurrent('v2.7.0', '2.6.0'), true);
  assert.equal(isNewerThanCurrent('2.6.0', 'v2.6.0'), false);
});

test('isNewerThanCurrent: どちらかが読めなければ null', () => {
  assert.equal(isNewerThanCurrent('not-a-version', '2.6.0'), null);
  assert.equal(isNewerThanCurrent('v2.6.0', ''), null);
});

test('stripVersionPrefix: v/V のみ落とし、それ以外はそのまま', () => {
  assert.equal(stripVersionPrefix('v1.2.3'), '1.2.3');
  assert.equal(stripVersionPrefix('V1.2.3'), '1.2.3');
  assert.equal(stripVersionPrefix('1.2.3'), '1.2.3');
  assert.equal(stripVersionPrefix('v'), 'v'); // 1文字だけの "v" は落とさない
});

test('tryBuildAtomUrlFromApiUrl: releases/latest の API URL から Atom フィード URL を組み立てる', () => {
  assert.equal(
    tryBuildAtomUrlFromApiUrl('https://api.github.com/repos/Yu5rin/CallStack/releases/latest'),
    'https://github.com/Yu5rin/CallStack/releases.atom',
  );
});

test('tryBuildAtomUrlFromApiUrl: GitHub 以外や形が違う URL は null', () => {
  assert.equal(tryBuildAtomUrlFromApiUrl('https://example.com/repos/a/b/releases/latest'), null);
  assert.equal(tryBuildAtomUrlFromApiUrl('https://api.github.com/repos/onlyowner'), null);
  assert.equal(tryBuildAtomUrlFromApiUrl('not a url'), null);
});

test('buildAtomUrl / buildAssetFileName / buildDownloadUrl: 規則どおりに組み立てる', () => {
  assert.equal(buildAtomUrl('Yu5rin', 'CallStack'), 'https://github.com/Yu5rin/CallStack/releases.atom');
  assert.equal(buildAssetFileName('v2.7.1'), 'CallStack-2.7.1-win-x64.zip');
  assert.equal(
    buildDownloadUrl('Yu5rin', 'CallStack', 'v2.7.1'),
    'https://github.com/Yu5rin/CallStack/releases/download/v2.7.1/CallStack-2.7.1-win-x64.zip',
  );
});

test('buildReleasePageUrl / buildLatestReleasePageUrl', () => {
  assert.equal(
    buildReleasePageUrl('Yu5rin', 'CallStack', 'v2.7.1'),
    'https://github.com/Yu5rin/CallStack/releases/tag/v2.7.1',
  );
  assert.equal(
    buildLatestReleasePageUrl('Yu5rin', 'CallStack'),
    'https://github.com/Yu5rin/CallStack/releases/latest',
  );
});

test('extractLatestTagFromAtom: 並び順に頼らず、バージョンとして最大のタグを選ぶ', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <link href="https://github.com/Yu5rin/CallStack/releases/tag/v2.6.0"/>
  </entry>
  <entry>
    <link href="https://github.com/Yu5rin/CallStack/releases/tag/v2.7.1"/>
  </entry>
  <entry>
    <link href="https://github.com/Yu5rin/CallStack/releases/tag/v2.7.0"/>
  </entry>
</feed>`;
  assert.equal(extractLatestTagFromAtom(xml), 'v2.7.1');
});

test('extractLatestTagFromAtom: バージョンとして読めないタグ（下書き用の名前等）は無視する', () => {
  const xml = `<feed>
  <entry><link href="https://github.com/Yu5rin/CallStack/releases/tag/nightly-build"/></entry>
  <entry><link href="https://github.com/Yu5rin/CallStack/releases/tag/v2.6.0"/></entry>
</feed>`;
  assert.equal(extractLatestTagFromAtom(xml), 'v2.6.0');
});

test('extractLatestTagFromAtom: 壊れた xml でも例外を投げず null を返す', () => {
  assert.equal(extractLatestTagFromAtom('<feed><entry><link href="'), null);
  assert.equal(extractLatestTagFromAtom(''), null);
  assert.equal(extractLatestTagFromAtom('not xml at all'), null);
});

test('extractLatestTagFromAtom: entry が無ければ null', () => {
  assert.equal(extractLatestTagFromAtom('<feed></feed>'), null);
});

test('isAllowedUpdateUrl: https の github.com / api.github.com のみ許可する', () => {
  assert.equal(isAllowedUpdateUrl('https://github.com/Yu5rin/CallStack/releases.atom'), true);
  assert.equal(isAllowedUpdateUrl('https://api.github.com/repos/Yu5rin/CallStack/releases/latest'), true);
  assert.equal(isAllowedUpdateUrl('http://github.com/Yu5rin/CallStack/releases.atom'), false);
  assert.equal(isAllowedUpdateUrl('https://evil.example.com/CallStack.zip'), false);
  assert.equal(isAllowedUpdateUrl('not a url'), false);
});

test('isAllowedUpdateUrl: ダウンロード用途は決まった prefix から始まるものだけ許可する', () => {
  const good = 'https://github.com/Yu5rin/CallStack/releases/download/v2.7.1/CallStack-2.7.1-win-x64.zip';
  const bad = 'https://github.com/other/other/releases/download/v1.0.0/x.zip';
  assert.equal(isAllowedUpdateUrl(good, { requireDownloadPrefix: true }), true);
  assert.equal(isAllowedUpdateUrl(bad, { requireDownloadPrefix: true }), false);
  // prefix を要求しない場合は github.com 上の任意のパスを許可する
  assert.equal(isAllowedUpdateUrl(bad, { requireDownloadPrefix: false }), true);
});
