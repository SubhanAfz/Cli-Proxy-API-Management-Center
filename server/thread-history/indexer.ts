import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  buildConversationThreads,
  extractRequestReferences,
  groupConversationRequests,
  mergeConversationRequestItems,
  parseConversationRequest,
} from '../../src/features/threads/model/conversations';
import type {
  ConversationItem,
  ConversationRequest,
  ConversationThread,
} from '../../src/features/threads/types';

export class HistoryIndex {
  readonly db: DatabaseSync;
  snapshot: { raw: Buffer; gzip: Buffer; etag: string } | undefined;
  progress = { completed: 0, total: 0, indexing: false };

  constructor(
    private readonly logDir: string,
    database: string
  ) {
    this.db = new DatabaseSync(database);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=NORMAL;
      CREATE TABLE IF NOT EXISTS files (
        name TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime REAL NOT NULL,
        request TEXT, error INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS items (hash TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS file_items (
        name TEXT NOT NULL, ordinal INTEGER NOT NULL, hash TEXT NOT NULL,
        PRIMARY KEY(name, ordinal)
      );
      CREATE INDEX IF NOT EXISTS file_items_hash ON file_items(hash);
      CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, data BLOB NOT NULL);
    `);
    const saved = this.db.prepare("SELECT data FROM state WHERE key='snapshot'").get();
    if (saved) this.setSnapshot(Buffer.from(saved.data as Uint8Array));
    // Retry malformed/unsupported files once after an indexer upgrade or restart.
    this.db.exec('UPDATE files SET mtime=-1 WHERE error=1');
  }

  private setSnapshot(raw: Buffer) {
    this.snapshot = {
      raw,
      gzip: gzipSync(raw),
      etag: '"' + createHash('sha256').update(raw).digest('hex') + '"',
    };
  }

  async scan() {
    if (this.progress.indexing) return;
    this.progress = { completed: 0, total: 0, indexing: true };
    try {
      const recovering = Boolean(this.db.prepare("SELECT 1 FROM state WHERE key='dirty'").get());
      const markDirty = this.db.prepare("INSERT OR REPLACE INTO state(key,data) VALUES('dirty',?)");
      const entries = await readdir(this.logDir, { withFileTypes: true });
      const names = entries
        .filter((e) => e.isFile() && /-[a-f0-9]{8,64}\.log$/i.test(e.name))
        .map((e) => e.name);
      this.progress.total = names.length;
      const refs = new Map();
      for (const file of entries
        .filter((e) => e.isFile() && e.name.startsWith('main') && e.name.endsWith('.log'))
        .sort((a, b) => a.name.localeCompare(b.name))) {
        for (const r of extractRequestReferences(
          (await readFile(join(this.logDir, file.name), 'utf8')).split('\n')
        ))
          refs.set(r.id, r);
      }
      const known = new Map(
        this.db
          .prepare('SELECT name, size, mtime, request FROM files')
          .all()
          .map((r) => [String(r.name), r])
      );
      const present = new Set(names);
      const changed = new Set<string>();
      const removeItems = this.db.prepare('DELETE FROM file_items WHERE name=?');
      for (const [name] of known) {
        if (!present.has(name)) {
          this.db.exec('BEGIN');
          try {
            markDirty.run(Buffer.from('1'));
            removeItems.run(name);
            this.db.prepare('DELETE FROM files WHERE name=?').run(name);
            this.db.exec('COMMIT');
          } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
          }
          changed.add(name);
        }
      }
      const putFile = this.db.prepare(
        'INSERT OR REPLACE INTO files(name,size,mtime,request,error) VALUES(?,?,?,?,?)'
      );
      const putItem = this.db.prepare('INSERT OR IGNORE INTO items(hash,data) VALUES(?,?)');
      const linkItem = this.db.prepare('INSERT INTO file_items(name,ordinal,hash) VALUES(?,?,?)');
      for (const name of names.sort()) {
        const path = join(this.logDir, name);
        let info;
        try {
          info = await stat(path);
        } catch {
          continue;
        }
        const old = known.get(name);
        if (old && old.size === info.size && old.mtime === info.mtimeMs) {
          this.progress.completed++;
          continue;
        }
        // The proxy can still be finishing this file. Pick it up on the next scan.
        if (Date.now() - info.mtimeMs < 500) continue;
        const id = name.match(/-([a-f0-9]{8,64})\.log$/i)![1];
        const reference = refs.get(id) ?? { id, timestamp: '', path: '', sequence: 0 };
        let request: ConversationRequest | undefined;
        let unsupported = false;
        try {
          const text = await readFile(path, 'utf8');
          const url = text.match(/^URL:\s*(.+)$/m)?.[1]?.trim() ?? '';
          // The live-audio wire dump is not a JSON text-conversation transcript.
          unsupported = new URL(url, 'http://localhost').pathname === '/v1/live';
          if (!unsupported) request = parseConversationRequest(text, reference);
          const after = await stat(path);
          if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) continue;
        } catch {
          /* Track malformed logs without exposing their contents in operational logs. */
        }
        this.db.exec('BEGIN');
        try {
          markDirty.run(Buffer.from('1'));
          removeItems.run(name);
          putFile.run(
            name,
            info.size,
            info.mtimeMs,
            request ? JSON.stringify({ ...request, items: [] }) : null,
            request ? 0 : unsupported ? 2 : 1
          );
          request?.items.forEach((item, ordinal) => {
            const data = JSON.stringify({ ...item, requestId: '' });
            const hash = createHash('sha256').update(data).digest('hex');
            putItem.run(hash, data);
            linkItem.run(name, ordinal, hash);
          });
          this.db.exec('COMMIT');
        } catch (error) {
          this.db.exec('ROLLBACK');
          throw error;
        }
        changed.add(name);
        this.progress.completed++;
        // Yield between files so the HTTP server can serve its already-built snapshot.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }

      if (!changed.size && this.snapshot && !recovering) return;
      const all = this.db
        .prepare('SELECT name, request FROM files WHERE error=0 ORDER BY name')
        .all();
      const records = all.map((r) => ({
        name: String(r.name),
        request: JSON.parse(String(r.request)) as ConversationRequest,
      }));
      const namesByRequest = new Map(records.map((r) => [r.request.id, r.name]));
      const groups = groupConversationRequests(records.map((r) => r.request));
      const oldGroups = groupConversationRequests(
        [...known.values()]
          .filter((r) => r.request)
          .map((r) => JSON.parse(String(r.request)) as ConversationRequest)
      );
      const changedIds = new Set<string>();
      for (const name of changed) {
        const previous = known.get(name)?.request;
        if (previous) changedIds.add((JSON.parse(String(previous)) as ConversationRequest).id);
      }
      for (const record of records) if (changed.has(record.name)) changedIds.add(record.request.id);
      const dirty = new Set<string>();
      for (const [id, requests] of [...oldGroups, ...groups]) {
        if (requests.some((r) => changedIds.has(r.id))) dirty.add(id);
      }
      const readItems = this.db.prepare(
        'SELECT items.data FROM file_items JOIN items ON items.hash=file_items.hash WHERE file_items.name=? ORDER BY ordinal'
      );
      const putThread = this.db.prepare('INSERT OR REPLACE INTO threads(id,data) VALUES(?,?)');
      for (const [id, metadata] of groups) {
        if (
          !recovering &&
          !dirty.has(id) &&
          this.db.prepare('SELECT 1 FROM threads WHERE id=?').get(id)
        )
          continue;
        let items: ConversationItem[] = [];
        for (const request of metadata) {
          const incoming = readItems
            .all(namesByRequest.get(request.id)!)
            .map(
              (r) => ({ ...JSON.parse(String(r.data)), requestId: request.id }) as ConversationItem
            );
          items = mergeConversationRequestItems(items, { ...request, items: incoming });
        }
        const latest = metadata[metadata.length - 1];
        const thread = buildConversationThreads([
          { ...latest, threadId: id, previousResponseId: undefined, items },
        ])[0];
        thread.requests = metadata;
        thread.models = [...new Set(metadata.map((r) => r.model).filter(Boolean))];
        thread.client = metadata.find((r) => r.client)?.client ?? '';
        thread.inputTokens = metadata.reduce((n, r) => n + r.inputTokens, 0);
        thread.outputTokens = metadata.reduce((n, r) => n + r.outputTokens, 0);
        thread.hasErrors ||= metadata.some((r) => (r.status ?? 0) >= 400);
        putThread.run(id, JSON.stringify(thread));
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      for (const row of this.db.prepare('SELECT id FROM threads').all()) {
        if (!groups.has(String(row.id)))
          this.db.prepare('DELETE FROM threads WHERE id=?').run(String(row.id));
      }
      this.db.exec(
        'DELETE FROM items WHERE NOT EXISTS (SELECT 1 FROM file_items WHERE file_items.hash=items.hash)'
      );
      const threads = this.db
        .prepare('SELECT data FROM threads')
        .all()
        .map((r) => JSON.parse(String(r.data)) as ConversationThread)
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp) || a.id.localeCompare(b.id));
      const retainedIds = new Set(names.map((name) => name.match(/-([a-f0-9]{8,64})\.log$/i)![1]));
      const payload = Buffer.from(
        JSON.stringify({
          ready: true,
          threads,
          indexed: records.length,
          total:
            names.length -
            Number(this.db.prepare('SELECT COUNT(*) AS n FROM files WHERE error=2').get()!.n),
          failed: Number(this.db.prepare('SELECT COUNT(*) AS n FROM files WHERE error=1').get()!.n),
          unavailable: [...refs.keys()].filter((id) => !retainedIds.has(id)).length,
        })
      );
      this.setSnapshot(payload);
      this.db.exec('BEGIN');
      try {
        this.db.prepare("INSERT OR REPLACE INTO state(key,data) VALUES('snapshot',?)").run(payload);
        this.db.prepare("DELETE FROM state WHERE key='dirty'").run();
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    } finally {
      this.progress.indexing = false;
    }
  }
}
