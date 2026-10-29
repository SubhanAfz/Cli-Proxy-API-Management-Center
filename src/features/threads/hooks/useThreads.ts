import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuthStore, useConfigStore } from '@/stores';
import { apiClient } from '@/services/api/client';
import { logsApi, responseDataToText } from '@/services/api/logs';
import {
  buildConversationThreads,
  extractRequestReferences,
  parseConversationRequest,
} from '../model/conversations';
import type { ConversationRequest, RequestReference } from '../types';
import { conversationIndexQuery } from '../model/logIndex';

interface Snapshot {
  revision: number;
  requests: ConversationRequest[];
  loading: boolean;
  completed: number;
  total: number;
  unavailable: number;
  failed: number;
  error: string;
}

const emptySnapshot = (revision: number): Snapshot => ({
  revision,
  requests: [],
  loading: false,
  completed: 0,
  total: 0,
  unavailable: 0,
  failed: 0,
  error: '',
});

export function useThreads(autoRefresh: boolean, active = true) {
  const apiBase = useAuthStore((state) => state.apiBase);
  const managementKey = useAuthStore((state) => state.managementKey);
  const config = useConfigStore((state) => state.config);
  const revision = apiClient.getConnectionRevision();
  const [snapshot, setSnapshot] = useState<Snapshot>(() => emptySnapshot(revision));
  const cache = useRef(new Map<string, ConversationRequest>());
  const references = useRef(new Map<string, RequestReference>());
  const cursor = useRef<string | undefined>(undefined);
  const unavailable = useRef(new Set<string>());
  const failed = useRef(new Set<string>());
  const controller = useRef<AbortController | null>(null);
  const pending = useRef<Promise<void> | null>(null);

  const refresh = useCallback((retryMissing = false): Promise<void> => {
    if (pending.current) return pending.current;
    const currentRevision = apiClient.getConnectionRevision();
    const abort = new AbortController();
    controller.current = abort;
    const current = () =>
      !abort.signal.aborted && currentRevision === apiClient.getConnectionRevision();
    if (retryMissing) {
      unavailable.current.clear();
      failed.current.clear();
    }
    const publish = (patch: Partial<Snapshot>) => {
      if (current())
        setSnapshot((old) => ({
          ...(old.revision === currentRevision ? old : emptySnapshot(currentRevision)),
          revision: currentRevision,
          requests: [...cache.current.values()],
          unavailable: unavailable.current.size,
          failed: failed.current.size,
          ...patch,
        }));
    };
    publish({ loading: true, error: '', completed: 0 });
    const task = (async () => {
      try {
        // Omitting limit reads every retained operational log, including rotated main logs.
        let more = true;
        while (more && current()) {
          const previousCursor = cursor.current;
          let index = await logsApi.fetchLogs(conversationIndexQuery(previousCursor), {
            signal: abort.signal,
          });
          if (!current()) return;
          if (index.cursorReset && previousCursor) {
            index = await logsApi.fetchLogs(conversationIndexQuery(), { signal: abort.signal });
            if (!current()) return;
          }
          for (const reference of extractRequestReferences(index.lines)) {
            const old = references.current.get(reference.id);
            references.current.set(reference.id, {
              ...reference,
              sequence: old?.sequence ?? references.current.size,
            });
          }
          cursor.current = index.nextCursor || undefined;
          more = Boolean(
            previousCursor &&
            index.lines.length >= 1000 &&
            cursor.current &&
            cursor.current !== previousCursor
          );
        }
        const missing = [...references.current.values()].filter(
          (r) =>
            !cache.current.has(r.id) && !unavailable.current.has(r.id) && !failed.current.has(r.id)
        );
        let next = 0;
        let completed = 0;
        publish({ total: missing.length });
        const worker = async () => {
          while (current() && next < missing.length) {
            const reference = missing[next++];
            try {
              const response = await logsApi.downloadRequestLogById(reference.id, {
                signal: abort.signal,
              });
              const text = await responseDataToText(response.data);
              if (!current()) return;
              cache.current.set(reference.id, parseConversationRequest(text, reference));
            } catch (error: unknown) {
              if (!current()) return;
              const status =
                typeof error === 'object' && error !== null && 'status' in error
                  ? error.status
                  : undefined;
              if (status === 401 || status === 403) {
                publish({
                  loading: false,
                  error: error instanceof Error ? error.message : String(error),
                });
                abort.abort();
                return;
              }
              if (status === 404) unavailable.current.add(reference.id);
              else failed.current.add(reference.id);
            }
            completed++;
            publish({ completed });
          }
        };
        // Bound downloads so a busy gateway is not flooded by the conversation viewer.
        await Promise.all(Array.from({ length: Math.min(3, missing.length) }, worker));
        publish({ loading: false });
      } catch (error: unknown) {
        publish({ loading: false, error: error instanceof Error ? error.message : String(error) });
      } finally {
        if (controller.current === abort) {
          controller.current = null;
          pending.current = null;
        }
      }
    })();
    pending.current = task;
    return task;
  }, []);

  useEffect(() => {
    controller.current?.abort();
    pending.current = null;
    cache.current.clear();
    references.current.clear();
    cursor.current = undefined;
    unavailable.current.clear();
    failed.current.clear();
    if (active) void refresh();
    return () => {
      controller.current?.abort();
      pending.current = null;
    };
  }, [apiBase, managementKey, refresh, active]);

  useEffect(() => {
    if (!autoRefresh || !active) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 15000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, refresh, active]);

  const safeSnapshot = snapshot.revision === revision ? snapshot : emptySnapshot(revision);
  const threads = useMemo(
    () => buildConversationThreads(safeSnapshot.requests),
    [safeSnapshot.requests]
  );
  return { ...safeSnapshot, threads, config, refresh };
}
