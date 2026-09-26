import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useDismiss } from './useDismiss';

interface Props {
  /** Where the pointer was, in window coordinates. */
  x: number;
  y: number;
  label: string;
  onClose: () => void;
  children: ReactNode;
}

/** A menu that opens at the pointer (a right-click), pulled back inside the window if it would spill out. It
 *  closes on Escape, a press elsewhere, a scroll, or the window losing focus or changing size. Its items are
 *  the ordinary `.menu-item` buttons. */
export function ContextMenu({ x, y, label, onClose, children }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState({ left: x, top: y });
  useDismiss(ref, true, onClose);

  // Measured once it is on screen: its size isn't known before.
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const margin = 6;
    setAt({
      left: Math.max(margin, Math.min(x, window.innerWidth - box.width - margin)),
      top: Math.max(margin, Math.min(y, window.innerHeight - box.height - margin)),
    });
  }, [x, y]);

  useEffect(() => {
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    document.addEventListener('scroll', onClose, true);
    return () => {
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
      document.removeEventListener('scroll', onClose, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={ref} className="menu context-menu" role="menu" aria-label={label} style={at} onContextMenu={(e) => e.preventDefault()}>
      {children}
    </div>
  );
}
