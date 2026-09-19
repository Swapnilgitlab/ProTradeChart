import { timeframeToString, type Timeframe } from './timeframes';

/** One bar as it is stored for an imported dataset. */
export interface ImportedBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface CsvParseResult {
  bars: ImportedBar[];
  /** Human-readable problems, capped — never fatal on their own. */
  warnings: string[];
  /** Set when the file can't be used at all (e.g. no recognisable columns). */
  error?: string;
  rowsRead: number;
  rowsSkipped: number;
}

const MAX_WARNINGS = 8;

const COLUMN_ALIASES: Record<'time' | 'open' | 'high' | 'low' | 'close' | 'volume', string[]> = {
  time: ['time', 'date', 'datetime', 'timestamp', 'date/time', 'date time', 'dt', 'day', 'period'],
  open: ['open', 'o', 'open price', 'opening price'],
  high: ['high', 'h', 'high price', 'max'],
  low: ['low', 'l', 'low price', 'min'],
  close: ['close', 'c', 'close price', 'closing price', 'last', 'price', 'adj close', 'adj_close'],
  volume: ['volume', 'vol', 'v', 'qty', 'quantity', 'tick volume', 'tickvol'],
};

function detectDelimiter(headerLine: string): string {
  const counts = [',', ';', '\t', '|'].map((d) => [d, headerLine.split(d).length - 1] as const);
  const best = counts.reduce((a, b) => (b[1] > a[1] ? b : a));
  return best[1] > 0 ? best[0] : ',';
}

/** Splits one line honouring double-quoted fields (which may contain the delimiter). */
function splitLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      out.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out.map((f) => f.trim());
}

function findColumn(headers: string[], key: keyof typeof COLUMN_ALIASES): number {
  const aliases = COLUMN_ALIASES[key];
  // Exact alias first, so "close" beats "adj close" when both are present.
  for (const alias of aliases) {
    const i = headers.indexOf(alias);
    if (i >= 0) return i;
  }
  return -1;
}

type DateOrder = 'dmy' | 'mdy';

/** Slash/dash dates like 03/04/2024 are ambiguous; look at every value for one
 *  whose first or second part can only be a day (> 12) to settle it. */
function detectDateOrder(samples: string[]): DateOrder {
  let dayFirst = false;
  let monthFirst = false;
  for (const s of samples) {
    const m = /^(\d{1,2})[/.-](\d{1,2})[/.-]\d{2,4}/.exec(s);
    if (!m) continue;
    if (Number(m[1]) > 12) dayFirst = true;
    if (Number(m[2]) > 12) monthFirst = true;
  }
  if (dayFirst && !monthFirst) return 'dmy';
  return 'mdy';
}

/** Parses the timestamp formats that show up in exported price files: epoch
 *  seconds/milliseconds, `YYYYMMDD`, ISO-like, and day/month/year. A value
 *  with no timezone is read in the local timezone — the same convention used
 *  for daily bars everywhere else in the app. */
export function parseTimestamp(raw: string, order: DateOrder = 'mdy'): number | null {
  const s = raw.trim();
  if (!s) return null;

  if (/^\d+$/.test(s)) {
    if (s.length === 8 && /^(19|20)\d{6}$/.test(s)) {
      return new Date(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8))).getTime();
    }
    if (s.length <= 10) return Number(s) * 1000;
    return Number(s);
  }

  const named = (y: number, mo: number, d: number, time: string) => {
    const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(time);
    const date = new Date(y, mo - 1, d, t ? Number(t[1]) : 0, t ? Number(t[2]) : 0, t?.[3] ? Number(t[3]) : 0);
    // Reject impossible dates like Feb 31 that Date would silently roll over.
    return date.getMonth() === mo - 1 && date.getDate() === d ? date.getTime() : null;
  };

  const ymd = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s]+(.*))?$/.exec(s);
  if (ymd) {
    const rest = (ymd[4] ?? '').trim();
    // An explicit timezone (Z or ±hh[:mm]) means it's an absolute instant.
    if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(rest)) {
      const t = Date.parse(`${ymd[1]}-${ymd[2].padStart(2, '0')}-${ymd[3].padStart(2, '0')}T${rest.replace(/\s+/g, '')}`);
      return Number.isNaN(t) ? null : t;
    }
    return named(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]), rest);
  }

  const dmy = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:[T\s]+(.*))?$/.exec(s);
  if (dmy) {
    const [a, b] = [Number(dmy[1]), Number(dmy[2])];
    let year = Number(dmy[3]);
    if (dmy[3].length === 2) year += year >= 70 ? 1900 : 2000;
    const [day, month] = order === 'dmy' ? [a, b] : [b, a];
    return named(year, month, day, (dmy[4] ?? '').trim());
  }

  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

function parseNumber(raw: string): number | null {
  const s = raw.replace(/[\s_]/g, '');
  if (!s) return null;
  // "1,234.50" → thousands separators; "1234,50" → decimal comma.
  const normalized = /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

export function parseOhlcvCsv(text: string): CsvParseResult {
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/).filter((l) => l.trim() !== '');
  const empty = (error: string): CsvParseResult => ({ bars: [], warnings: [], error, rowsRead: 0, rowsSkipped: 0 });
  if (lines.length < 2) return empty('The file needs a header row and at least one data row.');

  const delimiter = detectDelimiter(lines[0]);
  const headers = splitLine(lines[0], delimiter).map((h) => h.toLowerCase().replace(/^"|"$/g, ''));

  const col = {
    time: findColumn(headers, 'time'),
    open: findColumn(headers, 'open'),
    high: findColumn(headers, 'high'),
    low: findColumn(headers, 'low'),
    close: findColumn(headers, 'close'),
    volume: findColumn(headers, 'volume'),
  };
  const missing = (['time', 'open', 'high', 'low', 'close'] as const).filter((k) => col[k] < 0);
  if (missing.length > 0) {
    return empty(`Couldn't find column(s): ${missing.join(', ')}. Expected a header like: time,open,high,low,close,volume.`);
  }

  const rows = lines.slice(1).map((l) => splitLine(l, delimiter));
  const order = detectDateOrder(rows.map((r) => r[col.time] ?? ''));

  const warnings: string[] = [];
  const warn = (msg: string) => {
    if (warnings.length < MAX_WARNINGS) warnings.push(msg);
  };
  const bars: ImportedBar[] = [];
  let skipped = 0;

  rows.forEach((cells, i) => {
    const line = i + 2;
    const time = parseTimestamp(cells[col.time] ?? '', order);
    const open = parseNumber(cells[col.open] ?? '');
    const high = parseNumber(cells[col.high] ?? '');
    const low = parseNumber(cells[col.low] ?? '');
    const close = parseNumber(cells[col.close] ?? '');

    if (time === null) {
      skipped++;
      return warn(`Line ${line}: unrecognised date/time "${cells[col.time] ?? ''}"`);
    }
    if (open === null || high === null || low === null || close === null) {
      skipped++;
      return warn(`Line ${line}: a price is missing or not a number`);
    }
    // One zero or negative price would stretch the chart's scale and squash
    // every real candle into a sliver, so such rows are dropped.
    if (open <= 0 || high <= 0 || low <= 0 || close <= 0) {
      skipped++;
      return warn(`Line ${line}: prices must be greater than zero`);
    }
    const volume = col.volume >= 0 ? parseNumber(cells[col.volume] ?? '') : null;
    bars.push({
      time,
      open,
      high: Math.max(high, open, close, low),
      low: Math.min(low, open, close, high),
      close,
      volume: volume !== null && volume >= 0 ? volume : undefined,
    });
  });

  if (skipped > warnings.length) warnings.push(`…and ${skipped - warnings.length} more skipped row(s).`);
  if (bars.length === 0) {
    return { bars, warnings, error: 'No usable rows were found in the file.', rowsRead: rows.length, rowsSkipped: skipped };
  }
  bars.sort((a, b) => a.time - b.time);
  return { bars, warnings, rowsRead: rows.length, rowsSkipped: skipped };
}

// ---- Timeframe detection ---------------------------------------------------

const DAY_MS = 86_400_000;
const MINUTE_STEPS = [1, 2, 3, 5, 10, 15, 30, 45, 60, 120, 180, 240];

/** Guesses a file's bar size from the typical gap between consecutive bars. */
export function detectTimeframe(times: number[]): Timeframe {
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) {
    const g = times[i] - times[i - 1];
    if (g > 0) gaps.push(g);
  }
  if (gaps.length === 0) return { kind: 'day' };
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];

  if (median >= 25 * DAY_MS) return { kind: 'month' };
  if (median >= 5 * DAY_MS) return { kind: 'week' };
  if (median >= 20 * 3_600_000) return { kind: 'day' };
  const minutes = median / 60_000;
  const nearest = MINUTE_STEPS.reduce((a, b) => (Math.abs(b - minutes) < Math.abs(a - minutes) ? b : a));
  return { kind: 'minutes', minutes: nearest };
}

export function detectTimeframeString(times: number[]): string {
  return timeframeToString(detectTimeframe(times));
}

/** A dataset ticker: letters, digits and `._-` only, upper-cased, with any
 *  file extension dropped (so a filename can seed the suggestion). */
export function sanitizeTicker(raw: string): string {
  return raw
    .trim()
    .replace(/\.(csv|txt|tsv)$/i, '')
    .toUpperCase()
    .replace(/[^A-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}
