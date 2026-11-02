import { expect, test } from 'bun:test';
import { CompleteHistoryLoader } from '../src/features/threads/model/CompleteHistoryLoader';
import type { CompleteHistory } from '../src/services/api/threadHistory';
import type { ConversationThread } from '../src/features/threads/types';

const history = (): CompleteHistory => ({
  ready: true,
  threads: Array.from({ length: 2000 }, (_, n) => ({ id: `thread-${n}` }) as ConversationThread),
  total: 50000,
  indexed: 50000,
  failed: 0,
  unavailable: 0,
});

test('one index request automatically loads every thread and 304 preserves cached object identity', async () => {
  const calls: (string | undefined)[] = [];
  const data = history();
  const loader = new CompleteHistoryLoader({
    fetch: async (etag) => {
      calls.push(etag);
      return etag ? { notModified: true } : { notModified: false, data, etag: 'all-history' };
    },
    isCurrent: () => true,
  });
  await loader.refresh();
  expect(loader.getSnapshot().threads).toHaveLength(2000);
  expect(loader.getSnapshot().indexed).toBe(50000);
  const threads = loader.getSnapshot().threads;
  await loader.refresh();
  expect(loader.getSnapshot().threads).toBe(threads);
  expect(calls).toEqual([undefined, 'all-history']);
});

test('first-build progress automatically waits for complete history without showing a partial page', async () => {
  let first = true;
  const loader = new CompleteHistoryLoader({
    fetch: async () => {
      if (first) {
        first = false;
        return {
          notModified: false,
          data: { ...history(), ready: false, threads: [], completed: 12 },
        };
      }
      return { notModified: false, data: history() };
    },
    isCurrent: () => true,
    wait: async () => {},
  });
  await loader.refresh();
  expect(loader.getSnapshot()).toMatchObject({ ready: true, loading: false, indexed: 50000 });
  expect(loader.getSnapshot().threads).toHaveLength(2000);
});

test('logout or connection changes discard late full-index responses and clear history', async () => {
  let finish: ((value: { notModified: false; data: CompleteHistory }) => void) | undefined;
  const loader = new CompleteHistoryLoader({
    fetch: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    isCurrent: () => true,
  });
  const pending = loader.refresh();
  await new Promise((resolve) => setTimeout(resolve, 0));
  loader.clear();
  finish!({ notModified: false, data: history() });
  await pending;
  expect(loader.getSnapshot()).toMatchObject({ threads: [], ready: false, loading: false });
});

test('overlapping navigation owners share one complete-index fetch', async () => {
  let finish: ((value: { notModified: false; data: CompleteHistory }) => void) | undefined;
  let signal: AbortSignal | undefined;
  let calls = 0;
  const loader = new CompleteHistoryLoader({
    fetch: (_, s) => {
      calls++;
      signal = s;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    isCurrent: () => true,
  });
  const old = loader.retain();
  const pending = loader.refresh();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const next = loader.retain();
  old();
  expect(signal!.aborted).toBe(false);
  expect(loader.refresh()).toBe(pending);
  finish!({ notModified: false, data: history() });
  await pending;
  next();
  expect(calls).toBe(1);
  expect(loader.getSnapshot().threads).toHaveLength(2000);
});
