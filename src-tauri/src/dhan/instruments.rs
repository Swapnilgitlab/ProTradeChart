//! Dhan's instrument master: the CSV that maps a trading symbol to the
//! `SecurityId` every Dhan API call needs. It's ~26 MB with ~200k rows,
//! mostly options; only what can be charted (equities, indices, futures) is
//! kept, which is ~25k rows and searches instantly from SQLite.

use std::io::Read;

use rusqlite::{params, Connection, OptionalExtension};

use super::Segment;
use crate::models::SymbolMatch;

pub const MASTER_CSV_URL: &str = "https://images.dhan.co/api-data/api-scrip-master.csv";

#[derive(Debug, Clone, PartialEq)]
pub struct Instrument {
    /// `NSE:RELIANCE` — the chart symbol without its `dhan:` prefix.
    pub ticker: String,
    pub exchange: String,
    pub segment: Segment,
    pub security_id: i64,
    /// Dhan's own instrument type (`EQUITY`, `INDEX`, `FUTIDX`, …), sent back on history requests.
    pub instrument: String,
    pub symbol: String,
    pub name: Option<String>,
    /// `YYYY-MM-DD`, for futures.
    pub expiry: Option<String>,
}

/// Instrument types worth charting. Options are deliberately left out: there
/// are ~150k of them and they would drown every search.
const KEEP_INSTRUMENTS: [&str; 6] = ["EQUITY", "INDEX", "FUTIDX", "FUTSTK", "FUTCOM", "FUTCUR"];
/// Within EQUITY, the exchange types that are stocks and funds, not bonds.
const KEEP_EQUITY_TYPES: [&str; 4] = ["ES", "ETF", "REIT", "InvITU"];

fn segment_for(exchange: &str, segment: &str) -> Option<Segment> {
    Some(match (exchange, segment) {
        (_, "I") => Segment::IdxI,
        ("NSE", "E") => Segment::NseEq,
        ("BSE", "E") => Segment::BseEq,
        ("NSE", "D") => Segment::NseFno,
        ("BSE", "D") => Segment::BseFno,
        ("NSE", "C") => Segment::NseCurrency,
        ("BSE", "C") => Segment::BseCurrency,
        ("MCX", "M") => Segment::McxComm,
        _ => return None,
    })
}

/// The chart ticker for an exchange and trading symbol. Spaces become
/// underscores (`NIFTY_MIDCAP_150`) so a ticker never contains whitespace.
pub fn make_ticker(exchange: &str, symbol: &str) -> String {
    format!("{exchange}:{}", symbol.trim().to_uppercase().replace(' ', "_"))
}

/// Normalises typed or stored text to a ticker key: upper-case, spaces to
/// underscores, and a bare symbol assumed to be NSE.
pub fn normalize_ticker(text: &str) -> String {
    let t = text.trim().to_uppercase().replace(' ', "_");
    if t.contains(':') {
        t
    } else {
        format!("NSE:{t}")
    }
}

/// Parses the compact instrument master, keeping chartable rows. `today` is
/// `YYYY-MM-DD`; expired futures are dropped. When two rows share a ticker
/// (weekly currency futures) the first wins.
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
            .ok_or_else(|| format!("the instrument list has no {name} column — Dhan may have changed its format"))
    };
    let (c_exch, c_seg, c_id, c_inst) = (
        col("SEM_EXM_EXCH_ID")?,
        col("SEM_SEGMENT")?,
        col("SEM_SMST_SECURITY_ID")?,
        col("SEM_INSTRUMENT_NAME")?,
    );
    let (c_symbol, c_custom, c_expiry) = (
        col("SEM_TRADING_SYMBOL")?,
        col("SEM_CUSTOM_SYMBOL")?,
        col("SEM_EXPIRY_DATE")?,
    );
    let (c_etype, c_name) = (col("SEM_EXCH_INSTRUMENT_TYPE")?, col("SM_SYMBOL_NAME")?);

    let mut out = Vec::with_capacity(30_000);
    let mut seen = std::collections::HashSet::new();
    for record in csv.records() {
        let Ok(r) = record else { continue };
        let get = |i: usize| r.get(i).unwrap_or("").trim();

        let instrument = get(c_inst);
        if !KEEP_INSTRUMENTS.contains(&instrument) {
            continue;
        }
        if instrument == "EQUITY" && !KEEP_EQUITY_TYPES.contains(&get(c_etype)) {
            continue;
        }
        let Some(segment) = segment_for(get(c_exch), get(c_seg)) else {
            continue;
        };
        let Ok(security_id) = get(c_id).parse::<i64>() else {
            continue;
        };
        let symbol = get(c_symbol);
        if symbol.is_empty() {
            continue;
        }

        let is_future = instrument.starts_with("FUT");
        let expiry = get(c_expiry)
            .get(..10)
            .filter(|d| is_future && d.as_bytes().get(4) == Some(&b'-'))
            .map(str::to_string);
        if expiry.as_deref().is_some_and(|d| d < today) {
            continue;
        }

        let ticker = make_ticker(segment.exchange(), symbol);
        if !seen.insert(ticker.clone()) {
            continue;
        }
        // For companies the long legal name is the useful one. For an index it
        // just repeats the trading symbol, and for a future it's an abbreviation
        // ("RELIFUT"); the display name ("Nifty Bank", "RELIANCE NOV FUT") is what
        // people read and type.
        let candidates = if instrument == "INDEX" || instrument.starts_with("FUT") {
            [get(c_custom), get(c_name)]
        } else {
            [get(c_name), get(c_custom)]
        };
        let name = candidates.into_iter().find(|s| !s.is_empty()).map(str::to_string);
        out.push(Instrument {
            ticker,
            exchange: segment.exchange().to_string(),
            segment,
            security_id,
            instrument: instrument.to_string(),
            symbol: symbol.to_string(),
            name,
            expiry,
        });
    }
    Ok(out)
}

// ---- Storage ---------------------------------------------------------------

/// Replaces the stored instrument list. One transaction, so a failed refresh
/// never leaves search half-empty.
pub fn replace_all(conn: &mut Connection, items: &[Instrument]) -> rusqlite::Result<usize> {
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM dhan_instruments", [])?;
    {
        let mut stmt = tx.prepare(
            "INSERT OR IGNORE INTO dhan_instruments (ticker, exchange, segment, security_id, instrument, symbol, name, expiry)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        )?;
        for i in items {
            stmt.execute(params![
                i.ticker,
                i.exchange,
                i.segment.code(),
                i.security_id,
                i.instrument,
                i.symbol,
                i.name,
                i.expiry
            ])?;
        }
    }
    tx.commit()?;
    count(conn).map(|n| n as usize)
}

pub fn count(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row("SELECT COUNT(*) FROM dhan_instruments", [], |r| r.get(0))
}

fn from_row(r: &rusqlite::Row) -> rusqlite::Result<Instrument> {
    let segment = Segment::from_code(r.get::<_, i64>(2)?).unwrap_or(Segment::NseEq);
    Ok(Instrument {
        ticker: r.get(0)?,
        exchange: r.get(1)?,
        segment,
        security_id: r.get(3)?,
        instrument: r.get(4)?,
        symbol: r.get(5)?,
        name: r.get(6)?,
        expiry: r.get(7)?,
    })
}

const COLUMNS: &str = "ticker, exchange, segment, security_id, instrument, symbol, name, expiry";

/// Looks an instrument up by chart ticker (`NSE:RELIANCE`, or just `RELIANCE`).
pub fn resolve(conn: &Connection, ticker: &str) -> rusqlite::Result<Option<Instrument>> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM dhan_instruments WHERE ticker = ?1"),
        params![normalize_ticker(ticker)],
        from_row,
    )
    .optional()
}

/// Lists up to this long are "short": they leave room for other providers' results.
const SHORT_LIST: usize = 10;
const MAX_DERIVATIVES_IN_SHORT_LIST: usize = 3;

fn escape_like(text: &str) -> String {
    text.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

/// Searches symbols and names. Exact symbol first, then prefix, then anywhere
/// in the symbol, then in the name; ties prefer indices over stocks over
/// futures, NSE over BSE, and shorter symbols.
pub fn search(conn: &Connection, query: &str, limit: usize) -> rusqlite::Result<Vec<SymbolMatch>> {
    // A short list is for picking a stock; a stock's dozen monthly futures would
    // crowd it out. A long list (someone scoped to Dhan) has room for them.
    let derivative_cap = if limit <= SHORT_LIST {
        MAX_DERIVATIVES_IN_SHORT_LIST
    } else {
        usize::MAX
    };
    let q = query.trim().to_lowercase();
    // A query of nothing but separators or wildcards ("_", "%", "-") would
    // match everything, which is never what was meant.
    if !q.chars().any(char::is_alphanumeric) {
        return Ok(Vec::new());
    }
    let exact = q.replace('_', " ");
    let (prefix, any) = (
        format!("{}%", escape_like(&exact)),
        format!("%{}%", escape_like(&exact)),
    );
    let ticker_prefix = format!("{}%", escape_like(&q.replace(' ', "_")));

    let mut stmt = conn.prepare(
        "SELECT ticker, name, exchange, instrument FROM dhan_instruments
         WHERE LOWER(symbol) LIKE ?3 ESCAPE '\\' OR LOWER(name) LIKE ?3 ESCAPE '\\' OR LOWER(ticker) LIKE ?4 ESCAPE '\\'
         ORDER BY
           CASE WHEN LOWER(symbol) = ?1 THEN 0
                WHEN LOWER(symbol) LIKE ?2 ESCAPE '\\' OR LOWER(ticker) LIKE ?4 ESCAPE '\\' THEN 1
                WHEN LOWER(symbol) LIKE ?3 ESCAPE '\\' THEN 2 ELSE 3 END,
           CASE instrument WHEN 'INDEX' THEN 0 WHEN 'EQUITY' THEN 1 ELSE 2 END,
           CASE exchange WHEN 'NSE' THEN 0 WHEN 'IDX' THEN 0 WHEN 'BSE' THEN 1 WHEN 'NFO' THEN 2 WHEN 'MCX' THEN 3
                         WHEN 'CDS' THEN 4 WHEN 'BFO' THEN 5 ELSE 6 END,
           LENGTH(symbol)
         LIMIT ?5",
    )?;
    // Over-fetch so that skipping surplus derivatives still leaves `limit` rows.
    let rows = stmt.query_map(params![exact, prefix, any, ticker_prefix, (limit * 6) as i64], |r| {
        Ok(SymbolMatch {
            symbol: r.get(0)?,
            name: r.get(1)?,
            exchange: r.get(2)?,
            kind: r.get(3)?,
        })
    })?;

    let mut out = Vec::with_capacity(limit);
    let mut derivatives = 0;
    for row in rows {
        let m = row?;
        if m.kind.as_deref().is_some_and(|k| k.starts_with("FUT")) {
            derivatives += 1;
            if derivatives > derivative_cap {
                continue;
            }
        }
        out.push(m);
        if out.len() == limit {
            break;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    const HEADER: &str = "SEM_EXM_EXCH_ID,SEM_SEGMENT,SEM_SMST_SECURITY_ID,SEM_INSTRUMENT_NAME,SEM_EXPIRY_CODE,SEM_TRADING_SYMBOL,SEM_LOT_UNITS,SEM_CUSTOM_SYMBOL,SEM_EXPIRY_DATE,SEM_STRIKE_PRICE,SEM_OPTION_TYPE,SEM_TICK_SIZE,SEM_EXPIRY_FLAG,SEM_EXCH_INSTRUMENT_TYPE,SEM_SERIES,SM_SYMBOL_NAME";

    /// A miniature master with one of each kind of row, in Dhan's real layout.
    fn master() -> String {
        [
            HEADER,
            "NSE,E,2885,EQUITY,0,RELIANCE,1.0,Reliance Industries,,,,10.0000,NA,ES,EQ,RELIANCE INDUSTRIES LTD",
            "BSE,E,500325,EQUITY,0,RELIANCE,1.0,Reliance Industries,,,,5.0000,NA,ES,A,RELIANCE INDUSTRIES LTD.",
            "NSE,E,1594,EQUITY,0,INFY,1.0,Infosys,,,,10.0000,NA,ES,EQ,INFOSYS LIMITED",
            "NSE,E,3456,EQUITY,0,NIFTYBEES,1.0,Nippon Nifty BeES,,,,10.0000,NA,ETF,EQ,NIPPON INDIA ETF NIFTY 50 BEES",
            "NSE,E,777,EQUITY,0,SOMEBOND,1.0,A Bond,,,,10.0000,NA,DBT,N1,SOME BOND 2030",
            "NSE,I,13,INDEX,0,NIFTY,1.0,Nifty 50,0001-01-01,,XX,0.0500,,INDEX,X,NIFTY 50",
            "NSE,I,25,INDEX,0,NIFTY BANK,1.0,Nifty Bank,0001-01-01,,XX,0.0500,,INDEX,X,NIFTY BANK",
            "BSE,I,51,INDEX,0,SENSEX,1.0,SENSEX,0001-01-01,,XX,0.0500,,INDEX,X,SENSEX",
            "NSE,I,26,INDEX,0,BANKNIFTY,1.0,Nifty Bank,0001-01-01,,XX,0.0500,,INDEX,X,BANKNIFTY",
            "NSE,E,4567,EQUITY,0,SETFNIFBK,1.0,SBI Nifty Bank ETF,,,,10.0000,NA,ETF,EQ,SBI-ETF NIFTY BANK",
            "NSE,D,48699,FUTIDX,0,BANKNIFTY-Oct2026-FUT,30.0,BANKNIFTY OCT FUT,2026-10-27 14:30:00,-0.01000,XX,20.0000,M,FUT,,",
            "NSE,D,48700,FUTIDX,0,BANKNIFTY-Nov2026-FUT,30.0,BANKNIFTY NOV FUT,2026-11-24 14:30:00,-0.01000,XX,20.0000,M,FUT,,",
            "NSE,D,48701,FUTIDX,0,BANKNIFTY-Dec2026-FUT,30.0,BANKNIFTY DEC FUT,2026-12-29 14:30:00,-0.01000,XX,20.0000,M,FUT,,",
            "NSE,D,48702,FUTIDX,0,BANKNIFTY-Jan2027-FUT,30.0,BANKNIFTY JAN FUT,2027-01-26 14:30:00,-0.01000,XX,20.0000,M,FUT,,",
            "BSE,D,60001,FUTSTK,0,BANKNIFTY-Oct2026-FUT,30.0,BANKNIFTY BSE OCT FUT,2026-10-27 14:30:00,-0.01000,XX,20.0000,M,FUT,,BANKFUT",
            "NSE,D,11111,FUTIDX,0,BANKNIFTY-Aug2020-FUT,30.0,BANKNIFTY AUG FUT,2020-08-27 14:30:00,-0.01000,XX,20.0000,M,FUT,,",
            "NSE,D,22222,OPTIDX,0,NIFTY-Oct2026-25000-CE,75.0,NIFTY OCT 25000 CALL,2026-10-27 14:30:00,25000.0,CE,0.0500,M,OP,,",
            "MCX,M,483079,FUTCOM,0,GOLD-05Oct2026-FUT,1.0,GOLD OCT FUT,2026-10-05 23:30:00,0.0,XX,100.0000,M,FUTCOM,2,GOLD",
            "NSE,C,1119,FUTCUR,0,EURINR-Oct2026-FUT,1.0,EURINR 12 OCT FUT,2026-10-12 14:30:00,-0.01,XX,0.2500,W,FUT,,",
            "NSE,C,1255,FUTCUR,0,EURINR-Oct2026-FUT,1.0,EURINR 19 OCT FUT,2026-10-19 14:30:00,-0.01,XX,0.2500,W,FUT,,",
            "NSE,M,9999,FUTCOM,0,SOMETHING,1.0,X,2026-10-19 14:30:00,0,XX,1,W,FUT,,",
        ]
        .join("\n")
    }

    fn parsed() -> Vec<Instrument> {
        parse_master(master().as_bytes(), "2026-09-19").unwrap()
    }

    fn find<'a>(items: &'a [Instrument], ticker: &str) -> &'a Instrument {
        items
            .iter()
            .find(|i| i.ticker == ticker)
            .unwrap_or_else(|| panic!("{ticker} missing"))
    }

    #[test]
    fn keeps_stocks_indices_and_futures_and_drops_the_rest() {
        let items = parsed();
        let tickers: Vec<_> = items.iter().map(|i| i.ticker.as_str()).collect();
        for kept in [
            "NSE:RELIANCE",
            "BSE:RELIANCE",
            "NSE:INFY",
            "NSE:NIFTYBEES",
            "IDX:NIFTY",
            "IDX:SENSEX",
            "NFO:BANKNIFTY-OCT2026-FUT",
            "MCX:GOLD-05OCT2026-FUT",
        ] {
            assert!(tickers.contains(&kept), "{kept} should be kept: {tickers:?}");
        }
        assert!(!tickers.iter().any(|t| t.contains("SOMEBOND")), "bonds are dropped");
        assert!(!tickers.iter().any(|t| t.contains("-CE")), "options are dropped");
        assert!(
            !tickers.iter().any(|t| t.contains("SOMETHING")),
            "NSE commodity futures aren't a segment we chart"
        );
    }

    #[test]
    fn expired_futures_are_dropped_and_current_ones_keep_their_expiry() {
        let items = parsed();
        assert!(!items.iter().any(|i| i.ticker.contains("AUG2020")));
        assert_eq!(
            find(&items, "NFO:BANKNIFTY-OCT2026-FUT").expiry.as_deref(),
            Some("2026-10-27")
        );
        assert_eq!(find(&items, "NSE:RELIANCE").expiry, None);
        assert_eq!(
            find(&items, "IDX:NIFTY").expiry,
            None,
            "an index's placeholder date is not an expiry"
        );
    }

    #[test]
    fn rows_map_to_the_right_segment_security_id_and_name() {
        let items = parsed();
        let nse = find(&items, "NSE:RELIANCE");
        assert_eq!((nse.segment, nse.security_id), (Segment::NseEq, 2885));
        assert_eq!(nse.instrument, "EQUITY");
        assert_eq!(nse.name.as_deref(), Some("RELIANCE INDUSTRIES LTD"));
        assert_eq!(find(&items, "BSE:RELIANCE").segment, Segment::BseEq);
        assert_eq!(find(&items, "IDX:SENSEX").segment, Segment::IdxI);
        assert_eq!(find(&items, "MCX:GOLD-05OCT2026-FUT").segment, Segment::McxComm);
        // A future has no company name in the file; its display name stands in.
        assert_eq!(
            find(&items, "NFO:BANKNIFTY-OCT2026-FUT").name.as_deref(),
            Some("BANKNIFTY OCT FUT")
        );
    }

    #[test]
    fn an_index_is_named_by_its_display_name_and_a_company_by_its_legal_name() {
        let items = parsed();
        assert_eq!(find(&items, "IDX:BANKNIFTY").name.as_deref(), Some("Nifty Bank"));
        assert_eq!(
            find(&items, "NSE:RELIANCE").name.as_deref(),
            Some("RELIANCE INDUSTRIES LTD")
        );
    }

    #[test]
    fn a_future_is_named_by_its_display_name_not_the_exchanges_abbreviation() {
        let items = parsed();
        assert_eq!(
            find(&items, "BFO:BANKNIFTY-OCT2026-FUT").name.as_deref(),
            Some("BANKNIFTY BSE OCT FUT")
        );
    }

    #[test]
    fn spaces_in_symbols_become_underscores_in_tickers() {
        let items = parsed();
        let bank = find(&items, "IDX:NIFTY_BANK");
        assert_eq!(
            bank.symbol, "NIFTY BANK",
            "the original symbol is kept for display and search"
        );
    }

    #[test]
    fn duplicate_tickers_keep_the_first_row() {
        let items = parsed();
        let eur: Vec<_> = items.iter().filter(|i| i.ticker == "CDS:EURINR-OCT2026-FUT").collect();
        assert_eq!(eur.len(), 1);
        assert_eq!(eur[0].security_id, 1119);
    }

    #[test]
    fn a_file_with_missing_columns_is_reported_clearly() {
        let err = parse_master("A,B\n1,2\n".as_bytes(), "2026-01-01").unwrap_err();
        assert!(err.contains("SEM_EXM_EXCH_ID"), "{err}");
    }

    #[test]
    fn a_byte_order_mark_and_short_rows_are_tolerated() {
        let text = format!(
            "\u{feff}{}\nNSE,E,1\n{}",
            HEADER, "NSE,E,2885,EQUITY,0,RELIANCE,1.0,Reliance,,,,10,NA,ES,EQ,RELIANCE LTD"
        );
        let items = parse_master(text.as_bytes(), "2026-01-01").unwrap();
        assert_eq!(items.len(), 1);
    }

    // ---- storage & search ----

    fn loaded() -> Database {
        let db = Database::open_in_memory().unwrap();
        replace_all(&mut db.conn.lock().unwrap(), &parsed()).unwrap();
        db
    }

    #[test]
    fn ticker_normalisation_assumes_nse_for_a_bare_symbol() {
        assert_eq!(normalize_ticker("reliance"), "NSE:RELIANCE");
        assert_eq!(normalize_ticker(" bse:reliance "), "BSE:RELIANCE");
        assert_eq!(normalize_ticker("IDX:nifty bank"), "IDX:NIFTY_BANK");
        assert_eq!(make_ticker("IDX", "NIFTY BANK"), "IDX:NIFTY_BANK");
    }

    #[test]
    fn resolve_finds_by_ticker_case_and_default_exchange() {
        let db = loaded();
        let conn = db.conn.lock().unwrap();
        assert_eq!(resolve(&conn, "NSE:RELIANCE").unwrap().unwrap().security_id, 2885);
        assert_eq!(
            resolve(&conn, "reliance").unwrap().unwrap().security_id,
            2885,
            "bare = NSE"
        );
        assert_eq!(resolve(&conn, "bse:reliance").unwrap().unwrap().security_id, 500325);
        assert_eq!(resolve(&conn, "IDX:NIFTY BANK").unwrap().unwrap().security_id, 25);
        assert!(resolve(&conn, "NSE:NOPE").unwrap().is_none());
    }

    #[test]
    fn replace_all_swaps_the_whole_list() {
        let db = loaded();
        let mut conn = db.conn.lock().unwrap();
        let n = replace_all(&mut conn, &parsed()[..2]).unwrap();
        assert_eq!(n, 2);
        assert_eq!(count(&conn).unwrap(), 2);
    }

    #[test]
    fn search_ranks_exact_then_prefix_then_contains_then_name() {
        let db = loaded();
        let conn = db.conn.lock().unwrap();
        let tickers = |q: &str| {
            search(&conn, q, 10)
                .unwrap()
                .into_iter()
                .map(|m| m.symbol)
                .collect::<Vec<_>>()
        };

        // Exact symbol: NSE before BSE.
        assert_eq!(tickers("reliance"), ["NSE:RELIANCE", "BSE:RELIANCE"]);
        // Prefix of the symbol.
        assert_eq!(tickers("infy"), ["NSE:INFY"]);
        // "nifty": the index and ETF symbol-prefix matches come before name-only matches.
        let nifty = tickers("nifty");
        assert_eq!(nifty[0], "IDX:NIFTY", "an exact symbol beats prefixes");
        assert!(nifty.contains(&"NSE:NIFTYBEES".to_string()) && nifty.contains(&"IDX:NIFTY_BANK".to_string()));
        // A match on the company name only.
        assert_eq!(tickers("infosys"), ["NSE:INFY"]);
    }

    #[test]
    fn searching_an_index_by_its_display_name_puts_it_above_funds_that_track_it() {
        let db = loaded();
        let conn = db.conn.lock().unwrap();
        // "nifty bank" is in the ETF's name and the index's display name; the index is meant.
        let found = search(&conn, "nifty bank", 10).unwrap();
        let tickers: Vec<_> = found.iter().map(|m| m.symbol.as_str()).collect();
        let index = tickers
            .iter()
            .position(|t| *t == "IDX:BANKNIFTY")
            .expect("the index is found");
        let etf = tickers
            .iter()
            .position(|t| *t == "NSE:SETFNIFBK")
            .expect("and so is the fund");
        assert!(index < etf, "{tickers:?}");
    }

    #[test]
    fn a_short_list_caps_futures_so_stocks_are_not_crowded_out() {
        let db = loaded();
        let conn = db.conn.lock().unwrap();
        let is_future = |m: &SymbolMatch| m.kind.as_deref().is_some_and(|k| k.starts_with("FUT"));

        let short = search(&conn, "banknifty", 8).unwrap();
        assert!(
            short.iter().filter(|m| is_future(m)).count() <= MAX_DERIVATIVES_IN_SHORT_LIST,
            "{short:?}"
        );
        assert_eq!(short[0].symbol, "IDX:BANKNIFTY", "the index still leads");

        // Scoped to Dhan, the caller asks for a long list and gets every future.
        let long = search(&conn, "banknifty", 20).unwrap();
        assert!(
            long.iter().filter(|m| is_future(m)).count() > MAX_DERIVATIVES_IN_SHORT_LIST,
            "{long:?}"
        );
    }

    #[test]
    fn nse_futures_are_listed_before_bse_ones() {
        let db = loaded();
        let conn = db.conn.lock().unwrap();
        let tickers: Vec<_> = search(&conn, "banknifty", 20)
            .unwrap()
            .into_iter()
            .map(|m| m.symbol)
            .collect();
        let nse = tickers
            .iter()
            .position(|t| t.starts_with("NFO:"))
            .expect("an NSE future");
        let bse = tickers
            .iter()
            .position(|t| t.starts_with("BFO:"))
            .expect("a BSE future");
        assert!(nse < bse, "{tickers:?}");
    }

    #[test]
    fn search_understands_spaces_underscores_and_exchange_prefixes() {
        let db = loaded();
        let conn = db.conn.lock().unwrap();
        let tickers = |q: &str| {
            search(&conn, q, 10)
                .unwrap()
                .into_iter()
                .map(|m| m.symbol)
                .collect::<Vec<_>>()
        };
        assert!(tickers("nifty bank").contains(&"IDX:NIFTY_BANK".to_string()));
        assert!(tickers("nifty_bank").contains(&"IDX:NIFTY_BANK".to_string()));
        assert_eq!(tickers("bse:rel"), ["BSE:RELIANCE"]);
    }

    #[test]
    fn search_treats_wildcard_characters_literally_and_respects_the_limit() {
        let db = loaded();
        let conn = db.conn.lock().unwrap();
        assert!(search(&conn, "%", 10).unwrap().is_empty());
        assert!(search(&conn, "_", 10).unwrap().is_empty());
        assert!(search(&conn, "   ", 10).unwrap().is_empty());
        assert_eq!(search(&conn, "nifty", 2).unwrap().len(), 2);
    }

    #[test]
    fn search_results_carry_name_exchange_and_kind() {
        let db = loaded();
        let conn = db.conn.lock().unwrap();
        let m = &search(&conn, "infy", 5).unwrap()[0];
        assert_eq!(m.name.as_deref(), Some("INFOSYS LIMITED"));
        assert_eq!(m.exchange.as_deref(), Some("NSE"));
        assert_eq!(m.kind.as_deref(), Some("EQUITY"));
    }
}
