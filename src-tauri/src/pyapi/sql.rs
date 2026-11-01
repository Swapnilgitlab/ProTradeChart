//! `pt.sql`: a script's own SQL, run by the app on its own connection to `charting.db`, with the
//! saved prices attached read-only as `prices` when they are kept.
//!
//! What it may touch is decided statement by statement by SQLite's authorizer ([`policy`]): it may
//! read the watchlists, the symbol lists, imported datasets and saved prices, and change only the
//! four watchlist tables (and TEMP tables of its own). Settings, credentials, layouts and schedules
//! are out of its reach — so a script can't make a schedule, or read a secret, through SQL. Every
//! call is one transaction; a change to the watchlists is brought back to the app's rules
//! (`watchlists::repair_after_sql`) before it commits, or rolled back whole if it can't be.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{Batch, Connection, OpenFlags};
use serde::Serialize;
use serde_json::Value;

use crate::store::watchlists;

/// The most rows of the last result sent back, and the most columns it may have.
pub const MAX_ROWS: usize = 100_000;
pub const MAX_COLUMNS: usize = 100;
/// The most SQL one call runs.
pub const MAX_SQL_BYTES: usize = 1024 * 1024;

const READABLE_MAIN: &[&str] = &[
    "watchlists",
    "watchlist_items",
    "watchlist_sections",
    "symbol_flags",
    "market_symbols",
    "datasets",
    "dataset_bars",
    "zerodha_instruments",
    "fyers_instruments",
    "sqlite_master",
    "sqlite_schema",
];
pub const WRITABLE_MAIN: &[&str] = &["watchlists", "watchlist_items", "watchlist_sections", "symbol_flags"];
const READABLE_PRICES: &[&str] = &["price_series", "price_bars", "sqlite_master", "sqlite_schema"];
/// Pragmas that only describe a table.
const PRAGMAS: &[&str] = &[
    "table_info",
    "table_xinfo",
    "index_list",
    "index_info",
    "foreign_key_list",
    "table_list",
];

/// What a script's SQL asks for.
#[derive(Debug, Clone, Default)]
pub struct SqlRequest {
    pub sql: String,
    /// `?` values (each statement takes them from the first) or `:name` values.
    pub params: Params,
    /// Run it and roll it back: what it would return and change, with nothing changed.
    pub dry_run: bool,
}

#[derive(Debug, Clone, Default)]
pub enum Params {
    #[default]
    None,
    Positional(Vec<Value>),
    Named(serde_json::Map<String, Value>),
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlAnswer {
    /// The last statement that returned rows: its columns and rows (at most [`MAX_ROWS`]).
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
    /// More rows were there than were sent.
    pub truncated: bool,
    /// Rows the statements added, changed or removed.
    pub changes: u64,
    /// The tables it wrote to (TEMP ones left out).
    pub tables: Vec<String>,
    pub dry_run: bool,
}

/// What the authorizer saw: the tables written, and the first thing it refused (for the message).
#[derive(Debug, Default)]
struct Seen {
    written: Vec<String>,
    refused: Option<String>,
}

/// Whether the authorizer lets one action through. `Ok(Some(table))` is a write to that main table.
pub fn policy(action: &AuthAction, database: Option<&str>) -> Result<Option<String>, String> {
    let db = database.unwrap_or("main");
    let lower = |s: &str| s.to_ascii_lowercase();
    match action {
        AuthAction::Select | AuthAction::Recursive => Ok(None),
        AuthAction::Function { function_name } if lower(function_name) == "load_extension" => {
            Err("loading extensions".into())
        }
        AuthAction::Function { .. } => Ok(None),
        AuthAction::Read { table_name, .. } => {
            let table = lower(table_name);
            let ok = match db {
                "temp" => true,
                "main" => READABLE_MAIN.contains(&table.as_str()),
                "prices" => READABLE_PRICES.contains(&table.as_str()),
                _ => false,
            };
            if ok {
                Ok(None)
            } else {
                Err(format!("reading {db}.{table_name}"))
            }
        }
        AuthAction::Insert { table_name }
        | AuthAction::Update { table_name, .. }
        | AuthAction::Delete { table_name } => {
            let table = lower(table_name);
            match db {
                "temp" => Ok(None),
                // A table with AUTOINCREMENT keeps its counter there: written by SQLite along with it.
                "main" if table == "sqlite_sequence" => Ok(None),
                "main" if WRITABLE_MAIN.contains(&table.as_str()) => Ok(Some(table)),
                _ => Err(format!("changing {db}.{table_name}")),
            }
        }
        AuthAction::Pragma { pragma_name, .. } if PRAGMAS.contains(&lower(pragma_name).as_str()) => Ok(None),
        AuthAction::Pragma { pragma_name, .. } => Err(format!("PRAGMA {pragma_name}")),
        AuthAction::CreateTempTable { .. }
        | AuthAction::CreateTempIndex { .. }
        | AuthAction::CreateTempView { .. }
        | AuthAction::DropTempTable { .. }
        | AuthAction::DropTempIndex { .. }
        | AuthAction::DropTempView { .. } => Ok(None),
        AuthAction::Transaction { .. } | AuthAction::Savepoint { .. } => {
            Err("BEGIN, COMMIT and SAVEPOINT (each call is already one transaction)".into())
        }
        AuthAction::CreateTempTrigger { .. }
        | AuthAction::DropTempTrigger { .. }
        | AuthAction::CreateTrigger { .. }
        | AuthAction::DropTrigger { .. } => Err("triggers".into()),
        AuthAction::Attach { .. } | AuthAction::Detach { .. } => Err("attaching databases".into()),
        _ => Err("changing the database's tables (only TEMP tables can be made)".into()),
    }
}

const ALLOWED: &str = "pt.sql may read watchlists, watchlist_items, watchlist_sections, symbol_flags, market_symbols, \
     datasets, dataset_bars, the instrument tables and (with saved prices on) prices.price_series and prices.price_bars, \
     and change only the four watchlist tables";

/// Opens the connection a call runs on, with the saved prices attached read-only when there are
/// any (`prices`, or `None` when they aren't kept).
pub fn open(db_path: &Path, prices: Option<&Path>) -> rusqlite::Result<Connection> {
    let conn = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.busy_timeout(Duration::from_secs(30))?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    if let Some(prices) = prices {
        conn.execute("ATTACH DATABASE ?1 AS prices", [read_only_uri(prices)])?;
    }
    Ok(conn)
}

/// A `file:` URI that opens `path` read-only.
fn read_only_uri(path: &Path) -> String {
    let mut uri = String::from("file:");
    for c in path.to_string_lossy().replace('\\', "/").chars() {
        match c {
            ' ' => uri.push_str("%20"),
            '%' => uri.push_str("%25"),
            '#' => uri.push_str("%23"),
            '?' => uri.push_str("%3F"),
            c => uri.push(c),
        }
    }
    uri.push_str("?mode=ro");
    uri
}

fn json_of(value: ValueRef) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::from(i),
        ValueRef::Real(f) if f.is_finite() => Value::from(f),
        ValueRef::Real(_) => Value::Null,
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => Value::String(format!("<{} bytes>", b.len())),
    }
}

fn sql_of(value: &Value) -> Result<SqlValue, String> {
    Ok(match value {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(*b as i64),
        Value::Number(n) => match n.as_i64() {
            Some(i) => SqlValue::Integer(i),
            None => SqlValue::Real(n.as_f64().ok_or("a number SQLite can't hold")?),
        },
        Value::String(s) => SqlValue::Text(s.clone()),
        Value::Array(_) | Value::Object(_) => {
            return Err("A parameter must be a number, text, true/false or None.".into())
        }
    })
}

/// The rows of the last statement that returned any, and whether there were more.
type Rows = (Vec<String>, Vec<Vec<Value>>, bool);

fn execute_all(conn: &Connection, request: &SqlRequest) -> Result<Option<Rows>, rusqlite::Error> {
    let mut batch = Batch::new(conn, &request.sql);
    let mut last: Option<Rows> = None;
    let mut statements = 0;
    while let Some(mut stmt) = batch.next()? {
        statements += 1;
        for i in 1..=stmt.parameter_count() {
            let value = match (stmt.parameter_name(i), &request.params) {
                (Some(name), Params::Named(map)) => map.get(name.trim_start_matches([':', '@', '$'])),
                (None, Params::Positional(list)) => list.get(i - 1),
                _ => None,
            };
            let value = value.ok_or_else(|| {
                rusqlite::Error::InvalidParameterName(stmt.parameter_name(i).map_or(format!("?{i}"), str::to_string))
            })?;
            let value = sql_of(value).map_err(|e| rusqlite::Error::ToSqlConversionFailure(e.into()))?;
            stmt.raw_bind_parameter(i, value)?;
        }
        if stmt.column_count() == 0 {
            stmt.raw_execute()?;
            continue;
        }
        if stmt.column_count() > MAX_COLUMNS {
            return Err(rusqlite::Error::ToSqlConversionFailure(
                format!("A result can have at most {MAX_COLUMNS} columns.").into(),
            ));
        }
        let columns: Vec<String> = stmt.column_names().iter().map(|c| c.to_string()).collect();
        let width = columns.len();
        let mut rows = Vec::new();
        let mut truncated = false;
        let mut query = stmt.raw_query();
        while let Some(row) = query.next()? {
            if rows.len() == MAX_ROWS {
                truncated = true;
                break;
            }
            rows.push(
                (0..width)
                    .map(|i| row.get_ref(i).map(json_of))
                    .collect::<Result<_, _>>()?,
            );
        }
        last = Some((columns, rows, truncated));
    }
    if statements == 0 {
        return Err(rusqlite::Error::ToSqlConversionFailure(
            "There is no SQL to run.".into(),
        ));
    }
    Ok(last)
}

/// The error a script sees: what was refused and what is allowed, or SQLite's own words.
fn explain(error: rusqlite::Error, seen: &Seen) -> String {
    if let Some(refused) = &seen.refused {
        return format!("pt.sql can't do that ({refused}). {ALLOWED}.");
    }
    let text = match &error {
        rusqlite::Error::ToSqlConversionFailure(e) => e.to_string(),
        rusqlite::Error::InvalidParameterName(name) => format!("No value was given for the parameter {name}."),
        other => other.to_string(),
    };
    if text.contains("no such table: prices.") {
        return "The saved prices aren't there: switch on Save prices on this computer (Data providers) to query \
                prices.price_series and prices.price_bars."
            .into();
    }
    text
}

/// Runs a call on `conn` (from [`open`]): every statement in one transaction, the watchlists repaired
/// if they were changed, then committed — or rolled back, for a dry run or on any error.
pub fn run(conn: &Connection, request: &SqlRequest) -> Result<SqlAnswer, String> {
    if request.sql.len() > MAX_SQL_BYTES {
        return Err(format!("At most {} KB of SQL per call.", MAX_SQL_BYTES / 1024));
    }
    conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
    let seen = Arc::new(Mutex::new(Seen::default()));
    let log = seen.clone();
    conn.authorizer(Some(move |ctx: AuthContext<'_>| {
        match policy(&ctx.action, ctx.database_name) {
            Ok(written) => {
                if let (Some(table), Ok(mut seen)) = (written, log.lock()) {
                    if !seen.written.contains(&table) {
                        seen.written.push(table);
                    }
                }
                Authorization::Allow
            }
            Err(what) => {
                if let Ok(mut seen) = log.lock() {
                    seen.refused.get_or_insert(what);
                }
                Authorization::Deny
            }
        }
    }));
    let before = conn.total_changes();
    let result = execute_all(conn, request);
    conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>);
    let changes = conn.total_changes().saturating_sub(before);
    let seen = std::mem::take(&mut *seen.lock().unwrap_or_else(|e| e.into_inner()));
    let rollback = |message: String| {
        let _ = conn.execute_batch("ROLLBACK");
        Err(message)
    };
    let rows = match result {
        Ok(rows) => rows,
        Err(e) => return rollback(explain(e, &seen)),
    };
    if !seen.written.is_empty() {
        if let Err(e) = watchlists::repair_after_sql(conn) {
            return rollback(format!("Nothing was changed: {e}"));
        }
    }
    let end = if request.dry_run { "ROLLBACK" } else { "COMMIT" };
    if let Err(e) = conn.execute_batch(end) {
        return rollback(e.to_string());
    }
    let (columns, rows, truncated) = rows.unwrap_or_default();
    Ok(SqlAnswer {
        columns,
        rows,
        truncated,
        changes,
        tables: seen.written,
        dry_run: request.dry_run,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use serde_json::json;

    fn ask(conn: &Connection, sql: &str) -> Result<SqlAnswer, String> {
        run(
            conn,
            &SqlRequest {
                sql: sql.into(),
                ..Default::default()
            },
        )
    }

    fn symbols(conn: &Connection, list: i64) -> Vec<(String, i64)> {
        conn.prepare("SELECT symbol, position FROM watchlist_items WHERE watchlist_id = ?1 ORDER BY position")
            .unwrap()
            .query_map([list], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    #[test]
    fn it_reads_the_lists_and_returns_the_last_result() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        let answer = ask(
            &conn,
            "INSERT INTO watchlists (name) VALUES ('Banks'); SELECT id, name FROM watchlists WHERE name = 'Banks'",
        )
        .unwrap();
        assert_eq!(answer.columns, ["id", "name"]);
        assert_eq!(answer.rows.len(), 1);
        assert_eq!(answer.rows[0][1], json!("Banks"));
        assert_eq!(
            (answer.changes, answer.tables.as_slice()),
            (1, &["watchlists".to_string()][..])
        );
    }

    #[test]
    fn a_bare_ticker_becomes_canonical_and_rows_are_renumbered() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        conn.execute("INSERT INTO watchlists (id, name) VALUES (7, 'Breakouts')", [])
            .unwrap();
        conn.execute(
            "INSERT INTO watchlist_items (watchlist_id, symbol, position) VALUES (7, 'india:NSE:TCS', 1)",
            [],
        )
        .unwrap();
        ask(
            &conn,
            "INSERT INTO watchlist_items (watchlist_id, symbol) VALUES (7, 'reliance'), (7, 'NSE:INFY'), (7, 'india:TCS')",
        )
        .unwrap();
        // `india:TCS` is TCS again: dropped. The new rows (no position) follow, in order.
        assert_eq!(
            symbols(&conn, 7),
            [
                ("india:NSE:TCS".to_string(), 1),
                ("india:NSE:RELIANCE".to_string(), 2),
                ("india:NSE:INFY".to_string(), 3)
            ]
        );
    }

    #[test]
    fn what_cant_be_repaired_rolls_everything_back() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        conn.execute("INSERT INTO watchlists (id, name) VALUES (1, 'A')", [])
            .unwrap();
        let bad_flag = ask(
            &conn,
            "INSERT INTO watchlist_items (watchlist_id, symbol) VALUES (1, 'india:NSE:X');
             INSERT INTO symbol_flags (symbol, flag, flagged_at) VALUES ('india:NSE:X', 'pink', 1)",
        );
        assert!(bad_flag.unwrap_err().contains("'pink' isn't a flag colour"));
        assert!(symbols(&conn, 1).is_empty(), "the insert before it went too");
        assert!(ask(&conn, "UPDATE watchlists SET name = '' WHERE id = 1")
            .unwrap_err()
            .contains("needs a name"));
        assert!(ask(
            &conn,
            "INSERT INTO watchlist_items (watchlist_id, symbol) VALUES (1, 'nope:X')"
        )
        .unwrap_err()
        .contains("isn't a symbol"));
    }

    #[test]
    fn the_newer_flag_wins_when_two_spellings_meet() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO symbol_flags (symbol, flag, flagged_at) VALUES ('india:NSE:SBIN', 'red', 1)",
            [],
        )
        .unwrap();
        ask(
            &conn,
            "INSERT INTO symbol_flags (symbol, flag, flagged_at) VALUES ('SBIN', 'green', 5)",
        )
        .unwrap();
        let flags: Vec<(String, String)> = conn
            .prepare("SELECT symbol, flag FROM symbol_flags")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(flags, [("india:NSE:SBIN".to_string(), "green".to_string())]);
    }

    #[test]
    fn a_dry_run_changes_nothing() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        let answer = run(
            &conn,
            &SqlRequest {
                sql: "INSERT INTO watchlists (name) VALUES ('Trial'); SELECT COUNT(*) AS n FROM watchlists WHERE name = 'Trial'"
                    .into(),
                dry_run: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!((answer.rows[0][0].clone(), answer.dry_run), (json!(1), true));
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM watchlists WHERE name = 'Trial'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0);
    }

    #[test]
    fn settings_secrets_schedules_and_the_schema_are_out_of_reach() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        for sql in [
            "SELECT * FROM provider_secrets_fallback",
            "SELECT * FROM ui_preferences",
            "INSERT INTO script_schedules (id, script, rule_json) VALUES ('x', 'x.py', '{}')",
            "UPDATE chart_layouts SET name = 'x'",
            "DROP TABLE watchlists",
            "CREATE TABLE sneaky (x)",
            "ALTER TABLE watchlists ADD COLUMN x",
            "ATTACH DATABASE ':memory:' AS other",
            "PRAGMA foreign_keys = OFF",
            "BEGIN",
            "CREATE TEMP TRIGGER t AFTER INSERT ON watchlists BEGIN SELECT 1; END",
        ] {
            let error = ask(&conn, sql).unwrap_err();
            assert!(error.starts_with("pt.sql can't do that"), "{sql}: {error}");
        }
        let schedules: i64 = conn
            .query_row("SELECT COUNT(*) FROM script_schedules", [], |r| r.get(0))
            .unwrap();
        assert_eq!(schedules, 0);
        // TEMP tables of its own, and describing a table, are fine.
        let answer = ask(
            &conn,
            "CREATE TEMP TABLE picks AS SELECT 'india:NSE:TCS' AS symbol; SELECT symbol FROM picks",
        )
        .unwrap();
        assert_eq!(answer.rows, [[json!("india:NSE:TCS")]]);
        assert!(ask(&conn, "PRAGMA table_info(watchlist_items)").unwrap().rows.len() > 3);
    }

    #[test]
    fn parameters_are_bound_by_name_or_position() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        let named = run(
            &conn,
            &SqlRequest {
                sql: "SELECT :a + :b AS total".into(),
                params: Params::Named(json!({"a": 2, "b": 3}).as_object().unwrap().clone()),
                dry_run: false,
            },
        )
        .unwrap();
        assert_eq!(named.rows, [[json!(5)]]);
        let positional = run(
            &conn,
            &SqlRequest {
                sql: "SELECT ? || ?".into(),
                params: Params::Positional(vec![json!("a"), json!("b")]),
                dry_run: false,
            },
        )
        .unwrap();
        assert_eq!(positional.rows, [[json!("ab")]]);
        assert!(ask(&conn, "SELECT :missing").unwrap_err().contains(":missing"));
        assert!(ask(&conn, "  ").unwrap_err().contains("no SQL"));
    }

    #[test]
    fn saved_prices_are_attached_read_only() {
        let dir = std::env::temp_dir().join(format!("ptc-sql-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let main = dir.join("charting.db");
        {
            let db = crate::db::Database::open(&dir).unwrap();
            drop(db);
        }
        let prices = dir.join("prices.db");
        {
            let p = Connection::open(&prices).unwrap();
            crate::store::price_store::init(&p).unwrap();
            p.execute(
                "INSERT INTO price_series (symbol, interval, covered_from, covered_to, synced_at, last_used, bars, sources)
                 VALUES ('india:NSE:TCS', 'D', 0, 1, 0, 0, 1, 1)",
                [],
            )
            .unwrap();
        }
        let conn = open(&main, Some(&prices)).unwrap();
        let answer = ask(&conn, "SELECT symbol FROM prices.price_series").unwrap();
        assert_eq!(answer.rows, [[json!("india:NSE:TCS")]]);
        assert!(ask(&conn, "DELETE FROM prices.price_series")
            .unwrap_err()
            .starts_with("pt.sql can't do that"));
        drop(conn);

        let without = open(&main, None).unwrap();
        assert!(ask(&without, "SELECT * FROM prices.price_bars")
            .unwrap_err()
            .contains("Save prices on this computer"));
        drop(without);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_uri_escapes_what_would_end_a_path() {
        assert_eq!(
            read_only_uri(Path::new("C:\\Users\\A B\\100%#?.db")),
            "file:C:/Users/A%20B/100%25%23%3F.db?mode=ro"
        );
    }
}
