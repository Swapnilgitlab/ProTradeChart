//! What goes over the wire. Bars are *columnar* (one array per field): the Python side
//! turns that into a DataFrame without a per-row loop, and it is a fraction of the size of
//! an array of objects. Everything is camelCase, like the rest of the app's JSON.

use serde::{Deserialize, Serialize};

use super::data::{BarsData, Snapshot, SyncReport, SyncStatus};
use super::ApiError;

/// What a script posts to show in the app: a table, a backtest report or a figure. Rust checks
/// only what makes forwarding it safe (who it is for, what kind, that a figure is a PNG); the
/// webview checks the content's shape before it draws anything.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultPost {
    pub run_id: String,
    /// `table`, `report` or `figure`.
    pub kind: String,
    #[serde(default)]
    pub title: Option<String>,
    pub data: serde_json::Value,
}

pub const RESULT_KINDS: [&str; 6] = ["table", "report", "figure", "study", "screen", "watchlist"];
pub const MAX_TITLE_CHARS: usize = 200;
/// The first bytes of every PNG file, as base64. A figure that doesn't start like this isn't one.
pub const PNG_BASE64_PREFIX: &str = "iVBORw0KGgo";

/// A watchlist a script asked for (`pt.set_watchlist`), checked: a result of kind `watchlist`. It is
/// not forwarded to a window like the others; the app writes it and answers with what it did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchlistUpdate {
    pub name: String,
    /// Canonical symbols (a broker's with its exchange), without repeats, in the script's order.
    pub symbols: Vec<String>,
    pub replace: bool,
}

/// What writing a [`WatchlistUpdate`] did, as the script is told.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchlistSync {
    pub name: String,
    pub created: bool,
    pub added: usize,
    pub removed: usize,
    pub total: usize,
}

/// A `POST /v1/sql` request (`pt.sql`): the SQL, its parameters (a list for `?`, an object for
/// `:name`) and whether to roll it back.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlPost {
    pub sql: String,
    #[serde(default)]
    pub params: Option<serde_json::Value>,
    #[serde(default)]
    pub dry_run: bool,
}

/// A `POST /v1/email` request (`pt.send_email`). There is no recipient: it goes to the user's own
/// address.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailPost {
    pub subject: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub attachments: Vec<AttachmentPost>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentPost {
    pub name: String,
    #[serde(default)]
    pub content_type: Option<String>,
    /// The file's bytes, base64.
    pub data: String,
}

/// A `POST /v1/screenshot` request (`pt.screenshot`): a chart the app draws and returns as a PNG.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotPost {
    pub symbol: String,
    #[serde(default = "daily")]
    pub timeframe: String,
    /// A saved layout whose first chart styles it (indicators, chart type), by name.
    #[serde(default)]
    pub layout: Option<String>,
    #[serde(default = "default_width")]
    pub width: u32,
    #[serde(default = "default_height")]
    pub height: u32,
}

fn daily() -> String {
    "D".into()
}
fn default_width() -> u32 {
    1280
}
fn default_height() -> u32 {
    720
}

/// A `POST /v1/snapshot` request: the symbols whose day to quote.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct SnapshotPost {
    pub symbols: Vec<String>,
}

/// One symbol's day in a snapshot answer. Every price is `null` when the broker had no quote for it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotRowBody {
    pub symbol: String,
    pub open: Option<f64>,
    pub high: Option<f64>,
    pub low: Option<f64>,
    pub last: Option<f64>,
    pub previous_close: Option<f64>,
    pub volume: Option<f64>,
    /// When it last traded (epoch milliseconds): the quote's session.
    pub traded_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotBody {
    /// The session these quotes speak for (epoch milliseconds of its IST midnight); `null` in the
    /// pre-open window, when no quote is a day's bar.
    pub session_day: Option<i64>,
    pub snapshots: Vec<SnapshotRowBody>,
}

pub fn snapshot_body(snapshot: &Snapshot) -> SnapshotBody {
    SnapshotBody {
        session_day: snapshot.session_day,
        snapshots: snapshot
            .rows
            .iter()
            .map(|r| {
                let s = r.snapshot;
                SnapshotRowBody {
                    symbol: r.symbol.clone(),
                    open: s.map(|s| s.open),
                    high: s.map(|s| s.high),
                    low: s.map(|s| s.low),
                    last: s.map(|s| s.last),
                    previous_close: s.and_then(|s| s.previous_close),
                    volume: s.and_then(|s| s.volume),
                    traded_at: s.and_then(|s| s.traded_at_ms),
                }
            })
            .collect(),
    }
}

/// A `POST /v1/bars/sync` request, before [`super::routes::sync_request`] checks it.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct SyncPost {
    pub symbols: Vec<String>,
    #[serde(default)]
    pub interval: Option<String>,
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub limit: Option<usize>,
}

/// A posted panel request: many symbols' stored bars in one answer (`POST /v1/panel`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct PanelPost {
    pub symbols: Vec<String>,
    #[serde(default)]
    pub interval: Option<String>,
    pub from: Option<i64>,
    pub to: Option<i64>,
    /// The newest this many bars per symbol.
    pub bars: Option<usize>,
}

/// What a panel answer's JSON header says about each series; its bars follow in the arrays.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PanelSeriesHead<'a> {
    symbol: &'a str,
    count: usize,
    current: bool,
    covered_from: Option<i64>,
    covered_to: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PanelHead<'a> {
    format: u32,
    interval: &'a str,
    timezone: &'static str,
    count: usize,
    series: Vec<PanelSeriesHead<'a>>,
}

/// The panel's binary format, version 1 (`python/protrade/panels.py` reads it):
///
/// ```text
/// u32 LE   length of the JSON header
/// bytes    the JSON header: {format, interval, timezone, count, series: [{symbol, count, current,
///          coveredFrom, coveredTo}]}
/// zeros    padding to a multiple of 8 bytes
/// i64 LE × count   time (epoch ms)        — every series' bars back to back, in header order,
/// f64 LE × count   open                     each series oldest first
/// f64 LE × count   high
/// f64 LE × count   low
/// f64 LE × count   close
/// f64 LE × count   volume (NaN where there is none, as for an index)
/// ```
///
/// Columns rather than rows so a reader takes each one as an array without a copy, and binary
/// because a whole market's five years is millions of numbers that JSON would triple in size.
pub fn panel_body(interval: &str, series: &[super::data::PanelSeries]) -> Vec<u8> {
    let count: usize = series.iter().map(|s| s.bars.len()).sum();
    let head = PanelHead {
        format: 1,
        interval,
        timezone: "Asia/Kolkata",
        count,
        series: series
            .iter()
            .map(|s| PanelSeriesHead {
                symbol: &s.symbol,
                count: s.bars.len(),
                current: s.current,
                covered_from: s.coverage.map(|c| c.from_ms),
                covered_to: s.coverage.map(|c| c.to_ms),
            })
            .collect(),
    };
    let head = serde_json::to_vec(&head).unwrap_or_default();
    let padded = (4 + head.len()).div_ceil(8) * 8;
    let mut out = Vec::with_capacity(padded + count * 48);
    out.extend_from_slice(&(head.len() as u32).to_le_bytes());
    out.extend_from_slice(&head);
    out.resize(padded, 0);
    let bars = || series.iter().flat_map(|s| s.bars.iter());
    bars().for_each(|b| out.extend_from_slice(&b.time.to_le_bytes()));
    for field in [
        |b: &crate::models::Bar| b.open,
        |b: &crate::models::Bar| b.high,
        |b: &crate::models::Bar| b.low,
        |b: &crate::models::Bar| b.close,
        |b: &crate::models::Bar| b.volume.unwrap_or(f64::NAN),
    ] {
        bars().for_each(|b| out.extend_from_slice(&field(b).to_le_bytes()));
    }
    out
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResultBody {
    pub symbol: String,
    /// `current`, `updated`, `fetch` or `skipped`.
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SyncReportBody {
    pub results: Vec<SyncResultBody>,
}

pub fn sync_report_body(report: &SyncReport) -> SyncReportBody {
    SyncReportBody {
        results: report
            .results
            .iter()
            .map(|r| SyncResultBody {
                symbol: r.symbol.clone(),
                status: match r.status {
                    SyncStatus::Current => "current",
                    SyncStatus::Updated => "updated",
                    SyncStatus::Fetch => "fetch",
                    SyncStatus::Skipped => "skipped",
                },
                reason: r.reason.clone(),
            })
            .collect(),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BarsBody<'a> {
    pub symbol: &'a str,
    pub interval: &'a str,
    pub timezone: &'a str,
    pub count: usize,
    /// Bar open times, epoch milliseconds. A daily bar is stamped at midnight IST.
    pub t: Vec<i64>,
    pub o: Vec<f64>,
    pub h: Vec<f64>,
    pub l: Vec<f64>,
    pub c: Vec<f64>,
    /// `null` where the exchange reported no volume (an index).
    pub v: Vec<Option<f64>>,
    pub covered_from: i64,
    pub covered_to: i64,
    /// Present when the broker wouldn't serve as far back as asked; the real start.
    pub limited_from: Option<i64>,
}

pub fn bars_body<'a>(symbol: &'a str, interval: &'a str, data: &'a BarsData) -> BarsBody<'a> {
    let n = data.bars.len();
    let mut body = BarsBody {
        symbol,
        interval,
        timezone: &data.timezone,
        count: n,
        t: Vec::with_capacity(n),
        o: Vec::with_capacity(n),
        h: Vec::with_capacity(n),
        l: Vec::with_capacity(n),
        c: Vec::with_capacity(n),
        v: Vec::with_capacity(n),
        covered_from: data.covered_from_ms,
        covered_to: data.covered_to_ms,
        limited_from: data.limited_from_ms,
    };
    for b in &data.bars {
        body.t.push(b.time);
        body.o.push(b.open);
        body.h.push(b.high);
        body.l.push(b.low);
        body.c.push(b.close);
        body.v.push(b.volume);
    }
    body
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProviderStatus {
    /// The symbol namespace: `india` or `csv`.
    pub id: &'static str,
    pub label: &'static str,
    /// Switched on and fully set up (for a broker, credentials saved).
    pub usable: bool,
    /// For `india`, the broker serving it now (`zerodha`); none for imported data.
    pub broker: Option<&'static str>,
}

/// One row of a provider's instrument list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstrumentRow {
    /// Ready to pass back to the API: `zerodha:NSE:RELIANCE`.
    pub symbol: String,
    pub name: Option<String>,
    pub exchange: String,
    /// `EQUITY`, `INDEX` or `FUT`.
    pub kind: String,
    pub expiry: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WatchlistInfo {
    pub id: i64,
    pub name: String,
    pub count: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WatchlistSymbol {
    pub symbol: String,
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WatchlistContent {
    pub id: i64,
    pub name: String,
    pub symbols: Vec<WatchlistSymbol>,
}

pub fn error_json(e: &ApiError) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({ "error": { "code": e.code, "message": e.message } }))
        .unwrap_or_else(|_| br#"{"error":{"code":"internal","message":"could not encode the error"}}"#.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Bar;
    use serde_json::Value;

    fn data(bars: Vec<Bar>) -> BarsData {
        BarsData {
            bars,
            timezone: "Asia/Kolkata".into(),
            covered_from_ms: 10,
            covered_to_ms: 99,
            limited_from_ms: Some(20),
        }
    }

    #[test]
    fn bars_are_columns_not_rows() {
        let bars = vec![
            Bar {
                time: 1000,
                open: 1.0,
                high: 2.0,
                low: 0.5,
                close: 1.5,
                volume: Some(7.0),
            },
            Bar {
                time: 2000,
                open: 1.5,
                high: 2.5,
                low: 1.0,
                close: 2.0,
                volume: None,
            },
        ];
        let d = data(bars);
        let json: Value = serde_json::to_value(bars_body("india:NSE:X", "D", &d)).unwrap();

        assert_eq!(json["t"], serde_json::json!([1000, 2000]));
        assert_eq!(json["o"], serde_json::json!([1.0, 1.5]));
        assert_eq!(json["h"], serde_json::json!([2.0, 2.5]));
        assert_eq!(json["l"], serde_json::json!([0.5, 1.0]));
        assert_eq!(json["c"], serde_json::json!([1.5, 2.0]));
        assert_eq!(json["v"], serde_json::json!([7.0, null]), "missing volume is null");
        assert_eq!(json["count"], 2);
        assert_eq!(json["symbol"], "india:NSE:X");
        assert_eq!(json["timezone"], "Asia/Kolkata");
    }

    #[test]
    fn coverage_and_limits_are_camel_case() {
        let json: Value = serde_json::to_value(bars_body("s", "5", &data(vec![]))).unwrap();
        assert_eq!(json["coveredFrom"], 10);
        assert_eq!(json["coveredTo"], 99);
        assert_eq!(json["limitedFrom"], 20);
        assert_eq!(json["count"], 0);
    }

    #[test]
    fn an_unlimited_answer_says_null() {
        let mut d = data(vec![]);
        d.limited_from_ms = None;
        let json: Value = serde_json::to_value(bars_body("s", "5", &d)).unwrap();
        assert!(json["limitedFrom"].is_null());
    }

    #[test]
    fn an_error_carries_its_code_and_message_and_nothing_else() {
        let e = ApiError::new(401, "auth", "Zerodha rejected your access token.");
        let json: Value = serde_json::from_slice(&error_json(&e)).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "error": { "code": "auth", "message": "Zerodha rejected your access token." } })
        );
    }

    #[test]
    fn instruments_and_watchlists_use_the_apps_camel_case() {
        let row = InstrumentRow {
            symbol: "india:NSE:RELIANCE".into(),
            name: Some("Reliance Industries".into()),
            exchange: "NSE".into(),
            kind: "EQUITY".into(),
            expiry: None,
        };
        let json: Value = serde_json::to_value(row).unwrap();
        assert_eq!(json["symbol"], "india:NSE:RELIANCE");
        assert!(json["expiry"].is_null());
    }
}
