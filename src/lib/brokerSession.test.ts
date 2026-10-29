import { describe, expect, it } from 'vitest';
import { brokerSession, shouldPromptLogin, type BrokerSessionFacts } from './brokerSession';

const now = 1_800_000_000_000;
const DAY = 86_400_000;
const facts = (over: Partial<BrokerSessionFacts> = {}): BrokerSessionFacts => ({
  keysSaved: true,
  hasToken: true,
  enabled: true,
  tokenExpiresAt: now / 1000 + 8 * 3600,
  ...over,
});

describe('brokerSession', () => {
  it('needs the keys before anything else, naming each broker’s own', () => {
    expect(brokerSession('zerodha', facts({ keysSaved: false, hasToken: false }), now)).toMatchObject({ state: 'no-keys', text: /Kite Connect/ });
    expect(brokerSession('fyers', facts({ keysSaved: false, hasToken: false }), now)).toMatchObject({ state: 'no-keys', text: /FYERS app ID/ });
  });

  it('is logged out with keys but no token', () => {
    expect(brokerSession('zerodha', facts({ hasToken: false }), now).state).toBe('logged-out');
  });

  it('tells a live token from one about to reset and one that has', () => {
    expect(brokerSession('zerodha', facts(), now).state).toBe('active');
    expect(brokerSession('zerodha', facts({ tokenExpiresAt: now / 1000 + 1800 }), now).state).toBe('expiring');
    const expired = brokerSession('zerodha', facts({ tokenExpiresAt: now / 1000 - 3600 }), now);
    expect(expired.state).toBe('expired');
    expect(expired.text).toMatch(/log in again/);
  });

  it('says when each broker resets its tokens', () => {
    expect(brokerSession('zerodha', facts(), now).text).toMatch(/6 AM/);
    expect(brokerSession('fyers', facts(), now).text).toMatch(/6:30 AM/);
  });

  it('treats a token of unknown age as working', () => {
    expect(brokerSession('zerodha', facts({ tokenExpiresAt: null }), now).state).toBe('active');
  });

  it('counts a FYERS login the app renews with the PIN as standing, until the refresh token runs out', () => {
    const renewing = brokerSession('fyers', facts({ tokenExpiresAt: now / 1000 - 3600, renewsUntil: now + 5 * DAY }), now);
    expect(renewing).toMatchObject({ state: 'renewing', text: /about 5 more days/ });
    expect(brokerSession('fyers', facts({ tokenExpiresAt: now / 1000 - 3600, renewsUntil: now - 1 }), now).state).toBe('expired');
    expect(brokerSession('fyers', facts({ renewsUntil: now + 5 * DAY }), now).state, 'a fresh token says so').toBe('active');
  });
});

describe('shouldPromptLogin', () => {
  const expired = { tokenExpiresAt: now / 1000 - 60 };

  it('asks only when a switched-on broker has an expired token', () => {
    expect(shouldPromptLogin('zerodha', facts(expired), now)).toBe(true);
    expect(shouldPromptLogin('zerodha', facts(), now)).toBe(false);
    expect(shouldPromptLogin('zerodha', facts({ tokenExpiresAt: now / 1000 + 600 }), now)).toBe(false);
  });

  it('never nags someone who turned the broker off or never finished setting it up', () => {
    expect(shouldPromptLogin('zerodha', facts({ ...expired, enabled: false }), now)).toBe(false);
    expect(shouldPromptLogin('zerodha', facts({ hasToken: false }), now)).toBe(false);
    expect(shouldPromptLogin('zerodha', facts({ keysSaved: false, hasToken: false }), now)).toBe(false);
  });

  it('never asks when the app will renew the FYERS login itself', () => {
    expect(shouldPromptLogin('fyers', facts({ ...expired, renewsUntil: now + DAY }), now)).toBe(false);
    expect(shouldPromptLogin('fyers', facts(expired), now)).toBe(true);
  });
});
