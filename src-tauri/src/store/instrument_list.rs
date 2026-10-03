//! Lists a broker's instruments by exchange and kind, for building a screening universe
//! ("every NSE equity"). `search` in each broker's module ranks a few results for a search
//! box; this returns everything that matches, in ticker order.

use rusqlite::{params, Connection};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Zerodha,
}

impl Source {
    pub fn parse(provider: &str) -> Option<Source> {
        match provider {
            "zerodha" => Some(Source::Zerodha),
            _ => None,
        }
    }

    /// A constant, never user input, so it is safe to put in SQL.
    fn table(self) -> &'static str {
        match self {
            Source::Zerodha => "zerodha_instruments",
        }
    }
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
    fn only_zerodha_is_a_source() {
        assert_eq!(Source::parse("zerodha"), Some(Source::Zerodha));
        assert_eq!(Source::parse("dhan"), None, "Dhan was removed");
        assert_eq!(Source::parse("binance"), None);
        assert_eq!(Source::parse("csv"), None);
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
