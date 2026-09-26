//! Plain data shapes shared between the store, the brokers' clients and the
//! Tauri command layer. Everything serializes as camelCase so the TypeScript
//! side never needs a mapping layer.

use serde::{Deserialize, Serialize};

/// One OHLCV bar. `time` is the bar's open time in epoch milliseconds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bar {
    pub time: i64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: Option<f64>,
}

// ---- Layouts ---------------------------------------------------------------

/// A named chart session. `state_json` is opaque to Rust: the frontend owns
/// its shape (see `LayoutDocument` in `src/features/layouts`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartLayout {
    pub id: String,
    pub name: String,
    pub state_json: String,
    pub is_default: bool,
    pub created_at: String,
    pub updated_at: String,
}

// ---- Studies ---------------------------------------------------------------

/// A saved Study. `spec_json` is the Study Specification, opaque to Rust (see `src/studies/spec.ts`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Study {
    pub id: String,
    pub name: String,
    pub spec_json: String,
    pub created_at: String,
    pub updated_at: String,
}

/// A completed run of a Study, as a list shows it: no `result_json`, which can be megabytes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StudyResultInfo {
    pub id: String,
    pub study_id: String,
    pub name: String,
    pub summary_json: String,
    pub executed_at: String,
}

/// A completed run with everything it produced.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StudyResult {
    pub id: String,
    pub study_id: String,
    pub name: String,
    pub summary_json: String,
    pub result_json: String,
    pub executed_at: String,
}

// ---- Pine scripts ----------------------------------------------------------

/// A saved Pine Script. `kind` is `indicator` or `strategy` (enforced by the
/// table); the source is opaque to Rust, which never runs it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PineScript {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub source: String,
    pub created_at: String,
    pub updated_at: String,
}

// ---- Watchlists ------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchlistSummary {
    pub id: i64,
    pub name: String,
    pub created_at: String,
    pub item_count: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchlistItem {
    pub id: i64,
    /// Fully-qualified chart symbol, e.g. `binance:BTCUSDT` or `dhan:NSE:RELIANCE`.
    pub symbol: String,
    pub name: Option<String>,
    /// Where the row sits among the list's symbols *and* sections (see `WatchlistSection`).
    pub position: i64,
    /// A colour the user marked the symbol with, one of `store::watchlists::FLAGS`.
    pub flag: Option<String>,
}

/// A heading in a watchlist. It owns the symbols after it, up to the next heading.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchlistSection {
    pub id: i64,
    pub name: String,
    /// Shares a sequence with the symbols' `position`.
    pub position: i64,
    /// Whether the symbols under it are hidden.
    pub collapsed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchlistDetail {
    pub id: i64,
    pub name: String,
    pub created_at: String,
    /// The symbols, in list order.
    pub items: Vec<WatchlistItem>,
    /// The headings, in list order. Merge with `items` by `position` to get the rows as shown.
    pub sections: Vec<WatchlistSection>,
    /// Only set on the add-items response: how many of the given symbols were
    /// new (duplicates already on the list are skipped).
    pub added: Option<i64>,
}

/// Which table a row of a watchlist lives in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RowKind {
    Item,
    Section,
}

/// One row of a watchlist — a symbol or a section heading — named by its table and id.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowRef {
    pub kind: RowKind,
    pub id: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewWatchlistItem {
    pub symbol: String,
    pub name: Option<String>,
}

// ---- Imported datasets -----------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetInfo {
    pub ticker: String,
    pub description: Option<String>,
    /// Native timeframe of the stored bars, in Vela's canonical form
    /// (`"1"`, `"5"`, `"60"`, `"D"`, `"W"`, `"M"`).
    pub base_tf: String,
    pub bar_count: i64,
    pub first_time: Option<i64>,
    pub last_time: Option<i64>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetInput {
    pub ticker: String,
    pub description: Option<String>,
    pub base_tf: String,
    pub bars: Vec<Bar>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetBars {
    pub base_tf: String,
    pub bars: Vec<Bar>,
}

// ---- Market data -----------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BarsResponse {
    pub bars: Vec<Bar>,
    /// The instrument's exchange UTC offset in seconds — lets the frontend
    /// group intraday bars into exchange-local trading days.
    pub gmt_offset: i64,
    pub timezone: Option<String>,
    /// True when the network request failed and the bars came from the local
    /// cache instead.
    pub from_cache: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolMatch {
    pub symbol: String,
    pub name: Option<String>,
    pub exchange: Option<String>,
    pub kind: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Quote {
    pub symbol: String,
    pub price: Option<f64>,
    pub previous_close: Option<f64>,
    pub change_percent: Option<f64>,
    pub currency: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub data_dir: String,
}

// ---- Data providers --------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderField {
    pub key: String,
    pub label: String,
    /// Secret fields are write-only: the current value is never sent back.
    pub secret: bool,
    pub help: String,
    pub placeholder: String,
    /// The current value of a non-secret field.
    pub value: Option<String>,
    pub is_set: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCapabilities {
    pub history: bool,
    pub live: bool,
    pub search: bool,
    pub quotes: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub id: String,
    pub label: String,
    pub description: String,
    /// `free` (no setup), `broker` (needs your own account) or `local`.
    pub category: String,
    pub fields: Vec<ProviderField>,
    pub enabled: bool,
    /// Every required field has a value.
    pub configured: bool,
    pub can_disable: bool,
    pub capabilities: ProviderCapabilities,
    pub docs_url: Option<String>,
    /// `keychain` or `database` when any credential is stored.
    pub secret_storage: Option<String>,
}

// ---- Price alerts ----------------------------------------------------------

/// A price the user wants to hear about. The frontend's alert engine watches
/// `symbol` and fires when it crosses `price`; these are the fields it keeps.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceAlert {
    pub id: String,
    /// `provider:TICKER`, like a chart symbol.
    pub symbol: String,
    /// `crossing_up`, `crossing_down` or `crossing` (either way).
    pub condition: String,
    pub price: f64,
    /// The price a crossing is measured from until the engine has seen a newer
    /// one: the price when the alert was made, or when it last fired.
    pub base_price: Option<f64>,
    /// A note shown when it fires; may be empty.
    pub message: String,
    /// `once` (fire, then stop) or `every` (fire each time it crosses again).
    pub mode: String,
    /// `active`, `triggered` (fired, and done) or `paused`.
    pub status: String,
    pub created_at: i64,
    pub triggered_at: Option<i64>,
    /// The price that tripped it, the last time it fired.
    pub trigger_price: Option<f64>,
    pub trigger_count: i64,
}
