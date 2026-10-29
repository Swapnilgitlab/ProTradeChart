/** Naming a new script. The backend is the authority on what a valid name is (it must also
 *  refuse a name like `pandas.py`, which would replace the library for the scripts beside it),
 *  so this only suggests one and tidies what was typed; the backend's message says what's
 *  wrong when it refuses. */

/** `untitled.py`, then `untitled 2.py`, … — the first that isn't taken (names compare
 *  without regard to case, as Windows and macOS file systems do). */
export function nextScriptName(existing: readonly string[], base = 'untitled'): string {
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  let name = `${base}.py`;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} ${n}.py`;
  return name;
}

/** What was typed, trimmed and ending in `.py` (in lower case: the backend wants that). */
export function withPyExtension(typed: string): string {
  const name = typed.trim();
  if (name === '') return name;
  return /\.py$/i.test(name) ? `${name.slice(0, -3)}.py` : `${name}.py`;
}

/** What a new script starts with. */
export const STARTER_SCRIPT = `"""Describe what this script does."""

import protrade as pt

# A symbol is provider:EXCHANGE:TICKER. Try pt.instruments("india", exchange="NSE") to browse.
bars = pt.bars("india:NSE:RELIANCE", "D", limit=250)
print(bars.tail())
`;
