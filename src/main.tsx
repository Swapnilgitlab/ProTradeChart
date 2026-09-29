import React from 'react';
import ReactDOM from 'react-dom/client';
import { attachConsole } from '@tauri-apps/plugin-log';
import { App } from './App';
import { installAlertActions } from './chart/alertActions';
import { installWatchlistActions } from './chart/watchlistActions';
import { installExternalLinkHandler } from './lib/externalLinks';
import { installPineEngine } from './pine/engine';
import { installPineHostActions } from './pine/hostActions';
import { installPinePersistence } from './pine/persistence';
import './styles/tokens.css';
import './styles/app.css';
import './styles/pine.css';
import './styles/python.css';
import './styles/studies.css';
import './styles/screener.css';
import './styles/help.css';
import './styles/home.css';

// Route webview console output into the app's log file, so a bug report can
// include what the frontend saw.
void attachConsole();
installExternalLinkHandler();
// Vela reads these registries when a workspace is constructed, so they go in first.
installPineEngine();
installPinePersistence();
installPineHostActions();
installAlertActions();
installWatchlistActions();

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
