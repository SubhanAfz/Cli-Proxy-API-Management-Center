# Conversation viewer

Open **Observe → Threads**, or visit `management.html#/threads` after signing in with your management key.

Every retained, parseable text conversation loads automatically. There are no history pages or “show earlier” controls. Search and Markdown export cover the complete loaded history, including every tool argument and result. User messages appear as bubbles; model replies support Markdown, code, lists, tables, and links. Expand activity and tool rows to inspect recorded work. System/developer context can be shown separately.

## How full-history loading stays fast

The `server/thread-history` companion scans the Pi's retained request logs once. It shares the frontend parser and ordered history stitching, so repeated request snapshots become one conversation. SQLite stores identical message/tool bodies once, with request references linking to them. Materialized threads contain merged messages and request metadata rather than hundreds of duplicated histories.

The dashboard fetches **one complete compressed snapshot** from `/v8/management/thread-history/threads`. Subsequent polls send an ETag; an unchanged index returns HTTP 304 without transferring history again. The companion checks for new or changed files every three seconds and rebuilds only affected threads. A durable dirty marker recovers interrupted builds. Saved complete snapshots remain usable during incremental updates and service restarts.

The browser keeps the complete snapshot in memory across dashboard navigation. Sign-out or a connection/management-key change immediately cancels requests and clears this private cache. A reload retrieves the full snapshot again. The Live switch checks for updates every 15 seconds while the page is visible.

Every conversation message is present in memory and the DOM. CSS `content-visibility` lets the browser skip offscreen layout; expensive Markdown formatting is deferred automatically until text approaches the viewport. Scrolling needs no network request or paging button. Tool bodies remain collapsed until opened, and hidden arguments are not formatted unnecessarily.

## Companion deployment

The frontend still builds to one self-contained `dist/index.html`, installed as `management.html`. The optional companion is a separate Node.js 24 service; it does not replace or restart CLIProxyAPI.

```sh
bun install --frozen-lockfile
bun run verify
```

`bun run build:history` produces `server/thread-history/build/index.mjs`. Install it with a private Node.js 24 runtime and the provided `cliproxy-history.service`. Its defaults are:

- Listen: `127.0.0.1:8318`.
- Read-only logs: `/var/lib/cliproxyapi/auth/logs`.
- Private state: `/var/lib/cliproxy-history/history.sqlite`.
- Authentication check: the local proxy's existing v8 management API.

Environment overrides are `HISTORY_PORT`, `HISTORY_LOG_DIR`, `HISTORY_STATE_DIR`, and `HISTORY_UPSTREAM`. The upstream must use `127.0.0.1`. Protect the state directory with mode 0700 and the SQLite files with mode 0600. Neither the database nor snapshots store raw Authorization headers or OAuth files.

Expose the extension under the same HTTPS origin. For this Pi's Tailscale Serve setup, add the `/v8/management/thread-history` path to port 8318 while keeping `/` pointed at the existing proxy on port 8317. The companion accepts both the full declared extension path and `/threads` for a prefix-stripping reverse proxy.

Every snapshot request is authenticated through the existing management API, including conditional requests. Client API keys are rejected. Revoked management credentials cannot retrieve cached history. Before the first complete build, HTTP 202 reports progress and the dashboard waits automatically. A missing/unavailable companion produces an error rather than quietly showing only recent history.

## Completeness and retention

The companion discovers retained request files directly, including files whose operational log index has rotated away. Groups use explicit thread/session IDs, Codex turn metadata, conversation IDs, prompt-cache IDs, or `previous_response_id` chains. Unidentified requests remain separate. Ordered anchors preserve repeated short messages and tool-result pairing. The native live-audio wire dump at `/v1/live` is not a JSON text-conversation transcript and is excluded from text-history counts.

The viewer can show only what was recorded and retained. Logging must remain enabled:

```yaml
observability:
  logs:
    logging-to-file: true
    request-log: true
```

When raw files expire under `logs-max-total-size-mb`, their request links are removed and affected threads are rebuilt from the remaining files. Unreferenced bodies are garbage-collected. Deleted raw history is not restored by increasing retention. Missing old request IDs and malformed text logs have separate notices. Reasoning is shown only if the upstream recorded a visible summary; private encrypted reasoning cannot be recovered.

Logged remote images are never automatically fetched. Attachments appear as indicators; Markdown does not execute raw HTML.

## Verification

Regression tests cover exact full-history reconstruction against the original parser, message deduplication, warm restarts, interrupted-build recovery, file retention, gzip, management authentication, revocation and ETags. Loader tests cover a complete 2,000-thread snapshot in one request, automatic initial-build waiting, cancellation, navigation ownership and logout isolation. A 2,000-message render includes every user turn without paging controls. Stitching is checked against ordered-anchor semantics over 500 randomized duplicate/insertion cases.

Production transcripts, credentials, and screenshots must never be committed as fixtures. Existing documentation screenshots use synthetic messages.
