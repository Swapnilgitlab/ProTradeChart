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
      </p>
      <p className="notice">
        Market data comes from the sources you turn on: Binance, Coinbase and Hyperliquid for crypto, and Dhan or Zerodha
        with your own account. Prices can be delayed or wrong. Everything here is for information only and is not
        financial advice.
      </p>
    </Dialog>
  );
}
