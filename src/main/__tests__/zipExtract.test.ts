import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { extractZip } from '../zipExtract.ts';

// electron のメインプロセスでは resources/app.asar というパス（*.asar というセグメント）に
// 触れると asar パッチ付きの fs が誤作動する（selfUpdate.ts のコメント参照）。extractZip は
// 展開に使う fs を注入できるようにしてこれを避けているが、この関数自体は electron に依存しない
// 純粋なモジュールなので、ここでは素の node:fs を注入してテストする。

interface ZipEntrySpec {
  name: string;
  content?: Buffer;
  isDir?: boolean;
}

/**
 * テスト用に、圧縮なし(STORE)の最小限の zip をその場で組み立てる。
 * yazl 等の追加依存を増やさないための自前実装（node:zlib.crc32 を使う）。
 */
function buildZip(entries: ZipEntrySpec[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  const DOS_TIME = 0;
  const DOS_DATE = 0x21; // 1980-01-01（有効な値であればよく、日付自体はテストで見ない）
  const UTF8_FLAG = 0x0800;

  for (const entry of entries) {
    const isDir = entry.isDir ?? false;
    const nameBytes = Buffer.from(isDir && !entry.name.endsWith('/') ? `${entry.name}/` : entry.name, 'utf-8');
    const content = isDir ? Buffer.alloc(0) : (entry.content ?? Buffer.alloc(0));
    const crc = zlib.crc32(content) >>> 0;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(UTF8_FLAG, 6);
    localHeader.writeUInt16LE(0, 8); // compression method: store
    localHeader.writeUInt16LE(DOS_TIME, 10);
    localHeader.writeUInt16LE(DOS_DATE, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(content.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length

    localParts.push(localHeader, nameBytes, content);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(UTF8_FLAG, 8);
    centralHeader.writeUInt16LE(0, 10); // compression method
    centralHeader.writeUInt16LE(DOS_TIME, 12);
    centralHeader.writeUInt16LE(DOS_DATE, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(content.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra field length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(0, 38); // external attrs
    centralHeader.writeUInt32LE(offset, 42); // local header offset

    centralParts.push(centralHeader, nameBytes);

    offset += localHeader.length + nameBytes.length + content.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const centralDirectorySize = centralDirectory.length;
  const centralDirectoryOffset = offset;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectorySize, 12);
  eocd.writeUInt32LE(centralDirectoryOffset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

async function withTempDirs<T>(fn: (dirs: { work: string; dest: string; zipPath: string }) => Promise<T>): Promise<T> {
  const work = await mkdtemp(path.join(os.tmpdir(), 'callstack-zipextract-'));
  const dest = path.join(work, 'dest');
  const zipPath = path.join(work, 'input.zip');
  await fs.promises.mkdir(dest, { recursive: true });
  try {
    return await fn({ work, dest, zipPath });
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

test('resources/app.asar という名前のエントリも、ただのファイルとしてバイト単位そのまま展開される', async () => {
  await withTempDirs(async ({ dest, zipPath }) => {
    const asarBytes = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x10, 0x20, 0x30, 0x40, 0x50]);
    const zip = buildZip([{ name: 'resources/app.asar', content: asarBytes }]);
    fs.writeFileSync(zipPath, zip);

    await extractZip(zipPath, dest, fs);

    const outPath = path.join(dest, 'resources', 'app.asar');
    const st = await stat(outPath);
    assert.equal(st.isFile(), true);
    const written = await readFile(outPath);
    assert.deepEqual(written, asarBytes);
  });
});

test('ネストしたディレクトリはエントリの有無に関わらず作られる', async () => {
  await withTempDirs(async ({ dest, zipPath }) => {
    const zip = buildZip([
      { name: 'a/b/c/', isDir: true },
      { name: 'a/b/c/leaf.txt', content: Buffer.from('leaf', 'utf-8') },
    ]);
    fs.writeFileSync(zipPath, zip);

    await extractZip(zipPath, dest, fs);

    const dirStat = await stat(path.join(dest, 'a', 'b', 'c'));
    assert.equal(dirStat.isDirectory(), true);
    const leaf = await readFile(path.join(dest, 'a', 'b', 'c', 'leaf.txt'), 'utf-8');
    assert.equal(leaf, 'leaf');
  });
});

test('日本語のファイル名は文字化けせずに往復する', async () => {
  await withTempDirs(async ({ dest, zipPath }) => {
    const name = 'フォルダ/議事録・2026年9月.txt';
    const zip = buildZip([{ name, content: Buffer.from('内容', 'utf-8') }]);
    fs.writeFileSync(zipPath, zip);

    await extractZip(zipPath, dest, fs);

    const content = await readFile(path.join(dest, 'フォルダ', '議事録・2026年9月.txt'), 'utf-8');
    assert.equal(content, '内容');
  });
});

test('展開先の外を指す zip-slip エントリ（../evil.txt）は拒否され、外部に書き出されない', async () => {
  await withTempDirs(async ({ work, dest, zipPath }) => {
    const zip = buildZip([{ name: '../evil.txt', content: Buffer.from('pwned', 'utf-8') }]);
    fs.writeFileSync(zipPath, zip);

    await assert.rejects(() => extractZip(zipPath, dest, fs));

    const escapedPath = path.join(work, 'evil.txt');
    await assert.rejects(() => stat(escapedPath));
  });
});
