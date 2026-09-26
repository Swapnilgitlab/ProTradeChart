//! Running the user's Python scripts from inside the app.
//!
//! - [`env`]: finds a Python, keeps a private virtual environment for the app, and reports
//!   whether it is ready.
//! - [`runner`]: starts a script as a child process, streams its output, and stops it
//!   (with everything it started) on request.
//! - [`scripts`]: the user's `.py` files, which live as plain files in a folder so any
//!   editor and `git` work on them too.
//! - [`client_files`]: the `protrade` package scripts import to reach the data API. It is
//!   embedded in the app and written next to the venv at launch, so it always matches the
//!   running app.
//!
//! Nothing here runs a script by itself: a script runs only when the user asks for it.
//! Python is not sandboxed: a script has the user's own privileges, as it would from a
//! terminal.

pub mod client_files;
pub mod env;
pub mod runner;
pub mod scripts;

#[cfg(test)]
mod e2e;

use std::collections::HashMap;
use std::ffi::OsStr;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;

use tokio::process::Command;
use tokio::sync::oneshot;

use crate::pyapi::server::Server;

/// Where everything Python lives, under the app's local data folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Paths {
    pub root: PathBuf,
    /// The app's private virtual environment.
    pub venv: PathBuf,
    /// The user's scripts.
    pub scripts: PathBuf,
    /// Where the `protrade` package is written; put on the child's `PYTHONPATH`.
    pub lib: PathBuf,
}

impl Paths {
    pub fn under(data_dir: &std::path::Path) -> Paths {
        let root = data_dir.join("python");
        Paths {
            venv: root.join("venv"),
            scripts: root.join("scripts"),
            lib: root.join("lib"),
            root,
        }
    }
}

/// The app's Python state: what is running, and the local API (started on first use).
#[derive(Default)]
pub struct PythonState {
    /// A running script's stop switch, by run id.
    pub runs: Mutex<HashMap<String, oneshot::Sender<()>>>,
    pub api: tokio::sync::Mutex<Option<Server>>,
    pub setting_up: AtomicBool,
}

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A command for a Python tool: no console window flashing up on Windows, no stdin (so
/// `input()` fails at once instead of waiting for someone who isn't there), and killed if
/// the handle is dropped.
pub fn command(program: impl AsRef<OsStr>) -> Command {
    let mut cmd = Command::new(program);
    cmd.stdin(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// The names of environment variables a script must not inherit. The app's own environment
/// can hold the updater's signing key during development; a script has no use for it.
pub fn env_to_remove(names: impl IntoIterator<Item = String>) -> Vec<String> {
    names
        .into_iter()
        .filter(|n| {
            let upper = n.to_ascii_uppercase();
            upper.starts_with("TAURI_") || upper.starts_with("PROTRADE_")
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn everything_python_lives_under_one_folder() {
        let p = Paths::under(std::path::Path::new("/data/app"));
        assert_eq!(p.root, std::path::Path::new("/data/app").join("python"));
        assert!(p.venv.starts_with(&p.root) && p.scripts.starts_with(&p.root) && p.lib.starts_with(&p.root));
        assert_ne!(p.venv, p.scripts);
    }

    #[test]
    fn signing_keys_and_stale_api_settings_are_not_inherited() {
        let names = [
            "PATH",
            "HOME",
            "TAURI_SIGNING_PRIVATE_KEY",
            "tauri_signing_private_key_password",
            "PROTRADE_TOKEN",
            "PYTHONPATH",
            "TAURI",
        ]
        .map(String::from);
        assert_eq!(
            env_to_remove(names),
            [
                "TAURI_SIGNING_PRIVATE_KEY",
                "tauri_signing_private_key_password",
                "PROTRADE_TOKEN"
            ]
        );
    }
}
