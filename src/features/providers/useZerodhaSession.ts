import { useCallback, useEffect, useState } from 'react';
import { getProviderState, refreshProviders } from '../../data/providerStatus';
import { setProviderEnabled, zerodhaLoginInBrowser, zerodhaStatus, zerodhaUpdateInstruments, type ZerodhaStatus } from '../../lib/ipc';
import { zerodhaSession, type ZerodhaSession, type ZerodhaSessionFacts } from '../../lib/zerodhaSession';
import { useProviderState } from './useProviderState';

/** After a login the token is saved and the provider may now be complete: the first time it is,
 *  switch it on and fetch its instrument list, as saving the last missing credential would. */
export async function afterBrokerLogin(providerId: string): Promise<void> {
  await refreshProviders();
  const now = getProviderState().providers.find((p) => p.id === providerId);
  if (now && now.configured && !now.enabled && now.canDisable) {
    await setProviderEnabled(providerId, true);
    await refreshProviders();
    if (providerId === 'zerodha') zerodhaUpdateInstruments().catch(() => {});
  }
}

/** Zerodha's once-a-day login, for anything outside the Data providers dialog. `login` opens Zerodha's
 *  page and waits for the browser to come back, as **Log in with Zerodha** does there. */
export function useZerodhaSession(): {
  /** `null` until both the provider list and Zerodha's status have loaded. */
  facts: ZerodhaSessionFacts | null;
  session: ZerodhaSession | null;
  login: () => Promise<void>;
  reload: () => Promise<void>;
} {
  const { providers, loaded } = useProviderState();
  const [status, setStatus] = useState<ZerodhaStatus | null>(null);

  const reload = useCallback(
    () =>
      zerodhaStatus()
        .then(setStatus)
        .catch(() => {}),
    [],
  );
  useEffect(() => {
    void reload();
  }, [reload]);

  const provider = providers.find((p) => p.id === 'zerodha');
  const isSet = (key: string) => provider?.fields.find((f) => f.key === key)?.isSet ?? false;
  const facts: ZerodhaSessionFacts | null =
    loaded && provider && status
      ? {
          keysSaved: isSet('apiKey') && isSet('apiSecret'),
          hasToken: isSet('accessToken'),
          enabled: provider.enabled,
          tokenExpiresAt: status.tokenExpiresAt,
        }
      : null;

  const login = useCallback(async () => {
    await zerodhaLoginInBrowser();
    await afterBrokerLogin('zerodha');
    await reload();
  }, [reload]);

  return { facts, session: facts ? zerodhaSession(facts, Date.now()) : null, login, reload };
}
