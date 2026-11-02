import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { HistoryIndex } from '../../server/thread-history/indexer';
import { createHistoryServer } from '../../server/thread-history/http';
import {
  buildConversationThreads,
  extractRequestReferences,
  parseConversationRequest,
} from '../../src/features/threads/model/conversations';
import { demoLogs, demoLogLines, makeLog } from '../fixtures/conversationLogs';

const directory = mkdtempSync(join(tmpdir(), 'thread-history-test-'));
const logs = join(directory, 'logs');
mkdirSync(logs);
const path = (id: string) => join(logs, `v1-responses-2026-11-02T120000-${id}.log`);
const save = (id: string, text: string) => {
  writeFileSync(path(id), text);
  utimesSync(path(id), 1000, 1000);
};
let index: HistoryIndex | undefined;
const auth = createServer((req, res) => {
  res.writeHead(req.headers.authorization === 'Bearer synthetic-admin' && !revoked ? 200 : 401);
  res.end('{}');
});
let revoked = false;
try {
  for (const [id, text] of Object.entries(demoLogs)) save(id, text);
  save(
    'eeee0001',
    '=== REQUEST INFO ===\nURL: /v1/live\n\n=== REQUEST BODY ===\nSynthetic binary audio wire dump'
  );
  writeFileSync(join(logs, 'main.log'), demoLogLines.join('\n'));
  index = new HistoryIndex(logs, join(directory, 'index.sqlite'));
  await index.scan();
  let snapshot = JSON.parse(index.snapshot!.raw.toString());
  const references = extractRequestReferences(demoLogLines);
  const expected = buildConversationThreads(
    references.map((r) => parseConversationRequest(demoLogs[r.id], r))
  );
  assert.equal(snapshot.indexed, 4);
  assert.equal(snapshot.total, 4, 'non-text live-audio wire dumps are excluded');
  assert.equal(snapshot.failed, 0);
  assert.equal(snapshot.threads.length, expected.length);
  for (const thread of expected) {
    const actual = snapshot.threads.find((r: { id: string }) => r.id === thread.id);
    assert.deepEqual(actual.items, thread.items);
    assert.equal(actual.title, thread.title);
    assert.equal(actual.requests.length, thread.requests.length);
    assert(actual.requests.every((r: { items: unknown[] }) => r.items.length === 0));
  }
  assert(!index.snapshot!.raw.toString().includes('Bearer redacted'));
  const unique = Number(index.db.prepare('SELECT COUNT(*) AS n FROM items').get()!.n);
  const replayed = Number(index.db.prepare('SELECT COUNT(*) AS n FROM file_items').get()!.n);
  assert(unique < replayed, 'replayed messages are stored once');
  const unchanged = index.snapshot!.etag;
  await index.scan();
  assert.equal(index.snapshot!.etag, unchanged);
  save(
    'cccc0001',
    makeLog({ input: 'New independent thread' }, { output: [] }, 'Thread-Id: independent')
  );
  await index.scan();
  snapshot = JSON.parse(index.snapshot!.raw.toString());
  assert.equal(snapshot.threads.length, 3);
  const restarted = new HistoryIndex(logs, join(directory, 'index.sqlite'));
  assert.equal(
    restarted.snapshot!.etag,
    index.snapshot!.etag,
    'complete snapshot survives restart'
  );
  restarted.db.close();
  index.db
    .prepare("INSERT OR REPLACE INTO state(key,data) VALUES('dirty',?)")
    .run(Buffer.from('1'));
  index.db.exec('DELETE FROM threads');
  await index.scan();
  assert.equal(
    JSON.parse(index.snapshot!.raw.toString()).threads.length,
    3,
    'an interrupted build regenerates the complete snapshot'
  );
  unlinkSync(path('cccc0001'));
  await index.scan();
  snapshot = JSON.parse(index.snapshot!.raw.toString());
  assert.equal(snapshot.threads.length, 2, 'retention removes obsolete threads');
  assert(!index.snapshot!.raw.toString().includes('New independent thread'));
  save(
    'cccc0001',
    makeLog({ input: 'Replacement message' }, { output: [] }, 'Thread-Id: independent')
  );
  await index.scan();
  assert(index.snapshot!.raw.toString().includes('Replacement message'));

  await new Promise<void>((resolve) => auth.listen(0, '127.0.0.1', resolve));
  const upstream = new URL(`http://127.0.0.1:${(auth.address() as { port: number }).port}`);
  const server = createHistoryServer(index, upstream);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v8/management/thread-history/threads`;
  try {
    assert.equal((await fetch(url)).status, 401);
    assert.equal(
      (await fetch(url, { headers: { Authorization: 'Bearer synthetic-client-key' } })).status,
      401
    );
    const response = await fetch(url, { headers: { Authorization: 'Bearer synthetic-admin' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-encoding'), 'gzip');
    assert.equal((await response.json()).threads.length, 3);
    const etag = response.headers.get('etag')!;
    assert.equal(
      (
        await fetch(url, {
          headers: { Authorization: 'Bearer synthetic-admin', 'If-None-Match': etag },
        })
      ).status,
      304
    );
    revoked = true;
    assert.equal(
      (
        await fetch(url, {
          headers: { Authorization: 'Bearer synthetic-admin', 'If-None-Match': etag },
        })
      ).status,
      401
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  console.log(
    'PASS: complete index, exact reconstructed history, deduplication, warm restart, retention, compression, auth and ETags.'
  );
} finally {
  auth.close();
  index?.db.close();
  rmSync(directory, { recursive: true, force: true });
}
