import { describe, expect, it } from 'vitest';
import { PineEngine } from '@luxalgo/vela-pinets';
import type { ExecutionRequest } from '@luxalgo/vela/plugin';
import { BUNDLED_SCRIPTS } from './bundled';

/** Every script under pine/indicators is shipped to users, so each one must compile and
 *  run on the real engine. This is the gate that keeps a broken script out of a release. */

const RAW = import.meta.glob<string>('../../pine/indicators/**/*.pine', { query: '?raw', import: 'default', eager: true });

const DAY = 86_400_000;
const BARS: ExecutionRequest['bars'] = Array.from({ length: 300 }, (_, i) => {
  const close = 100 + 18 * Math.sin(i / 11) + i * 0.04 + 2 * Math.sin(i * 1.3);
  const open = 100 + 18 * Math.sin((i - 1) / 11) + (i - 1) * 0.04 + 2 * Math.sin((i - 1) * 1.3);
  return { time: Date.UTC(2024, 0, 1) + i * DAY, open, high: Math.max(open, close) + 1, low: Math.min(open, close) - 1, close, volume: 1000 + (i % 40) * 10 };
});

describe('bundled scripts', () => {
  it('are all loaded: none was skipped for a missing declaration or a duplicate title', () => {
    expect(BUNDLED_SCRIPTS.length).toBe(Object.keys(RAW).length);
  });

  for (const script of BUNDLED_SCRIPTS) {
    it(`${script.file} compiles and runs without warnings`, async () => {
      const engine = new PineEngine({ props: 'strategy' });
      const prepared = await engine.prepare(script.source, `bundled-${script.file}`);
      const session = await new Promise<ReturnType<PineEngine['execute']>>((resolve, reject) => {
        const s = engine.execute(
          { prepared, market: { symbol: 'TEST', timeframe: 'D' }, bars: BARS, mode: 'static' },
          { onModel: () => {}, onError: reject, onDone: () => resolve(s) },
        );
      });
      const ctx = await session.getContext?.(['plots', 'strategy', 'trades', 'warnings']);
      expect(ctx?.warnings ?? []).toEqual([]);
      if (script.kind === 'strategy') {
        expect(ctx?.strategy).toBeDefined();
        expect((ctx?.trades ?? []).some((t) => t.exit?.id === 'Margin call')).toBe(false);
      } else {
        expect(Object.keys(ctx?.plots ?? {}).length, 'an indicator should plot something').toBeGreaterThan(0);
      }
    });
  }
});
