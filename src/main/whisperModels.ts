import { promises as fs, createWriteStream } from 'node:fs';
import path from 'node:path';
import { net } from 'electron';
import { WhisperModel } from '../shared/types';
import { getDirs } from './paths';

const HF_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

const MODEL_FILES: Record<WhisperModel, string> = {
  tiny:   'ggml-tiny.bin',
  base:   'ggml-base.bin',
  small:  'ggml-small.bin',
  medium: 'ggml-medium.bin',
  'large-v3-turbo': 'ggml-large-v3-turbo.bin',
};

export function getModelPath(model: WhisperModel): string {
  const { models } = getDirs();
  return path.join(models, MODEL_FILES[model]);
}

export async function isModelDownloaded(model: WhisperModel): Promise<boolean> {
  try {
    const stat = await fs.stat(getModelPath(model));
    return stat.size > 1024 * 1024;
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

  await fs.mkdir(path.dirname(target), { recursive: true });

  await new Promise<void>((resolve, reject) => {
    const req = net.request({
      url,
      method: 'GET',
      redirect: 'follow',
    });

    req.on('redirect', (_status, _method, redirectUrl) => {
      req.followRedirect();
      void redirectUrl;
    });

    req.on('response', (res) => {
      const status = res.statusCode;
      if (status !== 200) {
        reject(new Error(`HTTP ${status}`));
        res.on('data', () => {});
        return;
      }
      const lenHdr = res.headers['content-length'];
      const lenStr = Array.isArray(lenHdr) ? lenHdr[0] : lenHdr;
      const total = lenStr ? Number(lenStr) : null;
      let received = 0;
      const out = createWriteStream(tmp);
      let failed = false;

      res.on('data', (chunk: Buffer) => {
        if (failed) return;
        received += chunk.length;
        onProgress({ receivedBytes: received, totalBytes: total });
        out.write(chunk);
      });
      res.on('end', () => {
        if (failed) return;
        out.end(() => resolve());
      });
      res.on('error', (err: Error) => {
        failed = true;
        out.destroy();
        reject(err);
      });
      out.on('error', (err) => {
        failed = true;
        reject(err);
      });
    });

    req.on('error', (err) => reject(err));
    req.end();
  });

  await fs.rename(tmp, target);
}
