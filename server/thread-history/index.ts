import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { HistoryIndex } from './indexer';
import { createHistoryServer } from './http';

process.umask(0o077);
const state = process.env.HISTORY_STATE_DIR ?? '/var/lib/cliproxy-history';
mkdirSync(state, { recursive: true, mode: 0o700 });
const index = new HistoryIndex(
  process.env.HISTORY_LOG_DIR ?? '/var/lib/cliproxyapi/auth/logs',
  join(state, 'history.sqlite')
);
const upstream = new URL(process.env.HISTORY_UPSTREAM ?? 'http://127.0.0.1:8317');
if (upstream.hostname !== '127.0.0.1')
  throw new Error('History authentication must use the local proxy');

const server = createHistoryServer(index, upstream);
server.listen(Number(process.env.HISTORY_PORT ?? 8318), '127.0.0.1');
const scan = async () => {
  try {
    await index.scan();
  } catch {
    console.error('History indexing failed; retaining the previous complete snapshot.');
  }
  setTimeout(scan, 3000).unref();
};
void scan();
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
