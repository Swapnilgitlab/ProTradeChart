import { useCallback, useEffect, useMemo, useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Check, Copy, ExternalLink, Eye, EyeOff, KeyRound, RefreshCw, ShieldAlert, Star } from 'lucide-react';
import { Dialog } from '../../components/Dialog';
import { useToast } from '../../components/Toasts';
import { onZerodhaStatus } from '../../data/zerodhaLive';
import { getProviderState, refreshProviders, setDefaultProvider } from '../../data/providerStatus';
import { confirmDelete } from '../../lib/dialogs';
import { describeKiteTokenExpiry, formatDate } from '../../lib/format';
import {
  clearProviderConfig,
  errorMessage,
  saveProviderConfig,
  setProviderEnabled,
  testProvider,
  type FeedStatus,
  type ProviderInfo,
  type TestResult,
  type ZerodhaStatus,
  zerodhaCompleteLogin,
  zerodhaLoginInBrowser,
  zerodhaLoginUrl,
  zerodhaRedirectUrl,
  zerodhaStatus,
  zerodhaUpdateInstruments,
} from '../../lib/ipc';
import type { ProviderId } from '../../lib/symbols';
import { MarketDataSection } from '../marketdata/MarketDataSection';
import { useProviderState } from './useProviderState';

interface Props {
  onClose: () => void;
  /** Which provider to show first. */
  initialProvider?: string;
}

type Tone = 'ok' | 'off' | 'warn';

/** The one-word state shown beside each provider. */
function providerStatus(p: ProviderInfo): { label: string; tone: Tone } {
  if (p.enabled && p.configured) return { label: 'On', tone: 'ok' };
  if (p.category === 'broker' && !p.configured) return { label: 'Set up', tone: 'warn' };
  return { label: 'Off', tone: 'off' };
}

const CATEGORY_ORDER: Record<ProviderInfo['category'], number> = { broker: 0, free: 1, local: 2 };
const CATEGORY_TITLES: Record<ProviderInfo['category'], string> = {
  broker: 'Your broker accounts',
  free: 'Free sources',
  local: 'On this computer',
};

const FEED_LABELS: Record<FeedStatus['state'], string> = {
  idle: 'Idle — connects when a chart needs it',
  connecting: 'Connecting…',
  live: 'Live',
  reconnecting: 'Reconnecting…',
  error: 'Not connected',
};

/** Downloads a broker's instrument list in the background, so symbol search
 *  works as soon as it is switched on. Providers without one do nothing. */
function refreshInstruments(providerId: string): void {
  if (providerId === 'zerodha') zerodhaUpdateInstruments().catch(() => {});
}

/** Where a user configures data sources: turn each on or off, enter broker
 *  credentials, test them, and pick the default. Everything is driven by the
 *  backend's provider list, so a new provider appears here with no UI work. */
export function DataProvidersDialog({ onClose, initialProvider }: Props) {
  const { providers, defaultProvider } = useProviderState();
  const [selectedId, setSelectedId] = useState<string>(initialProvider ?? 'zerodha');

  const groups = useMemo(() => {
    const sorted = [...providers].sort((a, b) => CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category]);
    const out: { category: ProviderInfo['category']; items: ProviderInfo[] }[] = [];
    for (const p of sorted) {
      const group = out.find((g) => g.category === p.category);
      if (group) group.items.push(p);
      else out.push({ category: p.category, items: [p] });
    }
    return out;
  }, [providers]);

  const selected = providers.find((p) => p.id === selectedId) ?? providers[0];

  return (
    <Dialog
      wide
      title="Data providers"
      onClose={onClose}
      footer={
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      }
    >
      <p className="secondary" style={{ marginTop: 0 }}>
        Choose where charts get their prices. Turn sources on or off, connect your own broker account, and pick the default
        for symbols you type without a provider.
      </p>
      <div className="prov-layout">
        <nav className="prov-list" aria-label="Data providers">
          {groups.map((g) => (
            <div key={g.category}>
              <div className="prov-group">{CATEGORY_TITLES[g.category]}</div>
              {g.items.map((p) => {
                const status = providerStatus(p);
                return (
                  <button
                    key={p.id}
                    type="button"
                    className={`prov-item${p.id === selected?.id ? ' active' : ''}`}
                    onClick={() => setSelectedId(p.id)}
                  >
                    <span className="prov-item-name">{p.label}</span>
                    {p.id === defaultProvider && <Star size={12} className="default-star" aria-label="Default provider" />}
                    <span className={`pill ${status.tone}`}>{status.label}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        {selected && <ProviderDetail key={selected.id} provider={selected} isDefault={selected.id === defaultProvider} />}
      </div>
      <MarketDataSection />
    </Dialog>
  );
}

function ProviderDetail({ provider, isDefault }: { provider: ProviderInfo; isDefault: boolean }) {
  const toast = useToast();
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<null | 'save' | 'test' | 'clear' | 'toggle'>(null);
  const [test, setTest] = useState<TestResult | null>(null);

  const dirty = Object.keys(edits).length > 0;
  const hasFields = provider.fields.length > 0;
  const usable = provider.enabled && provider.configured;

  /** Only what the user typed: a blank secret means "keep what's saved". */
  function pendingValues(): Record<string, string> {
    const values: Record<string, string> = {};
    for (const f of provider.fields) {
      const typed = edits[f.key];
      if (typed === undefined) continue;
      if (f.secret && typed.trim() === '') continue;
      values[f.key] = typed;
    }
    return values;
  }

  /** Saves whatever the user has typed. */
  async function save(): Promise<void> {
    const values = pendingValues();
    if (Object.keys(values).length === 0) return;
    const result = await saveProviderConfig(provider.id, values);
    setEdits({});
    await refreshProviders();
    if (result.secretStorage === 'database') {
      toast("Saved — but your system keychain isn't available, so the token is stored unencrypted in the app's database.", 'error');
    } else if (result.secretStorage === 'keychain') {
      toast('Saved to your system keychain.', 'success');
    } else {
      toast('Saved.', 'success');
    }
  }

  async function run(kind: 'save' | 'test' | 'clear' | 'toggle', action: () => Promise<void>) {
    setBusy(kind);
    try {
      await action();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(null);
    }
  }

  const switchOn = (next: boolean) =>
    run('toggle', async () => {
      await setProviderEnabled(provider.id, next);
      await refreshProviders();
      if (next) refreshInstruments(provider.id);
    });

  const onSave = () =>
    run('save', async () => {
      const wasConfigured = provider.configured;
      await save();
      // First time it's fully set up, switch it on: that's what saving credentials means.
      const now = getProviderState().providers.find((p) => p.id === provider.id);
      if (now && !wasConfigured && now.configured && !now.enabled && now.canDisable) {
        await setProviderEnabled(provider.id, true);
        await refreshProviders();
        refreshInstruments(provider.id);
      }
    });

  /** After a Zerodha login the token is saved and the provider may now be complete. */
  const afterLogin = async () => {
    await refreshProviders();
    const now = getProviderState().providers.find((p) => p.id === provider.id);
    if (now && now.configured && !now.enabled && now.canDisable) {
      await setProviderEnabled(provider.id, true);
      await refreshProviders();
      refreshInstruments(provider.id);
    }
  };

  const onTest = () =>
    run('test', async () => {
      setTest(null);
      if (dirty) await save();
      setTest(await testProvider(provider.id));
    });

  const onClear = () =>
    run('clear', async () => {
      if (!(await confirmDelete(`Forget the saved ${provider.label} credentials and switch it off?`))) return;
      await clearProviderConfig(provider.id);
      setEdits({});
      setTest(null);
      await refreshProviders();
    });

  const canBeDefault = provider.capabilities.search && usable;

  return (
    <section className="prov-detail" aria-label={provider.label}>
      <div className="prov-title">
        <h3>{provider.label}</h3>
        {isDefault && <span className="pill ok">Default</span>}
      </div>
      <p className="secondary prov-description">{provider.description}</p>

      {provider.docsUrl && (
        <p className="small" style={{ margin: '0 0 12px' }}>
          <a href={provider.docsUrl}>Documentation</a>
        </p>
      )}

      <label className={`switch-row${!provider.canDisable || (!provider.configured && hasFields) ? ' disabled' : ''}`}>
        <input
          type="checkbox"
          checked={provider.enabled}
          disabled={!provider.canDisable || (!provider.configured && hasFields) || busy !== null}
          onChange={(e) => void switchOn(e.currentTarget.checked)}
        />
        <span>
          <strong>Use {provider.label}</strong>
          <span className="muted small">
            {!provider.canDisable
              ? ' Always on.'
              : !provider.configured && hasFields
                ? ' Enter your details below first.'
                : provider.enabled
                  ? ' Its symbols appear in search and its data is available to charts.'
                  : ' Off: hidden from search; charts saved with its symbols will say it is off.'}
          </span>
        </span>
      </label>

      {hasFields && (
        <div className="prov-fields">
          {provider.fields.map((f) => {
            const shown = revealed[f.key];
            const value = edits[f.key] ?? (f.secret ? '' : (f.value ?? ''));
            return (
              <div className="field" key={f.key}>
                <label htmlFor={`prov-${provider.id}-${f.key}`}>{f.label}</label>
                <div className="input-with-button">
                      <input
                        id={`prov-${provider.id}-${f.key}`}
                        type={f.secret && !shown ? 'password' : 'text'}
                        value={value}
                        placeholder={f.secret && f.isSet ? '•••••••• saved — type to replace' : f.placeholder}
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(e) => setEdits({ ...edits, [f.key]: e.currentTarget.value })}
                      />
                      {f.secret && (
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={shown ? `Hide ${f.label}` : `Show ${f.label}`}
                          onClick={() => setRevealed({ ...revealed, [f.key]: !shown })}
                        >
                          {shown ? <EyeOff size={14} /> : <Eye size={14} />}
                        </button>
                      )}
                    </div>
                <span className="field-hint">{f.help}</span>
              </div>
            );
          })}

          {provider.secretStorage && (
            <p className={`notice${provider.secretStorage === 'database' ? ' error' : ''}`}>
              {provider.secretStorage === 'keychain' ? (
                <>
                  <KeyRound size={12} style={{ verticalAlign: '-1px' }} /> Your credentials are stored in your system keychain,
                  not in the app&rsquo;s database.
                </>
              ) : (
                <>
                  <ShieldAlert size={12} style={{ verticalAlign: '-1px' }} /> Your system keychain isn&rsquo;t available here,
                  so these credentials are stored <strong>unencrypted</strong> in the app&rsquo;s database.
                </>
              )}
            </p>
          )}

          <div className="prov-actions">
            <button type="button" className="btn btn-primary" disabled={!dirty || busy !== null} onClick={() => void onSave()}>
              {busy === 'save' ? 'Saving…' : 'Save'}
            </button>
            <button type="button" className="btn" disabled={(!dirty && !provider.configured) || busy !== null} onClick={() => void onTest()}>
              {busy === 'test' ? 'Testing…' : 'Test connection'}
            </button>
            <span className="grow" />
            <button
              type="button"
              className="btn"
              // Anything saved can be forgotten — not only a complete setup. A Zerodha login that has
              // not happened yet leaves a key and secret with no access token, and a wrong pair has to
              // be clearable.
              disabled={(!provider.fields.some((f) => f.isSet) && !dirty) || busy !== null}
              onClick={() => void onClear()}
            >
              Forget credentials
            </button>
          </div>
        </div>
      )}

      {test && (
        <div className={`notice${test.ok ? '' : ' error'}`} role="status">
          <strong>{test.ok ? <Check size={12} style={{ verticalAlign: '-1px' }} /> : null} {test.message}</strong>
          {test.details.length > 0 && (
            <ul>
              {test.details.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {provider.id === 'zerodha' && <ZerodhaPanel provider={provider} onLoggedIn={afterLogin} />}

      {provider.capabilities.search && (
        <div className="prov-default">
          {isDefault ? (
            <span className="muted small">
              This is the default: a symbol typed without a provider (like <code>RELIANCE</code>) goes here.
            </span>
          ) : (
            <button
              type="button"
              className="btn"
              disabled={!canBeDefault}
              title={canBeDefault ? undefined : `Turn ${provider.label} on first`}
              onClick={() => void setDefaultProvider(provider.id as ProviderId)}
            >
              <Star size={13} /> Make default
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/** Zerodha's daily login, and its token, instrument-list and live-feed status.
 *
 *  Kite access tokens expire every morning, and the only way to get one is to
 *  log in on Zerodha's own page. That page redirects the browser to the URL
 *  registered on the user's Kite app with a one-time `request_token`; the user
 *  pastes that address here and the backend trades it for an access token. */
function ZerodhaPanel({ provider, onLoggedIn }: { provider: ProviderInfo; onLoggedIn: () => Promise<void> }) {
  const toast = useToast();
  const [status, setStatus] = useState<ZerodhaStatus | null>(null);
  const [feed, setFeed] = useState<FeedStatus | null>(null);
  const [working, setWorking] = useState<null | 'browser' | 'open' | 'login' | 'instruments'>(null);
  const [pasted, setPasted] = useState('');
  const [redirectUrl, setRedirectUrl] = useState('');

  const keysSaved = ['apiKey', 'apiSecret'].every((k) => provider.fields.find((f) => f.key === k)?.isSet);
  const hasToken = provider.fields.find((f) => f.key === 'accessToken')?.isSet ?? false;

  const load = useCallback(() => zerodhaStatus().then(setStatus).catch(() => {}), []);

  useEffect(() => {
    void zerodhaRedirectUrl()
      .then(setRedirectUrl)
      .catch(() => {});
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(load, 4000);
    const off = onZerodhaStatus(setFeed);
    return () => {
      window.clearInterval(timer);
      off();
    };
  }, [load]);

  if (!keysSaved) {
    return (
      <p className="notice" role="note">
        Save your API key and secret above, then log in from here. You need a Kite Connect app: create one at{' '}
        <a href="https://developers.kite.trade">developers.kite.trade</a>.
      </p>
    );
  }

  /** The whole login in one go: the backend opens Zerodha's page and catches
   *  the redirect, so there is nothing to copy. Waits as long as the user takes. */
  async function loginInBrowser() {
    setWorking('browser');
    try {
      await zerodhaLoginInBrowser();
      toast('Logged in to Zerodha.', 'success');
      await onLoggedIn();
      await load();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setWorking(null);
    }
  }

  async function copyRedirectUrl() {
    try {
      await navigator.clipboard.writeText(redirectUrl);
      toast('Redirect URL copied.', 'success');
    } catch {
      toast(`Copy it by hand: ${redirectUrl}`, 'error');
    }
  }

  async function openLogin() {
    setWorking('open');
    try {
      await openUrl(await zerodhaLoginUrl());
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setWorking(null);
    }
  }

  async function finishLogin() {
    setWorking('login');
    try {
      await zerodhaCompleteLogin(pasted);
      setPasted('');
      toast('Logged in to Zerodha.', 'success');
      await onLoggedIn();
      await load();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setWorking(null);
    }
  }

  async function updateInstruments() {
    setWorking('instruments');
    try {
      const r = await zerodhaUpdateInstruments();
      toast(`Instrument list updated (${r.count.toLocaleString()} instruments).`, 'success');
      await load();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setWorking(null);
    }
  }

  const expiry = describeKiteTokenExpiry(status?.tokenExpiresAt ?? null, Date.now());
  const feedState = feed ?? status?.feed;

  return (
    <div className="prov-status">
      <div className="prov-status-row">
        <div>
          <div className="label">Access token</div>
          <div className={hasToken && expiry.expired ? 'neg' : hasToken && expiry.soon ? 'warn-text' : undefined}>
            {hasToken ? expiry.text : 'Not logged in yet.'}
          </div>
        </div>
      </div>

      <div className="prov-login">
        <div className="label">{hasToken ? 'Log in again' : 'Log in'}</div>
        <p className="small" style={{ margin: '0 0 8px' }}>
          Zerodha signs you in for the day. The app opens its login page and takes the token from the browser when
          you're done — nothing to copy.
        </p>
        <button type="button" className="btn btn-primary" disabled={working !== null} onClick={() => void loginInBrowser()}>
          <ExternalLink size={13} /> {working === 'browser' ? 'Waiting for you to finish…' : 'Log in with Zerodha'}
        </button>
        <div className="field-hint" style={{ marginTop: 8 }}>
          For this, your Kite app's redirect URL must be exactly <code>{redirectUrl || '…'}</code>{' '}
          <button type="button" className="btn btn-tiny" disabled={!redirectUrl} onClick={() => void copyRedirectUrl()}>
            <Copy size={11} /> Copy
          </button>{' '}
          — set it on your app at <a href="https://developers.kite.trade">developers.kite.trade</a>.
        </div>

        <details className="prov-manual">
          <summary className="small">Redirect URL set to something else? Paste the address instead</summary>
          <ol className="small">
            <li>
              <button type="button" className="btn" disabled={working !== null} onClick={() => void openLogin()}>
                <ExternalLink size={13} /> {working === 'open' ? 'Opening…' : 'Open Zerodha login'}
              </button>{' '}
              and sign in.
            </li>
            <li>
              Zerodha then sends your browser to the redirect URL of your Kite app. Copy that whole address from the
              address bar (it contains <code>request_token=…</code>) and paste it here.
            </li>
          </ol>
          <div className="input-with-button">
          <input
            type="text"
            value={pasted}
            placeholder="http://127.0.0.1/?request_token=…&action=login&status=success"
            aria-label="Address Zerodha redirected to"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setPasted(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && pasted.trim() && working === null) void finishLogin();
            }}
          />
          <button
            type="button"
            className="btn btn-primary"
            disabled={!pasted.trim() || working !== null}
            onClick={() => void finishLogin()}
          >
            {working === 'login' ? 'Logging in…' : 'Finish login'}
          </button>
        </div>
          <span className="field-hint">
            Each request token works once and only for a few minutes, so paste it straight away.
          </span>
        </details>
      </div>

      <div className="prov-status-row">
        <div>
          <div className="label">Instrument list (for symbol search)</div>
          <div>
            {status && status.instrumentCount > 0
              ? `${status.instrumentCount.toLocaleString()} instruments · updated ${formatDate(status.instrumentsUpdatedAt)}`
              : 'Not downloaded yet'}
          </div>
        </div>
        <button type="button" className="btn" disabled={working !== null} onClick={() => void updateInstruments()}>
          <RefreshCw size={13} />{' '}
          {working === 'instruments' ? 'Downloading…' : status && status.instrumentCount > 0 ? 'Update' : 'Download'}
        </button>
      </div>

      <div className="prov-status-row">
        <div>
          <div className="label">Live feed</div>
          <div className={feedState?.state === 'error' ? 'neg' : undefined}>
            {provider.enabled && feedState ? FEED_LABELS[feedState.state] : 'Off'}
            {provider.enabled && feedState?.message ? ` — ${feedState.message}` : ''}
          </div>
        </div>
      </div>
    </div>
  );
}
