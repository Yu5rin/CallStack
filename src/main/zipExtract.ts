import path from 'node:path';
import * as yauzl from 'yauzl';

/**
 * extractZip が書き込みに使う fs のうち、必要な部分だけを抜き出した最小限の型。
 * 本番では electron の asar パッチが当たっていない `original-fs` を渡す
 * （呼び出し側 selfUpdate.ts のコメント参照）。テストでは素の node:fs を渡せる。
 */
export interface ExtractFsModule {
  promises: {
    mkdir(dir: string, options: { recursive: true }): Promise<string | undefined>;
  };
  createWriteStream(filePath: string): NodeJS.WritableStream;
}

/**
 * yauzl 上に作った、最小限の zip 展開関数。
 *
 * extract-zip を使わない理由: extract-zip は内部で node:fs（electron のメインプロセスでは
 * asar 対応パッチが当たっている）を直接使っており、展開先に `*.asar` という名前のファイルが
 * 含まれると「そこから先は asar アーカイブの中身」と誤認されて書き込みに失敗する
 * （"Invalid package" エラー。selfUpdate.ts の解説コメント参照）。
 * この関数は書き込み用の fs を呼び出し側から注入できるようにし、asar パッチの影響を受けない
 * `original-fs` を渡せるようにする。
 *
 * 設計上の注意:
 *   - エントリを1つずつ順番に処理し（lazyEntries）、ファイル全体をメモリに載せない
 *     （更新用 zip は 150MB 近くあるため、ストリームで書き出す）
 *   - zip-slip 対策: 展開先の外へ出るパス（"../" を含むもの）や絶対パス
 *     （POSIX の "/", Windows のドライブレター・UNC パス）を持つエントリは拒否する
 *   - シンボリックリンクのエントリ（zip 内に unix パーミッションとして記録されている）は
 *     展開せずスキップする（配布物にシンボリックリンクは含まれない想定のため）
 */
export function extractZip(zipPath: string, destDir: string, fsModule: ExtractFsModule): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, decodeStrings: true }, (openErr, zipfile) => {
      if (openErr || !zipfile) {
        reject(openErr ?? new Error('zip ファイルを開けませんでした'));
        return;
      }

      let settled = false;
      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        try { zipfile.close(); } catch { /* noop */ }
        reject(err);
      };
      const succeed = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };

      zipfile.on('error', fail);

      zipfile.on('entry', (entry: yauzl.Entry) => {
        if (settled) return;
        extractOneEntry(zipfile, entry, destDir, fsModule)
          .then(() => {
            if (!settled) zipfile.readEntry();
          })
          .catch(fail);
      });

      zipfile.on('end', succeed);

      zipfile.readEntry();
    });
  });
}

async function extractOneEntry(
  zipfile: yauzl.ZipFile,
  entry: yauzl.Entry,
  destDir: string,
  fsModule: ExtractFsModule,
): Promise<void> {
  const rawName = entry.fileName;
  if (isUnsafeEntryName(rawName)) {
    throw new Error(`不正なエントリ名のため展開を中止しました: ${rawName}`);
  }

  const destRoot = path.resolve(destDir);
  const targetPath = path.resolve(destRoot, rawName);
  if (targetPath !== destRoot && !targetPath.startsWith(destRoot + path.sep)) {
    // "../" 等で展開先の外を指しているエントリ（zip-slip）
    throw new Error(`不正なエントリ名のため展開を中止しました: ${rawName}`);
  }

  if (isSymlinkEntry(entry)) {
    return; // シンボリックリンクは展開しない
  }

  const isDirectory = rawName.endsWith('/');
  if (isDirectory) {
    await fsModule.promises.mkdir(targetPath, { recursive: true });
    return;
  }

  await fsModule.promises.mkdir(path.dirname(targetPath), { recursive: true });
  await new Promise<void>((resolveEntry, rejectEntry) => {
    zipfile.openReadStream(entry, (streamErr, readStream) => {
      if (streamErr || !readStream) {
        rejectEntry(streamErr ?? new Error(`エントリを読み出せませんでした: ${rawName}`));
        return;
      }
      const writeStream = fsModule.createWriteStream(targetPath);
      let failed = false;
      const onError = (err: Error): void => {
        if (failed) return;
        failed = true;
        rejectEntry(err);
      };
      readStream.on('error', onError);
      writeStream.on('error', onError);
      writeStream.on('close', () => {
        if (!failed) resolveEntry();
      });
      readStream.pipe(writeStream);
    });
  });
}

/** POSIX の絶対パス・Windows のドライブレター/UNC パス・NUL バイトを含むエントリ名を拒否する */
function isUnsafeEntryName(name: string): boolean {
  if (name.length === 0) return true;
  if (name.includes('\0')) return true;
  if (name.startsWith('/') || name.startsWith('\\')) return true; // POSIX 絶対パス・UNC/ルート相対
  if (/^[a-zA-Z]:[\\/]/.test(name)) return true; // Windows ドライブレター（例: C:\foo）
  return false;
}

/** zip 内に unix パーミッションとして記録されたシンボリックリンクかどうか判定する */
function isSymlinkEntry(entry: yauzl.Entry): boolean {
  const madeByUnix = ((entry.versionMadeBy >> 8) & 0xff) === 3; // 3 = UNIX
  if (!madeByUnix) return false;
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const S_IFLNK = 0xa000;
  const S_IFMT = 0xf000;
  return (unixMode & S_IFMT) === S_IFLNK;
}
