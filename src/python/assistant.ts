/** The Python tab's AI assistant, its pure half: what the app tells the AI about this user's setup, which part
 *  of the last run goes with a request, the conversation's history, and the checks on what comes back. The
 *  pane is `features/python/AssistantPane.tsx`; the prompt itself is `python_body` in
 *  `src-tauri/src/ai/prompts.rs`.
 *
 *  What comes back is an untrusted proposal: `parseAssistAnswer` re-checks it, the pane draws it as text and
 *  changes, and only the user's Apply puts it in the editor — never saved, run or scheduled by the app. */

import type { BrokerId } from '../lib/symbols';
import { withPyExtension } from './scriptNames';

// ---- The user's setup ----------------------------------------------------------------------------

/** The intervals each broker serves natively, in the words the reference uses. */
const BROKER_INTERVALS: Record<BrokerId, string> = {
  zerodha: '"1", "3", "5", "10", "15", "30", "60" (minutes) and "D"',
  fyers: '"1", "2", "3", "5", "10", "15", "20", "30", "60", "120", "240" (minutes) and "D"',
};

export interface SetupFacts {
  broker?: {
    id: BrokerId;
    label: string;
    configured: boolean;
    fyersPlan?: 'standard' | 'prime';
    requestsToday?: number;
    dailyLimit?: number;
  };
  keepLoaded?: boolean;
  savedPrices?: boolean;
  watchlists?: { name: string; count: number }[];
  layouts?: string[];
  /** Imported CSV datasets, by ticker (read as `csv:TICKER`). */
  datasets?: { ticker: string; interval: string }[];
  emailReady?: boolean;
  scripts?: string[];
  /** The schedules the open script is a step of. */
  schedules?: { name: string; step: number; steps: number; when: string; enabled: boolean }[];
  python?: { version: string | null; custom: boolean };
  packages?: { name: string; version: string | null }[];
}

/** How many of each list are named, and how long a name may be: enough to recognise what the user means,
 *  short enough that the whole description stays well under what the backend accepts. */
const MAX_LISTED = 40;
const MAX_NAME_CHARS = 80;
export const MAX_SETUP_CHARS = 18_000;

const clip = (s: string) => (s.length > MAX_NAME_CHARS ? `${s.slice(0, MAX_NAME_CHARS - 1)}…` : s);

function listed<T>(items: readonly T[], show: (item: T) => string): string {
  const shown = items.slice(0, MAX_LISTED).map(show).join(', ');
  return items.length > MAX_LISTED ? `${shown}, and ${items.length - MAX_LISTED} more` : shown;
}

/** One line per fact the app could find out; a fact it couldn't is left out rather than guessed. */
export function describeSetup(f: SetupFacts): string {
  const lines: string[] = [];
  if (f.broker) {
    const b = f.broker;
    let line = `Broker serving india: symbols: ${b.label} (${b.configured ? 'connected' : 'not set up yet: data calls will raise NotConfiguredError'}). Its native intervals: ${BROKER_INTERVALS[b.id]}.`;
    if (b.id === 'fyers' && b.fyersPlan) {
      line +=
        b.fyersPlan === 'standard'
          ? ` FYERS Standard plan: 50 data requests a minute and ${b.dailyLimit ?? 5000} a day${b.requestsToday !== undefined ? ` (${b.requestsToday} used today)` : ''}, so keep history requests few (prefer pt.panel or pt.snapshot).`
          : ' FYERS Prime plan.';
    }
    lines.push(line);
  }
  if (f.keepLoaded !== undefined) {
    lines.push(
      f.keepLoaded
        ? '"Keep the market loaded" is on: the app holds five years of daily bars for every NSE stock and index, so pt.panel answers a whole market in about a second.'
        : '"Keep the market loaded" is off: pt.panel answers only for symbols the app has already read; pt.bars_many fetches the rest from the broker.',
    );
  }
  if (f.savedPrices !== undefined) {
    lines.push(
      f.savedPrices
        ? 'Saved prices are on: pt.sql can read prices.price_series and prices.price_bars.'
        : 'Saved prices are off: pt.sql has no prices.* tables.',
    );
  }
  if (f.watchlists) {
    lines.push(
      f.watchlists.length
        ? `Watchlists (name: symbols): ${listed(f.watchlists, (w) => `${clip(w.name)}: ${w.count}`)}.`
        : 'There are no watchlists yet.',
    );
  }
  if (f.layouts) lines.push(f.layouts.length ? `Saved chart layouts (for pt.screenshot's layout): ${listed(f.layouts, clip)}.` : 'There are no saved chart layouts.');
  if (f.datasets?.length) lines.push(`Imported datasets: ${listed(f.datasets, (d) => `csv:${clip(d.ticker)} (${d.interval})`)}.`);
  if (f.emailReady !== undefined) {
    lines.push(f.emailReady ? 'Email is set up: pt.send_email works.' : 'Email is not set up: pt.send_email will fail until the user sets it up in the Scheduler tab (Email settings).');
  }
  if (f.scripts) lines.push(f.scripts.length ? `Scripts in the Python tab: ${listed(f.scripts, clip)}.` : 'There are no other scripts.');
  if (f.schedules) {
    lines.push(
      f.schedules.length
        ? `This script runs from these schedules: ${listed(f.schedules, (s) => `"${clip(s.name)}" (step ${s.step} of ${s.steps}, ${s.when}${s.enabled ? '' : ', switched off'})`)}.`
        : 'This script is not part of any schedule.',
    );
  }
  if (f.python) {
    lines.push(`Python ${f.python.version ?? '(version unknown)'}${f.python.custom ? ', an interpreter the user chose' : ", the app's own environment"}.`);
  }
  if (f.packages) {
    const installed = f.packages.filter((p) => p.version).map((p) => `${p.name} ${p.version}`);
    const missing = f.packages.filter((p) => !p.version).map((p) => p.name);
    lines.push(`Installed packages: ${installed.length ? installed.join(', ') : 'none of those checked'}.${missing.length ? ` Not installed: ${missing.join(', ')}.` : ''}`);
  }
  const text = lines.join('\n');
  return text.length > MAX_SETUP_CHARS ? `${text.slice(0, MAX_SETUP_CHARS - 1)}…` : text;
}

/** Today's date in India, YYYY-MM-DD: the market's calendar, whatever the machine's own zone. */
export function todayInIndia(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

// ---- The last run --------------------------------------------------------------------------------

/** What the panel keeps of a script's last run, for the assistant. */
export interface LastRun {
  script: string;
  failed: boolean;
  /** How it ended, in the console's words ("Exited with code 1 after 0.4 s"). */
  summary: string;
  stdout: string[];
  stderr: string[];
}

/** A run's output as it arrives, kept for `LastRun`. */
export interface RunCapture {
  script: string;
  stdout: string[];
  stderr: string[];
  /** The last line of each stream ended in a lone carriage return: a progress bar the next line replaces. */
  redraw: { stdout: boolean; stderr: boolean };
}

/** The most lines kept of each stream; `tailText` keeps far fewer of them anyway. */
const MAX_CAPTURED_LINES = 2_000;

export const newCapture = (script: string): RunCapture => ({ script, stdout: [], stderr: [], redraw: { stdout: false, stderr: false } });

/** Adds one printed line, the way the console shows it (a redrawn progress bar is one line, not hundreds). */
export function captureLine(c: RunCapture, stream: 'stdout' | 'stderr', text: string, overwrite: boolean): void {
  const lines = c[stream];
  if (c.redraw[stream]) lines.pop();
  lines.push(text);
  c.redraw[stream] = overwrite;
  if (lines.length > MAX_CAPTURED_LINES) lines.splice(0, lines.length - MAX_CAPTURED_LINES);
}

/** The `run` part of a request, as the backend takes it. */
export interface RunReport {
  failed: boolean;
  summary: string;
  errors: string;
  output: string | null;
}

/** Under the backend's 32 KB per field, with room for the marker. */
export const MAX_RUN_TEXT_BYTES = 30 * 1024;
const OMITTED = '… (earlier lines left out)';

const utf8Length = (s: string) => new TextEncoder().encode(s).length;

/** The newest lines that fit in `maxBytes`, oldest first, with a marker when any were dropped. A single line
 *  too long to fit keeps its end. */
export function tailText(lines: readonly string[], maxBytes = MAX_RUN_TEXT_BYTES): string {
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const size = utf8Length(lines[i]) + 1;
    if (used + size > maxBytes) {
      if (kept.length === 0) kept.push(`…${lines[i].slice(-Math.floor(maxBytes / 4))}`);
      kept.unshift(OMITTED);
      break;
    }
    kept.unshift(lines[i]);
    used += size;
  }
  return kept.join('\n');
}

/** What of the last run goes with a request: its error only when the user kept the chip, and what it printed
 *  only when they ticked Include output (it can hold broker prices). Nothing when neither is wanted. */
export function runReport(run: LastRun | null, withErrors: boolean, withOutput: boolean): RunReport | null {
  if (!run || (!withErrors && !withOutput)) return null;
  return {
    failed: run.failed,
    summary: run.summary,
    errors: withErrors ? tailText(run.stderr) : '',
    output: withOutput ? tailText(run.stdout) : null,
  };
}

// ---- The conversation ----------------------------------------------------------------------------

export interface Turn {
  role: 'user' | 'assistant';
  text: string;
}

/** One question and what came of it, as the pane keeps it. */
export interface AssistExchange {
  question: string;
  reply: string | null;
  proposed: boolean;
  error: string | null;
}

/** The backend's limit on earlier turns. */
const MAX_TURNS = 20;
export const PROPOSED_NOTE = '(I proposed a new version of the script.)';

/** Earlier turns as text only: an answer that came with code says so, but never carries the code — the
 *  script travels fresh with every request, so an old copy would only cost tokens and confuse. The oldest
 *  exchanges go first when there are too many. */
export function assistHistory(exchanges: readonly AssistExchange[]): Turn[] {
  const turns = exchanges
    .filter((e) => e.reply !== null || e.proposed)
    .flatMap((e): Turn[] => [
      { role: 'user', text: e.question },
      { role: 'assistant', text: [e.reply, e.proposed ? PROPOSED_NOTE : null].filter(Boolean).join('\n\n') },
    ]);
  return turns.slice(Math.max(0, turns.length - MAX_TURNS));
}

// ---- The answer ----------------------------------------------------------------------------------

export interface AssistAnswer {
  reply: string;
  /** The whole new script, or null when there is no change to make. */
  code: string | null;
  /** A file name for a new script, when the user asked for one. */
  name: string | null;
}

const MAX_REPLY_CHARS = 4_000;
const MAX_CODE_BYTES = 256 * 1024;
const NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_ -]{0,58}\.py$/;

/** A whole answer wrapped in a Markdown fence, which the prompt asks the AI not to do, unwrapped. */
export function stripFence(code: string): string {
  const m = /^\s*(`{3,})[\w+-]*[ \t]*\r?\n([\s\S]*?)\r?\n?\1\s*$/.exec(code);
  return m ? m[2] : code;
}

const normalise = (code: string) => {
  const text = code.replace(/\r\n?/g, '\n');
  return text.endsWith('\n') ? text : `${text}\n`;
};

/** Checks what the AI sent back. Throws when it isn't the shape asked for; a wrong-looking `name` is
 *  dropped (it's only a suggestion), and code identical to `source` means there's nothing to apply. */
export function parseAssistAnswer(answer: unknown, source: string): AssistAnswer {
  const a = answer as Record<string, unknown> | null;
  if (!a || typeof a !== 'object' || typeof a.reply !== 'string' || typeof a.code !== 'string' || typeof a.name !== 'string') {
    throw new Error('The AI’s answer wasn’t in the shape it was asked for. Try again.');
  }
  const reply = a.reply.trim().slice(0, MAX_REPLY_CHARS);
  let code: string | null = stripFence(a.code);
  if (code.trim() === '') code = null;
  else {
    code = normalise(code);
    if (utf8Length(code) > MAX_CODE_BYTES) throw new Error('The AI’s script was too large to show.');
    if (code === normalise(source)) code = null;
  }
  const typed = withPyExtension(a.name);
  const name = typed && NAME_PATTERN.test(typed) ? typed : null;
  if (!reply && !code) throw new Error('The AI sent back an empty answer. Try again.');
  return { reply, code, name };
}

/** A name for "Save as new script": the AI's suggestion if it's free, else `<current>_2.py`, `_3`, … */
export function newScriptName(suggested: string | null, current: string | null, existing: readonly string[]): string {
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  if (suggested && !taken.has(suggested.toLowerCase())) return suggested;
  const base = (suggested ?? current ?? 'script.py').replace(/\.py$/i, '').replace(/_\d+$/, '');
  for (let n = 2; ; n++) {
    const name = `${base}_${n}.py`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}
