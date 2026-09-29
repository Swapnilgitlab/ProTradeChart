//! Scheduled scripts and what happened each time one came due. The rules are `scheduler::plan`'s;
//! this only keeps them, and keeps the history short.

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::scheduler::plan::Rule;

/// History rows kept per schedule; older ones go when a new one is written.
pub const KEEP_RUNS: i64 = 30;
/// The tail of a run's output that is kept with it.
pub const MAX_OUTPUT_BYTES: usize = 16 * 1024;
const MAX_MESSAGE_CHARS: usize = 500;

/// How a history row ended. A row still going is `running`, which only [`start_run`] writes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Ok,
    Failed,
    Stopped,
    Missed,
    Skipped,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Ok => "ok",
            Status::Failed => "failed",
            Status::Stopped => "stopped",
            Status::Missed => "missed",
            Status::Skipped => "skipped",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    pub id: String,
    pub script: String,
    pub rule: Rule,
    pub enabled: bool,
    /// Epoch ms; `None` while it is switched off.
    pub next_run_at: Option<i64>,
    /// The newest history row, if any.
    pub last_run: Option<ScheduleRun>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRun {
    pub id: i64,
    pub schedule_id: String,
    /// The Python run id while it runs (to stop it); `None` for a missed or skipped one.
    pub run_id: Option<String>,
    pub status: String,
    pub due_at: i64,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub message: String,
    pub output: String,
}

fn read_run(r: &rusqlite::Row) -> rusqlite::Result<ScheduleRun> {
    Ok(ScheduleRun {
        id: r.get(0)?,
        schedule_id: r.get(1)?,
        run_id: r.get(2)?,
        status: r.get(3)?,
        due_at: r.get(4)?,
        started_at: r.get(5)?,
        finished_at: r.get(6)?,
        message: r.get(7)?,
        output: r.get(8)?,
    })
}

const RUN_COLUMNS: &str = "id, schedule_id, run_id, status, due_at, started_at, finished_at, message, output";

fn parse_rule(json: &str) -> rusqlite::Result<Rule> {
    serde_json::from_str(json)
        .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))
}

pub fn list(conn: &Connection) -> rusqlite::Result<Vec<Schedule>> {
    let mut stmt = conn.prepare(
        "SELECT id, script, rule_json, enabled, next_run_at FROM script_schedules
         ORDER BY script COLLATE NOCASE, created_at, id",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, bool>(3)?,
                r.get::<_, Option<i64>>(4)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(|(id, script, rule, enabled, next_run_at)| {
            let last_run = runs(conn, &id, 1)?.into_iter().next();
            Ok(Schedule {
                rule: parse_rule(&rule)?,
                id,
                script,
                enabled,
                next_run_at,
                last_run,
            })
        })
        .collect()
}

pub fn get(conn: &Connection, id: &str) -> rusqlite::Result<Option<Schedule>> {
    Ok(list(conn)?.into_iter().find(|s| s.id == id))
}

/// Creates or changes a schedule. A schedule switched on is planned from `now`, so switching one
/// on (or changing its times) never makes up a run it would have had before.
pub fn save(conn: &Connection, id: &str, script: &str, rule: &Rule, enabled: bool, now: i64) -> Result<(), String> {
    rule.check()?;
    let json = serde_json::to_string(rule).map_err(|e| e.to_string())?;
    let next = enabled.then(|| rule.next_after(now));
    conn.execute(
        "INSERT INTO script_schedules (id, script, rule_json, enabled, next_run_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET script = excluded.script, rule_json = excluded.rule_json,
           enabled = excluded.enabled, next_run_at = excluded.next_run_at",
        params![id, script, json, enabled, next],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Deletes a schedule and its history.
pub fn delete(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM script_schedules WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn set_next(conn: &Connection, id: &str, next: Option<i64>) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE script_schedules SET next_run_at = ?2 WHERE id = ?1",
        params![id, next],
    )?;
    Ok(())
}

/// A schedule's history, newest first.
pub fn runs(conn: &Connection, schedule_id: &str, limit: i64) -> rusqlite::Result<Vec<ScheduleRun>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {RUN_COLUMNS} FROM schedule_runs WHERE schedule_id = ?1 ORDER BY id DESC LIMIT ?2"
    ))?;
    let rows = stmt.query_map(params![schedule_id, limit], read_run)?;
    rows.collect()
}

/// Whether a run of this schedule is still going.
pub fn is_running(conn: &Connection, schedule_id: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM schedule_runs WHERE schedule_id = ?1 AND status = 'running')",
        params![schedule_id],
        |r| r.get(0),
    )
}

fn prune(conn: &Connection, schedule_id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM schedule_runs WHERE schedule_id = ?1 AND status != 'running' AND id NOT IN (
           SELECT id FROM schedule_runs WHERE schedule_id = ?1 ORDER BY id DESC LIMIT ?2)",
        params![schedule_id, KEEP_RUNS],
    )?;
    Ok(())
}

fn clip(message: &str) -> String {
    message.chars().take(MAX_MESSAGE_CHARS).collect()
}

/// Records something that happened without a run: a missed or skipped one.
pub fn record(
    conn: &Connection,
    schedule_id: &str,
    status: Status,
    due_at: i64,
    now: i64,
    message: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO schedule_runs (schedule_id, status, due_at, finished_at, message) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![schedule_id, status.as_str(), due_at, now, clip(message)],
    )?;
    prune(conn, schedule_id)
}

/// Records that a run has started, and returns its row.
pub fn start_run(conn: &Connection, schedule_id: &str, run_id: &str, due_at: i64, now: i64) -> rusqlite::Result<i64> {
    conn.execute(
        "INSERT INTO schedule_runs (schedule_id, run_id, status, due_at, started_at) VALUES (?1, ?2, 'running', ?3, ?4)",
        params![schedule_id, run_id, due_at, now],
    )?;
    let id = conn.last_insert_rowid();
    prune(conn, schedule_id)?;
    Ok(id)
}

/// Records how a run ended, with the tail of what it printed.
pub fn finish_run(
    conn: &Connection,
    row: i64,
    status: Status,
    message: &str,
    output: &str,
    now: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE schedule_runs SET status = ?2, message = ?3, output = ?4, finished_at = ?5 WHERE id = ?1",
        params![row, status.as_str(), clip(message), tail(output, MAX_OUTPUT_BYTES), now],
    )?;
    Ok(())
}

/// Runs the app didn't see finish (it was closed or crashed meanwhile) are over; says so.
pub fn recover(conn: &Connection, now: i64) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE schedule_runs SET status = 'failed', finished_at = ?1,
           message = 'The app closed while this was running, so how it ended is unknown.'
         WHERE status = 'running'",
        params![now],
    )
}

/// The last `max` bytes of `text`, cut at a line (or at least a character) boundary.
pub fn tail(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut start = text.len() - max;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    let cut = &text[start..];
    match cut.find('\n') {
        Some(nl) if nl + 1 < cut.len() => cut[nl + 1..].to_string(),
        _ => cut.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use crate::scheduler::plan::When;

    const WEEKDAYS: [bool; 7] = [true, true, true, true, true, false, false];
    /// Monday 5 January 2026, 00:00 IST.
    const MON: i64 = 1_767_551_400_000;
    const HOUR: i64 = 3_600_000;

    fn at_four() -> Rule {
        Rule {
            days: WEEKDAYS,
            when: When::Daily { at: 16 * 60 },
        }
    }

    #[test]
    fn a_schedule_is_saved_planned_from_now_and_listed() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        save(&conn, "s1", "refresh.py", &at_four(), true, MON + 17 * HOUR).unwrap();
        save(&conn, "s2", "another.py", &at_four(), false, MON).unwrap();
        let all = list(&conn).unwrap();
        assert_eq!(
            all.iter().map(|s| s.script.as_str()).collect::<Vec<_>>(),
            ["another.py", "refresh.py"]
        );
        // Saved at 17:00 Monday: next is Tuesday 16:00, not the one an hour ago.
        assert_eq!(all[1].next_run_at, Some(MON + 24 * HOUR + 16 * HOUR));
        assert_eq!(all[0].next_run_at, None);
        assert_eq!(all[1].rule, at_four());
        assert!(all[1].last_run.is_none());
    }

    #[test]
    fn a_bad_rule_is_refused() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        let none = Rule {
            days: [false; 7],
            when: When::Daily { at: 0 },
        };
        assert!(save(&conn, "s", "x.py", &none, true, MON).is_err());
        assert!(list(&conn).unwrap().is_empty());
    }

    #[test]
    fn runs_are_recorded_finished_listed_newest_first_and_pruned() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        save(&conn, "s", "x.py", &at_four(), true, MON).unwrap();
        record(&conn, "s", Status::Missed, MON, MON + 1, "Missed 3 runs").unwrap();
        let row = start_run(&conn, "s", "sched-1", MON + 2, MON + 2).unwrap();
        assert!(is_running(&conn, "s").unwrap());
        assert_eq!(runs(&conn, "s", 1).unwrap()[0].run_id.as_deref(), Some("sched-1"));
        finish_run(&conn, row, Status::Ok, "", "hello\n", MON + 3).unwrap();
        assert!(!is_running(&conn, "s").unwrap());
        let history = runs(&conn, "s", 10).unwrap();
        assert_eq!(
            history.iter().map(|r| r.status.as_str()).collect::<Vec<_>>(),
            ["ok", "missed"]
        );
        assert_eq!(history[0].output, "hello\n");
        assert_eq!(list(&conn).unwrap()[0].last_run.as_ref().unwrap().status, "ok");
        for i in 0..40 {
            record(&conn, "s", Status::Skipped, MON + i, MON + i, "").unwrap();
        }
        assert_eq!(runs(&conn, "s", 100).unwrap().len() as i64, KEEP_RUNS);
    }

    #[test]
    fn deleting_a_schedule_deletes_its_history() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        save(&conn, "s", "x.py", &at_four(), true, MON).unwrap();
        record(&conn, "s", Status::Missed, MON, MON, "").unwrap();
        delete(&conn, "s").unwrap();
        assert!(runs(&conn, "s", 10).unwrap().is_empty());
    }

    #[test]
    fn a_run_left_going_when_the_app_closed_is_marked_failed() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        save(&conn, "s", "x.py", &at_four(), true, MON).unwrap();
        start_run(&conn, "s", "sched-1", MON, MON).unwrap();
        assert_eq!(recover(&conn, MON + 5).unwrap(), 1);
        let run = &runs(&conn, "s", 1).unwrap()[0];
        assert_eq!((run.status.as_str(), run.finished_at), ("failed", Some(MON + 5)));
        assert!(run.message.contains("app closed"));
    }

    #[test]
    fn the_output_kept_is_the_tail_cut_at_a_line() {
        assert_eq!(tail("short", 100), "short");
        assert_eq!(tail("one\ntwo\nthree\n", 9), "three\n");
        // Never splits a character.
        let t = tail("ééééé", 3);
        assert!(t == "é" || t == "éé");
    }
}
