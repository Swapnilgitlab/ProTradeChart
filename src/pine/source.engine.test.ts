import { describe, expect, it } from 'vitest';
import { PineEngine } from '@luxalgo/vela-pinets';
import type { ExecutionRequest } from '@luxalgo/vela/plugin';
import { TEMPLATES } from './source';

/** Every starter script must compile and run on the real engine — a template that fails
 *  is the first thing a new user would hit. */

const DAY = 86_400_000;
const BARS: ExecutionRequest['bars'] = Array.from({ length: 200 }, (_, i) => {
  const close = 100 + 15 * Math.sin(i / 9) + i * 0.03;
  const open = 100 + 15 * Math.sin((i - 1) / 9) + (i - 1) * 0.03;
  return { time: Date.UTC(2024, 0, 1) + i * DAY, open, high: Math.max(open, close) + 1, low: Math.min(open, close) - 1, close, volume: 1000 };
});

describe('starter templates run on the real engine', () => {
  for (const template of TEMPLATES) {
    it(template.label, async () => {
      const engine = new PineEngine({ props: 'strategy' });
      const prepared = await engine.prepare(template.source, `tpl-${template.id}`);
      expect(prepared.inputs.length).toBeGreaterThan(0);

      const session = await new Promise<ReturnType<PineEngine['execute']>>((resolve, reject) => {
        const s = engine.execute(
          { prepared, market: { symbol: 'TEST', timeframe: 'D' }, bars: BARS, mode: 'static' },
          { onModel: () => {}, onError: reject, onDone: () => resolve(s) },
        );
      });
      const ctx = await session.getContext?.(['strategy', 'trades', 'warnings']);
      expect(ctx?.warnings ?? []).toEqual([]);
      if (template.kind === 'strategy') {
        expect(ctx?.strategy).toBeDefined();
        expect((ctx?.trades ?? []).length).toBeGreaterThan(0);
        expect((ctx?.trades ?? []).some((t) => t.exit?.id === 'Margin call')).toBe(false);
      } else {
        expect(ctx?.strategy).toBeUndefined();
      }
    });
  }
});
