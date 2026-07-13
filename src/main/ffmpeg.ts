import { spawn } from 'node:child_process';
import path from 'node:path';
import { app } from 'electron';

/**
 * Resolves the ffmpeg binary path bundled by ffmpeg-static, adjusting for
 * the asar-unpacked location in production.
 */
export function getFfmpegPath(): string {
  // ffmpeg-static exports the absolute path to its bundled binary
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const raw = require('ffmpeg-static') as string | null;
  if (!raw) {
    throw new Error('ffmpeg-static did not return a binary path');
  }
  if (app.isPackaged) {
    // electron-builder unpacks to app.asar.unpacked
    return raw.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  }
  return raw;
}

/** 無音カットのしきい値 */
const SILENCE_DB = -45;
const SILENCE_MIN = 0.4;

export async function convertWebmToMp3(
  inputPath: string,
  outputPath: string,
  bitrateKbps: number,
  trimSilence = false,
): Promise<{ durationSec: number }> {
  const ffmpeg = getFfmpegPath();
  const args = ['-y', '-i', inputPath, '-vn'];
  if (trimSilence) {
    // 先頭・末尾の無音を除去（silenceremove は先頭のみ削るため、reverse を挟んで両端に適用）
    const sr = `silenceremove=start_periods=1:start_threshold=${SILENCE_DB}dB:start_silence=${SILENCE_MIN}:detection=peak`;
    args.push('-af', `${sr},areverse,${sr},areverse`);
  }
  args.push('-c:a', 'libmp3lame', '-b:a', `${bitrateKbps}k`, outputPath);
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, args);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}: ${stderr}`));
      // 出力の実測長を優先（無音カット後の長さ）。無ければ入力の Duration を使う。
      const times = [...stderr.matchAll(/time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
      let durationSec = 0;
      if (times.length > 0) {
        const t = times[times.length - 1];
        durationSec = Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]);
      } else {
        const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (m) durationSec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      }
      resolve({ durationSec });
    });
  });
}

/** 先頭の無音の長さ（秒）を検出する。マーカー位置の補正に使う */
export async function detectLeadingSilenceSec(inputPath: string): Promise<number> {
  const ffmpeg = getFfmpegPath();
  return new Promise((resolve) => {
    const proc = spawn(ffmpeg, [
      '-i', inputPath,
      '-af', `silencedetect=noise=${SILENCE_DB}dB:d=${SILENCE_MIN}`,
      '-f', 'null', '-',
    ]);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', () => resolve(0));
    proc.on('close', () => {
      // 先頭（silence_start ≈ 0）のブロックの silence_end が先頭無音の長さ
      const startM = stderr.match(/silence_start:\s*(-?\d+(?:\.\d+)?)/);
      const endM = stderr.match(/silence_end:\s*(\d+(?:\.\d+)?)/);
      if (startM && endM && Math.abs(Number(startM[1])) < 0.2) {
        resolve(Math.max(0, Number(endM[1])));
      } else {
        resolve(0);
      }
    });
  });
}

/** 音声ファイルの長さ（秒）を ffmpeg の解析出力から取得する */
export async function probeDurationSec(inputPath: string): Promise<number> {
  const ffmpeg = getFfmpegPath();
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, ['-i', inputPath, '-f', 'null', '-']);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', () => {
      const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!m) return reject(new Error('音声ファイルの長さを取得できませんでした（対応していない形式の可能性があります）'));
      resolve(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
    });
  });
}

export async function convertMp3ToWav16k(
  inputPath: string,
  outputPath: string,
  cancelToken?: { cancelled: boolean; kill: (() => void) | null },
): Promise<void> {
  const ffmpeg = getFfmpegPath();
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, [
      '-y',
      '-i', inputPath,
      '-ar', '16000',
      '-ac', '1',
      '-c:a', 'pcm_s16le',
      outputPath,
    ]);
    // キャンセル・ハング対策: kill フックの公開と 10 分のタイムアウト
    if (cancelToken) cancelToken.kill = () => proc.kill();
    const timeout = setTimeout(() => proc.kill(), 10 * 60 * 1000);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => { clearTimeout(timeout); reject(err); });
    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (cancelToken) cancelToken.kill = null;
      if (code !== 0) return reject(new Error(`ffmpeg(wav) exited ${code}: ${stderr.slice(-300)}`));
      resolve();
    });
  });
}
