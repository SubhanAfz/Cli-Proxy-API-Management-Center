import { createServer } from 'node:http';
import type { HistoryIndex } from './indexer';

export function createHistoryServer(index: HistoryIndex, upstream: URL) {
  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const json = (status: number, body: object) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET' && req.method !== 'HEAD')
      return json(405, { error: 'Read-only endpoint' });
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (!['/threads', '/v8/management/thread-history/threads'].includes(path))
      return json(404, { error: 'Not found' });
    const authorization = req.headers.authorization;
    if (!authorization?.startsWith('Bearer ') || authorization.length > 4096)
      return json(401, { error: 'Management authentication required' });
    try {
      const auth = await fetch(new URL('/v8/management/config/observability/logs', upstream), {
        headers: { Authorization: authorization },
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      });
      await auth.arrayBuffer();
      if (!auth.ok)
        return json(auth.status === 401 || auth.status === 403 ? auth.status : 502, {
          error: 'Management authentication failed',
        });
    } catch {
      return json(502, { error: 'Proxy management API unavailable' });
    }
    const snapshot = index.snapshot;
    if (!snapshot) return json(202, { ready: false, threads: [], ...index.progress });
    res.setHeader('ETag', snapshot.etag);
    if (req.headers['if-none-match'] === snapshot.etag) {
      res.writeHead(304);
      return res.end();
    }
    const gzip = /\bgzip\b/.test(req.headers['accept-encoding'] ?? '');
    const body = gzip ? snapshot.gzip : snapshot.raw;
    res.setHeader('Vary', 'Accept-Encoding');
    if (gzip) res.setHeader('Content-Encoding', 'gzip');
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
}
