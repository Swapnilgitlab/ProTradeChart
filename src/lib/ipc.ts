import { invoke } from '@tauri-apps/api/core';

/** Typed wrappers over every Tauri command. Keeping all `invoke` calls in one
 *  file means the Rust ↔ TypeScript contract (see `src-tauri/src/models.rs`)
 *  lives in exactly one place on this side. */

// ---- Types (mirror src-tauri/src/models.rs; serialized as camelCase) -------

export interface RawBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

export interface ChartLayoutRow {
  id: string;
  name: string;
  stateJson: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export type PineScriptKind = 'indicator' | 'strategy';

export interface PineScriptRow {
  id: string;
  name: string;
  kind: PineScriptKind;
  source: string;
  createdAt: string;
  updatedAt: string;
}

export interface WatchlistSummary {
  id: number;
  name: string;
  createdAt: string;
  itemCount: number;
}

export interface WatchlistItem {
  id: number;
  /** Fully-qualified chart symbol, e.g. `binance:BTCUSDT`. */
  symbol: string;
  name: string | null;
}

export interface WatchlistDetail {
  id: number;
  name: string;
  createdAt: string;
  items: WatchlistItem[];
  /** Only present on the add-items response. */
  added?: number | null;
}

export interface NewWatchlistItem {
  symbol: string;
  name?: string | null;
}

export interface DatasetInfo {
  ticker: string;
  description: string | null;
  baseTf: string;
  barCount: number;
  firstTime: number | null;
  lastTime: number | null;
  createdAt: string;
}

export interface DatasetInput {
  ticker: string;
  description?: string | null;
  baseTf: string;
  bars: { time: number; open: number; high: number; low: number; close: number; volume?: number | null }[];
}

export interface DatasetBars {
  baseTf: string;
  bars: RawBar[];
}

export interface BarsResponse {
  bars: RawBar[];
  gmtOffset: number;
  timezone: string | null;
  fromCache: boolean;
}

export interface SymbolMatch {
  symbol: string;
  name: string | null;
  exchange: string | null;
  kind: string | null;
}

export interface Quote {
  symbol: string;
  price: number | null;
  previousClose: number | null;
  changePercent: number | null;
  currency: string | null;
  error: string | null;
}

export interface AppInfo {
  version: string;
  dataDir: string;
}

// ---- App & preferences -----------------------------------------------------

export const getAppInfo = () => invoke<AppInfo>('get_app_info');

export const getPreference = (key: string) => invoke<string | null>('get_ui_preference', { key });

export const setPreference = (key: string, value: string) => invoke<void>('set_ui_preference', { key, value });

/** Relaunches the app; used once an update has been installed. */
export const restartApp = () => invoke<void>('restart_app');

// ---- Layouts ---------------------------------------------------------------

export const getChartLayouts = () => invoke<ChartLayoutRow[]>('get_chart_layouts');

export const saveChartLayout = (layout: ChartLayoutRow) => invoke<void>('save_chart_layout', { layout });

export const deleteChartLayout = (id: string) => invoke<void>('delete_chart_layout', { id });

// ---- Pine scripts ----------------------------------------------------------

export const listPineScripts = () => invoke<PineScriptRow[]>('list_pine_scripts');

/** Upserts by id; the timestamps on `script` are ignored (the database sets them). */
export const savePineScript = (script: PineScriptRow) => invoke<void>('save_pine_script', { script });

export const deletePineScript = (id: string) => invoke<void>('delete_pine_script', { id });

// ---- Watchlists ------------------------------------------------------------

export const listWatchlists = () => invoke<WatchlistSummary[]>('list_watchlists');

export const getWatchlist = (id: number) => invoke<WatchlistDetail>('get_watchlist', { id });

export const createWatchlist = (name: string) => invoke<WatchlistDetail>('create_watchlist', { name });

export const renameWatchlist = (id: number, name: string) => invoke<void>('rename_watchlist', { id, name });

export const deleteWatchlist = (id: number) => invoke<void>('delete_watchlist', { id });

export const addWatchlistItems = (watchlistId: number, items: NewWatchlistItem[]) =>
  invoke<WatchlistDetail>('add_watchlist_items', { watchlistId, items });

export const removeWatchlistItems = (watchlistId: number, symbols: string[]) =>
  invoke<void>('remove_watchlist_items', { watchlistId, symbols });

// ---- Imported datasets -----------------------------------------------------

export const listDatasets = () => invoke<DatasetInfo[]>('list_datasets');

export const saveDataset = (input: DatasetInput) => invoke<DatasetInfo>('save_dataset', { input });

export const deleteDataset = (ticker: string) => invoke<void>('delete_dataset', { ticker });

export const getDatasetBars = (ticker: string, fromMs?: number, toMs?: number, limit?: number) =>
  invoke<DatasetBars | null>('get_dataset_bars', { ticker, fromMs, toMs, limit });

// ---- Symbol names ----------------------------------------------------------

/** Company names for `symbols` (`provider:TICKER`), keyed by symbol; a symbol with no known
 *  name is absent. Only the brokers' instrument lists carry names. */
export const getSymbolNames = (symbols: string[]) => invoke<Record<string, string>>('symbol_names', { symbols });

// ---- Data providers --------------------------------------------------------

export interface ProviderField {
  key: string;
  label: string;
  /** Write-only: the current value of a secret is never sent back. */
  secret: boolean;
  help: string;
  placeholder: string;
  /** The current value of a non-secret field. */
  value: string | null;
  isSet: boolean;
}

export interface ProviderCapabilities {
  history: boolean;
  live: boolean;
  search: boolean;
  quotes: boolean;
}

export interface ProviderInfo {
  id: string;
  label: string;
  description: string;
  /** `free` (no setup), `broker` (needs your own account) or `local`. */
  category: 'free' | 'broker' | 'local';
  fields: ProviderField[];
  enabled: boolean;
  configured: boolean;
  canDisable: boolean;
  capabilities: ProviderCapabilities;
  docsUrl: string | null;
  /** Where credentials are kept: the OS `keychain`, or (unencrypted) the `database`. */
  secretStorage: 'keychain' | 'database' | null;
}

export interface TestResult {
  ok: boolean;
  message: string;
  details: string[];
}

export interface FeedStatus {
  /** `idle`, `connecting`, `live`, `reconnecting` or `error`. */
  state: 'idle' | 'connecting' | 'live' | 'reconnecting' | 'error';
  message: string | null;
}

export interface DhanStatus {
  instrumentCount: number;
  instrumentsUpdatedAt: number | null;
  tokenExpiresAt: number | null;
  feed: FeedStatus;
}

export interface DhanTick {
  segment: number;
  securityId: number;
  ltp: number;
  ltt: number | null;
  volume: number | null;
}

export interface ZerodhaStatus {
  instrumentCount: number;
  instrumentsUpdatedAt: number | null;
  /** When the current access token was saved (epoch ms). */
  tokenSavedAt: number | null;
  /** When it most likely stops working, an estimate: the next 06:00 IST (epoch seconds). */
  tokenExpiresAt: number | null;
  feed: FeedStatus;
}

export interface ZerodhaTick {
  token: number;
  ltp: number;
  ltt: number | null;
  volume: number | null;
}

/** A price the user wants to hear about; see `src/alerts`. */
export interface PriceAlert {
  id: string;
  /** `provider:TICKER`, like a chart symbol. */
  symbol: string;
  /** `crossing_up`, `crossing_down` or `crossing` (either way). */
  condition: string;
  price: number;
  /** What a crossing is measured from until a newer price has been seen. */
  basePrice: number | null;
  message: string;
  /** `once` or `every`. */
  mode: string;
  /** `active`, `triggered` or `paused`. */
  status: string;
  createdAt: number;
  triggeredAt: number | null;
  triggerPrice: number | null;
  triggerCount: number;
}

export const listProviders = () => invoke<ProviderInfo[]>('list_providers');

export const saveProviderConfig = (provider: string, values: Record<string, string>) =>
  invoke<{ secretStorage: string | null }>('save_provider_config', { provider, values });

export const clearProviderConfig = (provider: string) => invoke<void>('clear_provider_config', { provider });

export const setProviderEnabled = (provider: string, enabled: boolean) =>
  invoke<void>('set_provider_enabled', { provider, enabled });

export const testProvider = (provider: string) => invoke<TestResult>('test_provider', { provider });

export const dhanStatus = () => invoke<DhanStatus>('dhan_status');

export const dhanUpdateInstruments = () => invoke<{ count: number; updatedAt: number }>('dhan_update_instruments');

export const dhanRenewToken = () => invoke<{ tokenExpiresAt: number | null }>('dhan_renew_token');

export const dhanSearchInstruments = (query: string, limit = 8) =>
  invoke<SymbolMatch[]>('dhan_search_instruments', { query, limit });

export const dhanFetchBars = (ticker: string, interval: string, fromMs?: number, toMs?: number) =>
  invoke<BarsResponse>('dhan_fetch_bars', { ticker, interval, fromMs, toMs });

export const dhanQuotes = (tickers: string[]) => invoke<Quote[]>('dhan_quotes', { tickers });

export const dhanSubscribe = (ticker: string) =>
  invoke<{ segment: number; securityId: number }>('dhan_subscribe', { ticker });

export const dhanUnsubscribe = (ticker: string) => invoke<void>('dhan_unsubscribe', { ticker });

export const zerodhaStatus = () => invoke<ZerodhaStatus>('zerodha_status');

export const zerodhaLoginUrl = () => invoke<string>('zerodha_login_url');

/** The redirect URL to register on the Kite app so the app can catch the login itself. */
export const zerodhaRedirectUrl = () => invoke<string>('zerodha_redirect_url');

/** Opens Zerodha's login page and waits for the browser to come back with a
 *  request token, then saves the day's access token. Rejects if the login is
 *  never finished, or the Kite app redirects somewhere else. */
export const zerodhaLoginInBrowser = () => invoke<{ tokenExpiresAt: number }>('zerodha_login_in_browser');

/** `pasted` is the address Zerodha redirected to after login, or just its request token. */
export const zerodhaCompleteLogin = (pasted: string) =>
  invoke<{ tokenExpiresAt: number }>('zerodha_complete_login', { pasted });

export const zerodhaUpdateInstruments = () =>
  invoke<{ count: number; updatedAt: number }>('zerodha_update_instruments');

export const zerodhaSearchInstruments = (query: string, limit = 8) =>
  invoke<SymbolMatch[]>('zerodha_search_instruments', { query, limit });

export const zerodhaFetchBars = (ticker: string, interval: string, fromMs?: number, toMs?: number) =>
  invoke<BarsResponse>('zerodha_fetch_bars', { ticker, interval, fromMs, toMs });

export const zerodhaQuotes = (tickers: string[]) => invoke<Quote[]>('zerodha_quotes', { tickers });

export const zerodhaSubscribe = (ticker: string) =>
  invoke<{ token: number; exchange: string }>('zerodha_subscribe', { ticker });

export const zerodhaUnsubscribe = (ticker: string) => invoke<void>('zerodha_unsubscribe', { ticker });

/** Tauri rejects with a plain string; normalise to something `instanceof Error`-safe. */
export function errorMessage(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---- Price alerts ------------------------------------------------------------

export const listPriceAlerts = () => invoke<PriceAlert[]>('list_price_alerts');

/** Creates the alert, or updates the one with the same id. */
export const savePriceAlert = (alert: PriceAlert) => invoke<void>('save_price_alert', { alert });

export const deletePriceAlert = (id: string) => invoke<void>('delete_price_alert', { id });

/** Removes the alerts that have already fired; resolves with how many went. */
export const clearTriggeredPriceAlerts = () => invoke<number>('clear_triggered_price_alerts');
