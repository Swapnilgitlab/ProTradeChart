/** How the Study's significance tests are put into words. The engine runs the tests
 *  (`protrade/stats_tests.py`); this only reads them, and never words a difference as a cause. Pure. */

import { featureLabel, offsetLabel, windowLabel } from './metrics';
import type { Finding, TestResult } from './result';

/** q below this is "stands out", as in the engine's `FINDING_Q`. */
export const FINDING_Q = 0.05;
/** Cliff's delta thresholds, as in the engine's `stats_tests`. */
const SMALL = 0.147;
const MEDIUM = 0.33;
const LARGE = 0.474;

export type EffectWord = 'negligible' | 'small' | 'medium' | 'large';

export function effectWord(effect: number | null | undefined): EffectWord | null {
  if (effect === null || effect === undefined || !Number.isFinite(effect)) return null;
  const size = Math.abs(effect);
  if (size < SMALL) return 'negligible';
  if (size < MEDIUM) return 'small';
  if (size < LARGE) return 'medium';
  return 'large';
}

export function formatQ(q: number | null | undefined): string {
  if (q === null || q === undefined || !Number.isFinite(q)) return '—';
  if (q < 0.001) return 'q < 0.001';
  return `q = ${q < 0.01 ? q.toFixed(3) : q.toFixed(2)}`;
}

export const standsOut = (test: TestResult | null | undefined): boolean => !!test && test.q !== null && test.q < FINDING_Q;

/** Cliff's delta as it reads in a table: `+0.62 large`. */
export function formatEffect(effect: number | null | undefined): string {
  const word = effectWord(effect);
  if (word === null) return '—';
  return `${effect! > 0 ? '+' : ''}${effect!.toFixed(2)} ${word}`;
}

const points = (x: number) => `${x > 0 ? '+' : ''}${Math.round(x * 100)} pts`;

/** A share difference with its interval: `+34 pts (95% CI +20 to +48)`. */
export function formatShareDiff(test: TestResult | null | undefined): string {
  if (!test || test.diff === null) return '—';
  const ci = test.low !== null && test.high !== null ? ` (95% CI ${points(test.low)} to ${points(test.high)})` : '';
  return `${points(test.diff)}${ci}`;
}

/** One finding in a sentence, e.g. "At T-3M, the 3M return was higher among winners than among control
 *  dates (large effect, q < 0.001)." */
export function describeFinding(f: Finding, group: string, comparison: string): string {
  const q = formatQ(f.test.q);
  if (f.kind === 'characteristic') {
    const more = (f.test.diff ?? 0) > 0;
    return `At ${offsetLabel(f.offset)}, “${f.label}” was ${more ? 'more' : 'less'} common among ${group} than among ${comparison}: ${formatShareDiff(f.test)}, ${q}.`;
  }
  const higher = (f.test.effect ?? 0) > 0;
  const size = effectWord(f.test.effect) ?? 'unknown';
  if (f.kind === 'forward') {
    return `Over the next ${windowLabel(f.window)}, returns were ${higher ? 'higher' : 'lower'} among ${group} than among ${comparison} (${size} effect, ${q}).`;
  }
  return `At ${offsetLabel(f.offset)}, ${featureLabel(f.metric)} was ${higher ? 'higher' : 'lower'} among ${group} than among ${comparison} (${size} effect, ${q}).`;
}
