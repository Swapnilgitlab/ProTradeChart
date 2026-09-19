import { HighlightStyle, StreamLanguage, syntaxHighlighting, type StreamParser } from '@codemirror/language';
import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { tags as t } from '@lezer/highlight';

/** Pine Script syntax colouring and completion for the editor. Written for this app; it
 *  is a lexer, not a parser, so it colours and never rejects — the engine reports the
 *  real errors. */

const KEYWORDS = new Set([
  'if', 'else', 'for', 'to', 'by', 'while', 'switch', 'import', 'export', 'method', 'type', 'enum',
  'var', 'varip', 'const', 'break', 'continue', 'return', 'and', 'or', 'not', 'in', 'as',
]);
const ATOMS = new Set(['true', 'false', 'na']);
const TYPES = new Set(['int', 'float', 'bool', 'string', 'color', 'series', 'simple', 'array', 'matrix', 'map']);
const SERIES = new Set([
  'open', 'high', 'low', 'close', 'volume', 'time', 'time_close', 'bar_index', 'last_bar_index',
  'hl2', 'hlc3', 'ohlc4', 'hlcc4', 'dayofmonth', 'dayofweek', 'hour', 'minute', 'month', 'year', 'second',
]);
const NAMESPACES = new Set([
  'ta', 'math', 'str', 'strategy', 'color', 'input', 'request', 'array', 'matrix', 'map', 'syminfo',
  'timeframe', 'barstate', 'plot', 'shape', 'location', 'size', 'label', 'line', 'box', 'table', 'hline',
  'display', 'format', 'position', 'xloc', 'yloc', 'extend', 'font', 'text', 'alert', 'session', 'chart',
  'currency', 'order', 'scale', 'linefill', 'polyline',
]);
const FUNCTIONS = new Set([
  'indicator', 'strategy', 'library', 'plot', 'plotshape', 'plotchar', 'plotarrow', 'plotbar', 'plotcandle',
  'hline', 'fill', 'bgcolor', 'barcolor', 'alertcondition', 'alert', 'nz', 'fixnan', 'timestamp', 'log',
]);

/** Exported for tests: the lexer on its own, without an editor. */
export const pineParser: StreamParser<null> = {
  name: 'pine',
  startState: () => null,
  token(stream) {
    if (stream.eatSpace()) return null;

    if (stream.match('//')) {
      // `//@version=6` and friends are compiler annotations, not prose.
      const annotation = stream.peek() === '@';
      stream.skipToEnd();
      return annotation ? 'meta' : 'comment';
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

    if (stream.match(/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?\b/)) return 'atom';
    if (stream.match(/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/)) return 'number';

    if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*/)) {
      const word = stream.current();
      // The member of a namespace: `sma` in `ta.sma`, `blue` in `color.blue`.
      const before = stream.string.slice(0, stream.start);
      const owner = /([A-Za-z_][A-Za-z0-9_]*)\.$/.exec(before);
      if (owner && NAMESPACES.has(owner[1])) return 'builtin';
      if (KEYWORDS.has(word)) return 'keyword';
      if (ATOMS.has(word)) return 'atom';
      if (stream.peek() === '.' && NAMESPACES.has(word)) return 'builtin';
      if (TYPES.has(word)) return 'type';
      if (SERIES.has(word) || (FUNCTIONS.has(word) && stream.match(/^\s*\(/, false))) return 'builtin';
      return 'variable';
    }

    if (stream.match(/^(?:=>|:=|==|!=|<=|>=|\+=|-=|\*=|\/=|%=|\?|:|[-+*/%<>=!])/)) return 'operator';
    stream.next();
    return null;
  },
  languageData: {
    commentTokens: { line: '//' },
    closeBrackets: { brackets: ['(', '[', '"', "'"] },
    indentOnInput: /^\s*(?:else)\b/,
  },
};

export const pineLanguage = StreamLanguage.define(pineParser);

/** Colours come from the app's theme tokens, so every theme gets a readable editor. */
const highlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--accent)', fontWeight: '600' },
  { tag: t.comment, color: 'var(--text-muted)', fontStyle: 'italic' },
  { tag: t.meta, color: 'var(--text-muted)' },
  { tag: t.string, color: 'var(--profit)' },
  { tag: [t.number, t.atom], color: 'color-mix(in srgb, var(--loss) 75%, var(--text-primary))' },
  { tag: t.typeName, color: 'color-mix(in srgb, var(--accent) 70%, var(--text-primary))' },
  { tag: t.standard(t.variableName), color: 'color-mix(in srgb, var(--accent) 45%, var(--text-primary))' },
  { tag: t.operator, color: 'var(--text-secondary)' },
]);

const fn = (label: string, detail: string): Completion => ({ label, type: 'function', detail });
const constant = (label: string, detail = ''): Completion => ({ label, type: 'constant', detail });

/** The functions people reach for most. Not exhaustive — the engine knows more. */
const COMPLETIONS: Completion[] = [
  fn('indicator', '(title, overlay)'),
  fn('strategy', '(title, overlay, initial_capital, …)'),
  fn('plot', '(series, title, color, linewidth)'),
  fn('plotshape', '(series, title, style, location, color)'),
  fn('plotchar', '(series, title, char, location)'),
  fn('hline', '(price, title, color, linestyle)'),
  fn('fill', '(plot1, plot2, color)'),
  fn('bgcolor', '(color)'),
  fn('barcolor', '(color)'),
  fn('alertcondition', '(condition, title, message)'),
  fn('nz', '(value, replacement)'),
  fn('fixnan', '(source)'),
  fn('ta.sma', '(source, length)'),
  fn('ta.ema', '(source, length)'),
  fn('ta.rma', '(source, length)'),
  fn('ta.wma', '(source, length)'),
  fn('ta.vwma', '(source, length)'),
  fn('ta.rsi', '(source, length)'),
  fn('ta.macd', '(source, fast, slow, signal)'),
  fn('ta.bb', '(source, length, mult)'),
  fn('ta.atr', '(length)'),
  fn('ta.stoch', '(close, high, low, length)'),
  fn('ta.crossover', '(a, b)'),
  fn('ta.crossunder', '(a, b)'),
  fn('ta.cross', '(a, b)'),
  fn('ta.highest', '(source, length)'),
  fn('ta.lowest', '(source, length)'),
  fn('ta.change', '(source, length)'),
  fn('ta.tr', ''),
  fn('ta.vwap', '(source)'),
  fn('math.abs', '(x)'),
  fn('math.max', '(a, b)'),
  fn('math.min', '(a, b)'),
  fn('math.round', '(x, precision)'),
  fn('math.sqrt', '(x)'),
  fn('input.int', '(defval, title, minval, maxval)'),
  fn('input.float', '(defval, title, minval, maxval)'),
  fn('input.bool', '(defval, title)'),
  fn('input.string', '(defval, title, options)'),
  fn('input.color', '(defval, title)'),
  fn('input.source', '(defval, title)'),
  fn('input.timeframe', '(defval, title)'),
  fn('strategy.entry', '(id, direction, qty, limit, stop, comment)'),
  fn('strategy.exit', '(id, from_entry, profit, loss, stop, limit)'),
  fn('strategy.close', '(id, comment)'),
  fn('strategy.close_all', '(comment)'),
  fn('strategy.order', '(id, direction, qty)'),
  fn('strategy.cancel', '(id)'),
  fn('request.security', '(symbol, timeframe, expression)'),
  fn('color.new', '(color, transp)'),
  fn('color.rgb', '(red, green, blue, transp)'),
  fn('str.tostring', '(value, format)'),
  constant('strategy.long'),
  constant('strategy.short'),
  constant('strategy.percent_of_equity'),
  constant('strategy.fixed'),
  constant('strategy.cash'),
  constant('strategy.commission.percent'),
  constant('strategy.commission.cash_per_order'),
  constant('strategy.commission.cash_per_contract'),
  constant('shape.triangleup'),
  constant('shape.triangledown'),
  constant('shape.circle'),
  constant('shape.xcross'),
  constant('location.abovebar'),
  constant('location.belowbar'),
  constant('hline.style_dashed'),
  constant('hline.style_solid'),
  ...['red', 'green', 'blue', 'orange', 'yellow', 'purple', 'gray', 'white', 'black', 'teal', 'lime', 'aqua', 'maroon', 'navy', 'silver'].map((c) => constant(`color.${c}`)),
  ...['open', 'high', 'low', 'close', 'volume', 'hl2', 'hlc3', 'ohlc4', 'time', 'bar_index'].map((s) => constant(s, 'series')),
];

/** Names like `ta.sma` are one completion, so the word being completed spans dots
 *  (the stock list source stops at `.` and would produce `ta.ta.sma`). */
export function pineCompletionSource(context: CompletionContext): CompletionResult | null {
  const word = context.matchBefore(/[A-Za-z_][\w.]*/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  // A comment or string isn't code; don't pop a list up inside one.
  const line = context.state.doc.lineAt(context.pos);
  if (line.text.slice(0, context.pos - line.from).includes('//')) return null;
  return { from: word.from, options: COMPLETIONS, validFor: /^[A-Za-z_][\w.]*$/ };
}

export const pineExtensions = [
  pineLanguage,
  syntaxHighlighting(highlightStyle),
  autocompletion({ override: [pineCompletionSource], activateOnTyping: true, icons: false }),
];

export const PINE_COMPLETION_LABELS = COMPLETIONS.map((c) => c.label);
