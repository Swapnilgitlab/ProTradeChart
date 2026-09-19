import { describe, expect, it } from 'vitest';
import { StringStream } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { CompletionContext } from '@codemirror/autocomplete';
import { PINE_COMPLETION_LABELS, pineCompletionSource, pineParser } from './pineLanguage';

/** Lexes one line into `[text, token]` pairs, dropping whitespace and unstyled punctuation. */
function lex(line: string): [string, string][] {
  const stream = new StringStream(line, 4, 2);
  const out: [string, string][] = [];
  while (!stream.eol()) {
    stream.start = stream.pos;
    const token = pineParser.token(stream, null);
    if (token) out.push([stream.current(), token]);
  }
  return out;
}

describe('pine lexer', () => {
  it('colours a declaration and a plot call', () => {
    expect(lex('plot(ta.sma(close, 14), "MA")')).toEqual([
      ['plot', 'builtin'],
      ['ta', 'builtin'],
      ['sma', 'builtin'],
      ['close', 'builtin'],
      ['14', 'number'],
      ['"MA"', 'string'],
    ]);
  });

  it('separates annotations from ordinary comments', () => {
    expect(lex('//@version=6')).toEqual([['//@version=6', 'meta']]);
    expect(lex('x = 1 // why')).toEqual([
      ['x', 'variable'],
      ['=', 'operator'],
      ['1', 'number'],
      ['// why', 'comment'],
    ]);
  });

  it('handles keywords, atoms, types and colour literals', () => {
    expect(lex('if na(x) and true')).toEqual([
      ['if', 'keyword'],
      ['na', 'atom'],
      ['x', 'variable'],
      ['and', 'keyword'],
      ['true', 'atom'],
    ]);
    expect(lex('var float n = #2962FF')).toEqual([
      ['var', 'keyword'],
      ['float', 'type'],
      ['n', 'variable'],
      ['=', 'operator'],
      ['#2962FF', 'atom'],
    ]);
  });

  it('keeps an escaped quote inside a string', () => {
    expect(lex(String.raw`title = "a \"b\" c"`)).toEqual([
      ['title', 'variable'],
      ['=', 'operator'],
      [String.raw`"a \"b\" c"`, 'string'],
    ]);
  });

  it('does not treat a user variable named like a function as builtin unless it is called', () => {
    expect(lex('fill = 3')[0]).toEqual(['fill', 'variable']);
    expect(lex('fill(a, b)')[0]).toEqual(['fill', 'builtin']);
  });
});

describe('pine completion', () => {
  const complete = (doc: string, explicit = false) => {
    const state = EditorState.create({ doc });
    return pineCompletionSource(new CompletionContext(state, doc.length, explicit));
  };

  it('completes across the dot so `ta.s` replaces the whole word', () => {
    const result = complete('x = ta.s');
    expect(result?.from).toBe(4); // start of `ta.s`, not of `s`
    expect(PINE_COMPLETION_LABELS).toContain('ta.sma');
  });

  it('stays quiet with nothing typed, and inside a comment', () => {
    expect(complete('x = ')).toBeNull();
    expect(complete('// ta.s')).toBeNull();
  });

  it('returns nothing when there is no word to anchor on, even on demand', () => {
    expect(complete('x = ', true)).toBeNull();
  });
});
