//! A small client for OpenAI's Chat Completions API — the second AI provider, beside
//! [`super::claude`]. Plain HTTP, the same shape as `claude.rs`: the user's own API key is passed
//! in for each call and never kept here or logged.
//!
//! Chat Completions rather than the Responses API: it's the simpler, single-request shape closer
//! to what this app already sends Anthropic, and its `tools`/`tool_calls` and strict
//! `response_format: {type: "json_schema", ...}` are stable and well-documented. `MODEL` is one
//! constant, easy to change as OpenAI's line-up moves on.

use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::{network_error, timed_out, AiError, AiErrorKind, AiRequest, Progress, Reply, Stage, ToolCall};

pub const BASE_URL: &str = "https://api.openai.com";
pub const MODEL: &str = "gpt-5.1";
const MAX_TOKENS: u32 = 32_000;
const IDLE_TIMEOUT: Duration = Duration::from_secs(120);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(60);
const PROGRESS_EVERY: Duration = Duration::from_millis(250);
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const PROVIDER: &str = "OpenAI";
/// `response_format.json_schema.name` — not user-visible, just an id OpenAI's schema wants.
const SCHEMA_NAME: &str = "answer";

pub struct OpenAiClient {
    http: reqwest::Client,
    base: String,
    idle: Duration,
}

impl OpenAiClient {
    pub fn new(http: reqwest::Client) -> Self {
        Self::with_base(http, BASE_URL)
    }

    pub fn with_base(http: reqwest::Client, base: &str) -> Self {
        OpenAiClient {
            http,
            base: base.trim_end_matches('/').to_string(),
            idle: IDLE_TIMEOUT,
        }
    }

    #[cfg(test)]
    fn with_idle(self, idle: Duration) -> Self {
        OpenAiClient { idle, ..self }
    }

    fn request(&self, builder: reqwest::RequestBuilder, key: &str) -> reqwest::RequestBuilder {
        builder.bearer_auth(key)
    }

    /// Asks OpenAI whether it accepts a key, by listing its models: free, and it needs the key.
    pub async fn check_key(&self, key: &str) -> Result<(), AiError> {
        let resp = self
            .request(self.http.get(format!("{}/v1/models", self.base)), key)
            .timeout(CHECK_TIMEOUT)
            .send()
            .await
            .map_err(|e| network_error(&e, PROVIDER))?;
        let status = resp.status().as_u16();
        if (200..300).contains(&status) {
            return Ok(());
        }
        let body = resp.text().await.unwrap_or_default();
        Err(http_error(status, &body))
    }

    /// Builds the Chat Completions body: a leading system message, then the conversation, and
    /// either a strict `response_format` (structured JSON text) or `tools` (tool calls), matching
    /// which one `req` set.
    fn body(&self, req: &AiRequest) -> Value {
        let mut messages = vec![json!({"role": "system", "content": req.system})];
        messages.extend(
            req.messages
                .iter()
                .map(|m| json!({"role": m.role, "content": m.content})),
        );
        let mut body = json!({
            "model": MODEL,
            "max_completion_tokens": MAX_TOKENS,
            "messages": messages,
        });
        let map = body.as_object_mut().unwrap();
        if let Some(schema) = &req.schema {
            map.insert(
                "response_format".into(),
                json!({"type": "json_schema", "json_schema": {"name": SCHEMA_NAME, "strict": true, "schema": schema}}),
            );
        }
        if !req.tools.is_empty() {
            let tools: Vec<Value> = req
                .tools
                .iter()
                .map(|t| json!({"type": "function", "function": {"name": t.name, "description": t.description, "parameters": t.schema}}))
                .collect();
            map.insert("tools".into(), Value::Array(tools));
        }
        body
    }

    /// Sends one Chat Completions request as a stream and returns the finished answer, reporting
    /// progress as it arrives.
    pub async fn message(
        &self,
        key: &str,
        req: &AiRequest,
        on_progress: &mut (dyn FnMut(Progress) + Send),
    ) -> Result<Reply, AiError> {
        let mut body = self.body(req);
        body.as_object_mut().unwrap().insert("stream".into(), Value::Bool(true));
        let mut resp = tokio::time::timeout(
            CONNECT_TIMEOUT,
            self.request(self.http.post(format!("{}/v1/chat/completions", self.base)), key)
                .json(&body)
                .send(),
        )
        .await
        .map_err(|_| timed_out(PROVIDER))?
        .map_err(|e| network_error(&e, PROVIDER))?;
        let status = resp.status().as_u16();
        let streamed = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.starts_with("text/event-stream"));
        if !(200..300).contains(&status) || !streamed {
            let text = resp.text().await.map_err(|e| network_error(&e, PROVIDER))?;
            log::info!("OpenAI request finished with HTTP {status}");
            return parse_reply(status, &text);
        }
        let mut stream = SseAccumulator::default();
        let mut last = Instant::now() - PROGRESS_EVERY;
        let mut last_stage = None;
        loop {
            let chunk = tokio::time::timeout(self.idle, resp.chunk())
                .await
                .map_err(|_| timed_out(PROVIDER))?
                .map_err(|e| network_error(&e, PROVIDER))?;
            let Some(chunk) = chunk else { break };
            stream.feed(&chunk);
            let progress = stream.progress();
            if last_stage != Some(progress.stage) || last.elapsed() >= PROGRESS_EVERY {
                on_progress(progress);
                last = Instant::now();
                last_stage = Some(progress.stage);
            }
            if stream.is_done() {
                break;
            }
        }
        let reply = stream.finish();
        log::info!(
            "OpenAI stream finished: {}",
            match &reply {
                Ok(_) => "answered".to_string(),
                Err(e) => format!("{:?}", e.kind),
            }
        );
        reply
    }
}

#[derive(Debug, Default)]
struct ToolCallBuf {
    name: String,
    arguments: String,
}

/// Reads a Chat Completions event stream. Pure: fed bytes as they arrive, in chunks that may
/// split a line or a character anywhere. Each event is one `data: {...}` line (or the closing
/// `data: [DONE]`), so unlike Anthropic's, there's no `event:` line to skip.
#[derive(Debug, Default)]
pub struct SseAccumulator {
    pending: Vec<u8>,
    text: String,
    tool_calls: Vec<ToolCallBuf>,
    model: String,
    finish_reason: Option<String>,
    error: Option<AiError>,
    writing: bool,
    done: bool,
}

impl SseAccumulator {
    pub fn feed(&mut self, bytes: &[u8]) {
        self.pending.extend_from_slice(bytes);
        while let Some(end) = self.pending.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=end).collect();
            let line = String::from_utf8_lossy(&line);
            let line = line.trim_end_matches(['\n', '\r']);
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            let data = data.strip_prefix(' ').unwrap_or(data).to_string();
            if data == "[DONE]" {
                self.done = true;
                continue;
            }
            if !data.is_empty() {
                self.event(&data);
            }
        }
    }

    fn tool_call_mut(&mut self, index: usize) -> &mut ToolCallBuf {
        while self.tool_calls.len() <= index {
            self.tool_calls.push(ToolCallBuf::default());
        }
        &mut self.tool_calls[index]
    }

    fn event(&mut self, data: &str) {
        let Ok(v) = serde_json::from_str::<Value>(data) else {
            return;
        };
        if let Some(err) = v.get("error") {
            self.error = Some(error_from_body(err));
            self.done = true;
            return;
        }
        if let Some(model) = v.get("model").and_then(Value::as_str) {
            self.model = model.to_string();
        }
        let Some(choice) = v.pointer("/choices/0") else { return };
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            self.finish_reason = Some(reason.to_string());
        }
        let Some(delta) = choice.get("delta") else { return };
        if let Some(t) = delta.get("content").and_then(Value::as_str) {
            self.writing = true;
            self.text.push_str(t);
        }
        if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
            for call in calls {
                self.writing = true;
                let index = call.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                let buf = self.tool_call_mut(index);
                if let Some(name) = call.pointer("/function/name").and_then(Value::as_str) {
                    buf.name.push_str(name);
                }
                if let Some(args) = call.pointer("/function/arguments").and_then(Value::as_str) {
                    buf.arguments.push_str(args);
                }
            }
        }
    }

    pub fn progress(&self) -> Progress {
        Progress {
            stage: if self.writing { Stage::Writing } else { Stage::Thinking },
            chars: self.text.chars().count(),
        }
    }

    pub fn is_done(&self) -> bool {
        self.done
    }

    pub fn finish(self) -> Result<Reply, AiError> {
        if let Some(e) = self.error {
            return Err(e);
        }
        let tool_calls = tool_calls_from(&self.tool_calls);
        match self.finish_reason.as_deref() {
            Some("content_filter") => Err(refused()),
            Some("length") => Err(cut_off()),
            None => Err(AiError::new(
                AiErrorKind::Network,
                "OpenAI's answer stopped before it was complete. Try again.",
            )),
            Some(_) if self.text.trim().is_empty() && tool_calls.is_empty() => Err(empty()),
            Some(_) => Ok(Reply {
                text: self.text,
                tool_calls,
                model: self.model,
            }),
        }
    }
}

fn tool_calls_from(bufs: &[ToolCallBuf]) -> Vec<ToolCall> {
    bufs.iter()
        .filter(|b| !b.name.is_empty())
        .map(|b| ToolCall {
            name: b.name.clone(),
            arguments: serde_json::from_str(&b.arguments).unwrap_or(Value::Object(Default::default())),
        })
        .collect()
}

fn refused() -> AiError {
    AiError::new(
        AiErrorKind::Refused,
        "GPT declined this request. Try rewording it as a market-research question.",
    )
}

fn cut_off() -> AiError {
    AiError::new(
        AiErrorKind::CutOff,
        "GPT's answer was cut off before it was complete. Try a simpler question.",
    )
}

fn empty() -> AiError {
    AiError::new(AiErrorKind::Api, "OpenAI returned an empty answer.")
}

/// `{"error": {"message": …, "type": …, "code": …}}`, from a JSON body or an already-parsed
/// `error` field of a streamed error event.
fn error_from_body(err: &Value) -> AiError {
    let message = err.get("message").and_then(Value::as_str).unwrap_or("").trim();
    let code = err.get("code").and_then(Value::as_str).unwrap_or("");
    match code {
        "invalid_api_key" => AiError::new(
            AiErrorKind::BadKey,
            "OpenAI didn't accept the API key. Check it in the AI providers settings.",
        ),
        "rate_limit_exceeded" | "insufficient_quota" => AiError::new(
            AiErrorKind::Busy,
            "Your OpenAI account's rate limit was reached. Wait a minute and try again.",
        ),
        _ if !message.is_empty() => AiError::new(AiErrorKind::Api, format!("OpenAI rejected the request: {message}")),
        _ => AiError::new(AiErrorKind::Api, "OpenAI rejected the request."),
    }
}

fn api_error(body: &str) -> Option<AiError> {
    let v: Value = serde_json::from_str(body).ok()?;
    Some(error_from_body(v.get("error")?))
}

fn http_error(status: u16, body: &str) -> AiError {
    if let Some(e) = api_error(body) {
        if e.kind != AiErrorKind::Api {
            return e;
        }
    }
    match status {
        401 => AiError::new(
            AiErrorKind::BadKey,
            "OpenAI didn't accept the API key. Check it in the AI providers settings.",
        ),
        429 => AiError::new(
            AiErrorKind::Busy,
            "Your OpenAI account's rate limit was reached. Wait a minute and try again.",
        ),
        413 => AiError::new(AiErrorKind::Api, "The request was too large for OpenAI to accept."),
        500..=599 => AiError::new(
            AiErrorKind::Busy,
            format!("OpenAI had a problem answering (HTTP {status}). Try again."),
        ),
        _ => match api_error(body) {
            Some(e) => e,
            None => AiError::new(
                AiErrorKind::Api,
                format!("OpenAI rejected the request (HTTP {status})."),
            ),
        },
    }
}

/// Reads a Chat Completions response. Pure, so every branch is tested without a server.
pub fn parse_reply(status: u16, body: &str) -> Result<Reply, AiError> {
    if !(200..300).contains(&status) {
        return Err(http_error(status, body));
    }
    let v: Value =
        serde_json::from_str(body).map_err(|_| AiError::new(AiErrorKind::Api, "OpenAI's answer wasn't readable."))?;
    let finish_reason = v.pointer("/choices/0/finish_reason").and_then(Value::as_str);
    match finish_reason {
        Some("content_filter") => return Err(refused()),
        Some("length") => return Err(cut_off()),
        _ => {}
    }
    let message = v.pointer("/choices/0/message");
    let text = message
        .and_then(|m| m.get("content"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let tool_calls: Vec<ToolCall> = message
        .and_then(|m| m.get("tool_calls"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|c| {
            let name = c.pointer("/function/name").and_then(Value::as_str)?.to_string();
            let args = c.pointer("/function/arguments").and_then(Value::as_str).unwrap_or("{}");
            Some(ToolCall {
                name,
                arguments: serde_json::from_str(args).unwrap_or(Value::Object(Default::default())),
            })
        })
        .collect();
    if text.trim().is_empty() && tool_calls.is_empty() {
        return Err(empty());
    }
    Ok(Reply {
        text,
        tool_calls,
        model: v.get("model").and_then(Value::as_str).unwrap_or_default().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::{Msg, ToolSpec};
    use serde_json::json;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn req(schema: Value) -> AiRequest {
        AiRequest::structured(
            "system".into(),
            vec![Msg {
                role: "user".into(),
                content: "hi".into(),
            }],
            schema,
        )
    }

    #[test]
    fn a_finished_answer_is_its_message_content() {
        let body = json!({
            "model": "gpt-5.1",
            "choices": [{"finish_reason": "stop", "message": {"role": "assistant", "content": "{\"a\":1}"}}]
        });
        let reply = parse_reply(200, &body.to_string()).unwrap();
        assert_eq!(reply.text, "{\"a\":1}");
        assert_eq!(reply.model, "gpt-5.1");
        assert!(reply.tool_calls.is_empty());
    }

    #[test]
    fn a_tool_call_is_read_from_a_whole_response() {
        let body = json!({
            "model": "gpt-5.1",
            "choices": [{"finish_reason": "tool_calls", "message": {
                "role": "assistant", "content": null,
                "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "add_watchlist_item", "arguments": "{\"symbol\":\"binance:BTCUSDT\"}"}}]
            }}]
        });
        let reply = parse_reply(200, &body.to_string()).unwrap();
        assert_eq!(reply.text, "");
        assert_eq!(
            reply.tool_calls,
            vec![ToolCall {
                name: "add_watchlist_item".into(),
                arguments: json!({"symbol": "binance:BTCUSDT"}),
            }]
        );
    }

    #[test]
    fn a_refusal_or_a_cut_off_answer_is_never_used() {
        let refused = json!({"choices": [{"finish_reason": "content_filter", "message": {"content": "partial"}}]});
        assert_eq!(
            parse_reply(200, &refused.to_string()).unwrap_err().kind,
            AiErrorKind::Refused
        );
        let cut = json!({"choices": [{"finish_reason": "length", "message": {"content": "{\"spec\":"}}]});
        assert_eq!(
            parse_reply(200, &cut.to_string()).unwrap_err().kind,
            AiErrorKind::CutOff
        );
        let empty = json!({"choices": [{"finish_reason": "stop", "message": {"content": ""}}]});
        assert_eq!(parse_reply(200, &empty.to_string()).unwrap_err().kind, AiErrorKind::Api);
        assert_eq!(parse_reply(200, "<html>").unwrap_err().kind, AiErrorKind::Api);
    }

    #[test]
    fn http_errors_become_plain_words() {
        let err = |status: u16, body: &str| parse_reply(status, body).unwrap_err();
        let bad_key = r#"{"error":{"message":"Incorrect API key provided","type":"invalid_request_error","code":"invalid_api_key"}}"#;
        assert_eq!(err(401, bad_key).kind, AiErrorKind::BadKey);
        assert_eq!(err(401, "{}").kind, AiErrorKind::BadKey);
        assert_eq!(err(429, "{}").kind, AiErrorKind::Busy);
        let invalid = r#"{"error":{"message":"max_completion_tokens: too big","type":"invalid_request_error"}}"#;
        let bad = err(400, invalid);
        assert_eq!(bad.kind, AiErrorKind::Api);
        assert!(
            bad.message.contains("max_completion_tokens: too big"),
            "{}",
            bad.message
        );
        assert!(err(500, "").message.contains("HTTP 500"));
    }

    async fn serve_once(status: u16, body: Value) -> (String, Arc<Mutex<Option<(String, String)>>>) {
        serve_raw(status, "application/json", body.to_string(), None).await
    }

    async fn serve_raw(
        status: u16,
        content_type: &'static str,
        payload: String,
        stall_after: Option<usize>,
    ) -> (String, Arc<Mutex<Option<(String, String)>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(None));
        let record = seen.clone();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = Vec::new();
            let head_end = loop {
                let mut chunk = [0u8; 8192];
                let n = sock.read(&mut chunk).await.unwrap();
                buf.extend_from_slice(&chunk[..n]);
                if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    break p + 4;
                }
                assert!(n > 0);
            };
            let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
            let length: usize = head
                .lines()
                .find_map(|l| {
                    let (k, v) = l.split_once(':')?;
                    k.eq_ignore_ascii_case("content-length")
                        .then(|| v.trim().parse().ok())?
                })
                .unwrap_or(0);
            while buf.len() < head_end + length {
                let mut chunk = [0u8; 8192];
                let n = sock.read(&mut chunk).await.unwrap();
                buf.extend_from_slice(&chunk[..n]);
            }
            let sent = String::from_utf8_lossy(&buf[head_end..head_end + length]).to_string();
            *record.lock().unwrap() = Some((head, sent));
            let head = format!(
                "HTTP/1.1 {status} X\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                payload.len()
            );
            sock.write_all(head.as_bytes()).await.unwrap();
            match stall_after {
                Some(n) => {
                    sock.write_all(&payload.as_bytes()[..n]).await.unwrap();
                    tokio::time::sleep(Duration::from_secs(3600)).await;
                }
                None => {
                    // A real gap between writes, not just a `flush()` (which doesn't pace a raw
                    // socket and would let a fast loopback coalesce every piece into one read).
                    for piece in payload.as_bytes().chunks(7) {
                        sock.write_all(piece).await.unwrap();
                        sock.flush().await.ok();
                        tokio::time::sleep(Duration::from_millis(2)).await;
                    }
                }
            }
            sock.shutdown().await.ok();
        });
        (base, seen)
    }

    #[tokio::test]
    async fn a_message_carries_the_key_and_strict_schema() {
        let (base, seen) = serve_once(
            200,
            json!({"model": "gpt-5.1", "choices": [{"finish_reason": "stop", "message": {"content": "hi"}}]}),
        )
        .await;
        let client = OpenAiClient::with_base(reqwest::Client::new(), &base);
        let reply = client
            .message("sk-test", &req(json!({"type": "object"})), &mut |_| {})
            .await
            .unwrap();
        assert_eq!(reply.text, "hi");
        let (head, body) = seen.lock().unwrap().clone().unwrap();
        let head = head.to_ascii_lowercase();
        assert!(head.starts_with("post /v1/chat/completions "), "{head}");
        assert!(head.contains("authorization: bearer sk-test"));
        let sent: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(sent["model"], MODEL);
        assert_eq!(sent["stream"], true);
        assert_eq!(sent["messages"][0]["role"], "system");
        assert_eq!(sent["response_format"]["json_schema"]["strict"], true);
        assert_eq!(sent["response_format"]["json_schema"]["schema"]["type"], "object");
    }

    #[tokio::test]
    async fn a_request_with_tools_sends_them_and_no_response_format() {
        let (base, seen) = serve_once(
            200,
            json!({"model": "gpt-5.1", "choices": [{"finish_reason": "tool_calls", "message": {"tool_calls": [{"function": {"name": "f", "arguments": "{}"}}]}}]}),
        )
        .await;
        let client = OpenAiClient::with_base(reqwest::Client::new(), &base);
        let req = AiRequest::with_tools(
            "system".into(),
            vec![Msg {
                role: "user".into(),
                content: "hi".into(),
            }],
            vec![ToolSpec {
                name: "f".into(),
                description: "does f".into(),
                schema: json!({"type": "object", "properties": {}, "required": [], "additionalProperties": false}),
            }],
        );
        client.message("sk-test", &req, &mut |_| {}).await.unwrap();
        let (_, body) = seen.lock().unwrap().clone().unwrap();
        let sent: Value = serde_json::from_str(&body).unwrap();
        assert!(sent.get("response_format").is_none());
        assert_eq!(sent["tools"][0]["type"], "function");
        assert_eq!(sent["tools"][0]["function"]["name"], "f");
    }

    #[tokio::test]
    async fn a_key_check_lists_models_and_reads_a_401_as_a_bad_key() {
        let (base, seen) = serve_once(200, json!({"data": []})).await;
        let client = OpenAiClient::with_base(reqwest::Client::new(), &base);
        client.check_key("sk-good").await.unwrap();
        let head = seen.lock().unwrap().clone().unwrap().0;
        assert!(head.starts_with("GET /v1/models "), "{head}");

        let (base, _) = serve_once(
            401,
            json!({"error": {"message": "Incorrect API key provided", "type": "invalid_request_error", "code": "invalid_api_key"}}),
        )
        .await;
        let client = OpenAiClient::with_base(reqwest::Client::new(), &base);
        assert_eq!(client.check_key("sk-bad").await.unwrap_err().kind, AiErrorKind::BadKey);
    }

    fn sse(events: &[Value]) -> String {
        let mut out: String = events.iter().map(|e| format!("data: {e}\n\n")).collect();
        out.push_str("data: [DONE]\n\n");
        out
    }

    fn accumulate(stream: &str, piece: usize) -> Result<Reply, AiError> {
        let mut acc = SseAccumulator::default();
        for chunk in stream.as_bytes().chunks(piece) {
            acc.feed(chunk);
        }
        acc.finish()
    }

    #[test]
    fn a_stream_is_read_however_it_is_split() {
        let events = vec![
            json!({"model": "gpt-5.1", "choices": [{"delta": {"content": "{\"a\":"}}]}),
            json!({"choices": [{"delta": {"content": " \"₹1 Cr\"}"}}]}),
            json!({"choices": [{"delta": {}, "finish_reason": "stop"}]}),
        ];
        let stream = sse(&events);
        for piece in [1, 2, 3, 5, 64, stream.len()] {
            let reply = accumulate(&stream, piece).unwrap();
            assert_eq!(reply.text, "{\"a\": \"₹1 Cr\"}", "split every {piece} bytes");
            assert_eq!(reply.model, "gpt-5.1");
        }
    }

    #[test]
    fn a_streamed_tool_call_reassembles_its_arguments_from_chunks() {
        let events = vec![
            json!({"model": "gpt-5.1", "choices": [{"delta": {"content": "Adding it."}}]}),
            json!({"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "c1", "function": {"name": "add_watchlist_item", "arguments": ""}}]}}]}),
            json!({"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": "{\"symbol\": \""}}]}}]}),
            json!({"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": "binance:BTCUSDT\"}"}}]}}]}),
            json!({"choices": [{"delta": {}, "finish_reason": "tool_calls"}]}),
        ];
        let reply = accumulate(&sse(&events), 9).unwrap();
        assert_eq!(reply.text, "Adding it.");
        assert_eq!(
            reply.tool_calls,
            vec![ToolCall {
                name: "add_watchlist_item".into(),
                arguments: json!({"symbol": "binance:BTCUSDT"}),
            }]
        );
    }

    #[test]
    fn a_tool_only_answer_with_no_text_is_not_an_empty_answer() {
        let events = vec![
            json!({"model": "gpt-5.1", "choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"name": "f", "arguments": "{}"}}]}}]}),
            json!({"choices": [{"delta": {}, "finish_reason": "tool_calls"}]}),
        ];
        let reply = accumulate(&sse(&events), 100).unwrap();
        assert_eq!(reply.text, "");
        assert_eq!(reply.tool_calls[0].name, "f");
    }

    #[test]
    fn progress_moves_from_thinking_to_writing() {
        let mut acc = SseAccumulator::default();
        acc.feed(b"data: {\"model\": \"gpt-5.1\", \"choices\": [{\"delta\": {}}]}\n\n");
        assert_eq!(
            acc.progress(),
            Progress {
                stage: Stage::Thinking,
                chars: 0
            }
        );
        acc.feed(b"data: {\"choices\": [{\"delta\": {\"content\": \"abcde\"}}]}\n\n");
        assert_eq!(
            acc.progress(),
            Progress {
                stage: Stage::Writing,
                chars: 5
            }
        );
        assert!(!acc.is_done());
        acc.feed(b"data: [DONE]\n\n");
        assert!(acc.is_done());
    }

    #[test]
    fn a_streamed_refusal_cut_off_or_error_is_never_used() {
        let refused =
            sse(&[json!({"choices": [{"delta": {"content": "partial"}, "finish_reason": "content_filter"}]})]);
        assert_eq!(accumulate(&refused, 9).unwrap_err().kind, AiErrorKind::Refused);
        let cut = sse(&[json!({"choices": [{"delta": {"content": "{\"spec\":"}, "finish_reason": "length"}]})]);
        assert_eq!(accumulate(&cut, 9).unwrap_err().kind, AiErrorKind::CutOff);
        let mut unfinished = sse(&[json!({"choices": [{"delta": {"content": "{}"}}]})]);
        unfinished = unfinished.replace("data: [DONE]\n\n", "");
        assert_eq!(accumulate(&unfinished, 9).unwrap_err().kind, AiErrorKind::Network);
        let error_event = sse(&[json!({"error": {"message": "Rate limit reached", "code": "rate_limit_exceeded"}})]);
        assert_eq!(accumulate(&error_event, 9).unwrap_err().kind, AiErrorKind::Busy);
    }

    #[tokio::test]
    async fn a_streamed_message_reports_progress_and_returns_the_answer() {
        let events = vec![
            json!({"model": "gpt-5.1", "choices": [{"delta": {"content": "{\"ok\""}}]}),
            json!({"choices": [{"delta": {"content": ": true}"}}]}),
            json!({"choices": [{"delta": {}, "finish_reason": "stop"}]}),
        ];
        let stream = sse(&events);
        let (base, _) = serve_raw(200, "text/event-stream", stream, None).await;
        let client = OpenAiClient::with_base(reqwest::Client::new(), &base);
        let mut seen = Vec::new();
        let reply = client
            .message("sk-test", &req(json!({"type": "object"})), &mut |p| seen.push(p))
            .await
            .unwrap();
        assert_eq!(reply.text, "{\"ok\": true}");
        assert!(seen.iter().any(|p| p.stage == Stage::Writing));
    }

    #[tokio::test]
    async fn a_stream_that_goes_quiet_is_given_up() {
        let events = vec![json!({"model": "gpt-5.1", "choices": [{"delta": {"content": "{}"}}]})];
        let stream = sse(&events);
        let stall = stream.len() - 20;
        let (base, _) = serve_raw(200, "text/event-stream", stream, Some(stall)).await;
        let client = OpenAiClient::with_base(reqwest::Client::new(), &base).with_idle(Duration::from_millis(300));
        let err = client
            .message("sk-test", &req(json!({"type": "object"})), &mut |_| {})
            .await
            .unwrap_err();
        assert_eq!(err.kind, AiErrorKind::Network);
        assert!(err.message.contains("stopped answering"), "{}", err.message);
    }
}
