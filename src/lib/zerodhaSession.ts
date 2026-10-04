import { describeKiteTokenExpiry } from './format';

export interface ZerodhaSessionFacts {
  /** The API key and secret are both saved: logging in from the app is possible. */
  keysSaved: boolean;
  hasToken: boolean;
  enabled: boolean;
  /** Estimated expiry of the saved token, epoch seconds (`ZerodhaStatus.tokenExpiresAt`). */
  tokenExpiresAt: number | null;
}

export type ZerodhaSessionState = 'no-keys' | 'logged-out' | 'expired' | 'expiring' | 'active';

export interface ZerodhaSession {
  state: ZerodhaSessionState;
  text: string;
}

/** Where the user stands with Zerodha's once-a-day login. */
export function zerodhaSession(f: ZerodhaSessionFacts, nowMs: number): ZerodhaSession {
  if (!f.keysSaved) return { state: 'no-keys', text: 'Add your Kite Connect API key and secret to log in.' };
  if (!f.hasToken) return { state: 'logged-out', text: 'Not logged in yet.' };
  const expiry = describeKiteTokenExpiry(f.tokenExpiresAt, nowMs);
  if (expiry.expired) return { state: 'expired', text: expiry.text };
  return { state: expiry.soon ? 'expiring' : 'active', text: expiry.text };
}

/** Whether to ask for a fresh login when the app opens: only someone already using Zerodha
 *  (switched on, logged in before) whose token has since run out — never a first-time setup. */
export function shouldPromptLogin(f: ZerodhaSessionFacts, nowMs: number): boolean {
  return f.enabled && zerodhaSession(f, nowMs).state === 'expired';
}
