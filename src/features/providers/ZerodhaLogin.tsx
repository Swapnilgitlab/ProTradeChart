import { useEffect, useState } from 'react';
import { ExternalLink, KeyRound } from 'lucide-react';
import { Dialog } from '../../components/Dialog';
import { useToast } from '../../components/Toasts';
import { errorMessage } from '../../lib/ipc';
import { shouldPromptLogin, type ZerodhaSessionState } from '../../lib/zerodhaSession';
import { useZerodhaSession } from './useZerodhaSession';

const STATE_CLASS: Partial<Record<ZerodhaSessionState, string>> = { expired: 'neg', expiring: 'warn-text' };

/** Runs the browser login, saying how it went. `working` covers the whole wait: Zerodha's page stays
 *  open for as long as the user takes. */
function useLoginAction(login: () => Promise<void>, onDone?: () => void) {
  const toast = useToast();
  const [working, setWorking] = useState(false);
  const run = async () => {
    setWorking(true);
    try {
      await login();
      toast('Logged in to Zerodha.', 'success');
      onDone?.();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setWorking(false);
    }
  };
  return { working, run };
}

/** The Home tab's Zerodha card: where the day's login stands, and the button to log in. */
export function ZerodhaHomeCard({ onOpenDataProviders }: { onOpenDataProviders: () => void }) {
  const { session, login } = useZerodhaSession();
  const { working, run } = useLoginAction(login);
  if (!session) return null;

  const needsSetup = session.state === 'no-keys';
  const loggedIn = session.state === 'active' || session.state === 'expiring';
  return (
    <section className="home-section">
      <h2>Zerodha</h2>
      <div className={`home-zerodha${loggedIn ? '' : ' attention'}`}>
        <KeyRound size={18} aria-hidden="true" />
        <div className="home-zerodha-text">
          <span className="home-card-title">{loggedIn ? 'Logged in' : needsSetup ? 'Not set up' : 'Log in for today'}</span>
          <span className={`home-card-description ${STATE_CLASS[session.state] ?? ''}`}>{session.text}</span>
        </div>
        <div className="home-zerodha-actions">
          {needsSetup ? (
            <button type="button" className="btn btn-primary" onClick={onOpenDataProviders}>
              Set up Zerodha
            </button>
          ) : (
            <>
              <button type="button" className="link-button small" onClick={onOpenDataProviders}>
                Other ways to log in
              </button>
              <button type="button" className={`btn${loggedIn ? '' : ' btn-primary'}`} disabled={working} onClick={() => void run()}>
                <ExternalLink size={13} /> {working ? 'Waiting for you to finish…' : loggedIn ? 'Log in again' : 'Log in with Zerodha'}
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/** Asked once, as the main window opens, when the Zerodha login in use has expired overnight. */
export function ZerodhaLoginPrompt({ onOpenDataProviders }: { onOpenDataProviders: () => void }) {
  const { facts, session, login } = useZerodhaSession();
  // Decided on the first full answer only: the prompt never appears later in the session.
  const [open, setOpen] = useState<boolean | null>(null);
  useEffect(() => {
    if (open === null && facts) setOpen(shouldPromptLogin(facts, Date.now()));
  }, [facts, open]);
  const close = () => setOpen(false);
  const { working, run } = useLoginAction(login, close);

  if (!open) return null;
  return (
    <Dialog
      title="Log in to Zerodha"
      onClose={close}
      footer={
        <>
          <button type="button" className="btn" onClick={close}>
            Not now
          </button>
          <button type="button" className="btn btn-primary" disabled={working} onClick={() => void run()}>
            <ExternalLink size={13} /> {working ? 'Waiting for you to finish…' : 'Log in with Zerodha'}
          </button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>
        Your Zerodha session has expired. Kite logins last one day and reset around 6 AM, so Indian market charts,
        watchlist prices and alerts won't load until you log in again.
      </p>
      {session && <p className="neg small">{session.text}</p>}
      <p className="small muted" style={{ marginBottom: 0 }}>
        The app opens Zerodha's login page and takes the token from the browser when you're done. Kite app redirecting
        somewhere else?{' '}
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
