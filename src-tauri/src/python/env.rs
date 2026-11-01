//! Finding a Python to run scripts with, and preparing the app's private environment.
//!
//! The app never bundles or downloads an interpreter: it uses one the user already has
//! (Python 3.10 or newer), makes a virtual environment from it in the app's data folder,
//! and installs pandas and numpy there. The user may instead point it at an interpreter of
//! their own (a conda or uv environment that already has vectorbt, say).

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;

use super::runner::{run_streaming, Emit, Line, Outcome, Stream};
use super::{command, Paths};

/// The oldest Python the client supports.
pub const MIN_VERSION: (u32, u32) = (3, 10);
/// What a script needs to get any use out of the client.
pub const BASELINE_PACKAGES: [&str; 2] = ["pandas", "numpy"];

const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
/// First launches of pandas can take several seconds while bytecode is compiled.
const IMPORT_TIMEOUT: Duration = Duration::from_secs(60);
/// Prints where this interpreter really is, then its version, one per line. Asking the
/// interpreter (instead of trusting a path) is what tells a real Python from the Microsoft
/// Store's stub, which is on PATH on Windows machines that have no Python at all.
const PROBE_CODE: &str = "import sys; print(sys.executable); print('.'.join(map(str, sys.version_info[:3])))";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Interpreter {
    pub path: PathBuf,
    pub version: (u32, u32, u32),
}

impl Interpreter {
    pub fn version_text(&self) -> String {
        format!("{}.{}.{}", self.version.0, self.version.1, self.version.2)
    }

    /// New enough for the client?
    pub fn is_supported(&self) -> bool {
        (self.version.0, self.version.1) >= MIN_VERSION
    }
}

/// Reads the probe's output: the last two non-empty lines are the interpreter's path and its
/// version. Anything printed before them (a site hook's banner) is ignored.
pub fn parse_probe(stdout: &str) -> Option<Interpreter> {
    let lines: Vec<&str> = stdout.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let [.., path, version] = lines.as_slice() else {
        return None;
    };
    let mut parts = version.split('.').map(|p| p.parse::<u32>().ok());
    let found = (parts.next()??, parts.next()??, parts.next()??);
    parts.next().is_none().then(|| Interpreter {
        path: PathBuf::from(path),
        version: found,
    })
}

/// Runs `program` (with any `leading` arguments, like `py -3`) and reports the interpreter it
/// turns out to be, if it is a working Python of a supported version.
pub async fn probe(program: impl AsRef<OsStr>, leading: &[&str]) -> Option<Interpreter> {
    let mut cmd = command(program);
    cmd.args(leading).args(["-c", PROBE_CODE]);
    let out = tokio::time::timeout(PROBE_TIMEOUT, cmd.output()).await.ok()?.ok()?;
    if !out.status.success() {
        return None;
    }
    let found = parse_probe(&String::from_utf8_lossy(&out.stdout))?;
    (found.is_supported() && found.path.exists()).then_some(found)
}

#[cfg(windows)]
const CANDIDATES: &[(&str, &[&str])] = &[("py", &["-3"]), ("python", &[]), ("python3", &[])];
#[cfg(not(windows))]
const CANDIDATES: &[(&str, &[&str])] = &[("python3", &[]), ("python", &[])];

/// The first supported Python on this machine, by the names people install it under.
pub async fn find_system_python() -> Option<Interpreter> {
    for (program, leading) in CANDIDATES {
        if let Some(found) = probe(program, leading).await {
            return Some(found);
        }
    }
    None
}

/// The interpreter inside a virtual environment.
pub fn venv_python(venv: &Path) -> PathBuf {
    if cfg!(windows) {
        venv.join("Scripts").join("python.exe")
    } else {
        venv.join("bin").join("python")
    }
}

/// The Python a script runs with: the user's own choice, or the app's environment.
pub fn python_to_run(paths: &Paths, custom: Option<&Path>) -> PathBuf {
    custom.map_or_else(|| venv_python(&paths.venv), Path::to_path_buf)
}

async fn has_packages(python: &Path) -> bool {
    let imports = BASELINE_PACKAGES.join(", ");
    let mut cmd = command(python);
    cmd.args(["-c", &format!("import {imports}")]);
    matches!(
        tokio::time::timeout(IMPORT_TIMEOUT, cmd.status()).await,
        Ok(Ok(status)) if status.success()
    )
}

/// The packages the Python tab's AI assistant is told about, by distribution name: the baseline,
/// and the ones a script most often wants (charts, statistics, indicator libraries). A fixed list,
/// so nothing the webview sends reaches the command line.
pub const KNOWN_PACKAGES: [&str; 9] = [
    "pandas",
    "numpy",
    "matplotlib",
    "scipy",
    "statsmodels",
    "scikit-learn",
    "ta",
    "pandas-ta",
    "TA-Lib",
];

/// Prints one JSON object: each of [`KNOWN_PACKAGES`] and its installed version, or null. Reads
/// package metadata only (nothing is imported, so it's quick), and runs with `-I` so nothing in the
/// current folder or the user's environment variables can change what it loads.
fn packages_code() -> String {
    let names = KNOWN_PACKAGES.map(|n| format!("'{n}'")).join(", ");
    format!(
        "import json, importlib.metadata as m\n\
         def v(n):\n    try:\n        return m.version(n)\n    except Exception:\n        return None\n\
         print(json.dumps({{n: v(n) for n in [{names}]}}))"
    )
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Package {
    pub name: String,
    pub version: Option<String>,
}

/// The probe's answer, in [`KNOWN_PACKAGES`]' order: its last line that is a JSON object. A name it
/// didn't mention, or a version that isn't a short string, counts as not installed.
pub fn parse_packages(stdout: &str) -> Option<Vec<Package>> {
    let found: serde_json::Map<String, serde_json::Value> = stdout
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str(line.trim()).ok())?;
    Some(
        KNOWN_PACKAGES
            .iter()
            .map(|name| Package {
                name: (*name).to_string(),
                version: found
                    .get(*name)
                    .and_then(|v| v.as_str())
                    .filter(|v| !v.is_empty() && v.len() <= 40)
                    .map(str::to_string),
            })
            .collect(),
    )
}

/// Which of [`KNOWN_PACKAGES`] `python` has, and their versions.
pub async fn packages(python: &Path) -> Result<Vec<Package>, String> {
    let mut cmd = command(python);
    cmd.args(["-I", "-c", &packages_code()]);
    let out = tokio::time::timeout(PROBE_TIMEOUT, cmd.output())
        .await
        .map_err(|_| "Python took too long to list its packages.".to_string())?
        .map_err(|e| format!("Couldn't start Python: {e}"))?;
    if !out.status.success() {
        return Err("Python couldn't list its packages.".into());
    }
    parse_packages(&String::from_utf8_lossy(&out.stdout))
        .ok_or_else(|| "Python's list of packages couldn't be read.".into())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum State {
    /// No usable Python: none installed, or the chosen one doesn't run.
    NoPython,
    /// A Python exists; the app's environment hasn't been made from it yet.
    NeedsVenv,
    /// The environment exists but pandas and numpy aren't in it.
    NeedsPackages,
    Ready,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub state: State,
    /// The interpreter scripts will run with (or would be made from), when there is one.
    pub python: Option<String>,
    pub version: Option<String>,
    /// Where the app's environment lives, or will.
    pub venv: String,
    /// The user chose the interpreter, instead of the app's environment.
    pub custom: bool,
    /// One sentence for the person: what is true, and what to do about it.
    pub message: String,
}

pub async fn status(paths: &Paths, custom: Option<&Path>) -> Status {
    let venv = paths.venv.to_string_lossy().into_owned();
    let make = |state, found: Option<&Interpreter>, message: String| Status {
        state,
        python: found.map(|i| i.path.to_string_lossy().into_owned()),
        version: found.map(Interpreter::version_text),
        venv: venv.clone(),
        custom: custom.is_some(),
        message,
    };

    let chosen = match custom {
        Some(path) => probe(path, &[]).await,
        None => {
            let own = venv_python(&paths.venv);
            if own.exists() {
                probe(&own, &[]).await
            } else {
                None
            }
        }
    };
    if let Some(found) = chosen {
        return if has_packages(&found.path).await {
            make(
                State::Ready,
                Some(&found),
                format!("Python {} is ready.", found.version_text()),
            )
        } else {
            make(
                State::NeedsPackages,
                Some(&found),
                format!(
                    "Python {} is there, but {} aren't installed in it yet.",
                    found.version_text(),
                    BASELINE_PACKAGES.join(" and ")
                ),
            )
        };
    }
    if let Some(path) = custom {
        return make(
            State::NoPython,
            None,
            format!(
                "{} doesn't start as Python {}.{} or newer. Choose another, or clear it to use the app's own environment.",
                path.display(),
                MIN_VERSION.0,
                MIN_VERSION.1
            ),
        );
    }
    match find_system_python().await {
        Some(system) => make(
            State::NeedsVenv,
            Some(&system),
            format!(
                "Python {} was found. Set up makes a private environment for the app from it and installs {}.",
                system.version_text(),
                BASELINE_PACKAGES.join(" and ")
            ),
        ),
        None => make(
            State::NoPython,
            None,
            format!(
                "Python {}.{} or newer isn't installed, or isn't on your PATH. Install it from python.org, then check again.",
                MIN_VERSION.0, MIN_VERSION.1
            ),
        ),
    }
}

/// Makes the app's environment (unless the user chose their own interpreter) and installs
/// the baseline packages into whichever Python will run scripts. Every line the tools print
/// goes to `emit`, so the person watches it happen.
pub async fn setup(paths: &Paths, custom: Option<&Path>, emit: Emit) -> Result<(), String> {
    let say = |text: String| emit(Stream::Stdout, Line { text, overwrite: false });
    let python = match custom {
        Some(path) => path.to_path_buf(),
        None => {
            let own = venv_python(&paths.venv);
            let have_venv = own.exists() && probe(&own, &[]).await.is_some();
            if !have_venv {
                let system = find_system_python().await.ok_or_else(|| {
                    format!(
                        "Python {}.{} or newer isn't installed, or isn't on your PATH.",
                        MIN_VERSION.0, MIN_VERSION.1
                    )
                })?;
                say(format!(
                    "Creating the app's Python environment in {} from Python {}…",
                    paths.venv.display(),
                    system.version_text()
                ));
                std::fs::create_dir_all(&paths.root)
                    .map_err(|e| format!("Couldn't create {}: {e}", paths.root.display()))?;
                let mut cmd = command(&system.path);
                cmd.args(["-m", "venv"]).arg(&paths.venv);
                match run_streaming(cmd, None, emit.clone()).await? {
                    Outcome::Exited(Some(0)) => {}
                    _ => {
                        return Err(
                            "Creating the environment failed; the output above says why. (On Debian or Ubuntu, \
                                    install the python3-venv package first.)"
                                .to_string(),
                        )
                    }
                }
            }
            own
        }
    };

    say(format!("Installing {}…", BASELINE_PACKAGES.join(" and ")));
    let mut cmd = command(&python);
    cmd.args(["-m", "pip", "install", "--disable-pip-version-check", "--no-input"])
        .args(BASELINE_PACKAGES);
    match run_streaming(cmd, None, emit.clone()).await? {
        Outcome::Exited(Some(0)) => {}
        _ => {
            return Err(
                "Installing the packages failed; the output above says why. You can also run \
                        `pip install pandas numpy` yourself in that Python."
                    .to_string(),
            )
        }
    }
    if !has_packages(&python).await {
        return Err("The packages installed but can't be imported; see the output above.".to_string());
    }
    say("Done. Python is ready.".to_string());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn the_package_probe_reads_its_last_json_line_in_a_fixed_order() {
        let got = parse_packages(
            "a site hook printed this\n{\"pandas\": \"2.2.3\", \"numpy\": \"2.1.0\", \"matplotlib\": null, \"evil\": \"1\"}\r\n",
        )
        .unwrap();
        assert_eq!(got.len(), KNOWN_PACKAGES.len());
        assert_eq!(
            got[0],
            Package {
                name: "pandas".into(),
                version: Some("2.2.3".into())
            }
        );
        assert_eq!(got[1].version.as_deref(), Some("2.1.0"));
        assert_eq!(got[2].version, None);
        assert!(got.iter().all(|p| p.name != "evil"));
        assert!(parse_packages("Traceback…").is_none());
    }

    #[test]
    fn the_package_probe_is_a_fixed_program() {
        let code = packages_code();
        for name in KNOWN_PACKAGES {
            assert!(code.contains(&format!("'{name}'")), "{name}");
        }
        assert!(code.contains("importlib.metadata"));
        assert!(!code.contains("import pandas"), "it reads metadata, it imports nothing");
    }

    /// Runs the probe on a real Python when there is one on PATH.
    #[tokio::test]
    async fn the_package_probe_runs_on_a_real_python() {
        let Some(found) = find_system_python().await else {
            return;
        };
        let got = packages(&found.path).await.unwrap();
        assert_eq!(got.len(), KNOWN_PACKAGES.len());
    }

    fn version(v: (u32, u32, u32)) -> Interpreter {
        Interpreter {
            path: PathBuf::from("python"),
            version: v,
        }
    }

    #[test]
    fn a_probes_last_two_lines_are_the_path_and_the_version() {
        let found = parse_probe("C:\\Python313\\python.exe\n3.13.13\n").unwrap();
        assert_eq!(found.path, PathBuf::from("C:\\Python313\\python.exe"));
        assert_eq!(found.version, (3, 13, 13));
        assert_eq!(found.version_text(), "3.13.13");
    }

    #[test]
    fn a_banner_before_them_and_a_path_with_spaces_are_fine() {
        let found = parse_probe("site hook says hello\n\n  /opt/my python/bin/python3  \r\n3.11.4\r\n").unwrap();
        assert_eq!(found.path, PathBuf::from("/opt/my python/bin/python3"));
        assert_eq!(found.version, (3, 11, 4));
    }

    #[test]
    fn output_that_is_not_a_probe_is_rejected() {
        for text in [
            "",
            "3.13.13",
            "python\n3.13",
            "python\nthree.thirteen.one",
            "python\n3.13.13.1",
            "Python was not found; run without arguments to install from the Microsoft Store.\n",
        ] {
            assert_eq!(parse_probe(text), None, "{text:?}");
        }
    }

    #[test]
    fn python_older_than_3_10_is_not_supported() {
        assert!(!version((3, 9, 18)).is_supported());
        assert!(!version((2, 7, 18)).is_supported());
        assert!(version((3, 10, 0)).is_supported());
        assert!(version((3, 13, 13)).is_supported());
        assert!(version((4, 0, 0)).is_supported());
    }

    #[test]
    fn a_venvs_interpreter_is_where_the_platform_puts_it() {
        let p = venv_python(Path::new("/data/venv"));
        if cfg!(windows) {
            assert!(
                p.ends_with("Scripts/python.exe") || p.ends_with("Scripts\\python.exe"),
                "{p:?}"
            );
        } else {
            assert!(p.ends_with("bin/python"), "{p:?}");
        }
    }

    #[test]
    fn the_users_own_interpreter_wins_over_the_apps_environment() {
        let paths = Paths::under(Path::new("/data"));
        assert_eq!(
            python_to_run(&paths, Some(Path::new("/opt/conda/bin/python"))),
            PathBuf::from("/opt/conda/bin/python")
        );
        assert_eq!(python_to_run(&paths, None), venv_python(&paths.venv));
    }

    #[tokio::test]
    async fn a_program_that_is_not_python_is_not_an_interpreter() {
        assert_eq!(probe("definitely-not-a-real-program-xyz", &[]).await, None);
    }

    #[tokio::test]
    async fn a_real_python_is_recognised_when_there_is_one() {
        let Some(found) = find_system_python().await else {
            return;
        };
        assert!(found.is_supported());
        assert!(found.path.exists());
        // Asking the interpreter it names gives the same answer.
        assert_eq!(probe(&found.path, &[]).await, Some(found));
    }

    #[tokio::test]
    async fn with_no_environment_yet_the_status_offers_to_make_one() {
        let Some(system) = find_system_python().await else {
            return;
        };
        let dir = std::env::temp_dir().join(format!("protrade-env-test-{}", std::process::id()));
        let paths = Paths::under(&dir);
        let status = status(&paths, None).await;
        assert_eq!(status.state, State::NeedsVenv);
        assert_eq!(status.python.as_deref(), Some(system.path.to_string_lossy().as_ref()));
        assert!(!status.custom);
        assert!(status.message.contains("Set up"), "{}", status.message);
    }

    #[tokio::test]
    async fn a_chosen_interpreter_that_does_not_run_says_so_and_does_not_fall_back() {
        let dir = std::env::temp_dir().join(format!("protrade-env-test2-{}", std::process::id()));
        let paths = Paths::under(&dir);
        let missing = dir.join("nowhere").join("python");
        let status = status(&paths, Some(&missing)).await;
        assert_eq!(status.state, State::NoPython);
        assert!(status.custom);
        assert!(status.message.contains("nowhere"), "{}", status.message);
    }

    #[tokio::test]
    async fn a_chosen_interpreter_with_the_packages_is_ready_without_an_environment_of_our_own() {
        let Some(system) = find_system_python().await else {
            return;
        };
        if !has_packages(&system.path).await {
            return; // this machine's Python has no pandas; nothing to prove
        }
        let dir = std::env::temp_dir().join(format!("protrade-env-test3-{}", std::process::id()));
        let paths = Paths::under(&dir);
        let status = status(&paths, Some(&system.path)).await;
        assert_eq!(status.state, State::Ready);
        assert!(status.custom);
        assert!(!paths.venv.exists(), "no environment was made");
    }

    /// Makes a real environment and installs pandas and numpy into it from the network.
    /// Run it by hand: `cargo test --lib env::tests::setup_makes -- --ignored`.
    #[tokio::test]
    #[ignore = "creates a virtual environment and installs packages from the network"]
    async fn setup_makes_a_working_environment_from_nothing() {
        let dir = std::env::temp_dir().join(format!("protrade-env-live-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let paths = Paths::under(&dir);
        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = seen.clone();
        let emit: Emit = Arc::new(move |_, line| sink.lock().unwrap().push(line.text));

        setup(&paths, None, emit).await.unwrap();

        let status = status(&paths, None).await;
        assert_eq!(status.state, State::Ready, "{}", status.message);
        assert!(seen.lock().unwrap().iter().any(|l| l.contains("Done")));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
