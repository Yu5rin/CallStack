import { promises as fs, createWriteStream } from 'node:fs';
import path from 'node:path';
import { get as httpGet } from 'node:https';
import { WhisperModel } from '../shared/types';
import { getDirs } from './paths';

const HF_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

const MODEL_FILES: Record<WhisperModel, string> = {
  tiny:   'ggml-tiny.bin',
  base:   'ggml-base.bin',
  small:  'ggml-small.bin',
  medium: 'ggml-medium.bin',
};

export function getModelPath(model: WhisperModel): string {
  const { models } = getDirs();
  return path.join(models, MODEL_FILES[model]);
}

export async function isModelDownloaded(model: WhisperModel): Promise<boolean> {
  try {
    const stat = await fs.stat(getModelPath(model));
    return stat.size > 1024 * 1024; // > 1MB sanity check
  } catch {
    return false;
  }
}

export interface DownloadProgress {
  receivedBytes: number;
  totalBytes: number | null;
}

export async function downloadModel(
  model: WhisperModel,
  onProgress: (p: DownloadProgress) => void,
): Promise<void> {
  const target = getModelPath(model);
  const tmp = target + '.part';
  const url = `${HF_BASE}/${MODEL_FILES[model]}`;

  await new Promise<void>((resolve, reject) => {
    const fetchWithRedirect = (u: string, depth = 0) => {
      if (depth > 5) return reject(new Error('Too many redirects'));
      const req = httpGet(u, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          fetchWithRedirect(new URL(res.headers.location, u).toString(), depth + 1);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        const total = res.headers['content-length'] ? Number(res.headers['content-length']) : null;
        let received = 0;
        const out = createWriteStream(tmp);
        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          onProgress({ receivedBytes: received, totalBytes: total });
        });
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve()));
        out.on('error', reject);
      });
      req.on('error', reject);
    };
    fetchWithRedirect(url);
  });

  await fs.rename(tmp, target);
}
