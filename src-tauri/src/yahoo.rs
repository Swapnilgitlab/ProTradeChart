//! Pure request-planning and response-parsing for Yahoo Finance's unofficial,
//! key-less JSON endpoints. No I/O lives here so all of it is unit-testable;
//! `market.rs` does the actual HTTP.

use serde_json::Value;

use crate::models::{Bar, Quote, SymbolMatch};

pub const HOST: &str = "https://query1.finance.yahoo.com";

const DAY_SECS: i64 = 24 * 60 * 60;
const HOUR_SECS: i64 = 60 * 60;

/// What Yahoo will serve for one bar interval.
pub struct IntervalLimits {
    /// Widest single request, in seconds (`None` = unbounded).
    pub max_window_secs: Option<i64>,
    /// How far back from now any bar can be requested (`None` = full history).
    pub max_age_secs: Option<i64>,
}

/// `None` means the interval isn't one Yahoo serves.
pub fn interval_limits(interval: &str) -> Option<IntervalLimits> {
    let (window, age) = match interval {
        "1m" => (Some(7 * DAY_SECS), Some(30 * DAY_SECS)),
        "2m" | "5m" | "15m" | "30m" | "90m" => (Some(60 * DAY_SECS), Some(60 * DAY_SECS)),
        "60m" | "1h" => (Some(730 * DAY_SECS), Some(730 * DAY_SECS)),
        "1d" | "5d" | "1wk" | "1mo" | "3mo" => (None, None),
        _ => return None,
    };
    Some(IntervalLimits {
        max_window_secs: window,
        max_age_secs: age,
    })
}

/// The `[period1, period2)` window (epoch seconds) to request, clamped to what
/// Yahoo allows for `interval`. `None` when the interval is unsupported or the
/// requested window lies entirely outside the servable range.
pub fn plan_window(interval: &str, from_ms: Option<i64>, to_ms: Option<i64>, now_ms: i64) -> Option<(i64, i64)> {
    let limits = interval_limits(interval)?;
    let now = now_ms.div_euclid(1000);

    // +1 so a bar opening exactly at `to` is included.
    let period2 = to_ms.map_or(now, |t| t.div_euclid(1000)).min(now) + 1;
    let mut period1 = from_ms.map_or(0, |f| f.div_euclid(1000)).max(0);

    if let Some(age) = limits.max_age_secs {
        // An hour of slack: a request sitting exactly on the limit is rejected.
        let earliest = now - age + HOUR_SECS;
        if period2 <= earliest {
            return None;
        }
        period1 = period1.max(earliest);
    }
    if let Some(window) = limits.max_window_secs {
        period1 = period1.max(period2 - window);
    }

    (period1 < period2).then_some((period1, period2))
}

pub struct ChartData {
    pub bars: Vec<Bar>,
    pub gmt_offset: i64,
    pub timezone: Option<String>,
}

fn api_error(body: &Value) -> Option<String> {
    let err = body.pointer("/chart/error")?;
    if err.is_null() {
        return None;
    }
    let description = err
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or("unknown error");
    Some(description.to_string())
}

/// Whether a chart error just means "no bars in the window asked for" rather
/// than a real failure: a window that ends before the symbol's first trade
/// (`Data doesn't exist for startDate = …`, HTTP 400), or an intraday window
/// past what Yahoo keeps (`… data not available for startTime = …`, HTTP 422).
/// Scrolling back through history asks for windows like these once it runs out
/// of data, and the right answer to them is an empty result.
pub fn is_window_without_data(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    message.contains("data doesn't exist for startdate") || message.contains("data not available for starttime")
}

/// Parses a `/v8/finance/chart` response into bars. A response with no
/// timestamps (a window with no trading) is an empty result, not an error.
pub fn parse_chart(body: &Value) -> Result<ChartData, String> {
    if let Some(e) = api_error(body) {
        return Err(e);
    }
    let result = body.pointer("/chart/result/0").ok_or("no data returned")?;

    let gmt_offset = result.pointer("/meta/gmtoffset").and_then(Value::as_i64).unwrap_or(0);
    let timezone = result
        .pointer("/meta/exchangeTimezoneName")
        .and_then(Value::as_str)
        .map(str::to_string);

    let Some(timestamps) = result.get("timestamp").and_then(Value::as_array) else {
        return Ok(ChartData {
            bars: Vec::new(),
            gmt_offset,
            timezone,
        });
    };
    let quote = result
        .pointer("/indicators/quote/0")
        .ok_or("response has no price series")?;
    let series = |key: &str| quote.get(key).and_then(Value::as_array);
    let (opens, highs, lows, closes, volumes) = (
        series("open"),
        series("high"),
        series("low"),
        series("close"),
        series("volume"),
    );

    let mut bars: Vec<Bar> = Vec::with_capacity(timestamps.len());
    for (i, ts) in timestamps.iter().enumerate() {
        let Some(ts) = ts.as_i64() else { continue };
        let pick = |s: Option<&Vec<Value>>| s.and_then(|a| a.get(i)).and_then(Value::as_f64);
        // Any OHLC field can be null for a bar Yahoo couldn't fill — skip it.
        let (Some(open), Some(high), Some(low), Some(close)) = (pick(opens), pick(highs), pick(lows), pick(closes))
        else {
            continue;
        };
        // Volume can be legitimately absent (indices, FX) and 0 means "no data".
        let volume = pick(volumes).filter(|v| *v > 0.0);
        let time = ts * 1000;

        // Yahoo occasionally repeats the forming bar's timestamp; keep the latest.
        match bars.last_mut() {
            Some(last) if last.time == time => {
                *last = Bar {
                    time,
                    open,
                    high,
                    low,
                    close,
                    volume,
                }
            }
            _ => bars.push(Bar {
                time,
                open,
                high,
                low,
                close,
                volume,
            }),
        }
    }
    Ok(ChartData {
        bars,
        gmt_offset,
        timezone,
    })
}

/// Parses a `/v1/finance/search` response, dropping option contracts (they
/// can't be charted meaningfully here).
pub fn parse_search(body: &Value) -> Vec<SymbolMatch> {
    let Some(quotes) = body.get("quotes").and_then(Value::as_array) else {
        return Vec::new();
    };
    quotes
        .iter()
        .filter_map(|q| {
            let symbol = q.get("symbol")?.as_str()?.to_string();
            let kind = q.get("quoteType").and_then(Value::as_str).map(str::to_string);
            if kind.as_deref() == Some("OPTION") {
                return None;
            }
            let text = |key: &str| q.get(key).and_then(Value::as_str).map(str::to_string);
            Some(SymbolMatch {
                symbol,
                name: text("longname").or_else(|| text("shortname")),
                exchange: text("exchDisp").or_else(|| text("exchange")),
                kind,
            })
        })
        .collect()
}

/// Most symbols one `/v8/finance/spark` request may carry (Yahoo answers 400 above this).
pub const SPARK_MAX_SYMBOLS: usize = 20;

/// A quote that couldn't be produced, carrying the reason.
pub fn quote_error(symbol: &str, error: &str) -> Quote {
    Quote {
        symbol: symbol.to_string(),
        price: None,
        previous_close: None,
        change_percent: None,
        currency: None,
        error: Some(error.to_string()),
    }
}

/// Builds quotes from a `/v8/finance/spark?range=5d&interval=1d` response, which
/// covers up to [`SPARK_MAX_SYMBOLS`] symbols in one request. Returns one quote
/// per entry of `symbols`, in order; a symbol Yahoo left out (unknown ticker)
/// or couldn't price comes back with `error` set, so one bad ticker doesn't
/// blank the rest. Spark has no currency field, so `currency` is always `None`.
pub fn parse_spark(body: &Value, symbols: &[String]) -> Vec<Quote> {
    if let Some(error) = body.pointer("/spark/error").filter(|e| !e.is_null()) {
        let description = error
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("Yahoo Finance rejected the request");
        return symbols.iter().map(|s| quote_error(s, description)).collect();
    }
    symbols
        .iter()
        .map(|symbol| {
            // Yahoo echoes tickers upper-cased, so a lower-case request still finds its entry.
            let entry = body.get(symbol.as_str()).or_else(|| {
                body.as_object()?
                    .iter()
                    .find(|(key, _)| key.eq_ignore_ascii_case(symbol))
                    .map(|(_, value)| value)
            });
            match entry {
                Some(entry) => spark_quote(symbol, entry),
                None => quote_error(symbol, "no data returned"),
            }
        })
        .collect()
}

fn spark_quote(symbol: &str, entry: &Value) -> Quote {
    let closes: Vec<f64> = entry
        .get("close")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_f64).collect())
        .unwrap_or_default();
    let number = |key: &str| entry.get(key).and_then(Value::as_f64);

    let price = number("fulldayPrice").or_else(|| closes.last().copied());
    let Some(price) = price else {
        return quote_error(symbol, "no price available");
    };
    let previous_close = closes
        .len()
        .checked_sub(2)
        .map(|i| closes[i])
        .or_else(|| number("chartPreviousClose"));
    let change_percent = number("fulldayChangePercent").or_else(|| match previous_close {
        Some(prev) if prev != 0.0 => Some((price - prev) / prev * 100.0),
        _ => None,
    });

    Quote {
        symbol: symbol.to_string(),
        price: Some(price),
        previous_close,
        change_percent,
        currency: None,
        error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: i64 = 1_800_000_000_000; // ms
    const DAY_MS: i64 = 86_400_000;

    #[test]
    fn unsupported_interval_has_no_plan() {
        assert!(plan_window("3m", None, None, NOW).is_none());
        assert!(plan_window("240m", None, None, NOW).is_none());
    }

    #[test]
    fn daily_requests_pass_through_unclamped() {
        let (p1, p2) = plan_window("1d", Some(NOW - 400 * DAY_MS), Some(NOW), NOW).unwrap();
        assert_eq!(p1, (NOW - 400 * DAY_MS) / 1000);
        assert_eq!(p2, NOW / 1000 + 1);
    }

    #[test]
    fn open_ended_daily_request_asks_for_full_history() {
        let (p1, _) = plan_window("1d", None, None, NOW).unwrap();
        assert_eq!(p1, 0);
    }

    #[test]
    fn one_minute_window_is_clamped_to_seven_days() {
        let (p1, p2) = plan_window("1m", Some(NOW - 20 * DAY_MS), None, NOW).unwrap();
        assert_eq!(p2 - p1, 7 * DAY_SECS);
    }

    #[test]
    fn requests_older_than_the_age_limit_are_dropped_or_trimmed() {
        // Entirely older than 30 days of 1m data: nothing to fetch.
        assert!(plan_window("1m", Some(NOW - 100 * DAY_MS), Some(NOW - 60 * DAY_MS), NOW).is_none());
        // Straddling the limit: the start is pulled forward inside it.
        let (p1, _) = plan_window("5m", Some(NOW - 90 * DAY_MS), Some(NOW), NOW).unwrap();
        assert!(p1 > (NOW - 60 * DAY_MS) / 1000);
    }

    #[test]
    fn a_backfill_window_ending_at_a_bar_includes_that_bar() {
        let to = NOW - 10 * DAY_MS;
        let (_, p2) = plan_window("60m", Some(NOW - 30 * DAY_MS), Some(to), NOW).unwrap();
        assert_eq!(p2, to / 1000 + 1);
    }

    fn chart_body() -> Value {
        json!({ "chart": { "error": null, "result": [{
            "meta": { "gmtoffset": 19800, "exchangeTimezoneName": "Asia/Kolkata", "currency": "INR",
                      "regularMarketPrice": 110.0 },
            "timestamp": [100, 200, 300, 300, 400],
            "indicators": { "quote": [{
                "open":   [1.0, 2.0, null, 3.5, 4.0],
                "high":   [1.5, 2.5, 3.5, 3.9, 4.5],
                "low":    [0.5, 1.5, 2.5, 3.1, 3.5],
                "close":  [1.2, 2.2, 3.2, 3.6, 4.2],
                "volume": [100, null, 300, 350, 0]
            }]}
        }]}})
    }

    #[test]
    fn parse_chart_skips_null_bars_dedupes_and_maps_volume() {
        let data = parse_chart(&chart_body()).unwrap();
        assert_eq!(data.gmt_offset, 19800);
        assert_eq!(data.timezone.as_deref(), Some("Asia/Kolkata"));

        // ts=300 has a null open on its first row and is repeated: the later
        // full row survives; ts=100/200/400 are kept.
        let times: Vec<_> = data.bars.iter().map(|b| b.time).collect();
        assert_eq!(times, [100_000, 200_000, 300_000, 400_000]);
        assert_eq!(data.bars[0].volume, Some(100.0));
        assert_eq!(data.bars[1].volume, None, "null volume");
        assert_eq!(data.bars[3].volume, None, "zero volume is treated as missing");
        assert_eq!(data.bars[2].close, 3.6);
    }

    #[test]
    fn parse_chart_with_no_timestamps_is_empty_not_an_error() {
        let body = json!({ "chart": { "error": null, "result": [{ "meta": { "gmtoffset": -14400 } }] } });
        let data = parse_chart(&body).unwrap();
        assert!(data.bars.is_empty());
        assert_eq!(data.gmt_offset, -14400);
    }

    #[test]
    fn windows_outside_a_symbols_history_are_recognised_as_empty_not_broken() {
        // The real messages Yahoo sends (prefixed with the symbol by `fetch_chart`).
        assert!(is_window_without_data(
            "INFY.NS: Data doesn't exist for startDate = 315532800, endDate = 320000000"
        ));
        assert!(is_window_without_data(
            "AAPL: 5m data not available for startTime=1700000000 and endTime=1700500000. The requested range must be within the last 60 days."
        ));
        // Genuine failures stay failures.
        assert!(!is_window_without_data("ZZZQQQ: No data found, symbol may be delisted"));
        assert!(!is_window_without_data(
            "Yahoo Finance is rate limiting this app — requests are paused for 30s"
        ));
        assert!(!is_window_without_data("network error: connection refused"));
    }

    #[test]
    fn parse_chart_surfaces_api_errors() {
        let body = json!({ "chart": { "result": null, "error": { "code": "Not Found", "description": "No data found, symbol may be delisted" } } });
        assert_eq!(
            parse_chart(&body).err().as_deref(),
            Some("No data found, symbol may be delisted")
        );
    }

    #[test]
    fn parse_search_drops_options_and_prefers_long_names() {
        let body = json!({ "quotes": [
            { "symbol": "RELIANCE.NS", "shortname": "RELIANCE INDUSTRIES LTD", "longname": "Reliance Industries Limited", "exchDisp": "NSE", "quoteType": "EQUITY" },
            { "symbol": "AAPL240101C00100000", "quoteType": "OPTION" },
            { "shortname": "no symbol" },
            { "symbol": "BTC-USD", "shortname": "Bitcoin USD", "exchange": "CCC", "quoteType": "CRYPTOCURRENCY" }
        ]});
        let matches = parse_search(&body);
        assert_eq!(matches.len(), 2);
        assert_eq!(matches[0].name.as_deref(), Some("Reliance Industries Limited"));
        assert_eq!(matches[0].exchange.as_deref(), Some("NSE"));
        assert_eq!(matches[1].exchange.as_deref(), Some("CCC"));
    }

    fn syms(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parse_spark_prefers_yahoos_price_and_change_percent() {
        let body = json!({
            "RELIANCE.NS": { "close": [1200.0, 1243.9, 1226.4], "fulldayPrice": 1226.4, "fulldayChangePercent": -1.407,
                             "chartPreviousClose": 1190.0 }
        });
        let q = &parse_spark(&body, &syms(&["RELIANCE.NS"]))[0];
        assert_eq!(q.price, Some(1226.4));
        assert_eq!(q.previous_close, Some(1243.9));
        assert_eq!(q.change_percent, Some(-1.407));
        assert_eq!(q.error, None);
    }

    #[test]
    fn parse_spark_derives_change_from_the_last_two_closes() {
        let body = json!({ "X": { "close": [95.0, 100.0, null, 110.0] } });
        let q = &parse_spark(&body, &syms(&["X"]))[0];
        assert_eq!(q.price, Some(110.0));
        assert_eq!(q.previous_close, Some(100.0));
        assert!((q.change_percent.unwrap() - 10.0).abs() < 1e-9);
    }

    #[test]
    fn parse_spark_with_a_single_close_falls_back_to_the_chart_previous_close() {
        let body = json!({ "X": { "close": [105.0], "chartPreviousClose": 100.0 } });
        let q = &parse_spark(&body, &syms(&["X"]))[0];
        assert_eq!(q.previous_close, Some(100.0));
        assert!((q.change_percent.unwrap() - 5.0).abs() < 1e-9);
    }

    #[test]
    fn parse_spark_answers_every_requested_symbol_in_order() {
        // Yahoo omits unknown tickers rather than erroring on the whole request.
        let body = json!({
            "AAPL": { "close": [1.0, 2.0], "fulldayPrice": 2.0 },
            "MSFT": { "close": [3.0, 4.0], "fulldayPrice": 4.0 },
            "EMPTY": { "close": [null, null] }
        });
        let quotes = parse_spark(&body, &syms(&["MSFT", "ZZZQQQ", "AAPL", "EMPTY"]));
        let summary: Vec<_> = quotes
            .iter()
            .map(|q| (q.symbol.as_str(), q.price, q.error.is_some()))
            .collect();
        assert_eq!(
            summary,
            [
                ("MSFT", Some(4.0), false),
                ("ZZZQQQ", None, true),
                ("AAPL", Some(2.0), false),
                ("EMPTY", None, true)
            ]
        );
        assert_eq!(quotes[1].error.as_deref(), Some("no data returned"));
    }

    #[test]
    fn parse_spark_matches_symbols_case_insensitively() {
        let body = json!({ "INFY.NS": { "close": [1.0, 2.0], "fulldayPrice": 2.0 } });
        let q = &parse_spark(&body, &syms(&["infy.ns"]))[0];
        assert_eq!(q.symbol, "infy.ns", "the caller's spelling is kept");
        assert_eq!(q.price, Some(2.0));
    }

    #[test]
    fn parse_spark_reports_a_rejected_request_against_every_symbol() {
        let body = json!({ "spark": { "result": null, "error": {
            "code": "Bad Request", "description": "Number of symbols needs to be less than or equal to 20" } } });
        let quotes = parse_spark(&body, &syms(&["A", "B"]));
        assert_eq!(quotes.len(), 2);
        assert!(quotes.iter().all(|q| q
            .error
            .as_deref()
            .is_some_and(|e| e.contains("less than or equal to 20"))));
    }
}
