//! Tauri commands for Python. Like the other `*_commands.rs` files they are thin: resolve
//! paths, read the one preference, and hand over to `python/` and `pyapi/`, which hold the
//! logic and its tests. Output and results reach the webview as events.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::oneshot;

use crate::db::Database;
use crate::pyapi::backend::AppBackend;
use crate::pyapi::server;
use crate::pyapi::valid_run_id;
use crate::python::runner::{self, Emit, Outcome, Stream};
use crate::python::scripts::{self, ScriptInfo};
use crate::python::{self, client_files, env, Paths, PythonState};
use crate::store::{preferences, research_bars};

/// The interpreter the user chose instead of the app's own environment. Empty means none.
const INTERPRETER_PREF: &str = "python_interpreter";

pub(crate) fn paths(app: &AppHandle) -> Result<Paths, String> {
    app.path()
        .app_local_data_dir()
        .map(|dir| Paths::under(&dir))
        .map_err(|e| e.to_string())
}

fn custom_interpreter(db: &Database) -> Option<PathBuf> {
    let conn = db.conn.lock().ok()?;
    preferences::get(&conn, INTERPRETER_PREF)
        .ok()
        .flatten()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
}

/// `PYTHONPATH` for a script: the client's folder first, then whatever the user already had.
pub fn pythonpath(lib: &Path, existing: Option<&OsStr>) -> OsString {
    let mut parts = vec![lib.to_path_buf()];
    if let Some(existing) = existing {
        parts.extend(std::env::split_paths(existing));
    }
    std::env::join_paths(parts).unwrap_or_else(|_| lib.as_os_str().to_os_string())
}

// ---- Events ------------------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputEvent {
    run_id: String,
    stream: Stream,
    text: String,
    overwrite: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExitEvent {
    run_id: String,
    /// `None` when it was stopped or ended by a signal.
    code: Option<i32>,
    stopped: bool,
    /// Set when the script couldn't be started at all.
    error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SetupOutput {
    stream: Stream,
    text: String,
    overwrite: bool,
}

#[derive(Clone, Serialize)]
struct SetupDone {
    ok: bool,
    message: String,
}

// ---- The environment ------------------------------------------------------------

#[tauri::command]
pub async fn python_env_status(app: AppHandle, db: State<'_, Database>) -> Result<env::Status, String> {
    let paths = paths(&app)?;
    let custom = custom_interpreter(&db);
    Ok(env::status(&paths, custom.as_deref()).await)
}

/// Uses `path` as the interpreter, or the app's own environment again when it is `None`
/// or empty. A path that doesn't start as a supported Python is refused, not saved.
#[tauri::command]
pub async fn python_set_interpreter(
    path: Option<String>,
    app: AppHandle,
    db: State<'_, Database>,
) -> Result<env::Status, String> {
    let chosen = path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
    if let Some(p) = &chosen {
        if env::probe(p, &[]).await.is_none() {
            return Err(format!(
                "{p} doesn't start as Python {}.{} or newer.",
                env::MIN_VERSION.0,
                env::MIN_VERSION.1
            ));
        }
    }
    {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        preferences::set(&conn, INTERPRETER_PREF, chosen.as_deref().unwrap_or("")).map_err(|e| e.to_string())?;
    }
    python_env_status(app, db).await
}

/// Makes the app's environment and installs the baseline packages, streaming what the tools
/// print as `python-setup-output` and finishing with `python-setup-done`. Returns at once.
#[tauri::command(async)]
pub fn python_setup_env(app: AppHandle, state: State<'_, PythonState>, db: State<'_, Database>) -> Result<(), String> {
    if state.setting_up.swap(true, Ordering::SeqCst) {
        return Err("Setup is already running.".into());
    }
    let paths = match paths(&app) {
        Ok(paths) => paths,
        Err(e) => {
            state.setting_up.store(false, Ordering::SeqCst);
            return Err(e);
        }
    };
    let custom = custom_interpreter(&db);
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let sink = handle.clone();
        let emit: Emit = Arc::new(move |stream, line| {
            let _ = sink.emit(
                "python-setup-output",
                SetupOutput {
                    stream,
                    text: line.text,
                    overwrite: line.overwrite,
                },
            );
        });
        let done = match env::setup(&paths, custom.as_deref(), emit).await {
            Ok(()) => SetupDone {
                ok: true,
                message: "Python is ready.".into(),
            },
            Err(message) => SetupDone { ok: false, message },
        };
        let _ = handle.emit("python-setup-done", done);
        handle.state::<PythonState>().setting_up.store(false, Ordering::SeqCst);
    });
    Ok(())
}

// ---- Scripts -----------------------------------------------------------------------

#[tauri::command(async)]
pub fn python_list_scripts(app: AppHandle) -> Result<Vec<ScriptInfo>, String> {
    let paths = paths(&app)?;
    scripts::seed_examples(&paths.scripts).map_err(|e| format!("Couldn't prepare the scripts folder: {e}"))?;
    scripts::list(&paths.scripts).map_err(|e| format!("Couldn't read the scripts folder: {e}"))
}

#[tauri::command(async)]
pub fn python_read_script(name: String, app: AppHandle) -> Result<String, String> {
    scripts::read(&paths(&app)?.scripts, &name)
}

#[tauri::command(async)]
pub fn python_save_script(name: String, source: String, app: AppHandle) -> Result<(), String> {
    scripts::write(&paths(&app)?.scripts, &name, &source)
}

#[tauri::command(async)]
pub fn python_delete_script(name: String, app: AppHandle) -> Result<(), String> {
    scripts::delete(&paths(&app)?.scripts, &name)
}

/// Opens the scripts folder in the system's file manager.
#[tauri::command(async)]
pub fn python_reveal_folder(app: AppHandle) -> Result<(), String> {
    let paths = paths(&app)?;
    std::fs::create_dir_all(&paths.scripts).map_err(|e| e.to_string())?;
    app.opener()
        .open_path(paths.scripts.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| format!("Couldn't open the folder: {e}"))
}

// ---- Running -------------------------------------------------------------------------

/// The local data API's address and token, starting it if this is the first script.
async fn ensure_api(app: &AppHandle, state: &PythonState) -> Result<(String, String), String> {
    let mut api = state.api.lock().await;
    if api.is_none() {
        let running = server::start(Arc::new(AppBackend::new(app.clone()))).await?;
        log::info!("python data API listening at {}", running.url);
        *api = Some(running);
    }
    match api.as_ref() {
        Some(running) => Ok((running.url.clone(), running.token.clone())),
        None => Err("The local data API isn't running.".into()),
    }
}

/// Starts a script. Its output arrives as `python-output` events and its end as
/// `python-exit`, both carrying `run_id` — which the caller makes up, so it can match the
/// events to its own run. Nothing else ever starts a script.
#[tauri::command]
pub async fn python_run(
    name: String,
    run_id: String,
    app: AppHandle,
    state: State<'_, PythonState>,
    db: State<'_, Database>,
) -> Result<(), String> {
    let paths = paths(&app)?;
    let script = scripts::path_of(&paths.scripts, &name)?;
    if !scripts::exists(&paths.scripts, &name) {
        return Err(format!("There is no script called {name}."));
    }
    start_python(
        &app,
        &state,
        &db,
        StartRun {
            args: vec![script.into_os_string()],
            cwd: paths.scripts.clone(),
            run_id,
            remove_after: None,
            on_exit: None,
        },
    )
    .await
}

/// What to start: Python's arguments after `-u`, where, and a file to delete once it has ended.
pub(crate) struct StartRun {
    pub args: Vec<OsString>,
    pub cwd: PathBuf,
    pub run_id: String,
    pub remove_after: Option<PathBuf>,
    /// Told how the run ended, with the tail of its output: for a run no window is watching (a
    /// schedule's). The events are sent either way.
    pub on_exit: Option<OnExit>,
}

/// How a run ended, for [`StartRun::on_exit`].
pub(crate) struct RunEnd {
    pub outcome: Result<Outcome, String>,
    /// The last lines it printed (stdout and stderr together, stderr lines marked `! `).
    pub output: String,
}

pub(crate) type OnExit = Box<dyn FnOnce(RunEnd) + Send>;

/// Output kept for [`RunEnd`]: enough to see why a run failed.
const KEPT_OUTPUT_BYTES: usize = 32 * 1024;

/// Starts Python with the client on its path and the local API's address and token in its
/// environment, streaming its output as `python-output` and its end as `python-exit`. Shared by
/// scripts and Studies, which are both only ever started by the user.
pub(crate) async fn start_python(
    app: &AppHandle,
    state: &PythonState,
    db: &Database,
    run: StartRun,
) -> Result<(), String> {
    let StartRun {
        args,
        cwd,
        run_id,
        remove_after,
        on_exit,
    } = run;
    if !valid_run_id(&run_id) {
        return Err("That isn't a valid run id.".into());
    }
    if state.runs.lock().map_err(|e| e.to_string())?.contains_key(&run_id) {
        return Err("That run id is already in use.".into());
    }
    let paths = paths(app)?;
    let custom = custom_interpreter(db);
    let interpreter = env::python_to_run(&paths, custom.as_deref());
    if !interpreter.exists() {
        return Err("Python isn't set up yet. Choose Set up in the Python panel first.".into());
    }
    client_files::ensure(&paths.lib).map_err(|e| format!("Couldn't prepare the Python client: {e}"))?;
    let (url, token) = ensure_api(app, state).await?;

    let mut cmd = python::command(&interpreter);
    // Removed first, so the values set below are the ones the script sees.
    for stale in python::env_to_remove(std::env::vars_os().filter_map(|(k, _)| k.into_string().ok())) {
        cmd.env_remove(stale);
    }
    cmd.arg("-u")
        .args(&args)
        .current_dir(&cwd)
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .env(
            "PYTHONPATH",
            pythonpath(&paths.lib, std::env::var_os("PYTHONPATH").as_deref()),
        )
        .env("PROTRADE_API", &url)
        .env("PROTRADE_TOKEN", &token)
        .env("PROTRADE_RUN_ID", &run_id);

    let (stop_tx, stop_rx) = oneshot::channel();
    state
        .runs
        .lock()
        .map_err(|e| e.to_string())?
        .insert(run_id.clone(), stop_tx);

    let sink = app.clone();
    let output_run = run_id.clone();
    let kept: Option<Arc<std::sync::Mutex<String>>> = on_exit.as_ref().map(|_| Default::default());
    let keeper = kept.clone();
    let emit: Emit = Arc::new(move |stream, line| {
        if let Some(kept) = &keeper {
            if let Ok(mut text) = kept.lock() {
                if matches!(stream, Stream::Stderr) {
                    text.push_str("! ");
                }
                text.push_str(&line.text);
                text.push('\n');
                if text.len() > 2 * KEPT_OUTPUT_BYTES {
                    *text = crate::store::schedules::tail(&text, KEPT_OUTPUT_BYTES);
                }
            }
        }
        let _ = sink.emit(
            "python-output",
            OutputEvent {
                run_id: output_run.clone(),
                stream,
                text: line.text,
                overwrite: line.overwrite,
            },
        );
    });
    let handle = app.clone();
    let finished_run = run_id.clone();
    tauri::async_runtime::spawn(async move {
        let result = runner::run_streaming(cmd, Some(stop_rx), emit).await;
        if let Some(on_exit) = on_exit {
            let output = kept
                .and_then(|k| {
                    k.lock()
                        .ok()
                        .map(|t| crate::store::schedules::tail(&t, KEPT_OUTPUT_BYTES))
                })
                .unwrap_or_default();
            on_exit(RunEnd {
                outcome: result.clone(),
                output,
            });
        }
        if let Ok(mut runs) = handle.state::<PythonState>().runs.lock() {
            runs.remove(&finished_run);
        }
        if let Some(file) = remove_after {
            let _ = std::fs::remove_file(file);
        }
        let event = match result {
            Ok(Outcome::Exited(code)) => ExitEvent {
                run_id: finished_run,
                code,
                stopped: false,
                error: None,
            },
            Ok(Outcome::Stopped) => ExitEvent {
                run_id: finished_run,
                code: None,
                stopped: true,
                error: None,
            },
            Err(error) => ExitEvent {
                run_id: finished_run,
                code: None,
                stopped: false,
                error: Some(error),
            },
        };
        let _ = handle.emit("python-exit", event);
    });
    Ok(())
}

/// Stops a running script and everything it started. A run that has already ended is not an error.
#[tauri::command(async)]
pub fn python_stop(run_id: String, state: State<'_, PythonState>) -> Result<(), String> {
    let stop = state.runs.lock().map_err(|e| e.to_string())?.remove(&run_id);
    if let Some(stop) = stop {
        let _ = stop.send(());
    }
    Ok(())
}

// ---- The research store ------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchStats {
    pub series: i64,
    pub bars: i64,
}

/// How much market data scripts have caused the app to keep.
#[tauri::command(async)]
pub fn python_research_stats(db: State<'_, Database>) -> Result<ResearchStats, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let stats = research_bars::stats(&conn).map_err(|e| e.to_string())?;
    Ok(ResearchStats {
        series: stats.series,
        bars: stats.bars,
    })
}

/// Forgets it all; the next script that asks fetches from the broker again.
#[tauri::command(async)]
pub fn python_clear_research_data(db: State<'_, Database>) -> Result<usize, String> {
    let mut conn = db.conn.lock().map_err(|e| e.to_string())?;
    research_bars::clear(&mut conn).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_clients_folder_comes_first_and_the_users_own_path_is_kept() {
        let joined = pythonpath(
            Path::new("/app/lib"),
            Some(OsStr::new(if cfg!(windows) {
                "C:\\mine;D:\\theirs"
            } else {
                "/mine:/theirs"
            })),
        );
        let parts: Vec<_> = std::env::split_paths(&joined).collect();
        assert_eq!(parts[0], Path::new("/app/lib"));
        assert_eq!(parts.len(), 3);
    }

    #[test]
    fn with_no_path_of_their_own_it_is_just_the_clients_folder() {
        let joined = pythonpath(Path::new("/app/lib"), None);
        assert_eq!(
            std::env::split_paths(&joined).collect::<Vec<_>>(),
            [PathBuf::from("/app/lib")]
        );
    }
}
