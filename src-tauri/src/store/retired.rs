//! Housekeeping for the data sources the app no longer has.

use rusqlite::Connection;

use super::preferences;
use crate::secrets::Secrets;

const YAHOO_PURGED_PREF: &str = "yahooLeftoversPurged";
const DHAN_PURGED_PREF: &str = "dhanLeftoversPurged";

/// Yahoo Finance used to be a data source. What it left in the database is cache
/// the app can rebuild, or a setting nothing reads any more, so it is removed once,
/// on the first launch after the source was dropped.
///
/// Nothing the user wrote is touched: watchlists, layouts and alerts keep their
/// `yahoo:` symbols (they simply can no longer be loaded).
pub fn purge_yahoo_leftovers_once(conn: &mut Connection) -> rusqlite::Result<()> {
    if preferences::get(conn, YAHOO_PURGED_PREF)?.is_some() {
        return Ok(());
    }
    let tx = conn.transaction()?;
    // The brokers cache under `dhan:…` and `zerodha:…` keys; every other key was
    // one of Yahoo's bare tickers.
    tx.execute(
        "DELETE FROM bars_cache WHERE symbol NOT LIKE 'dhan:%' AND symbol NOT LIKE 'zerodha:%'",
        [],
    )?;
    // Yahoo's per-symbol timezones, and the company names it supplied.
    tx.execute_batch("DROP TABLE IF EXISTS symbol_meta; DROP TABLE IF EXISTS symbol_names;")?;
    tx.execute("DELETE FROM provider_settings WHERE provider = 'yahoo'", [])?;
    tx.execute(
        "DELETE FROM ui_preferences
         WHERE key IN ('barsCachePeriodKeyed', 'market_data_intro_seen')
            OR (key = 'default_provider' AND value = 'yahoo')",
        [],
    )?;
    preferences::set(&tx, YAHOO_PURGED_PREF, "1")?;
    tx.commit()
}

/// Dhan used to be a data source. Its credentials are removed from the OS credential store (they
/// were a secret the app no longer needs to hold), and what it left in the database — cached and
/// stored bars, its instrument list, its settings — is removed once, on the first launch after it
/// was dropped. A market-data store that was downloaded from Dhan is forgotten too, so the next
/// download comes from the broker that remains.
///
/// Nothing the user wrote is touched: watchlists, layouts and alerts keep their `dhan:` symbols
/// (they simply can no longer be loaded).
pub fn purge_dhan_leftovers_once(conn: &mut Connection, secrets: &Secrets) -> rusqlite::Result<()> {
    if preferences::get(conn, DHAN_PURGED_PREF)?.is_some() {
        return Ok(());
    }
    for key in ["accessToken", "clientId"] {
        secrets.delete(conn, "dhan", key)?;
    }
    let store_was_dhan = preferences::get(conn, "marketData.provider")?.as_deref() == Some("dhan");
    let tx = conn.transaction()?;
    for table in ["bars_cache", "research_bars", "research_coverage", "market_symbols"] {
        tx.execute(&format!("DELETE FROM {table} WHERE symbol LIKE 'dhan:%'"), [])?;
    }
    tx.execute_batch("DROP TABLE IF EXISTS dhan_instruments;")?;
    tx.execute("DELETE FROM provider_settings WHERE provider = 'dhan'", [])?;
    tx.execute("DELETE FROM provider_secrets_fallback WHERE provider = 'dhan'", [])?;
    tx.execute(
        "DELETE FROM ui_preferences WHERE key IN ('pine_dock_dhan', 'dhan_feed') OR (key = 'default_provider' AND value = 'dhan')",
        [],
    )?;
    if store_was_dhan {
        tx.execute(
            "DELETE FROM ui_preferences WHERE key LIKE 'marketData.%' AND key != 'marketData.auto'",
            [],
        )?;
    }
    preferences::set(&tx, DHAN_PURGED_PREF, "1")?;
    tx.commit()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    fn cached_symbols(conn: &Connection) -> Vec<String> {
        let mut stmt = conn
            .prepare("SELECT DISTINCT symbol FROM bars_cache ORDER BY symbol")
            .unwrap();
        stmt.query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect()
    }

    fn cache(conn: &Connection, symbol: &str, interval: &str) {
        conn.execute(
            "INSERT INTO bars_cache (symbol, interval, ts, open, high, low, close, volume)
             VALUES (?1, ?2, 1000, 1, 2, 0, 1, 10)",
            [symbol, interval],
        )
        .unwrap();
    }

    /// A database as an earlier version left it: Yahoo's tables and rows beside the brokers'.
    fn old_database() -> Database {
        let db = Database::open_in_memory().unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute_batch(
                "CREATE TABLE symbol_meta (symbol TEXT PRIMARY KEY, gmt_offset INTEGER NOT NULL, timezone TEXT);
                 CREATE TABLE symbol_names (symbol TEXT PRIMARY KEY, name TEXT NOT NULL) WITHOUT ROWID;
                 INSERT INTO symbol_meta VALUES ('AAPL', -14400, 'America/New_York');
                 INSERT INTO symbol_names VALUES ('yahoo:AAPL', 'Apple Inc.');
                 INSERT INTO provider_settings (provider, key, value) VALUES ('yahoo', 'enabled', '1'), ('dhan', 'enabled', '1');
                 INSERT INTO ui_preferences (key, value) VALUES
                   ('default_provider', 'yahoo'), ('barsCachePeriodKeyed', '1'), ('market_data_intro_seen', '1'), ('theme', 'paper');",
            )
            .unwrap();
            cache(&conn, "AAPL", "1d");
            cache(&conn, "QPOWER.NS", "5m");
            cache(&conn, "dhan:NSE:RELIANCE", "1D");
            cache(&conn, "zerodha:NSE:TCS", "5M");
        }
        db
    }

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn yahoo_cache_and_settings_go_but_the_brokers_data_stays() {
        let db = old_database();
        let mut conn = db.conn.lock().unwrap();
        purge_yahoo_leftovers_once(&mut conn).unwrap();

        assert_eq!(cached_symbols(&conn), ["dhan:NSE:RELIANCE", "zerodha:NSE:TCS"]);
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM sqlite_master WHERE name IN ('symbol_meta', 'symbol_names')"
            ),
            0
        );
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM provider_settings WHERE provider = 'yahoo'"),
            0
        );
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM provider_settings WHERE provider = 'dhan'"),
            1
        );
        assert_eq!(
            preferences::get(&conn, "default_provider").unwrap(),
            None,
            "a default of Yahoo is dropped so the app's own default applies"
        );
        assert_eq!(preferences::get(&conn, "theme").unwrap().as_deref(), Some("paper"));
    }

    #[test]
    fn a_default_provider_the_user_chose_is_kept() {
        let db = Database::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        preferences::set(&conn, "default_provider", "dhan").unwrap();
        purge_yahoo_leftovers_once(&mut conn).unwrap();
        assert_eq!(
            preferences::get(&conn, "default_provider").unwrap().as_deref(),
            Some("dhan")
        );
    }

    #[test]
    fn it_runs_only_once() {
        let db = old_database();
        let mut conn = db.conn.lock().unwrap();
        purge_yahoo_leftovers_once(&mut conn).unwrap();
        cache(&conn, "BTC-USD", "1d");
        purge_yahoo_leftovers_once(&mut conn).unwrap();
        assert!(
            cached_symbols(&conn).contains(&"BTC-USD".to_string()),
            "the second launch leaves later rows alone"
        );
    }

    #[test]
    fn a_fresh_database_is_fine() {
        let db = Database::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        purge_yahoo_leftovers_once(&mut conn).unwrap();
        assert!(cached_symbols(&conn).is_empty());
    }

    mod dhan {
        use super::*;
        use crate::secrets::testing::MemoryKeychain;

        #[test]
        fn dhan_credentials_data_and_settings_go_but_zerodhas_stay() {
            let db = old_database();
            let secrets = Secrets::new(Box::new(MemoryKeychain::default()));
            let mut conn = db.conn.lock().unwrap();
            conn.execute_batch(
                "CREATE TABLE dhan_instruments (ticker TEXT PRIMARY KEY);
                 INSERT INTO research_coverage (symbol, interval, from_ts, to_ts, synced_at) VALUES
                   ('dhan:NSE:RELIANCE', 'D', 1, 2, 3), ('zerodha:NSE:TCS', 'D', 1, 2, 3);
                 INSERT OR REPLACE INTO ui_preferences (key, value) VALUES ('default_provider', 'dhan'),
                   ('marketData.provider', 'dhan'), ('marketData.lastUpdate', '5'), ('marketData.auto', 'false');",
            )
            .unwrap();
            secrets.set(&conn, "dhan", "accessToken", "tok").unwrap();
            secrets.set(&conn, "zerodha", "accessToken", "kite").unwrap();

            purge_dhan_leftovers_once(&mut conn, &secrets).unwrap();

            assert_eq!(secrets.get(&conn, "dhan", "accessToken").unwrap(), None);
            assert_eq!(
                secrets.get(&conn, "zerodha", "accessToken").unwrap().as_deref(),
                Some("kite")
            );
            assert_eq!(cached_symbols(&conn), ["AAPL", "QPOWER.NS", "zerodha:NSE:TCS"]);
            assert_eq!(count(&conn, "SELECT COUNT(*) FROM research_coverage"), 1);
            assert_eq!(
                count(
                    &conn,
                    "SELECT COUNT(*) FROM sqlite_master WHERE name = 'dhan_instruments'"
                ),
                0
            );
            assert_eq!(
                count(&conn, "SELECT COUNT(*) FROM provider_settings WHERE provider = 'dhan'"),
                0
            );
            assert_eq!(preferences::get(&conn, "default_provider").unwrap(), None);
            assert_eq!(
                preferences::get(&conn, "marketData.provider").unwrap(),
                None,
                "the next download picks again"
            );
            assert_eq!(preferences::get(&conn, "marketData.lastUpdate").unwrap(), None);
            assert_eq!(
                preferences::get(&conn, "marketData.auto").unwrap().as_deref(),
                Some("false"),
                "a choice the user made stays"
            );
        }

        #[test]
        fn a_store_downloaded_from_zerodha_is_kept_and_it_runs_once() {
            let db = Database::open_in_memory().unwrap();
            let secrets = Secrets::new(Box::new(MemoryKeychain::default()));
            let mut conn = db.conn.lock().unwrap();
            preferences::set(&conn, "marketData.provider", "zerodha").unwrap();
            purge_dhan_leftovers_once(&mut conn, &secrets).unwrap();
            assert_eq!(
                preferences::get(&conn, "marketData.provider").unwrap().as_deref(),
                Some("zerodha")
            );
            cache(&conn, "dhan:NSE:LATER", "1D");
            purge_dhan_leftovers_once(&mut conn, &secrets).unwrap();
            assert!(
                cached_symbols(&conn).contains(&"dhan:NSE:LATER".to_string()),
                "the second launch leaves later rows alone"
            );
        }
    }
}
