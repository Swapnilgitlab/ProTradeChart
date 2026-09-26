/** The Python console's lines. Pure, so the rules about progress bars and the size limit
 *  are tested without a component. */

export type ConsoleStream = 'stdout' | 'stderr' | 'info' | 'error';

export interface ConsoleLine {
  id: number;
  stream: ConsoleStream;
  text: string;
  /** The script ended this line with a lone carriage return — a progress bar redrawing itself.
   *  The next line from the same stream replaces it instead of adding one. */
  overwrite: boolean;
}

export interface ConsoleState {
  lines: ConsoleLine[];
  nextId: number;
}

export interface ConsoleEntry {
  stream: ConsoleStream;
  text: string;
  overwrite?: boolean;
}

/** More than this and the oldest lines go. A flood of output is already cut off by the
 *  backend; this keeps what the view renders small enough to redraw every frame. */
export const MAX_CONSOLE_LINES = 2000;

export const emptyConsole = (): ConsoleState => ({ lines: [], nextId: 1 });

/** Adds `entries` in order. Returns the same object when there is nothing to add, so a
 *  state update with no news doesn't re-render. */
export function appendLines(state: ConsoleState, entries: readonly ConsoleEntry[]): ConsoleState {
  if (entries.length === 0) return state;
  const lines = state.lines.slice();
  let nextId = state.nextId;
  for (const entry of entries) {
    const last = lines[lines.length - 1];
    if (last && last.overwrite && last.stream === entry.stream) lines.pop();
    lines.push({ id: nextId++, stream: entry.stream, text: entry.text, overwrite: entry.overwrite ?? false });
  }
  return { lines: lines.length > MAX_CONSOLE_LINES ? lines.slice(lines.length - MAX_CONSOLE_LINES) : lines, nextId };
}
