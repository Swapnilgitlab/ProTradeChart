import { useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { DEFAULT_PANEL_WIDTH, dragWidth } from './panelWidth';

interface Props {
  width: number;
  /** While dragging. */
  onResize: (width: number) => void;
  /** When the drag ends (or a double-click resets it): the width to keep. */
  onCommit: (width: number) => void;
}

/** The side panel's left edge: drag it to make the panel wider or narrower; double-click for the
 *  default width. Pointer events with capture, like the watchlist's own dragging. */
export function PanelResizer({ width, onResize, onCommit }: Props) {
  const drag = useRef<{ startX: number; startWidth: number; last: number } | null>(null);

  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startWidth: width, last: width };
    document.body.classList.add('resizing-panel');
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    d.last = dragWidth(d.startWidth, d.startX, e.clientX, window.innerWidth);
    onResize(d.last);
  };
  const up = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    document.body.classList.remove('resizing-panel');
    if (d.last !== d.startWidth) onCommit(d.last);
  };

  return (
    <div
      className="panel-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the side panel"
      aria-valuenow={width}
      title="Drag to resize. Double-click for the default width."
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onDoubleClick={() => {
        onResize(DEFAULT_PANEL_WIDTH);
        onCommit(DEFAULT_PANEL_WIDTH);
      }}
    />
  );
}
