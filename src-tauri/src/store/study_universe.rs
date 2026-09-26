//! What a Study's universe will cost before it runs: which listings count as stocks, and how many of
//! them the research store already holds back far enough.
//!
//! `listing_series` and `pick_listings` are the engine's own rules (`python/protrade/study.py`,
//! same names): the estimate must count the symbols the run will fetch. Keep the two in step — the
//! tests here use the same cases as `UniverseTests` there.

use std::collections::HashSet;

use rusqlite::Connection;

use super::research_bars;

const DAY_MS: i64 = 86_400_000;
/// Words that mark a fund rather than a company, in a ticker or a name.
const FUND_WORDS: [&str; 6] = ["ETF", "FOF", "FUND", "BEES", "INVIT", "REIT"];
/// Words two exchanges disagree on in a company's name.
const COMPANY_NOISE: [&str; 3] = ["LIMITED", "LTD", "THE"];

fn words(text: &str) -> impl Iterator<Item = &str> {
    text.split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
}

fn fund_like(text: &str) -> bool {
    let upper = text.trim().to_ascii_uppercase();
    upper.ends_with("BEES") || upper.ends_with("ETF") || words(&upper).any(|w| FUND_WORDS.contains(&w))
}

/// `"EQ"`, `"BE"` or `"SME"` for a listing that is a stock, `None` for anything else an exchange lists
/// as equity (bonds, SGBs, G-secs, T-bills, funds). `ticker` is without its exchange.
pub fn listing_series(ticker: &str, name: Option<&str>) -> Option<&'static str> {
    let ticker = ticker.trim().to_ascii_uppercase();
    let first = ticker.chars().next()?;
    if let Some((_, suffix)) = ticker.rsplit_once('-') {
        return match suffix {
            "BE" | "BZ" => Some("BE"),
            "SM" | "ST" | "SZ" => Some("SME"),
            _ => None,
        };
    }
    if first.is_ascii_digit() || fund_like(&ticker) || name.is_some_and(fund_like) {
        return None;
    }
    Some("EQ")
}

fn company_key(name: Option<&str>) -> Option<String> {
    let upper = name?.to_ascii_uppercase();
    let key: String = words(&upper).filter(|w| !COMPANY_NOISE.contains(w)).collect();
    (!key.is_empty()).then_some(key)
}

/// `(symbol, name)` rows, in order, reduced to one listing per company among `series`: a company on
/// two exchanges is kept on the first one seen, matched by ticker or by name.
pub fn pick_listings(rows: &[(String, Option<String>)], series: &[String]) -> Vec<String> {
    let (mut out, mut tickers, mut companies) = (Vec::new(), HashSet::new(), HashSet::new());
    for (symbol, name) in rows {
        let ticker = symbol.rsplit(':').next().unwrap_or(symbol).to_ascii_uppercase();
        let Some(kind) = listing_series(&ticker, name.as_deref()) else {
            continue;
        };
        if !series.iter().any(|s| s == kind) {
            continue;
        }
        let base = if kind == "EQ" {
            ticker.clone()
        } else {
            ticker.rsplit_once('-').map_or(ticker.clone(), |(b, _)| b.to_string())
        };
        let company = company_key(name.as_deref());
        if tickers.contains(&base) || company.as_ref().is_some_and(|c| companies.contains(c)) {
            continue;
        }
        tickers.insert(base);
        if let Some(c) = company {
            companies.insert(c);
        }
        out.push(symbol.clone());
    }
    out
}

#[derive(Debug, Clone, PartialEq)]
pub struct Estimate {
    pub symbols: usize,
    /// Already held from far enough back: at most a top-up of the newest bars.
    pub stored: usize,
    /// Broker requests the run is expected to make, and how long they take at the broker's pace.
    pub requests: usize,
    pub seconds: f64,
}

/// What loading `symbols`' daily bars from `from_ms` will cost. A symbol not held back to `from_ms`
/// costs one request per `window_days` of span; a held one whose newest bar is more than a day old
/// is counted as one more (a top-up) — an upper bound, since a weekend or holiday needs none.
pub fn estimate(
    conn: &Connection,
    symbols: &[String],
    from_ms: i64,
    now_ms: i64,
    window_days: i64,
    gap_ms: u64,
) -> rusqlite::Result<Estimate> {
    let per_symbol = ((now_ms - from_ms).max(DAY_MS) + window_days * DAY_MS - 1) / (window_days * DAY_MS);
    let (mut stored, mut requests) = (0usize, 0usize);
    for symbol in symbols {
        match research_bars::coverage(conn, symbol, "D")? {
            Some(c) if c.from_ms <= from_ms => {
                stored += 1;
                if c.to_ms < now_ms - DAY_MS {
                    requests += 1;
                }
            }
            _ => requests += per_symbol as usize,
        }
    }
    Ok(Estimate {
        symbols: symbols.len(),
        stored,
        requests,
        seconds: requests as f64 * gap_ms as f64 / 1000.0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use crate::store::research_bars::Range;

    #[test]
    fn only_shares_count_as_stocks_as_in_the_engine() {
        let cases: [(&str, Option<&str>, Option<&str>); 14] = [
            ("RELIANCE", Some("RELIANCE INDUSTRIES"), Some("EQ")),
            ("XYZ-BE", Some("XYZ"), Some("BE")),
            ("XYZ-BZ", Some("XYZ"), Some("BE")),
            ("ABC-SM", Some("ABC"), Some("SME")),
            ("ABC-ST", Some("ABC"), Some("SME")),
            ("IRFC-N2", Some("IRFC"), None),
            ("SGBAUG28V-GB", Some("SGB"), None),
            ("GS2030-GS", Some("GOI"), None),
            ("364D210226", Some("TBILL"), None),
            ("1030FC24", Some("ABC FINANCE NCD"), None),
            ("NIFTYBEES", Some("NIPPON INDIA ETF NIFTY BEES"), None),
            ("GOLDETF", None, None),
            ("EMBASSY-RR", Some("EMBASSY OFFICE PARKS REIT"), None),
            ("", None, None),
        ];
        for (ticker, name, expected) in cases {
            assert_eq!(listing_series(ticker, name), expected, "{ticker}");
        }
    }

    #[test]
    fn a_company_on_two_exchanges_is_counted_once_as_in_the_engine() {
        let rows: Vec<(String, Option<String>)> = [
            ("zerodha:NSE:RELIANCE", "RELIANCE INDUSTRIES"),
            ("zerodha:NSE:IRFC-N2", "IRFC"),
            ("zerodha:NSE:XYZ-BE", "XYZ"),
            ("zerodha:BSE:RELIANCE", "Reliance Industries Ltd."),
            ("zerodha:BSE:RELIND", "RELIANCE INDUSTRIES LIMITED"),
            ("zerodha:BSE:XYZ", "XYZ Ltd"),
            ("zerodha:BSE:BSEONLY", "BSE ONLY LTD"),
        ]
        .iter()
        .map(|(s, n)| (s.to_string(), Some(n.to_string())))
        .collect();
        let eq = ["EQ".to_string()];
        assert_eq!(
            pick_listings(&rows, &eq),
            ["zerodha:NSE:RELIANCE", "zerodha:BSE:XYZ", "zerodha:BSE:BSEONLY"]
        );
        let eq_be = ["EQ".to_string(), "BE".to_string()];
        assert_eq!(
            pick_listings(&rows, &eq_be),
            ["zerodha:NSE:RELIANCE", "zerodha:NSE:XYZ-BE", "zerodha:BSE:BSEONLY"]
        );
    }

    #[test]
    fn stored_series_cost_at_most_a_top_up_and_new_ones_a_request_per_window() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        let now = 3_000 * DAY_MS;
        let from = now - 1_500 * DAY_MS;
        let cover = |symbol: &str, from_ms: i64, to_ms: i64| {
            research_bars::extend_coverage(&conn, symbol, "D", Range { from_ms, to_ms }, now).unwrap();
        };
        cover("zerodha:NSE:FRESH", from - DAY_MS, now);
        cover("zerodha:NSE:OLD", from, now - 5 * DAY_MS);
        cover("zerodha:NSE:SHORT", from + 100 * DAY_MS, now);
        let symbols: Vec<String> = [
            "zerodha:NSE:FRESH",
            "zerodha:NSE:OLD",
            "zerodha:NSE:SHORT",
            "zerodha:NSE:NEW",
        ]
        .map(String::from)
        .to_vec();
        let e = estimate(&conn, &symbols, from, now, 2000, 350).unwrap();
        assert_eq!(
            (e.symbols, e.stored, e.requests),
            (4, 2, 3),
            "OLD tops up, SHORT and NEW fetch"
        );
        assert!((e.seconds - 1.05).abs() < 1e-9);
        // A span longer than one request's window costs a request per window.
        let long = estimate(&conn, &symbols[3..], now - 4_500 * DAY_MS, now, 2000, 350).unwrap();
        assert_eq!(long.requests, 3);
    }
}
