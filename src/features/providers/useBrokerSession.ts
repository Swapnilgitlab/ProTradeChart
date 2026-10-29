import { useCallback, useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getProviderState, refreshProviders } from '../../data/providerStatus';
import {
  fyersLoginInBrowser,
  fyersStatus,
  fyersUpdateInstruments,
  setProviderEnabled,
  zerodhaLoginInBrowser,
  zerodhaStatus,
  zerodhaUpdateInstruments,
} from '../../lib/ipc';
import { brokerSession, type BrokerSession, type BrokerSessionFacts } from '../../lib/brokerSession';
import type { BrokerId } from '../../lib/symbols';
import { useProviderState } from './useProviderState';

/** How long FYERS's refresh token is taken to last (its community forum says 15 days). */
const FYERS_REFRESH_DAYS = 15;

/** Downloads a broker's instrument list in the background, so symbol search works as soon as it is
 *  switched on. Providers without one do nothing. */
export function refreshInstruments(providerId: string): void {
  if (providerId === 'zerodha') zerodhaUpdateInstruments().catch(() => {});
  if (providerId === 'fyers') fyersUpdateInstruments().catch(() => {});
}

/** After a login the token is saved and the provider may now be complete: the first time it is,
 *  switch it on and fetch its instrument list, as saving the last missing credential would. */
export async function afterBrokerLogin(providerId: string): Promise<void> {
  await refreshProviders();
  const now = getProviderState().providers.find((p) => p.id === providerId);
  if (now && now.configured && !now.enabled && now.canDisable) {
    await setProviderEnabled(providerId, true);
    await refreshProviders();
    refreshInstruments(providerId);
  }
}

/** The keys a broker's app needs before a login can start. */
const KEY_FIELDS: Record<BrokerId, [string, string]> = {
  zerodha: ['apiKey', 'apiSecret'],
  fyers: ['appId', 'appSecret'],
};

interface SessionStatus {
  tokenExpiresAt: number | null;
  renewsUntil: number | null;
}

const loadStatus: Record<BrokerId, () => Promise<SessionStatus>> = {
  zerodha: () => zerodhaStatus().then((s) => ({ tokenExpiresAt: s.tokenExpiresAt, renewsUntil: null })),
  fyers: () =>
    fyersStatus().then((s) => ({
      tokenExpiresAt: s.tokenExpiresAt,
      renewsUntil: s.pinSaved && s.refreshSavedAt !== null ? s.refreshSavedAt + FYERS_REFRESH_DAYS * 86_400_000 : null,
    })),
};

const loginInBrowser: Record<BrokerId, () => Promise<unknown>> = {
  zerodha: zerodhaLoginInBrowser,
  fyers: fyersLoginInBrowser,
};

/** A broker's once-a-day login, for anything outside the Data providers dialog. `login` opens the
 *  broker's page and waits for the browser to come back, as **Log in with …** does there. */
export function useBrokerSession(broker: BrokerId): {
  /** `null` until both the provider list and the broker's status have loaded. */
  facts: BrokerSessionFacts | null;
  session: BrokerSession | null;
  login: () => Promise<void>;
  reload: () => Promise<void>;
} {
  const { providers, loaded } = useProviderState();
  const [status, setStatus] = useState<{ broker: BrokerId; value: SessionStatus } | null>(null);

  const reload = useCallback(
    () =>
      loadStatus[broker]()
        .then((value) => setStatus({ broker, value }))
        .catch(() => {}),
    [broker],
  );
  useEffect(() => {
    void reload();
  }, [reload]);
  // A FYERS renewal (or a refused one) happens in the backend, between any two requests.
  useEffect(() => {
    if (broker !== 'fyers') return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    void listen('fyers-session', () => void reload()).then((unlisten) => {
      if (cancelled) unlisten();
      else stop = unlisten;
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [broker, reload]);

  const provider = providers.find((p) => p.id === broker);
  const isSet = (key: string) => provider?.fields.find((f) => f.key === key)?.isSet ?? false;
  const current = status?.broker === broker ? status.value : null;
  const facts: BrokerSessionFacts | null =
    loaded && provider && current
      ? {
          keysSaved: KEY_FIELDS[broker].every(isSet),
          hasToken: isSet('accessToken'),
          enabled: provider.enabled,
          tokenExpiresAt: current.tokenExpiresAt,
          renewsUntil: current.renewsUntil,
        }
      : null;

  const login = useCallback(async () => {
    await loginInBrowser[broker]();
    await afterBrokerLogin(broker);
    await reload();
  }, [broker, reload]);

  return { facts, session: facts ? brokerSession(broker, facts, Date.now()) : null, login, reload };
}
