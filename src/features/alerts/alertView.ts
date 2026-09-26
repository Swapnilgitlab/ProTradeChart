import { formatPrice } from '../../lib/format';
import type { PriceAlert } from '../../lib/ipc';

/** Statuses in the order people want to see them: what is watching first, what has fired last. */
const STATUS_ORDER = { active: 0, paused: 1, triggered: 2 } as const;

export const when = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** The alerts in display order: by status, then the most recent first. */
export function sortAlerts(alerts: readonly PriceAlert[]): PriceAlert[] {
  const rank = (a: PriceAlert) => STATUS_ORDER[a.status as keyof typeof STATUS_ORDER] ?? STATUS_ORDER.triggered;
  return [...alerts].sort((a, b) => rank(a) - rank(b) || (b.triggeredAt ?? b.createdAt) - (a.triggeredAt ?? a.createdAt));
}

/** One line on what an alert is doing: watching, paused, or when it fired and at what. */
export function describeStatus(alert: PriceAlert): string {
  const parts: string[] = [];
  if (alert.status === 'active') parts.push('Watching');
  else if (alert.status === 'paused') parts.push('Paused');
  else parts.push(`Fired ${alert.triggeredAt ? when(alert.triggeredAt) : ''} at ${alert.triggerPrice === null ? '—' : formatPrice(alert.triggerPrice)}`.replace('  ', ' '));
  if (alert.mode === 'every') {
    parts.push('every time it crosses');
    if (alert.status !== 'triggered' && alert.triggerCount > 0 && alert.triggeredAt) {
      parts.push(`fired ${alert.triggerCount}× (last ${when(alert.triggeredAt)})`);
    }
  }
  if (alert.message) parts.push(alert.message);
  return parts.join(' · ');
}
