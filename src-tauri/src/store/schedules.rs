//! Scheduled sequences of scripts and what happened each time one came due. The rules are
//! `scheduler::plan`'s; this only keeps them, and keeps the history short.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::scheduler::plan::Rule;

/// History rows kept per schedule; older ones go when a new one is written.
pub const KEEP_RUNS: i64 = 30;
/// The tail of a script's output that is kept with it.
pub const MAX_OUTPUT_BYTES: usize = 16 * 1024;
/// The most scripts one schedule runs.
pub const MAX_SCRIPTS: usize = 20;
const MAX_NAME_CHARS: usize = 100;
const MAX_MESSAGE_CHARS: usize = 500;

/// How a history row (or one script of it) ended. A row still going is `running`, which only
/// [`start_run`] and [`start_step`] write.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Ok,
    Failed,
    Stopped,
    Missed,
    Skipped,
    /// A script after one that failed or was stopped.
    NotRun,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Ok => "ok",
            Status::Failed => "failed",
            Status::Stopped => "stopped",
            Status::Missed => "missed",
            Status::Skipped => "skipped",
            Status::NotRun => "not-run",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    pub id: String,
    pub name: String,
    /// The scripts it runs, in order.
    pub scripts: Vec<String>,
    pub rule: Rule,
    pub enabled: bool,
    /// Send the user an email when a run fails (`crate::email`).
    pub email_on_failure: bool,
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
    /// The Python run id of the script going now (to stop it); `None` otherwise.
    pub run_id: Option<String>,
    pub status: String,
    pub due_at: i64,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub message: String,
    /// A run from before sequences kept its script's output here; a newer one keeps it per step.
    pub output: String,
    pub steps: Vec<StepRun>,
}

/// One script of a run.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepRun {
    /// 0-based position in the sequence.
    pub step: i64,
    pub script: String,
    pub status: String,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub message: String,
    pub output: String,
}

fn has_column(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name = ?2",
        params![table, column],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n > 0)
}

/// Brings a database made before schedules ran sequences up to date: the columns a schedule
/// gained. Its one script becomes a sequence of one (`scripts_json` is read as `[script]` while
/// it is NULL). Once: a database that has them is left alone.
pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    for (column, ddl) in [
        (
            "name",
            "ALTER TABLE script_schedules ADD COLUMN name TEXT NOT NULL DEFAULT ''",
        ),
        (
            "scripts_json",
            "ALTER TABLE script_schedules ADD COLUMN scripts_json TEXT",
        ),
        (
            "email_on_failure",
            "ALTER TABLE script_schedules ADD COLUMN email_on_failure INTEGER NOT NULL DEFAULT 0",
        ),
    ] {
        if !has_column(conn, "script_schedules", column)? {
            conn.execute_batch(ddl)?;
        }
    }
    Ok(())
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
        steps: Vec::new(),
    })
}

const RUN_COLUMNS: &str = "id, schedule_id, run_id, status, due_at, started_at, finished_at, message, output";

fn bad_column(e: serde_json::Error) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
}

/// A schedule's sequence: `scripts_json`, or its one `script` when that is NULL (a database from
/// before sequences).
fn sequence(script: String, scripts_json: Option<String>) -> rusqlite::Result<Vec<String>> {
    match scripts_json {
        Some(json) => serde_json::from_str(&json).map_err(bad_column),
        None => Ok(vec![script]),
    }
}

pub fn list(conn: &Connection) -> rusqlite::Result<Vec<Schedule>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, script, scripts_json, rule_json, enabled, email_on_failure, next_run_at
         FROM script_schedules
         ORDER BY CASE name WHEN '' THEN script ELSE name END COLLATE NOCASE, created_at, id",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, bool>(5)?,
                r.get::<_, bool>(6)?,
                r.get::<_, Option<i64>>(7)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(
            |(id, name, script, scripts_json, rule, enabled, email_on_failure, next_run_at)| {
                let last_run = runs(conn, &id, 1)?.into_iter().next();
                let scripts = sequence(script, scripts_json)?;
                Ok(Schedule {
                    // A schedule from before names is called after its script.
                    name: if name.is_empty() { scripts[0].clone() } else { name },
                    rule: serde_json::from_str(&rule).map_err(bad_column)?,
                    id,
                    scripts,
                    enabled,
                    email_on_failure,
                    next_run_at,
                    last_run,
                })
            },
        )
        .collect()
}

pub fn get(conn: &Connection, id: &str) -> rusqlite::Result<Option<Schedule>> {
    Ok(list(conn)?.into_iter().find(|s| s.id == id))
}

/// What a schedule is: everything [`save`] takes but its id.
#[derive(Debug, Clone, PartialEq)]
pub struct ScheduleSpec<'a> {
    pub name: &'a str,
    pub scripts: &'a [String],
    pub rule: &'a Rule,
    pub enabled: bool,
    pub email_on_failure: bool,
}

/// Checks a schedule before it is saved: a name, one to [`MAX_SCRIPTS`] scripts, a rule that fires.
/// That each script exists is the caller's to check (it knows where scripts live).
pub fn check(spec: &ScheduleSpec) -> Result<(), String> {
    let name = spec.name.trim();
    if name.is_empty() || name.chars().count() > MAX_NAME_CHARS || name.chars().any(char::is_control) {
        return Err(format!("A schedule needs a name of 1 to {MAX_NAME_CHARS} characters."));
    }
    if spec.scripts.is_empty() {
        return Err("Add at least one script to run.".into());
    }
    if spec.scripts.len() > MAX_SCRIPTS {
        return Err(format!("A schedule can run at most {MAX_SCRIPTS} scripts."));
    }
    spec.rule.check()
}

/// Creates or changes a schedule. A schedule switched on is planned from `now`, so switching one
/// on (or changing its times) never makes up a run it would have had before.
pub fn save(conn: &Connection, id: &str, spec: &ScheduleSpec, now: i64) -> Result<(), String> {
    check(spec)?;
    let rule = serde_json::to_string(spec.rule).map_err(|e| e.to_string())?;
    let scripts = serde_json::to_string(spec.scripts).map_err(|e| e.to_string())?;
    let next = spec.enabled.then(|| spec.rule.next_after(now));
    conn.execute(
        "INSERT INTO script_schedules (id, name, script, scripts_json, rule_json, enabled, email_on_failure, next_run_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, script = excluded.script,
           scripts_json = excluded.scripts_json, rule_json = excluded.rule_json, enabled = excluded.enabled,
           email_on_failure = excluded.email_on_failure, next_run_at = excluded.next_run_at",
        params![
            id,
            spec.name.trim(),
            spec.scripts[0],
            scripts,
            rule,
            spec.enabled,
            spec.email_on_failure,
            next
        ],
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

fn steps_of(conn: &Connection, run_row: i64) -> rusqlite::Result<Vec<StepRun>> {
    let mut stmt = conn.prepare(
        "SELECT step, script, status, started_at, finished_at, message, output
         FROM schedule_steps WHERE run_row = ?1 ORDER BY step",
    )?;
    let rows = stmt.query_map(params![run_row], |r| {
        Ok(StepRun {
            step: r.get(0)?,
            script: r.get(1)?,
            status: r.get(2)?,
            started_at: r.get(3)?,
            finished_at: r.get(4)?,
            message: r.get(5)?,
            output: r.get(6)?,
        })
    })?;
    rows.collect()
}

/// A schedule's history, newest first, each run with its scripts.
pub fn runs(conn: &Connection, schedule_id: &str, limit: i64) -> rusqlite::Result<Vec<ScheduleRun>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {RUN_COLUMNS} FROM schedule_runs WHERE schedule_id = ?1 ORDER BY id DESC LIMIT ?2"
    ))?;
    let mut rows = stmt
        .query_map(params![schedule_id, limit], read_run)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for run in &mut rows {
        run.steps = steps_of(conn, run.id)?;
    }
    Ok(rows)
}

/// Whether a run of this schedule is still going.
pub fn is_running(conn: &Connection, schedule_id: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM schedule_runs WHERE schedule_id = ?1 AND status = 'running')",
        params![schedule_id],
        |r| r.get(0),
    )
}

/// The Python run id of the script a schedule's run is going through now, if any.
pub fn running_script(conn: &Connection, schedule_id: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT run_id FROM schedule_runs WHERE schedule_id = ?1 AND status = 'running' ORDER BY id DESC LIMIT 1",
        params![schedule_id],
        |r| r.get::<_, Option<String>>(0),
    )
    .optional()
    .map(Option::flatten)
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
pub fn start_run(conn: &Connection, schedule_id: &str, due_at: i64, now: i64) -> rusqlite::Result<i64> {
    conn.execute(
        "INSERT INTO schedule_runs (schedule_id, status, due_at, started_at) VALUES (?1, 'running', ?2, ?3)",
        params![schedule_id, due_at, now],
    )?;
    let id = conn.last_insert_rowid();
    prune(conn, schedule_id)?;
    Ok(id)
}

/// Records that a run's script `step` has started as Python run `run_id` (what Stop stops).
pub fn start_step(
    conn: &Connection,
    run_row: i64,
    step: usize,
    script: &str,
    run_id: &str,
    now: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO schedule_steps (run_row, step, script, status, started_at) VALUES (?1, ?2, ?3, 'running', ?4)",
        params![run_row, step as i64, script, now],
    )?;
    conn.execute(
        "UPDATE schedule_runs SET run_id = ?2 WHERE id = ?1",
        params![run_row, run_id],
    )?;
    Ok(())
}

/// Records how a run's script ended, with the tail of what it printed.
pub fn finish_step(
    conn: &Connection,
    run_row: i64,
    step: usize,
    status: Status,
    message: &str,
    output: &str,
    now: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE schedule_steps SET status = ?3, message = ?4, output = ?5, finished_at = ?6
         WHERE run_row = ?1 AND step = ?2",
        params![
            run_row,
            step as i64,
            status.as_str(),
            clip(message),
            tail(output, MAX_OUTPUT_BYTES),
            now
        ],
    )?;
    Ok(())
}

/// Records the scripts of a run that weren't run, from `first` on.
pub fn not_run(conn: &Connection, run_row: i64, first: usize, scripts: &[String]) -> rusqlite::Result<()> {
    for (step, script) in scripts.iter().enumerate().skip(first) {
        conn.execute(
            "INSERT INTO schedule_steps (run_row, step, script, status) VALUES (?1, ?2, ?3, ?4)",
            params![run_row, step as i64, script, Status::NotRun.as_str()],
        )?;
    }
    Ok(())
}

/// Records how a run ended.
pub fn finish_run(conn: &Connection, row: i64, status: Status, message: &str, now: i64) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE schedule_runs SET status = ?2, message = ?3, run_id = NULL, finished_at = ?4 WHERE id = ?1",
        params![row, status.as_str(), clip(message), now],
    )?;
    Ok(())
}

/// Runs the app didn't see finish (it was closed or crashed meanwhile) are over; says so.
pub fn recover(conn: &Connection, now: i64) -> rusqlite::Result<usize> {
    const UNKNOWN: &str = "The app closed while this was running, so how it ended is unknown.";
    conn.execute(
        "UPDATE schedule_steps SET status = 'failed', finished_at = ?1, message = ?2 WHERE status = 'running'",
        params![now, UNKNOWN],
    )?;
    conn.execute(
        "UPDATE schedule_runs SET status = 'failed', finished_at = ?1, run_id = NULL, message = ?2
         WHERE status = 'running'",
        params![now, UNKNOWN],
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

    fn scripts(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    fn save_one(conn: &Connection, id: &str, name: &str, list: &[&str], enabled: bool, now: i64) {
        let list = scripts(list);
        let rule = at_four();
        let spec = ScheduleSpec {
            name,
            scripts: &list,
            rule: &rule,
            enabled,
            email_on_failure: false,
        };
        save(conn, id, &spec, now).unwrap();
    }

    #[test]
    fn a_schedule_is_saved_planned_from_now_and_listed_by_name() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        save_one(
            &conn,
            "s1",
            "Evening screen",
            &["screen.py", "mail.py"],
            true,
            MON + 17 * HOUR,
        );
        save_one(&conn, "s2", "another", &["another.py"], false, MON);
        let all = list(&conn).unwrap();
        assert_eq!(
            all.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
            ["another", "Evening screen"]
        );
        assert_eq!(all[1].scripts, ["screen.py", "mail.py"]);
        // Saved at 17:00 Monday: next is Tuesday 16:00, not the one an hour ago.
        assert_eq!(all[1].next_run_at, Some(MON + 24 * HOUR + 16 * HOUR));
        assert_eq!(all[0].next_run_at, None);
        assert_eq!(all[1].rule, at_four());
        assert!(all[1].last_run.is_none());
    }

    #[test]
    fn a_bad_schedule_is_refused() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        let none = Rule {
            days: [false; 7],
            when: When::Daily { at: 0 },
        };
        let one = scripts(&["x.py"]);
        let too_many: Vec<String> = (0..=MAX_SCRIPTS).map(|i| format!("s{i}.py")).collect();
        let rule = at_four();
        for (name, list, rule) in [
            ("ok", &one, &none),
            ("", &one, &rule),
            ("ok", &Vec::new(), &rule),
            ("ok", &too_many, &rule),
        ] {
            let spec = ScheduleSpec {
                name,
                scripts: list,
                rule,
                enabled: true,
                email_on_failure: false,
            };
            assert!(save(&conn, "s", &spec, MON).is_err(), "{name:?} {list:?}");
        }
        assert!(list(&conn).unwrap().is_empty());
    }

    #[test]
    fn a_schedule_from_before_sequences_runs_its_one_script_and_is_named_after_it() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE script_schedules (id TEXT PRIMARY KEY, script TEXT NOT NULL, rule_json TEXT NOT NULL,
               enabled INTEGER NOT NULL DEFAULT 1, next_run_at INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')));
             CREATE TABLE schedule_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, schedule_id TEXT NOT NULL, run_id TEXT,
               status TEXT NOT NULL, due_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
               message TEXT NOT NULL DEFAULT '', output TEXT NOT NULL DEFAULT '');
             CREATE TABLE schedule_steps (run_row INTEGER NOT NULL, step INTEGER NOT NULL, script TEXT NOT NULL,
               status TEXT NOT NULL, started_at INTEGER, finished_at INTEGER, message TEXT NOT NULL DEFAULT '',
               output TEXT NOT NULL DEFAULT '', PRIMARY KEY (run_row, step));",
        )
        .unwrap();
        let rule = serde_json::to_string(&at_four()).unwrap();
        conn.execute(
            "INSERT INTO script_schedules (id, script, rule_json, next_run_at) VALUES ('old', 'refresh.py', ?1, 42)",
            params![rule],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO schedule_runs (schedule_id, status, due_at, output) VALUES ('old', 'ok', 1, 'printed')",
            [],
        )
        .unwrap();

        migrate(&conn).unwrap();
        migrate(&conn).unwrap(); // and only once
        let old = &list(&conn).unwrap()[0];
        assert_eq!(
            (old.name.as_str(), old.scripts.as_slice()),
            ("refresh.py", &["refresh.py".to_string()][..])
        );
        assert_eq!(
            (old.enabled, old.email_on_failure, old.next_run_at),
            (true, false, Some(42))
        );
        let run = old.last_run.as_ref().unwrap();
        assert_eq!((run.output.as_str(), run.steps.len()), ("printed", 0));
    }

    #[test]
    fn a_run_records_each_script_and_the_ones_not_run() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        let list3 = ["a.py", "b.py", "c.py"];
        save_one(&conn, "s", "Seq", &list3, true, MON);
        let row = start_run(&conn, "s", MON, MON).unwrap();
        assert!(is_running(&conn, "s").unwrap());
        start_step(&conn, row, 0, "a.py", "sched-1", MON + 1).unwrap();
        assert_eq!(running_script(&conn, "s").unwrap().as_deref(), Some("sched-1"));
        finish_step(&conn, row, 0, Status::Ok, "", "hello\n", MON + 2).unwrap();
        start_step(&conn, row, 1, "b.py", "sched-2", MON + 3).unwrap();
        finish_step(&conn, row, 1, Status::Failed, "Exited with code 1", "boom\n", MON + 4).unwrap();
        not_run(&conn, row, 2, &scripts(&list3)).unwrap();
        finish_run(&conn, row, Status::Failed, "b.py failed", MON + 5).unwrap();

        assert!(!is_running(&conn, "s").unwrap());
        assert_eq!(running_script(&conn, "s").unwrap(), None);
        let run = &runs(&conn, "s", 1).unwrap()[0];
        assert_eq!(run.status, "failed");
        assert_eq!(
            run.steps
                .iter()
                .map(|s| (s.script.as_str(), s.status.as_str()))
                .collect::<Vec<_>>(),
            [("a.py", "ok"), ("b.py", "failed"), ("c.py", "not-run")]
        );
        assert_eq!(run.steps[0].output, "hello\n");
    }

    #[test]
    fn history_is_newest_first_and_pruned_with_its_steps() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        save_one(&conn, "s", "S", &["x.py"], true, MON);
        record(&conn, "s", Status::Missed, MON, MON + 1, "Missed 3 runs").unwrap();
        let row = start_run(&conn, "s", MON + 2, MON + 2).unwrap();
        start_step(&conn, row, 0, "x.py", "sched-1", MON + 2).unwrap();
        finish_step(&conn, row, 0, Status::Ok, "", "", MON + 3).unwrap();
        finish_run(&conn, row, Status::Ok, "", MON + 3).unwrap();
        let history = runs(&conn, "s", 10).unwrap();
        assert_eq!(
            history.iter().map(|r| r.status.as_str()).collect::<Vec<_>>(),
            ["ok", "missed"]
        );
        assert_eq!(list(&conn).unwrap()[0].last_run.as_ref().unwrap().status, "ok");
        for i in 0..40 {
            record(&conn, "s", Status::Skipped, MON + i, MON + i, "").unwrap();
        }
        assert_eq!(runs(&conn, "s", 100).unwrap().len() as i64, KEEP_RUNS);
        let steps: i64 = conn
            .query_row("SELECT COUNT(*) FROM schedule_steps", [], |r| r.get(0))
            .unwrap();
        assert_eq!(steps, 0, "a pruned run's steps go with it");
    }

    #[test]
    fn deleting_a_schedule_deletes_its_history() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        save_one(&conn, "s", "S", &["x.py"], true, MON);
        record(&conn, "s", Status::Missed, MON, MON, "").unwrap();
        delete(&conn, "s").unwrap();
        assert!(runs(&conn, "s", 10).unwrap().is_empty());
    }

    #[test]
    fn a_run_left_going_when_the_app_closed_is_marked_failed() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        save_one(&conn, "s", "S", &["x.py"], true, MON);
        let row = start_run(&conn, "s", MON, MON).unwrap();
        start_step(&conn, row, 0, "x.py", "sched-1", MON).unwrap();
        assert_eq!(recover(&conn, MON + 5).unwrap(), 1);
        let run = &runs(&conn, "s", 1).unwrap()[0];
        assert_eq!(
            (run.status.as_str(), run.finished_at, run.run_id.as_deref()),
            ("failed", Some(MON + 5), None)
        );
        assert!(run.message.contains("app closed"));
        assert_eq!(run.steps[0].status, "failed");
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
