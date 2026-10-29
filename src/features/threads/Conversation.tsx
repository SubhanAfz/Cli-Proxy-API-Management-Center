import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  IconChevronDown,
  IconTerminal,
  IconFileText,
  IconChevronRight,
} from '@/components/ui/icons';
import type { ConversationItem, ConversationThread } from './types';
import styles from './ThreadsPage.module.scss';

function Markdown({ text }: { text: string }) {
  const { t } = useTranslation();
  return (
    <div className={styles.markdown}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
          // Logged remote assets must never cause a browser request merely by opening a thread.
          img: ({ alt }) => (
            <span className={styles.attachment}>
              <IconFileText size={14} />
              {alt || t('threads.image_attachment')}
            </span>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function pretty(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function ToolCall({ item }: { item: ConversationItem }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const args = pretty(item.arguments || '');
  const output = item.kind === 'tool-result' ? item.text : item.output;
  return (
    <details className={styles.toolCall} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <IconChevronRight size={14} />
        <IconTerminal size={15} />
        <strong>{item.name || t('threads.tool_call')}</strong>
        <span>
          {output !== undefined ? t('threads.tool_complete') : t('threads.tool_recorded')}
        </span>
      </summary>
      {open && (
        <div className={styles.toolBody}>
          {args && (
            <>
              <div className={styles.sectionLabel}>{t('threads.arguments')}</div>
              <pre>{args}</pre>
            </>
          )}
          {output !== undefined && (
            <>
              <div className={styles.sectionLabel}>{t('threads.output')}</div>
              <pre>{output || t('threads.empty_output')}</pre>
            </>
          )}
          {!args && output === undefined && (
            <p className={styles.muted}>{t('threads.no_tool_body')}</p>
          )}
        </div>
      )}
    </details>
  );
}

function ActivityItem({ item }: { item: ConversationItem }) {
  const { t } = useTranslation();
  if (item.kind === 'tool' || item.kind === 'tool-result') return <ToolCall item={item} />;
  if (item.kind === 'reasoning')
    return (
      <details className={styles.reasoning}>
        <summary>{t('threads.reasoning')}</summary>
        <Markdown text={item.text} />
      </details>
    );
  if (item.kind === 'error') return <div className={styles.requestError}>{item.text}</div>;
  return <Markdown text={item.text} />;
}

function AssistantTurn({
  items,
  thread,
}: {
  items: ConversationItem[];
  thread: ConversationThread;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (!items.length) return null;
  const hasActivity = items.some((item) => item.kind !== 'message' || item.phase === 'commentary');
  const last = items[items.length - 1];
  const final =
    last.kind === 'message' && last.role === 'assistant' && last.phase !== 'commentary'
      ? last
      : undefined;
  const work = final ? items.slice(0, -1) : items;
  const requestIds = new Set(items.map((item) => item.requestId));
  const durations = thread.requests
    .filter((request) => requestIds.has(request.id))
    .map((request) => request.duration)
    .filter(Boolean);
  const tools = work.filter((item) => item.kind === 'tool' || item.kind === 'tool-result').length;
  return (
    <div className={styles.assistantTurn}>
      {hasActivity && work.length > 0 ? (
        <details
          className={styles.activity}
          onToggle={(event) => setOpen(event.currentTarget.open)}
        >
          <summary>
            <IconChevronRight size={15} />
            <span>
              {durations.length === 1
                ? t('threads.worked_for', { duration: durations[0] })
                : t('threads.activity')}
            </span>
            {tools > 0 && (
              <span className={styles.activityCount}>
                {t('threads.tool_count', { count: tools })}
              </span>
            )}
          </summary>
          {open && (
            <div className={styles.activityBody}>
              {work.map((item, index) => (
                <ActivityItem key={`${item.id || item.callId || index}-${item.kind}`} item={item} />
              ))}
            </div>
          )}
        </details>
      ) : (
        work.map((item, index) => (
          <ActivityItem key={`${item.id || index}-${item.kind}`} item={item} />
        ))
      )}
      {final && <Markdown text={final.text} />}
    </div>
  );
}

export function Conversation({
  thread,
  showContext,
}: {
  thread: ConversationThread;
  showContext: boolean;
}) {
  const { t } = useTranslation();
  const blocks: {
    user?: ConversationItem;
    activity: ConversationItem[];
    context?: ConversationItem;
  }[] = [];
  for (const item of thread.items) {
    if (item.context) {
      if (showContext) blocks.push({ activity: [], context: item });
      continue;
    }
    if (item.kind === 'message' && item.role === 'user') blocks.push({ user: item, activity: [] });
    else {
      if (!blocks.length || blocks[blocks.length - 1].context) blocks.push({ activity: [] });
      blocks[blocks.length - 1].activity.push(item);
    }
  }
  return (
    <div className={styles.messages}>
      <div className={styles.startMarker}>
        <span />
        <span>{t('threads.conversation_start')}</span>
        <span />
      </div>
      {blocks.map((block, index) => (
        <Fragment key={`${block.user?.id || block.context?.id || index}`}>
          {block.context && (
            <details className={styles.context}>
              <summary>
                {t('threads.context_message', { role: block.context.role })}
                <IconChevronDown size={14} />
              </summary>
              <pre>{block.context.text}</pre>
            </details>
          )}
          {block.user && (
            <article className={styles.userMessage} aria-label={t('threads.user_message')}>
              <div className={styles.userBubble}>
                {block.user.attachments?.map((file, i) => (
                  <div className={styles.attachment} key={i}>
                    <IconFileText size={14} />
                    {file.type === 'image' ? t('threads.image_attachment') : file.name}
                  </div>
                ))}
                {block.user.text && <Markdown text={block.user.text} />}
              </div>
            </article>
          )}
          <AssistantTurn items={block.activity} thread={thread} />
        </Fragment>
      ))}
      <div className={styles.endMarker}>
        <span className={styles.statusDot} />
        {t('threads.read_only')}
      </div>
    </div>
  );
}
