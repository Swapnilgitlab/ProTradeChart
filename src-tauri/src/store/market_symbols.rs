//! The list of symbols "Keep the market loaded" covers (`market_symbols`): names, never prices. The brokers' instrument
//! tables are replaced on every refresh, so they can't say what is *new*; this list keeps every
//! symbol it has seen, which is how a new listing (an IPO) is found, and when it was last listed.

use rusqlite::{params, Connection};

/// `EQ` (a stock) or `INDEX`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listed {
    pub symbol: String,
    pub kind: String,
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarketSymbol {
    pub symbol: String,
    pub kind: String,
    pub name: Option<String>,
    pub first_seen: i64,
    pub last_seen: i64,
    pub refetched_at: Option<i64>,
}

/// Records that `listed` is what the exchange lists as of `now`. Returns the symbols seen for
/// the first time, in the order given.
pub fn record_listing(conn: &mut Connection, listed: &[Listed], now: i64) -> rusqlite::Result<Vec<String>> {
    let tx = conn.transaction()?;
    let mut new = Vec::new();
    {
        let mut insert = tx.prepare(
            "INSERT INTO market_symbols (symbol, kind, name, first_seen, last_seen)
             VALUES (?1, ?2, ?3, ?4, ?4) ON CONFLICT(symbol) DO NOTHING",
        )?;
        let mut touch =
            tx.prepare("UPDATE market_symbols SET kind = ?2, name = ?3, last_seen = ?4 WHERE symbol = ?1")?;
        for l in listed {
            if insert.execute(params![l.symbol, l.kind, l.name, now])? == 1 {
                new.push(l.symbol.clone());
            } else {
                touch.execute(params![l.symbol, l.kind, l.name, now])?;
            }
        }
    }
    tx.commit()?;
    Ok(new)
}

pub fn list(conn: &Connection) -> rusqlite::Result<Vec<MarketSymbol>> {
    let mut stmt = conn.prepare(
        "SELECT symbol, kind, name, first_seen, last_seen, refetched_at FROM market_symbols ORDER BY symbol",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(MarketSymbol {
            symbol: r.get(0)?,
            kind: r.get(1)?,
            name: r.get(2)?,
            first_seen: r.get(3)?,
            last_seen: r.get(4)?,
            refetched_at: r.get(5)?,
        })
    })?;
    rows.collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    fn eq(symbol: &str) -> Listed {
        Listed {
            symbol: symbol.to_string(),
            kind: "EQ".to_string(),
            name: Some(format!("{symbol} Ltd")),
        }
    }

    #[test]
    fn the_first_listing_is_all_new_and_a_later_one_reports_only_new_listings() {
        let db = Database::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        let first = record_listing(&mut conn, &[eq("zerodha:NSE:A"), eq("zerodha:NSE:B")], 100).unwrap();
        assert_eq!(first, ["zerodha:NSE:A", "zerodha:NSE:B"]);

        let next = record_listing(&mut conn, &[eq("zerodha:NSE:B"), eq("zerodha:NSE:IPO")], 200).unwrap();
        assert_eq!(next, ["zerodha:NSE:IPO"]);

        let all = list(&conn).unwrap();
        assert_eq!(all.len(), 3, "a delisted symbol keeps its row");
        let a = all.iter().find(|s| s.symbol == "zerodha:NSE:A").unwrap();
        let b = all.iter().find(|s| s.symbol == "zerodha:NSE:B").unwrap();
        assert_eq!((a.first_seen, a.last_seen), (100, 100));
        assert_eq!((b.first_seen, b.last_seen), (100, 200));
    }
}
