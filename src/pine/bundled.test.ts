import { describe, expect, it } from 'vitest';
import { DEFAULT_CATEGORY, loadBundled, toManifest } from './bundled';

const ind = (title: string) => `//@version=6\nindicator("${title}", overlay=true)\nplot(close)\n`;
const strat = (title: string) => `//@version=6\nstrategy("${title}")\n`;

describe('loadBundled', () => {
  it('groups scripts by folder and sorts by category, then name', () => {
    const scripts = loadBundled({
      '../../pine/indicators/Trend/Zeta.pine': ind('Zeta'),
      '../../pine/indicators/Trend/Alpha.pine': ind('Alpha'),
      '../../pine/indicators/Momentum/RSI.pine': ind('My RSI'),
      '../../pine/indicators/Loose.pine': ind('Loose one'),
      '../../pine/indicators/Volume/Flow/Deep.pine': ind('Deep'),
    });
    expect(scripts.map((s) => [s.category, s.name])).toEqual([
      ['Momentum', 'My RSI'],
      ['Pine scripts', 'Loose one'],
      ['Trend', 'Alpha'],
      ['Trend', 'Zeta'],
      ['Volume / Flow', 'Deep'],
    ]);
    expect(scripts.find((s) => s.name === 'Deep')?.file).toBe('Volume/Flow/Deep.pine');
    expect(DEFAULT_CATEGORY).toBe('Pine scripts');
  });

  it('names a script by its declared title, falling back to the file name', () => {
    const scripts = loadBundled({
      '../../pine/indicators/a.pine': ind('Declared'),
      '../../pine/indicators/b.pine': '//@version=6\nindicator(myTitle)\n',
    });
    expect(scripts.find((s) => s.file === 'a.pine')?.name).toBe('Declared');
    expect(scripts.find((s) => s.file === 'b.pine')?.name).toBe('b');
  });

  it('records the kind, so strategies can be bundled too', () => {
    const [s] = loadBundled({ '../../pine/indicators/S/x.pine': strat('Cross') });
    expect(s.kind).toBe('strategy');
  });

  it('skips a script with no declaration, and a title that is already taken, with a warning', () => {
    const warnings: string[] = [];
    const scripts = loadBundled(
      {
        '../../pine/indicators/a.pine': ind('Same'),
        '../../pine/indicators/b.pine': ind('Same'),
        '../../pine/indicators/lib.pine': 'library("lib")\n',
        '../../pine/indicators/notes.pine': 'plot(close)\n',
      },
      (m) => warnings.push(m),
    );
    expect(scripts.map((s) => s.file)).toEqual(['a.pine']); // the first path wins the title
    expect(warnings).toHaveLength(3);
    expect(warnings.join('\n')).toMatch(/already used by "a.pine"/);
    expect(warnings.join('\n')).toMatch(/no indicator\(\) or strategy\(\)/);
  });

  it('copes with no files at all', () => {
    expect(loadBundled({})).toEqual([]);
  });
});

describe('toManifest', () => {
  it('lists scripts in the picker without adding them to every new chart', () => {
    const [entry] = toManifest(loadBundled({ '../../pine/indicators/Trend/A.pine': ind('A') }));
    expect(entry).toEqual({ name: 'A', script: ind('A'), language: 'pine', enabled: false, category: 'Trend' });
  });
});
