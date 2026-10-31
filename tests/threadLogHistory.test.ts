import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import en from '../src/i18n/locales/en.json';
import { LogHistoryNotice } from '../src/features/threads/LogHistoryNotice';

const translations = createInstance();
await translations.init({ lng: 'en', resources: { en: { translation: en } } });
const render = (unavailable: number, failed: number, loading = false) =>
  renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n: translations },
      createElement(LogHistoryNotice, { unavailable, failed, loading, onRetry: () => {} })
    )
  );

test('missing files are collapsed history information with no inference failure alert', () => {
  const html = render(535, 0);
  expect(html).toContain('535 older request logs are unavailable');
  expect(html).toContain('<details');
  expect(html).not.toContain(' open=');
  expect(html).not.toContain('role="alert"');
  expect(html).not.toContain('<button');
  expect(html).toContain('cannot restore deleted files');
});

test('loading failures retain their own count and an actionable retry', () => {
  const html = render(535, 2);
  expect(html).toContain('535 older request logs are unavailable');
  expect(html).toContain('2 request logs could not be loaded');
  expect(html).not.toContain('537');
  expect(html).toContain('role="alert"');
  expect(html).toContain('Retry');
  expect(render(0, 1)).toContain('1 request log could not be loaded');
  expect(render(0, 1, true)).toContain('disabled=""');
  expect(render(0, 0)).toBe('');
});
