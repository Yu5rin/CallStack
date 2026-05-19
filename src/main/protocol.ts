import { protocol, net } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getDirs } from './paths';

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
      const fileUrl = pathToFileURL(abs).toString();
      return net.fetch(fileUrl);
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
