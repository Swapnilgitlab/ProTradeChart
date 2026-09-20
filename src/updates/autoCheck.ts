import type { Updater } from './updater';
import { autoCheckEnabled } from './updater';

/** Wait this long after launch before the first look, so it never competes with the
 *  first charts for the network. */
export const STARTUP_DELAY_MS = 20_000;
/** People leave a charting app open for days, so look again about once a day. */
export const RECHECK_MS = 24 * 60 * 60 * 1000;

export interface AutoCheckDeps {
  updater: Updater;
  /** The stored `autoUpdateCheck` preference. */
  readPreference(): Promise<string | null>;
  /** Tell the user a version is waiting. Called once per version. */
  announce(version: string): void;
  startupDelayMs?: number;
  intervalMs?: number;
}

/** Checks for an update shortly after launch and then daily, unless the user switched it
 *  off (read fresh each time, so the switch takes effect without a restart). Failures are
 *  quiet: being offline is not something to nag about. Returns a function that stops it. */
export function startAutoUpdates(deps: AutoCheckDeps): () => void {
  let announced: string | null = null;
  let stopped = false;

  const run = async () => {
    let enabled = true;
    try {
      enabled = autoCheckEnabled(await deps.readPreference());
    } catch {
      // An unreadable preference counts as "on", the default.
    }
    if (stopped || !enabled) return;
    await deps.updater.check(true);
    const state = deps.updater.getState();
    if (!stopped && state.kind === 'available' && state.version !== announced) {
      announced = state.version;
      deps.announce(state.version);
    }
  };

  const first = setTimeout(() => void run(), deps.startupDelayMs ?? STARTUP_DELAY_MS);
  const repeat = setInterval(() => void run(), deps.intervalMs ?? RECHECK_MS);
  return () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(repeat);
  };
}
