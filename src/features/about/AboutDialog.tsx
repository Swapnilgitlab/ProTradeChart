import { useEffect, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { getAppInfo, type AppInfo } from '../../lib/ipc';
import { UpdatesSection } from './UpdatesSection';

interface Props {
  onClose: () => void;
}

const SHORTCUTS: [string, string][] = [
  ['Ctrl + T', 'New chart tab'],
  ['Ctrl + W', 'Close the current tab'],
  ['Ctrl + PageUp / PageDown', 'Previous / next tab'],
  ['Ctrl + K', 'Search for a symbol'],
  ['Ctrl + E', 'Show or hide the Pine Editor and Strategy Tester'],
  ['Ctrl + Shift + N', 'New window'],
  ['↑ / ↓ (in the watchlist)', 'Step through symbols'],
  ['? (on a chart)', "Vela's own shortcut list"],
];

export function AboutDialog({ onClose }: Props) {
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    getAppInfo().then(setInfo).catch(() => {});
  }, []);

  return (
    <Dialog title="About" onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Close</button>}>
      <div className="about-brand">
        <img src="/favicon-128.png" alt="" />
        <div>
          <h3>ProTradeChart</h3>
          <span className="muted">Free, open-source desktop charting</span>
        </div>
      </div>

      <dl className="about-list about-links">
        <dt>Version</dt>
        <dd>{info?.version ?? '…'}</dd>
        <dt>License</dt>
        <dd>GNU AGPL-3.0 (free software, no warranty)</dd>
        <dt>Developer</dt>
        <dd>Swapnil Pawar, ProTradeJournal</dd>
        <dt>Profiles</dt>
        <dd>
          <a href="https://x.com/swapnilpawar_">X: @swapnilpawar_</a>
          {' · '}
          <a href="https://github.com/Swapnilgitlab">GitHub: Swapnilgitlab</a>
        </dd>
        <dt>Your data</dt>
        <dd>{info?.dataDir ?? '…'}</dd>
      </dl>

      <UpdatesSection />

      <div className="section-title">Shortcuts</div>
      <dl className="about-list">
        {SHORTCUTS.map(([keys, action]) => (
          <div key={keys} style={{ display: 'contents' }}>
            <dt>
              <kbd>{keys}</kbd>
            </dt>
            <dd>{action}</dd>
          </div>
        ))}
      </dl>

      <div className="section-title">Credits</div>
      <p className="secondary about-links" style={{ marginTop: 0 }}>
        Charts are rendered by <a href="https://luxalgo.com/vela">Vela™</a>, an open-source charting library by LuxAlgo
        (Apache-2.0). The desktop shell is built with <a href="https://tauri.app">Tauri</a>.
      </p>
      <p className="secondary about-links">
        Pine Script support is powered by <a href="https://github.com/LuxAlgo/PineTS">PineTS</a> and Vela PineTS, built by
        LuxAlgo (AGPL-3.0). The script editor is <a href="https://codemirror.net">CodeMirror</a>. Pine Script® and TradingView®
        are registered trademarks of TradingView, Inc.; this app is not affiliated with, or endorsed by, TradingView.
      </p>
      <p className="notice">
        Market data comes from Yahoo Finance's public endpoints (which may be delayed or change without notice), from
        Binance, Coinbase and Hyperliquid for crypto, and from Dhan or Zerodha if you connect your own account. It is provided for
        information only and is not financial advice.
      </p>
    </Dialog>
  );
}
