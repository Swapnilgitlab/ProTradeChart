import { useEffect, useState } from 'react';
import { ExternalLink, KeyRound } from 'lucide-react';
import { Dialog } from '../../components/Dialog';
import { useToast } from '../../components/Toasts';
import { errorMessage } from '../../lib/ipc';
import { brokerName, shouldPromptLogin, type BrokerSessionState } from '../../lib/brokerSession';
import type { BrokerId } from '../../lib/symbols';
import { useBrokerSession } from './useBrokerSession';
import { useProviderState } from './useProviderState';

const STATE_CLASS: Partial<Record<BrokerSessionState, string>> = { expired: 'neg', expiring: 'warn-text' };

/** When each broker's logins reset, for the prompt. */
const RESETS: Record<BrokerId, string> = {
  zerodha: 'Kite logins last one day and reset around 6 AM',
  fyers: 'FYERS logins last one day and reset at 6:30 AM',
};

/** Runs the browser login, saying how it went. `working` covers the whole wait: the broker's page stays
 *  open for as long as the user takes. */
function useLoginAction(broker: BrokerId, login: () => Promise<void>, onDone?: () => void) {
  const toast = useToast();
  const [working, setWorking] = useState(false);
  const run = async () => {
    setWorking(true);
    try {
      await login();
      toast(`Logged in to ${brokerName(broker)}.`, 'success');
      onDone?.();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setWorking(false);
    }
  };
  return { working, run };
}

/** The Home tab's broker card: where the day's login with the broker serving Indian market data stands,
 *  and the button to log in. */
export function BrokerHomeCard({ onOpenDataProviders }: { onOpenDataProviders: () => void }) {
  const { indiaBroker: broker } = useProviderState();
  const { session, login } = useBrokerSession(broker);
  const { working, run } = useLoginAction(broker, login);
  if (!session) return null;

  const name = brokerName(broker);
  const needsSetup = session.state === 'no-keys';
  const loggedIn = session.state === 'active' || session.state === 'expiring' || session.state === 'renewing';
  return (
    <section className="home-section">
      <h2>{name}</h2>
      <div className={`home-broker${loggedIn ? '' : ' attention'}`}>
        <KeyRound size={18} aria-hidden="true" />
        <div className="home-broker-text">
          <span className="home-card-title">{loggedIn ? 'Logged in' : needsSetup ? 'Not set up' : 'Log in for today'}</span>
          <span className={`home-card-description ${STATE_CLASS[session.state] ?? ''}`}>{session.text}</span>
        </div>
        <div className="home-broker-actions">
          {needsSetup ? (
            <button type="button" className="btn btn-primary" onClick={onOpenDataProviders}>
              Set up {name}
            </button>
          ) : (
            <>
              <button type="button" className="link-button small" onClick={onOpenDataProviders}>
                Other ways to log in
              </button>
              <button type="button" className={`btn${loggedIn ? '' : ' btn-primary'}`} disabled={working} onClick={() => void run()}>
                <ExternalLink size={13} /> {working ? 'Waiting for you to finish…' : loggedIn ? 'Log in again' : `Log in with ${name}`}
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/** Asked once, as the main window opens, when the login with the broker serving Indian market data
 *  has expired overnight (and won't renew by itself). */
export function BrokerLoginPrompt({ onOpenDataProviders }: { onOpenDataProviders: () => void }) {
  const { indiaBroker: broker, loaded } = useProviderState();
  const { facts, session, login } = useBrokerSession(broker);
  // Decided on the first full answer only: the prompt never appears later in the session.
  const [open, setOpen] = useState<boolean | null>(null);
  useEffect(() => {
    if (open === null && loaded && facts) setOpen(shouldPromptLogin(broker, facts, Date.now()));
  }, [broker, facts, loaded, open]);
  const close = () => setOpen(false);
  const { working, run } = useLoginAction(broker, login, close);

  if (!open) return null;
  const name = brokerName(broker);
  return (
    <Dialog
      title={`Log in to ${name}`}
      onClose={close}
      footer={
        <>
          <button type="button" className="btn" onClick={close}>
            Not now
          </button>
          <button type="button" className="btn btn-primary" disabled={working} onClick={() => void run()}>
            <ExternalLink size={13} /> {working ? 'Waiting for you to finish…' : `Log in with ${name}`}
          </button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>
        Your {name} session has expired. {RESETS[broker]}, so Indian market charts, watchlist prices and alerts won't load
        until you log in again.
      </p>
      {session && <p className="neg small">{session.text}</p>}
      <p className="small muted" style={{ marginBottom: 0 }}>
        The app opens {name}'s login page and takes the token from the browser when you're done. App redirecting somewhere
        else?{' '}
        <button
          type="button"
          className="link-button"
          onClick={() => {
            close();
            onOpenDataProviders();
          }}
        >
          Log in from Data providers
        </button>
        .
      </p>
    </Dialog>
  );
}
