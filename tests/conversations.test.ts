import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  buildConversationThreads,
  cleanUserText,
  extractRequestReferences,
  mergeConversation,
  parseConversationRequest,
  threadMatches,
  exportConversation,
} from '../src/features/threads/model/conversations';
import { demoLogLines, demoLogs, makeLog } from './fixtures/conversationLogs';
import type { ConversationItem, RequestReference } from '../src/features/threads/types';
import { getLayerRenderLocation } from '../src/components/common/PageTransitionLayer';
import { conversationIndexQuery } from '../src/features/threads/model/logIndex';

const reference = (id = 'aaaa0001'): RequestReference => ({
  id,
  timestamp: '2026-10-29 19:51:24',
  path: '/v1/responses',
  status: 200,
});
const message = (text: string): ConversationItem => ({
  id: '',
  requestId: 'test',
  kind: 'message',
  role: 'user',
  text,
});

describe('conversation request discovery and parsing', () => {
  test('full index scans omit limit because the v8 backend rejects limit=0', () => {
    expect(conversationIndexQuery()).toEqual({});
    expect(conversationIndexQuery('saved-cursor')).toEqual({ cursor: 'saved-cursor', limit: 1000 });
  });
  test('discovers retained inference requests and excludes management/model traffic', () => {
    const values = extractRequestReferences([
      ...demoLogLines,
      demoLogLines[0],
      '[2026-10-29 19:51:24] [dddd1111] [info] 200 | 0s | 127.0.0.1 | GET "/v1/models"',
    ]);
    expect(values).toHaveLength(4);
    expect(values[0]).toMatchObject({ id: 'aaaa0001', duration: '2.4s', status: 200 });
  });

  test('parses full SSE outputs, visible reasoning, metadata and usage once', () => {
    const value = parseConversationRequest(demoLogs.aaaa0001, reference());
    expect(value.threadId).toBe('thread-demo');
    expect(value.client).toBe('T3 Code');
    expect(value.inputTokens).toBe(1280);
    expect(value.items.map((item) => item.kind)).toEqual([
      'message',
      'message',
      'message',
      'reasoning',
      'tool',
    ]);
    expect(value.items[0].context).toBe(true);
    expect(value.items[4]).toMatchObject({ name: 'functions.exec', callId: 'call-1' });
    expect(JSON.stringify(value)).not.toContain('Bearer');
  });

  test('reads thread IDs from Codex client metadata when headers are absent', () => {
    const log = makeLog(
      {
        model: 'demo',
        input: 'hello',
        client_metadata: { 'x-codex-turn-metadata': '{"thread_id":"metadata-thread"}' },
      },
      { id: 'response', output: [] },
      ''
    );
    expect(parseConversationRequest(log, reference()).threadId).toBe('metadata-thread');
  });

  test('accumulates partial SSE function arguments and text without a final response', () => {
    const log = makeLog({ input: 'run a check' }, [
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          id: 'tool-a',
          type: 'function_call',
          name: 'shell',
          call_id: 'call-a',
          arguments: '',
        },
      },
      { type: 'response.function_call_arguments.delta', item_id: 'tool-a', delta: '{"cmd":' },
      { type: 'response.function_call_arguments.delta', item_id: 'tool-a', delta: '"pwd"}' },
      {
        type: 'response.output_item.added',
        output_index: 1,
        item: { id: 'message-a', type: 'message', role: 'assistant', content: [] },
      },
      {
        type: 'response.output_text.delta',
        item_id: 'message-a',
        content_index: 0,
        delta: 'Working ',
      },
      { type: 'response.output_text.delta', item_id: 'message-a', content_index: 0, delta: 'now.' },
    ]);
    const value = parseConversationRequest(log, reference());
    expect(value.items.find((item) => item.kind === 'tool')?.arguments).toBe('{"cmd":"pwd"}');
    expect(value.items[value.items.length - 1].text).toBe('Working now.');
  });

  test('normalizes Chat Completions tool calls and tool results', () => {
    const log = makeLog(
      {
        messages: [
          { role: 'user', content: 'test' },
          {
            role: 'assistant',
            tool_calls: [
              { id: 'chat-call', type: 'function', function: { name: 'run', arguments: '{}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'chat-call', content: 'passed' },
        ],
      },
      { choices: [{ message: { role: 'assistant', content: 'Done.' } }] },
      '',
      false
    );
    const thread = buildConversationThreads([parseConversationRequest(log, reference())])[0];
    expect(thread.items.find((item) => item.kind === 'tool')).toMatchObject({
      name: 'run',
      output: 'passed',
    });
    expect(thread.items[thread.items.length - 1].text).toBe('Done.');
  });

  test('keeps image references without loading or retaining their remote URL', () => {
    const log = makeLog(
      {
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: 'What is this?' },
              { type: 'input_image', image_url: 'https://private.example/secret.png' },
            ],
          },
        ],
      },
      { output: [] }
    );
    const value = parseConversationRequest(log, reference());
    expect(value.items[0].attachments).toHaveLength(1);
    expect(JSON.stringify(value)).not.toContain('private.example');
  });

  test('rejects missing/corrupt request bodies and preserves model errors', () => {
    expect(() => parseConversationRequest('not a request log', reference())).toThrow();
    const value = parseConversationRequest(
      makeLog({ input: 'test' }, { error: { message: 'Quota exhausted' } }, '', false),
      reference()
    );
    expect(value.items[value.items.length - 1]).toMatchObject({
      kind: 'error',
      text: 'Quota exhausted',
    });
  });
});

describe('thread reconstruction', () => {
  test('merges full histories, pairs tool results and preserves separate conversations', () => {
    const refs = extractRequestReferences(demoLogLines);
    const threads = buildConversationThreads(
      refs.map((ref) => parseConversationRequest(demoLogs[ref.id], ref))
    );
    expect(threads).toHaveLength(2);
    const thread = threads.find((value) => value.id === 'thread-demo')!;
    expect(thread.requests).toHaveLength(3);
    expect(thread.items.filter((item) => item.id === 'user-1')).toHaveLength(1);
    expect(thread.items.filter((item) => item.id === 'answer-1')).toHaveLength(1);
    expect(thread.items.find((item) => item.kind === 'tool')?.output).toContain('3 pass');
    expect(thread.items.some((item) => item.kind === 'tool-result')).toBe(false);
    expect(thread.title).toContain('health endpoint');
    expect(threadMatches(thread, 'health exec')).toBe(true);
    expect(threadMatches(thread, 'not-a-real-message')).toBe(false);
    expect(exportConversation(thread)).toContain('### functions.exec');
    expect(exportConversation(thread)).not.toContain('Synthetic system context');
  });

  test('does not collapse repeated short user messages that lack IDs', () => {
    const existing = [message('start'), message('yes')];
    const incoming = [message('start'), message('yes'), message('yes')];
    expect(mergeConversation(existing, incoming).map((item) => item.text)).toEqual([
      'start',
      'yes',
      'yes',
    ]);
    expect(mergeConversation(existing, [message('new turn')]).map((item) => item.text)).toEqual([
      'start',
      'yes',
      'new turn',
    ]);
  });

  test('links previous_response_id chains and leaves unidentified requests separate', () => {
    const first = parseConversationRequest(
      makeLog({ input: 'first' }, { id: 'resp-first', output: [] }, ''),
      reference('aaaa0001')
    );
    const next = parseConversationRequest(
      makeLog(
        { input: 'next', previous_response_id: 'resp-first' },
        { id: 'resp-next', output: [] },
        ''
      ),
      reference('aaaa0002')
    );
    const separate = parseConversationRequest(
      makeLog({ input: 'unrelated' }, { output: [] }, ''),
      reference('aaaa0003')
    );
    expect(
      buildConversationThreads([next, separate, first])
        .map((thread) => thread.requests.length)
        .sort()
    ).toEqual([1, 2]);
  });

  test('environment-only messages are context and not used as conversation titles', () => {
    expect(cleanUserText('<environment_context>cwd=/tmp</environment_context>\nHello')).toBe(
      'Hello'
    );
    const log = makeLog(
      {
        input: [
          { role: 'user', content: '<environment_context>cwd=/tmp</environment_context>' },
          { role: 'user', content: 'The real question' },
        ],
      },
      { output: [] }
    );
    const request = parseConversationRequest(log, reference());
    expect(request.items[0].context).toBe(true);
    expect(buildConversationThreads([request])[0].title).toBe('The real question');
  });

  test('continuation deltas keep repeated user messages instead of deduplicating them', () => {
    const first = parseConversationRequest(
      makeLog({ input: 'yes' }, { id: 'response-first', output: [] }, ''),
      reference('aaaa0001')
    );
    const next = parseConversationRequest(
      makeLog({ input: 'yes', previous_response_id: 'response-first' }, { output: [] }, ''),
      reference('aaaa0002')
    );
    const thread = buildConversationThreads([first, next])[0];
    expect(thread.items.filter((item) => item.role === 'user').map((item) => item.text)).toEqual([
      'yes',
      'yes',
    ]);
  });

  test('uses precise request timestamps and log order when downloads finish out of order', () => {
    const first = parseConversationRequest(demoLogs.aaaa0001, {
      ...reference('ffff0001'),
      sequence: 0,
    });
    const next = parseConversationRequest(demoLogs.aaaa0002, {
      ...reference('aaaa0002'),
      sequence: 1,
    });
    expect(first.timestamp).toBe('2026-10-29T19:51:24.000');
    expect(buildConversationThreads([next, first])[0].requests.map((r) => r.id)).toEqual([
      'ffff0001',
      'aaaa0002',
    ]);
  });
});

test('thread selection updates query parameters without changing the transition layer', () => {
  const saved = {
    pathname: '/threads',
    search: '?thread=first',
    hash: '',
    key: 'first',
    state: null,
  };
  const current = { ...saved, search: '?thread=second', key: 'second' };
  expect(getLayerRenderLocation('current', saved, current)).toBe(current);
  expect(getLayerRenderLocation('exiting', saved, current)).toBe(saved);
  expect(getLayerRenderLocation('stacked', saved, current)).toBe(saved);
  expect(getLayerRenderLocation('current', saved, { ...current, pathname: '/logs' })).toBe(saved);
});

test('all supported locales include the conversation viewer labels', () => {
  const read = (locale: string) =>
    JSON.parse(
      readFileSync(new URL(`../src/i18n/locales/${locale}.json`, import.meta.url), 'utf8')
    );
  const keys = Object.keys(read('en').threads).sort();
  for (const locale of ['zh-CN', 'zh-TW', 'ru', 'vi', 'ko']) {
    const content = read(locale);
    expect(Object.keys(content.threads).sort()).toEqual(keys);
    expect(content.nav.threads).toBeTruthy();
    expect(content.nav_meta.threads).toBeTruthy();
  }
});
