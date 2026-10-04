import { describe, expect, it } from 'vitest';
import { shouldPromptLogin, zerodhaSession, type ZerodhaSessionFacts } from './zerodhaSession';

const now = 1_800_000_000_000;
const facts = (over: Partial<ZerodhaSessionFacts> = {}): ZerodhaSessionFacts => ({
  keysSaved: true,
  hasToken: true,
  enabled: true,
  tokenExpiresAt: now / 1000 + 8 * 3600,
  ...over,
});

describe('zerodhaSession', () => {
  it('needs the keys before anything else', () => {
    expect(zerodhaSession(facts({ keysSaved: false, hasToken: false }), now).state).toBe('no-keys');
  });

  it('is logged out with keys but no token', () => {
    expect(zerodhaSession(facts({ hasToken: false }), now).state).toBe('logged-out');
  });

  it('tells a live token from one about to reset and one that has', () => {
    expect(zerodhaSession(facts(), now).state).toBe('active');
    expect(zerodhaSession(facts({ tokenExpiresAt: now / 1000 + 1800 }), now).state).toBe('expiring');
    const expired = zerodhaSession(facts({ tokenExpiresAt: now / 1000 - 3600 }), now);
    expect(expired.state).toBe('expired');
    expect(expired.text).toMatch(/log in again/);
  });

  it('treats a token of unknown age as working', () => {
    expect(zerodhaSession(facts({ tokenExpiresAt: null }), now).state).toBe('active');
  });
});

describe('shouldPromptLogin', () => {
  const expired = { tokenExpiresAt: now / 1000 - 60 };

  it('asks only when a switched-on Zerodha has an expired token', () => {
    expect(shouldPromptLogin(facts(expired), now)).toBe(true);
    expect(shouldPromptLogin(facts(), now)).toBe(false);
    expect(shouldPromptLogin(facts({ tokenExpiresAt: now / 1000 + 600 }), now)).toBe(false);
  });

  it('never nags someone who turned Zerodha off or never finished setting it up', () => {
    expect(shouldPromptLogin(facts({ ...expired, enabled: false }), now)).toBe(false);
    expect(shouldPromptLogin(facts({ hasToken: false }), now)).toBe(false);
    expect(shouldPromptLogin(facts({ keysSaved: false, hasToken: false }), now)).toBe(false);
  });
});
