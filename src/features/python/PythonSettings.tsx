import { useCallback, useEffect, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { confirmDelete } from '../../lib/dialogs';
import {
  clearPythonResearchData,
  errorMessage,
  pythonResearchStats,
  pythonSetInterpreter,
  revealPythonFolder,
  type PythonEnvStatus,
  type ResearchStats,
} from '../../lib/ipc';

interface Props {
  env: PythonEnvStatus | null;
  onEnvChanged: (status: PythonEnvStatus) => void;
  /** Reports what happened (or went wrong) where the person is already looking: the console. */
  say: (level: 'info' | 'error', text: string) => void;
}

/** Which Python runs scripts, where they live, and the market data they have caused the
 *  app to keep. Everything here changes only when the person presses a button. The parent
 *  closes it on an outside click, so the button that opens it counts as inside. */
export function PythonSettings({ env, onEnvChanged, say }: Props) {
  const [path, setPath] = useState(env?.custom ? (env.python ?? '') : '');
  const [busy, setBusy] = useState(false);
  const [stats, setStats] = useState<ResearchStats | null>(null);

  const loadStats = useCallback(() => {
    pythonResearchStats()
      .then(setStats)
      .catch(() => setStats(null));
  }, []);
  useEffect(loadStats, [loadStats]);

  const choose = async (next: string | null) => {
    setBusy(true);
    try {
      const status = await pythonSetInterpreter(next);
      onEnvChanged(status);
      say('info', next ? `Scripts will run with ${next}.` : "Scripts will run in the app's own Python environment.");
      if (!next) setPath('');
    } catch (err) {
      say('error', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const clearData = async () => {
    if (!stats) return;
    if (!(await confirmDelete(`Clear the ${stats.bars.toLocaleString()} bars held in memory? The next run fetches from your broker again.`))) return;
    try {
      const removed = await clearPythonResearchData();
      say('info', `Cleared ${removed.toLocaleString()} bars from memory.`);
      loadStats();
    } catch (err) {
      say('error', errorMessage(err));
    }
  };

  return (
    <div className="python-settings" role="dialog" aria-label="Python settings">
      <div className="python-settings-section">
        <div className="menu-heading">Python</div>
        <div className="small">
          {env?.python ? (
            <>
              <span className="python-path">{env.python}</span>
              {env.version && <span className="muted"> · {env.version}</span>}
              <div className="muted">{env.custom ? 'Your own interpreter.' : "The app's own environment."}</div>
            </>
          ) : (
            <span className="muted">No Python found yet.</span>
          )}
        </div>
        <label className="python-field small" htmlFor="python-interpreter">
          Use a different Python (a conda or uv environment, say)
        </label>
        <div className="python-field-row">
          <input
            id="python-interpreter"
            className="python-input"
            value={path}
            placeholder="Path to python.exe"
            spellCheck={false}
            onChange={(e) => setPath(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && path.trim()) void choose(path.trim());
            }}
          />
          <button type="button" className="btn pine-btn" disabled={busy || !path.trim()} onClick={() => void choose(path.trim())}>
            Use
          </button>
        </div>
        {env?.custom && (
          <button type="button" className="btn pine-btn" disabled={busy} onClick={() => void choose(null)}>
            Go back to the app&apos;s environment
          </button>
        )}
      </div>

      <div className="python-settings-section">
        <div className="menu-heading">Scripts</div>
        <button
          type="button"
          className="btn pine-btn"
          onClick={() => revealPythonFolder().catch((err) => say('error', errorMessage(err)))}
        >
          <FolderOpen size={14} />
          Open the scripts folder
        </button>
        <div className="muted small">They are plain .py files: edit them in any editor, and keep them in git.</div>
      </div>

      <div className="python-settings-section">
        <div className="menu-heading">Market data in memory</div>
        <div className="small">
          {stats ? `${stats.bars.toLocaleString()} bars across ${stats.series.toLocaleString()} series.` : 'Not available.'}
        </div>
        <div className="muted small">
          Held while the app is open, so a screen over many symbols only asks your broker for what is new. Never saved on this
          computer: it is cleared when the app closes.
        </div>
        <button type="button" className="btn pine-btn" disabled={!stats || stats.bars === 0} onClick={() => void clearData()}>
          Clear it
        </button>
      </div>
    </div>
  );
}
