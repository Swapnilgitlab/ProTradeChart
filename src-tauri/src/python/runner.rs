//! Runs a command as a child process, streams what it prints, and stops it — and
//! everything it started — on request.
//!
//! The same code runs a user's script and the setup commands (`venv`, `pip`). It knows
//! nothing of Tauri: output goes to a callback, so it is tested against a real Python.

use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::sync::oneshot;

/// A run's output past this many bytes is dropped, so a script that prints in a loop can't
/// bury the window. (The script keeps running; only the display is cut.)
pub const OUTPUT_LIMIT_BYTES: usize = 4 * 1024 * 1024;
/// How long to keep reading a child's pipes after it has gone: a grandchild that inherited
/// them could otherwise hold the reader open for ever.
const DRAIN_GRACE: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Stream {
    Stdout,
    Stderr,
}

/// One line of output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Line {
    pub text: String,
    /// It ended in a lone carriage return: a progress bar redrawing itself, which should
    /// replace the previous line instead of adding one.
    pub overwrite: bool,
}

/// Splits a byte stream into lines on `\n`, `\r\n` and lone `\r`. Bytes are decoded only at
/// line ends, so a character split across two reads is never mangled, and invalid UTF-8 is
/// replaced instead of ending the stream.
#[derive(Default)]
pub struct LineSplitter {
    buf: Vec<u8>,
    after_cr: bool,
}

impl LineSplitter {
    fn take(&mut self, overwrite: bool) -> Line {
        let text = String::from_utf8_lossy(&self.buf).into_owned();
        self.buf.clear();
        Line { text, overwrite }
    }

    pub fn push(&mut self, bytes: &[u8]) -> Vec<Line> {
        let mut lines = Vec::new();
        for &b in bytes {
            if self.after_cr {
                self.after_cr = false;
                if b == b'\n' {
                    lines.push(self.take(false)); // \r\n
                    continue;
                }
                lines.push(self.take(true)); // a lone \r, and this byte starts the next line
            }
            match b {
                b'\r' => self.after_cr = true,
                b'\n' => lines.push(self.take(false)),
                _ => self.buf.push(b),
            }
        }
        lines
    }

    /// What is left when the stream ends.
    pub fn finish(&mut self) -> Option<Line> {
        let had_cr = std::mem::take(&mut self.after_cr);
        (had_cr || !self.buf.is_empty()).then(|| self.take(false))
    }
}

/// Counts output against [`OUTPUT_LIMIT_BYTES`].
pub struct Limiter {
    used: usize,
    limit: usize,
    told: bool,
}

pub enum Admit {
    Yes,
    /// The limit has just been reached: show this instead, once.
    Notice(&'static str),
    No,
}

impl Limiter {
    pub fn new(limit: usize) -> Self {
        Limiter {
            used: 0,
            limit,
            told: false,
        }
    }

    pub fn admit(&mut self, line: &Line) -> Admit {
        // Once the limit has been reached nothing more is shown, however short the line:
        // output that resumes after a gap would read as if nothing had been lost.
        if self.told {
            return Admit::No;
        }
        if self.used + line.text.len() < self.limit {
            self.used += line.text.len() + 1;
            return Admit::Yes;
        }
        self.told = true;
        Admit::Notice("… output limit reached; the script is still running, but further output is not shown.")
    }
}

pub type Emit = Arc<dyn Fn(Stream, Line) + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// It ended by itself. `None` when a signal ended it.
    Exited(Option<i32>),
    /// It was stopped on request.
    Stopped,
}

async fn pump(mut pipe: impl AsyncRead + Unpin, stream: Stream, emit: Emit, limiter: Arc<Mutex<Limiter>>) {
    let mut splitter = LineSplitter::default();
    let mut chunk = [0u8; 8 * 1024];
    let send = |line: Line| {
        let verdict = limiter.lock().map(|mut l| l.admit(&line)).unwrap_or(Admit::No);
        match verdict {
            Admit::Yes => emit(stream, line),
            Admit::Notice(text) => emit(
                Stream::Stderr,
                Line {
                    text: text.to_string(),
                    overwrite: false,
                },
            ),
            Admit::No => {}
        }
    };
    loop {
        match pipe.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => splitter.push(&chunk[..n]).into_iter().for_each(&send),
        }
    }
    if let Some(rest) = splitter.finish() {
        send(rest);
    }
}

/// Ends a process and everything it started. A script that uses `multiprocessing` has
/// children of its own, and stopping only the parent would leave them working.
pub async fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        let _ = super::command("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
    }
    #[cfg(unix)]
    {
        // `run_streaming` starts the child in its own process group, so `-pid` is the group.
        let group = format!("-{pid}");
        let _ = super::command("kill")
            .args(["-TERM", "--", &group])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
        tokio::time::sleep(Duration::from_millis(800)).await;
        let _ = super::command("kill")
            .args(["-KILL", "--", &group])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
    }
}

/// Runs `cmd`, calling `emit` for every line it prints, until it exits or `stop` fires.
/// An `Err` means it could not be started at all.
pub async fn run_streaming(
    mut cmd: Command,
    stop: Option<oneshot::Receiver<()>>,
    emit: Emit,
) -> Result<Outcome, String> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);

    let mut child = cmd.spawn().map_err(|e| format!("Couldn't start Python: {e}"))?;
    let pid = child.id();
    let limiter = Arc::new(Mutex::new(Limiter::new(OUTPUT_LIMIT_BYTES)));
    let readers: Vec<_> = [
        child
            .stdout
            .take()
            .map(|p| (Box::new(p) as Box<dyn AsyncRead + Unpin + Send>, Stream::Stdout)),
        child
            .stderr
            .take()
            .map(|p| (Box::new(p) as Box<dyn AsyncRead + Unpin + Send>, Stream::Stderr)),
    ]
    .into_iter()
    .flatten()
    .map(|(pipe, stream)| tokio::spawn(pump(pipe, stream, emit.clone(), limiter.clone())))
    .collect();

    let mut stop = stop;
    let stopped = async {
        if let Some(rx) = stop.as_mut() {
            if rx.await.is_ok() {
                return;
            }
        }
        // No stop switch, or it was dropped unused: never stop.
        std::future::pending::<()>().await
    };
    let outcome = tokio::select! {
        status = child.wait() => Outcome::Exited(status.ok().and_then(|s| s.code())),
        _ = stopped => {
            if let Some(pid) = pid {
                kill_tree(pid).await;
            }
            let _ = child.wait().await;
            Outcome::Stopped
        }
    };

    let _ = tokio::time::timeout(DRAIN_GRACE, async {
        for reader in readers {
            let _ = reader.await;
        }
    })
    .await;
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::python::env::find_system_python;
    use std::path::PathBuf;
    use std::time::Instant;

    fn line(text: &str, overwrite: bool) -> Line {
        Line {
            text: text.into(),
            overwrite,
        }
    }

    // ---- The line splitter ---------------------------------------------------

    #[test]
    fn lines_split_on_newlines_and_keep_blank_ones() {
        let mut s = LineSplitter::default();
        assert_eq!(
            s.push(b"one\ntwo\n\nthree\n"),
            [
                line("one", false),
                line("two", false),
                line("", false),
                line("three", false)
            ]
        );
        assert_eq!(s.finish(), None);
    }

    #[test]
    fn a_windows_line_ending_is_one_line_break_even_across_reads() {
        let mut s = LineSplitter::default();
        assert_eq!(s.push(b"a\r\nb\r"), [line("a", false)]);
        assert_eq!(s.push(b"\nc"), [line("b", false)]);
        assert_eq!(s.finish(), Some(line("c", false)));
    }

    #[test]
    fn a_lone_carriage_return_marks_a_line_that_a_progress_bar_will_overwrite() {
        let mut s = LineSplitter::default();
        assert_eq!(
            s.push(b"10%\r50%\r100%\ndone\n"),
            [
                line("10%", true),
                line("50%", true),
                line("100%", false),
                line("done", false)
            ]
        );
    }

    #[test]
    fn a_line_split_across_reads_is_reassembled() {
        let mut s = LineSplitter::default();
        assert!(s.push(b"hel").is_empty());
        assert!(s.push(b"lo wor").is_empty());
        assert_eq!(s.push(b"ld\n"), [line("hello world", false)]);
    }

    #[test]
    fn a_character_split_across_reads_is_not_mangled_and_bad_bytes_are_replaced() {
        let rupee = "₹".as_bytes(); // three bytes
        let mut s = LineSplitter::default();
        assert!(s.push(&rupee[..1]).is_empty());
        assert!(s.push(&rupee[1..]).is_empty());
        assert_eq!(s.push(b" 100\n"), [line("₹ 100", false)]);
        assert_eq!(s.push(b"bad \xff byte\n"), [line("bad \u{fffd} byte", false)]);
    }

    #[test]
    fn what_is_left_at_the_end_is_not_lost() {
        let mut s = LineSplitter::default();
        s.push(b"no newline");
        assert_eq!(s.finish(), Some(line("no newline", false)));
        assert_eq!(s.finish(), None);
    }

    #[test]
    fn output_is_cut_off_once_with_a_notice() {
        let mut limiter = Limiter::new(20);
        assert!(matches!(limiter.admit(&line("0123456789", false)), Admit::Yes));
        assert!(matches!(limiter.admit(&line("0123456789", false)), Admit::Notice(_)));
        assert!(matches!(limiter.admit(&line("more", false)), Admit::No));
        assert!(matches!(limiter.admit(&line("more", false)), Admit::No));
    }

    // ---- A real Python -------------------------------------------------------

    async fn python() -> Option<PathBuf> {
        find_system_python().await.map(|i| i.path)
    }

    /// Everything a run printed, in order.
    type Seen = Arc<Mutex<Vec<(Stream, Line)>>>;

    fn collector() -> (Emit, Seen) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        (Arc::new(move |s, l| sink.lock().unwrap().push((s, l))), seen)
    }

    fn script(py: &PathBuf, code: &str) -> Command {
        let mut cmd = crate::python::command(py);
        cmd.args(["-u", "-c", code])
            .env("PYTHONUTF8", "1")
            .env("PYTHONIOENCODING", "utf-8");
        cmd
    }

    fn texts(seen: &Seen, stream: Stream) -> Vec<String> {
        seen.lock()
            .unwrap()
            .iter()
            .filter(|(s, _)| *s == stream)
            .map(|(_, l)| l.text.clone())
            .collect()
    }

    #[tokio::test]
    async fn a_scripts_output_and_exit_code_come_back() {
        let Some(py) = python().await else { return };
        let (emit, seen) = collector();
        let out = run_streaming(
            script(
                &py,
                "import sys; print('hello ₹'); print('oops', file=sys.stderr); sys.exit(3)",
            ),
            None,
            emit,
        )
        .await
        .unwrap();
        assert_eq!(out, Outcome::Exited(Some(3)));
        assert_eq!(texts(&seen, Stream::Stdout), ["hello ₹"]);
        assert_eq!(texts(&seen, Stream::Stderr), ["oops"]);
    }

    #[tokio::test]
    async fn a_traceback_reaches_the_console() {
        let Some(py) = python().await else { return };
        let (emit, seen) = collector();
        let out = run_streaming(script(&py, "raise ValueError('bad input')"), None, emit)
            .await
            .unwrap();
        assert_eq!(out, Outcome::Exited(Some(1)));
        let err = texts(&seen, Stream::Stderr).join("\n");
        assert!(err.contains("ValueError: bad input"), "{err}");
    }

    #[tokio::test]
    async fn stop_ends_a_running_script_promptly() {
        let Some(py) = python().await else { return };
        let (emit, _) = collector();
        let (stop, stopped) = oneshot::channel();
        let started = Instant::now();
        let running = tokio::spawn(run_streaming(
            script(&py, "import time; print('working', flush=True); time.sleep(120)"),
            Some(stopped),
            emit,
        ));
        tokio::time::sleep(Duration::from_millis(600)).await;
        stop.send(()).unwrap();
        let out = running.await.unwrap().unwrap();
        assert_eq!(out, Outcome::Stopped);
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "took {:?}",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn stop_ends_the_children_a_script_started_too() {
        let Some(py) = python().await else { return };
        // The child writes a file after a delay; if stopping left it alive the file appears.
        let marker = std::env::temp_dir().join(format!("protrade-orphan-{}.txt", std::process::id()));
        let _ = std::fs::remove_file(&marker);
        let child_code = format!(
            "import time; time.sleep(3); open(r'{}', 'w').write('alive')",
            marker.display()
        );
        let parent = format!(
            "import subprocess, sys, time; subprocess.Popen([sys.executable, '-c', {child_code:?}]); print('spawned', flush=True); time.sleep(120)"
        );
        let (emit, seen) = collector();
        let (stop, stopped) = oneshot::channel();
        let running = tokio::spawn(run_streaming(script(&py, &parent), Some(stopped), emit));
        for _ in 0..100 {
            if !texts(&seen, Stream::Stdout).is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        stop.send(()).unwrap();
        assert_eq!(running.await.unwrap().unwrap(), Outcome::Stopped);

        // The child would have written its file three seconds after it started.
        tokio::time::sleep(Duration::from_secs(4)).await;
        let survived = marker.exists();
        let _ = std::fs::remove_file(&marker);
        assert!(!survived, "the script's child outlived the stop");
    }

    #[tokio::test]
    async fn there_is_no_stdin_so_input_fails_instead_of_waiting() {
        let Some(py) = python().await else { return };
        let (emit, seen) = collector();
        let started = Instant::now();
        let out = run_streaming(script(&py, "input('?')"), None, emit).await.unwrap();
        assert_eq!(out, Outcome::Exited(Some(1)));
        assert!(texts(&seen, Stream::Stderr).join("\n").contains("EOFError"));
        assert!(started.elapsed() < Duration::from_secs(20));
    }

    #[tokio::test]
    async fn the_environment_a_script_is_given_reaches_it() {
        let Some(py) = python().await else { return };
        let (emit, seen) = collector();
        let mut cmd = script(&py, "import os; print(os.environ['PROTRADE_API'])");
        cmd.env("PROTRADE_API", "http://127.0.0.1:1234");
        run_streaming(cmd, None, emit).await.unwrap();
        assert_eq!(texts(&seen, Stream::Stdout), ["http://127.0.0.1:1234"]);
    }

    #[tokio::test]
    async fn a_flood_of_output_is_cut_off_but_the_script_still_finishes() {
        let Some(py) = python().await else { return };
        let (emit, seen) = collector();
        let out = run_streaming(
            script(
                &py,
                "print('x' * 1000)\nfor i in range(6000): print('y' * 1000)\nprint('finished')",
            ),
            None,
            emit,
        )
        .await
        .unwrap();
        assert_eq!(out, Outcome::Exited(Some(0)));
        let shown = seen.lock().unwrap().len();
        assert!(shown < 6000, "the flood was not cut off: {shown} lines");
        assert!(texts(&seen, Stream::Stderr).iter().any(|t| t.contains("output limit")));
    }

    #[tokio::test]
    async fn a_program_that_does_not_exist_is_an_error_not_a_hang() {
        let (emit, _) = collector();
        let cmd = crate::python::command("definitely-not-a-real-program-xyz");
        let err = run_streaming(cmd, None, emit).await.unwrap_err();
        assert!(err.contains("Couldn't start"), "{err}");
    }
}
