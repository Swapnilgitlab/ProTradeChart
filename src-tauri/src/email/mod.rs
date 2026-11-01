//! Email, through the user's own SMTP account, to the user's own address only: what a script sends
//! with `pt.send_email`, and the note a schedule sends when a run fails. There is no recipient to
//! choose — a message goes from the address in the settings to the same address — so nothing the
//! app holds (broker prices included) can be mailed to anyone else.
//!
//! The settings (server, port, security, user name, address) are a preference; the password is a
//! secret (`Secrets`, `smtp` / `password`), saved only after a login with it worked, read only here,
//! and never sent back to the webview or a script.

use std::time::Duration;

use lettre::message::header::ContentType;
use lettre::message::{Attachment as Part, Mailbox, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::{Address, AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::db::Database;
use crate::secrets::Secrets;
use crate::store::preferences;

pub const PREF_SETTINGS: &str = "email.smtp";
pub const SECRET_PROVIDER: &str = "smtp";
pub const SECRET_KEY: &str = "password";

/// Limits on what one message carries. Attachments travel to the app base64 in a JSON body that
/// the local API caps at 16 MB, so their total stays well under that.
pub const MAX_ATTACHMENTS: usize = 20;
pub const MAX_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_SUBJECT_CHARS: usize = 200;
pub const MAX_BODY_CHARS: usize = 200_000;
const SEND_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Security {
    /// Plain connection upgraded with STARTTLS (usually port 587).
    Starttls,
    /// TLS from the first byte (usually port 465).
    Tls,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmtpSettings {
    pub host: String,
    pub port: u16,
    pub security: Security,
    pub username: String,
    /// The user's own address: every message is from it and to it.
    pub address: String,
}

impl SmtpSettings {
    pub fn check(&self) -> Result<(), String> {
        let host = self.host.trim();
        if host.is_empty()
            || host.len() > 253
            || !host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
        {
            return Err("The mail server should be a host name like smtp.gmail.com.".into());
        }
        if self.port == 0 {
            return Err("The port should be a number like 587 or 465.".into());
        }
        if self.username.trim().is_empty() || self.username.len() > 254 {
            return Err("Fill in the user name you log in to your mail server with.".into());
        }
        self.mailbox()?;
        Ok(())
    }

    fn mailbox(&self) -> Result<Mailbox, String> {
        let address: Address = self
            .address
            .trim()
            .parse()
            .map_err(|_| "Your email address doesn't look right.".to_string())?;
        Ok(Mailbox::new(Some("ProTradeChart".into()), address))
    }
}

/// One file attached to a message.
#[derive(Debug, Clone, PartialEq)]
pub struct Attachment {
    pub name: String,
    pub content_type: String,
    pub bytes: Vec<u8>,
}

/// A file name safe to put in a message: no path, no control characters, at most 100 characters.
pub fn clean_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '"' | '<' | '>' | ':' | '|' | '?' | '*'))
        .take(100)
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').to_string();
    if cleaned.is_empty() {
        "attachment".into()
    } else {
        cleaned
    }
}

/// The type a file is sent as, from its extension, unless the caller named one that reads.
pub fn content_type_for(name: &str, given: Option<&str>) -> String {
    if let Some(given) = given.filter(|g| ContentType::parse(g).is_ok()) {
        return given.to_string();
    }
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "csv" => "text/csv",
        "txt" | "log" => "text/plain",
        "json" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "pdf" => "application/pdf",
        "html" | "htm" => "text/html",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        _ => "application/octet-stream",
    }
    .to_string()
}

/// The message: from and to the user's own address, the text, and the attachments. Pure.
pub fn message(
    settings: &SmtpSettings,
    subject: &str,
    body: &str,
    attachments: Vec<Attachment>,
) -> Result<Message, String> {
    let subject = subject.trim();
    if subject.is_empty() || subject.chars().count() > MAX_SUBJECT_CHARS {
        return Err(format!("A subject of 1 to {MAX_SUBJECT_CHARS} characters, please."));
    }
    if body.chars().count() > MAX_BODY_CHARS {
        return Err(format!("The text can be at most {MAX_BODY_CHARS} characters."));
    }
    if attachments.len() > MAX_ATTACHMENTS {
        return Err(format!("At most {MAX_ATTACHMENTS} attachments per email."));
    }
    let total: usize = attachments.iter().map(|a| a.bytes.len()).sum();
    if total > MAX_ATTACHMENT_BYTES {
        return Err(format!(
            "The attachments come to {:.1} MB; an email can carry at most {} MB.",
            total as f64 / 1_048_576.0,
            MAX_ATTACHMENT_BYTES / 1_048_576
        ));
    }
    let me = settings.mailbox()?;
    let builder = Message::builder().from(me.clone()).to(me).subject(subject);
    let text = SinglePart::plain(body.to_string());
    let built = if attachments.is_empty() {
        builder.singlepart(text)
    } else {
        let mut mixed = MultiPart::mixed().singlepart(text);
        for a in attachments {
            let kind = ContentType::parse(&a.content_type)
                .unwrap_or(ContentType::parse("application/octet-stream").map_err(|e| e.to_string())?);
            mixed = mixed.singlepart(Part::new(clean_name(&a.name)).body(a.bytes, kind));
        }
        builder.multipart(mixed)
    };
    built.map_err(|e| format!("Couldn't put the email together: {e}"))
}

fn transport(settings: &SmtpSettings, password: &str) -> Result<AsyncSmtpTransport<Tokio1Executor>, String> {
    let host = settings.host.trim();
    let builder = match settings.security {
        Security::Tls => AsyncSmtpTransport::<Tokio1Executor>::relay(host),
        Security::Starttls => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(host),
    }
    .map_err(|e| format!("Couldn't use the mail server {host}: {e}"))?;
    Ok(builder
        .port(settings.port)
        .credentials(Credentials::new(
            settings.username.trim().to_string(),
            password.to_string(),
        ))
        .timeout(Some(SEND_TIMEOUT))
        .build())
}

/// A mail server's refusal in words a user can act on.
fn explain(e: lettre::transport::smtp::Error) -> String {
    let text = e.to_string();
    if (e.is_permanent() && text.contains("535")) || text.to_ascii_lowercase().contains("authentication") {
        return "The mail server refused the user name or password. Gmail and Outlook need an app password, not your account password.".into();
    }
    if e.is_timeout() {
        return "The mail server didn't answer in time. Check the server name, the port and your connection.".into();
    }
    format!("The mail server refused it: {text}")
}

/// Logs in to the mail server with these settings, without sending anything.
pub async fn test_login(settings: &SmtpSettings, password: &str) -> Result<(), String> {
    match transport(settings, password)?.test_connection().await {
        Ok(true) => Ok(()),
        Ok(false) => Err("The mail server closed the connection.".into()),
        Err(e) => Err(explain(e)),
    }
}

pub async fn send(settings: &SmtpSettings, password: &str, message: Message) -> Result<(), String> {
    transport(settings, password)?
        .send(message)
        .await
        .map(|_| ())
        .map_err(explain)
}

/// The saved settings, if email is set up.
pub fn saved_settings(conn: &rusqlite::Connection) -> Result<Option<SmtpSettings>, String> {
    preferences::get(conn, PREF_SETTINGS)
        .map_err(|e| e.to_string())?
        .map(|json| serde_json::from_str(&json).map_err(|e| e.to_string()))
        .transpose()
}

/// The settings and the password, or why email can't be sent.
pub fn load(app: &AppHandle) -> Result<(SmtpSettings, String), String> {
    const NOT_SET_UP: &str = "Email isn't set up: open the Scheduler tab and choose Email settings.";
    let db = app.state::<Database>();
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let settings = saved_settings(&conn)?.ok_or(NOT_SET_UP)?;
    let password = app
        .state::<Secrets>()
        .get(&conn, SECRET_PROVIDER, SECRET_KEY)
        .map_err(|e| e.to_string())?
        .ok_or(NOT_SET_UP)?;
    Ok((settings, password))
}

/// Sends a message to the user's own address.
pub async fn send_to_self(
    app: &AppHandle,
    subject: &str,
    body: &str,
    attachments: Vec<Attachment>,
) -> Result<(), String> {
    let (settings, password) = load(app)?;
    let message = message(&settings, subject, body, attachments)?;
    send(&settings, &password, message).await
}

/// The note a schedule sends when a run of it fails: what failed, and the end of what each script
/// printed. Nothing is sent (and nothing is wrong) when email isn't set up.
pub async fn send_failure_notice(app: &AppHandle, name: &str, message: &str, run_row: i64) -> Result<(), String> {
    if load(app).is_err() {
        return Ok(());
    }
    let steps = {
        let db = app.state::<Database>();
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT script, status, message, output FROM schedule_steps WHERE run_row = ?1 ORDER BY step")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([run_row], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        rows
    };
    send_to_self(
        app,
        &format!("Schedule failed: {name}"),
        &failure_text(name, message, &steps),
        Vec::new(),
    )
    .await
}

/// The text of a failure note. Pure.
pub fn failure_text(name: &str, message: &str, steps: &[(String, String, String, String)]) -> String {
    let mut text = format!("The schedule \"{name}\" failed: {message}\n\n");
    for (script, status, why, output) in steps {
        text.push_str(&format!("{script}: {status}"));
        if !why.is_empty() {
            text.push_str(&format!(" ({why})"));
        }
        text.push('\n');
        if status == "failed" && !output.is_empty() {
            text.push_str("Last lines it printed:\n");
            text.push_str(&crate::store::schedules::tail(output, 3_000));
            text.push('\n');
        }
    }
    text.push_str("\nSee the Scheduler tab in ProTradeChart for the whole run.\n");
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings() -> SmtpSettings {
        SmtpSettings {
            host: "smtp.example.com".into(),
            port: 587,
            security: Security::Starttls,
            username: "me@example.com".into(),
            address: "me@example.com".into(),
        }
    }

    fn formatted(m: &Message) -> String {
        String::from_utf8(m.formatted()).unwrap()
    }

    #[test]
    fn settings_are_checked() {
        assert!(settings().check().is_ok());
        for bad in [
            SmtpSettings {
                host: "".into(),
                ..settings()
            },
            SmtpSettings {
                host: "smtp example.com".into(),
                ..settings()
            },
            SmtpSettings { port: 0, ..settings() },
            SmtpSettings {
                username: " ".into(),
                ..settings()
            },
            SmtpSettings {
                address: "not an address".into(),
                ..settings()
            },
        ] {
            assert!(bad.check().is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_message_goes_from_and_to_your_own_address_only() {
        let m = message(&settings(), "Breakouts", "3 new names", Vec::new()).unwrap();
        let envelope = m.envelope();
        assert_eq!(envelope.from().map(|a| a.to_string()), Some("me@example.com".into()));
        assert_eq!(
            envelope.to().iter().map(|a| a.to_string()).collect::<Vec<_>>(),
            ["me@example.com"]
        );
        let text = formatted(&m);
        assert!(text.contains("Subject: Breakouts"));
        assert!(text.contains("3 new names"));
    }

    #[test]
    fn attachments_are_named_safely_typed_and_limited() {
        let csv = Attachment {
            name: "..\\..\\matches.csv".into(),
            content_type: content_type_for("matches.csv", None),
            bytes: b"symbol\nRELIANCE\n".to_vec(),
        };
        let png = Attachment {
            name: "RELIANCE.png".into(),
            content_type: content_type_for("RELIANCE.png", Some("not a type")),
            bytes: vec![0x89, b'P', b'N', b'G'],
        };
        let text = formatted(&message(&settings(), "Daily", "", vec![csv, png]).unwrap());
        assert!(text.contains("filename=\"matches.csv\""), "no path in the name");
        assert!(text.contains("text/csv") && text.contains("image/png"));

        let big = Attachment {
            name: "big.bin".into(),
            content_type: "application/octet-stream".into(),
            bytes: vec![0; MAX_ATTACHMENT_BYTES + 1],
        };
        assert!(message(&settings(), "Too big", "", vec![big])
            .unwrap_err()
            .contains("at most 10 MB"));
        let many = (0..=MAX_ATTACHMENTS)
            .map(|i| Attachment {
                name: format!("{i}.txt"),
                content_type: "text/plain".into(),
                bytes: vec![b'x'],
            })
            .collect();
        assert!(message(&settings(), "Many", "", many).is_err());
        assert!(
            message(&settings(), "  ", "", Vec::new()).is_err(),
            "a subject is needed"
        );
    }

    #[test]
    fn file_names_lose_paths_and_odd_characters() {
        assert_eq!(clean_name("C:\\Users\\me\\report.csv"), "report.csv");
        assert_eq!(clean_name("a<b>:c?.png"), "abc.png");
        assert_eq!(clean_name("../"), "attachment");
    }

    #[test]
    fn a_failure_note_says_what_failed_and_shows_its_last_lines() {
        let steps = vec![
            (
                "screen.py".to_string(),
                "ok".to_string(),
                String::new(),
                "fine\n".to_string(),
            ),
            (
                "mail.py".to_string(),
                "failed".to_string(),
                "Exited with code 1".to_string(),
                "! KeyError: 'x'\n".to_string(),
            ),
            (
                "after.py".to_string(),
                "not-run".to_string(),
                String::new(),
                String::new(),
            ),
        ];
        let text = failure_text("Evening", "mail.py (script 2 of 3): Exited with code 1", &steps);
        assert!(text.starts_with("The schedule \"Evening\" failed"));
        assert!(text.contains("mail.py: failed (Exited with code 1)\nLast lines it printed:\n! KeyError: 'x'"));
        assert!(text.contains("after.py: not-run"));
        assert!(!text.contains("fine"), "only the failed script's output");
    }
}
