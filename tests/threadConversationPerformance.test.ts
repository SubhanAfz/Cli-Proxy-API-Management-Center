import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { Conversation } from '../src/features/threads/Conversation';
import {
  buildConversationThreads,
  mergeConversation,
} from '../src/features/threads/model/conversations';
import {
  conversationBlocks,
  CONVERSATION_PAGE_SIZE,
} from '../src/features/threads/model/visibleConversation';
import type { ConversationItem } from '../src/features/threads/types';
import en from '../src/i18n/locales/en.json';

const item = (n: number, role = 'user'): ConversationItem => ({
  id: `${role}-${n}`,
  kind: 'message',
  role,
  text: `Synthetic ${role} message ${n}`,
  requestId: 'demo',
});

// Original ordered-anchor semantics, used as an independent oracle for duplicate/insertion cases.
function referenceMerge(existing: ConversationItem[], incoming: ConversationItem[]) {
  const key = (i: ConversationItem) => i.id || i.text;
  const result = [...existing];
  const keys = result.map(key);
  const anchor = incoming.findIndex((i) => keys.includes(key(i)));
  if (anchor < 0) return [...existing, ...incoming];
  let cursor = keys.indexOf(key(incoming[anchor]));
  for (const i of incoming) {
    const index = keys.indexOf(key(i), cursor);
    if (index >= 0) {
      result[index] = { ...result[index], ...i, requestId: result[index].requestId };
      cursor = index + 1;
    } else {
      result.splice(cursor, 0, i);
      keys.splice(cursor++, 0, key(i));
    }
  }
  return result;
}

test('indexed history stitching preserves ordered duplicates, insertions and original event origins', () => {
  let seed = 341;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed;
  };
  for (let n = 0; n < 500; n++) {
    const existing = Array.from({ length: random() % 30 }, () => item(random() % 12));
    const incoming = Array.from({ length: random() % 30 }, () => ({
      ...item(random() % 16),
      requestId: 'new',
    }));
    expect(mergeConversation(existing, incoming)).toEqual(referenceMerge(existing, incoming));
  }
});

test('a 2000-message conversation initially renders only the latest 25 turns without losing history', async () => {
  const items = Array.from({ length: 1000 }, (_, n) => [item(n), item(n, 'assistant')]).flat();
  const thread = buildConversationThreads([
    {
      id: 'demo',
      threadId: 'large-demo',
      timestamp: '2026-11-02',
      path: '/v1/responses',
      model: 'demo',
      client: 'test',
      inputTokens: 0,
      outputTokens: 0,
      items,
    },
  ])[0];
  const translations = createInstance();
  await translations.init({ lng: 'en', resources: { en: { translation: en } } });
  const html = renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n: translations },
      createElement(Conversation, { thread, showContext: false })
    )
  );
  expect(html.match(/<article/g)).toHaveLength(CONVERSATION_PAGE_SIZE);
  expect(html).toContain('Show earlier messages (975 sections)');
  expect(html).toContain('Synthetic user message 999');
  expect(html).not.toContain('Synthetic user message 0<');
  expect(thread.items).toHaveLength(2000);
  expect(conversationBlocks(thread.items, false)).toHaveLength(1000);
});
