mod alert_commands;
mod commands;
mod db;
mod dhan;
mod gate;
mod market;
mod models;
mod provider_commands;
mod providers;
mod schema;
mod secrets;
mod store;
mod throttle;
mod update_commands;
mod yahoo;
mod zerodha;
mod zerodha_commands;

use std::sync::Arc;

use tauri::{Emitter, Manager};

use crate::db::Database;
use crate::dhan::client::DhanClient;
use crate::dhan::feed::{Feed, FeedConfig};
use crate::market::Market;
use crate::secrets::Secrets;
use crate::zerodha::client::ZerodhaClient;
use crate::zerodha::feed::{Feed as ZerodhaFeed, FeedConfig as ZerodhaFeedConfig};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                // `new()` starts with default targets; `target()` only adds to
                // them, which would write a second, differently-named log file.
                .clear_targets()
                .target(tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout))
                .target(tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                    file_name: Some("protradechart".into()),
                }))
                // Debug builds log request-level detail (what was asked of each data
                // source, and what came back); release builds keep to the essentials.
                .level(if cfg!(debug_assertions) {
                    log::LevelFilter::Debug
                } else {
                    log::LevelFilter::Info
                })
                .max_file_size(5_000_000)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // Installed first so a panic below lands in the log file instead
            // of vanishing with the window.
            std::panic::set_hook(Box::new(|info| log::error!("panic: {info}")));

            let data_dir = app.path().app_local_data_dir()?;
            let db = Database::open(&data_dir)?;
            {
                let mut conn = db.conn.lock().map_err(|e| e.to_string())?;
                store::watchlists::seed_starter_list_once(&mut conn)?;
            }
            log::info!("database ready at {}", data_dir.display());

            app.manage(db);
            app.manage(Secrets::os());
            app.manage(Market::new());

            let broker_http = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .user_agent(concat!("protradechart/", env!("CARGO_PKG_VERSION")))
                .build()?;
            app.manage(DhanClient::new(broker_http.clone()));
            app.manage(ZerodhaClient::new(broker_http));

            // One live-feed connection for the whole app; ticks and status go
            // to every window as events. Credentials are read at each connect.
            let (creds_handle, tick_handle, status_handle) =
                (app.handle().clone(), app.handle().clone(), app.handle().clone());
            app.manage(Feed::start(FeedConfig::production(
                Arc::new(move || {
                    let db = creds_handle.state::<Database>();
                    let secrets = creds_handle.state::<Secrets>();
                    let conn = db.conn.lock().ok()?;
                    provider_commands::dhan_credentials(&conn, &secrets).ok()
                }),
                Arc::new(move |tick| {
                    let _ = tick_handle.emit("dhan-tick", tick);
                }),
                Arc::new(move |status| {
                    let _ = status_handle.emit("dhan-status", status);
                }),
            )));

            // Zerodha's feed works the same way, on its own connection and events.
            let (creds_handle, tick_handle, status_handle) =
                (app.handle().clone(), app.handle().clone(), app.handle().clone());
            app.manage(ZerodhaFeed::start(ZerodhaFeedConfig::production(
                Arc::new(move || {
                    let db = creds_handle.state::<Database>();
                    let secrets = creds_handle.state::<Secrets>();
                    let conn = db.conn.lock().ok()?;
                    zerodha_commands::zerodha_credentials(&conn, &secrets).ok()
                }),
                Arc::new(move |tick| {
                    let _ = tick_handle.emit("zerodha-tick", tick);
                }),
                Arc::new(move |status| {
                    let _ = status_handle.emit("zerodha-status", status);
                }),
            )));

            // Keep the brokers' instrument lists fresh in the background.
            let refresh_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let db = refresh_handle.state::<Database>();
                let secrets = refresh_handle.state::<Secrets>();
                let client = refresh_handle.state::<DhanClient>();
                provider_commands::refresh_instruments_if_stale(&db, &secrets, &client).await;
                let zerodha = refresh_handle.state::<ZerodhaClient>();
                zerodha_commands::refresh_instruments_if_stale(&db, &secrets, &zerodha).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_app_info,
            commands::get_ui_preference,
            commands::set_ui_preference,
            update_commands::restart_app,
            commands::get_chart_layouts,
            commands::save_chart_layout,
            commands::delete_chart_layout,
            commands::list_pine_scripts,
            commands::save_pine_script,
            commands::delete_pine_script,
            commands::list_watchlists,
            commands::get_watchlist,
            commands::create_watchlist,
            commands::rename_watchlist,
            commands::delete_watchlist,
            commands::add_watchlist_items,
            commands::remove_watchlist_items,
            commands::list_datasets,
            commands::save_dataset,
            commands::delete_dataset,
            commands::get_dataset_bars,
            commands::fetch_bars,
            commands::search_symbols,
            commands::fetch_quotes,
            provider_commands::list_providers,
            provider_commands::save_provider_config,
            provider_commands::clear_provider_config,
            provider_commands::set_provider_enabled,
            provider_commands::test_provider,
            provider_commands::dhan_status,
            provider_commands::dhan_update_instruments,
            provider_commands::dhan_renew_token,
            provider_commands::dhan_search_instruments,
            provider_commands::dhan_fetch_bars,
            provider_commands::dhan_quotes,
            provider_commands::dhan_subscribe,
            provider_commands::dhan_unsubscribe,
            zerodha_commands::zerodha_status,
            zerodha_commands::zerodha_login_url,
            zerodha_commands::zerodha_complete_login,
            zerodha_commands::zerodha_update_instruments,
            zerodha_commands::zerodha_search_instruments,
            zerodha_commands::zerodha_fetch_bars,
            zerodha_commands::zerodha_quotes,
            zerodha_commands::zerodha_subscribe,
            zerodha_commands::zerodha_unsubscribe,
            alert_commands::list_price_alerts,
            alert_commands::save_price_alert,
            alert_commands::delete_price_alert,
            alert_commands::clear_triggered_price_alerts,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the application");
}
