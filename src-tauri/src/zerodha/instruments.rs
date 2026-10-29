//! Zerodha's instrument master: the CSV that maps a trading symbol to the
//! `instrument_token` every Kite API call needs. It is published per exchange
//! (`/instruments/NSE`, …), needs no credentials, and is mostly options; only
//! what can be charted (equities, indices, futures) is kept, which is about
//! 25k rows and searches instantly from SQLite.

use std::io::Read;

use rusqlite::Connection;

use crate::models::SymbolMatch;
pub use crate::store::instrument_list::Instrument;
use crate::store::instrument_list::{self, Source};

/// The exchanges whose lists are downloaded. Each file carries its own
/// options, which are dropped.
pub const EXCHANGES: [&str; 7] = ["NSE", "BSE", "NFO", "BFO", "MCX", "CDS", "BCD"];

/// How Kite's quote requests name an instrument: `EXCHANGE:TRADINGSYMBOL`.
pub trait QuoteKey {
    fn quote_key(&self) -> String;
}

impl QuoteKey for Instrument {
    fn quote_key(&self) -> String {
        format!("{}:{}", self.exchange, self.symbol)
    }
}

/// The chart ticker for an exchange and trading symbol. Spaces become
/// underscores (`NIFTY_50`) so a ticker never contains whitespace.
pub fn make_ticker(exchange: &str, symbol: &str) -> String {
    format!("{exchange}:{}", symbol.trim().to_uppercase().replace(' ', "_"))
}

const MONTHS: [&str; 12] = [
    "JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
];

/// `NIFTY SEP 26 FUT` from a name and a `YYYY-MM-DD` expiry.
fn future_name(name: &str, expiry: &str) -> String {
    let month = expiry
        .get(5..7)
        .and_then(|m| m.parse::<usize>().ok())
        .and_then(|m| MONTHS.get(m.wrapping_sub(1)));
    match (month, expiry.get(2..4)) {
        (Some(m), Some(yy)) => format!("{name} {m} {yy} FUT"),
        _ => format!("{name} FUT"),
    }
}

/// Parses one exchange's list, keeping chartable rows. `today` is
/// `YYYY-MM-DD`; expired futures are dropped.
pub fn parse_master(reader: impl Read, today: &str) -> Result<Vec<Instrument>, String> {
    let mut csv = csv::ReaderBuilder::new().flexible(true).from_reader(reader);
    let headers = csv
        .headers()
        .map_err(|e| format!("the instrument list has no header row: {e}"))?
        .clone();
    let col = |name: &str| {
        headers
            .iter()
            .position(|h| h.trim_start_matches('\u{feff}') == name)
            .ok_or_else(|| format!("the instrument list has no {name} column — Zerodha may have changed its format"))
    };
    let (c_token, c_symbol, c_name, c_expiry) = (
        col("instrument_token")?,
        col("tradingsymbol")?,
        col("name")?,
        col("expiry")?,
    );
    let (c_type, c_segment, c_exchange) = (col("instrument_type")?, col("segment")?, col("exchange")?);

    let mut out = Vec::with_capacity(12_000);
    let mut seen = std::collections::HashSet::new();
    for record in csv.records() {
        let Ok(r) = record else { continue };
        let get = |i: usize| r.get(i).unwrap_or("").trim();

        // Options (CE/PE) are left out: there are ~100k of them and they would
        // drown every search.
        let instrument = match (get(c_type), get(c_segment)) {
            ("EQ", "INDICES") => "INDEX",
            ("EQ", "NSE" | "BSE") => "EQUITY",
            ("FUT", segment) if segment.ends_with("-FUT") => "FUT",
            _ => continue,
        };
        let Ok(token) = get(c_token).parse::<i64>() else {
            continue;
        };
        let (symbol, exchange) = (get(c_symbol), get(c_exchange));
        if symbol.is_empty() || exchange.is_empty() {
            continue;
        }

        let expiry = (instrument == "FUT")
            .then(|| get(c_expiry))
            .filter(|d| d.len() == 10 && d.as_bytes().get(4) == Some(&b'-'))
            .map(str::to_string);
        if expiry.as_deref().is_some_and(|d| d < today) {
            continue;
        }

        let ticker = make_ticker(exchange, symbol);
        if !seen.insert(ticker.clone()) {
            continue;
        }
        let base = Some(get(c_name)).filter(|n| !n.is_empty()).unwrap_or(symbol);
        let name = match (&expiry, instrument) {
            (Some(e), "FUT") => future_name(base, e),
            _ => base.to_string(),
        };
        out.push(Instrument {
            ticker,
            exchange: exchange.to_string(),
            token,
            instrument: instrument.to_string(),
            symbol: symbol.to_string(),
            name: Some(name),
            expiry,
        });
    }
    Ok(out)
}

// ---- Storage ---------------------------------------------------------------
//
// Zerodha's own table (`zerodha_instruments`), through the code both brokers share.

/// Replaces the stored instrument list. One transaction, so a failed refresh
/// never leaves search half-empty.
pub fn replace_all(conn: &mut Connection, items: &[Instrument]) -> rusqlite::Result<usize> {
    instrument_list::replace_all(conn, Source::Zerodha, items)
}

pub fn count(conn: &Connection) -> rusqlite::Result<i64> {
    instrument_list::count(conn, Source::Zerodha)
}

/// Looks an instrument up by chart ticker (`NSE:RELIANCE`, or just `RELIANCE`); see
/// [`instrument_list::resolve`].
pub fn resolve(conn: &Connection, ticker: &str) -> rusqlite::Result<Option<Instrument>> {
    instrument_list::resolve(conn, Source::Zerodha, ticker)
}

pub fn search(conn: &Connection, query: &str, limit: usize) -> rusqlite::Result<Vec<SymbolMatch>> {
    instrument_list::search(conn, Source::Zerodha, query, limit)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use crate::store::instrument_list::normalize_ticker;

    const HEADER: &str =
        "instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange";

    /// A miniature master with one of each kind of row, in Zerodha's real layout
    /// (rows taken from the public lists).
    fn master() -> String {
        [
            HEADER,
            r#"256265,1001,NIFTY 50,"NIFTY 50",0,,0,0,0,EQ,INDICES,NSE"#,
            r#"260105,1016,NIFTY BANK,"NIFTY BANK",0,,0,0,0,EQ,INDICES,NSE"#,
            r#"738561,2885,RELIANCE,"RELIANCE INDUSTRIES",0,,0,0.1,1,EQ,NSE,NSE"#,
            r#"519937,2031,M&M,"MAHINDRA & MAHINDRA",0,,0,0.1,1,EQ,NSE,NSE"#,
            r#"4267265,16669,BAJAJ-AUTO,"BAJAJ AUTO",0,,0,0.5,1,EQ,NSE,NSE"#,
            r#"128083204,500325,RELIANCE,"RELIANCE INDUSTRIES",0,,0,0.05,1,EQ,BSE,BSE"#,
            r#"265,1,SENSEX,"SENSEX",0,,0,0,0,EQ,INDICES,BSE"#,
            r#"17512194,68407,NIFTY26SEPFUT,"NIFTY",0,2026-09-29,0,0.1,65,FUT,NFO-FUT,NFO"#,
            r#"12468226,48704,NIFTY26OCTFUT,"NIFTY",0,2026-10-27,0,0.1,65,FUT,NFO-FUT,NFO"#,
            r#"15736578,61471,NIFTY26NOVFUT,"NIFTY",0,2026-11-23,0,0.1,65,FUT,NFO-FUT,NFO"#,
            r#"16000001,61472,NIFTY26DECFUT,"NIFTY",0,2026-12-29,0,0.1,65,FUT,NFO-FUT,NFO"#,
            r#"9999991,1,NIFTY20JANFUT,"NIFTY",0,2020-01-30,0,0.1,75,FUT,NFO-FUT,NFO"#,
            r#"11111111,2,NIFTY26SEP25000CE,"NIFTY",0,2026-09-29,25000,0.05,65,CE,NFO-OPT,NFO"#,
            r#"22222222,3,NIFTY26SEP25000PE,"NIFTY",0,2026-09-29,25000,0.05,65,PE,NFO-OPT,NFO"#,
            r#"146251783,571296,ALUMINI26SEPFUT,"ALUMINI",0,2026-09-30,0,0.05,1,FUT,MCX-FUT,MCX"#,
        ]
        .join("\n")
    }

    /// The sample list plus stocks NSE trades in special series.
    fn with_series_stocks() -> Database {
        let extra = [
            HEADER,
            r#"1000001,3001,HFCL-BE,"HFCL LIMITED",0,,0,0.05,1,EQ,NSE,NSE"#,
            r#"1000002,3002,KODYTECH-ST,"KODY TECHNOLAB",0,,0,0.05,1,EQ,NSE,NSE"#,
            r#"1000003,3003,HFCL-BZ,"HFCL LIMITED (OTHER SERIES)",0,,0,0.05,1,EQ,NSE,NSE"#,
            r#"1000004,3004,BAJAJ,"BAJAJ LIMITED",0,,0,0.05,1,EQ,BSE,BSE"#,
        ]
        .join("\n");
        let mut all = parsed();
        all.extend(parse_master(extra.as_bytes(), "2026-09-19").unwrap());
        let db = Database::open_in_memory().unwrap();
        replace_all(&mut db.conn.lock().unwrap(), &all).unwrap();
        db
    }

    fn found(db: &Database, ticker: &str) -> Option<String> {
        resolve(&db.conn.lock().unwrap(), ticker).unwrap().map(|i| i.ticker)
    }

    #[test]
    fn a_stock_listed_under_an_nse_series_is_found_by_its_bare_name() {
        let db = with_series_stocks();
        assert_eq!(found(&db, "NSE:KODYTECH").as_deref(), Some("NSE:KODYTECH-ST"));
        assert_eq!(
            found(&db, "kodytech").as_deref(),
            Some("NSE:KODYTECH-ST"),
            "bare and lower-case"
        );
        // The bare name and the full one are the same instrument.
        let bare = resolve(&db.conn.lock().unwrap(), "NSE:KODYTECH").unwrap().unwrap();
        let full = resolve(&db.conn.lock().unwrap(), "NSE:KODYTECH-ST").unwrap().unwrap();
        assert_eq!(bare.token, full.token);
    }

    #[test]
    fn with_several_series_the_be_one_is_taken() {
        assert_eq!(found(&with_series_stocks(), "NSE:HFCL").as_deref(), Some("NSE:HFCL-BE"));
    }

    #[test]
    fn an_exact_match_always_beats_a_series_one() {
        let db = with_series_stocks();
        assert_eq!(found(&db, "NSE:RELIANCE").as_deref(), Some("NSE:RELIANCE"));
        assert_eq!(found(&db, "NSE:BAJAJ-AUTO").as_deref(), Some("NSE:BAJAJ-AUTO"));
    }

    #[test]
    fn a_series_match_never_borrows_a_different_company_that_shares_a_prefix() {
        let db = with_series_stocks();
        // NSE:BAJAJ-AUTO exists, but it is not NSE:BAJAJ, whose only listing is BSE's.
        assert_eq!(found(&db, "NSE:BAJAJ"), None);
        assert_eq!(found(&db, "BSE:BAJAJ").as_deref(), Some("BSE:BAJAJ"));
        assert_eq!(found(&db, "NSE:BAJ"), None);
    }

    #[test]
    fn only_nse_stocks_get_the_series_fallback() {
        let db = with_series_stocks();
        assert_eq!(found(&db, "BSE:HFCL"), None);
        assert_eq!(found(&db, "NFO:HFCL"), None);
        assert_eq!(found(&db, "NSE:NOSUCHSTOCK"), None);
    }

    fn parsed() -> Vec<Instrument> {
        parse_master(master().as_bytes(), "2026-09-19").unwrap()
    }

    fn store() -> Database {
        let db = Database::open_in_memory().unwrap();
        replace_all(&mut db.conn.lock().unwrap(), &parsed()).unwrap();
        db
    }

    #[test]
    fn tickers_use_underscores_and_keep_the_symbols_own_punctuation() {
        assert_eq!(make_ticker("NSE", "NIFTY 50"), "NSE:NIFTY_50");
        assert_eq!(make_ticker("NSE", "m&m"), "NSE:M&M");
        assert_eq!(make_ticker("NSE", "BAJAJ-AUTO"), "NSE:BAJAJ-AUTO");
        assert_eq!(normalize_ticker("reliance"), "NSE:RELIANCE");
        assert_eq!(normalize_ticker("bse:sensex"), "BSE:SENSEX");
        assert_eq!(normalize_ticker(" nifty 50 "), "NSE:NIFTY_50");
    }

    #[test]
    fn the_master_keeps_equities_indices_and_live_futures_and_drops_the_rest() {
        let tickers: Vec<_> = parsed().into_iter().map(|i| i.ticker).collect();
        assert!(tickers.contains(&"NSE:RELIANCE".to_string()));
        assert!(
            tickers.contains(&"BSE:RELIANCE".to_string()),
            "same symbol on two exchanges"
        );
        assert!(tickers.contains(&"NSE:NIFTY_50".to_string()));
        assert!(tickers.contains(&"BSE:SENSEX".to_string()));
        assert!(tickers.contains(&"NFO:NIFTY26SEPFUT".to_string()));
        assert!(tickers.contains(&"MCX:ALUMINI26SEPFUT".to_string()));
        assert!(!tickers.iter().any(|t| t.contains("25000")), "options are excluded");
        assert!(
            !tickers.iter().any(|t| t.contains("20JAN")),
            "expired futures are dropped"
        );
        assert_eq!(tickers.len(), 12, "3 indices, 4 equities and 5 futures");
    }

    #[test]
    fn each_row_carries_the_token_kind_and_a_readable_name() {
        let all = parsed();
        let by = |t: &str| all.iter().find(|i| i.ticker == t).unwrap();
        let reliance = by("NSE:RELIANCE");
        assert_eq!((reliance.token, reliance.instrument.as_str()), (738561, "EQUITY"));
        assert_eq!(reliance.name.as_deref(), Some("RELIANCE INDUSTRIES"));
        let nifty = by("NSE:NIFTY_50");
        assert_eq!((nifty.token, nifty.instrument.as_str()), (256265, "INDEX"));
        assert_eq!(
            nifty.symbol, "NIFTY 50",
            "the trading symbol keeps its space for API calls"
        );
        let fut = by("NFO:NIFTY26SEPFUT");
        assert_eq!(fut.instrument, "FUT");
        assert_eq!(fut.expiry.as_deref(), Some("2026-09-29"));
        assert_eq!(fut.name.as_deref(), Some("NIFTY SEP 26 FUT"));
    }

    #[test]
    fn quote_requests_name_an_instrument_by_exchange_and_trading_symbol() {
        let all = parsed();
        let nifty = all.iter().find(|i| i.ticker == "NSE:NIFTY_50").unwrap();
        assert_eq!(nifty.quote_key(), "NSE:NIFTY 50");
        let mm = all.iter().find(|i| i.ticker == "NSE:M&M").unwrap();
        assert_eq!(mm.quote_key(), "NSE:M&M");
    }

    #[test]
    fn a_master_without_the_expected_columns_is_rejected_with_a_clear_message() {
        let err = parse_master("foo,bar\n1,2\n".as_bytes(), "2026-09-19").unwrap_err();
        assert!(err.contains("instrument_token"), "{err}");
    }

    #[test]
    fn rows_with_a_bad_token_or_no_symbol_are_skipped_not_fatal() {
        let csv = [
            HEADER,
            r#"abc,1,BROKEN,"X",0,,0,0,1,EQ,NSE,NSE"#,
            r#"1,1,,"NO SYMBOL",0,,0,0,1,EQ,NSE,NSE"#,
            r#"738561,2885,RELIANCE,"RELIANCE INDUSTRIES",0,,0,0.1,1,EQ,NSE,NSE"#,
        ]
        .join("\n");
        assert_eq!(parse_master(csv.as_bytes(), "2026-09-19").unwrap().len(), 1);
    }

    #[test]
    fn replacing_the_list_swaps_it_atomically_and_resolve_finds_rows() {
        let db = store();
        let conn = db.conn.lock().unwrap();
        assert_eq!(count(&conn).unwrap(), 12);
        assert_eq!(resolve(&conn, "NSE:RELIANCE").unwrap().unwrap().token, 738561);
        assert_eq!(
            resolve(&conn, "reliance").unwrap().unwrap().exchange,
            "NSE",
            "bare means NSE"
        );
        assert_eq!(resolve(&conn, "NSE:NIFTY_50").unwrap().unwrap().token, 256265);
        assert_eq!(resolve(&conn, "nse:nifty 50").unwrap().unwrap().token, 256265);
        assert!(resolve(&conn, "NSE:NOPE").unwrap().is_none());
    }

    #[test]
    fn search_ranks_exact_then_prefix_and_prefers_nse_and_indices() {
        let db = store();
        let conn = db.conn.lock().unwrap();
        let hits = search(&conn, "reliance", 8).unwrap();
        assert_eq!(hits[0].symbol, "NSE:RELIANCE");
        assert_eq!(hits[1].symbol, "BSE:RELIANCE");
        assert_eq!(hits[0].kind.as_deref(), Some("EQUITY"));

        let nifty = search(&conn, "nifty", 8).unwrap();
        assert_eq!(nifty[0].symbol, "NSE:NIFTY_50", "an index outranks the futures on it");
        assert!(nifty.iter().any(|m| m.symbol == "NSE:NIFTY_BANK"));
    }

    #[test]
    fn search_finds_names_symbols_with_spaces_and_odd_punctuation() {
        let db = store();
        let conn = db.conn.lock().unwrap();
        assert_eq!(search(&conn, "mahindra", 5).unwrap()[0].symbol, "NSE:M&M");
        assert_eq!(search(&conn, "nifty bank", 5).unwrap()[0].symbol, "NSE:NIFTY_BANK");
        assert_eq!(search(&conn, "nifty_bank", 5).unwrap()[0].symbol, "NSE:NIFTY_BANK");
        assert_eq!(search(&conn, "bajaj-auto", 5).unwrap()[0].symbol, "NSE:BAJAJ-AUTO");
        assert_eq!(search(&conn, "sensex", 5).unwrap()[0].symbol, "BSE:SENSEX");
    }

    #[test]
    fn a_short_list_caps_futures_but_a_scoped_search_shows_them_all() {
        let db = store();
        let conn = db.conn.lock().unwrap();
        let short = search(&conn, "nifty", 8).unwrap();
        assert_eq!(short.iter().filter(|m| m.kind.as_deref() == Some("FUT")).count(), 3);
        let long = search(&conn, "nifty", 20).unwrap();
        assert_eq!(long.iter().filter(|m| m.kind.as_deref() == Some("FUT")).count(), 4);
    }

    #[test]
    fn separator_only_queries_match_nothing() {
        let db = store();
        let conn = db.conn.lock().unwrap();
        for q in ["_", "%", "-", " ", "&"] {
            assert!(search(&conn, q, 8).unwrap().is_empty(), "{q:?}");
        }
    }
}
