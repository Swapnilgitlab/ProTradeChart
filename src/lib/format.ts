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

/** Whether and when an access token stops working, in plain words. */
export function describeTokenExpiry(expiresAtSecs: number | null, nowMs: number): { text: string; expired: boolean; soon: boolean } {
  if (expiresAtSecs === null) return { text: "Expiry unknown (the token isn't a standard one).", expired: false, soon: false };
  const left = expiresAtSecs - nowMs / 1000;
  if (left <= 0) return { text: `Expired ${formatSpan(left)} ago.`, expired: true, soon: false };
  return { text: `Valid for another ${formatSpan(left)}.`, expired: false, soon: left < 2 * 3600 };
}

/** An estimated expiry for a Zerodha access token. Kite gives tokens no expiry
 *  of their own; they simply stop working at about 06:00 IST, so the caller
 *  passes that estimate (or `null` when it isn't known). */
export function describeKiteTokenExpiry(
  expiresAtSecs: number | null,
  nowMs: number,
): { text: string; expired: boolean; soon: boolean } {
  if (expiresAtSecs === null) return { text: "Saved, but when it was issued isn't known.", expired: false, soon: false };
  const left = expiresAtSecs - nowMs / 1000;
  if (left <= 0) return { text: `Expired ${formatSpan(left)} ago — log in again.`, expired: true, soon: false };
  return { text: `Should work for another ${formatSpan(left)} (Kite tokens reset around 6 AM).`, expired: false, soon: left < 2 * 3600 };
}
