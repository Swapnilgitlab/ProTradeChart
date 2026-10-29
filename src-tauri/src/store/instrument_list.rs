//! Each broker's instrument table: the rows that can be charted (equities, indices, futures), under
//! the app's own tickers (`NSE:RELIANCE`, `NSE:NIFTY_50`, `NFO:NIFTY26OCTFUT`) whichever broker
//! listed them, beside what the broker itself calls them. `resolve` finds a chart's instrument,
//! `search` ranks a few for a search box, and `list` returns everything that matches a filter, in
//! ticker order, for building a screening universe ("every NSE equity").
//!
//! The tables hold names and identifiers, never prices.

use rusqlite::{params, Connection, OptionalExtension};

use crate::models::SymbolMatch;
use crate::secrets::Secrets;
use crate::symbols::{canonical_provider, india_broker, Broker, INDIA};

/// Whose instrument list: one table per broker, each holding the app's own tickers (`NSE:RELIANCE`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Zerodha,
    Fyers,
}

impl Source {
    pub fn of(broker: Broker) -> Source {
        match broker {
            Broker::Zerodha => Source::Zerodha,
            Broker::Fyers => Source::Fyers,
        }
    }

    /// The instrument list behind a symbol namespace: the broker's that serves `india:` now. `None` for
    /// a namespace with none (imported data).
    pub fn for_provider(conn: &Connection, secrets: &Secrets, provider: &str) -> rusqlite::Result<Option<Source>> {
        if canonical_provider(provider.trim()) != INDIA {
            return Ok(None);
        }
        Ok(Some(Source::of(india_broker(conn, secrets)?)))
    }

    /// A constant, never user input, so it is safe to put in SQL.
    fn table(self) -> &'static str {
        match self {
            Source::Zerodha => "zerodha_instruments",
            Source::Fyers => "fyers_instruments",
        }
    }
}

/// One row of a broker's instrument table.
#[derive(Debug, Clone, PartialEq)]
pub struct Instrument {
    /// `NSE:RELIANCE` — the chart symbol without its `india:` prefix.
    pub ticker: String,
    pub exchange: String,
    /// The broker's own number for it: Kite's `instrument_token`, FYERS's `fyToken`.
    pub token: i64,
    /// `EQUITY`, `INDEX` or `FUT`.
    pub instrument: String,
    /// What the broker calls it in a request: Kite's trading symbol (`NIFTY 50`, `M&M`), FYERS's
    /// symbol (`NSE:NIFTY50-INDEX`, `NSE:M&M-EQ`).
    pub symbol: String,
    pub name: Option<String>,
    /// `YYYY-MM-DD`, for futures.
    pub expiry: Option<String>,
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

/// Replaces a broker's stored instrument list. One transaction, so a failed refresh never leaves
/// search half-empty.
pub fn replace_all(conn: &mut Connection, source: Source, items: &[Instrument]) -> rusqlite::Result<usize> {
    let table = source.table();
    let tx = conn.transaction()?;
    tx.execute(&format!("DELETE FROM {table}"), [])?;
    {
        let mut stmt = tx.prepare(&format!(
            "INSERT OR IGNORE INTO {table} (ticker, exchange, token, instrument, symbol, name, expiry)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"
        ))?;
        for i in items {
            stmt.execute(params![
                i.ticker,
                i.exchange,
                i.token,
                i.instrument,
                i.symbol,
                i.name,
                i.expiry
            ])?;
        }
    }
    tx.commit()?;
    count(conn, source).map(|n| n as usize)
}

pub fn count(conn: &Connection, source: Source) -> rusqlite::Result<i64> {
    conn.query_row(&format!("SELECT COUNT(*) FROM {}", source.table()), [], |r| r.get(0))
}

const COLUMNS: &str = "ticker, exchange, token, instrument, symbol, name, expiry";

fn from_row(r: &rusqlite::Row) -> rusqlite::Result<Instrument> {
    Ok(Instrument {
        ticker: r.get(0)?,
        exchange: r.get(1)?,
        token: r.get(2)?,
        instrument: r.get(3)?,
        symbol: r.get(4)?,
        name: r.get(5)?,
        expiry: r.get(6)?,
    })
}

/// A stock NSE trades in a special segment is listed with its series after a
/// hyphen — `HFCL` is `NSE:HFCL-BE`, `KODYTECH` is `NSE:KODYTECH-ST` — while lists,
/// imports and people use the bare name. Only a two-letter series counts, so `BAJAJ`
/// is not taken for `BAJAJ-AUTO`, a different company. `-BE` wins if there are several.
fn nse_series_ticker(conn: &Connection, source: Source, symbol: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        &format!(
            "SELECT ticker FROM {} WHERE exchange = 'NSE' AND instrument = 'EQUITY' AND ticker LIKE ?1 ESCAPE '\\'
             ORDER BY (ticker LIKE '%-BE') DESC, ticker LIMIT 1",
            source.table()
        ),
        params![format!("NSE:{}-__", escape_like(symbol))],
        |r| r.get(0),
    )
    .optional()
}

/// An index ticker without its punctuation: `NSE:NIFTY_MIDCAP_100` and `NSE:NIFTYMIDCAP100` are one.
fn compact(ticker: &str) -> String {
    ticker
        .chars()
        .filter(|c| !matches!(c, '_' | ' ' | '-'))
        .collect::<String>()
        .to_uppercase()
}

/// The brokers spell some index names differently (Kite's `NIFTY MIDCAP 100`, FYERS's
/// `NIFTYMIDCAP100`), and a symbol saved through one may be read through the other. An index whose
/// ticker is the same once underscores and spaces are dropped is the same index. Indices only: a
/// stock's punctuation means something (`BAJAJ-AUTO`).
fn index_by_compact_name(conn: &Connection, source: Source, ticker: &str) -> rusqlite::Result<Option<String>> {
    let Some((exchange, _)) = ticker.split_once(':') else {
        return Ok(None);
    };
    let wanted = compact(ticker);
    let mut stmt = conn.prepare(&format!(
        "SELECT ticker FROM {} WHERE exchange = ?1 AND instrument = 'INDEX' ORDER BY ticker",
        source.table()
    ))?;
    let found = stmt
        .query_map(params![exchange], |r| r.get::<_, String>(0))?
        .filter_map(Result::ok)
        .find(|t| compact(t) == wanted);
    Ok(found)
}

fn by_ticker(conn: &Connection, source: Source, ticker: &str) -> rusqlite::Result<Option<Instrument>> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM {} WHERE ticker = ?1", source.table()),
        params![ticker],
        from_row,
    )
    .optional()
}

/// Looks an instrument up by chart ticker (`NSE:RELIANCE`, or just `RELIANCE`). A stock
/// NSE lists under a series (`NSE:HFCL-BE`) is found by its bare name too, so a list or
/// an import that says `NSE:HFCL` charts, quotes and streams the same as any other; and an index
/// is found by its name however the other broker punctuated it.
pub fn resolve(conn: &Connection, source: Source, ticker: &str) -> rusqlite::Result<Option<Instrument>> {
    let key = normalize_ticker(ticker);
    if let Some(found) = by_ticker(conn, source, &key)? {
        return Ok(Some(found));
    }
    if let Some(symbol) = key.strip_prefix("NSE:") {
        if let Some(series) = nse_series_ticker(conn, source, symbol)? {
            return by_ticker(conn, source, &series);
        }
    }
    match index_by_compact_name(conn, source, &key)? {
        Some(index) => by_ticker(conn, source, &index),
        None => Ok(None),
    }
}

/// Lists up to this long are "short": they leave room for other providers' results.
const SHORT_LIST: usize = 10;
const MAX_FUTURES_IN_SHORT_LIST: usize = 3;

/// Searches symbols and names. Exact symbol first, then prefix, then anywhere
/// in the symbol, then in the name; ties prefer indices over stocks over
/// futures, NSE over BSE, and shorter symbols. "Symbol" is the app's own ticker without its exchange
/// (`NIFTY_50`), whatever the broker calls it in a request.
pub fn search(conn: &Connection, source: Source, query: &str, limit: usize) -> rusqlite::Result<Vec<SymbolMatch>> {
    // A short list is for picking a stock; a stock's monthly futures would
    // crowd it out. A long list (someone scoped to the Indian markets) has room for them.
    let future_cap = if limit <= SHORT_LIST {
        MAX_FUTURES_IN_SHORT_LIST
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

    // `own` is the ticker after its exchange with underscores read as spaces: `NIFTY 50`.
    let own = "LOWER(replace(substr(ticker, instr(ticker, ':') + 1), '_', ' '))";
    let mut stmt = conn.prepare(&format!(
        "SELECT ticker, name, exchange, instrument FROM {table}
         WHERE {own} LIKE ?3 ESCAPE '\\' OR LOWER(name) LIKE ?3 ESCAPE '\\' OR LOWER(ticker) LIKE ?4 ESCAPE '\\'
         ORDER BY
           CASE WHEN {own} = ?1 THEN 0
                WHEN {own} LIKE ?2 ESCAPE '\\' OR LOWER(ticker) LIKE ?4 ESCAPE '\\' THEN 1
                WHEN {own} LIKE ?3 ESCAPE '\\' THEN 2 ELSE 3 END,
           CASE instrument WHEN 'INDEX' THEN 0 WHEN 'EQUITY' THEN 1 ELSE 2 END,
           CASE exchange WHEN 'NSE' THEN 0 WHEN 'BSE' THEN 1 WHEN 'NFO' THEN 2 WHEN 'MCX' THEN 3
                         WHEN 'CDS' THEN 4 WHEN 'BFO' THEN 5 ELSE 6 END,
           LENGTH(ticker)
         LIMIT ?5",
        table = source.table()
    ))?;
    // Over-fetch so that skipping surplus futures still leaves `limit` rows.
    let rows = stmt.query_map(params![exact, prefix, any, ticker_prefix, (limit * 6) as i64], |r| {
        Ok(SymbolMatch {
            symbol: r.get(0)?,
            name: r.get(1)?,
            exchange: r.get(2)?,
            kind: r.get(3)?,
        })
    })?;

    let mut out = Vec::with_capacity(limit);
    let mut futures = 0;
    for row in rows {
        let m = row?;
        if m.kind.as_deref() == Some("FUT") {
            futures += 1;
            if futures > future_cap {
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listed {
    /// `NSE:RELIANCE`, without the provider.
    pub ticker: String,
    pub exchange: String,
    /// The broker's own type: `EQUITY`, `INDEX` or `FUT`.
    pub instrument: String,
    pub name: Option<String>,
    pub expiry: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Filter {
    pub exchange: Option<String>,
    /// `EQUITY`, `INDEX`, or `FUT` (which matches every futures type).
    pub kind: Option<String>,
    /// Matched anywhere in the symbol or the name.
    pub query: Option<String>,
}

fn escape_like(text: &str) -> String {
    text.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

fn non_empty(text: &Option<String>) -> Option<String> {
    text.as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
}

pub fn list(conn: &Connection, source: Source, filter: &Filter, limit: usize) -> rusqlite::Result<Vec<Listed>> {
    let exchange = non_empty(&filter.exchange).map(|e| e.to_uppercase());
    let kind = non_empty(&filter.kind).map(|k| k.to_uppercase());
    let query = non_empty(&filter.query).map(|q| format!("%{}%", escape_like(&q.replace(' ', "_"))));
    // The name is free text, so a space there is a space, not the underscore tickers use.
    let name_query = non_empty(&filter.query).map(|q| format!("%{}%", escape_like(&q)));

    let sql = format!(
        "SELECT ticker, exchange, instrument, name, expiry FROM {}
         WHERE (?1 IS NULL OR exchange = ?1)
           AND (?2 IS NULL OR UPPER(instrument) = ?2 OR (?2 = 'FUT' AND UPPER(instrument) LIKE 'FUT%'))
           AND (?3 IS NULL OR UPPER(ticker) LIKE UPPER(?3) ESCAPE '\\' OR UPPER(name) LIKE UPPER(?4) ESCAPE '\\')
         ORDER BY ticker LIMIT ?5",
        source.table()
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![exchange, kind, query, name_query, limit as i64], |r| {
        Ok(Listed {
            ticker: r.get(0)?,
            exchange: r.get(1)?,
            instrument: r.get(2)?,
            name: r.get(3)?,
            expiry: r.get(4)?,
        })
    })?;
    rows.collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    fn seed(conn: &Connection) {
        for (ticker, exchange, instrument, name, expiry) in [
            ("NSE:RELIANCE", "NSE", "EQUITY", "Reliance Industries", None),
            ("NSE:TCS", "NSE", "EQUITY", "Tata Consultancy Services", None),
            ("BSE:RELIANCE", "BSE", "EQUITY", "Reliance Industries", None),
            ("NSE:NIFTY_50", "NSE", "INDEX", "Nifty 50", None),
            ("NFO:NIFTY26SEPFUT", "NFO", "FUT", "NIFTY", Some("2026-09-29")),
            ("NSE:M&M", "NSE", "EQUITY", "Mahindra & Mahindra", None),
        ] {
            conn.execute(
                "INSERT INTO zerodha_instruments (ticker, exchange, token, instrument, symbol, name, expiry)
                 VALUES (?1, ?2, 1, ?3, ?1, ?4, ?5)",
                params![ticker, exchange, instrument, name, expiry],
            )
            .unwrap();
        }
    }

    fn tickers(rows: Vec<Listed>) -> Vec<String> {
        rows.into_iter().map(|r| r.ticker).collect()
    }

    fn all(conn: &Connection, source: Source, filter: Filter) -> Vec<String> {
        tickers(list(conn, source, &filter, 1000).unwrap())
    }

    #[test]
    fn the_indian_namespace_reads_its_brokers_list_and_nothing_else_has_one() {
        let db = Database::open_in_memory().unwrap();
        let secrets = crate::secrets::Secrets::new(Box::new(crate::secrets::testing::MemoryKeychain::default()));
        let conn = db.conn.lock().unwrap();
        let source = |p| Source::for_provider(&conn, &secrets, p).unwrap();
        assert_eq!(source("india"), Some(Source::Zerodha));
        assert_eq!(source("zerodha"), Some(Source::Zerodha), "the namespace's old name");
        for none in ["nosuch", "binance", "csv"] {
            assert_eq!(source(none), None, "{none}");
        }
    }

    #[test]
    fn everything_lists_in_ticker_order() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        seed(&conn);
        let got = all(&conn, Source::Zerodha, Filter::default());
        let mut sorted = got.clone();
        sorted.sort();
        assert_eq!(got, sorted);
        assert_eq!(got.len(), 6);
    }

    #[test]
    fn an_exchange_and_a_kind_narrow_the_list() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        seed(&conn);
        let nse_stocks = Filter {
            exchange: Some("nse".into()),
            kind: Some("equity".into()),
            query: None,
        };
        assert_eq!(
            all(&conn, Source::Zerodha, nse_stocks),
            ["NSE:M&M", "NSE:RELIANCE", "NSE:TCS"]
        );
        let indices = Filter {
            kind: Some("INDEX".into()),
            ..Filter::default()
        };
        assert_eq!(all(&conn, Source::Zerodha, indices), ["NSE:NIFTY_50"]);
    }

    #[test]
    fn fut_matches_every_futures_type() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        seed(&conn);
        let futures = Filter {
            kind: Some("FUT".into()),
            ..Filter::default()
        };
        assert_eq!(all(&conn, Source::Zerodha, futures), ["NFO:NIFTY26SEPFUT"]);
    }

    #[test]
    fn a_query_matches_the_symbol_or_the_name_case_insensitively() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        seed(&conn);
        let q = |text: &str| Filter {
            query: Some(text.into()),
            ..Filter::default()
        };
        assert_eq!(
            all(&conn, Source::Zerodha, q("reliance")),
            ["BSE:RELIANCE", "NSE:RELIANCE"]
        );
        assert_eq!(all(&conn, Source::Zerodha, q("Tata Consultancy")), ["NSE:TCS"]);
        assert_eq!(
            all(&conn, Source::Zerodha, q("nifty 50")),
            ["NSE:NIFTY_50"],
            "a space finds the underscore"
        );
    }

    #[test]
    fn wildcards_in_a_query_are_literal() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        seed(&conn);
        let q = |text: &str| Filter {
            query: Some(text.into()),
            ..Filter::default()
        };
        assert!(all(&conn, Source::Zerodha, q("%")).is_empty(), "% is not 'anything'");
        assert!(
            all(&conn, Source::Zerodha, q("_")).len() < 6,
            "_ is not 'any one character'"
        );
        assert_eq!(all(&conn, Source::Zerodha, q("M&M")), ["NSE:M&M"]);
    }

    #[test]
    fn a_limit_caps_the_list_and_blank_filters_are_ignored() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        seed(&conn);
        let blank = Filter {
            exchange: Some("  ".into()),
            kind: Some(String::new()),
            query: Some(" ".into()),
        };
        assert_eq!(tickers(list(&conn, Source::Zerodha, &blank, 2).unwrap()).len(), 2);
    }
}
