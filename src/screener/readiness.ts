/** Before a screen runs: what it needs, whether the app has it, and what the data will cost. Pure.
 *  The same facts, and the same wording for them, as a Study's readiness (`studies/readiness.ts`). */

import { splitSymbol } from '../lib/symbols';
import { formatCost, TRIAL_SYMBOLS, type ReadinessFacts, type UniverseEstimate } from '../studies/readiness';
import type { ScreenSpec } from './spec';

export interface ScreenCheck {
  ok: boolean;
  /** The screen can't run until this is dealt with. */
  blocking: boolean;
  text: string;
}

export interface ScreenReadiness {
  ready: boolean;
  checks: ScreenCheck[];
  /** Offer a trial on the first N symbols: the first run would take a while. */
  offerTrial: boolean;
}

/** Above this many minutes of fetching, a trial run is offered. */
const LONG_FETCH_MINUTES = 3;

const label = (id: string) => (id === 'zerodha' ? 'Zerodha' : id);

export function screenReadiness(spec: ScreenSpec, facts: Omit<ReadinessFacts, 'today'>): ScreenReadiness {
  const checks: ScreenCheck[] = [];
  checks.push(
    facts.pythonReady
      ? { ok: true, blocking: false, text: 'Python is ready to run the screen.' }
      : { ok: false, blocking: true, text: facts.pythonMessage ?? 'Set up Python in the Python tab first.' },
  );

  const u = spec.universe;
  const usable = new Set(facts.providers.filter((p) => p.usable).map((p) => p.id));
  if (u.source === 'watchlist') {
    const known = facts.watchlists.some((w) => w.toLowerCase() === (u.watchlist ?? '').toLowerCase());
    checks.push({ ok: known, blocking: !known, text: known ? `Watchlist “${u.watchlist}”.` : `There is no watchlist called “${u.watchlist}”.` });
  }
  // A watchlist's sources are only known when it runs; the engine leaves out what it can't read.
  const sources = u.source === 'instruments' ? [u.provider] : u.source === 'symbols' ? [...new Set(u.symbols.map((s) => splitSymbol(s).provider))] : [];
  const unsupported = sources.filter((p) => p !== 'zerodha');
  const missing = sources.filter((p) => p === 'zerodha' && !usable.has(p));
  if (unsupported.length) {
    checks.push({ ok: false, blocking: true, text: `The Screener reads Zerodha data only, not ${unsupported.join(', ')}.` });
  } else if (missing.length) {
    checks.push({ ok: false, blocking: true, text: `${missing.map(label).join(' and ')} isn't set up and switched on (Data providers).` });
  }
  if (spec.benchmark && !usable.has(splitSymbol(spec.benchmark).provider)) {
    checks.push({ ok: false, blocking: false, text: `${label(splitSymbol(spec.benchmark).provider)} isn't set up, so relative strength would be blank.` });
  }

  let offerTrial = false;
  const e: UniverseEstimate | null | undefined = facts.estimate;
  if (e) {
    offerTrial = e.seconds / 60 > LONG_FETCH_MINUTES && u.max_symbols === null && e.symbols > TRIAL_SYMBOLS;
    const parts = [
      `${e.symbols.toLocaleString()} symbol${e.symbols === 1 ? '' : 's'}`,
      `${e.stored.toLocaleString()} already stored`,
      formatCost(e),
    ];
    checks.push(
      e.symbols === 0
        ? { ok: false, blocking: u.source === 'instruments', text: 'No stocks in this universe. Update the instrument list in Data providers.' }
        : { ok: true, blocking: false, text: `${parts.join('; ')}.` },
    );
  }
  return { ready: !checks.some((c) => c.blocking), checks, offerTrial };
}
