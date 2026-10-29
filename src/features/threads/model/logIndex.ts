import type { LogsQuery } from '@/services/api/logs';

// The backend's parseLimit rejects an explicit zero. Omit limit for a full retained scan.
export function conversationIndexQuery(cursor?: string): LogsQuery {
  return cursor ? { cursor, limit: 1000 } : {};
}
