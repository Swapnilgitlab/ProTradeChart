import { describe, expect, it } from 'vitest';
import cases from './fixtures/screen-cases.json';
import { fromPreset, PRESETS } from './presets';
import { historyBars, loadFrom, normalizeScreen, outputColumns, screenProblem } from './spec';

/** The placeholders screen-cases.json uses for lists too long to write out (test_screen.py expands them the same way). */
function expand(value: unknown): unknown {
  if (value === 'TWENTY_ONE_FILTERS') return Array.from({ length: 21 }, () => ({ left: 'rsi_14', op: '<', right: 30 }));
  if (value === 'THIRTY_ONE_COLUMNS') return Array.from({ length: 31 }, (_, i) => `sma_${i + 1}`);
  if (value && typeof value === 'object' && !Array.isArray(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v)]));
  return value;
}

const patched = (patch: object) => ({ ...structuredClone(cases.base), ...(expand(structuredClone(patch)) as object) });

describe('the cases shared with the engine (fixtures/screen-cases.json)', () => {
  it.each(cases.refused)('refuses $patch', ({ patch, word }) => {
    expect(() => normalizeScreen(patched(patch))).toThrow(word);
  });

  it.each(cases.accepted)('accepts: $about', ({ patch, expect: expected }) => {
    expect(normalizeScreen(patched(patch))).toEqual(expected);
  });

  it('accepts the base itself', () => {
    expect(screenProblem(cases.base)).toBeNull();
  });
});

describe('a screen', () => {
  it('shows every feature its filters read, after the columns asked for', () => {
    const spec = normalizeScreen({ ...cases.base, filters: [{ left: 'close', op: '>', right: 'ema_200' }, { left: 'rsi_14', op: '<', right: 30 }], sort: null });
    expect(outputColumns(spec)).toEqual(['close', 'return_1', 'volume', 'ema_200', 'rsi_14']);
  });

  it('is normalised to itself (saving twice changes nothing)', () => {
    const once = normalizeScreen(patched(cases.accepted[0].patch));
    expect(normalizeScreen(structuredClone(once))).toEqual(once);
  });

  it('loads as much history as the engine (history_bars / fetch_start)', () => {
    // The engine's figures for the same screens (test_screen.py checks its side).
    const slow = normalizeScreen({ ...cases.base, columns: ['ema_200', 'slope_sma_200'], filters: [], sort: null });
    expect(historyBars(slow)).toBe(2 * (200 + 21) + 10);
    expect(historyBars(normalizeScreen({ ...cases.base, columns: ['close'], filters: [], sort: null }))).toBe(260);
    // 452 bars → 674 + 10 calendar days before 2025-07-01.
    expect(loadFrom(slow, new Date(2025, 6, 1))).toBe('2023-08-17');
  });

  it('every preset is a valid screen, under a unique id', () => {
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length);
    for (const preset of PRESETS) expect(screenProblem(fromPreset(preset.id)), preset.id).toBeNull();
  });

  it('an unknown preset falls back to a blank screen', () => {
    expect(fromPreset('nope').filters).toEqual([]);
  });
});
