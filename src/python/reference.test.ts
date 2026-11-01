import { describe, expect, it } from 'vitest';
import protradeInit from '../../python/protrade/__init__.py?raw';
import { pythonApiReference } from './reference';

function protradeAll(): string[] {
  const match = protradeInit.match(/__all__\s*=\s*\[([\s\S]*?)\]/);
  if (!match) throw new Error('protrade/__init__.py has no __all__ list to check against.');
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe('the Python API reference', () => {
  it('opens with the real import', () => {
    expect(pythonApiReference()).toContain('import protrade as pt');
  });

  /** The assistant is only as good as what it's told: an export missing here is one it will never use,
   *  or will guess at. */
  it('mentions every name protrade exports', () => {
    const text = pythonApiReference();
    const exported = protradeAll();
    expect(exported.length).toBeGreaterThan(30);
    for (const name of exported) {
      expect(text, `protrade exports ${name}, but the reference never mentions it — document it in reference.ts`).toContain(name);
    }
  });

  it('documents the Panel and BarsMap members a script reaches for', () => {
    const text = pythonApiReference();
    for (const name of ['panel.frame(', 'panel.wide(', 'panel.held', 'panel.missing', 'panel.arrays(', 'result.errors', 'attrs["session"]']) {
      expect(text).toContain(name);
    }
  });
});
