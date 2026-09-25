import { promises as fs, createWriteStream, WriteStream } from 'node:fs';
import path from 'node:path';
import { getDirs } from './paths';
import { convertWebmToMp3, detectLeadingSilenceSec } from './ffmpeg';

interface Session {
  callId: string;
  tmpPath: string;
  stream: WriteStream;
  bytes: number;
  closed: Promise<void>;
}

const sessions = new Map<string, Session>();

export async function appendChunk(callId: string, buf: Buffer): Promise<void> {
  let s = sessions.get(callId);
  if (!s) {
    const { tmpRecordings } = getDirs();
    const tmpPath = path.join(tmpRecordings, `${callId}.webm`);
    const stream = createWriteStream(tmpPath, { flags: 'a' });
    const closed = new Promise<void>((resolve, reject) => {
      stream.on('close', () => resolve());
      stream.on('error', reject);
    });
    s = { callId, tmpPath, stream, bytes: 0, closed };
    sessions.set(callId, s);
  }
  await new Promise<void>((resolve, reject) => {
    s!.stream.write(buf, (err) => err ? reject(err) : resolve());
  });
  s.bytes += buf.length;
}

export async function abort(callId: string): Promise<void> {
  const s = sessions.get(callId);
  if (!s) return;
  await new Promise<void>((resolve) => s.stream.end(() => resolve()));
  await fs.unlink(s.tmpPath).catch(() => {});
  sessions.delete(callId);
}

export interface FinalizeResult {
  path: string;            // relative to recordings dir, e.g. 'abc.mp3'
  absPath: string;
  bytes: number;
  durationSec: number;
  /** 先頭無音カットで削られた秒数（マーカー位置の補正用） */
  leadingTrimSec: number;
}

export async function finalize(callId: string, mp3Bitrate: number, trimSilence = false): Promise<FinalizeResult | null> {
  const s = sessions.get(callId);
  if (!s) return null;
  await new Promise<void>((resolve) => s.stream.end(() => resolve()));
  await s.closed.catch(() => {});
  sessions.delete(callId);

  if (s.bytes === 0) {
    await fs.unlink(s.tmpPath).catch(() => {});
    return null;
  }

  const { recordings } = getDirs();
  const rel = `${callId}.mp3`;
  const abs = path.join(recordings, rel);
  // 無音カットが有効なら先頭無音の長さを先に測る（マーカー補正のため）
  const leadingTrimSec = trimSilence ? await detectLeadingSilenceSec(s.tmpPath).catch(() => 0) : 0;
  const { durationSec } = await convertWebmToMp3(s.tmpPath, abs, mp3Bitrate, trimSilence);
  const stat = await fs.stat(abs);
  await fs.unlink(s.tmpPath).catch(() => {});
  return { path: rel, absPath: abs, bytes: stat.size, durationSec, leadingTrimSec };
}

export async function deleteRecording(relPath: string): Promise<void> {
  const { recordings } = getDirs();
  // relPath は録音フォルダからの相対パスである前提。絶対パスや `..` による
  // 脱出（不正な復元データ等に由来する可能性）を拒否し、フォルダ外のファイルを
  // 誤って消さないようにする。
  if (path.isAbsolute(relPath)) {
    console.error(`[recording] deleteRecording: refusing absolute path: ${relPath}`);
    return;
  }
  const abs = path.resolve(recordings, relPath);
  if (abs !== recordings && !abs.startsWith(recordings + path.sep)) {
    console.error(`[recording] deleteRecording: refusing path outside recordings dir: ${relPath}`);
    return;
  }
  await fs.unlink(abs).catch(() => {});
}
