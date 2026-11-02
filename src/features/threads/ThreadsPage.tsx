import { useDeferredValue, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import {
  IconRefreshCw,
  IconSearch,
  IconDownload,
  IconCopy,
  IconChevronLeft,
  IconChevronDown,
  IconMessageCircle,
} from '@/components/ui/icons';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { usePageTransitionLayer } from '@/components/common/PageTransitionLayer';
import { copyToClipboard } from '@/utils/clipboard';
import { downloadBlob } from '@/utils/download';
import { useNotificationStore } from '@/stores';
import { Conversation } from './Conversation';
import { LogHistoryNotice } from './LogHistoryNotice';
import { useThreads } from './hooks/useThreads';
import { exportConversation, threadMatches } from './model/conversations';
import styles from './ThreadsPage.module.scss';

export function ThreadsPage() {
  const { t, i18n } = useTranslation();
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [showContext, setShowContext] = useState(false);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [client, setClient] = useState('');
  const [mobileConversation, setMobileConversation] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [params, setParams] = useSearchParams();
  const active = usePageTransitionLayer()?.isCurrentLayer !== false;
  const state = useThreads(autoRefresh, active);
  const scroller = useRef<HTMLDivElement>(null);
  const lastThread = useRef('');
  const showNotification = useNotificationStore((store) => store.showNotification);
  useHeaderRefresh(() => state.refresh(true), active);
  const clients = useMemo(
    () => [...new Set(state.threads.map((thread) => thread.client).filter(Boolean))].sort(),
    [state.threads]
  );
  const filtered = useMemo(
    () =>
      state.threads.filter(
        (thread) => (!client || thread.client === client) && threadMatches(thread, deferredQuery)
      ),
    [state.threads, deferredQuery, client]
  );
  const requested = params.get('thread');
  const selected =
    filtered.find((thread) => thread.id === requested) ??
    (requested ? state.threads.find((thread) => thread.id === requested) : filtered[0]);
  const messageCount =
    selected?.items.filter((item) => item.kind === 'message' && !item.context).length ?? 0;
  const contextCount = selected?.items.filter((item) => item.context).length ?? 0;

  useLayoutEffect(() => {
    if (!selected) return;
    const changed = lastThread.current !== selected.id;
    lastThread.current = selected.id;
    if (changed || atBottom) {
      if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
    }
  }, [selected, atBottom]);

  const dateLabel = (timestamp: string) => {
    // Do not apply a timezone offset to the backend's unzoned log timestamps.
    const parsed = new Date(timestamp.replace(' ', 'T'));
    return Number.isNaN(parsed.getTime())
      ? timestamp
      : parsed.toLocaleDateString(i18n.language, { month: 'short', day: 'numeric' }) +
          ' · ' +
          parsed.toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' });
  };
  const copyId = async () => {
    if (!selected) return;
    const ok = await copyToClipboard(selected.id);
    showNotification(t(ok ? 'threads.copied' : 'threads.copy_failed'), ok ? 'success' : 'error');
  };
  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div>
          <span className={styles.eyebrow}>{t('threads.workspace')}</span>
          <h1>{t('threads.title')}</h1>
        </div>
        <div className={styles.pageActions}>
          <label className={styles.liveToggle}>
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(event) => setAutoRefresh(event.target.checked)}
            />
            <span className={autoRefresh ? styles.statusDot : styles.pausedDot} />
            {t('threads.live')}
          </label>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void state.refresh(true)}
            loading={state.loading}
          >
            <IconRefreshCw size={15} />
            {t('threads.refresh')}
          </Button>
        </div>
      </div>
      {state.error && (
        <div className={styles.notice} role="alert">
          {state.error}
          <Button variant="ghost" size="sm" onClick={() => void state.refresh(true)}>
            {t('threads.retry')}
          </Button>
        </div>
      )}
      <LogHistoryNotice
        unavailable={state.unavailable}
        failed={state.failed}
        loading={state.loading}
        onRetry={() => void state.refresh(true)}
      />
      <div className={`${styles.workspace} ${mobileConversation ? styles.mobileConversation : ''}`}>
        <aside className={styles.threadSidebar} aria-label={t('threads.thread_list')}>
          <div className={styles.listHeading}>
            <span>{t('threads.all_threads')}</span>
            <span className={styles.count}>{state.threads.length}</span>
          </div>
          <div className={styles.searchBox}>
            <IconSearch size={16} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('threads.search')}
              aria-label={t('threads.search')}
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label={t('threads.clear_search')}
              >
                ×
              </button>
            )}
          </div>
          {clients.length > 1 && (
            <select
              className={styles.clientFilter}
              aria-label={t('threads.filter_client')}
              value={client}
              onChange={(event) => setClient(event.target.value)}
            >
              <option value="">{t('threads.all_clients')}</option>
              {clients.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          )}
          <div className={styles.threadList}>
            {filtered.map((thread) => (
              <button
                type="button"
                key={thread.id}
                className={`${styles.threadCard} ${thread.id === selected?.id ? styles.selected : ''}`}
                aria-pressed={thread.id === selected?.id}
                onClick={() => {
                  setParams({ thread: thread.id });
                  setMobileConversation(true);
                }}
              >
                <div className={styles.cardTitle}>
                  <IconMessageCircle size={15} />
                  <strong>{thread.title || t('threads.untitled')}</strong>
                  {thread.hasErrors && (
                    <span className={styles.errorDot} aria-label={t('threads.has_errors')} />
                  )}
                </div>
                <p>{thread.preview || t('threads.no_preview')}</p>
                <div className={styles.cardMeta}>
                  <span>{thread.client || t('threads.unknown_client')}</span>
                  <time>{dateLabel(thread.timestamp)}</time>
                </div>
                <div className={styles.cardFooter}>
                  <span>{thread.models[0] || t('threads.unknown_model')}</span>
                  <span>{t('threads.request_count', { count: thread.requests.length })}</span>
                </div>
              </button>
            ))}
            {!filtered.length && (
              <div className={styles.listEmpty}>
                {state.loading ? (
                  <>
                    <span className="loading-spinner" />
                    {t('threads.loading')}
                  </>
                ) : query || client ? (
                  t('threads.no_matches')
                ) : (
                  t('threads.no_threads')
                )}
              </div>
            )}
          </div>
          <div className={styles.listStatus} role="status">
            {state.loading
              ? t('threads.indexing', { completed: state.completed, total: state.total })
              : t('threads.loaded_history', {
                  loaded: state.requests.length,
                  total: state.indexed,
                })}
            {state.remaining > 0 && (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={state.loading}
                  onClick={() => void state.loadOlder()}
                >
                  {t('threads.load_older', { count: state.remaining })}
                </Button>
                <span>{t('threads.search_loaded')}</span>
              </>
            )}
            <span>{t('threads.private_view')}</span>
          </div>
        </aside>
        <section className={styles.conversationPanel} aria-label={t('threads.conversation')}>
          {selected ? (
            <>
              <header className={styles.conversationHeader}>
                <button
                  className={styles.backButton}
                  type="button"
                  onClick={() => setMobileConversation(false)}
                  aria-label={t('threads.back')}
                >
                  <IconChevronLeft size={20} />
                </button>
                <div className={styles.headingText}>
                  <div className={styles.breadcrumb}>
                    {selected.client || t('threads.unknown_client')}
                    <span>/</span>
                    {t('threads.conversation')}
                  </div>
                  <h2 title={selected.title}>{selected.title || t('threads.untitled')}</h2>
                  <div className={styles.conversationMeta}>
                    <span>{selected.models.join(', ')}</span>
                    <span>·</span>
                    <span>{t('threads.message_count', { count: messageCount })}</span>
                    <span>·</span>
                    <span>{t('threads.request_count', { count: selected.requests.length })}</span>
                  </div>
                </div>
                <div className={styles.conversationActions}>
                  <button
                    type="button"
                    onClick={() => void copyId()}
                    aria-label={t('threads.copy_id')}
                    title={t('threads.copy_id')}
                  >
                    <IconCopy size={16} />
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      downloadBlob({
                        filename: `thread-${selected.id.replace(/[^\w-]/g, '_')}.md`,
                        blob: new Blob([exportConversation(selected)], { type: 'text/markdown' }),
                      })
                    }
                    title={t('threads.export')}
                    aria-label={t('threads.export')}
                  >
                    <IconDownload size={17} />
                  </button>
                </div>
              </header>
              <div className={styles.viewerControls}>
                <span className={styles.threadId} title={selected.id}>
                  {selected.ungrouped ? t('threads.ungrouped') : selected.id}
                </span>
                {contextCount > 0 && (
                  <label>
                    <input
                      type="checkbox"
                      checked={showContext}
                      onChange={(event) => setShowContext(event.target.checked)}
                    />
                    {t('threads.show_context', { count: contextCount })}
                  </label>
                )}
              </div>
              <div
                className={styles.conversationScroll}
                data-conversation-scroll
                ref={scroller}
                onScroll={() => {
                  const el = scroller.current;
                  if (el) setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 100);
                }}
              >
                <Conversation key={selected.id} thread={selected} showContext={showContext} />
              </div>
              {!atBottom && (
                <button
                  className={styles.jumpButton}
                  type="button"
                  onClick={() =>
                    scroller.current?.scrollTo({
                      top: scroller.current.scrollHeight,
                      behavior: 'auto',
                    })
                  }
                >
                  <IconChevronDown size={16} />
                  {t('threads.latest')}
                </button>
              )}
            </>
          ) : (
            <div className={styles.emptyConversation}>
              <span className={styles.emptyIcon}>
                <IconMessageCircle size={32} />
              </span>
              <h2>{t('threads.empty_title')}</h2>
              <p>{t('threads.empty_description')}</p>
              <Link to="/config">{t('threads.open_config')}</Link>
              <span className={styles.captureHint}>{t('threads.capture_hint')}</span>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
