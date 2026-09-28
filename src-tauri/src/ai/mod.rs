//! AI providers: a request/reply shape neither Anthropic's nor OpenAI's API dictates, so
//! [`prompts`] and [`crate::ai_commands`] don't have to know which one answered. See "AI
//! providers" in `docs/ARCHITECTURE.md`.
//!
//! [`claude`] and [`openai`] are the two implementations. Each is a plain struct with its own
//! `check_key`/`message` methods (same signatures, no shared trait — two is a closed set here,
//! not a plugin point, so a `match` on the provider id in `ai_commands.rs` is simpler than an
//! async trait object). Both keep the caller's key out of their own logs, and never see anything
//! but what [`prompts`] put in an [`AiRequest`].

pub mod claude;
pub mod openai;
pub mod prompts;

use std::fmt;

use serde::Serialize;
use serde_json::Value;

/// One turn of a conversation, in the vocabulary both APIs share.
#[derive(Debug, Clone)]
pub struct Msg {
    pub role: String,
    pub content: String,
}

/// A tool the model may call, with its arguments as a JSON Schema object. Every property
/// required and `additionalProperties: false` at every level — what OpenAI's strict tool mode
/// needs, and no less exact than Anthropic wants either.
#[derive(Debug, Clone)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub schema: Value,
}

/// What a provider is asked to do. Exactly one of `schema` or `tools` is used by a given
/// request: the Study Builder's four calls ask for `schema`-shaped JSON text and never a tool;
/// Ask AI offers `tools` and no schema, since its answer is free text plus proposed actions.
#[derive(Debug, Clone)]
pub struct AiRequest {
    pub system: String,
    pub messages: Vec<Msg>,
    pub schema: Option<Value>,
    pub tools: Vec<ToolSpec>,
}

impl AiRequest {
    /// A request whose answer must be JSON text following `schema` (Study Builder calls).
    pub fn structured(system: String, messages: Vec<Msg>, schema: Value) -> Self {
        AiRequest {
            system,
            messages,
            schema: Some(schema),
            tools: Vec::new(),
        }
    }

    /// A request that may call one of `tools` instead of (or alongside) answering in text
    /// (Ask AI).
    pub fn with_tools(system: String, messages: Vec<Msg>, tools: Vec<ToolSpec>) -> Self {
        AiRequest {
            system,
            messages,
            schema: None,
            tools,
        }
    }
}

/// One action the model proposed. Never executed here or in either client: `ai_commands.rs`
/// hands it to the webview exactly as received, and only the frontend — after the user approves
/// it — calls the real function it names. See "Ask AI" in `docs/ARCHITECTURE.md`.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolCall {
    pub name: String,
    pub arguments: Value,
}

/// A finished answer: its text (a Study Builder call's JSON, or Ask AI's reply — empty is valid
/// when the model only proposed actions), any proposed actions, and the model that actually
/// produced it (a fallback model, for Claude, when the requested one declined).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Reply {
    pub text: String,
    pub tool_calls: Vec<ToolCall>,
    pub model: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AiErrorKind {
    /// The provider didn't accept the key.
    BadKey,
    /// Rate limited or overloaded: worth trying again later.
    Busy,
    /// The model declined the request.
    Refused,
    /// The answer hit its token limit before it was complete.
    CutOff,
    Network,
    /// Anything else the API said, in its own words.
    Api,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AiError {
    pub kind: AiErrorKind,
    pub message: String,
}

impl AiError {
    pub fn new(kind: AiErrorKind, message: impl Into<String>) -> Self {
        AiError {
            kind,
            message: message.into(),
        }
    }
}

impl fmt::Display for AiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

/// Where a streamed answer has got to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Stage {
    Thinking,
    Writing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Progress {
    pub stage: Stage,
    /// Characters of the answer so far.
    pub chars: usize,
}

pub(crate) fn network_error(e: &reqwest::Error, provider: &str) -> AiError {
    let what = if e.is_timeout() {
        format!("{provider} took too long to answer. Try again, or ask a narrower question.")
    } else {
        format!("Couldn't reach {provider}. Check the internet connection and try again.")
    };
    log::warn!("{provider} request failed: {e}");
    AiError::new(AiErrorKind::Network, what)
}

pub(crate) fn timed_out(provider: &str) -> AiError {
    AiError::new(
        AiErrorKind::Network,
        format!("{provider} stopped answering. Try again, or ask a narrower question."),
    )
}
