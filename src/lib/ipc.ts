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

/** The colours a symbol can be flagged with; the backend refuses any other. */
export const WATCHLIST_FLAGS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;
export type WatchlistFlag = (typeof WATCHLIST_FLAGS)[number];

export interface WatchlistItem {
  id: number;
  /** Fully-qualified chart symbol, e.g. `binance:BTCUSDT`. */
  symbol: string;
  name: string | null;
  /** Where the row sits among the list's symbols and sections: they share one sequence. */
  position: number;
  flag: WatchlistFlag | null;
}

/** A heading in a watchlist. It owns the symbols after it, up to the next heading. */
export interface WatchlistSection {
  id: number;
  name: string;
  position: number;
  /** The symbols under it are hidden. */
  collapsed: boolean;
}

export interface WatchlistDetail {
  id: number;
  name: string;
  createdAt: string;
  items: WatchlistItem[];
  sections: WatchlistSection[];
  /** Only present on the add-items response. */
  added?: number | null;
}

/** One row of a watchlist — a symbol or a section heading — named by its kind and id. */
export interface RowRef {
  kind: 'item' | 'section';
  id: number;
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

/** Makes the Indices watchlist (broad market, sectors, themes) from a broker's instrument list. */
export const createIndicesWatchlist = (provider: 'zerodha') => invoke<WatchlistDetail>('create_indices_watchlist', { provider });

/** Every NSE equity a broker's instrument list has (~2,000 symbols) — feeds Vela's own symbol
 *  index (`data/providers/zerodha.ts`'s `listSymbols`), not the app's own search box. */
export const listNseEquities = (provider: 'zerodha') => invoke<SymbolMatch[]>('list_nse_equities', { provider });

/** A symbol's drawings (Vela's document, as JSON), or null when none were ever stored for it. */
export const getSymbolDrawings = (symbol: string) => invoke<string | null>('get_symbol_drawings', { symbol });

/** Stores a symbol's drawings; every window hears `symbol-drawings-changed` with `source`. */
export const saveSymbolDrawings = (symbol: string, docJson: string, source: string) =>
  invoke<void>('save_symbol_drawings', { symbol, docJson, source });

export const createWatchlist = (name: string) => invoke<WatchlistDetail>('create_watchlist', { name });

export const renameWatchlist = (id: number, name: string) => invoke<void>('rename_watchlist', { id, name });

export const deleteWatchlist = (id: number) => invoke<void>('delete_watchlist', { id });

export const addWatchlistItems = (watchlistId: number, items: NewWatchlistItem[]) =>
  invoke<WatchlistDetail>('add_watchlist_items', { watchlistId, items });

/** Which symbols every list holds, as `[watchlistId, symbol]` pairs. */
export const listWatchlistMembers = () => invoke<[number, string][]>('list_watchlist_members');

export const removeWatchlistItems = (watchlistId: number, symbols: string[]) =>
  invoke<void>('remove_watchlist_items', { watchlistId, symbols });

/** Flags a symbol with a colour — the same on every list it is on — or clears its flag. */
export const setSymbolFlag = (symbol: string, flag: WatchlistFlag | null) => invoke<void>('set_symbol_flag', { symbol, flag });

/** The flags of those of `symbols` that have one; a symbol with none is absent. */
export const getSymbolFlags = (symbols: string[]) => invoke<Record<string, WatchlistFlag>>('symbol_flags', { symbols });

/** The six colour lists (every symbol flagged with that colour), with their counts. Their ids are negative. */
export const listFlagLists = () => invoke<WatchlistSummary[]>('list_flag_lists');

/** The colour whose list `id` is, or null for a real watchlist: red is -1 … purple -6 (`watchlists::flag_list_id`). */
export function flagOfList(id: number | null | undefined): WatchlistFlag | null {
  if (id == null || id >= 0) return null;
  return WATCHLIST_FLAGS[-id - 1] ?? null;
}

/** Puts the rows in this order and returns the list as it now stands. Rows left out keep their order after the
 *  ones named, so a list that changed under the caller isn't scrambled. */
export const setWatchlistOrder = (watchlistId: number, order: RowRef[]) =>
  invoke<WatchlistDetail>('set_watchlist_order', { watchlistId, order });

/** Adds a section heading before `before`, or at the end of the list. Returns the list as it now stands. */
export const addWatchlistSection = (watchlistId: number, name: string, before: RowRef | null) =>
  invoke<WatchlistDetail>('add_watchlist_section', { watchlistId, name, before });

export const renameWatchlistSection = (id: number, name: string) => invoke<void>('rename_watchlist_section', { id, name });

/** Removes the heading; the symbols under it stay on the list. */
export const deleteWatchlistSection = (id: number) => invoke<void>('delete_watchlist_section', { id });

export const setWatchlistSectionCollapsed = (id: number, collapsed: boolean) =>
  invoke<void>('set_watchlist_section_collapsed', { id, collapsed });

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

// ---- Python -------------------------------------------------------------------

export type PythonEnvState = 'noPython' | 'needsVenv' | 'needsPackages' | 'ready';

export interface PythonEnvStatus {
  state: PythonEnvState;
  /** The interpreter scripts run with (or would be made from), when there is one. */
  python: string | null;
  version: string | null;
  /** Where the app's own environment lives, or will. */
  venv: string;
  /** The user chose the interpreter instead of the app's environment. */
  custom: boolean;
  /** One sentence for the person: what is true, and what to do about it. */
  message: string;
}

export interface PythonScript {
  name: string;
  modifiedMs: number;
  size: number;
}

export type PythonStream = 'stdout' | 'stderr';

/** `python-output`: one line a running script printed. */
export interface PythonOutputEvent {
  runId: string;
  stream: PythonStream;
  text: string;
  /** A progress bar redrawing itself: the next line from the same stream replaces it. */
  overwrite: boolean;
}

/** `python-exit`: a run has ended. */
export interface PythonExitEvent {
  runId: string;
  /** Null when it was stopped, or a signal ended it. */
  code: number | null;
  stopped: boolean;
  /** Set when the script could not be started at all. */
  error: string | null;
}

/** `python-result`: something a script asked the app to show. `data` is whatever the script
 *  sent, checked by the backend only as far as forwarding it safely; `python/results.ts`
 *  validates its shape before anything is drawn. */
export interface PythonResultEvent {
  runId: string;
  /** `table`, `report`, `figure`, or `study` (a Study run, `studies/result.ts`). */
  kind: string;
  title: string | null;
  data: unknown;
}

/** `python-setup-output`: a line the environment setup printed. */
export interface PythonSetupOutputEvent {
  stream: PythonStream;
  text: string;
  overwrite: boolean;
}

/** `python-setup-done`. */
export interface PythonSetupDoneEvent {
  ok: boolean;
  message: string;
}

export interface ResearchStats {
  series: number;
  bars: number;
}

export const pythonEnvStatus = () => invoke<PythonEnvStatus>('python_env_status');

/** Use this interpreter instead of the app's own environment; null goes back to the app's. */
export const pythonSetInterpreter = (path: string | null) => invoke<PythonEnvStatus>('python_set_interpreter', { path });

/** Makes the environment and installs pandas and numpy. Returns at once; progress arrives
 *  as `python-setup-output` events and the end as `python-setup-done`. */
export const pythonSetupEnv = () => invoke<void>('python_setup_env');

export const listPythonScripts = () => invoke<PythonScript[]>('python_list_scripts');

export const readPythonScript = (name: string) => invoke<string>('python_read_script', { name });

export const savePythonScript = (name: string, source: string) => invoke<void>('python_save_script', { name, source });

export const deletePythonScript = (name: string) => invoke<void>('python_delete_script', { name });

/** Opens the scripts folder in the system's file manager. */
export const revealPythonFolder = () => invoke<void>('python_reveal_folder');

/** Starts a script. `runId` is made up by the caller and names the run in every event, so
 *  output can be recognised before this resolves. */
export const runPythonScript = (name: string, runId: string) => invoke<void>('python_run', { name, runId });

export const stopPythonRun = (runId: string) => invoke<void>('python_stop', { runId });

/** How much market data scripts have caused the app to keep. */
export const pythonResearchStats = () => invoke<ResearchStats>('python_research_stats');

/** Forgets it all; resolves with how many bars went. */
export const clearPythonResearchData = () => invoke<number>('python_clear_research_data');

// ---- Studies ------------------------------------------------------------------

/** A saved Study (mirrors `Study` in models.rs). `specJson` is the Study Specification (`studies/spec.ts`). */
export interface StudyRow {
  id: string;
  name: string;
  specJson: string;
  createdAt: string;
  updatedAt: string;
}

/** A completed run, without its (large) result. `summaryJson` is a `RunSummary` (`studies/result.ts`). */
export interface StudyResultInfo {
  id: string;
  studyId: string;
  name: string;
  summaryJson: string;
  executedAt: string;
}

/** A completed run with everything it produced. `resultJson` is checked by `parseStudyResult` before use. */
export interface StudyResultRow extends StudyResultInfo {
  resultJson: string;
}

export type StudyExportKind = 'csv' | 'json' | 'py' | 'md';

export const listStudies = () => invoke<StudyRow[]>('list_studies');

export const saveStudy = (study: StudyRow) => invoke<void>('save_study', { study });

/** Deletes a Study and every stored run of it. */
export const deleteStudy = (id: string) => invoke<void>('delete_study', { id });

/** Stored runs, newest first: of one Study, or of all of them. */
export const listStudyResults = (studyId: string | null = null) => invoke<StudyResultInfo[]>('list_study_results', { studyId });

export const getStudyResult = (id: string) => invoke<StudyResultRow | null>('get_study_result', { id });

/** Keeps a run; the Study's oldest runs past the last twenty are dropped. */
export const saveStudyResult = (result: StudyResultRow) => invoke<void>('save_study_result', { result });

export const deleteStudyResult = (id: string) => invoke<void>('delete_study_result', { id });

/** Runs a Study with the Python engine. Output, the result and the end arrive as the Python
 *  events (`python-output`, `python-result` of kind `study`, `python-exit`) for `runId`. */
export const runStudy = (specJson: string, runId: string) => invoke<void>('study_run', { specJson, runId });

/** Asks where to save, in the system's dialog, and writes `contents` there. Resolves with the path,
 *  or null when the dialog was cancelled. */
export const exportStudyFile = (suggestedName: string, kind: StudyExportKind, contents: string) =>
  invoke<string | null>('export_study_file', { suggestedName, kind, contents });

/** The universe a Study would load, to price before it runs (mirrors `EstimateRequest`). */
export interface StudyEstimateRequest {
  provider: string;
  exchanges: string[];
  series: string[];
  /** A watchlist's or a list's symbols; the instrument list is read when absent. */
  symbols: string[] | null;
  fromMs: number;
  maxSymbols: number | null;
}

export interface StudyEstimate {
  symbols: number;
  /** Already held back far enough: at most a top-up. */
  stored: number;
  /** Historical-endpoint requests expected: new symbols, or ones not held back far enough. */
  requests: number;
  /** Batched quote calls the daily top-up needs instead, for stored symbols that only need
   *  their newest bar — usually 0 or 1, never one per symbol. */
  quoteRequests: number;
  /** Roughly how long `requests` and `quoteRequests` together take, at each endpoint's pace. */
  seconds: number;
  /** Listings left out as not stocks, or as a company's second listing. */
  listingsSkipped: number;
}

/** What a Study's data will cost to load. Reads the database only; asks no broker. */
export const studyEstimate = (request: StudyEstimateRequest) => invoke<StudyEstimate>('study_estimate', { request });

// ---- Scheduled scripts --------------------------------------------------------------

/** When a schedule fires (`scheduler/plan.rs` `Rule`). Minutes count from midnight IST. */
export type ScheduleRule =
  | { days: boolean[]; kind: 'daily'; at: number }
  | { days: boolean[]; kind: 'every'; minutes: number; from: number; until: number };

export type ScheduleRunStatus = 'running' | 'ok' | 'failed' | 'stopped' | 'missed' | 'skipped';

/** What happened one time a schedule came due. Times are epoch ms. */
export interface ScheduleRun {
  id: number;
  scheduleId: string;
  runId: string | null;
  status: ScheduleRunStatus;
  dueAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  message: string;
  /** The tail of what it printed; stderr lines start `! `. */
  output: string;
}

export interface Schedule {
  id: string;
  script: string;
  rule: ScheduleRule;
  enabled: boolean;
  /** Epoch ms; null while it is switched off. */
  nextRunAt: number | null;
  lastRun: ScheduleRun | null;
}

export const listSchedules = () => invoke<Schedule[]>('list_schedules');

/** Creates or changes a schedule. Only the user's press in the Python tab calls this. */
export const saveSchedule = (id: string, script: string, rule: ScheduleRule, enabled: boolean) =>
  invoke<void>('save_schedule', { id, script, rule, enabled });

export const deleteSchedule = (id: string) => invoke<void>('delete_schedule', { id });

/** A schedule's history, newest first. */
export const listScheduleRuns = (scheduleId: string) => invoke<ScheduleRun[]>('list_schedule_runs', { scheduleId });

export const runScheduleNow = (id: string) => invoke<void>('run_schedule_now', { id });

export const stopScheduleRun = (id: string) => invoke<void>('stop_schedule_run', { id });

// ---- Screener ------------------------------------------------------------------

/** A saved screen, without its last result. */
export interface ScreenerRow {
  id: string;
  name: string;
  specJson: string;
  /** When it last ran, or null if it never has. */
  ranAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const listScreeners = () => invoke<ScreenerRow[]>('list_screeners');

export const saveScreener = (id: string, name: string, specJson: string) => invoke<void>('save_screener', { id, name, specJson });

/** Deletes a screen and its last result. */
export const deleteScreener = (id: string) => invoke<void>('delete_screener', { id });

/** Keeps a run as the screen's last one. False when the screen isn't saved, so the run wasn't kept. */
export const saveScreenerResult = (id: string, resultJson: string, ranAt: string) =>
  invoke<boolean>('save_screener_result', { id, resultJson, ranAt });

/** The screen's last run as JSON, or null if it has none. */
export const getScreenerResult = (id: string) => invoke<string | null>('get_screener_result', { id });

/** Starts the Python engine on a screen. Its progress, result and exit arrive as `python-*` events for `runId`. */
export const runScreen = (specJson: string, runId: string) => invoke<void>('screen_run', { specJson, runId });

// ---- Market data (the local store of every NSE stock's daily history) ---------------

export type MarketDataTrigger = 'download' | 'update' | 'automatic';
export type MarketDataPhase = 'history' | 'prices' | 'corrections';

export interface MarketDataProgress {
  phase: MarketDataPhase;
  done: number;
  total: number;
}

export interface MarketDataSummary {
  listed: number;
  newListings: number;
  downloaded: number;
  updated: number;
  refetched: number;
  failed: number;
  holiday: boolean;
}

export interface MarketDataStatus {
  /** The broker the history comes from; null until the download has been started. */
  provider: 'zerodha' | null;
  autoUpdate: boolean;
  running: { trigger: MarketDataTrigger; startedAt: number; progress: MarketDataProgress | null } | null;
  lastUpdate: number | null;
  lastFailure: number | null;
  lastError: string | null;
  holdings: { symbols: number; series: number; fromMs: number | null; toMs: number | null };
}

export interface MarketDataFinished {
  trigger: MarketDataTrigger;
  summary: MarketDataSummary | null;
  error: string | null;
}

export const marketDataStatus = () => invoke<MarketDataStatus>('market_data_status');

/** Starts (or resumes) the five-year download. Only its button calls this. */
export const marketDataDownload = () => invoke<void>('market_data_download');

export const marketDataUpdateNow = () => invoke<void>('market_data_update_now');

export const marketDataStop = () => invoke<void>('market_data_stop');

export const marketDataSetAuto = (on: boolean) => invoke<void>('market_data_set_auto', { on });

// ---- Research Notebooks -------------------------------------------------------

export interface NotebookSummary {
  id: string;
  name: string;
  itemCount: number;
  updatedAt: string;
}

export type NotebookItemKind = 'study' | 'result';

/** An entry of a notebook. `title`/`detail` (name, date) are null when its target has been deleted. */
export interface NotebookItem {
  id: number;
  kind: NotebookItemKind;
  refId: string;
  note: string;
  position: number;
  title: string | null;
  detail: string | null;
}

export interface NotebookDetail {
  id: string;
  name: string;
  notes: string;
  updatedAt: string;
  items: NotebookItem[];
}

export const listNotebooks = () => invoke<NotebookSummary[]>('list_notebooks');

export const getNotebook = (id: string) => invoke<NotebookDetail | null>('get_notebook', { id });

/** Creates or renames a notebook and sets its notes. */
export const saveNotebook = (id: string, name: string, notes: string) => invoke<void>('save_notebook', { id, name, notes });

export const deleteNotebook = (id: string) => invoke<void>('delete_notebook', { id });

/** Adds a Study or a stored result to the end of a notebook; one already there is left as it is. */
export const addNotebookItem = (notebookId: string, kind: NotebookItemKind, refId: string) =>
  invoke<void>('add_notebook_item', { notebookId, kind, refId });

export const removeNotebookItem = (itemId: number) => invoke<void>('remove_notebook_item', { itemId });

export const setNotebookItemNote = (itemId: number, note: string) => invoke<void>('set_notebook_item_note', { itemId, note });

/** Puts a notebook's entries in this order. */
export const setNotebookOrder = (notebookId: string, itemIds: number[]) => invoke<void>('set_notebook_order', { notebookId, itemIds });

// ---- AI (Claude and OpenAI, with the user's own API keys) -----------------------------------------

/** A provider ProTradeChart can send AI requests to. */
export type AiProviderId = 'anthropic' | 'openai';

/** One provider's key status (mirrors `AiProviderStatus`). The key itself never leaves Rust. */
export interface AiProviderStatus {
  id: AiProviderId;
  label: string;
  configured: boolean;
  /** `keychain`, or `database` when there is no OS credential store (unencrypted). */
  storage: 'keychain' | 'database' | null;
}

/** Every provider's status, and which one an AI feature will actually use right now (mirrors
 *  `AiProviders`). `active` is `null` until at least one provider has a key. */
export interface AiProviders {
  providers: AiProviderStatus[];
  active: AiProviderId | null;
}

/** The AI's structured answer, unvalidated (`studies/assistant.ts` reads it), and the model that gave it. */
export interface AiAnswer {
  answer: unknown;
  model: string;
}

/** Mirrors `DraftRequest` in `ai/prompts.rs`. */
export interface AiDraftRequest {
  question: string;
  reference: string;
  currentSpec: object | null;
  history: { role: 'user' | 'assistant'; text: string }[];
  today: string;
}

/** Mirrors `ExplainRequest` in `ai/prompts.rs`. */
export interface AiExplainRequest {
  spec: object;
  summary: object;
  warnings: string[];
}

export const listAiProviders = () => invoke<AiProviders>('list_ai_providers');

/** Checks the key with the provider, then saves it in the OS keychain. */
export const aiSetKey = (provider: AiProviderId, key: string) => invoke<AiProviderStatus>('ai_set_key', { provider, key });

export const aiDeleteKey = (provider: AiProviderId) => invoke<void>('ai_delete_key', { provider });

/** How a streamed answer is going (the `ai-progress` event), for the request with `requestId`. */
export interface AiProgressEvent {
  requestId: string;
  stage: 'thinking' | 'writing';
  /** Characters of the answer so far. */
  chars: number;
}

/** Mirrors `PlanRequest` in `ai/prompts.rs`. */
export interface AiPlanRequest {
  question: string;
  reference: string;
  today: string;
  /** The previous round's synthesis, when planning a follow-up. */
  context: string | null;
}

/** Mirrors `SynthesisRequest` in `ai/prompts.rs`. */
export interface AiSynthesisRequest {
  question: string;
  studies: { purpose: string; spec: object; summary: object; warnings: string[] }[];
}

// Each call below is billed to the user's Anthropic account, and reports progress as `ai-progress`
// events carrying its `requestId`.

/** Sends a question (or a revision of `currentSpec`) to Claude. */
export const aiDraftStudy = (request: AiDraftRequest, requestId: string) => invoke<AiAnswer>('ai_draft_study', { request, requestId });

/** Asks Claude to explain a stored result's summary. */
export const aiExplainResult = (request: AiExplainRequest, requestId: string) => invoke<AiAnswer>('ai_explain_result', { request, requestId });

/** Asks Claude for a plan of Studies answering a research question. Runs nothing. */
export const aiPlanResearch = (request: AiPlanRequest, requestId: string) => invoke<AiAnswer>('ai_plan_research', { request, requestId });

/** Asks Claude to synthesise a finished round's results. */
export const aiSynthesizeResearch = (request: AiSynthesisRequest, requestId: string) =>
  invoke<AiAnswer>('ai_synthesize_research', { request, requestId });

// ---- Ask AI (the rail assistant: suggests actions, never runs them) -------------------------------

/** What Ask AI is told about the app right now (mirrors `AskAiContext`) — never secrets, broker
 *  tokens or a watchlist's contents, only what's already on screen. */
export interface AskAiContext {
  activeSymbol: string | null;
  activeTimeframe: string | null;
  openTabs: string[];
  watchlistNames: string[];
}

/** Mirrors `AskAiRequest` in `ai/prompts.rs`. */
export interface AskAiRequest {
  question: string;
  context: AskAiContext;
  history: { role: 'user' | 'assistant'; text: string }[];
}

/** One action the assistant proposed (mirrors `ProposedAction`). `actions.ts` validates
 *  `arguments` before ever showing it, and only the frontend's own code ever calls the real
 *  function it names — never this call itself. */
export interface ProposedAction {
  tool: string;
  arguments: Record<string, unknown>;
}

export interface AskAiAnswer {
  reply: string;
  actions: ProposedAction[];
  model: string;
}

/** A question (or a follow-up) → words, proposed actions, or both. Runs nothing by itself. */
export const askAi = (request: AskAiRequest, requestId: string) => invoke<AskAiAnswer>('ai_ask_ai', { request, requestId });
