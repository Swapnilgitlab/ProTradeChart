import { useEffect, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { getAppInfo, type AppInfo } from '../../lib/ipc';
import { LicenseTextDialog } from './LicenseTextDialog';
import { UpdatesSection } from './UpdatesSection';
import { SHORTCUTS } from '../../help/topics';

/** Where the complete source of every release is published (the AGPL asks that users can find it). */
const SOURCE_URL = 'https://github.com/Swapnilgitlab/ProTradeChart';

/** The licence files the app carries (the installers have copies too). Loaded on demand:
 *  the third-party list is close to a megabyte. */
const LICENSE_FILES = {
  agpl: {
    title: 'GNU Affero General Public License v3.0',
    load: () => import('../../../LICENSE?raw').then((m) => m.default),
  },
  thirdParty: {
    title: 'Third-party licences',
    load: () => import('../../../THIRD_PARTY_LICENSES.txt?raw').then((m) => m.default),
  },
  // Vela's NOTICE (Apache-2.0 section 4(d)), the statement that the app ships a modified Vela
  // (section 4(b)) and the AGPL section 7(b) attribution term all live in this file.
  notices: {
    title: 'Third-party notices',
    load: () => import('../../../THIRD_PARTY_NOTICES.md?raw').then((m) => m.default),
  },
} as const;

interface Props {
  onClose: () => void;
}


export function AboutDialog({ onClose }: Props) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  /** A licence being read, shown in place of this dialog rather than stacked on it. */
  const [reading, setReading] = useState<keyof typeof LICENSE_FILES | null>(null);

  useEffect(() => {
    getAppInfo().then(setInfo).catch(() => {});
  }, []);

  if (reading) {
    const file = LICENSE_FILES[reading];
    return <LicenseTextDialog title={file.title} load={file.load} onClose={() => setReading(null)} />;
  }

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
        <dt>Licence</dt>
        <dd>
          GNU AGPL-3.0, free software with no warranty ·{' '}
          <button type="button" className="link-button" onClick={() => setReading('agpl')}>
            Read the licence
          </button>
        </dd>
        <dt>Source code</dt>
        <dd>
          <a href={SOURCE_URL}>github.com/Swapnilgitlab/ProTradeChart</a>
        </dd>
        <dt>Developer</dt>
        <dd>Swapnil Pawar</dd>
        <dt>Profiles</dt>
        <dd>
          <a href="https://x.com/swapnilpawar_">X: @swapnilpawar_</a>
          {' · '}
          <a href="https://github.com/Swapnilgitlab">GitHub: Swapnilgitlab</a>
        </dd>
        <dt>Your data</dt>
        <dd>{info?.dataDir ?? '…'}</dd>
      </dl>

      <UpdatesSection version={info?.version ?? null} />

      <div className="section-title">Credits</div>
      <p className="secondary about-links" style={{ marginTop: 0 }}>
        Charts are rendered by <a href="https://luxalgo.com/vela">Vela™</a>, an open-source charting library by LuxAlgo
        (Apache-2.0). ProTradeChart ships Vela with small changes of its own, to the price scale&rsquo;s padding and the chart
        menus, described in the third-party notices. The desktop shell is built with <a href="https://tauri.app">Tauri</a>.
      </p>
      <p className="secondary about-links">
        Pine Script support is powered by <a href="https://github.com/LuxAlgo/PineTS">PineTS</a> and Vela PineTS, built by
        LuxAlgo (AGPL-3.0). The script editor is <a href="https://codemirror.net">CodeMirror</a>. Pine Script® and TradingView®
        are registered trademarks of TradingView, Inc.; this app is not affiliated with, or endorsed by, TradingView.
      </p>
      <p className="secondary">
        It is also built on React, SQLite, Lucide icons and some 550 other open-source packages and crates. Each one&rsquo;s
        copyright notice and licence is under Third-party licences, below.
      </p>
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

      <div className="section-title">Legal</div>
      <p className="secondary" style={{ marginTop: 0 }}>
        Copyright &copy; 2026 Swapnil Pawar and the ProTradeChart contributors.
      </p>
      <p className="secondary">
        ProTradeChart is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General
        Public License, version 3, as published by the Free Software Foundation. It is distributed in the hope that it will
        be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR
        PURPOSE. See the licence for details. The complete source code of every release, and of the AGPL components it is
        built on, is published with the release in the project&rsquo;s repository.
      </p>
      <p className="secondary">
        <button type="button" className="link-button" onClick={() => setReading('agpl')}>
          Read the licence
        </button>
        {' · '}
        <button type="button" className="link-button" onClick={() => setReading('thirdParty')}>
          Third-party licences
        </button>
        {' · '}
        <button type="button" className="link-button" onClick={() => setReading('notices')}>
          Third-party notices
        </button>
      </p>
      <p className="secondary">
        Zerodha, Kite and Kite Connect, FYERS, NSE, BSE, MCX, Claude, Anthropic, GPT, OpenAI and Python are trademarks of their
        respective owners. They are named only to say which services the app connects to; ProTradeChart is not affiliated
        with, sponsored by or endorsed by any of them.
      </p>

      <div className="section-title">Market data: use and storage</div>
      <div className="notice">
        <ul>
          <li>
            <strong>Whose data it is.</strong> Prices come from the exchanges (NSE, BSE, MCX and others) through your own
            broker account and API app (Zerodha Kite Connect or FYERS), or from files you import. Broker data is licensed to
            you, for your own use, under your broker&rsquo;s API terms and the exchanges&rsquo; rules. ProTradeChart supplies
            no data and holds no data licence.
          </li>
          <li>
            <strong>Keep it to yourself.</strong> Don&rsquo;t publish, share, sell or show it to the public (on a stream or
            a website, or by passing on this app&rsquo;s data folder or prices exported from it), and don&rsquo;t use it
            for mock trading or games, which Kite&rsquo;s terms forbid. FYERS&rsquo;s API terms also restrict using its
            data for charting or technical tools and keeping copies of it without FYERS&rsquo;s written consent: read them
            before connecting FYERS.
          </li>
          <li>
            <strong>Never saved on this computer.</strong> The brokers&rsquo; terms restrict copies of their data, so
            broker prices are held only in memory while the app is open (the charts&rsquo; recent bars, what scripts,
            the Screener and Studies read, and the whole market if you keep it loaded) and are gone when it
            closes. What the data folder above keeps is your own: layouts, watchlists, alerts, scripts, imported files,
            and the results of the screens and Studies you ran. None of it is sent to this project or anyone else. AI
            features send your question, symbols, watchlist names and a Study&rsquo;s summary statistics, never price
            history.
          </li>
          <li>
            <strong>No advice.</strong> Prices can be delayed, incomplete or wrong. ProTradeChart is not a broker or a
            SEBI-registered investment adviser and places no orders; nothing in it is financial advice. Following your
            broker&rsquo;s terms and the rules that apply to you is your responsibility.
          </li>
        </ul>
      </div>
    </Dialog>
  );
}
