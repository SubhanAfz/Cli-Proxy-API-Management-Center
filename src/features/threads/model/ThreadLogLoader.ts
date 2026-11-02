import type { LogsQuery, LogsResponse } from '@/services/api/logs';
import { extractRequestReferences, parseConversationRequest } from './conversations';
import { conversationIndexQuery } from './logIndex';
import type { ConversationRequest, RequestReference } from '../types';

export const THREAD_LOG_BATCH_SIZE = 12;

export interface ThreadLogSnapshot {
  requests: ConversationRequest[];
  loading: boolean;
  completed: number;
  total: number;
  indexed: number;
  remaining: number;
  unavailable: number;
  failed: number;
  error: string;
}

interface Source {
  fetchIndex: (query: LogsQuery, signal: AbortSignal) => Promise<LogsResponse>;
  download: (reference: RequestReference, signal: AbortSignal) => Promise<string>;
  isCurrent: () => boolean;
  yieldToBrowser?: () => Promise<void>;
}

/** An in-memory, connection-scoped reader. The index is cheap; transcripts are loaded on demand. */
export class ThreadLogLoader {
  private cache = new Map<string, ConversationRequest>();
  private references = new Map<string, RequestReference>();
  private unavailable = new Set<string>();
  private failed = new Set<string>();
  private resume = new Set<string>();
  private cursor: string | undefined;
  private controller: AbortController | null = null;
  private pending: Promise<void> | null = null;
  private listeners = new Set<() => void>();
  private owners = new Set<symbol>();
  private dirty = false;
  private snapshot: ThreadLogSnapshot = {
    requests: [],
    loading: false,
    completed: 0,
    total: 0,
    indexed: 0,
    remaining: 0,
    unavailable: 0,
    failed: 0,
    error: '',
  };

  constructor(private readonly source: Source) {}

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  // Transition layers can overlap. An old layer must not cancel the new layer's work.
  retain = () => {
    const owner = Symbol();
    this.owners.add(owner);
    return () => {
      this.owners.delete(owner);
      if (!this.owners.size) this.cancel();
    };
  };

  private publish(patch: Partial<ThreadLogSnapshot>) {
    this.snapshot = {
      ...this.snapshot,
      requests: this.dirty ? [...this.cache.values()] : this.snapshot.requests,
      indexed: this.references.size,
      remaining: Math.max(
        0,
        this.references.size - this.cache.size - this.unavailable.size - this.failed.size
      ),
      unavailable: this.unavailable.size,
      failed: this.failed.size,
      ...patch,
    };
    this.dirty = false;
    this.listeners.forEach((listener) => listener());
  }

  cancel = () => {
    this.controller?.abort();
    this.controller = null;
    this.pending = null;
    if (this.snapshot.loading) this.publish({ loading: false });
  };

  clear = () => {
    this.cancel();
    this.cache.clear();
    this.references.clear();
    this.unavailable.clear();
    this.failed.clear();
    this.resume.clear();
    this.cursor = undefined;
    this.dirty = true;
    this.publish({ loading: false, completed: 0, total: 0, error: '' });
  };

  refresh = (retryFailed = false) => this.run(false, retryFailed);
  loadOlder = () => this.run(true, false);

  private run(older: boolean, retryFailed: boolean): Promise<void> {
    if (this.pending) return this.pending;
    if (!this.source.isCurrent()) return Promise.resolve();
    const abort = new AbortController();
    this.controller = abort;
    const current = () =>
      this.controller === abort && !abort.signal.aborted && this.source.isCurrent();
    this.publish({ loading: true, error: '', completed: 0, total: 0 });
    // Schedule after assigning pending, even if a source throws synchronously.
    const task = Promise.resolve().then(async () => {
      try {
        const discovered = new Set<string>();
        if (!older) {
          let more = true;
          while (more && current()) {
            const previous = this.cursor;
            let index = await this.source.fetchIndex(
              conversationIndexQuery(previous),
              abort.signal
            );
            if (!current()) return;
            if (index.cursorReset && previous) {
              index = await this.source.fetchIndex(conversationIndexQuery(), abort.signal);
              if (!current()) return;
            }
            for (const reference of extractRequestReferences(index.lines)) {
              const old = this.references.get(reference.id);
              if (!old) discovered.add(reference.id);
              this.references.set(reference.id, {
                ...reference,
                sequence: old?.sequence ?? this.references.size,
              });
            }
            this.cursor = index.nextCursor || undefined;
            more = Boolean(
              previous && index.lines.length >= 1000 && this.cursor && this.cursor !== previous
            );
          }
        }
        if (!current()) return;
        const candidates = [...this.references.values()]
          .filter(
            (r) =>
              !this.cache.has(r.id) &&
              !this.unavailable.has(r.id) &&
              (older
                ? !this.failed.has(r.id)
                : discovered.has(r.id) ||
                  this.resume.has(r.id) ||
                  (retryFailed && this.failed.has(r.id)))
          )
          .sort(
            (a, b) =>
              b.timestamp.localeCompare(a.timestamp) || (b.sequence ?? 0) - (a.sequence ?? 0)
          )
          .slice(0, THREAD_LOG_BATCH_SIZE);
        candidates.forEach((r) => this.resume.add(r.id));
        let next = 0;
        let completed = 0;
        let lastPublish = 0;
        this.publish({ total: candidates.length });
        const worker = async () => {
          while (current() && next < candidates.length) {
            const reference = candidates[next++];
            try {
              const text = await this.source.download(reference, abort.signal);
              if (!current()) return;
              this.cache.set(reference.id, parseConversationRequest(text, reference));
              this.dirty = true;
              this.failed.delete(reference.id);
            } catch (error: unknown) {
              if (!current()) return;
              const status =
                typeof error === 'object' && error !== null && 'status' in error
                  ? error.status
                  : undefined;
              if (status === 401 || status === 403) {
                this.publish({
                  error: error instanceof Error ? error.message : String(error),
                  loading: false,
                });
                abort.abort();
                return;
              }
              if (status === 404) {
                this.unavailable.add(reference.id);
                this.failed.delete(reference.id);
              } else this.failed.add(reference.id);
            }
            this.resume.delete(reference.id);
            completed++;
            // The first result is immediate; subsequent results rebuild the view at most 5x/sec.
            if (Date.now() - lastPublish >= 200) {
              this.publish({ completed });
              lastPublish = Date.now();
            }
            await this.source.yieldToBrowser?.();
          }
        };
        await Promise.all(Array.from({ length: Math.min(3, candidates.length) }, worker));
        if (current()) this.publish({ loading: false, completed });
      } catch (error: unknown) {
        if (current())
          this.publish({
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          });
      } finally {
        if (this.controller === abort) {
          this.controller = null;
          this.pending = null;
        }
      }
    });
    this.pending = task;
    return task;
  }
}
