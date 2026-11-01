import { describe, expect, it } from 'vitest';
import { PineEngine } from '@luxalgo/vela-pinets';
import type { ExecutionRequest } from '@luxalgo/vela/plugin';
import type { PineScriptRow } from '../lib/ipc';
import { findLibrary } from './libraries';

/** A script that imports a saved library runs on the real engine, the library found by its
 *  declared title whatever user and version the import names. */

const DAY = 86_400_000;
const BARS: ExecutionRequest['bars'] = Array.from({ length: 50 }, (_, i) => {
  const close = 100 + i;
  return { time: Date.UTC(2024, 0, 1) + i * DAY, open: close - 1, high: close + 1, low: close - 2, close, volume: 1000 };
});

const saved = (kind: PineScriptRow['kind'], source: string) => ({ kind, source });

const LIBRARY = `//@version=6
// @description Doubles a series.
library("Doubler")

// @function Twice the value.
export double(float x) =>
    x * 2
`;

const SCRIPTS = [
  saved('indicator', '//@version=6\nindicator("Doubler")\nplot(close)'), // same title, but not a library
  saved('library', LIBRARY),
];

describe('Pine libraries', () => {
  it('are found among saved scripts by their declared title, libraries only', () => {
    expect(findLibrary(SCRIPTS, 'Doubler')).toBe(LIBRARY);
    expect(findLibrary(SCRIPTS, 'doubler')).toBeNull();
    expect(findLibrary(SCRIPTS, 'Missing')).toBeNull();
  });

  it('run inside a script that imports them, and an unknown one fails at prepare', async () => {
    const engine = new PineEngine({ importResolver: (_path, info) => findLibrary(SCRIPTS, info.name) });
    const source = `//@version=6
indicator("Uses a library")
import someone/Doubler/3 as lib
plot(lib.double(close), "Twice")
`;
    const prepared = await engine.prepare(source, 'uses-lib');
    const plots = await new Promise<Record<string, ReadonlyArray<{ value: unknown }>>>((resolve, reject) => {
      const s = engine.execute(
        { prepared, market: { symbol: 'TEST', timeframe: 'D' }, bars: BARS, mode: 'static' },
        {
          onModel: () => {},
          onError: reject,
          onDone: () => void s.getContext?.(['plots']).then((ctx) => resolve(ctx?.plots ?? {}), reject),
        },
      );
    });
    const twice = Object.values(plots)[0];
    expect(twice[twice.length - 1].value).toBe(2 * (100 + 49));

    await expect(engine.prepare(source.replace('Doubler', 'Nowhere'), 'missing-lib')).rejects.toThrow(/Nowhere/);
  });
});
