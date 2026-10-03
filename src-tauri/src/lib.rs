mod ai;
mod ai_commands;
mod alert_commands;
mod commands;
mod db;
mod market;
mod marketdata;
mod marketdata_commands;
mod models;
mod provider_commands;
mod providers;
mod pyapi;
mod python;
mod python_commands;
mod schedule_commands;
mod scheduler;
mod schema;
mod screener_commands;
mod secrets;
mod store;
mod study_commands;
mod throttle;
mod update_commands;
mod zerodha;
mod zerodha_commands;

use std::sync::Arc;

use tauri::{Emitter, Manager};

use crate::db::{Database, ResearchDb};
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
                store::retired::purge_yahoo_leftovers_once(&mut conn)?;
                store::retired::purge_dhan_leftovers_once(&mut conn, &secrets)?;
            }
            log::info!("database ready at {}", data_dir.display());

            app.manage(db);
            app.manage(ResearchDb::open(&data_dir)?);
            app.manage(marketdata::MarketData::default());
            app.manage(secrets);
            // The Python runs and the local data API they use, which starts with the first script.
            app.manage(python::PythonState::default());

            let broker_http = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .user_agent(concat!("protradechart/", env!("CARGO_PKG_VERSION")))
                .build()?;
            app.manage(ZerodhaClient::new(broker_http));
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

            // Scripts the user scheduled. Only ever started here, once.
            scheduler::engine::start(app.handle().clone());
            // The market-data store's daily update; idle until the user has started the download,
            // and its first look is minutes after launch.
            marketdata::start_engine(app.handle().clone());

            // Keep the broker's instrument list fresh in the background.
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
            zerodha_commands::zerodha_search_instruments,
            zerodha_commands::zerodha_fetch_bars,
            zerodha_commands::zerodha_quotes,
            zerodha_commands::zerodha_subscribe,
            zerodha_commands::zerodha_unsubscribe,
            alert_commands::list_price_alerts,
            alert_commands::save_price_alert,
            alert_commands::delete_price_alert,
            alert_commands::clear_triggered_price_alerts,
            python_commands::python_env_status,
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
            marketdata_commands::market_data_download,
            marketdata_commands::market_data_update_now,
            marketdata_commands::market_data_stop,
            marketdata_commands::market_data_set_auto,
            schedule_commands::list_schedules,
            schedule_commands::save_schedule,
            schedule_commands::delete_schedule,
            schedule_commands::list_schedule_runs,
            schedule_commands::run_schedule_now,
            schedule_commands::stop_schedule_run,
            ai_commands::list_ai_providers,
            ai_commands::ai_set_key,
            ai_commands::ai_delete_key,
            ai_commands::ai_draft_study,
            ai_commands::ai_explain_result,
            ai_commands::ai_plan_research,
            ai_commands::ai_synthesize_research,
            ai_commands::ai_ask_ai,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the application");
}
