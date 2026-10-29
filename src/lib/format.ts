import type { BrokerId } from './symbols';

const DASH = '—';

/** Fixed to `max` decimals, then trailing zeros trimmed down to no fewer than `min`. */
function trimmed(v: number, max: number, min: number): string {
  const fixed = v.toFixed(max);
  const [int, frac = ''] = fixed.split('.');
  let end = frac.length;
  while (end > min && frac[end - 1] === '0') end--;
  return end > 0 ? `${int}.${frac.slice(0, end)}` : int;
}

/** A price with a sensible number of decimals for its magnitude: two for
 *  stocks and indices, more for FX and sub-dollar crypto where the extra digits
 *  carry information. `null` (no quote) renders as an em dash. */
export function formatPrice(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  const abs = Math.abs(v);
  if (abs >= 100) return v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (abs >= 1) return trimmed(v, 4, 2);
  return trimmed(v, 6, 2);
}

/** Signed percentage with two decimals, e.g. `+1.25%`. */
export function formatPercent(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

/** A compact date/time range label for dataset summaries. */
export function formatDate(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return DASH;
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** "5h 12m" for a span in seconds (sign ignored). */
export function formatSpan(seconds: number): string {
  const s = Math.abs(Math.round(seconds));
  const days = Math.floor(s / 86_400);
  const hours = Math.floor((s % 86_400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/** When each broker's access tokens stop working, as the expiry text says it. */
const TOKEN_RESETS: Record<BrokerId, string> = {
  zerodha: 'Kite tokens reset around 6 AM',
  fyers: 'FYERS tokens reset at 6:30 AM',
};

/** An estimated expiry for a broker's access token. Neither broker gives tokens an
 *  expiry of their own; they simply stop working each morning (Kite at about 06:00
 *  IST, FYERS at 06:30), so the caller passes that estimate (or `null` when it isn't known). */
export function describeTokenExpiry(
  broker: BrokerId,
  expiresAtSecs: number | null,
  nowMs: number,
): { text: string; expired: boolean; soon: boolean } {
  if (expiresAtSecs === null) return { text: "Saved, but when it was issued isn't known.", expired: false, soon: false };
  const left = expiresAtSecs - nowMs / 1000;
  if (left <= 0) return { text: `Expired ${formatSpan(left)} ago — log in again.`, expired: true, soon: false };
  return { text: `Should work for another ${formatSpan(left)} (${TOKEN_RESETS[broker]}).`, expired: false, soon: left < 2 * 3600 };
}

export const describeKiteTokenExpiry = (expiresAtSecs: number | null, nowMs: number) =>
  describeTokenExpiry('zerodha', expiresAtSecs, nowMs);
