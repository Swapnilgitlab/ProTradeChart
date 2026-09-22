import { useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { useToast } from '../../components/Toasts';
import { ensureProvidersLoaded, getProviderState, refreshProviders } from '../../data/providerStatus';
import { errorMessage, getPreference, setPreference, setProviderEnabled } from '../../lib/ipc';
import { TermsNotice } from './TermsNotice';
import { useProviderState } from './useProviderState';

/** Set once the user has answered (or dismissed) the question below. */
const PREF_KEY = 'market_data_intro_seen';

/** Whether to ask, at startup, which market data to use: once, and only while
 *  Yahoo Finance is still off. */
export async function needsMarketDataIntro(): Promise<boolean> {
  const [, seen] = await Promise.all([ensureProvidersLoaded(), getPreference(PREF_KEY)]);
  if (seen === '1') return false;
  const yahoo = getProviderState().providers.find((p) => p.id === 'yahoo');
  return !!yahoo && !yahoo.enabled;
}

/** The first-run question. Yahoo Finance comes under Yahoo's own terms, so it
 *  starts off and the user turns it on here, having read them — or doesn't,
 *  and starts with crypto. Closing the dialog counts as "not now". */
export function MarketDataIntro({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const { providers } = useProviderState();
  const yahoo = providers.find((p) => p.id === 'yahoo');
  const [busy, setBusy] = useState(false);

  async function finish(useYahoo: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      if (useYahoo) {
        await setProviderEnabled('yahoo', true);
        await refreshProviders();
      }
      await setPreference(PREF_KEY, '1');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
    onDone();
  }

  return (
    <Dialog
      title="Where prices come from"
      onClose={() => void finish(false)}
      footer={
        <>
          <button type="button" className="btn" disabled={busy} onClick={() => void finish(false)}>
            Not now
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || !yahoo} onClick={() => void finish(true)}>
            Turn on Yahoo Finance
          </button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>
        ProTradeChart has no market data of its own. Charts load from the sources you choose, straight from this computer.
      </p>
      <p>
        Crypto from Binance, Coinbase and Hyperliquid works right away. For stocks, ETFs, indices, FX and futures you can
        turn on Yahoo Finance, or connect your own Dhan or Zerodha account under <strong>Data providers</strong>.
      </p>
      {yahoo && <TermsNotice provider={yahoo} />}
      <p className="muted small" style={{ marginBottom: 0 }}>
        You can change this at any time under Data providers (the plug icon in the tab bar).
      </p>
    </Dialog>
  );
}
