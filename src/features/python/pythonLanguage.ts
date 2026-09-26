import { HighlightStyle, StreamLanguage, indentUnit, syntaxHighlighting, type StreamParser } from '@codemirror/language';
import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { tags as t } from '@lezer/highlight';

/** Python syntax colouring and completion for the editor. Written for this app, like the
 *  Pine one: a lexer that colours and never rejects — Python reports the real errors. */

const KEYWORDS = new Set([
  'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else',
  'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not',
  'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield', 'match', 'case',
]);
const ATOMS = new Set(['True', 'False', 'None']);
const BUILTINS = new Set([
  'print', 'len', 'range', 'enumerate', 'zip', 'map', 'filter', 'sorted', 'reversed', 'sum', 'min', 'max',
  'abs', 'round', 'int', 'float', 'str', 'bool', 'list', 'dict', 'set', 'tuple', 'isinstance', 'open',
  'any', 'all', 'type', 'getattr', 'hasattr', 'super', 'input', 'format', 'repr',
]);

export interface LexState {
  /** Inside a triple-quoted string that hasn't closed yet: the quote that will close it. */
  triple: string | null;
  /** The last word was `def` or `class`, so the next name is being defined. */
  defining: boolean;
}

/** Exported for tests: the lexer on its own, without an editor. */
export const pythonParser: StreamParser<LexState> = {
  name: 'python',
  startState: () => ({ triple: null, defining: false }),
  copyState: (s) => ({ ...s }),
  token(stream, state) {
    if (state.triple) {
      // Read to the closing quotes, honouring backslash escapes; a string that runs on
      // past the end of the line carries its state to the next.
      let escaped = false;
      while (!stream.eol()) {
        if (!escaped && stream.match(state.triple)) {
          state.triple = null;
          return 'string';
        }
        // Always advance: `!escaped && stream.next()` would skip the read after a backslash
        // and never move again.
        const ch = stream.next();
        escaped = !escaped && ch === '\\';
      }
      return 'string';
    }

    if (stream.eatSpace()) return null;

    if (stream.peek() === '#') {
      stream.skipToEnd();
      return 'comment';
    }

    const triple = stream.match('"""', false) ? '"""' : stream.match("'''", false) ? "'''" : null;
    if (triple) {
      stream.match(triple);
      state.triple = triple;
      return pythonParser.token(stream, state);
    }

    const quote = stream.peek();
    if (quote === '"' || quote === "'") {
      stream.next();
      let escaped = false;
      let ch: string | void;
      while ((ch = stream.next()) != null) {
        if (ch === quote && !escaped) break;
        escaped = !escaped && ch === '\\';
      }
      return 'string';
    }

    if (stream.match(/^@[A-Za-z_][\w.]*/)) return 'meta';
    if (stream.match(/^0[xX][0-9a-fA-F_]+|^0[bB][01_]+|^0[oO][0-7_]+/)) return 'number';
    if (stream.match(/^(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?[jJ]?/)) return 'number';

    if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*/)) {
      const word = stream.current();
      const wasDefining = state.defining;
      state.defining = word === 'def' || word === 'class';
      if (wasDefining) return 'def';
      if (KEYWORDS.has(word)) return 'keyword';
      if (ATOMS.has(word)) return 'atom';
      if (BUILTINS.has(word) && stream.match(/^\s*\(/, false)) return 'builtin';
      return 'variable';
    }

    if (stream.match(/^(?:\*\*=?|\/\/=?|<<=?|>>=?|->|:=|==|!=|<=|>=|[-+*/%&|^~<>=@]=?)/)) return 'operator';
    stream.next();
    return null;
  },
  languageData: {
    commentTokens: { line: '#' },
    closeBrackets: { brackets: ['(', '[', '{', '"', "'"] },
    indentOnInput: /^\s*(?:else|elif|except|finally)\b/,
  },
};

export const pythonLanguage = StreamLanguage.define(pythonParser);

/** Colours come from the app's theme tokens, so every theme gets a readable editor. */
const highlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--accent)', fontWeight: '600' },
  { tag: t.comment, color: 'var(--text-muted)', fontStyle: 'italic' },
  { tag: t.meta, color: 'color-mix(in srgb, var(--accent) 60%, var(--text-muted))' },
  { tag: t.string, color: 'var(--profit)' },
  { tag: [t.number, t.atom], color: 'color-mix(in srgb, var(--loss) 75%, var(--text-primary))' },
  { tag: t.definition(t.variableName), color: 'color-mix(in srgb, var(--accent) 70%, var(--text-primary))', fontWeight: '600' },
  { tag: t.standard(t.variableName), color: 'color-mix(in srgb, var(--accent) 45%, var(--text-primary))' },
  { tag: t.operator, color: 'var(--text-secondary)' },
]);

const fn = (label: string, detail: string): Completion => ({ label, type: 'function', detail });

/** The client's functions, offered after `pt.`. */
const COMPLETIONS: Completion[] = [
  fn('pt.bars', '(symbol, interval="D", start, end, limit)'),
  fn('pt.bars_many', '(symbols, interval="D", start, end, limit, errors="raise")'),
  fn('pt.instruments', '(provider, exchange, kind, q, limit)'),
  fn('pt.watchlist', '(name, providers=None)'),
  fn('pt.watchlists', '()'),
  fn('pt.providers', '()'),
  fn('pt.resample', '(bars, rule, session_open="09:15")'),
  fn('pt.status', '()'),
];

/** `pt.bars` is one completion: the word being completed spans the dot. */
export function pythonCompletionSource(context: CompletionContext): CompletionResult | null {
  const word = context.matchBefore(/pt\.\w*/);
  if (!word) return null;
  // A comment isn't code; don't pop a list up inside one.
  const line = context.state.doc.lineAt(context.pos);
  if (line.text.slice(0, context.pos - line.from).includes('#')) return null;
  return { from: word.from, options: COMPLETIONS, validFor: /^pt\.\w*$/ };
}

export const pythonExtensions = [
  pythonLanguage,
  // Python's convention, and what a person expects Tab to give.
  indentUnit.of('    '),
  syntaxHighlighting(highlightStyle),
  autocompletion({ override: [pythonCompletionSource], activateOnTyping: true, icons: false }),
];

export const PYTHON_COMPLETION_LABELS = COMPLETIONS.map((c) => c.label);
