import { protocol } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { getDirs } from './paths';

function contentTypeFor(ext: string): string {
  switch (ext.toLowerCase()) {
    case '.mp3': return 'audio/mpeg';
    case '.webm': return 'audio/webm';
    case '.wav': return 'audio/wav';
    case '.ogg': return 'audio/ogg';
    case '.m4a': return 'audio/mp4';
    default: return 'application/octet-stream';
  }
}

export function registerAppProtocol(): void {
  protocol.handle('app', async (req) => {
    try {
      const url = new URL(req.url);
      // app://recordings/<file>
      if (url.host !== 'recordings') {
        return new Response('Not Found', { status: 404 });
      }
      const requested = decodeURIComponent(url.pathname.replace(/^\//, ''));
      const { recordings } = getDirs();
      const abs = path.normalize(path.join(recordings, requested));
      // Path-traversal guard
      if (!abs.startsWith(path.normalize(recordings) + path.sep) && abs !== path.normalize(recordings)) {
        return new Response('Forbidden', { status: 403 });
      }

      const stat = await fs.promises.stat(abs);
      const fileSize = stat.size;
      const contentType = contentTypeFor(path.extname(abs));
      const rangeHeader = req.headers.get('range');

      if (!rangeHeader) {
        const stream = Readable.toWeb(fs.createReadStream(abs)) as ReadableStream;
        return new Response(stream, {
          status: 200,
          headers: {
            'Content-Type': contentType,
            'Content-Length': String(fileSize),
            'Accept-Ranges': 'bytes',
          },
        });
      }

      const m = rangeHeader.match(/bytes=(\d*)-(\d*)/);
      if (!m) return new Response(null, { status: 416 });
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? parseInt(m[2], 10) : fileSize - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= fileSize) {
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${fileSize}` },
        });
      }
      const chunkSize = end - start + 1;
      const stream = Readable.toWeb(fs.createReadStream(abs, { start, end })) as ReadableStream;
      return new Response(stream, {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Content-Length': String(chunkSize),
          'Content-Type': contentType,
          'Accept-Ranges': 'bytes',
        },
      });
    } catch (err) {
      return new Response(`Error: ${(err as Error).message}`, { status: 500 });
    }
  });
}

export function registerAppProtocolPrivilege(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } },
  ]);
}
