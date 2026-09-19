import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { onDataNotice } from '../data/events';

export type ToastKind = 'info' | 'success' | 'error' | 'alert';

interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

type ShowToast = (message: string, kind?: ToastKind) => void;

const ToastContext = createContext<ShowToast | null>(null);

const DURATION_MS = { info: 3500, success: 3000, error: 6000, alert: 15000 } as const;
const MAX_VISIBLE = 4;

/** Owns the toast stack, and turns data-layer notices (offline fallback, a
 *  failed fetch) into toasts so providers never need to know about React. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const show = useCallback<ShowToast>((message, kind = 'info') => {
    const id = nextId.current++;
    setToasts((prev) => [...prev.slice(-(MAX_VISIBLE - 1)), { id, kind, message }]);
    window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), DURATION_MS[kind]);
  }, []);

  useEffect(() => onDataNotice((n) => show(n.message, n.level)), [show]);

  const value = useMemo(() => show, [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-host" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ShowToast {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
}
