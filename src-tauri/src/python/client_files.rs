//! The `protrade` Python package, embedded in the app and written to disk so scripts can
//! import it.
//!
//! It is written at launch, next to the virtual environment, and put on each script's
//! `PYTHONPATH`. So it is never `pip install`ed: there is nothing to keep in step, and a
//! script always talks to an API of the version that started it.

use std::borrow::Cow;
use std::fs;
use std::io;
use std::path::Path;

/// `(path inside the lib folder, contents)`.
pub const FILES: &[(&str, &str)] = &[
    (
        "protrade/__init__.py",
        include_str!("../../../python/protrade/__init__.py"),
    ),
    ("protrade/api.py", include_str!("../../../python/protrade/api.py")),
    ("protrade/client.py", include_str!("../../../python/protrade/client.py")),
    (
        "protrade/features.py",
        include_str!("../../../python/protrade/features.py"),
    ),
    ("protrade/frames.py", include_str!("../../../python/protrade/frames.py")),
    (
        "protrade/results.py",
        include_str!("../../../python/protrade/results.py"),
    ),
    (
        "protrade/run_study.py",
        include_str!("../../../python/protrade/run_study.py"),
    ),
    ("protrade/stats.py", include_str!("../../../python/protrade/stats.py")),
    (
        "protrade/stats_tests.py",
        include_str!("../../../python/protrade/stats_tests.py"),
    ),
    ("protrade/study.py", include_str!("../../../python/protrade/study.py")),
];

/// A file of the package as this build writes it. A release build writes what it embedded. A debug
/// build (`npm run tauri:dev`) reads the repository's copy when it can: the dev watcher rebuilds only
/// for changes under `src-tauri/`, so after a `git pull` that changed only `python/`, an embedded copy
/// would keep running the old engine until the app was restarted by hand.
fn contents(relative: &str, embedded: &'static str) -> Cow<'static, str> {
    #[cfg(debug_assertions)]
    {
        let live = Path::new(env!("CARGO_MANIFEST_DIR")).join("../python").join(relative);
        if let Ok(text) = fs::read_to_string(live) {
            return Cow::Owned(text);
        }
    }
    let _ = relative;
    Cow::Borrowed(embedded)
}

/// Writes any file that is missing or differs from the package's current contents. Returns how many
/// it wrote.
pub fn ensure(lib: &Path) -> io::Result<usize> {
    let mut written = 0;
    for (relative, embedded) in FILES {
        let contents = contents(relative, embedded);
        let path = lib.join(relative);
        if fs::read_to_string(&path).is_ok_and(|existing| existing == *contents) {
            continue;
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&path, contents.as_bytes())?;
        written += 1;
    }
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("protrade-lib-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn the_package_is_written_and_a_second_call_writes_nothing() {
        let dir = temp("write");
        assert_eq!(ensure(&dir).unwrap(), FILES.len());
        assert_eq!(ensure(&dir).unwrap(), 0);
        for (relative, embedded) in FILES {
            assert_eq!(
                fs::read_to_string(dir.join(relative)).unwrap(),
                *contents(relative, embedded)
            );
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_stale_or_edited_file_is_put_back() {
        let dir = temp("stale");
        ensure(&dir).unwrap();
        fs::write(dir.join("protrade/client.py"), "# an older version").unwrap();
        assert_eq!(ensure(&dir).unwrap(), 1);
        assert!(fs::read_to_string(dir.join("protrade/client.py"))
            .unwrap()
            .contains("ProTradeChart"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_debug_build_writes_the_repositorys_current_python() {
        // So `git pull` + Run Study picks up an engine fix without restarting `tauri:dev`.
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../python");
        for (relative, embedded) in FILES {
            let on_disk = fs::read_to_string(repo.join(relative)).unwrap();
            let written = contents(relative, embedded);
            if cfg!(debug_assertions) {
                assert_eq!(*written, on_disk, "{relative}");
            } else {
                assert_eq!(&*written, *embedded, "{relative}");
            }
        }
        assert_eq!(&*contents("protrade/no_such_module.py", "embedded"), "embedded");
    }

    #[test]
    fn every_module_of_the_package_on_disk_is_embedded_and_nothing_else() {
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../python/protrade");
        let mut on_disk: Vec<String> = fs::read_dir(&source)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .filter(|name| name.ends_with(".py"))
            .map(|name| format!("protrade/{name}"))
            .collect();
        on_disk.sort();
        let mut embedded: Vec<String> = FILES.iter().map(|(p, _)| p.to_string()).collect();
        embedded.sort();
        assert_eq!(
            embedded, on_disk,
            "a module was added to python/protrade without being listed in FILES"
        );
    }

    #[test]
    fn the_embedded_package_imports_under_a_real_python() {
        // The cheapest way to catch a module left out of `FILES`. It needs a Python with
        // pandas, which the package imports; a machine without one has nothing to check.
        let python = if cfg!(windows) { "python" } else { "python3" };
        let has_pandas = std::process::Command::new(python)
            .args(["-c", "import pandas"])
            .output()
            .is_ok_and(|o| o.status.success());
        if !has_pandas {
            return;
        }
        let dir = temp("import");
        ensure(&dir).unwrap();
        let out = std::process::Command::new(python)
            .args(["-c", "import protrade; print(protrade.bars.__name__)"])
            .env("PYTHONPATH", &dir)
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "bars");
        let _ = fs::remove_dir_all(&dir);
    }
}
