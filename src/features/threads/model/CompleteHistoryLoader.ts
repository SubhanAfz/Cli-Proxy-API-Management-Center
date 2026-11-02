import type { CompleteHistory, createThreadHistoryApi } from '@/services/api/threadHistory';

interface Source {
  fetch: ReturnType<typeof createThreadHistoryApi>['fetch'];
  isCurrent: () => boolean;
  wait?: (signal: AbortSignal) => Promise<void>;
}

const empty = () =>
  ({
    ready: false,
    threads: [],
    indexed: 0,
    total: 0,
    completed: 0,
    failed: 0,
    unavailable: 0,
    loading: false,
    error: '',
  }) as CompleteHistory & { loading: boolean; error: string };

function waitForIndex(signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, 2000);
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Fetches the complete materialized history in one compressed response, never a partial page. */
export class CompleteHistoryLoader {
  private snapshot = empty();
  private etag: string | undefined;
  private controller: AbortController | undefined;
  private pending: Promise<void> | undefined;
  private listeners = new Set<() => void>();
  private owners = new Set<symbol>();

  constructor(private readonly source: Source) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<typeof this.snapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  retain = () => {
    const owner = Symbol();
    this.owners.add(owner);
    return () => {
      this.owners.delete(owner);
      if (!this.owners.size) this.cancel();
    };
  };
  cancel = () => {
    this.controller?.abort();
    this.controller = undefined;
    this.pending = undefined;
    if (this.snapshot.loading) this.publish({ loading: false });
  };
  clear = () => {
    this.cancel();
    this.etag = undefined;
    this.snapshot = empty();
    this.listeners.forEach((listener) => listener());
  };

  refresh = (): Promise<void> => {
    if (this.pending) return this.pending;
    if (!this.source.isCurrent()) return Promise.resolve();
    const abort = new AbortController();
    this.controller = abort;
    const current = () =>
      this.controller === abort && !abort.signal.aborted && this.source.isCurrent();
    this.publish({ loading: true, error: '' });
    this.pending = Promise.resolve().then(async () => {
      try {
        while (current()) {
          const response = await this.source.fetch(this.etag, abort.signal);
          if (!current()) return;
          if (response.notModified) {
            this.publish({ loading: false });
            return;
          }
          if (!response.data.ready) {
            this.publish({ completed: response.data.completed ?? 0, total: response.data.total });
            await (this.source.wait ?? waitForIndex)(abort.signal);
            continue;
          }
          this.etag = response.etag;
          this.publish({ ...response.data, completed: response.data.total, loading: false });
          return;
        }
      } catch (error) {
        if (current())
          this.publish({
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          });
      } finally {
        if (this.controller === abort) {
          this.controller = undefined;
          this.pending = undefined;
        }
      }
    });
    return this.pending;
  };
}
