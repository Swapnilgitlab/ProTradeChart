/** Shared polling for data sources that have no push feed (Yahoo Finance).
 *
 *  Everyone watching the same thing — two tabs on one symbol, a chart and its
 *  detached window — shares a single timer and a single request per tick, so
 *  the load on the source depends on *what* is being watched, not on how many
 *  panes are open. A poll that fails backs off exponentially instead of
 *  retrying at full speed, which matters most when the failure is a rate limit. */

export interface PollOptions {
  /** Time between polls while the data is changing. */
  baseMs: number;
  /** Time between polls once `idlePollsBeforeBackoff` polls in a row found nothing new. */
  idleMs: number;
  idlePollsBeforeBackoff: number;
  /** Upper bound for the delay after consecutive failures. */
  maxFailureMs: number;
  /** Polls are skipped while this returns false (e.g. the window is hidden). */
  isActive?: () => boolean;
}

interface Listener<T> {
  onChange: (latest: T) => void;
  /** Joined after polling began: gets the next result even if nothing changed. */
  needsFirst: boolean;
}

const windowIsVisible = () => typeof document === 'undefined' || document.visibilityState === 'visible';

class Poller<T> {
  readonly listeners = new Set<Listener<T>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private lastSeen = '';
  private idlePolls = 0;
  private failures = 0;

  constructor(
    private readonly load: () => Promise<T>,
    private readonly options: PollOptions,
    private readonly onStop: () => void,
  ) {
    this.timer = setTimeout(() => void this.tick(), options.baseMs);
  }

  add(listener: Listener<T>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  }

  private stop() {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.onStop();
  }

  private nextDelay(): number {
    const { baseMs, idleMs, idlePollsBeforeBackoff, maxFailureMs } = this.options;
    if (this.failures > 0) return Math.min(baseMs * 2 ** this.failures, maxFailureMs);
    return this.idlePolls >= idlePollsBeforeBackoff ? idleMs : baseMs;
  }

  private async tick() {
    if (this.stopped) return;
    if ((this.options.isActive ?? windowIsVisible)()) {
      try {
        const latest = await this.load();
        if (this.stopped) return;
        const fingerprint = JSON.stringify(latest);
        const changed = fingerprint !== this.lastSeen;
        this.idlePolls = changed ? 0 : this.idlePolls + 1;
        this.lastSeen = fingerprint;
        this.failures = 0;
        // A listener may unsubscribe from inside its callback.
        for (const listener of [...this.listeners]) {
          if (changed || listener.needsFirst) listener.onChange(latest);
          listener.needsFirst = false;
        }
      } catch {
        // A failed poll is silent: the chart already has its history, and the
        // next tick simply tries again — later, the more often it fails.
        this.failures = Math.min(this.failures + 1, 16);
      }
    }
    if (!this.stopped) this.timer = setTimeout(() => void this.tick(), this.nextDelay());
  }
}

const pollers = new Map<string, Poller<unknown>>();

/** Calls `onChange` with the result of `load()` whenever it differs from the
 *  previous poll. Subscribers sharing a `key` share one poller (the first
 *  subscriber's `load` and `options` win, so the key must identify both).
 *  Returns the unsubscribe function; the poller stops with its last subscriber. */
export function subscribePolled<T>(
  key: string,
  options: PollOptions,
  load: () => Promise<T>,
  onChange: (latest: T) => void,
): () => void {
  let poller = pollers.get(key) as Poller<T> | undefined;
  const joining = poller !== undefined;
  if (!poller) {
    poller = new Poller<T>(load, options, () => pollers.delete(key));
    pollers.set(key, poller as Poller<unknown>);
  }
  return poller.add({ onChange, needsFirst: joining });
}

/** Number of live pollers; exposed for tests. */
export const activePollerCount = () => pollers.size;
