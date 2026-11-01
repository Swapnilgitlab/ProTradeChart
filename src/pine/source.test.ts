import { describe, expect, it } from 'vitest';
import { BLANKS, TEMPLATES, declaredTitle, detectKind } from './source';

describe('detectKind', () => {
  it('reads the declaration, ignoring comments and blank lines', () => {
    expect(detectKind('//@version=6\nindicator("A")')).toBe('indicator');
    expect(detectKind('//@version=6\n\n// strategy("nope")\n  strategy("A", overlay=true)')).toBe('strategy');
    expect(detectKind('indicator ( "spaced" )')).toBe('indicator');
  });

  it('reads a library, and returns null for an undeclared script', () => {
    expect(detectKind('//@version=6\nlibrary("lib")')).toBe('library');
    expect(detectKind('plot(close)')).toBeNull();
    expect(detectKind('')).toBeNull();
  });

  it('uses the first declaration and does not match longer identifiers', () => {
    expect(detectKind('indicator("A")\nstrategy("B")')).toBe('indicator');
    expect(detectKind('myindicator("A")')).toBeNull();
  });
});

describe('declaredTitle', () => {
  it('reads positional, named, single- and double-quoted titles', () => {
    expect(declaredTitle('indicator("My MA", overlay=true)')).toBe('My MA');
    expect(declaredTitle("strategy('Cross', overlay=true)")).toBe('Cross');
    expect(declaredTitle('indicator(title="Named", overlay=true)')).toBe('Named');
    expect(declaredTitle('indicator("Has \\"quotes\\"")')).toBe('Has \\"quotes\\"');
  });

  it('returns null when there is no literal title', () => {
    expect(declaredTitle('indicator(t)')).toBeNull();
    expect(declaredTitle('plot(close)')).toBeNull();
  });
});

describe('TEMPLATES', () => {
  it('declare the kind they are filed under', () => {
    for (const t of [...BLANKS, ...TEMPLATES]) expect(detectKind(t.source), t.id).toBe(t.kind);
  });

  it('have unique ids and titles', () => {
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(TEMPLATES.length);
    expect(TEMPLATES.every((t) => declaredTitle(t.source))).toBe(true);
  });
});
