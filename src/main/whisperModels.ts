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
  // Kotoba-Whisper v2.0（日本語特化・distil 系で高速）の ggml
  'kotoba-v2': 'ggml-kotoba-whisper-v2.0.bin',
};

/**
 * モデルごとのダウンロード候補 URL（上から順に試す）。
 * Kotoba-Whisper は whisper.cpp 本家リポジトリに無いため、配布 ggml を候補として持つ。
 */
function modelUrls(model: WhisperModel): string[] {
  const file = MODEL_FILES[model];
  if (model === 'kotoba-v2') {
    return [
      `https://huggingface.co/kotoba-tech/kotoba-whisper-v2.0-ggml/resolve/main/${file}`,
      // 予備の配布ミラー（本家に無い場合のフォールバック）
      `https://huggingface.co/JhonVanced/whisper-kotoba-v2.0-ggml/resolve/main/${file}`,
    ];
  }
  return [`${HF_BASE}/${file}`];
}

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

function downloadOne(url: string, tmp: string, onProgress: (p: DownloadProgress) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const req = net.request({ url, method: 'GET', redirect: 'follow' });
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
      res.on('end', () => { if (!failed) out.end(() => resolve()); });
      res.on('error', (err: Error) => { failed = true; out.destroy(); reject(err); });
      out.on('error', (err) => { failed = true; reject(err); });
    });
    req.on('error', (err) => reject(err));
    req.end();
  });
}

export async function downloadModel(
  model: WhisperModel,
  onProgress: (p: DownloadProgress) => void,
): Promise<void> {
  const target = getModelPath(model);
  const tmp = target + '.part';
  await fs.mkdir(path.dirname(target), { recursive: true });

  const urls = modelUrls(model);
  let lastErr: Error | null = null;
  for (const url of urls) {
    try {
      await downloadOne(url, tmp, onProgress);
      await fs.rename(tmp, target);
      return;
    } catch (err) {
      lastErr = err as Error;
      await fs.unlink(tmp).catch(() => {});
    }
  }
  throw new Error(
    `モデルのダウンロードに失敗しました (${lastErr?.message ?? '不明'})。`
    + (model === 'kotoba-v2'
      ? '\nKotoba-Whisper の ggml が入手できない場合は、ggml-kotoba-whisper-v2.0.bin を手動で models フォルダに配置してください。'
      : ''),
  );
}
