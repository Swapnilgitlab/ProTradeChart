//! The scheduler: one task for the whole app that looks at the schedules every few seconds and
//! starts the scripts that are due, through the same `start_python` the Run button uses.
//!
//! It never makes up a run. A schedule that came due while the app was closed (or the machine
//! slept) is recorded as missed and planned from now; on its first look after the app starts,
//! anything already due counts as missed, so starting the app never runs a script. The rules are
//! `plan::decide`'s; this only carries them out and keeps the history.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::plan::{decide, Decision};
use crate::db::{now_ms, Database};
use crate::python::runner::Outcome;
use crate::python::{scripts, PythonState};
use crate::python_commands::{paths, start_python, OnExit, RunEnd, StartRun};
use crate::store::schedules::{self, Status};

const LOOK_EVERY: Duration = Duration::from_secs(15);

/// Tells every window the schedules or their history changed.
pub const CHANGED_EVENT: &str = "schedules-changed";
/// Tells every window a scheduled run ended (the main window says so when one failed).
pub const FINISHED_EVENT: &str = "schedule-run-finished";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Finished {
    schedule_id: String,
    script: String,
    status: &'static str,
    message: String,
}

/// Starts the scheduler. Called once, when the app starts.
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut first = true;
        loop {
            if let Err(e) = look(&app, first).await {
                log::warn!("scheduler: {e}");
            }
            first = false;
            tokio::time::sleep(LOOK_EVERY).await;
        }
    });
}

async fn look(app: &AppHandle, first: bool) -> Result<(), String> {
    let now = now_ms();
    let mut due = Vec::new();
    let mut changed = false;
    {
        let db = app.state::<Database>();
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let sql = |e: rusqlite::Error| e.to_string();
        if first {
            changed |= schedules::recover(&conn, now).map_err(sql)? > 0;
        }
        for s in schedules::list(&conn).map_err(sql)?.into_iter().filter(|s| s.enabled) {
            let busy = schedules::is_running(&conn, &s.id).map_err(sql)?;
            match decide(&s.rule, s.next_run_at, now, first, busy) {
                Decision::Wait => {}
                Decision::Plan { next } => schedules::set_next(&conn, &s.id, Some(next)).map_err(sql)?,
                Decision::Run { next } => {
                    schedules::set_next(&conn, &s.id, Some(next)).map_err(sql)?;
                    due.push((s.id, s.script, s.next_run_at.unwrap_or(now)));
                }
                Decision::Busy { next } => {
                    schedules::set_next(&conn, &s.id, Some(next)).map_err(sql)?;
                    let due_at = s.next_run_at.unwrap_or(now);
                    schedules::record(
                        &conn,
                        &s.id,
                        Status::Skipped,
                        due_at,
                        now,
                        "Skipped: the run before it was still going.",
                    )
                    .map_err(sql)?;
                    changed = true;
                }
                Decision::Missed { first, count, next } => {
                    schedules::set_next(&conn, &s.id, Some(next)).map_err(sql)?;
                    let message = if count == 1 {
                        "Missed: it came due while the app was closed or the computer was asleep. It wasn't made up."
                            .to_string()
                    } else {
                        format!("Missed {count} runs: they came due while the app was closed or the computer was asleep. None was made up.")
                    };
                    schedules::record(&conn, &s.id, Status::Missed, first, now, &message).map_err(sql)?;
                    changed = true;
                }
            }
        }
    }
    for (id, script, due_at) in due {
        launch(app, &id, &script, due_at).await;
        changed = true;
    }
    if changed {
        let _ = app.emit(CHANGED_EVENT, ());
    }
    Ok(())
}

static RUNS: AtomicU64 = AtomicU64::new(0);

/// Starts one run of a schedule — when it is due, or when the user presses Run now — and records
/// it. A run that can't start (the script is gone, Python isn't set up) is recorded as failed.
pub async fn launch(app: &AppHandle, schedule_id: &str, script: &str, due_at: i64) {
    let now = now_ms();
    let run_id = format!("schedule-{now}-{}", RUNS.fetch_add(1, Ordering::Relaxed));
    let row = {
        let db = app.state::<Database>();
        let Ok(conn) = db.conn.lock() else { return };
        match schedules::start_run(&conn, schedule_id, &run_id, due_at, now) {
            Ok(row) => row,
            Err(e) => {
                log::warn!("scheduler: couldn't record a run: {e}");
                return;
            }
        }
    };
    let handle = app.clone();
    let (sid, name) = (schedule_id.to_string(), script.to_string());
    let on_exit: OnExit = Box::new(move |end| finish(&handle, row, &sid, &name, end));
    let started = async {
        let paths = paths(app)?;
        let file = scripts::path_of(&paths.scripts, script)?;
        if !scripts::exists(&paths.scripts, script) {
            return Err(format!("There is no script called {script} any more."));
        }
        let state = app.state::<PythonState>();
        let db = app.state::<Database>();
        start_python(
            app,
            &state,
            &db,
            StartRun {
                args: vec![file.into_os_string()],
                cwd: paths.scripts.clone(),
                run_id,
                remove_after: None,
                on_exit: Some(on_exit),
            },
        )
        .await
    }
    .await;
    // `on_exit` is only called for a run that started; one that didn't is finished here.
    if let Err(error) = started {
        finish(
            app,
            row,
            schedule_id,
            script,
            RunEnd {
                outcome: Err(error),
                output: String::new(),
            },
        );
    }
}

/// What a run's end means for its history: its status and a line saying why.
pub fn verdict(end: &RunEnd) -> (Status, String) {
    let last_error = || {
        end.output
            .lines()
            .rev()
            .find_map(|l| l.strip_prefix("! ").filter(|l| !l.trim().is_empty()))
            .map(|l| format!(": {}", l.trim()))
            .unwrap_or_default()
    };
    match &end.outcome {
        Ok(Outcome::Exited(Some(0))) => (Status::Ok, String::new()),
        Ok(Outcome::Exited(Some(code))) => (Status::Failed, format!("Exited with code {code}{}", last_error())),
        Ok(Outcome::Exited(None)) => (Status::Failed, format!("Ended by a signal{}", last_error())),
        Ok(Outcome::Stopped) => (Status::Stopped, "Stopped.".into()),
        Err(error) => (Status::Failed, error.clone()),
    }
}

fn finish(app: &AppHandle, row: i64, schedule_id: &str, script: &str, end: RunEnd) {
    let (status, message) = verdict(&end);
    if let Ok(conn) = app.state::<Database>().conn.lock() {
        if let Err(e) = schedules::finish_run(&conn, row, status, &message, &end.output, now_ms()) {
            log::warn!("scheduler: couldn't record how a run ended: {e}");
        }
    }
    let _ = app.emit(CHANGED_EVENT, ());
    let _ = app.emit(
        FINISHED_EVENT,
        Finished {
            schedule_id: schedule_id.into(),
            script: script.into(),
            status: status.as_str(),
            message,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn end(outcome: Result<Outcome, String>, output: &str) -> RunEnd {
        RunEnd {
            outcome,
            output: output.into(),
        }
    }

    #[test]
    fn a_run_that_exits_cleanly_is_ok() {
        assert_eq!(
            verdict(&end(Ok(Outcome::Exited(Some(0))), "done\n")),
            (Status::Ok, String::new())
        );
    }

    #[test]
    fn a_failed_run_says_the_last_thing_it_complained_about() {
        let out = "loading\n! Traceback (most recent call last):\n! ValueError: no symbols\nbye\n";
        assert_eq!(
            verdict(&end(Ok(Outcome::Exited(Some(1))), out)),
            (Status::Failed, "Exited with code 1: ValueError: no symbols".into())
        );
        assert_eq!(verdict(&end(Ok(Outcome::Exited(Some(2))), "")).1, "Exited with code 2");
    }

    #[test]
    fn a_stopped_or_unstartable_run_says_so() {
        assert_eq!(verdict(&end(Ok(Outcome::Stopped), "")).0, Status::Stopped);
        assert_eq!(
            verdict(&end(Err("Python isn't set up yet.".into()), "")),
            (Status::Failed, "Python isn't set up yet.".into())
        );
    }
}
