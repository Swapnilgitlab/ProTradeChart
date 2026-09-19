const DASH = '—';
const MINUS = '−'; // a real minus sign lines up with digits and reads better than a hyphen

const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/** Account money: thousands separators, two decimals, and a currency code only when the
 *  strategy names one (`NONE` means the script didn't choose). */
export function formatMoney(v: number | null | undefined, currency?: string): string {
  if (!finite(v)) return DASH;
  const body = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const unit = currency && currency !== 'NONE' ? ` ${currency}` : '';
  return `${v < 0 ? MINUS : ''}${body}${unit}`;
}

/** Money with an explicit sign for gains — `+1,234.50`, `−98.00`. */
export function formatSignedMoney(v: number | null | undefined, currency?: string): string {
  if (!finite(v)) return DASH;
  return `${v > 0 ? '+' : ''}${formatMoney(v, currency)}`;
}

/** A percentage; pass `signed` for P&L (`+1.25%`), omit for shares (`62.50%`). */
export function formatPct(v: number | null | undefined, signed = false): string {
  if (!finite(v)) return DASH;
  const body = `${Math.abs(v).toFixed(2)}%`;
  if (v < 0) return `${MINUS}${body}`;
  return signed && v > 0 ? `+${body}` : body;
}

/** A ratio such as profit factor or win/loss, two decimals. */
export function formatRatio(v: number | null | undefined): string {
  return finite(v) ? v.toFixed(2) : DASH;
}

/** A position size: trims noise (`111.509203` → `111.51`) but keeps small crypto sizes readable. */
export function formatQty(v: number): string {
  const abs = Math.abs(v);
  const digits = abs >= 100 ? 2 : abs >= 1 ? 3 : 6;
  return Number(v.toFixed(digits)).toLocaleString('en-US', { maximumFractionDigits: digits });
}

/** Whole bars count, or a dash when unknown. */
export function formatBars(v: number | null | undefined): string {
  return finite(v) ? String(Math.round(v)) : DASH;
}

/** `2024-03-05 14:30` in the machine's timezone — dates only for daily-and-up bars,
 *  which are stamped at local midnight. */
export function formatWhen(ms: number | null | undefined): string {
  if (!finite(ms)) return DASH;
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return d.getHours() === 0 && d.getMinutes() === 0 ? date : `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The CSS class that colours a P&L figure. */
export function pnlClass(v: number | null | undefined): string {
  if (!finite(v) || v === 0) return '';
  return v > 0 ? 'pos' : 'neg';
}
