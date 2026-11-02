import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useAuthStore, useConfigStore } from '@/stores';
import { apiClient } from '@/services/api/client';
import { createThreadHistoryApi } from '@/services/api/threadHistory';
import { CompleteHistoryLoader } from '../model/CompleteHistoryLoader';

let session: { revision: number; loader: CompleteHistoryLoader } | undefined;

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

function getSession(revision: number): CompleteHistoryLoader {
  if (session?.revision === revision) return session.loader;
  session?.loader.clear();
  const historyApi = createThreadHistoryApi(apiClient.captureConnection());
  const loader = new CompleteHistoryLoader({
    fetch: historyApi.fetch,
    isCurrent: () =>
      revision === apiClient.getConnectionRevision() && useAuthStore.getState().isAuthenticated,
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

  return { ...snapshot, config, refresh: loader.refresh };
}
