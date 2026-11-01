//! The scheduler: one task for the whole app that looks at the schedules every few seconds and
//! runs the sequences that are due, each script through the same `start_python` the Run button
//! uses, one after another.
//!
//! It never makes up a run. A schedule that came due while the app was closed (or the machine
//! slept) is recorded as missed and planned from now; on its first look after the app starts,
//! anything already due counts as missed, so starting the app never runs a script. The rules are
//! `plan::decide`'s; this only carries them out and keeps the history.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

use super::plan::{decide, Decision};
use crate::db::{now_ms, Database};
use crate::python::runner::Outcome;
use crate::python::{scripts, PythonState};
use crate::python_commands::{paths, start_python, OnExit, RunEnd, StartRun};
use crate::store::schedules::{self, Schedule, Status};

const LOOK_EVERY: Duration = Duration::from_secs(15);

/// Tells every window the schedules or their history changed.
pub const CHANGED_EVENT: &str = "schedules-changed";
/// Tells every window a scheduled run ended (the main window says so when one failed).
pub const FINISHED_EVENT: &str = "schedule-run-finished";

/// What a script of a schedule's run finds in its environment: the folder the run's scripts share
/// (emptied when the run ends), the schedule's name, and which script of how many it is.
pub const RUN_FOLDER_ENV: &str = "PROTRADE_RUN_FOLDER";
pub const SCHEDULE_ENV: &str = "PROTRADE_SCHEDULE";
pub const STEP_ENV: &str = "PROTRADE_STEP";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Finished {
    schedule_id: String,
    name: String,
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

/// Where the runs' shared folders are made.
fn runs_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(paths(app)?.root.join("runs"))
}

async fn look(app: &AppHandle, first: bool) -> Result<(), String> {
    let now = now_ms();
    let mut due = Vec::new();
    let mut changed = false;
    if first {
        // No run can be going at launch: whatever a run left in its folder is stale.
        if let Ok(root) = runs_root(app) {
            let _ = std::fs::remove_dir_all(root);
        }
    }
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
                    let due_at = s.next_run_at.unwrap_or(now);
                    due.push((s, due_at));
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
    for (schedule, due_at) in due {
        if let Err(e) = launch(app, schedule, due_at) {
            log::warn!("scheduler: couldn't start a run: {e}");
        }
        changed = true;
    }
    if changed {
        let _ = app.emit(CHANGED_EVENT, ());
    }
    Ok(())
}

static RUNS: AtomicU64 = AtomicU64::new(0);

/// Schedules whose running run the user asked to stop. Stop ends the script going now; this catches
/// the moment between two scripts, so the next one doesn't start.
static STOPS: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// Asks a schedule's running run to stop before its next script.
pub fn request_stop(schedule_id: &str) {
    if let Ok(mut stops) = STOPS.lock() {
        stops.get_or_insert_with(HashSet::new).insert(schedule_id.to_string());
    }
}

/// Whether a stop was asked for (and forgets it).
fn take_stop(schedule_id: &str) -> bool {
    STOPS
        .lock()
        .ok()
        .and_then(|mut stops| stops.as_mut().map(|s| s.remove(schedule_id)))
        .unwrap_or(false)
}

/// Starts one run of a schedule — when it is due, or when the user presses Run now — and records
/// it. Its scripts then run one after another in the background; this returns once it has begun.
pub fn launch(app: &AppHandle, schedule: Schedule, due_at: i64) -> Result<(), String> {
    let now = now_ms();
    let row = {
        let db = app.state::<Database>();
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        schedules::start_run(&conn, &schedule.id, due_at, now).map_err(|e| e.to_string())?
    };
    // A stop asked for an earlier run is not this one's.
    take_stop(&schedule.id);
    let app = app.clone();
    tauri::async_runtime::spawn(async move { run_sequence(app, schedule, row).await });
    Ok(())
}

async fn run_sequence(app: AppHandle, schedule: Schedule, row: i64) {
    let folder = runs_root(&app).map(|root| root.join(format!("{}-{row}", now_ms())));
    if let Ok(folder) = &folder {
        let _ = std::fs::create_dir_all(folder);
    }
    let stopped_at = run_steps(&schedule.scripts, |step, script| {
        let (app, schedule, folder) = (&app, &schedule, &folder);
        async move {
            let (status, message, output) = match folder {
                Ok(folder) => run_script(app, schedule, row, step, &script, folder).await,
                Err(e) => (
                    Status::Failed,
                    format!("Couldn't make the run's folder: {e}"),
                    String::new(),
                ),
            };
            if let Ok(conn) = app.state::<Database>().conn.lock() {
                if let Err(e) = schedules::finish_step(&conn, row, step, status, &message, &output, now_ms()) {
                    log::warn!("scheduler: couldn't record how a script ended: {e}");
                }
            }
            let _ = app.emit(CHANGED_EVENT, ());
            (status, message)
        }
    })
    .await;
    if let Ok(folder) = &folder {
        let _ = std::fs::remove_dir_all(folder);
    }
    let (status, message) = match stopped_at {
        None => (Status::Ok, String::new()),
        Some((status, step, message)) => {
            if let Ok(conn) = app.state::<Database>().conn.lock() {
                let _ = schedules::not_run(&conn, row, step + 1, &schedule.scripts);
            }
            (status, ending_message(&schedule.scripts, step, &message))
        }
    };
    if let Ok(conn) = app.state::<Database>().conn.lock() {
        if let Err(e) = schedules::finish_run(&conn, row, status, &message, now_ms()) {
            log::warn!("scheduler: couldn't record how a run ended: {e}");
        }
    }
    let _ = app.emit(CHANGED_EVENT, ());
    let _ = app.emit(
        FINISHED_EVENT,
        Finished {
            schedule_id: schedule.id.clone(),
            name: schedule.name.clone(),
            status: status.as_str(),
            message: message.clone(),
        },
    );
    if status == Status::Failed && schedule.email_on_failure {
        if let Err(e) = crate::email::send_failure_notice(&app, &schedule.name, &message, row).await {
            log::warn!("scheduler: couldn't email the failure of '{}': {e}", schedule.name);
        }
    }
}

/// Runs `scripts` in order through `run`, stopping at the first that doesn't end ok. Returns that
/// one's status, position and message; `None` when every script ended ok.
pub(crate) async fn run_steps<F, Fut>(scripts: &[String], mut run: F) -> Option<(Status, usize, String)>
where
    F: FnMut(usize, String) -> Fut,
    Fut: std::future::Future<Output = (Status, String)>,
{
    for (step, script) in scripts.iter().enumerate() {
        let (status, message) = run(step, script.clone()).await;
        if status != Status::Ok {
            return Some((status, step, message));
        }
    }
    None
}

/// The run's message when script `step` ended it.
fn ending_message(scripts: &[String], step: usize, message: &str) -> String {
    let why = if message.is_empty() {
        String::new()
    } else {
        format!(": {message}")
    };
    format!("{} (script {} of {}){why}", scripts[step], step + 1, scripts.len())
}

/// Runs one script of a schedule's run and waits for it to end: its status, a line saying why,
/// and the tail of what it printed.
async fn run_script(
    app: &AppHandle,
    schedule: &Schedule,
    row: i64,
    step: usize,
    script: &str,
    folder: &Path,
) -> (Status, String, String) {
    let now = now_ms();
    let run_id = format!("schedule-{now}-{}", RUNS.fetch_add(1, Ordering::Relaxed));
    if let Ok(conn) = app.state::<Database>().conn.lock() {
        if let Err(e) = schedules::start_step(&conn, row, step, script, &run_id, now) {
            log::warn!("scheduler: couldn't record a script starting: {e}");
        }
    }
    let _ = app.emit(CHANGED_EVENT, ());
    if take_stop(&schedule.id) {
        return (Status::Stopped, "Stopped before it started.".into(), String::new());
    }
    let (tx, rx) = oneshot::channel::<RunEnd>();
    let on_exit: OnExit = Box::new(move |end| {
        let _ = tx.send(end);
    });
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
                env: vec![
                    (RUN_FOLDER_ENV.into(), folder.to_string_lossy().into_owned()),
                    (SCHEDULE_ENV.into(), schedule.name.clone()),
                    (STEP_ENV.into(), format!("{}/{}", step + 1, schedule.scripts.len())),
                ],
            },
        )
        .await
    }
    .await;
    let end = match started {
        Ok(()) => rx.await.unwrap_or(RunEnd {
            outcome: Err("The script ended without saying how.".into()),
            output: String::new(),
        }),
        // `on_exit` is only called for a run that started.
        Err(error) => RunEnd {
            outcome: Err(error),
            output: String::new(),
        },
    };
    let (status, message) = verdict(&end);
    (status, message, end.output)
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

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn scripts_run_in_order_and_the_first_that_fails_ends_the_run() {
        let scripts = names(&["screen.py", "update.py", "mail.py"]);
        let ran = std::cell::RefCell::new(Vec::new());
        let outcome = tauri::async_runtime::block_on(run_steps(&scripts, |step, script| {
            ran.borrow_mut().push(script.clone());
            async move {
                if step == 1 {
                    (Status::Failed, "Exited with code 1".to_string())
                } else {
                    (Status::Ok, String::new())
                }
            }
        }));
        assert_eq!(*ran.borrow(), ["screen.py", "update.py"], "mail.py never ran");
        let (status, step, message) = outcome.unwrap();
        assert_eq!((status, step), (Status::Failed, 1));
        assert_eq!(
            ending_message(&scripts, step, &message),
            "update.py (script 2 of 3): Exited with code 1"
        );
    }

    #[test]
    fn a_sequence_that_all_ends_ok_or_is_stopped_says_so() {
        let scripts = names(&["a.py", "b.py"]);
        let all_ok = tauri::async_runtime::block_on(run_steps(&scripts, |_, _| async { (Status::Ok, String::new()) }));
        assert_eq!(all_ok, None);
        let stopped = tauri::async_runtime::block_on(run_steps(&scripts, |_, _| async {
            (Status::Stopped, "Stopped.".to_string())
        }));
        assert_eq!(stopped.map(|(s, step, _)| (s, step)), Some((Status::Stopped, 0)));
        assert_eq!(ending_message(&scripts, 0, ""), "a.py (script 1 of 2)");
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
