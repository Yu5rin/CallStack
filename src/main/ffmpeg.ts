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

export async function convertWebmToMp3(
  inputPath: string,
  outputPath: string,
  bitrateKbps: number,
): Promise<{ durationSec: number }> {
  const ffmpeg = getFfmpegPath();
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, [
      '-y',
      '-i', inputPath,
      '-vn',
      '-c:a', 'libmp3lame',
      '-b:a', `${bitrateKbps}k`,
      outputPath,
    ]);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}: ${stderr}`));
      // Parse duration "Duration: HH:MM:SS.cc"
      const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      let durationSec = 0;
      if (m) {
        durationSec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      }
      resolve({ durationSec });
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
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg(wav) exited ${code}: ${stderr}`));
      resolve();
    });
  });
}
