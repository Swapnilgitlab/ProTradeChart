/** What a script showed, turned into something the panel can draw.
 *
 *  A script is arbitrary code the user wrote, so nothing here trusts what it sent: every result
 *  is checked and anything malformed is refused rather than drawn. Pure, so all of that is
 *  tested without a component. */

export interface TableResult {
  kind: 'table';
  id: number;
  title: string | null;
  columns: string[];
  /** Each row has one cell per column; a missing or unusable value is null. */
  rows: Cell[][];
  /** How many rows the script had, which may be more than it sent. */
  totalRows: number;
  /** The column holding chart symbols, if any: its cells open a chart. */
  symbolColumn: number | null;
  /** Decimals to draw numbers with. */
  digits: number;
}

export type Cell = string | number | boolean | null;

export interface Metric {
  label: string;
  value: number | string | null;
  format: 'money' | 'percent' | 'ratio' | 'int' | 'number' | 'text';
}

export interface Curve {
  /** Epoch milliseconds. */
  t: number[];
  v: number[];
}

export interface ReportResult {
  kind: 'report';
  id: number;
  title: string | null;
  metrics: Metric[];
  equity: Curve | null;
  benchmark: Curve | null;
  initialCapital: number | null;
  trades: TableResult | null;
}

export interface FigureResult {
  kind: 'figure';
  id: number;
  title: string | null;
  /** A `data:` URI for an `<img>`; the payload is checked to be a base64 PNG. */
  src: string;
}

export type PythonResult = TableResult | ReportResult | FigureResult;

const FORMATS = new Set(['money', 'percent', 'ratio', 'int', 'number', 'text']);
/** The first bytes of every PNG, base64-encoded. */
const PNG_PREFIX = 'iVBORw0KGgo';
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** More than this and the panel crawls; the backend caps the whole body at 16 MB as well. */
const MAX_ROWS = 5000;
const MAX_COLUMNS = 100;
const MAX_POINTS = 20_000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function cell(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (isFiniteNumber(value)) return value;
  return null;
}

function table(data: unknown, id: number, title: string | null): TableResult | null {
  if (!isRecord(data) || !Array.isArray(data.columns) || !Array.isArray(data.rows)) return null;
  if (data.columns.length === 0 || data.columns.length > MAX_COLUMNS) return null;
  if (!data.columns.every((c) => typeof c === 'string')) return null;
  const columns = data.columns as string[];

  const rows: Cell[][] = [];
  for (const row of data.rows.slice(0, MAX_ROWS)) {
    if (!Array.isArray(row)) return null;
    // A row is padded or trimmed to the columns, so the table is always rectangular.
    rows.push(columns.map((_, i) => cell(row[i])));
  }
  const symbolColumn =
    isFiniteNumber(data.symbolColumn) && Number.isInteger(data.symbolColumn) && data.symbolColumn >= 0 && data.symbolColumn < columns.length
      ? data.symbolColumn
      : null;
  return {
    kind: 'table',
    id,
    title,
    columns,
    rows,
    totalRows: isFiniteNumber(data.totalRows) && data.totalRows >= rows.length ? Math.floor(data.totalRows) : rows.length,
    symbolColumn,
    digits: isFiniteNumber(data.digits) ? Math.min(Math.max(Math.floor(data.digits), 0), 10) : 2,
  };
}

function metrics(value: unknown): Metric[] {
  if (!Array.isArray(value)) return [];
  const out: Metric[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.label !== 'string') continue;
    const format = typeof item.format === 'string' && FORMATS.has(item.format) ? (item.format as Metric['format']) : 'number';
    const raw = item.value;
    const metricValue = raw === null || raw === undefined ? null : format === 'text' ? String(raw) : isFiniteNumber(raw) ? raw : null;
    out.push({ label: item.label, value: metricValue, format });
  }
  return out;
}

function curve(value: unknown): Curve | null {
  if (!isRecord(value) || !Array.isArray(value.t) || !Array.isArray(value.v)) return null;
  // Only points where both the time and the value are usable, so the two arrays stay in step.
  const t: number[] = [];
  const v: number[] = [];
  const n = Math.min(value.t.length, value.v.length, MAX_POINTS);
  for (let i = 0; i < n; i++) {
    if (isFiniteNumber(value.t[i]) && isFiniteNumber(value.v[i])) {
      t.push(value.t[i] as number);
      v.push(value.v[i] as number);
    }
  }
  return t.length >= 2 ? { t, v } : null;
}

function figureSrc(data: unknown): string | null {
  if (!isRecord(data) || typeof data.png !== 'string') return null;
  const png = data.png.trim();
  // It must really be a PNG: the app draws it, and an SVG would bring script with it.
  if (!png.startsWith(PNG_PREFIX) || !BASE64.test(png)) return null;
  return `data:image/png;base64,${png}`;
}

/** Turns an event into something drawable, or null when it isn't one. `id` names it in the list. */
export function parseResult(event: { kind: string; title: string | null; data: unknown }, id: number): PythonResult | null {
  const title = typeof event.title === 'string' && event.title.trim() !== '' ? event.title : null;
  switch (event.kind) {
    case 'table':
      return table(event.data, id, title);
    case 'figure': {
      const src = figureSrc(event.data);
      return src === null ? null : { kind: 'figure', id, title, src };
    }
    case 'report': {
      if (!isRecord(event.data)) return null;
      const report: ReportResult = {
        kind: 'report',
        id,
        title,
        metrics: metrics(event.data.metrics),
        equity: curve(event.data.equity),
        benchmark: curve(event.data.benchmark),
        initialCapital: isFiniteNumber(event.data.initialCapital) ? event.data.initialCapital : null,
        trades: event.data.trades == null ? null : table(event.data.trades, id, null),
      };
      // Nothing to show at all means the payload wasn't a report.
      return report.metrics.length === 0 && !report.equity && !report.trades ? null : report;
    }
    default:
      return null;
  }
}

/** A metric as the panel writes it. `currency` is only used by `money`. */
export function formatMetric(metric: Metric, currency = '₹'): string {
  const { value, format } = metric;
  if (value === null) return '—';
  if (format === 'text') return String(value);
  const n = value as number;
  switch (format) {
    case 'money':
      return `${n < 0 ? '-' : ''}${currency}${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    case 'percent':
      return `${n.toFixed(2)}%`;
    case 'ratio':
      return n.toFixed(2);
    case 'int':
      return Math.round(n).toLocaleString();
    default:
      return Math.abs(n) >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(Number(n.toFixed(4)));
  }
}

/** Whether a metric reads as good, bad or neither, for colouring. */
export function metricTone(metric: Metric): 'profit' | 'loss' | '' {
  if (typeof metric.value !== 'number' || metric.format === 'int' || metric.format === 'text') return '';
  const label = metric.label.toLowerCase();
  // A drawdown is a loss however it is signed; everything else goes by its sign.
  if (label.includes('drawdown') || label.includes('loss')) return metric.value === 0 ? '' : 'loss';
  if (label.includes('capital') || label.includes('equity')) return '';
  if (metric.value > 0) return 'profit';
  if (metric.value < 0) return 'loss';
  return '';
}

/** A table cell as text. Numbers get `digits` decimals; a whole number keeps none. */
export function formatCell(value: Cell, digits: number): string {
  if (value === null) return '';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? value.toLocaleString()
      : value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }
  return value;
}

/** The rows sorted by one column: numbers as numbers, text as text, blanks last. */
export function sortRows(rows: readonly Cell[][], column: number, direction: 'asc' | 'desc'): Cell[][] {
  const sign = direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = a[column];
    const y = b[column];
    if (x === null && y === null) return 0;
    if (x === null) return 1; // blanks sink, whichever way it is sorted
    if (y === null) return -1;
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * sign;
    return String(x).localeCompare(String(y), undefined, { numeric: true }) * sign;
  });
}

/** The chart symbols in a table's symbol column, without repeats. */
export function symbolsOf(table: TableResult): string[] {
  if (table.symbolColumn === null) return [];
  const seen = new Set<string>();
  for (const row of table.rows) {
    const value = row[table.symbolColumn];
    if (typeof value === 'string' && value.includes(':')) seen.add(value);
  }
  return [...seen];
}
