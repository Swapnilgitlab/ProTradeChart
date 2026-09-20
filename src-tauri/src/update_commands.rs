//! The one piece of the updater the plugin doesn't cover: restarting into the new version.

use tauri::AppHandle;

/// Relaunches the app after an update has been installed. On Windows the installer closes
/// the app itself, so this matters on macOS and Linux. `restart` goes through the normal
/// exit path, so the window state and database are closed cleanly first.
#[tauri::command]
pub fn restart_app(app: AppHandle) {
    app.restart();
}
