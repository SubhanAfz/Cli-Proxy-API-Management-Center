import { createContext, useContext } from 'react';
import type { Location } from 'react-router-dom';

export type LayerStatus = 'current' | 'exiting' | 'stacked';

/** Query-only navigation updates the active page without remounting its transition layer. */
export function getLayerRenderLocation(
  status: LayerStatus,
  saved: Location,
  current: Location
): Location {
  return status === 'current' && saved.pathname === current.pathname ? current : saved;
}

export type PageTransitionLayerContextValue = {
  status: LayerStatus;
  isCurrentLayer: boolean;
  isAnimating: boolean;
};

export const PageTransitionLayerContext = createContext<PageTransitionLayerContextValue | null>(
  null
);

export const PAGE_TRANSITION_LAYER_CONTEXT_VALUES: Record<
  LayerStatus,
  PageTransitionLayerContextValue
> = {
  current: { status: 'current', isCurrentLayer: true, isAnimating: false },
  stacked: { status: 'stacked', isCurrentLayer: false, isAnimating: false },
  exiting: { status: 'exiting', isCurrentLayer: false, isAnimating: false },
};

export function usePageTransitionLayer() {
  return useContext(PageTransitionLayerContext);
}
