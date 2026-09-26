//! Persistence layer: plain functions over a `&Connection`, kept free of any
//! Tauri types so they can be unit-tested against an in-memory database.

pub mod alerts;
pub mod bars_cache;
pub mod datasets;
pub mod instrument_list;
pub mod layouts;
pub mod notebooks;
pub mod preferences;
pub mod provider_settings;
pub mod research_bars;
pub mod retired;
pub mod scripts;
pub mod studies;
pub mod study_universe;
pub mod symbol_names;
pub mod watchlists;
