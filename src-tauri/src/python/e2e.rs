//! End to end: a real Python process, the embedded `protrade` package, and the real local
//! server, with a fake backend standing in for the brokers. This is the path a script
//! takes in the app — the environment it is given, the token, the `Host` check, the JSON —
//! with nothing mocked between the script and the socket.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tokio::process::Command;

use super::env::find_system_python;
use super::runner::{run_streaming, Emit, Outcome, Stream};
use super::{client_files, command};
use crate::pyapi::routes::testing::FakeBackend;
use crate::pyapi::server::{self, Server};
use crate::pyapi::ApiError;

struct Harness {
    python: PathBuf,
    lib: PathBuf,
    server: Server,
    backend: Arc<FakeBackend>,
}

/// `None` on a machine with no Python that has pandas: there is nothing to run.
async fn harness(tag: &str) -> Option<Harness> {
    let python = find_system_python().await?.path;
    let has_pandas = command(&python)
        .args(["-c", "import pandas"])
        .status()
        .await
        .is_ok_and(|s| s.success());
    if !has_pandas {
        return None;
    }
    let lib = std::env::temp_dir().join(format!("protrade-e2e-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&lib);
    client_files::ensure(&lib).unwrap();
    let backend = Arc::new(FakeBackend::default());
    let server = server::start(backend.clone()).await.unwrap();
    Some(Harness {
        python,
        lib,
        server,
        backend,
    })
}

struct Ran {
    outcome: Outcome,
    stdout: String,
    stderr: String,
}

impl Harness {
    async fn run(&self, code: &str, token: Option<&str>) -> Ran {
        let mut cmd: Command = command(&self.python);
        cmd.args(["-u", "-c", code])
            .env("PYTHONPATH", &self.lib)
            .env("PYTHONUTF8", "1")
            .env("PROTRADE_API", &self.server.url)
            .env("PROTRADE_TOKEN", token.unwrap_or(&self.server.token))
            .env("PROTRADE_RUN_ID", "e2e-run")
            .env("PROTRADE_TIMEOUT", "20");
        let seen = Arc::new(Mutex::new((String::new(), String::new())));
        let sink = seen.clone();
        let emit: Emit = Arc::new(move |stream, line| {
            let mut out = sink.lock().unwrap();
            let target = if stream == Stream::Stdout {
                &mut out.0
            } else {
                &mut out.1
            };
            target.push_str(&line.text);
            target.push('\n');
        });
        let outcome = run_streaming(cmd, None, emit).await.unwrap();
        let (stdout, stderr) = seen.lock().unwrap().clone();
        Ran {
            outcome,
            stdout,
            stderr,
        }
    }

    fn cleanup(&self) {
        let _ = std::fs::remove_dir_all(&self.lib);
    }
}

#[tokio::test]
async fn a_script_reads_bars_and_lists_through_the_real_api() {
    let Some(h) = harness("bars").await else { return };
    let ran = h
        .run(
            "import protrade as pt\n\
             df = pt.bars('zerodha:NSE:RELIANCE', 'D', start='2020-01-01', end='2024-03-01', limit=10)\n\
             print(len(df), df['close'].iloc[0], df['volume'].iloc[0], df.index.tz)\n\
             print(pt.watchlists().to_string(index=False))\n\
             print(pt.providers()['usable'].tolist())\n\
             print(pt.status()['ok'])",
            None,
        )
        .await;
    assert_eq!(ran.outcome, Outcome::Exited(Some(0)), "stderr: {}", ran.stderr);
    assert!(ran.stdout.contains("1 1.5 9.0 Asia/Kolkata"), "{}", ran.stdout);
    assert!(ran.stdout.contains("Nifty 50"), "{}", ran.stdout);
    assert!(ran.stdout.contains("[True]"), "{}", ran.stdout);
    assert!(ran.stdout.trim_end().ends_with("True"), "{}", ran.stdout);

    // What the app saw is what the script asked for.
    let seen = h.backend.last_bars.lock().unwrap().clone().unwrap();
    assert_eq!(
        (seen.symbol.as_str(), seen.interval.as_str(), seen.limit),
        ("zerodha:NSE:RELIANCE", "D", Some(10))
    );
    assert!(seen.from_ms.is_some() && seen.to_ms.is_some());
    h.cleanup();
}

#[tokio::test]
async fn the_example_scripts_that_ship_with_the_app_run_against_the_real_api() {
    let Some(h) = harness("examples").await else { return };
    // Three years of daily bars, so the screens and the backtest have something to work on.
    *h.backend.bar_count.lock().unwrap() = 760;
    for (name, source) in super::scripts::EXAMPLES {
        h.backend.results.lock().unwrap().clear();
        let ran = h.run(source, None).await;
        assert_eq!(ran.outcome, Outcome::Exited(Some(0)), "{name} failed:\n{}", ran.stderr);
        assert!(ran.stderr.is_empty(), "{name} wrote to stderr:\n{}", ran.stderr);
        assert!(!ran.stdout.trim().is_empty(), "{name} printed nothing");

        // Every example but the greeting shows something in the app.
        let shown = h.backend.results.lock().unwrap().clone();
        if *name == "hello.py" {
            assert!(shown.is_empty(), "hello.py should only print");
            continue;
        }
        assert_eq!(shown.len(), 1, "{name} showed {} results", shown.len());
        let result = &shown[0];
        assert_eq!(result.run_id, "e2e-run");
        assert!(result.title.is_some(), "{name} showed an untitled result");
        if name.starts_with("screen_") {
            assert_eq!(result.kind, "table", "{name}");
            let rows = result.data["rows"].as_array().expect("rows");
            assert!(!rows.is_empty(), "{name} showed an empty table");
            // The symbol column is what makes a row clickable.
            assert_eq!(result.data["symbolColumn"], 0, "{name}");
            assert!(
                rows[0][0].as_str().is_some_and(|s| s.starts_with("zerodha:NSE:")),
                "{name}: {rows:?}"
            );
        } else {
            assert_eq!(result.kind, "report", "{name}");
            let metrics = result.data["metrics"].as_array().expect("metrics");
            assert!(
                metrics.iter().any(|m| m["label"] == "Total return"),
                "{name}: {metrics:?}"
            );
            assert!(
                result.data["equity"]["v"].as_array().is_some_and(|v| v.len() > 10),
                "{name}"
            );
            assert!(
                result.data["benchmark"]["v"].as_array().is_some(),
                "{name} had no benchmark"
            );
        }
    }
    h.cleanup();
}

/// A table and a report from a script, through the real socket, as the app will receive them.
#[tokio::test]
async fn a_script_shows_a_table_and_a_report_in_the_app() {
    let Some(h) = harness("results").await else { return };
    let ran = h
        .run(
            "import pandas as pd, protrade as pt\n\
             pt.show(pd.DataFrame({'symbol': ['zerodha:NSE:TCS'], 'close': [4000.5]}), title='Screen')\n\
             equity = pd.Series([100.0, 110.0, 121.0], index=pd.date_range('2024-01-01', periods=3, freq='D'))\n\
             pt.report(trades=pd.DataFrame({'pnl': [10.0, -5.0]}), equity=equity, title='Test')\n\
             print('shown')",
            None,
        )
        .await;
    assert_eq!(ran.outcome, Outcome::Exited(Some(0)), "stderr: {}", ran.stderr);

    let shown = h.backend.results.lock().unwrap().clone();
    assert_eq!(shown.len(), 2);
    assert_eq!(
        (shown[0].kind.as_str(), shown[0].title.as_deref()),
        ("table", Some("Screen"))
    );
    assert_eq!(shown[0].data["rows"][0][0], "zerodha:NSE:TCS");
    assert_eq!(
        (shown[1].kind.as_str(), shown[1].title.as_deref()),
        ("report", Some("Test"))
    );
    assert_eq!(shown[1].data["equity"]["v"].as_array().unwrap().len(), 3);
    h.cleanup();
}

#[tokio::test]
async fn a_study_runs_through_the_real_api_and_posts_one_result_even_with_no_events() {
    let Some(h) = harness("study").await else { return };
    let ran = h
        .run(
            "import json, sys\n\
             from protrade import run_study\n\
             spec = {'name': 'E2E', 'universe': {'source': 'symbols', 'symbols': ['zerodha:NSE:RELIANCE']},\n\
                     'period': {'start': '2020-01-01'}, 'event': {'conditions': ['return_21 crosses_above 5']},\n\
                     'metrics': ['return_21', 'rsi_14']}\n\
             open('e2e-spec.json', 'w').write(json.dumps(spec))\n\
             sys.exit(run_study.main(['run_study', 'e2e-spec.json']))",
            None,
        )
        .await;
    let _ = std::fs::remove_file("e2e-spec.json");
    assert_eq!(ran.outcome, Outcome::Exited(Some(0)), "stderr: {}", ran.stderr);
    assert!(ran.stdout.contains("[progress] 100% Complete"), "{}", ran.stdout);

    let shown = h.backend.results.lock().unwrap().clone();
    assert_eq!(shown.len(), 1);
    assert_eq!(
        (shown[0].kind.as_str(), shown[0].title.as_deref()),
        ("study", Some("E2E"))
    );
    assert_eq!(shown[0].data["format"], 1);
    assert_eq!(shown[0].data["summary"]["events"], 0);
    assert_eq!(shown[0].data["spec"]["event"]["conditions"][0]["left"], "return_21");
    assert_eq!(shown[0].data["availability"]["market_cap"], false);
    h.cleanup();
}

/// A script that isn't started by the app has nowhere to show things, so it prints instead of failing.
#[tokio::test]
async fn showing_something_outside_the_app_prints_it() {
    let Some(h) = harness("outside").await else { return };
    let mut cmd = command(&h.python);
    cmd.args([
        "-u",
        "-c",
        "import pandas as pd, protrade as pt; pt.show(pd.DataFrame({'symbol': ['p:A'], 'x': [1]}))",
    ])
    .env("PYTHONPATH", &h.lib)
    .env("PYTHONUTF8", "1")
    .env("PROTRADE_API", &h.server.url)
    .env("PROTRADE_TOKEN", &h.server.token);
    // No PROTRADE_RUN_ID: the same as running the script from a terminal.
    let seen = Arc::new(Mutex::new(String::new()));
    let sink = seen.clone();
    let emit: Emit = Arc::new(move |_, line| sink.lock().unwrap().push_str(&line.text));
    let outcome = run_streaming(cmd, None, emit).await.unwrap();

    assert_eq!(outcome, Outcome::Exited(Some(0)), "{}", seen.lock().unwrap());
    assert!(seen.lock().unwrap().contains("p:A"));
    assert!(h.backend.results.lock().unwrap().is_empty(), "nothing was posted");
    h.cleanup();
}

/// The way most people meet them: a first run, before they have made a single watchlist. An
/// example that only works for someone who has set things up is a broken example.
#[tokio::test]
async fn the_example_scripts_work_for_someone_with_no_watchlists() {
    let Some(h) = harness("no-lists").await else { return };
    *h.backend.no_watchlists.lock().unwrap() = true;
    for (name, source) in super::scripts::EXAMPLES {
        let ran = h.run(source, None).await;
        assert_eq!(ran.outcome, Outcome::Exited(Some(0)), "{name} failed:\n{}", ran.stderr);
        assert!(ran.stderr.is_empty(), "{name} wrote to stderr:\n{}", ran.stderr);
    }
    // The screen fell back to a sample of large stocks through the broker that is set up.
    let screen = h
        .run(
            super::scripts::EXAMPLES
                .iter()
                .find(|(n, _)| *n == "screen_above_200dma.py")
                .unwrap()
                .1,
            None,
        )
        .await;
    assert!(
        screen
            .stdout
            .contains("Screening 10 symbols from a sample of large NSE stocks"),
        "{}",
        screen.stdout
    );
    let asked = h.backend.last_bars.lock().unwrap().clone().unwrap();
    assert!(asked.symbol.starts_with("zerodha:NSE:"), "{}", asked.symbol);
    h.cleanup();
}

/// Someone who names a watchlist they don't have is told so, and told what they do have. The
/// screen stops rather than quietly screening something else: they asked for a particular list.
#[tokio::test]
async fn naming_a_watchlist_that_does_not_exist_says_so_rather_than_screening_something_else() {
    let Some(h) = harness("named").await else { return };
    *h.backend.no_watchlists.lock().unwrap() = true;
    let source = super::scripts::EXAMPLES
        .iter()
        .find(|(n, _)| *n == "screen_above_200dma.py")
        .unwrap()
        .1
        .replace("WATCHLIST = None", "WATCHLIST = \"Nifty 50\"");
    let ran = h.run(&source, None).await;
    assert_eq!(ran.outcome, Outcome::Exited(Some(1)), "stdout: {}", ran.stdout);
    assert!(
        ran.stderr.contains("NotFoundError") && ran.stderr.contains("There is no watchlist called 'Nifty 50'"),
        "{}",
        ran.stderr
    );
    assert!(
        !ran.stdout.contains("Screening"),
        "it should not have screened anything: {}",
        ran.stdout
    );
    assert!(h.backend.results.lock().unwrap().is_empty());
    h.cleanup();
}

#[tokio::test]
async fn a_script_with_the_wrong_token_is_refused_with_a_message_that_says_why() {
    let Some(h) = harness("token").await else { return };
    let ran = h
        .run("import protrade as pt\npt.bars('zerodha:NSE:X')", Some("not-the-token"))
        .await;
    assert_eq!(ran.outcome, Outcome::Exited(Some(1)));
    assert!(ran.stderr.contains("ConnectionFailed"), "{}", ran.stderr);
    assert!(ran.stderr.contains("API token"), "{}", ran.stderr);
    assert!(h.backend.last_bars.lock().unwrap().is_none(), "no data was read");
    h.cleanup();
}

#[tokio::test]
async fn a_brokers_expired_token_reaches_the_script_as_an_auth_error_it_can_catch() {
    let Some(h) = harness("auth").await else { return };
    *h.backend.fail_bars_with.lock().unwrap() = Some(ApiError::new(
        401,
        "auth",
        "Zerodha rejected your access token. Kite tokens expire every morning around 6 AM.",
    ));
    let ran = h
        .run(
            "import protrade as pt\n\
             try:\n\
             \x20   pt.bars('zerodha:NSE:X')\n\
             except pt.AuthError as e:\n\
             \x20   print('caught:', e)\n\
             try:\n\
             \x20   pt.bars_many(['zerodha:NSE:A', 'zerodha:NSE:B'], errors='skip', progress=False)\n\
             except pt.ProTradeError as e:\n\
             \x20   print('batch stopped:', type(e).__name__)",
            None,
        )
        .await;
    assert_eq!(ran.outcome, Outcome::Exited(Some(0)), "stderr: {}", ran.stderr);
    assert!(
        ran.stdout.contains("caught: Zerodha rejected your access token"),
        "{}",
        ran.stdout
    );
    assert!(
        ran.stdout.contains("batch stopped: AuthError"),
        "an expired token ends a skipping batch: {}",
        ran.stdout
    );
    h.cleanup();
}

#[tokio::test]
async fn a_script_started_without_the_app_is_told_to_use_the_python_tab() {
    let Some(h) = harness("bare").await else { return };
    let mut cmd = command(&h.python);
    cmd.args(["-c", "import protrade as pt; pt.status()"])
        .env("PYTHONPATH", &h.lib)
        .env_remove("PROTRADE_API")
        .env_remove("PROTRADE_TOKEN");
    let seen = Arc::new(Mutex::new(String::new()));
    let sink = seen.clone();
    let emit: Emit = Arc::new(move |_, line| sink.lock().unwrap().push_str(&line.text));
    let outcome = run_streaming(cmd, None, emit).await.unwrap();
    assert_eq!(outcome, Outcome::Exited(Some(1)));
    assert!(seen.lock().unwrap().contains("Python tab"), "{}", seen.lock().unwrap());
    h.cleanup();
}

#[tokio::test]
async fn a_proxy_in_the_environment_does_not_sit_between_a_script_and_the_app() {
    let Some(h) = harness("proxy").await else { return };
    let mut cmd = command(&h.python);
    cmd.args(["-u", "-c", "import protrade as pt; print(pt.status()['ok'])"])
        .env("PYTHONPATH", &h.lib)
        .env("PROTRADE_API", &h.server.url)
        .env("PROTRADE_TOKEN", &h.server.token)
        // A proxy that would swallow the request if it were used.
        .env("HTTP_PROXY", "http://127.0.0.1:9")
        .env("http_proxy", "http://127.0.0.1:9");
    let seen = Arc::new(Mutex::new(String::new()));
    let sink = seen.clone();
    let emit: Emit = Arc::new(move |_, line| sink.lock().unwrap().push_str(&line.text));
    let outcome = run_streaming(cmd, None, emit).await.unwrap();
    assert_eq!(outcome, Outcome::Exited(Some(0)), "{}", seen.lock().unwrap());
    assert_eq!(seen.lock().unwrap().trim(), "True");
    h.cleanup();
}
