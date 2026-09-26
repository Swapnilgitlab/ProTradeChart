//! The user's Python scripts, kept as plain `.py` files in one folder so any editor,
//! debugger and `git` work on them as well as the app's own editor.
//!
//! The frontend has no file access and only ever names a script (`screen.py`), never a
//! path. Every name is validated here, so a request can't reach outside the folder.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};

/// A script larger than this is not something a person typed.
pub const MAX_SOURCE_BYTES: usize = 2 * 1024 * 1024;
const MAX_NAME_LEN: usize = 80;

/// Files a script must not be called: a script's folder is the first place Python looks for
/// imports, so `pandas.py` would replace pandas for every script beside it. (The client's own
/// package is `protrade`.)
const SHADOWING: [&str; 22] = [
    "protrade",
    "pandas",
    "numpy",
    "scipy",
    "matplotlib",
    "requests",
    "talib",
    "vectorbt",
    "sklearn",
    "statsmodels",
    "random",
    "json",
    "time",
    "math",
    "os",
    "sys",
    "re",
    "csv",
    "datetime",
    "typing",
    "statistics",
    "string",
];
/// Names Windows reserves for devices, whatever the extension.
const DEVICES: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2",
    "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptInfo {
    pub name: String,
    pub modified_ms: i64,
    pub size: u64,
}

/// A script name: letters, digits, spaces, `_`, `-` and `.`, ending in `.py`. Returns it
/// trimmed, or says what is wrong with it.
pub fn validate_name(name: &str) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("Give the script a name.".into());
    }
    if n.len() > MAX_NAME_LEN {
        return Err(format!("A script name can be at most {MAX_NAME_LEN} characters."));
    }
    let Some(stem) = n.strip_suffix(".py") else {
        return Err("A script's name ends in .py, like screen.py.".into());
    };
    if stem.is_empty()
        || !n
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | ' '))
        || n.starts_with(['.', ' '])
        || stem.ends_with(['.', ' '])
        || n.contains("..")
    {
        return Err("Use letters, digits, spaces, _ and - in a script's name, like my_screen.py.".into());
    }
    let first = stem.split('.').next().unwrap_or(stem);
    if DEVICES.contains(&first.to_ascii_uppercase().as_str()) {
        return Err(format!("{first} is a reserved name on Windows; choose another."));
    }
    if SHADOWING.contains(&stem.to_ascii_lowercase().as_str()) {
        return Err(format!(
            "A script called {n} would replace the {stem} library for the scripts beside it; choose another name."
        ));
    }
    Ok(n.to_string())
}

/// The file for a validated name.
pub fn path_of(dir: &Path, name: &str) -> Result<PathBuf, String> {
    Ok(dir.join(validate_name(name)?))
}

fn modified_ms(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as i64)
}

/// The scripts in the folder, by name. Files that aren't valid script names are not shown.
pub fn list(dir: &Path) -> io::Result<Vec<ScriptInfo>> {
    fs::create_dir_all(dir)?;
    let mut found = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let meta = entry.metadata()?;
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if meta.is_file() && validate_name(&name).is_ok() {
            found.push(ScriptInfo {
                name,
                modified_ms: modified_ms(&meta),
                size: meta.len(),
            });
        }
    }
    found.sort_by_key(|s| s.name.to_lowercase());
    Ok(found)
}

pub fn read(dir: &Path, name: &str) -> Result<String, String> {
    let path = path_of(dir, name)?;
    fs::read_to_string(&path).map_err(|e| match e.kind() {
        io::ErrorKind::NotFound => format!("There is no script called {name}."),
        io::ErrorKind::InvalidData => format!("{name} isn't UTF-8 text, so it can't be opened here."),
        _ => format!("Couldn't read {name}: {e}"),
    })
}

/// Saves a script. Written to a temporary file and renamed into place, so a crash halfway
/// never leaves half a script.
pub fn write(dir: &Path, name: &str, source: &str) -> Result<(), String> {
    let path = path_of(dir, name)?;
    if source.len() > MAX_SOURCE_BYTES {
        return Err(format!("That script is over {} MB.", MAX_SOURCE_BYTES / (1024 * 1024)));
    }
    fs::create_dir_all(dir).map_err(|e| format!("Couldn't create the scripts folder: {e}"))?;
    let temp = dir.join(format!(".{}.tmp", validate_name(name)?));
    fs::write(&temp, source).map_err(|e| format!("Couldn't save {name}: {e}"))?;
    fs::rename(&temp, &path).map_err(|e| {
        let _ = fs::remove_file(&temp);
        format!("Couldn't save {name}: {e}")
    })
}

pub fn delete(dir: &Path, name: &str) -> Result<(), String> {
    let path = path_of(dir, name)?;
    fs::remove_file(&path).map_err(|e| match e.kind() {
        io::ErrorKind::NotFound => format!("There is no script called {name}."),
        _ => format!("Couldn't delete {name}: {e}"),
    })
}

pub fn exists(dir: &Path, name: &str) -> bool {
    path_of(dir, name).is_ok_and(|p| p.is_file())
}

/// Example scripts that ship with the app. They are offered in the scripts folder, and kept
/// current: an example the user hasn't touched is replaced when a newer version ships, so a
/// fix reaches people who already have it. One they have edited, or deleted, is left alone.
pub const EXAMPLES: &[(&str, &str)] = &[
    ("hello.py", include_str!("../../../python/examples/hello.py")),
    (
        "screen_above_200dma.py",
        include_str!("../../../python/examples/screen_above_200dma.py"),
    ),
    (
        "screen_rsi_oversold.py",
        include_str!("../../../python/examples/screen_rsi_oversold.py"),
    ),
    (
        "screen_52_week_high.py",
        include_str!("../../../python/examples/screen_52_week_high.py"),
    ),
    (
        "backtest_sma_cross.py",
        include_str!("../../../python/examples/backtest_sma_cross.py"),
    ),
];

/// What the app last wrote for each example, one `name<TAB>sha256` per line. It is how a file
/// nobody has touched is told from one that was edited (or deleted, or was never ours).
const SEEDED_MARKER: &str = ".examples-seeded";

fn digest(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

/// Tolerant: a line that isn't `name<TAB>hash` is ignored, and so is a marker that can't be read.
fn read_record(marker: &Path) -> HashMap<String, String> {
    fs::read_to_string(marker)
        .unwrap_or_default()
        .lines()
        .filter_map(|line| {
            let (name, hash) = line.split_once('\t')?;
            let (name, hash) = (name.trim(), hash.trim());
            (!name.is_empty() && !hash.is_empty()).then(|| (name.to_string(), hash.to_string()))
        })
        .collect()
}

pub fn seed_examples(dir: &Path) -> io::Result<()> {
    seed_from(dir, EXAMPLES)
}

fn seed_from(dir: &Path, examples: &[(&str, &str)]) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let marker = dir.join(SEEDED_MARKER);
    let mut record = read_record(&marker);
    let mut changed = !marker.exists();
    for (name, shipped) in examples {
        let path = dir.join(name);
        let shipped_hash = digest(shipped);
        let write_it = match (record.get(*name), path.exists()) {
            // Never offered, and nothing there: offer it.
            (None, false) => true,
            // A file of that name the app didn't write is the user's own.
            (None, true) => false,
            // The app wrote it and they deleted it: it stays deleted.
            (Some(_), false) => false,
            // Untouched since the app wrote it, and the shipped one has moved on: refresh it.
            (Some(written), true) => {
                *written != shipped_hash && fs::read_to_string(&path).is_ok_and(|on_disk| digest(&on_disk) == *written)
            }
        };
        if write_it {
            fs::write(&path, shipped)?;
            record.insert((*name).to_string(), shipped_hash);
            changed = true;
        }
    }
    if changed {
        let mut lines: Vec<String> = record.iter().map(|(name, hash)| format!("{name}\t{hash}")).collect();
        lines.sort();
        fs::write(marker, lines.join("\n") + "\n")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("protrade-scripts-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn ordinary_names_are_accepted_and_trimmed() {
        for name in ["screen.py", "my screen.py", "rsi-scan_2.py", "v1.2.py", " padded.py "] {
            assert!(validate_name(name).is_ok(), "{name}");
        }
        assert_eq!(validate_name("  a.py ").unwrap(), "a.py");
    }

    #[test]
    fn a_name_cannot_reach_outside_the_folder() {
        for name in [
            "../evil.py",
            "..\\evil.py",
            "sub/evil.py",
            "sub\\evil.py",
            "/etc/passwd.py",
            "C:\\x.py",
            "a..b.py",
            "..py",
            ".hidden.py",
            "evil.py.",
            "a/../b.py",
            "x\0.py",
        ] {
            assert!(validate_name(name).is_err(), "{name:?} should be refused");
        }
        // Whatever is accepted stays directly inside the folder.
        let dir = Path::new("/scripts");
        for name in ["ok.py", "my screen.py", "v1.2.py", " padded.py "] {
            assert_eq!(path_of(dir, name).unwrap().parent(), Some(dir), "{name}");
        }
    }

    #[test]
    fn a_name_needs_the_py_extension_and_a_stem() {
        for name in ["", "  ", "screen", "screen.txt", ".py", "screen.PY", "screen.py.txt"] {
            assert!(validate_name(name).is_err(), "{name:?}");
        }
    }

    #[test]
    fn odd_characters_and_long_names_are_refused() {
        assert!(validate_name("what?.py").is_err());
        assert!(validate_name("a*b.py").is_err());
        assert!(validate_name("naïve.py").is_err());
        assert!(validate_name(&format!("{}.py", "x".repeat(80))).is_err());
        assert!(validate_name(&format!("{}.py", "x".repeat(70))).is_ok());
    }

    #[test]
    fn windows_device_names_are_refused() {
        for name in ["con.py", "NUL.py", "Com1.py", "lpt9.py", "aux.txt.py"] {
            assert!(validate_name(name).is_err(), "{name}");
        }
        assert!(validate_name("console.py").is_ok());
    }

    #[test]
    fn a_script_may_not_be_named_after_a_library_it_would_replace() {
        for name in ["pandas.py", "NumPy.py", "protrade.py", "random.py", "json.py"] {
            let err = validate_name(name).unwrap_err();
            assert!(err.contains("replace"), "{name}: {err}");
        }
        assert!(validate_name("pandas_screen.py").is_ok());
    }

    #[test]
    fn a_script_is_saved_listed_read_and_deleted() {
        let dir = temp("crud");
        write(&dir, "b.py", "print('b')").unwrap();
        write(&dir, "A.py", "print('a')").unwrap();
        write(&dir, "b.py", "print('b2')").unwrap();

        let listed = list(&dir).unwrap();
        assert_eq!(
            listed.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
            ["A.py", "b.py"],
            "by name, case aside"
        );
        assert_eq!(listed[1].size, "print('b2')".len() as u64);
        assert!(listed[1].modified_ms > 0);
        assert_eq!(read(&dir, "b.py").unwrap(), "print('b2')");
        assert!(exists(&dir, "A.py"));

        delete(&dir, "A.py").unwrap();
        assert!(!exists(&dir, "A.py"));
        assert!(delete(&dir, "A.py").unwrap_err().contains("no script"));
        assert!(read(&dir, "A.py").unwrap_err().contains("no script"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn saving_leaves_no_temporary_file_behind() {
        let dir = temp("tmp");
        write(&dir, "a.py", "1").unwrap();
        let names: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, ["a.py"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn other_files_in_the_folder_are_not_listed_and_cannot_be_opened() {
        let dir = temp("other");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("notes.txt"), "x").unwrap();
        fs::write(dir.join(".examples-seeded"), "").unwrap();
        fs::create_dir_all(dir.join("sub.py")).unwrap(); // a folder that looks like a script
        write(&dir, "real.py", "1").unwrap();
        assert_eq!(list(&dir).unwrap().len(), 1);
        assert!(read(&dir, "notes.txt").is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_huge_script_is_refused_and_utf8_survives() {
        let dir = temp("size");
        assert!(write(&dir, "big.py", &"x".repeat(MAX_SOURCE_BYTES + 1))
            .unwrap_err()
            .contains("MB"));
        write(&dir, "rupee.py", "print('₹ 100')").unwrap();
        assert_eq!(read(&dir, "rupee.py").unwrap(), "print('₹ 100')");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_folder_is_created_on_first_use() {
        let dir = temp("missing").join("deeper");
        assert!(list(&dir).unwrap().is_empty());
        assert!(dir.is_dir());
        let _ = fs::remove_dir_all(dir.parent().unwrap());
    }

    // ---- Seeding the examples ------------------------------------------------

    const V1: &[(&str, &str)] = &[("a.py", "print('a v1')\n"), ("b.py", "print('b v1')\n")];

    fn names(dir: &Path) -> Vec<String> {
        list(dir).unwrap().into_iter().map(|s| s.name).collect()
    }

    #[test]
    fn a_new_folder_gets_every_example() {
        let dir = temp("seed");
        seed_examples(&dir).unwrap();
        let found = names(&dir);
        for (name, source) in EXAMPLES {
            assert!(found.contains(&name.to_string()), "{name}");
            assert_eq!(&read(&dir, name).unwrap(), source);
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn seeding_again_changes_nothing() {
        let dir = temp("seed-twice");
        seed_from(&dir, V1).unwrap();
        let marker_before = fs::read_to_string(dir.join(SEEDED_MARKER)).unwrap();
        seed_from(&dir, V1).unwrap();
        assert_eq!(fs::read_to_string(dir.join(SEEDED_MARKER)).unwrap(), marker_before);
        assert_eq!(read(&dir, "a.py").unwrap(), "print('a v1')\n");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_example_the_user_deleted_stays_deleted() {
        let dir = temp("seed-deleted");
        seed_from(&dir, V1).unwrap();
        delete(&dir, "a.py").unwrap();
        seed_from(&dir, V1).unwrap();
        assert!(!exists(&dir, "a.py"));
        assert!(exists(&dir, "b.py"));
        // Not even when a newer version of it ships.
        seed_from(&dir, &[("a.py", "print('a v2')\n"), V1[1]]).unwrap();
        assert!(!exists(&dir, "a.py"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_example_the_user_edited_is_never_replaced_even_by_a_newer_one() {
        let dir = temp("seed-edited");
        seed_from(&dir, V1).unwrap();
        write(&dir, "a.py", "# mine\n").unwrap();
        seed_from(&dir, &[("a.py", "print('a v2')\n"), V1[1]]).unwrap();
        assert_eq!(read(&dir, "a.py").unwrap(), "# mine\n");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_example_nobody_touched_is_brought_up_to_date_when_a_newer_one_ships() {
        let dir = temp("seed-refresh");
        seed_from(&dir, V1).unwrap();
        seed_from(&dir, &[("a.py", "print('a v2')\n"), V1[1]]).unwrap();
        assert_eq!(read(&dir, "a.py").unwrap(), "print('a v2')\n", "refreshed");
        assert_eq!(
            read(&dir, "b.py").unwrap(),
            "print('b v1')\n",
            "unchanged upstream, so unchanged"
        );
        // And the refreshed copy is itself tracked: editing it now protects it from a v3.
        write(&dir, "a.py", "# edited after the refresh\n").unwrap();
        seed_from(&dir, &[("a.py", "print('a v3')\n"), V1[1]]).unwrap();
        assert_eq!(read(&dir, "a.py").unwrap(), "# edited after the refresh\n");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn opening_and_saving_an_example_unchanged_does_not_count_as_editing_it() {
        let dir = temp("seed-resave");
        seed_from(&dir, V1).unwrap();
        let text = read(&dir, "a.py").unwrap();
        write(&dir, "a.py", &text).unwrap();
        seed_from(&dir, &[("a.py", "print('a v2')\n"), V1[1]]).unwrap();
        assert_eq!(read(&dir, "a.py").unwrap(), "print('a v2')\n");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_example_added_by_a_later_version_is_offered() {
        let dir = temp("seed-added");
        seed_from(&dir, V1).unwrap();
        seed_from(&dir, &[V1[0], V1[1], ("c.py", "print('c')\n")]).unwrap();
        assert_eq!(read(&dir, "c.py").unwrap(), "print('c')\n");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_the_user_already_had_under_an_examples_name_is_not_replaced() {
        let dir = temp("seed-theirs");
        write(&dir, "a.py", "# theirs\n").unwrap();
        seed_from(&dir, V1).unwrap();
        assert_eq!(read(&dir, "a.py").unwrap(), "# theirs\n");
        // Nor by a newer version: the app never wrote it.
        seed_from(&dir, &[("a.py", "print('a v2')\n"), V1[1]]).unwrap();
        assert_eq!(read(&dir, "a.py").unwrap(), "# theirs\n");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_first_versions_empty_marker_keeps_what_is_there_and_only_fills_gaps() {
        // That version wrote an empty marker and no record of what it had written.
        let dir = temp("seed-legacy");
        write(&dir, "a.py", "print('a old')\n").unwrap();
        fs::write(dir.join(SEEDED_MARKER), "").unwrap();
        seed_from(&dir, V1).unwrap();
        assert_eq!(
            read(&dir, "a.py").unwrap(),
            "print('a old')\n",
            "provenance unknown, so left alone"
        );
        assert_eq!(read(&dir, "b.py").unwrap(), "print('b v1')\n", "missing, so offered");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_garbled_marker_does_not_stop_seeding() {
        let dir = temp("seed-garbled");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(SEEDED_MARKER), "no tab here\n\t\nname\t\n\u{fffd}\n").unwrap();
        seed_from(&dir, V1).unwrap();
        assert!(exists(&dir, "a.py") && exists(&dir, "b.py"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_marker_is_never_listed_as_a_script() {
        let dir = temp("seed-hidden");
        seed_from(&dir, V1).unwrap();
        assert_eq!(names(&dir), ["a.py", "b.py"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn every_example_is_a_valid_name_and_mentions_the_client() {
        for (name, source) in EXAMPLES {
            assert!(validate_name(name).is_ok(), "{name}");
            assert!(source.contains("import protrade"), "{name} should use the client");
        }
    }
}
