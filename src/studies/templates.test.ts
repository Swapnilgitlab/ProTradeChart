import { describe, expect, it } from 'vitest';
import { normalizeSpec } from './spec';
import { presetOf, windowSide } from './measures';
import { fromTemplate, TEMPLATES } from './templates';

describe('templates', () => {
  it('are all valid specs with unique ids, and their own names', () => {
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(TEMPLATES.length);
    for (const t of TEMPLATES) {
      expect(normalizeSpec(t.spec)).toEqual(t.spec);
      expect(t.spec.template).toBe(t.id);
      expect(t.spec.universe.market_cap_min).toBeNull();
    }
  });

  it('include the 100% Winners study and a custom starting point', () => {
    const winners = fromTemplate('winners_100');
    expect(winners.event.conditions).toEqual([{ left: 'return_252', op: 'crosses_above', right: 1 }]);
    expect(winners.lookback_windows).toEqual([21, 63, 126, 252]);
    expect(TEMPLATES.some((t) => t.id === 'custom')).toBe(true);
  });

  it('hand out copies, so editing one leaves the template alone', () => {
    const copy = fromTemplate('winners_100');
    copy.name = 'Mine';
    copy.metrics.push('adx_14');
    expect(TEMPLATES[0].spec.name).toBe('100% Winners');
    expect(TEMPLATES[0].spec.metrics).not.toContain('adx_14');
  });

  it('include a journey and an aftermath Study that measure over time and take no snapshots', () => {
    const journey = fromTemplate('how_winners_got_there');
    expect(journey.metrics).toEqual([]);
    expect(journey.question).not.toBe('');
    expect(journey.measures.filter((m) => m.headline).map((m) => m.stat)).toEqual(['length', 'share']);
    expect(windowSide(journey.measures[0].window)).toBe('before');
    const after = fromTemplate('after_the_breakout');
    expect(after.measures.every((m) => windowSide(m.window) === 'after')).toBe(true);
    expect(presetOf(after.measures[0].window)).toBe('until_below_sma50');
  });
});

