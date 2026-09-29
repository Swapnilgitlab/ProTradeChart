/** The tab strip when there are more tabs than fit: which way it can still scroll, and scrolling it.
 *  Tabs first shrink (CSS: `.tab-chip`); only past their minimum width does the strip scroll, and
 *  then arrows show which side has hidden tabs, the mouse wheel scrolls it sideways, and the active
 *  tab is always brought into view. */

import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from 'react';

/** How far one arrow press scrolls, as a share of the strip's visible width. */
const STEP = 0.7;
/** Rounding slack: a strip scrolled to its end can be a fraction of a pixel short. */
const SLACK = 1;

/** Whether there are tabs hidden to the left and to the right. Pure. */
export function stripOverflow(scrollLeft: number, scrollWidth: number, clientWidth: number): { left: boolean; right: boolean } {
  return { left: scrollLeft > SLACK, right: scrollLeft + clientWidth < scrollWidth - SLACK };
}

export function useTabStrip(stripRef: RefObject<HTMLDivElement | null>, activeTabId: string, tabCount: number) {
  const [overflow, setOverflow] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const el = stripRef.current;
    if (!el) return;
    const next = stripOverflow(el.scrollLeft, el.scrollWidth, el.clientWidth);
    setOverflow((prev) => (prev.left === next.left && prev.right === next.right ? prev : next));
  }, [stripRef]);

  // Re-measure when the strip scrolls, is resized (the window, the side panel) or its tabs change.
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    el.addEventListener('scroll', measure, { passive: true });
    // A vertical wheel scrolls the strip sideways, as in a browser's tab strip.
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      observer.disconnect();
      el.removeEventListener('scroll', measure);
      el.removeEventListener('wheel', onWheel);
    };
  }, [stripRef, measure]);

  // The active tab is always in view: a new tab (added at the end), Ctrl+PageDown, a pick elsewhere.
  useLayoutEffect(() => {
    const el = stripRef.current;
    el?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    measure();
  }, [stripRef, activeTabId, tabCount, measure]);

  const scrollBy = useCallback(
    (direction: -1 | 1) => {
      const el = stripRef.current;
      if (el) el.scrollBy({ left: direction * el.clientWidth * STEP, behavior: 'smooth' });
    },
    [stripRef],
  );

  return { overflow, scrollBy };
}
