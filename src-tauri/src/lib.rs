mod ai;
mod ai_commands;
mod alert_commands;
mod commands;
mod db;
mod email;
mod email_commands;
mod fyers;
mod fyers_commands;
mod login_callback;
mod market;
mod market_commands;
mod marketdata;
mod marketdata_commands;
mod models;
mod prices;
mod prices_commands;
mod provider_commands;
mod providers;
mod pyapi;
mod python;
mod python_commands;
mod schedule_commands;
mod scheduler;
mod schema;
mod screener_commands;
mod screenshot;
mod secrets;
mod store;
mod study_commands;
mod symbols;
mod throttle;
mod update_commands;
mod zerodha;
mod zerodha_commands;

use std::sync::Arc;

use tauri::{Emitter, Manager};

use crate::db::Database;
use crate::fyers::client::FyersClient;
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
                // Debug builds would otherwise log every credential lookup: thousands of
                // lines in one screen of the watchlist, burying the entries that matter.
                .level_for("keyring", log::LevelFilter::Info)
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
            let secrets = Secrets::os();
            {
                let mut conn = db.conn.lock().map_err(|e| e.to_string())?;
                store::watchlists::seed_starter_list_once(&mut conn)?;
            }
            let fyers_plan = fyers_commands::saved_plan(&*db.conn.lock().map_err(|e| e.to_string())?);
            log::info!("database ready at {}", data_dir.display());

            app.manage(db);
            app.manage(store::bar_memory::BarMemory::default());
            // The saved prices' files sit beside the database; which one is open follows the broker
            // (`market_commands::sync_market`, below, once everything it needs is managed).
            app.manage(prices::SavedPrices::new(data_dir.clone()));
            app.manage(market_commands::Serving::default());
            app.manage(marketdata::MarketData::default());
            app.manage(secrets);
            // The Python runs and the local data API they use, which starts with the first script.
            app.manage(python::PythonState::default());
            app.manage(screenshot::Screenshots::default());

            let broker_http = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .user_agent(concat!("protradechart/", env!("CARGO_PKG_VERSION")))
                .build()?;
            app.manage(ZerodhaClient::new(broker_http.clone()));
            let fyers = FyersClient::new(broker_http);
            fyers.set_plan(fyers_plan);
            app.manage(fyers);
            app.manage(fyers::session::FyersSession::default());
            app.manage(fyers::quotes::QuoteCache::default());
            app.manage(fyers::poller::Poller::default());
            // Notes the broker serving `india:`, and opens the saved prices when saving is on: only
            // their index is read now (a few thousand rows), never the bars.
            market_commands::sync_market(app.handle());
            // Keeps the saved prices from growing without end: intraday is trimmed, daily is kept.
            let prune_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(5 * 60)).await;
                loop {
                    let memory = prune_handle.state::<store::bar_memory::BarMemory>();
                    let pruned = memory.prune(db::now_ms(), &store::bar_memory::PrunePolicy::default());
                    if pruned > 0 {
                        log::info!("saved prices: {pruned} intraday series trimmed or dropped");
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(24 * 60 * 60)).await;
                }
            });
            // AI's own clients: their requests set their own, longer, timeouts.
            let ai_http = reqwest::Client::builder()
                .user_agent(concat!("protradechart/", env!("CARGO_PKG_VERSION")))
                .build()?;
            app.manage(ai::claude::ClaudeClient::new(ai_http.clone()));
            app.manage(ai::openai::OpenAiClient::new(ai_http));

            // One live-feed connection for the whole app; ticks and status go to every window as
            // events. Credentials are read at each connect.
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

            // FYERS's live charts, from polled quotes: one loop for the whole app, idle until a chart subscribes.
            fyers::poller::start(app.handle().clone());
            // Scripts the user scheduled. Only ever started here, once.
            scheduler::engine::start(app.handle().clone());
            // The market-data store's daily update; idle until the user has started the download,
            // and its first look is minutes after launch.
            marketdata::start_engine(app.handle().clone());

            // Keep each set-up broker's instrument list fresh in the background.
            let refresh_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let db = refresh_handle.state::<Database>();
                let secrets = refresh_handle.state::<Secrets>();
                let zerodha = refresh_handle.state::<ZerodhaClient>();
                zerodha_commands::refresh_instruments_if_stale(
                    &db,
                    &secrets,
                    &zerodha,
                    zerodha_commands::INSTRUMENTS_MAX_AGE_MS,
                )
                .await;
                let fyers = refresh_handle.state::<FyersClient>();
                fyers_commands::refresh_instruments_if_stale(
                    &db,
                    &secrets,
                    &fyers,
                    fyers_commands::INSTRUMENTS_MAX_AGE_MS,
                )
                .await;
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
            commands::create_indices_watchlist,
            commands::list_nse_equities,
            commands::list_watchlist_members,
            commands::get_symbol_drawings,
            commands::save_symbol_drawings,
            commands::rename_watchlist,
            commands::delete_watchlist,
            commands::add_watchlist_items,
            commands::remove_watchlist_items,
            commands::set_symbol_flag,
            commands::symbol_flags,
            commands::list_flag_lists,
            commands::set_watchlist_order,
            commands::add_watchlist_section,
            commands::rename_watchlist_section,
            commands::delete_watchlist_section,
            commands::set_watchlist_section_collapsed,
            commands::list_datasets,
            commands::save_dataset,
            commands::delete_dataset,
            commands::get_dataset_bars,
            commands::symbol_names,
            provider_commands::list_providers,
            provider_commands::save_provider_config,
            provider_commands::clear_provider_config,
            provider_commands::set_provider_enabled,
            provider_commands::test_provider,
            zerodha_commands::zerodha_status,
            zerodha_commands::zerodha_login_url,
            zerodha_commands::zerodha_complete_login,
            zerodha_commands::zerodha_login_in_browser,
            zerodha_commands::zerodha_redirect_url,
            zerodha_commands::zerodha_update_instruments,
            zerodha_commands::zerodha_subscribe,
            zerodha_commands::zerodha_unsubscribe,
            fyers_commands::fyers_status,
            fyers_commands::fyers_login_url,
            fyers_commands::fyers_redirect_url,
            fyers_commands::fyers_login_in_browser,
            fyers_commands::fyers_complete_login,
            fyers_commands::fyers_set_pin,
            fyers_commands::fyers_set_plan,
            fyers_commands::fyers_update_instruments,
            fyers_commands::fyers_subscribe,
            fyers_commands::fyers_unsubscribe,
            market_commands::market_source,
            market_commands::set_market_source,
            market_commands::market_fetch_bars,
            market_commands::market_quotes,
            market_commands::market_search_instruments,
            prices_commands::saved_prices_status,
            prices_commands::saved_prices_set,
            prices_commands::saved_prices_delete,
            alert_commands::list_price_alerts,
            alert_commands::save_price_alert,
            alert_commands::delete_price_alert,
            alert_commands::clear_triggered_price_alerts,
            python_commands::python_env_status,
            python_commands::python_probe_packages,
            python_commands::python_set_interpreter,
            python_commands::python_setup_env,
            python_commands::python_list_scripts,
            python_commands::python_read_script,
            python_commands::python_save_script,
            python_commands::python_delete_script,
            python_commands::python_reveal_folder,
            python_commands::python_run,
            python_commands::python_stop,
            python_commands::python_research_stats,
            python_commands::python_clear_research_data,
            study_commands::list_studies,
            study_commands::save_study,
            study_commands::delete_study,
            study_commands::list_study_results,
            study_commands::get_study_result,
            study_commands::save_study_result,
            study_commands::delete_study_result,
            study_commands::study_run,
            study_commands::study_estimate,
            study_commands::list_notebooks,
            study_commands::get_notebook,
            study_commands::save_notebook,
            study_commands::delete_notebook,
            study_commands::add_notebook_item,
            study_commands::remove_notebook_item,
            study_commands::set_notebook_item_note,
            study_commands::set_notebook_order,
            study_commands::export_study_file,
            screener_commands::list_screeners,
            screener_commands::save_screener,
            screener_commands::delete_screener,
            screener_commands::save_screener_result,
            screener_commands::get_screener_result,
            screener_commands::screen_run,
            marketdata_commands::market_data_status,
            marketdata_commands::market_data_load_now,
            marketdata_commands::market_data_stop,
            marketdata_commands::market_data_set_keep_loaded,
            schedule_commands::list_schedules,
            schedule_commands::save_schedule,
            schedule_commands::delete_schedule,
            schedule_commands::list_schedule_runs,
            schedule_commands::run_schedule_now,
            schedule_commands::stop_schedule_run,
            email_commands::email_status,
            email_commands::email_save,
            email_commands::email_send_test,
            email_commands::email_forget,
            screenshot::script_screenshot_result,
            ai_commands::list_ai_providers,
            ai_commands::ai_set_key,
            ai_commands::ai_delete_key,
            ai_commands::ai_draft_study,
            ai_commands::ai_explain_result,
            ai_commands::ai_plan_research,
            ai_commands::ai_synthesize_research,
            ai_commands::ai_ask_ai,
            ai_commands::ai_python_assist,
        ])
        .build(tauri::generate_context!())
        .expect("error while building the application")
        .run(|app, event| {
            // What memory has queued for the saved prices is written before the app goes.
            if let tauri::RunEvent::Exit = event {
                app.state::<prices::SavedPrices>().close();
            }
        });
}
