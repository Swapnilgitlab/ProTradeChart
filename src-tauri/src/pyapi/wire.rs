//! What goes over the wire. Bars are *columnar* (one array per field): the Python side
//! turns that into a DataFrame without a per-row loop, and it is a fraction of the size of
//! an array of objects. Everything is camelCase, like the rest of the app's JSON.

use serde::{Deserialize, Serialize};

use super::data::BarsData;
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

pub const RESULT_KINDS: [&str; 4] = ["table", "report", "figure", "study"];
pub const MAX_TITLE_CHARS: usize = 200;
/// The first bytes of every PNG file, as base64. A figure that doesn't start like this isn't one.
pub const PNG_BASE64_PREFIX: &str = "iVBORw0KGgo";

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
    pub id: &'static str,
    pub label: &'static str,
    /// Switched on and fully set up (for a broker, credentials saved).
    pub usable: bool,
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
        let json: Value = serde_json::to_value(bars_body("zerodha:NSE:X", "D", &d)).unwrap();

        assert_eq!(json["t"], serde_json::json!([1000, 2000]));
        assert_eq!(json["o"], serde_json::json!([1.0, 1.5]));
        assert_eq!(json["h"], serde_json::json!([2.0, 2.5]));
        assert_eq!(json["l"], serde_json::json!([0.5, 1.0]));
        assert_eq!(json["c"], serde_json::json!([1.5, 2.0]));
        assert_eq!(json["v"], serde_json::json!([7.0, null]), "missing volume is null");
        assert_eq!(json["count"], 2);
        assert_eq!(json["symbol"], "zerodha:NSE:X");
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
            symbol: "zerodha:NSE:RELIANCE".into(),
            name: Some("Reliance Industries".into()),
            exchange: "NSE".into(),
            kind: "EQUITY".into(),
            expiry: None,
        };
        let json: Value = serde_json::to_value(row).unwrap();
        assert_eq!(json["symbol"], "zerodha:NSE:RELIANCE");
        assert!(json["expiry"].is_null());
    }
}
