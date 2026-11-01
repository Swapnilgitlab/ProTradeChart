//! Tauri commands for scheduled sequences of scripts: the schedules and their history
//! (`store/schedules.rs`), and running or stopping one by hand. A schedule is made only here, by
//! the user in the Scheduler tab; nothing else — not Ask AI, not a script — can create one. The
//! engine is `scheduler/`.

use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::{now_ms, Database};
use crate::python::{scripts, PythonState};
use crate::python_commands::{paths, python_stop};
use crate::scheduler::engine::{self, CHANGED_EVENT};
use crate::scheduler::plan::Rule;
use crate::store::schedules::{self, Schedule, ScheduleRun, ScheduleSpec, KEEP_RUNS};

fn sql<T>(result: rusqlite::Result<T>) -> Result<T, String> {
    result.map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn list_schedules(db: State<Database>) -> Result<Vec<Schedule>, String> {
    sql(schedules::list(&*db.conn.lock().map_err(|e| e.to_string())?))
}

/// Creates or changes a schedule. Each of its scripts must exist; a schedule switched on is
/// planned from now.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn save_schedule(
    id: String,
    name: String,
    scripts: Vec<String>,
    rule: Rule,
    enabled: bool,
    email_on_failure: bool,
    app: AppHandle,
    db: State<Database>,
) -> Result<(), String> {
    if id.is_empty() || id.len() > 64 {
        return Err("That isn't a schedule id.".into());
    }
    let paths = paths(&app)?;
    for script in &scripts {
        scripts::path_of(&paths.scripts, script)?;
        if !scripts::exists(&paths.scripts, script) {
            return Err(format!("There is no script called {script}."));
        }
    }
    let spec = ScheduleSpec {
        name: &name,
        scripts: &scripts,
        rule: &rule,
        enabled,
        email_on_failure,
    };
    schedules::save(&*db.conn.lock().map_err(|e| e.to_string())?, &id, &spec, now_ms())?;
    let _ = app.emit(CHANGED_EVENT, ());
    Ok(())
}

/// Deletes a schedule and its history, stopping a run of it that is still going.
#[tauri::command(async)]
pub fn delete_schedule(id: String, app: AppHandle, db: State<Database>) -> Result<(), String> {
    stop_schedule_run(id.clone(), app.clone(), db.clone())?;
    sql(schedules::delete(&*db.conn.lock().map_err(|e| e.to_string())?, &id))?;
    let _ = app.emit(CHANGED_EVENT, ());
    Ok(())
}

#[tauri::command(async)]
pub fn list_schedule_runs(schedule_id: String, db: State<Database>) -> Result<Vec<ScheduleRun>, String> {
    sql(schedules::runs(
        &*db.conn.lock().map_err(|e| e.to_string())?,
        &schedule_id,
        KEEP_RUNS,
    ))
}

/// Runs a schedule's scripts now, as its schedule would (recorded in its history). The user's press.
#[tauri::command(async)]
pub fn run_schedule_now(id: String, app: AppHandle, db: State<Database>) -> Result<(), String> {
    let schedule = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        if sql(schedules::is_running(&conn, &id))? {
            return Err("It is already running.".into());
        }
        sql(schedules::get(&conn, &id))?.ok_or("That schedule no longer exists.")?
    };
    engine::launch(&app, schedule, now_ms())?;
    let _ = app.emit(CHANGED_EVENT, ());
    Ok(())
}

/// Stops the script a schedule's run is going through, which ends the run (the scripts after it
/// aren't run).
#[tauri::command(async)]
pub fn stop_schedule_run(id: String, app: AppHandle, db: State<Database>) -> Result<(), String> {
    let running = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        if sql(schedules::is_running(&conn, &id))? {
            engine::request_stop(&id);
        }
        sql(schedules::running_script(&conn, &id))?
    };
    match running {
        Some(run_id) => python_stop(run_id, app.state::<PythonState>()),
        None => Ok(()),
    }
}
