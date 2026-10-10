import { useEffect, useState, type ReactElement } from 'react';
import { getPreference, setPreference } from '../../lib/ipc';
import { updater } from '../../updates/service';
import { useUpdateState } from '../../updates/useUpdateState';
import { AUTO_UPDATE_PREFERENCE, autoCheckEnabled, progressPercent } from '../../updates/updater';

/** The About dialog's "Updates" block: check now, install what's found, and the switch for
 *  the daily background check. `version` is the installed one, once About has read it. */
export function UpdatesSection({ version }: { version: string | null }) {
  const state = useUpdateState();
  const [auto, setAuto] = useState(true);

  useEffect(() => {
    getPreference(AUTO_UPDATE_PREFERENCE)
      .then((value) => setAuto(autoCheckEnabled(value)))
      .catch(() => {});
  }, []);

  const toggleAuto = (on: boolean) => {
    setAuto(on);
    void setPreference(AUTO_UPDATE_PREFERENCE, on ? 'on' : 'off').catch(() => {});
  };

  let status: string;
  let action: ReactElement | null = null;
  switch (state.kind) {
    case 'checking':
      status = 'Checking for updates…';
      break;
    case 'current':
      status = version ? `You're up to date: ${version} is the latest version.` : "You're up to date.";
      action = <CheckButton label="Check again" />;
      break;
    case 'available':
      status = `ProTradeChart ${state.version} is available.`;
      action = (
        <button type="button" className="btn btn-primary" onClick={() => void updater.install()}>
          Download and install
        </button>
      );
      break;
    case 'downloading': {
      const percent = progressPercent(state.received, state.total);
      status = `Downloading ProTradeChart ${state.version}${percent === null ? '…' : `… ${percent}%`}`;
      break;
    }
    case 'installed':
      status = `ProTradeChart ${state.version} is installed. Restart to start using it.`;
      action = (
        <button type="button" className="btn btn-primary" onClick={() => void updater.restart()}>
          Restart now
        </button>
      );
      break;
    case 'error':
      status = state.message;
      action =
        state.during === 'install' ? (
          <button type="button" className="btn" onClick={() => void updater.install()}>
            Try again
          </button>
        ) : (
          <CheckButton label="Try again" />
        );
      break;
    default:
      status = 'ProTradeChart can check for a newer version.';
      action = <CheckButton label="Check for updates" />;
  }

  return (
    <>
      <div className="section-title">Updates</div>
      <div className="update-row">
        <span className={state.kind === 'error' ? 'update-status error' : 'update-status'} role="status">
          {status}
        </span>
        {action}
      </div>
      <label className="alert-sound">
        <input type="checkbox" checked={auto} onChange={(e) => toggleAuto(e.currentTarget.checked)} /> Check for updates
        automatically
      </label>
      <p className="secondary small">
        Checking asks GitHub for the latest release; nothing else is sent. A download is verified against a signing key built
        into the app before it is installed.
      </p>
    </>
  );
}

function CheckButton({ label }: { label: string }) {
  return (
    <button type="button" className="btn" onClick={() => void updater.check()}>
      {label}
    </button>
  );
}
