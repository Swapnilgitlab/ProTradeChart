//! Commands for "Save prices on this computer" (`crate::prices`). Every one touches the disk, so
//! none runs on the window's thread.

use tauri::{AppHandle, Manager};

use crate::db::Database;
use crate::market_commands::sync_market;
use crate::prices::{self, SavedPrices, SavedPricesStatus, PREF_SAVE};
use crate::store::bar_memory::BarMemory;
use crate::store::preferences;

fn status(app: &AppHandle) -> Result<SavedPricesStatus, String> {
    let on = {
        let db = app.state::<Database>();
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        prices::saving(&conn)
    };
    Ok(app.state::<SavedPrices>().status(&app.state::<BarMemory>(), on))
}

#[tauri::command(async)]
pub fn saved_prices_status(app: AppHandle) -> Result<SavedPricesStatus, String> {
    status(&app)
}

/// Switches saving on (what memory holds is saved at once, and kept from then on) or off (the saved
/// prices are deleted; memory keeps what it holds until the app closes).
#[tauri::command(async)]
pub fn saved_prices_set(on: bool, app: AppHandle) -> Result<SavedPricesStatus, String> {
    {
        let db = app.state::<Database>();
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        preferences::set(&conn, PREF_SAVE, if on { "true" } else { "false" }).map_err(|e| e.to_string())?;
    }
    if on {
        sync_market(&app);
    } else {
        app.state::<SavedPrices>().switch_off(&app.state::<BarMemory>())?;
    }
    status(&app)
}

/// Deletes every saved price (and what memory holds of Indian symbols, read again when needed).
#[tauri::command(async)]
pub fn saved_prices_delete(app: AppHandle) -> Result<SavedPricesStatus, String> {
    app.state::<SavedPrices>().delete(&app.state::<BarMemory>())?;
    status(&app)
}
