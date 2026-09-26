import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { dropInsertion, type Row } from '../../lib/watchlistRows';

/** How far the pointer must travel before a press on a row becomes a drag rather than a click. */
const DRAG_THRESHOLD_PX = 5;
/** The band at the top and bottom of the list where a drag scrolls it. */
const EDGE_PX = 28;
const AUTOSCROLL_MS = 40;

export interface DragState {
  /** The row being dragged. */
  row: Row;
  /** Where it would land: an index into the shown rows, or `null` while the pointer is over no valid spot. */
  insertion: number | null;
}

interface Options {
  listRef: RefObject<HTMLElement | null>;
  rowHeight: number;
  /** The rows on screen, in order — what `insertion` indexes. */
  shown: readonly Row[];
  /** Dragging is off while the list is sorted by a column: the order on screen isn't the list's own. */
  enabled: boolean;
  /** The pointer was released over a spot. */
  onDrop: (row: Row, insertion: number) => void;
}

/** Drag-to-reorder for a windowed list of fixed-height rows.
 *
 *  It is built on pointer events rather than HTML5 drag and drop: the window's file-drop handler swallows
 *  in-page drags on Windows. Rows are one height, so the row under the pointer is plain arithmetic on the
 *  list's scroll position, and it works however few of them are actually rendered. */
export function useRowDrag(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const [drag, setDrag] = useState<DragState | null>(null);
  const clickSwallowed = useRef(false);
  const stopCurrent = useRef<(() => void) | null>(null);

  // A drag still going when the panel goes away must not leave its listeners behind.
  useEffect(() => () => stopCurrent.current?.(), []);

  const onRowPointerDown = useCallback((e: ReactPointerEvent, row: Row) => {
    if (!latest.current.enabled || e.button !== 0 || !e.isPrimary) return;
    // A button or field inside the row keeps its own behaviour.
    if ((e.target as HTMLElement).closest('button, input, a')) return;

    const startX = e.clientX;
    const startY = e.clientY;
    let lastY = startY;
    let active = false;
    let insertion: number | null = null;
    let timer = 0;

    const locate = () => {
      const list = latest.current.listRef.current;
      if (!list) return;
      const { shown, rowHeight } = latest.current;
      const y = lastY - list.getBoundingClientRect().top + list.scrollTop;
      const at = Math.floor(y / rowHeight);
      const next = dropInsertion(shown, row, at, y - at * rowHeight >= rowHeight / 2);
      if (next !== insertion) {
        insertion = next;
        setDrag({ row, insertion });
      }
    };

    // Held near an edge the list keeps scrolling, whether or not the pointer moves.
    const autoscroll = () => {
      const list = latest.current.listRef.current;
      if (!list) return;
      const box = list.getBoundingClientRect();
      if (lastY < box.top + EDGE_PX) list.scrollTop -= 4 + ((box.top + EDGE_PX - lastY) / EDGE_PX) * 14;
      else if (lastY > box.bottom - EDGE_PX) list.scrollTop += 4 + ((lastY - (box.bottom - EDGE_PX)) / EDGE_PX) * 14;
      locate();
    };

    const onMove = (ev: PointerEvent) => {
      lastY = ev.clientY;
      if (!active) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD_PX) return;
        active = true;
        document.body.classList.add('watchlist-dragging');
        timer = window.setInterval(autoscroll, AUTOSCROLL_MS);
      }
      locate();
    };

    const finish = (commit: boolean) => {
      window.clearInterval(timer);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onCancel);
      stopCurrent.current = null;
      if (!active) return;
      document.body.classList.remove('watchlist-dragging');
      setDrag(null);
      // The click that follows the release belongs to the drag, not to whatever is under the pointer.
      clickSwallowed.current = true;
      window.setTimeout(() => (clickSwallowed.current = false), 100);
      if (commit && insertion !== null) latest.current.onDrop(row, insertion);
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') finish(false);
    };

    stopCurrent.current?.();
    stopCurrent.current = () => finish(false);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', onCancel);
  }, []);

  /** True once, right after a drag ends: the row's click handler asks, and ignores that click. */
  const consumeClick = useCallback(() => {
    const swallowed = clickSwallowed.current;
    clickSwallowed.current = false;
    return swallowed;
  }, []);

  return { drag, onRowPointerDown, consumeClick };
}
