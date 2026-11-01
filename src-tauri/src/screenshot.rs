//! `pt.screenshot`: a chart drawn by the app for a script. Python can't draw the app's charts, so a
//! request goes to the main window (`features/scheduler/ScreenshotRunner.tsx`), which builds the
//! chart off screen and hands the PNG back through [`script_screenshot_result`]. One at a time,
//! each given two minutes. The PNG goes back to the script, which saves it where it wants: the app
//! writes no file of its own.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::oneshot;

use crate::pyapi::wire::ScreenshotPost;

/// The event the main window draws a chart for.
pub const REQUEST_EVENT: &str = "script-screenshot";
const TIME_LIMIT: Duration = Duration::from_secs(120);
pub const MAX_PNG_BYTES: usize = 10 * 1024 * 1024;
const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

type Answer = Result<Vec<u8>, String>;

/// The requests waiting for the main window, and the turn they wait for.
#[derive(Default)]
pub struct Screenshots {
    pending: Mutex<HashMap<String, oneshot::Sender<Answer>>>,
    turn: tokio::sync::Mutex<()>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    request_id: String,
    #[serde(flatten)]
    chart: ScreenshotPost,
}

/// Why a screenshot couldn't be taken.
#[derive(Debug, PartialEq, Eq)]
pub enum Failure {
    /// The main window isn't open to draw it.
    NoWindow,
    TimedOut,
    Failed(String),
}

static REQUESTS: AtomicU64 = AtomicU64::new(0);

/// Asks the main window to draw `chart`, and waits for the PNG.
pub async fn take(app: &AppHandle, chart: ScreenshotPost) -> Result<Vec<u8>, Failure> {
    let shots = app.state::<Screenshots>();
    let _turn = shots.turn.lock().await;
    let window = app.get_webview_window("main").ok_or(Failure::NoWindow)?;
    let request_id = format!("shot-{}", REQUESTS.fetch_add(1, Ordering::Relaxed));
    let (tx, rx) = oneshot::channel();
    shots
        .pending
        .lock()
        .map_err(|e| Failure::Failed(e.to_string()))?
        .insert(request_id.clone(), tx);
    let sent = window.emit_to(
        "main",
        REQUEST_EVENT,
        Request {
            request_id: request_id.clone(),
            chart,
        },
    );
    let answer = match sent {
        Err(e) => Err(Failure::Failed(e.to_string())),
        Ok(()) => match tokio::time::timeout(TIME_LIMIT, rx).await {
            Ok(Ok(answer)) => answer.map_err(Failure::Failed),
            Ok(Err(_)) => Err(Failure::Failed("The window closed before the chart was drawn.".into())),
            Err(_) => Err(Failure::TimedOut),
        },
    };
    if let Ok(mut pending) = shots.pending.lock() {
        pending.remove(&request_id);
    }
    answer
}

/// A PNG the window sent, checked: base64 that decodes to a PNG of at most [`MAX_PNG_BYTES`]. Pure.
pub fn checked_png(base64: &str) -> Result<Vec<u8>, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64.trim().as_bytes())
        .map_err(|_| "The chart image wasn't base64.".to_string())?;
    if bytes.len() > MAX_PNG_BYTES {
        return Err("The chart image is larger than 10 MB.".into());
    }
    if !bytes.starts_with(&PNG_SIGNATURE) {
        return Err("The chart image isn't a PNG.".into());
    }
    Ok(bytes)
}

/// The main window's answer to a request: the chart as a base64 PNG, or why it couldn't draw it.
#[tauri::command]
pub fn script_screenshot_result(
    request_id: String,
    png: Option<String>,
    error: Option<String>,
    shots: State<Screenshots>,
) -> Result<(), String> {
    let waiting = shots.pending.lock().map_err(|e| e.to_string())?.remove(&request_id);
    let Some(waiting) = waiting else {
        // Too late (it timed out), or not a request of ours.
        return Ok(());
    };
    let answer = match (png, error) {
        (Some(png), _) => checked_png(&png),
        (None, Some(error)) => Err(error.chars().take(500).collect()),
        (None, None) => Err("The window sent no chart.".into()),
    };
    let _ = waiting.send(answer);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_png_of_a_sane_size_is_taken() {
        let encode = |b: &[u8]| base64::engine::general_purpose::STANDARD.encode(b);
        let png = [&PNG_SIGNATURE[..], b"rest"].concat();
        assert_eq!(checked_png(&encode(&png)).unwrap(), png);
        assert!(checked_png(&encode(b"GIF89a....")).unwrap_err().contains("isn't a PNG"));
        assert!(checked_png("not base64!").unwrap_err().contains("base64"));
        let huge = [&PNG_SIGNATURE[..], &vec![0u8; MAX_PNG_BYTES]].concat();
        assert!(checked_png(&encode(&huge)).unwrap_err().contains("10 MB"));
    }
}
