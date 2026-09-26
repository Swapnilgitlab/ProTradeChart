/** Wording for a script run's end. Pure, so what a person reads is tested. */

export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return `${Math.max(0, Math.round(Number.isFinite(ms) ? ms : 0))} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return rest === 60 ? `${minutes + 1} min 0 s` : `${minutes} min ${rest} s`;
}

export interface RunEnd {
  code: number | null;
  stopped: boolean;
  /** Set when the script could not be started at all. */
  error: string | null;
}

/** One line for the console when a run ends, and whether it counts as a failure. */
export function exitSummary(end: RunEnd, elapsedMs: number): { level: 'info' | 'error'; text: string } {
  const took = formatElapsed(elapsedMs);
  if (end.error) return { level: 'error', text: `✗ ${end.error}` };
  if (end.stopped) return { level: 'info', text: `■ Stopped after ${took}` };
  if (end.code === 0) return { level: 'info', text: `✓ Finished in ${took}` };
  if (end.code === null) return { level: 'error', text: `✗ Ended unexpectedly after ${took}` };
  return { level: 'error', text: `✗ Exited with code ${end.code} after ${took}` };
}
