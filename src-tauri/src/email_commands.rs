//! Tauri commands for the email settings scripts send with (`pt.send_email`) and schedules send
//! failure notes with (`crate::email`). The password goes in only after a login with it worked, is
//! kept by `Secrets`, and never comes back out: the webview learns only whether one is saved.

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::db::Database;
use crate::email::{self, SmtpSettings, PREF_SETTINGS, SECRET_KEY, SECRET_PROVIDER};
use crate::secrets::Secrets;
use crate::store::preferences;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailStatus {
    pub settings: Option<SmtpSettings>,
    pub password_saved: bool,
}

fn status(db: &Database, secrets: &Secrets) -> Result<EmailStatus, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    Ok(EmailStatus {
        settings: email::saved_settings(&conn)?,
        password_saved: secrets
            .has(&conn, SECRET_PROVIDER, SECRET_KEY)
            .map_err(|e| e.to_string())?,
    })
}

#[tauri::command(async)]
pub fn email_status(db: State<Database>, secrets: State<Secrets>) -> Result<EmailStatus, String> {
    status(&db, &secrets)
}

/// Saves the settings after logging in with them: with `password` when one is given (it is saved
/// too), else with the one already saved.
#[tauri::command]
pub async fn email_save(
    settings: SmtpSettings,
    password: Option<String>,
    db: State<'_, Database>,
    secrets: State<'_, Secrets>,
) -> Result<EmailStatus, String> {
    settings.check()?;
    let typed = password.map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
    let password = match &typed {
        Some(p) => p.clone(),
        None => {
            let conn = db.conn.lock().map_err(|e| e.to_string())?;
            secrets
                .get(&conn, SECRET_PROVIDER, SECRET_KEY)
                .map_err(|e| e.to_string())?
                .ok_or("Type the password (an app password for Gmail and Outlook).")?
        }
    };
    email::test_login(&settings, &password).await?;
    {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let json = serde_json::to_string(&settings).map_err(|e| e.to_string())?;
        preferences::set(&conn, PREF_SETTINGS, &json).map_err(|e| e.to_string())?;
        if let Some(p) = &typed {
            secrets
                .set(&conn, SECRET_PROVIDER, SECRET_KEY, p)
                .map_err(|e| e.to_string())?;
        }
    }
    log::info!("email settings saved");
    status(&db, &secrets)
}

/// Sends a short test message to the user's own address.
#[tauri::command]
pub async fn email_send_test(app: AppHandle) -> Result<(), String> {
    email::send_to_self(
        &app,
        "ProTradeChart test email",
        "This is a test from ProTradeChart. Scripts can now send you email with pt.send_email, and schedules can tell you when a run fails.\n",
        Vec::new(),
    )
    .await
}

/// Forgets the settings and the password.
#[tauri::command(async)]
pub fn email_forget(db: State<Database>, secrets: State<Secrets>) -> Result<EmailStatus, String> {
    {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        preferences::delete(&conn, PREF_SETTINGS).map_err(|e| e.to_string())?;
        secrets
            .delete(&conn, SECRET_PROVIDER, SECRET_KEY)
            .map_err(|e| e.to_string())?;
    }
    status(&db, &secrets)
}
