//! Company names for chart symbols (`provider:TICKER`), so a watchlist row or a
//! chart watermark can show "Reliance Industries" beside the ticker. Only the
//! brokers' instrument lists carry names; the crypto venues and imported files
//! have none.

use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension};

use crate::zerodha::instruments as zerodha;

/// The names known for `symbols`; symbols with none are left out.
pub fn known(conn: &Connection, symbols: &[String]) -> rusqlite::Result<HashMap<String, String>> {
    let mut dhan = conn.prepare("SELECT name FROM dhan_instruments WHERE ticker = ?1")?;
    let mut names = HashMap::new();
    for symbol in symbols {
        let name = match symbol.split_once(':') {
            Some(("dhan", ticker)) => dhan
                .query_row(params![ticker], |r| r.get::<_, Option<String>>(0))
                .optional()?
                .flatten(),
            // The same lookup charts use, so a stock Zerodha lists as `NSE:HFCL-BE` is named
            // under the `NSE:HFCL` a list or import calls it.
            Some(("zerodha", ticker)) => zerodha::resolve(conn, ticker)?.and_then(|instrument| instrument.name),
            _ => continue,
        };
        if let Some(name) = name.filter(|n| !n.trim().is_empty()) {
            names.insert(symbol.clone(), name);
        }
    }
    Ok(names)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    fn syms(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn broker_symbols_are_named_from_their_instrument_lists() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO zerodha_instruments (ticker, exchange, token, instrument, symbol, name)
             VALUES ('NSE:RELIANCE', 'NSE', 738561, 'EQ', 'RELIANCE', 'RELIANCE INDUSTRIES')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO dhan_instruments (ticker, exchange, segment, security_id, instrument, symbol, name)
             VALUES ('NSE:TCS', 'NSE', 1, 11536, 'EQUITY', 'TCS', NULL),
                    ('NSE:INFY', 'NSE', 1, 1594, 'EQUITY', 'INFY', 'INFOSYS LTD')",
            [],
        )
        .unwrap();
        let names = known(
            &conn,
            &syms(&[
                "zerodha:NSE:RELIANCE",
                "dhan:NSE:TCS",
                "dhan:NSE:INFY",
                "binance:BTCUSDT",
            ]),
        )
        .unwrap();
        assert_eq!(
            names.len(),
            2,
            "no name in the list means no name, and only brokers have lists"
        );
        assert_eq!(names["zerodha:NSE:RELIANCE"], "RELIANCE INDUSTRIES");
        assert_eq!(names["dhan:NSE:INFY"], "INFOSYS LTD");
    }

    #[test]
    fn a_zerodha_stock_listed_under_an_nse_series_is_named_by_its_bare_symbol() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO zerodha_instruments (ticker, exchange, token, instrument, symbol, name)
             VALUES ('NSE:HFCL-BE', 'NSE', 2000001, 'EQUITY', 'HFCL-BE', 'HFCL LIMITED')",
            [],
        )
        .unwrap();
        let names = known(&conn, &syms(&["zerodha:NSE:HFCL", "zerodha:NSE:HFCL-BE"])).unwrap();
        assert_eq!(names["zerodha:NSE:HFCL"], "HFCL LIMITED");
        assert_eq!(names["zerodha:NSE:HFCL-BE"], "HFCL LIMITED");
    }

    #[test]
    fn an_empty_request_and_unknown_tickers_give_nothing() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        assert!(known(&conn, &[]).unwrap().is_empty());
        assert!(known(&conn, &syms(&["dhan:NSE:NOPE", "csv:MY_DATA"]))
            .unwrap()
            .is_empty());
    }
}
