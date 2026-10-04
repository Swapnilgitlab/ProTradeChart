//! Tauri commands for the data-provider settings: what the Data providers dialog lists, saves, clears,
//! switches on and off, and tests. A broker's own commands (Zerodha's login, instruments, bars) live
//! beside its client.

use std::collections::HashMap;
use std::sync::MutexGuard;

use rusqlite::Connection;
use serde::Serialize;
use tauri::State;

use crate::db::Database;
use crate::models::ProviderInfo;
use crate::providers;
use crate::secrets::Secrets;
use crate::store::provider_settings::{self as settings, Table};
use crate::zerodha::client::ZerodhaClient;
use crate::zerodha::feed::Feed as ZerodhaFeed;
use crate::zerodha_commands::{self, TOKEN_SAVED_KEY, ZERODHA};

fn lock(db: &Database) -> Result<MutexGuard<'_, Connection>, String> {
    db.conn.lock().map_err(|e| e.to_string())
}

fn sql<T>(result: rusqlite::Result<T>) -> Result<T, String> {
    result.map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn list_providers(db: State<Database>, secrets: State<Secrets>) -> Result<Vec<ProviderInfo>, String> {
    sql(providers::describe(&*lock(&db)?, &secrets))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    /// Where a newly saved secret went: `keychain` or `database`.
    pub secret_storage: Option<String>,
}

#[tauri::command(async)]
pub fn save_provider_config(
    provider: String,
    values: HashMap<String, String>,
    db: State<Database>,
    secrets: State<Secrets>,
    zerodha_feed: State<ZerodhaFeed>,
) -> Result<SaveResult, String> {
    let storage = providers::save_config(&*lock(&db)?, &secrets, &provider, &values)?;
    if provider == ZERODHA {
        // Kite tokens carry no expiry, so remember when a pasted one arrived.
        if values.get("accessToken").is_some_and(|t| !t.trim().is_empty()) {
            sql(zerodha_commands::note_token_saved(&*lock(&db)?))?;
        }
        zerodha_feed.reconnect(); // a new token takes effect on the live connection too
    }
    Ok(SaveResult {
        secret_storage: storage.map(|s| s.as_str().to_string()),
    })
}

#[tauri::command(async)]
pub fn clear_provider_config(
    provider: String,
    db: State<Database>,
    secrets: State<Secrets>,
    zerodha_feed: State<ZerodhaFeed>,
) -> Result<(), String> {
    providers::clear_config(&*lock(&db)?, &secrets, &provider)?;
    if provider == ZERODHA {
        sql(settings::delete(
            &*lock(&db)?,
            Table::Settings,
            ZERODHA,
            TOKEN_SAVED_KEY,
        ))?;
        zerodha_feed.reconnect();
    }
    Ok(())
}

#[tauri::command(async)]
pub fn set_provider_enabled(
    provider: String,
    enabled: bool,
    db: State<Database>,
    zerodha_feed: State<ZerodhaFeed>,
) -> Result<(), String> {
    providers::set_enabled(&*lock(&db)?, &provider, enabled)?;
    if provider == ZERODHA {
        zerodha_feed.reconnect();
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub ok: bool,
    pub message: String,
    pub details: Vec<String>,
}

#[tauri::command]
pub async fn test_provider(
    provider: String,
    db: State<'_, Database>,
    secrets: State<'_, Secrets>,
    zerodha_client: State<'_, ZerodhaClient>,
) -> Result<TestResult, String> {
    if providers::spec(&provider).is_none() {
        return Err(format!("unknown data provider '{provider}'"));
    }
    if provider == ZERODHA {
        return zerodha_commands::test(&db, &secrets, &zerodha_client).await;
    }
    Ok(TestResult {
        ok: true,
        message: "Nothing to test — this provider needs no setup.".into(),
        details: vec![],
    })
}
