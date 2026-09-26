import { describe, expect, it } from 'vitest';
import { appendLines, emptyConsole, MAX_CONSOLE_LINES, type ConsoleEntry } from './console';

const out = (text: string, overwrite = false): ConsoleEntry => ({ stream: 'stdout', text, overwrite });
const texts = (entries: readonly ConsoleEntry[]) => appendLines(emptyConsole(), entries).lines.map((l) => l.text);

describe('the console', () => {
  it('keeps lines in the order they arrive, with increasing ids', () => {
    const state = appendLines(emptyConsole(), [out('a'), out('b'), out('')]);
    expect(state.lines.map((l) => l.text)).toEqual(['a', 'b', '']);
    expect(state.lines.map((l) => l.id)).toEqual([1, 2, 3]);
    const lines = appendLines(state, [out('c')]).lines;
    expect(lines[lines.length - 1].id).toBe(4);
  });

  it('returns the very same state when there is nothing to add', () => {
    const state = appendLines(emptyConsole(), [out('a')]);
    expect(appendLines(state, [])).toBe(state);
  });

  it('does not change the state it was given', () => {
    const before = appendLines(emptyConsole(), [out('a')]);
    const copy = JSON.stringify(before);
    appendLines(before, [out('b'), out('c', true), out('d')]);
    expect(JSON.stringify(before)).toBe(copy);
  });

  it('lets a progress bar redraw one line instead of adding hundreds', () => {
    expect(texts([out('fetched 1/3', true), out('fetched 2/3', true), out('fetched 3/3'), out('done')])).toEqual([
      'fetched 3/3',
      'done',
    ]);
  });

  it('replaces only a line that asked to be replaced', () => {
    expect(texts([out('a'), out('b')])).toEqual(['a', 'b']);
    expect(texts([out('a', true), out('b')])).toEqual(['b']);
  });

  it('never replaces a line from the other stream, so an error does not eat a progress bar', () => {
    const entries: ConsoleEntry[] = [out('fetched 1/3', true), { stream: 'stderr', text: 'warning: slow' }, out('fetched 2/3')];
    const lines = appendLines(emptyConsole(), entries).lines;
    expect(lines.map((l) => l.text)).toEqual(['fetched 1/3', 'warning: slow', 'fetched 2/3']);
  });

  it('carries the replacement across separate appends, as output arrives in frames', () => {
    let state = appendLines(emptyConsole(), [out('10%', true)]);
    state = appendLines(state, [out('50%', true)]);
    state = appendLines(state, [out('100%')]);
    expect(state.lines.map((l) => l.text)).toEqual(['100%']);
  });

  it('drops the oldest lines past the limit and keeps the newest', () => {
    const many = Array.from({ length: MAX_CONSOLE_LINES + 50 }, (_, i) => out(`line ${i}`));
    const lines = appendLines(emptyConsole(), many).lines;
    expect(lines).toHaveLength(MAX_CONSOLE_LINES);
    expect(lines[0].text).toBe('line 50');
    expect(lines[lines.length - 1].text).toBe(`line ${MAX_CONSOLE_LINES + 49}`);
  });

  it('keeps the text exactly as it was printed', () => {
    expect(texts([out('  indented ₹ 100  '), out('\ttab')])).toEqual(['  indented ₹ 100  ', '\ttab']);
  });
});
