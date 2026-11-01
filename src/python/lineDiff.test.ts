import { describe, expect, it } from 'vitest';
import { diffCounts, hunks, lineDiff, splitLines } from './lineDiff';

const marks = (before: string, after: string) =>
  lineDiff(before, after).map((l) => `${l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}${l.text}`);

describe('a line diff of two versions of a script', () => {
  it('reads lines the way an editor does', () => {
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a\r\nb\n')).toEqual(['a', 'b']);
    expect(splitLines('a\n\n')).toEqual(['a', '']);
  });

  it('marks what was added, removed and kept, in order', () => {
    expect(marks('a\nb\nc\n', 'a\nB\nc\nd\n')).toEqual([' a', '-b', '+B', ' c', '+d']);
    expect(marks('', 'x\n')).toEqual(['+x']);
    expect(marks('x\n', '')).toEqual(['-x']);
    expect(marks('same\n', 'same\n')).toEqual([' same']);
  });

  it('numbers each line in the version it belongs to', () => {
    const d = lineDiff('a\nb\nc\nd\n', 'a\nnew\nb\nc\nd\n');
    expect(d.find((l) => l.kind === 'add')).toMatchObject({ text: 'new', oldNo: null, newNo: 2 });
    expect(d[d.length - 1]).toMatchObject({ text: 'd', oldNo: 4, newNo: 5 });
  });

  it('counts the change', () => {
    expect(diffCounts(lineDiff('a\nb\n', 'a\nc\nd\n'))).toEqual({ added: 2, removed: 1 });
  });

  it('keeps a small change inside a long file small', () => {
    const before = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    const after = before.replace('line 50', 'line fifty');
    const { hunks: shown, trailing } = hunks(lineDiff(before, after));
    expect(shown).toHaveLength(1);
    expect(shown[0].skipped).toBe(47);
    expect(shown[0].lines.map((l) => l.kind)).toEqual(['same', 'same', 'same', 'del', 'add', 'same', 'same', 'same']);
    expect(trailing).toBe(46);
  });

  it('shows a huge rewrite as removed then added instead of comparing every pair of lines', () => {
    const before = Array.from({ length: 3000 }, (_, i) => `old ${i}`).join('\n');
    const after = Array.from({ length: 3000 }, (_, i) => `new ${i}`).join('\n');
    const d = lineDiff(before, after);
    expect(diffCounts(d)).toEqual({ added: 3000, removed: 3000 });
    expect(d[0].kind).toBe('del');
    expect(d[3000].kind).toBe('add');
  });
});
