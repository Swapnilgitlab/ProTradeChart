//! Tauri commands for the AI Study Builder: the user's Anthropic API key, and what it is used for —
//! drafting or revising a Study Specification, explaining a stored result, and the research agent's
//! plans and syntheses.
//!
//! The key is a secret like a broker's: it is saved through [`Secrets::set`], read only here, and
//! never returned to the webview or logged. The commands send only what the Studies tab passes in
//! (the question, a spec, a result's summary); what comes back is an untrusted proposal the
//! frontend validates, and nothing here runs a Study.

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use crate::ai::client::{ClaudeClient, Progress, Reply};
use crate::ai::prompts::{self, DraftRequest, ExplainRequest, PlanRequest, SynthesisRequest};
use crate::db::Database;
use crate::pyapi::valid_run_id;
use crate::secrets::Secrets;

/// Where the key is kept, in `Secrets`' terms.
const PROVIDER: &str = "anthropic";
const KEY: &str = "apiKey";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiKeyStatus {
    pub configured: bool,
    /// "keychain" or "database" (no OS credential store: unencrypted), when configured.
    pub storage: Option<String>,
}

/// Claude's answer: the JSON it was asked for, and the model that gave it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAnswer {
    pub answer: Value,
    pub model: String,
}

/// A pasted key, trimmed, if it looks like an Anthropic API key at all.
fn clean_key(key: &str) -> Result<&str, String> {
    let key = key.trim();
    if !key.starts_with("sk-ant-") || key.len() < 20 || key.len() > 400 {
        return Err("That doesn't look like an Anthropic API key (they start with sk-ant-).".into());
    }
    if key.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("An API key has no spaces in it.".into());
    }
    Ok(key)
}

fn key_status(db: &Database, secrets: &Secrets) -> Result<AiKeyStatus, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let storage = secrets.storage_of(&conn, PROVIDER, KEY).map_err(|e| e.to_string())?;
    Ok(AiKeyStatus {
        configured: storage.is_some(),
        storage: storage.map(|s| s.as_str().to_string()),
    })
}

/// The saved key. Read under the database lock, which is released before any request is made.
fn saved_key(db: &Database, secrets: &Secrets) -> Result<String, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    secrets
        .get(&conn, PROVIDER, KEY)
        .map_err(|e| e.to_string())?
        .filter(|k| !k.is_empty())
        .ok_or_else(|| "Add your Anthropic API key first.".into())
}

/// Saves a key once Anthropic has accepted it, so a mistyped key never replaces a working one.
async fn set_key(db: &Database, secrets: &Secrets, client: &ClaudeClient, key: &str) -> Result<AiKeyStatus, String> {
    let key = clean_key(key)?;
    client.check_key(key).await.map_err(|e| e.to_string())?;
    {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        secrets.set(&conn, PROVIDER, KEY, key).map_err(|e| e.to_string())?;
    }
    log::info!("Anthropic API key saved");
    key_status(db, secrets)
}

/// Parses Claude's structured answer. The schema should guarantee an object; this doesn't trust it.
fn answer(reply: Reply) -> Result<AiAnswer, String> {
    let value: Value = serde_json::from_str(reply.text.trim())
        .map_err(|_| "Claude's answer wasn't the JSON it was asked for.".to_string())?;
    if !value.is_object() {
        return Err("Claude's answer wasn't the JSON it was asked for.".into());
    }
    Ok(AiAnswer {
        answer: value,
        model: reply.model,
    })
}

async fn ask(
    db: &Database,
    secrets: &Secrets,
    client: &ClaudeClient,
    body: Value,
    on_progress: &mut (dyn FnMut(Progress) + Send),
) -> Result<AiAnswer, String> {
    let key = saved_key(db, secrets)?;
    answer(
        client
            .message(&key, &body, on_progress)
            .await
            .map_err(|e| e.to_string())?,
    )
}

/// What the Studies tab hears while an answer streams in (`ai-progress`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent<'a> {
    request_id: &'a str,
    #[serde(flatten)]
    progress: Progress,
}

/// Sends a request, telling the webview how it is going under `request_id`.
async fn ask_with_progress(
    app: &AppHandle,
    request_id: &str,
    db: &Database,
    secrets: &Secrets,
    client: &ClaudeClient,
    body: Value,
) -> Result<AiAnswer, String> {
    if !valid_run_id(request_id) {
        return Err("A request id is short and plain.".into());
    }
    let mut report = |progress: Progress| {
        let _ = app.emit("ai-progress", ProgressEvent { request_id, progress });
    };
    ask(db, secrets, client, body, &mut report).await
}

#[tauri::command]
pub fn ai_key_status(db: State<'_, Database>, secrets: State<'_, Secrets>) -> Result<AiKeyStatus, String> {
    key_status(&db, &secrets)
}

#[tauri::command]
pub async fn ai_set_key(
    key: String,
    db: State<'_, Database>,
    secrets: State<'_, Secrets>,
    client: State<'_, ClaudeClient>,
) -> Result<AiKeyStatus, String> {
    set_key(&db, &secrets, &client, &key).await
}

#[tauri::command]
pub fn ai_delete_key(db: State<'_, Database>, secrets: State<'_, Secrets>) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    secrets.delete(&conn, PROVIDER, KEY).map_err(|e| e.to_string())?;
    log::info!("Anthropic API key removed");
    Ok(())
}

/// A question → a proposed Study Specification, or an instruction → a revision of the current one.
#[tauri::command]
pub async fn ai_draft_study(
    request: DraftRequest,
    request_id: String,
    app: AppHandle,
    db: State<'_, Database>,
    secrets: State<'_, Secrets>,
    client: State<'_, ClaudeClient>,
) -> Result<AiAnswer, String> {
    let body = prompts::draft_body(&request)?;
    ask_with_progress(&app, &request_id, &db, &secrets, &client, body).await
}

/// A stored result's summary → a plain-language explanation.
#[tauri::command]
pub async fn ai_explain_result(
    request: ExplainRequest,
    request_id: String,
    app: AppHandle,
    db: State<'_, Database>,
    secrets: State<'_, Secrets>,
    client: State<'_, ClaudeClient>,
) -> Result<AiAnswer, String> {
    let body = prompts::explain_body(&request)?;
    ask_with_progress(&app, &request_id, &db, &secrets, &client, body).await
}

/// A research question → a plan of Studies for the user to approve. Nothing here runs one.
#[tauri::command]
pub async fn ai_plan_research(
    request: PlanRequest,
    request_id: String,
    app: AppHandle,
    db: State<'_, Database>,
    secrets: State<'_, Secrets>,
    client: State<'_, ClaudeClient>,
) -> Result<AiAnswer, String> {
    let body = prompts::plan_body(&request)?;
    ask_with_progress(&app, &request_id, &db, &secrets, &client, body).await
}

/// A finished round's result summaries → a synthesis across them, with follow-up questions.
#[tauri::command]
pub async fn ai_synthesize_research(
    request: SynthesisRequest,
    request_id: String,
    app: AppHandle,
    db: State<'_, Database>,
    secrets: State<'_, Secrets>,
    client: State<'_, ClaudeClient>,
) -> Result<AiAnswer, String> {
    let body = prompts::synthesis_body(&request)?;
    ask_with_progress(&app, &request_id, &db, &secrets, &client, body).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::testing::MemoryKeychain;
    use serde_json::json;
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// Answers every request with `status` and `body`, counting them.
    async fn anthropic(status: u16, body: Value) -> (String, Arc<std::sync::atomic::AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let seen = count.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    return;
                };
                seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let mut buf = Vec::new();
                let mut chunk = [0u8; 8192];
                // Headers, then whatever body Content-Length announces.
                loop {
                    let n = sock.read(&mut chunk).await.unwrap_or(0);
                    buf.extend_from_slice(&chunk[..n]);
                    let text = String::from_utf8_lossy(&buf);
                    if let Some(end) = text.find("\r\n\r\n") {
                        let length: usize = text[..end]
                            .lines()
                            .find_map(|l| {
                                let (k, v) = l.split_once(':')?;
                                k.eq_ignore_ascii_case("content-length")
                                    .then(|| v.trim().parse().ok())?
                            })
                            .unwrap_or(0);
                        if buf.len() >= end + 4 + length {
                            break;
                        }
                    }
                    if n == 0 {
                        break;
                    }
                }
                let payload = body.to_string();
                let response = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                    payload.len()
                );
                sock.write_all(response.as_bytes()).await.ok();
                sock.shutdown().await.ok();
            }
        });
        (base, count)
    }

    fn setup() -> (Database, Secrets) {
        (
            Database::open_in_memory().unwrap(),
            Secrets::new(Box::new(MemoryKeychain::default())),
        )
    }

    const GOOD: &str = "sk-ant-api03-abcdefghijklmnop";

    #[test]
    fn only_something_shaped_like_a_key_is_sent_to_be_checked() {
        assert_eq!(clean_key(&format!("  {GOOD}\n")).unwrap(), GOOD);
        assert!(clean_key("sk-proj-abcdefghijklmnopqrst").is_err());
        assert!(clean_key("sk-ant-short").is_err());
        assert!(clean_key("sk-ant-api03 abcdefghijklmnop").is_err());
    }

    #[tokio::test]
    async fn a_key_is_saved_only_after_anthropic_accepts_it() {
        let (db, secrets) = setup();
        let (base, _) = anthropic(
            401,
            json!({"type": "error", "error": {"type": "authentication_error", "message": "invalid x-api-key"}}),
        )
        .await;
        let client = ClaudeClient::with_base(reqwest::Client::new(), &base);
        let err = set_key(&db, &secrets, &client, GOOD).await.unwrap_err();
        assert!(err.contains("didn't accept"), "{err}");
        assert!(!key_status(&db, &secrets).unwrap().configured);

        let (base, _) = anthropic(200, json!({"data": []})).await;
        let client = ClaudeClient::with_base(reqwest::Client::new(), &base);
        let status = set_key(&db, &secrets, &client, GOOD).await.unwrap();
        assert!(status.configured);
        assert_eq!(status.storage.as_deref(), Some("keychain"));
        assert_eq!(saved_key(&db, &secrets).unwrap(), GOOD);
    }

    #[tokio::test]
    async fn nothing_is_sent_without_a_key() {
        let (db, secrets) = setup();
        let (base, count) = anthropic(200, json!({})).await;
        let client = ClaudeClient::with_base(reqwest::Client::new(), &base);
        let err = ask(&db, &secrets, &client, json!({}), &mut |_| {}).await.unwrap_err();
        assert!(err.contains("API key"), "{err}");
        assert_eq!(count.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_structured_answer_comes_back_as_json_with_its_model() {
        let (db, secrets) = setup();
        {
            let conn = db.conn.lock().unwrap();
            secrets.set(&conn, PROVIDER, KEY, GOOD).unwrap();
        }
        let (base, _) = anthropic(
            200,
            json!({"model": "claude-opus-5", "stop_reason": "end_turn",
                   "content": [{"type": "text", "text": "{\"reply\":\"Done.\",\"spec\":null,\"assumptions\":[],\"unavailable\":[]}"}]}),
        )
        .await;
        let client = ClaudeClient::with_base(reqwest::Client::new(), &base);
        let got = ask(&db, &secrets, &client, json!({}), &mut |_| {}).await.unwrap();
        assert_eq!(got.answer["reply"], "Done.");
        assert_eq!(got.model, "claude-opus-5");

        let (base, _) = anthropic(
            200,
            json!({"stop_reason": "end_turn", "content": [{"type": "text", "text": "not json"}]}),
        )
        .await;
        let client = ClaudeClient::with_base(reqwest::Client::new(), &base);
        assert!(ask(&db, &secrets, &client, json!({}), &mut |_| {}).await.is_err());
    }

    #[test]
    fn the_status_never_carries_the_key() {
        let status = AiKeyStatus {
            configured: true,
            storage: Some("keychain".into()),
        };
        let wire = serde_json::to_string(&status).unwrap();
        assert_eq!(wire, r#"{"configured":true,"storage":"keychain"}"#);
    }
}
