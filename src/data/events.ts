/** A tiny pub/sub for data-layer notices (offline fallback, unsupported
 *  timeframe, fetch failure). Data providers run deep inside Vela's loading
 *  pipeline where they have no UI of their own; this is how they get a message
 *  in front of the user without importing any React. */

/** `alert` is a price alert firing: it lingers longer than an `info` notice. */
export type DataNoticeLevel = 'info' | 'error' | 'alert';

export interface DataNotice {
  level: DataNoticeLevel;
  message: string;
}

type Listener = (notice: DataNotice) => void;

const listeners = new Set<Listener>();
/** Identical notices inside this window collapse into one — a chart that
 *  retries, or several tabs hitting the same failure, must not stack toasts. */
const DEDUPE_WINDOW_MS = 4000;
const recent = new Map<string, number>();

export function notify(level: DataNoticeLevel, message: string): void {
  const key = `${level}:${message}`;
  const now = Date.now();
  const last = recent.get(key);
  if (last !== undefined && now - last < DEDUPE_WINDOW_MS) return;
  recent.set(key, now);
  for (const listener of listeners) listener({ level, message });
}

export function onDataNotice(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
