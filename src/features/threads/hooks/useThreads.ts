import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useAuthStore, useConfigStore } from '@/stores';
import { apiClient } from '@/services/api/client';
import { createLogsApi, responseDataToText } from '@/services/api/logs';
import { buildConversationThreads } from '../model/conversations';
import { ThreadLogLoader } from '../model/ThreadLogLoader';

let session: { revision: number; loader: ThreadLogLoader } | undefined;

// Clear private history immediately on logout or connection change, including off this route.
useAuthStore.subscribe((state, previous) => {
  if (
    !state.isAuthenticated ||
    state.apiBase !== previous.apiBase ||
    state.managementKey !== previous.managementKey
  ) {
    session?.loader.clear();
    session = undefined;
  }
});

function getSession(revision: number): ThreadLogLoader {
  if (session?.revision === revision) return session.loader;
  session?.loader.clear();
  const logsApi = createLogsApi(apiClient.captureConnection());
  const loader = new ThreadLogLoader({
    fetchIndex: (query, signal) => logsApi.fetchLogs(query, { signal }),
    download: async (reference, signal) => {
      const response = await logsApi.downloadRequestLogById(reference.id, { signal });
      return responseDataToText(response.data);
    },
    isCurrent: () =>
      revision === apiClient.getConnectionRevision() && useAuthStore.getState().isAuthenticated,
    yieldToBrowser: () => new Promise((resolve) => window.setTimeout(resolve, 0)),
  });
  session = { revision, loader };
  return loader;
}

export function useThreads(autoRefresh: boolean, active = true) {
  const apiBase = useAuthStore((state) => state.apiBase);
  const managementKey = useAuthStore((state) => state.managementKey);
  const config = useConfigStore((state) => state.config);
  const revision = apiClient.getConnectionRevision();
  const loader = useMemo(() => getSession(revision), [revision]);
  const snapshot = useSyncExternalStore(loader.subscribe, loader.getSnapshot);

  useEffect(() => {
    if (!active) return;
    const release = loader.retain();
    void loader.refresh();
    return release;
  }, [apiBase, managementKey, loader, active]);

  useEffect(() => {
    if (!autoRefresh || !active) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loader.refresh();
    }, 15000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, loader, active]);

  const threads = useMemo(() => buildConversationThreads(snapshot.requests), [snapshot.requests]);
  return { ...snapshot, threads, config, refresh: loader.refresh, loadOlder: loader.loadOlder };
}
