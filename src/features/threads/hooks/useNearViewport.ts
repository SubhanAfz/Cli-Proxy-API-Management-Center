import { useEffect, useState, type RefObject } from 'react';

const pools = new WeakMap<
  Element,
  {
    observer: IntersectionObserver;
    callbacks: WeakMap<Element, () => void>;
  }
>();

/** Every message is already in memory and the DOM; only expensive Markdown formatting is deferred. */
export function useNearViewport(ref: RefObject<HTMLElement | null>, enabled: boolean) {
  const [near, setNear] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (near || !enabled || !ref.current) return;
    const target = ref.current;
    const root = target.closest('[data-conversation-scroll]') ?? document.documentElement;
    let pool = pools.get(root);
    if (!pool) {
      const callbacks = new WeakMap<Element, () => void>();
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              callbacks.get(entry.target)?.();
              observer.unobserve(entry.target);
              callbacks.delete(entry.target);
            }
          }
        },
        { root, rootMargin: '1000px 0px' }
      );
      pool = { observer, callbacks };
      pools.set(root, pool);
    }
    pool.callbacks.set(target, () => setNear(true));
    pool.observer.observe(target);
    return () => {
      pool.observer.unobserve(target);
      pool.callbacks.delete(target);
    };
  }, [ref, enabled, near]);
  return !enabled || near;
}
