import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import styles from './ThreadsPage.module.scss';

interface LogHistoryNoticeProps {
  unavailable: number;
  failed: number;
  loading: boolean;
  onRetry: () => void;
}

/** Missing transcript files are retained-history information, not failed inference. */
export function LogHistoryNotice({ unavailable, failed, loading, onRetry }: LogHistoryNoticeProps) {
  const { t } = useTranslation();
  return (
    <>
      {unavailable > 0 && (
        <details className={styles.retentionNotice}>
          <summary>{t('threads.missing_logs', { count: unavailable })}</summary>
          <p>{t('threads.retention_explanation')}</p>
        </details>
      )}
      {failed > 0 && (
        <div className={styles.notice} role="alert">
          {t('threads.failed_logs', { count: failed })}
          <Button variant="ghost" size="sm" loading={loading} onClick={onRetry}>
            {t('threads.retry')}
          </Button>
        </div>
      )}
    </>
  );
}
