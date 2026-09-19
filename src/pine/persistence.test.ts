import { describe, expect, it } from 'vitest';
import type { InputSchema } from '@luxalgo/vela/plugin';
import { makeIndicatorId, scriptIdOf } from './engine';
import { parseSavedScripts, toIndicatorEntry, toSavedScripts } from './persistence';

const PROP_SCHEMA: InputSchema[] = [
  { key: 'initial_capital', title: 'Initial capital', type: 'float', defval: 10000 },
  { key: 'commission_value', title: 'Commission', type: 'float', defval: 0 },
];

const SCHEMA: InputSchema[] = [
  { key: 'len', title: 'Length', type: 'int', defval: 14 },
  { key: 'col', title: 'Color', type: 'color', defval: '#2196F3' },
];

function handle(over: Record<string, unknown> = {}) {
  return {
    id: 'a~1',
    title: 'My MA',
    source: '//@version=6\nindicator("My MA")',
    inputs: SCHEMA,
    props: PROP_SCHEMA,
    visible: true,
    inputValues: () => ({ len: 14, col: '#2196F3' }),
    propValues: () => ({}),
    ...over,
  } as Parameters<typeof toSavedScripts>[0][number];
}

describe('indicator ids', () => {
  it('links a chart indicator back to its library script', () => {
    const id = makeIndicatorId('3f2c-uuid');
    expect(id.startsWith('3f2c-uuid~')).toBe(true);
    expect(scriptIdOf(id)).toBe('3f2c-uuid');
    expect(makeIndicatorId('x')).not.toBe(makeIndicatorId('x'));
  });

  it('returns null for an id we did not mint', () => {
    expect(scriptIdOf('ind-4')).toBeNull();
    expect(scriptIdOf('~oops')).toBeNull();
  });
});

describe('toSavedScripts', () => {
  it('keeps only script indicators, and only the values that differ from the defaults', () => {
    const saved = toSavedScripts([
      handle(),
      // Vela reports every prop, defaults included; only the one that differs is kept.
      handle({ id: 'b~2', inputValues: () => ({ len: 50, col: '#2196F3' }), propValues: () => ({ initial_capital: 5000, commission_value: 0 }), visible: false }),
      handle({ id: 'native', source: undefined }),
    ]);
    expect(saved).toEqual([
      { id: 'a~1', name: 'My MA', source: '//@version=6\nindicator("My MA")' },
      {
        id: 'b~2',
        name: 'My MA',
        source: '//@version=6\nindicator("My MA")',
        inputs: { len: 50 },
        props: { initial_capital: 5000 },
        hidden: true,
      },
    ]);
  });

  it('names a script by the title it declares, not the handle placeholder', () => {
    const source = '//@version=6\nindicator("Real name", overlay=true)';
    const [saved] = toSavedScripts([handle({ title: 'Indicator', source })]);
    expect(saved.name).toBe('Real name');
  });

  it('falls back to the handle title when the script declares none', () => {
    const [saved] = toSavedScripts([handle({ title: 'Indicator', source: 'plot(close)' })]);
    expect(saved.name).toBe('Indicator');
  });

  it('stores nothing for props that all sit on their defaults', () => {
    const [saved] = toSavedScripts([handle({ propValues: () => ({ initial_capital: 10000, commission_value: 0 }) })]);
    expect(saved.props).toBeUndefined();
  });
});

describe('parseSavedScripts', () => {
  it('drops malformed entries and duplicates instead of failing the restore', () => {
    const parsed = parseSavedScripts([
      { id: 'a', name: 'A', source: 'x', inputs: { n: 1 }, props: { p: 'y' }, hidden: true },
      { id: 'a', name: 'dup', source: 'x' },
      { id: '', source: 'x' },
      { id: 'c' },
      { id: 'd', source: '   ' },
      { id: 'e', source: 'x', inputs: { bad: { nested: 1 } }, name: 42 },
      'nope',
      null,
    ]);
    expect(parsed).toEqual([
      { id: 'a', name: 'A', source: 'x', inputs: { n: 1 }, props: { p: 'y' }, hidden: true },
      { id: 'e', name: 'Script', source: 'x' },
    ]);
  });

  it('treats a non-array payload as nothing to restore', () => {
    expect(parseSavedScripts(undefined)).toEqual([]);
    expect(parseSavedScripts({ id: 'a', source: 'x' })).toEqual([]);
  });

  it('round-trips into an indicator entry for the pine engine', () => {
    const [saved] = parseSavedScripts([{ id: 'a~1', name: 'A', source: 'src', inputs: { n: 2 } }]);
    expect(toIndicatorEntry(saved)).toEqual({
      id: 'a~1',
      name: 'A',
      script: 'src',
      language: 'pine',
      inputs: { n: 2 },
      props: undefined,
      hidden: undefined,
    });
  });
});
