import { expect, test } from 'bun:test';
import {
  ThreadLogLoader,
  THREAD_LOG_BATCH_SIZE,
} from '../src/features/threads/model/ThreadLogLoader';
import { makeLog } from './fixtures/conversationLogs';

const line = (n: number) =>
  `[2026-11-02 12:${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}] [req-${String(n).padStart(6, '0')}] [info] 200 | 1s | localhost | POST "/v1/responses"`;
const log = makeLog({ input: 'Synthetic message' }, { id: 'response-demo', output: [] });

test('thousands of index entries load only a bounded newest-first batch with at most three downloads', async () => {
  const calls: string[] = [];
  let concurrent = 0;
  let maximum = 0;
  const loader = new ThreadLogLoader({
    fetchIndex: async () => ({
      lines: Array.from({ length: 2000 }, (_, n) => line(n)),
      nextCursor: 'saved',
    }),
    download: async (r) => {
      calls.push(r.id);
      maximum = Math.max(maximum, ++concurrent);
      await new Promise((resolve) => setTimeout(resolve, 1));
      concurrent--;
      return log;
    },
    isCurrent: () => true,
  });
  await loader.refresh();
  expect(calls).toHaveLength(THREAD_LOG_BATCH_SIZE);
  expect(calls[0]).toBe('req-001999');
  expect(maximum).toBe(3);
  expect(loader.getSnapshot()).toMatchObject({
    indexed: 2000,
    remaining: 2000 - THREAD_LOG_BATCH_SIZE,
    loading: false,
  });
  const requests = loader.getSnapshot().requests;
  await loader.refresh();
  expect(calls).toHaveLength(THREAD_LOG_BATCH_SIZE);
  expect(loader.getSnapshot().requests).toBe(requests);
  await loader.loadOlder();
  expect(calls).toHaveLength(THREAD_LOG_BATCH_SIZE * 2);
  expect(calls[THREAD_LOG_BATCH_SIZE]).toBe('req-001987');
});

test('live refresh reads the cursor and downloads new traffic without draining older history', async () => {
  const queries: unknown[] = [];
  const calls: string[] = [];
  const loader = new ThreadLogLoader({
    fetchIndex: async (query) => {
      queries.push(query);
      return query.cursor
        ? { lines: [line(2000)], nextCursor: 'next' }
        : { lines: Array.from({ length: 2000 }, (_, n) => line(n)), nextCursor: 'saved' };
    },
    download: async (r) => {
      calls.push(r.id);
      return log;
    },
    isCurrent: () => true,
  });
  await loader.refresh();
  await loader.refresh();
  expect(queries).toEqual([{}, { cursor: 'saved', limit: 1000 }]);
  expect(calls).toHaveLength(THREAD_LOG_BATCH_SIZE + 1);
  expect(calls.at(-1)).toBe('req-002000');
  expect(loader.getSnapshot().remaining).toBe(2000 - THREAD_LOG_BATCH_SIZE);
});

test('failed downloads are retried explicitly and expired files are not repeatedly downloaded', async () => {
  let recover = false;
  const calls: string[] = [];
  const loader = new ThreadLogLoader({
    fetchIndex: async () => ({ lines: [line(0), line(1)], nextCursor: 'saved' }),
    download: async (r) => {
      calls.push(r.id);
      if (r.id === 'req-000000') throw Object.assign(new Error('gone'), { status: 404 });
      if (!recover) throw Object.assign(new Error('temporary'), { status: 503 });
      return log;
    },
    isCurrent: () => true,
  });
  await loader.refresh();
  expect(loader.getSnapshot()).toMatchObject({ unavailable: 1, failed: 1 });
  recover = true;
  await loader.refresh(true);
  expect(calls).toEqual(['req-000001', 'req-000000', 'req-000001']);
  expect(loader.getSnapshot()).toMatchObject({ unavailable: 1, failed: 0 });
});

test('connection changes and cancellation reject late results and clear cached private history', async () => {
  let resolve: ((text: string) => void) | undefined;
  let current = true;
  const loader = new ThreadLogLoader({
    fetchIndex: async () => ({ lines: [line(0)] }),
    download: () =>
      new Promise<string>((done) => {
        resolve = done;
      }),
    isCurrent: () => current,
  });
  const pending = loader.refresh();
  await new Promise((done) => setTimeout(done, 0));
  current = false;
  loader.clear();
  resolve!(log);
  await pending;
  expect(loader.getSnapshot()).toMatchObject({
    requests: [],
    indexed: 0,
    remaining: 0,
    loading: false,
  });
});

test('returning after cancellation resumes unfinished work and does not lose the saved cursor', async () => {
  let resolve: ((text: string) => void) | undefined;
  let blocked = true;
  const loader = new ThreadLogLoader({
    fetchIndex: async (query) => ({ lines: query.cursor ? [] : [line(0)], nextCursor: 'saved' }),
    download: () =>
      blocked
        ? new Promise<string>((done) => {
            resolve = done;
          })
        : Promise.resolve(log),
    isCurrent: () => true,
  });
  const first = loader.refresh();
  await new Promise((done) => setTimeout(done, 0));
  loader.cancel();
  blocked = false;
  await loader.refresh();
  resolve!(log);
  await first;
  expect(loader.getSnapshot().requests).toHaveLength(1);
  expect(loader.getSnapshot().loading).toBe(false);
});

test('a cursor reset rescans the index without redownloading cached snapshots', async () => {
  let resets = false;
  const queries: unknown[] = [];
  const downloads: string[] = [];
  const loader = new ThreadLogLoader({
    fetchIndex: async (query) => {
      queries.push(query);
      if (resets && query.cursor) return { lines: [], cursorReset: true };
      return { lines: resets ? [line(0), line(1)] : [line(0)], nextCursor: 'saved' };
    },
    download: async (r) => {
      downloads.push(r.id);
      return log;
    },
    isCurrent: () => true,
  });
  await loader.refresh();
  resets = true;
  await loader.refresh();
  expect(queries).toEqual([{}, { cursor: 'saved', limit: 1000 }, {}]);
  expect(downloads).toEqual(['req-000000', 'req-000001']);
});

test('overlapping transition owners do not cancel one another and the final release aborts', async () => {
  let resolve: ((text: string) => void) | undefined;
  let signal: AbortSignal | undefined;
  const loader = new ThreadLogLoader({
    fetchIndex: async () => ({ lines: [line(0)] }),
    download: (_, s) => {
      signal = s;
      return new Promise<string>((done) => {
        resolve = done;
      });
    },
    isCurrent: () => true,
  });
  const releaseOld = loader.retain();
  const pending = loader.refresh();
  await new Promise((done) => setTimeout(done, 0));
  const releaseNew = loader.retain();
  releaseOld();
  expect(signal!.aborted).toBe(false);
  releaseNew();
  expect(signal!.aborted).toBe(true);
  resolve!(log);
  await pending;
  expect(loader.getSnapshot().requests).toHaveLength(0);
});
