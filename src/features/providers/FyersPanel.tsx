import { useCallback, useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Copy, ExternalLink, KeyRound, RefreshCw } from 'lucide-react';
import { useToast } from '../../components/Toasts';
import { onFyersStatus } from '../../data/fyersLive';
import { brokerSession } from '../../lib/brokerSession';
import { formatDate } from '../../lib/format';
import {
  errorMessage,
  fyersCompleteLogin,
  fyersLoginInBrowser,
  fyersLoginUrl,
  fyersSetPin,
  fyersSetPlan,
  fyersStatus,
  fyersUpdateInstruments,
  type FeedStatus,
  type FyersStatus,
  type ProviderInfo,
} from '../../lib/ipc';

const FEED_LABELS: Record<FeedStatus['state'], string> = {
  idle: 'Waiting — no FYERS chart is open',
  connecting: 'Starting…',
  live: 'Updating',
  reconnecting: 'Retrying…',
  error: 'Not updating',
};

const REFRESH_DAYS = 15;

/** FYERS's login, the PIN renewal, the plan, and the symbol-master and live-update status.
 *
 *  FYERS access tokens expire every morning at 6:30, and a login happens on FYERS's own page, which
 *  redirects the browser to the URL registered on the user's FYERS app with a one-time `auth_code`. The
 *  app catches that redirect itself, or the user pastes the address. A login also gives a refresh token,
 *  which, with the user's PIN, renews the day's token without a login (an endpoint FYERS doesn't
 *  document; the user decides whether to save the PIN). */
export function FyersPanel({ provider, onLoggedIn }: { provider: ProviderInfo; onLoggedIn: () => Promise<void> }) {
  const toast = useToast();
  const [status, setStatus] = useState<FyersStatus | null>(null);
  const [feed, setFeed] = useState<FeedStatus | null>(null);
  const [working, setWorking] = useState<null | 'browser' | 'open' | 'login' | 'instruments' | 'pin' | 'plan'>(null);
  const [pasted, setPasted] = useState('');
  const [pin, setPin] = useState('');

  const keysSaved = ['appId', 'appSecret'].every((k) => provider.fields.find((f) => f.key === k)?.isSet);
  const hasToken = provider.fields.find((f) => f.key === 'accessToken')?.isSet ?? false;

  const load = useCallback(() => fyersStatus().then(setStatus).catch(() => {}), []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(load, 4000);
    const off = onFyersStatus(setFeed);
    let stop: (() => void) | undefined;
    let cancelled = false;
    void listen('fyers-session', () => void load()).then((unlisten) => {
      if (cancelled) unlisten();
      else stop = unlisten;
    });
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      off();
      stop?.();
    };
  }, [load]);

  const redirectUrl = status?.redirectUrl ?? 'http://127.0.0.1:47822/';

  if (!keysSaved) {
    return (
      <div className="notice" role="note">
        <p style={{ marginTop: 0 }}>
          Save your app ID and secret ID above, then log in from here. You need a FYERS API app: create one at{' '}
          <a href="https://myapi.fyers.in">myapi.fyers.in</a> and set its redirect URL to <code>{redirectUrl}</code>.
        </p>
        <p style={{ marginBottom: 0 }}>
          FYERS's API terms govern how its data may be used; they restrict using it for charting tools and making copies
          of it. ProTradeChart keeps FYERS's prices in memory unless you switch on Save prices on this computer, but
          whether your use is allowed is between you and FYERS.
        </p>
      </div>
    );
  }

  async function run(kind: NonNullable<typeof working>, action: () => Promise<void>) {
    setWorking(kind);
    try {
      await action();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setWorking(null);
    }
  }

  const loginInBrowser = () =>
    run('browser', async () => {
      await fyersLoginInBrowser();
      toast('Logged in to FYERS.', 'success');
      await onLoggedIn();
      await load();
    });

  const openLogin = () => run('open', async () => openUrl(await fyersLoginUrl()));

  const finishLogin = () =>
    run('login', async () => {
      await fyersCompleteLogin(pasted);
      setPasted('');
      toast('Logged in to FYERS.', 'success');
      await onLoggedIn();
      await load();
    });

  const updateInstruments = () =>
    run('instruments', async () => {
      const r = await fyersUpdateInstruments();
      toast(`Symbol master updated (${r.count.toLocaleString()} instruments).`, 'success');
      await load();
    });

  const savePin = (value: string) =>
    run('pin', async () => {
      await fyersSetPin(value);
      setPin('');
      toast(value ? 'PIN saved to your system keychain.' : 'PIN forgotten.', 'success');
      await load();
    });

  const choosePlan = (plan: 'standard' | 'prime') =>
    run('plan', async () => {
      await fyersSetPlan(plan);
      await load();
    });

  async function copyRedirectUrl() {
    try {
      await navigator.clipboard.writeText(redirectUrl);
      toast('Redirect URL copied.', 'success');
    } catch {
      toast(`Copy it by hand: ${redirectUrl}`, 'error');
    }
  }

  const renewsUntil = status?.pinSaved && status.refreshSavedAt !== null ? status.refreshSavedAt + REFRESH_DAYS * 86_400_000 : null;
  const session = status
    ? brokerSession('fyers', { keysSaved, hasToken, enabled: provider.enabled, tokenExpiresAt: status.tokenExpiresAt, renewsUntil }, Date.now())
    : null;
  const feedState = feed ?? status?.feed;
  const plan = status?.plan ?? 'standard';

  return (
    <div className="prov-status">
      <div className="prov-status-row">
        <div>
          <div className="label">Access token</div>
          <div className={session?.state === 'expired' ? 'neg' : session?.state === 'expiring' ? 'warn-text' : undefined}>
            {session?.text ?? '…'}
          </div>
        </div>
      </div>

      <div className="prov-login">
        <div className="label">{hasToken ? 'Log in again' : 'Log in'}</div>
        <p className="small" style={{ margin: '0 0 8px' }}>
          FYERS signs you in for the day. The app opens its login page and takes the token from the browser when you're
          done — nothing to copy.
        </p>
        <button type="button" className="btn btn-primary" disabled={working !== null} onClick={() => void loginInBrowser()}>
          <ExternalLink size={13} /> {working === 'browser' ? 'Waiting for you to finish…' : 'Log in with FYERS'}
        </button>
        <div className="field-hint" style={{ marginTop: 8 }}>
          For this, your FYERS app's redirect URL must be exactly <code>{redirectUrl}</code>{' '}
          <button type="button" className="btn btn-tiny" onClick={() => void copyRedirectUrl()}>
            <Copy size={11} /> Copy
          </button>{' '}
          — set it on your app at <a href="https://myapi.fyers.in">myapi.fyers.in</a>.
        </div>

        <details className="prov-manual">
          <summary className="small">Redirect URL set to something else? Paste the address instead</summary>
          <ol className="small">
            <li>
              <button type="button" className="btn" disabled={working !== null} onClick={() => void openLogin()}>
                <ExternalLink size={13} /> {working === 'open' ? 'Opening…' : 'Open FYERS login'}
              </button>{' '}
              and sign in.
            </li>
            <li>
              FYERS then sends your browser to the redirect URL of your FYERS app. Copy that whole address from the address
              bar (it contains <code>auth_code=…</code>) and paste it here.
            </li>
          </ol>
          <div className="input-with-button">
            <input
              type="text"
              value={pasted}
              placeholder="https://…/?s=ok&code=200&auth_code=…&state=…"
              aria-label="Address FYERS redirected to"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setPasted(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && pasted.trim() && working === null) void finishLogin();
              }}
            />
            <button type="button" className="btn btn-primary" disabled={!pasted.trim() || working !== null} onClick={() => void finishLogin()}>
              {working === 'login' ? 'Logging in…' : 'Finish login'}
            </button>
          </div>
          <span className="field-hint">Each auth code works once and only for a few minutes, so paste it straight away.</span>
        </details>
      </div>

      <div className="prov-login">
        <div className="label">Renew automatically with your PIN</div>
        <p className="small" style={{ margin: '0 0 8px' }}>
          Each login also gives a refresh token that lasts about {REFRESH_DAYS} days. With your four-digit FYERS PIN saved,
          the app uses it to renew the day's token after 6:30 AM, so you log in about once a fortnight instead of every
          morning. The PIN is stored in your system keychain and sent only to FYERS. FYERS doesn't document this renewal,
          so it may stop working; if it does, the app asks you to log in.
        </p>
        <div className="small" style={{ marginBottom: 8 }}>
          {status?.pinSaved ? (
            <>
              <KeyRound size={12} style={{ verticalAlign: '-1px' }} /> PIN saved.{' '}
              {status.refreshSavedAt !== null
                ? `Refresh token from ${formatDate(status.refreshSavedAt)}.`
                : 'No refresh token yet — log in once to get one.'}
            </>
          ) : (
            'No PIN saved: you log in each morning.'
          )}
        </div>
        {status?.renewalError && <p className="small neg">{status.renewalError}</p>}
        <div className="input-with-button">
          <input
            type="password"
            inputMode="numeric"
            maxLength={4}
            value={pin}
            placeholder={status?.pinSaved ? '•••• saved — type to replace' : 'Four-digit PIN'}
            aria-label="FYERS PIN"
            autoComplete="off"
            onChange={(e) => setPin(e.currentTarget.value.replace(/\D/g, ''))}
          />
          <button type="button" className="btn btn-primary" disabled={pin.length !== 4 || working !== null} onClick={() => void savePin(pin)}>
            {working === 'pin' && pin ? 'Saving…' : 'Save PIN'}
          </button>
          <button type="button" className="btn" disabled={!status?.pinSaved || working !== null} onClick={() => void savePin('')}>
            Forget PIN
          </button>
        </div>
      </div>

      <div className="prov-status-row">
        <div>
          <div className="label">FYERS API plan</div>
          <div className="small">
            {plan === 'prime'
              ? 'Prime: 10 data requests a second, 500 a minute, 500,000 a day.'
              : 'Standard (free): 5 data requests a second, 50 a minute, 5,000 a day. Loading the whole market needs Prime.'}{' '}
            The app stays under these limits: FYERS blocks an account for the rest of the day after it goes over too often.
          </div>
          {status && (
            <div className="small muted">
              Today: {status.requestsToday.toLocaleString()} of {status.dailyLimit.toLocaleString()} data requests.
            </div>
          )}
        </div>
        <select
          className="python-input"
          value={plan}
          disabled={working !== null}
          aria-label="FYERS API plan"
          onChange={(e) => void choosePlan(e.currentTarget.value as 'standard' | 'prime')}
        >
          <option value="standard">Standard</option>
          <option value="prime">Prime</option>
        </select>
      </div>

      <div className="prov-status-row">
        <div>
          <div className="label">Symbol master (for symbol search)</div>
          <div>
            {status && status.instrumentCount > 0
              ? `${status.instrumentCount.toLocaleString()} instruments · updated ${formatDate(status.instrumentsUpdatedAt)}`
              : 'Not downloaded yet'}
          </div>
        </div>
        <button type="button" className="btn" disabled={working !== null} onClick={() => void updateInstruments()}>
          <RefreshCw size={13} /> {working === 'instruments' ? 'Downloading…' : status && status.instrumentCount > 0 ? 'Update' : 'Download'}
        </button>
      </div>

      <div className="prov-status-row">
        <div>
          <div className="label">Live charts</div>
          <div className={feedState?.state === 'error' ? 'neg' : undefined}>
            {provider.enabled && feedState ? FEED_LABELS[feedState.state] : 'Off'}
            {provider.enabled && feedState?.message ? ` — ${feedState.message}` : ''}
          </div>
          <div className="small muted">
            From FYERS's quotes, every {plan === 'prime' ? '3 seconds' : '30 seconds'} while the market is open.
          </div>
        </div>
      </div>

      <p className="small muted prov-status-note">
        FYERS's API terms govern how its data may be used; they restrict using it for charting tools and making copies of
        it. ProTradeChart keeps FYERS's prices in memory unless you switch on Save prices on this computer, but whether
        your use is allowed is between you and FYERS.
      </p>
    </div>
  );
}
