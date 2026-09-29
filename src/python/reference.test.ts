import { describe, expect, it } from 'vitest';
import protradeInit from '../../python/protrade/__init__.py?raw';
import { pythonApiReference } from './reference';

/** The names this prompt is meant to cover — a deliberate subset of `protrade.__all__` (the
 *  point is a short, human-readable prompt, not a dump of every export), checked against the
 *  real package so a rename or removal is caught here rather than silently going stale. */
const DOCUMENTED = [
  'status',
  'providers',
  'instruments',
  'watchlists',
  'watchlist',
  'universe',
  'bars',
  'bars_many',
  'resample',
  'show',
  'report',
  'plot',
  'set_watchlist',
  'ResearchStudy',
  'NotConfiguredError',
  'NotFoundError',
  'RateLimitedError',
  'AuthError',
  'BadRequestError',
];

function protradeAll(): string[] {
  const match = protradeInit.match(/__all__\s*=\s*\[([\s\S]*?)\]/);
  if (!match) throw new Error('protrade/__init__.py has no __all__ list to check against.');
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe('the Python API reference for outside LLMs', () => {
  it('opens with the real import', () => {
    expect(pythonApiReference()).toContain('import protrade as pt');
  });

  it('mentions every name it documents, and each is still really exported', () => {
    const text = pythonApiReference();
    const exported = protradeAll();
    for (const name of DOCUMENTED) {
      expect(exported, `${name} is no longer in protrade.__all__ — update the reference or drop it`).toContain(name);
      expect(text, `${name} is documented here but not actually mentioned in the text`).toContain(name);
    }
  });
});
