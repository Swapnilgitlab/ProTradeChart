//! Persistence layer: plain functions over a `&Connection`, kept free of any
//! Tauri types so they can be unit-tested against an in-memory database.

pub mod alerts;
pub mod bar_memory;
pub mod bar_tables;
pub mod datasets;
pub mod day_topup;
pub mod index_catalog;
pub mod instrument_list;
pub mod layouts;
pub mod market_symbols;
pub mod notebooks;
pub mod preferences;
pub mod provider_settings;
pub mod research_bars;
pub mod schedules;
pub mod screeners;
pub mod scripts;
pub mod studies;
pub mod study_universe;
pub mod symbol_drawings;
pub mod symbol_names;
pub mod watchlists;
