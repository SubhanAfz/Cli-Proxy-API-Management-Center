import { apiClient } from './client';
import type { ConversationThread } from '@/features/threads/types';
import { isRecord } from '@/utils/helpers';

export interface CompleteHistory {
  ready: boolean;
  threads: ConversationThread[];
  indexed: number;
  total: number;
  completed?: number;
  failed: number;
  unavailable: number;
}

export const createThreadHistoryApi = (client = apiClient) => ({
  async fetch(etag?: string, signal?: AbortSignal) {
    // This path belongs to the companion's HTTP extension, not the upstream proxy API.
    const response = await client.getRaw('/thread-history/threads', {
      signal,
      timeout: 30000,
      headers: etag ? { 'If-None-Match': etag } : {},
      validateStatus: (status) => (status >= 200 && status < 300) || status === 304,
    });
    if (response.status === 304) return { notModified: true as const };
    const data: unknown = response.data;
    if (!isRecord(data) || typeof data.ready !== 'boolean' || !Array.isArray(data.threads)) {
      throw new Error('Invalid conversation index response');
    }
    if (
      data.threads.some(
        (thread: unknown) =>
          !isRecord(thread) ||
          typeof thread.id !== 'string' ||
          !Array.isArray(thread.items) ||
          !Array.isArray(thread.requests) ||
          !Array.isArray(thread.models)
      )
    ) {
      throw new Error('Invalid indexed conversation');
    }
    return {
      notModified: false as const,
      data: data as unknown as CompleteHistory,
      etag: typeof response.headers.etag === 'string' ? response.headers.etag : undefined,
    };
  },
});
