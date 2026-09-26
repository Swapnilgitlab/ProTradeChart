import { describe, expect, it } from 'vitest';
import { StringStream } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { CompletionContext } from '@codemirror/autocomplete';
import { PYTHON_COMPLETION_LABELS, pythonCompletionSource, pythonParser, type LexState } from './pythonLanguage';

/** Lexes lines in order, carrying state between them, into `[text, token]` pairs. */
function lex(...lines: string[]): [string, string][][] {
  const state: LexState = { triple: null, defining: false };
  return lines.map((line) => {
    const stream = new StringStream(line, 4, 4);
    const out: [string, string][] = [];
    while (!stream.eol()) {
      stream.start = stream.pos;
      const token = pythonParser.token(stream, state);
      if (token) out.push([stream.current(), token]);
    }
    return out;
  });
}

const lex1 = (line: string) => lex(line)[0];

describe('python lexer', () => {
  it('colours keywords, names, numbers and strings', () => {
    expect(lex1('if x > 1.5: print("hi")')).toEqual([
      ['if', 'keyword'],
      ['x', 'variable'],
      ['>', 'operator'],
      ['1.5', 'number'],
      ['print', 'builtin'],
      ['"hi"', 'string'],
    ]);
  });

  it('marks a name being defined, once', () => {
    expect(lex1('def screen(bars):')).toEqual([
      ['def', 'keyword'],
      ['screen', 'def'],
      ['bars', 'variable'],
    ]);
    expect(lex1('class Scan:')).toEqual([
      ['class', 'keyword'],
      ['Scan', 'def'],
    ]);
    expect(lex1('def f(): return g')).toEqual([
      ['def', 'keyword'],
      ['f', 'def'],
      ['return', 'keyword'],
      ['g', 'variable'],
    ]);
  });

  it('takes a builtin as one only when it is called', () => {
    expect(lex1('len(x)')[0]).toEqual(['len', 'builtin']);
    expect(lex1('len = 3')[0]).toEqual(['len', 'variable']);
  });

  it('knows the constants and the decorators', () => {
    expect(lex1('x = None')).toEqual([
      ['x', 'variable'],
      ['=', 'operator'],
      ['None', 'atom'],
    ]);
    expect(lex1('@functools.cache')).toEqual([['@functools.cache', 'meta']]);
  });

  it('reads the number forms a script uses', () => {
    for (const n of ['42', '1_000_000', '3.14', '.5', '1e-9', '2.5E3', '0xFF', '0b101', '0o17', '3j']) {
      expect(lex1(`x = ${n}`)[2], n).toEqual([n, 'number']);
    }
  });

  it('ends a comment at the line and does not lex inside it', () => {
    expect(lex1('x = 1  # why "not"')).toEqual([
      ['x', 'variable'],
      ['=', 'operator'],
      ['1', 'number'],
      ['# why "not"', 'comment'],
    ]);
  });

  it('handles escapes and either quote in a string', () => {
    expect(lex1(`'it\\'s' + "say \\"x\\""`)).toEqual([
      [`'it\\'s'`, 'string'],
      ['+', 'operator'],
      ['"say \\"x\\""', 'string'],
    ]);
  });

  it('ends an unterminated string at the end of the line', () => {
    expect(lex('s = "open', 'x = 1')[1][0]).toEqual(['x', 'variable']);
  });

  it('carries a triple-quoted string across lines', () => {
    const lines = lex('"""Screens', 'the market"""', 'x = 1');
    expect(lines[0]).toEqual([['"""Screens', 'string']]);
    expect(lines[1]).toEqual([['the market"""', 'string']]);
    expect(lines[2][0]).toEqual(['x', 'variable']);
  });

  it('lets a triple-quoted string close on the line it opens, and code follow it', () => {
    expect(lex1('"""doc""" + x')).toEqual([
      ['"""doc"""', 'string'],
      ['+', 'operator'],
      ['x', 'variable'],
    ]);
    expect(lex1("'''a''' 'b'")[1]).toEqual(["'b'", 'string']);
  });

  it('terminates on a backslash inside a triple-quoted string (it once looped for ever)', () => {
    const lines = lex('"""a \\ b \\\\ c \\', 'still inside"""', 'z');
    expect(lines[0]).toEqual([['"""a \\ b \\\\ c \\', 'string']]);
    expect(lines[1]).toEqual([['still inside"""', 'string']]);
    expect(lines[2][0]).toEqual(['z', 'variable']);
  });

  it('does not close a triple-quoted string on an escaped quote', () => {
    const lines = lex('"""a \\""" still', 'closes here"""', 'y');
    expect(lines[1]).toEqual([['closes here"""', 'string']]);
    expect(lines[2][0]).toEqual(['y', 'variable']);
  });

  it('reads multi-character operators as one', () => {
    for (const op of ['**', '//', '==', '!=', '<=', '>=', '->', ':=', '+=', '//=', '**=', '<<', '>>=']) {
      expect(lex1(`a ${op} b`)[1], op).toEqual([op, 'operator']);
    }
  });

  it('gives every character of any line a place, without looping', () => {
    const line = 'x = [i for i in range(10) if i % 2] # ₹ ünïcode \u0000 ?!`';
    expect(() => lex1(line)).not.toThrow();
  });
});

describe('python completion', () => {
  function complete(doc: string, explicit = false) {
    const state = EditorState.create({ doc });
    return pythonCompletionSource(new CompletionContext(state, doc.length, explicit));
  }

  it('offers the client functions after pt.', () => {
    const result = complete('df = pt.');
    expect(result?.from).toBe(5);
    expect(result?.options.map((o) => o.label)).toEqual(PYTHON_COMPLETION_LABELS);
    expect(PYTHON_COMPLETION_LABELS).toContain('pt.bars');
    expect(complete('pt.ba')?.from).toBe(0);
  });

  it('stays quiet for anything else, and inside a comment', () => {
    expect(complete('print(')).toBeNull();
    expect(complete('import pandas')).toBeNull();
    expect(complete('# call pt.')).toBeNull();
  });
});
