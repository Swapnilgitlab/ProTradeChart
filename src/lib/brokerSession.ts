import { describeTokenExpiry } from './format';
import { BROKER_LABELS, type BrokerId } from './symbols';

export interface BrokerSessionFacts {
  /** The app's keys (Kite's API key and secret, FYERS's app ID and secret ID) are saved: logging in
   *  from the app is possible. */
  keysSaved: boolean;
  hasToken: boolean;
  enabled: boolean;
  /** Estimated expiry of the saved token, epoch seconds (`tokenExpiresAt` in the broker's status). */
  tokenExpiresAt: number | null;
  /** FYERS only: until when the day's token is renewed by itself with the saved PIN (epoch ms) —
   *  the refresh token's estimated end — or null when it isn't. */
  renewsUntil?: number | null;
}

export type BrokerSessionState = 'no-keys' | 'logged-out' | 'expired' | 'expiring' | 'active' | 'renewing';

export interface BrokerSession {
  state: BrokerSessionState;
  text: string;
}

const KEYS_NEEDED: Record<BrokerId, string> = {
  zerodha: 'Add your Kite Connect API key and secret to log in.',
  fyers: 'Add your FYERS app ID and secret ID to log in.',
};

/** Where the user stands with a broker's once-a-day login. A FYERS login that the app renews with the
 *  saved PIN counts as standing, however its token's own day is going. */
export function brokerSession(broker: BrokerId, f: BrokerSessionFacts, nowMs: number): BrokerSession {
  if (!f.keysSaved) return { state: 'no-keys', text: KEYS_NEEDED[broker] };
  if (!f.hasToken) return { state: 'logged-out', text: 'Not logged in yet.' };
  const expiry = describeTokenExpiry(broker, f.tokenExpiresAt, nowMs);
  if (f.renewsUntil && f.renewsUntil > nowMs && (expiry.expired || expiry.soon)) {
    const days = Math.max(1, Math.round((f.renewsUntil - nowMs) / 86_400_000));
    return { state: 'renewing', text: `Renews by itself with your PIN for about ${days} more day${days === 1 ? '' : 's'}.` };
  }
  if (expiry.expired) return { state: 'expired', text: expiry.text };
  return { state: expiry.soon ? 'expiring' : 'active', text: expiry.text };
}

/** Whether to ask for a fresh login when the app opens: only someone already using the broker
 *  (switched on, logged in before) whose token has since run out and won't renew by itself — never
 *  a first-time setup. */
export function shouldPromptLogin(broker: BrokerId, f: BrokerSessionFacts, nowMs: number): boolean {
  return f.enabled && brokerSession(broker, f, nowMs).state === 'expired';
}

/** `Zerodha`, `FYERS`. */
export const brokerName = (broker: BrokerId) => BROKER_LABELS[broker];
