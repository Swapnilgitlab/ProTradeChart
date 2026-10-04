//! Tauri commands for AI in ProTradeChart: the user's own API keys (Anthropic, OpenAI), and what
//! they're used for — the Study Builder's drafts/explanations/plans/syntheses, and Ask AI.
//!
//! A key is a secret like a broker's: it is saved through [`Secrets::set`], read only here, and
//! never returned to the webview or logged. The commands send only what the caller passed in (a
//! question, a spec, a result's summary, the Ask AI context); what comes back is untrusted —
//! Studies' proposals are validated by the frontend, Ask AI's proposed actions are never run here
//! or anywhere but the frontend, and only after the user approves each one.

use rusqlite::Connection;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use crate::ai::claude::ClaudeClient;
use crate::ai::openai::OpenAiClient;
use crate::ai::prompts::{self, AskAiRequest, DraftRequest, ExplainRequest, PlanRequest, SynthesisRequest};
use crate::ai::{AiError, AiRequest, Progress, Reply};
use crate::db::Database;
use crate::pyapi::valid_run_id;
use crate::secrets::Secrets;
use crate::store::preferences;

/// Where each provider's key is kept, in `Secrets`' terms: `(id, "apiKey")`.
const KEY: &str = "apiKey";
/// `(id, label)` for every provider this app knows, in the order the settings dialog lists them.
const PROVIDERS: &[(&str, &str)] = &[("anthropic", "Claude (Anthropic)"), ("openai", "OpenAI")];
/// The UI preference naming which provider is used when more than one has a key.
const ACTIVE_PROVIDER_PREF: &str = "ai_active_provider";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderStatus {
    pub id: String,
    pub label: String,
    pub configured: bool,
    /// "keychain" or "database" (no OS credential store: unencrypted), when configured.
    pub storage: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviders {
    pub providers: Vec<AiProviderStatus>,
    /// Which provider an AI feature will actually use right now, or `None` if neither is
    /// configured. See [`provider_for`].
    pub active: Option<String>,
}

/// A pasted key, trimmed, if it looks like the named provider's API key at all.
fn clean_key<'a>(provider: &str, key: &'a str) -> Result<&'a str, String> {
    let key = key.trim();
    let looks_right = match provider {
        "anthropic" => key.starts_with("sk-ant-"),
        "openai" => key.starts_with("sk-"),
        _ => return Err("Unknown AI provider.".into()),
    };
    if !looks_right || key.len() < 20 || key.len() > 400 {
        let example = if provider == "anthropic" { "sk-ant-" } else { "sk-" };
        return Err(format!(
            "That doesn't look like an API key for this provider (they start with {example})."
        ));
    }
    if key.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("An API key has no spaces in it.".into());
    }
    Ok(key)
}

fn provider_status(conn: &Connection, secrets: &Secrets, id: &str, label: &str) -> Result<AiProviderStatus, String> {
    let storage = secrets.storage_of(conn, id, KEY).map_err(|e| e.to_string())?;
    Ok(AiProviderStatus {
        id: id.to_string(),
        label: label.to_string(),
        configured: storage.is_some(),
        storage: storage.map(|s| s.as_str().to_string()),
    })
}

fn has_key(conn: &Connection, secrets: &Secrets, id: &str) -> Result<bool, String> {
    Ok(secrets.storage_of(conn, id, KEY).map_err(|e| e.to_string())?.is_some())
}

/// Which provider id serves an AI feature right now (Studies and Ask AI alike): the one the user
/// prefers, if it has a key; otherwise whichever of the two does; `None` if neither does yet.
fn resolve_provider(conn: &Connection, secrets: &Secrets) -> Result<Option<String>, String> {
    let preferred = preferences::get(conn, ACTIVE_PROVIDER_PREF)
        .map_err(|e| e.to_string())?
        .filter(|p| PROVIDERS.iter().any(|(id, _)| id == p))
        .unwrap_or_else(|| "anthropic".to_string());
    if has_key(conn, secrets, &preferred)? {
        return Ok(Some(preferred));
    }
    for (id, _) in PROVIDERS {
        if *id != preferred && has_key(conn, secrets, id)? {
            return Ok(Some((*id).to_string()));
        }
    }
    Ok(None)
}

fn provider_for(db: &Database, secrets: &Secrets) -> Result<String, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    resolve_provider(&conn, secrets)?
        .ok_or_else(|| "Add an AI provider's API key first, in AI providers settings.".into())
}

/// The saved key for `provider`. Read under the database lock, which is released before any
/// request is made.
fn saved_key(db: &Database, secrets: &Secrets, provider: &str) -> Result<String, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    secrets
        .get(&conn, provider, KEY)
        .map_err(|e| e.to_string())?
        .filter(|k| !k.is_empty())
        .ok_or_else(|| "Add an AI provider's API key first, in AI providers settings.".into())
}

/// Saves a key once the provider has accepted it, so a mistyped key never replaces a working one.
async fn set_key(
    db: &Database,
    secrets: &Secrets,
    claude: &ClaudeClient,
    openai: &OpenAiClient,
    provider: &str,
    key: &str,
) -> Result<AiProviderStatus, String> {
    let cleaned = clean_key(provider, key)?.to_string();
    match provider {
        "anthropic" => claude.check_key(&cleaned).await.map_err(|e| e.to_string())?,
        "openai" => openai.check_key(&cleaned).await.map_err(|e| e.to_string())?,
        _ => return Err("Unknown AI provider.".into()),
    }
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    secrets.set(&conn, provider, KEY, &cleaned).map_err(|e| e.to_string())?;
    log::info!("{provider} API key saved");
    let label = PROVIDERS
        .iter()
        .find(|(id, _)| *id == provider)
        .map_or(provider, |(_, l)| l);
    provider_status(&conn, secrets, provider, label)
}

/// Claude or GPT's answer: the JSON it was asked for, and the model that gave it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAnswer {
    pub answer: Value,
    pub model: String,
}

/// Parses a Study Builder answer. The schema should guarantee an object; this doesn't trust it.
fn answer(reply: Reply) -> Result<AiAnswer, String> {
    let value: Value = serde_json::from_str(reply.text.trim())
        .map_err(|_| "The AI's answer wasn't the JSON it was asked for.".to_string())?;
    if !value.is_object() {
        return Err("The AI's answer wasn't the JSON it was asked for.".into());
    }
    Ok(AiAnswer {
        answer: value,
        model: reply.model,
    })
}

/// Sends `req` to whichever provider `provider` names — the two clients share the same
/// `check_key`/`message` shape (see `ai/mod.rs`), so this is the one place that picks between them.
async fn send(
    provider: &str,
    claude: &ClaudeClient,
    openai: &OpenAiClient,
    key: &str,
    req: &AiRequest,
    on_progress: &mut (dyn FnMut(Progress) + Send),
) -> Result<Reply, AiError> {
    match provider {
        "openai" => openai.message(key, req, on_progress).await,
        _ => claude.message(key, req, on_progress).await,
    }
}

async fn ask(
    db: &Database,
    secrets: &Secrets,
    claude: &ClaudeClient,
    openai: &OpenAiClient,
    req: &AiRequest,
    on_progress: &mut (dyn FnMut(Progress) + Send),
) -> Result<AiAnswer, String> {
    let provider = provider_for(db, secrets)?;
    let key = saved_key(db, secrets, &provider)?;
    answer(
        send(&provider, claude, openai, &key, req, on_progress)
            .await
            .map_err(|e| e.to_string())?,
    )
}

/// What the frontend hears while an answer streams in (`ai-progress`).
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
    claude: &ClaudeClient,
    openai: &OpenAiClient,
    req: &AiRequest,
) -> Result<AiAnswer, String> {
    if !valid_run_id(request_id) {
        return Err("A request id is short and plain.".into());
    }
    let mut report = |progress: Progress| {
        let _ = app.emit("ai-progress", ProgressEvent { request_id, progress });
    };
    ask(db, secrets, claude, openai, req, &mut report).await
}

#[tauri::command(async)]
pub fn list_ai_providers(db: State<'_, Database>, secrets: State<'_, Secrets>) -> Result<AiProviders, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let providers = PROVIDERS
        .iter()
        .map(|(id, label)| provider_status(&conn, &secrets, id, label))
        .collect::<Result<Vec<_>, _>>()?;
    let active = resolve_provider(&conn, &secrets)?;
    Ok(AiProviders { providers, active })
}

#[tauri::command]
pub async fn ai_set_key(
    provider: String,
    key: String,
    db: State<'_, Database>,
    secrets: State<'_, Secrets>,
    claude: State<'_, ClaudeClient>,
    openai: State<'_, OpenAiClient>,
) -> Result<AiProviderStatus, String> {
    set_key(&db, &secrets, &claude, &openai, &provider, &key).await
}

#[tauri::command(async)]
pub fn ai_delete_key(provider: String, db: State<'_, Database>, secrets: State<'_, Secrets>) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    secrets.delete(&conn, &provider, KEY).map_err(|e| e.to_string())?;
    log::info!("{provider} API key removed");
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
    claude: State<'_, ClaudeClient>,
    openai: State<'_, OpenAiClient>,
) -> Result<AiAnswer, String> {
    let req = prompts::draft_body(&request)?;
    ask_with_progress(&app, &request_id, &db, &secrets, &claude, &openai, &req).await
}

/// A stored result's summary → a plain-language explanation.
#[tauri::command]
pub async fn ai_explain_result(
    request: ExplainRequest,
    request_id: String,
    app: AppHandle,
    db: State<'_, Database>,
    secrets: State<'_, Secrets>,
    claude: State<'_, ClaudeClient>,
    openai: State<'_, OpenAiClient>,
) -> Result<AiAnswer, String> {
    let req = prompts::explain_body(&request)?;
    ask_with_progress(&app, &request_id, &db, &secrets, &claude, &openai, &req).await
}

/// A research question → a plan of Studies for the user to approve. Nothing here runs one.
#[tauri::command]
pub async fn ai_plan_research(
    request: PlanRequest,
    request_id: String,
    app: AppHandle,
    db: State<'_, Database>,
    secrets: State<'_, Secrets>,
    claude: State<'_, ClaudeClient>,
    openai: State<'_, OpenAiClient>,
) -> Result<AiAnswer, String> {
    let req = prompts::plan_body(&request)?;
    ask_with_progress(&app, &request_id, &db, &secrets, &claude, &openai, &req).await
}

/// A finished round's result summaries → a synthesis across them, with follow-up questions.
#[tauri::command]
pub async fn ai_synthesize_research(
    request: SynthesisRequest,
    request_id: String,
    app: AppHandle,
    db: State<'_, Database>,
    secrets: State<'_, Secrets>,
    claude: State<'_, ClaudeClient>,
    openai: State<'_, OpenAiClient>,
) -> Result<AiAnswer, String> {
    let req = prompts::synthesis_body(&request)?;
    ask_with_progress(&app, &request_id, &db, &secrets, &claude, &openai, &req).await
}

/// One action Ask AI proposed. Never run here: the frontend shows it for approval and, only then,
/// calls the real function it names. See "Ask AI" in `docs/ARCHITECTURE.md`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposedAction {
    pub tool: String,
    pub arguments: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AskAiAnswer {
    pub reply: String,
    pub actions: Vec<ProposedAction>,
    pub model: String,
}

fn ask_ai_answer(reply: Reply) -> AskAiAnswer {
    AskAiAnswer {
        reply: reply.text,
        actions: reply
            .tool_calls
            .into_iter()
            .map(|c| ProposedAction {
                tool: c.name,
                arguments: c.arguments,
            })
            .collect(),
        model: reply.model,
    }
}

/// A question (or a follow-up) → words, proposed actions, or both. Nothing here touches app state.
#[tauri::command]
pub async fn ai_ask_ai(
    request: AskAiRequest,
    request_id: String,
    app: AppHandle,
    db: State<'_, Database>,
    secrets: State<'_, Secrets>,
    claude: State<'_, ClaudeClient>,
    openai: State<'_, OpenAiClient>,
) -> Result<AskAiAnswer, String> {
    if !valid_run_id(&request_id) {
        return Err("A request id is short and plain.".into());
    }
    let req = prompts::ask_ai_body(&request)?;
    let provider = provider_for(&db, &secrets)?;
    let key = saved_key(&db, &secrets, &provider)?;
    let mut report = |progress: Progress| {
        let _ = app.emit(
            "ai-progress",
            ProgressEvent {
                request_id: &request_id,
                progress,
            },
        );
    };
    let reply = send(&provider, &claude, &openai, &key, &req, &mut report)
        .await
        .map_err(|e| e.to_string())?;
    Ok(ask_ai_answer(reply))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::prompts::AskAiContext;
    use crate::secrets::testing::MemoryKeychain;
    use serde_json::json;
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// Answers every request with `status` and `body`, counting them.
    async fn fake_server(status: u16, body: Value) -> (String, Arc<std::sync::atomic::AtomicUsize>) {
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

    const GOOD_CLAUDE: &str = "sk-ant-api03-abcdefghijklmnop";
    const GOOD_OPENAI: &str = "sk-abcdefghijklmnopqrstuvwx";

    #[test]
    fn only_something_shaped_like_each_provider_s_key_is_sent_to_be_checked() {
        assert_eq!(
            clean_key("anthropic", &format!("  {GOOD_CLAUDE}\n")).unwrap(),
            GOOD_CLAUDE
        );
        assert!(clean_key("anthropic", "sk-proj-abcdefghijklmnopqrst").is_err());
        assert!(clean_key("anthropic", "sk-ant-short").is_err());
        assert_eq!(clean_key("openai", GOOD_OPENAI).unwrap(), GOOD_OPENAI);
        assert!(clean_key("openai", "not-a-key-at-all-xxxxx").is_err());
        assert!(clean_key("mistral", GOOD_OPENAI).is_err());
    }

    #[tokio::test]
    async fn a_key_is_saved_only_after_the_provider_accepts_it() {
        let (db, secrets) = setup();
        let (base, _) = fake_server(
            401,
            json!({"type": "error", "error": {"type": "authentication_error", "message": "invalid x-api-key"}}),
        )
        .await;
        let claude = ClaudeClient::with_base(reqwest::Client::new(), &base);
        let openai = OpenAiClient::with_base(reqwest::Client::new(), &base);
        let err = set_key(&db, &secrets, &claude, &openai, "anthropic", GOOD_CLAUDE)
            .await
            .unwrap_err();
        assert!(!err.is_empty());
        let providers = list_providers_for_test(&db, &secrets);
        assert!(!providers.providers[0].configured);

        let (base, _) = fake_server(200, json!({"data": []})).await;
        let claude = ClaudeClient::with_base(reqwest::Client::new(), &base);
        let openai = OpenAiClient::with_base(reqwest::Client::new(), &base);
        let status = set_key(&db, &secrets, &claude, &openai, "anthropic", GOOD_CLAUDE)
            .await
            .unwrap();
        assert!(status.configured);
        assert_eq!(status.storage.as_deref(), Some("keychain"));
        assert_eq!(saved_key(&db, &secrets, "anthropic").unwrap(), GOOD_CLAUDE);

        let status = set_key(&db, &secrets, &claude, &openai, "openai", GOOD_OPENAI)
            .await
            .unwrap();
        assert_eq!(status.id, "openai");
        assert!(status.configured);
    }

    fn list_providers_for_test(db: &Database, secrets: &Secrets) -> AiProviders {
        let conn = db.conn.lock().unwrap();
        let providers = PROVIDERS
            .iter()
            .map(|(id, label)| provider_status(&conn, secrets, id, label).unwrap())
            .collect();
        let active = resolve_provider(&conn, secrets).unwrap();
        AiProviders { providers, active }
    }

    #[tokio::test]
    async fn the_active_provider_prefers_the_saved_choice_then_falls_back() {
        let (db, secrets) = setup();
        {
            let conn = db.conn.lock().unwrap();
            assert_eq!(resolve_provider(&conn, &secrets).unwrap(), None);
            secrets.set(&conn, "openai", KEY, GOOD_OPENAI).unwrap();
            // Only OpenAI has a key: it's used even though "anthropic" is the default preference.
            assert_eq!(resolve_provider(&conn, &secrets).unwrap().as_deref(), Some("openai"));
            secrets.set(&conn, "anthropic", KEY, GOOD_CLAUDE).unwrap();
            // Both configured, no preference saved yet: Anthropic, the default.
            assert_eq!(resolve_provider(&conn, &secrets).unwrap().as_deref(), Some("anthropic"));
            preferences::set(&conn, ACTIVE_PROVIDER_PREF, "openai").unwrap();
            assert_eq!(resolve_provider(&conn, &secrets).unwrap().as_deref(), Some("openai"));
            secrets.delete(&conn, "openai", KEY).unwrap();
            // Preferred but no longer configured: falls back to the one that still is.
            assert_eq!(resolve_provider(&conn, &secrets).unwrap().as_deref(), Some("anthropic"));
        }
    }

    #[tokio::test]
    async fn nothing_is_sent_without_a_key() {
        let (db, secrets) = setup();
        let (base, count) = fake_server(200, json!({})).await;
        let claude = ClaudeClient::with_base(reqwest::Client::new(), &base);
        let openai = OpenAiClient::with_base(reqwest::Client::new(), &base);
        let req = AiRequest::structured("s".into(), vec![], json!({"type": "object"}));
        let err = ask(&db, &secrets, &claude, &openai, &req, &mut |_| {})
            .await
            .unwrap_err();
        assert!(err.contains("API key"), "{err}");
        assert_eq!(count.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_structured_answer_comes_back_as_json_with_its_model() {
        let (db, secrets) = setup();
        {
            let conn = db.conn.lock().unwrap();
            secrets.set(&conn, "anthropic", KEY, GOOD_CLAUDE).unwrap();
        }
        let (base, _) = fake_server(
            200,
            json!({"model": "claude-opus-5", "stop_reason": "end_turn",
                   "content": [{"type": "text", "text": "{\"reply\":\"Done.\",\"spec\":null,\"assumptions\":[],\"unavailable\":[]}"}]}),
        )
        .await;
        let claude = ClaudeClient::with_base(reqwest::Client::new(), &base);
        let openai = OpenAiClient::with_base(reqwest::Client::new(), &base);
        let req = AiRequest::structured("s".into(), vec![], json!({"type": "object"}));
        let got = ask(&db, &secrets, &claude, &openai, &req, &mut |_| {}).await.unwrap();
        assert_eq!(got.answer["reply"], "Done.");
        assert_eq!(got.model, "claude-opus-5");

        let (base, _) = fake_server(
            200,
            json!({"stop_reason": "end_turn", "content": [{"type": "text", "text": "not json"}]}),
        )
        .await;
        let claude = ClaudeClient::with_base(reqwest::Client::new(), &base);
        assert!(ask(&db, &secrets, &claude, &openai, &req, &mut |_| {}).await.is_err());
    }

    #[tokio::test]
    async fn ask_ai_never_runs_a_proposed_action_it_only_reports_it() {
        let (db, secrets) = setup();
        {
            let conn = db.conn.lock().unwrap();
            secrets.set(&conn, "anthropic", KEY, GOOD_CLAUDE).unwrap();
        }
        let (base, _) = fake_server(
            200,
            json!({"model": "claude-opus-5", "stop_reason": "tool_use", "content": [
                {"type": "text", "text": "Sure, adding it."},
                {"type": "tool_use", "id": "t1", "name": "add_watchlist_item", "input": {"watchlist": "Getting started", "symbol": "binance:ETHUSDT"}}
            ]}),
        )
        .await;
        let claude = ClaudeClient::with_base(reqwest::Client::new(), &base);
        let openai = OpenAiClient::with_base(reqwest::Client::new(), &base);
        let provider = provider_for(&db, &secrets).unwrap();
        let key = saved_key(&db, &secrets, &provider).unwrap();
        let req = prompts::ask_ai_body(&AskAiRequest {
            question: "Add ETHUSDT to Getting started".into(),
            context: AskAiContext {
                active_symbol: None,
                active_timeframe: None,
                open_tabs: vec![],
                watchlist_names: vec!["Getting started".into()],
            },
            history: vec![],
        })
        .unwrap();
        let reply = send(&provider, &claude, &openai, &key, &req, &mut |_| {})
            .await
            .unwrap();
        let got = ask_ai_answer(reply);
        assert_eq!(got.reply, "Sure, adding it.");
        assert_eq!(got.actions.len(), 1);
        assert_eq!(got.actions[0].tool, "add_watchlist_item");
        assert_eq!(got.actions[0].arguments["symbol"], "binance:ETHUSDT");
    }

    #[test]
    fn the_status_never_carries_the_key() {
        let status = AiProviderStatus {
            id: "anthropic".into(),
            label: "Claude (Anthropic)".into(),
            configured: true,
            storage: Some("keychain".into()),
        };
        let wire = serde_json::to_string(&status).unwrap();
        assert_eq!(
            wire,
            r#"{"id":"anthropic","label":"Claude (Anthropic)","configured":true,"storage":"keychain"}"#
        );
    }
}
