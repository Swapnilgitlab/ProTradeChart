//! Tauri commands for price alerts. Thin, like `commands.rs`: validate, call
//! into `store::alerts`, and tell every window the list changed.

use std::sync::MutexGuard;

use rusqlite::Connection;
use tauri::{AppHandle, Emitter, State};

use crate::db::Database;
use crate::models::PriceAlert;
use crate::store::alerts;

/// Sent to every window after any change, so an open alerts list refreshes and
/// the window running the alert engine picks the change up.
const CHANGED_EVENT: &str = "alerts-changed";

fn lock(db: &Database) -> Result<MutexGuard<'_, Connection>, String> {
    db.conn.lock().map_err(|e| e.to_string())
}

const CONDITIONS: [&str; 3] = ["crossing_up", "crossing_down", "crossing"];
const MODES: [&str; 2] = ["once", "every"];
const STATUSES: [&str; 3] = ["active", "triggered", "paused"];

/// Rejects an alert that could never work, with a reason the user can act on.
pub fn validate(a: &PriceAlert) -> Result<(), String> {
    if a.id.trim().is_empty() {
        return Err("an alert needs an id".into());
    }
    if a.symbol.trim().is_empty() {
        return Err("Choose a symbol for the alert.".into());
    }
    if !a.price.is_finite() || a.price <= 0.0 {
        return Err("The alert price must be a number above zero.".into());
    }
    if !CONDITIONS.contains(&a.condition.as_str()) {
        return Err(format!("unknown alert condition '{}'", a.condition));
    }
    if !MODES.contains(&a.mode.as_str()) {
        return Err(format!("unknown alert mode '{}'", a.mode));
    }
    if !STATUSES.contains(&a.status.as_str()) {
        return Err(format!("unknown alert status '{}'", a.status));
    }
    if a.message.chars().count() > 200 {
        return Err("The alert note is too long (200 characters at most).".into());
    }
    Ok(())
}

#[tauri::command]
pub fn list_price_alerts(db: State<Database>) -> Result<Vec<PriceAlert>, String> {
    alerts::list(&*lock(&db)?).map_err(|e| e.to_string())
}

/// Creates the alert, or updates the one with the same id.
#[tauri::command]
pub fn save_price_alert(alert: PriceAlert, db: State<Database>, app: AppHandle) -> Result<(), String> {
    validate(&alert)?;
    alerts::save(&*lock(&db)?, &alert).map_err(|e| e.to_string())?;
    let _ = app.emit(CHANGED_EVENT, ());
    Ok(())
}

#[tauri::command]
pub fn delete_price_alert(id: String, db: State<Database>, app: AppHandle) -> Result<(), String> {
    alerts::delete(&*lock(&db)?, &id).map_err(|e| e.to_string())?;
    let _ = app.emit(CHANGED_EVENT, ());
    Ok(())
}

/// Removes the alerts that have already fired. Returns how many went.
#[tauri::command]
pub fn clear_triggered_price_alerts(db: State<Database>, app: AppHandle) -> Result<usize, String> {
    let removed = alerts::delete_triggered(&*lock(&db)?).map_err(|e| e.to_string())?;
    let _ = app.emit(CHANGED_EVENT, ());
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid() -> PriceAlert {
        PriceAlert {
            id: "a1".into(),
            symbol: "yahoo:AAPL".into(),
            condition: "crossing_up".into(),
            price: 250.0,
            base_price: Some(240.0),
            message: String::new(),
            mode: "once".into(),
            status: "active".into(),
            created_at: 1,
            triggered_at: None,
            trigger_price: None,
            trigger_count: 0,
        }
    }

    #[test]
    fn a_well_formed_alert_is_accepted() {
        assert!(validate(&valid()).is_ok());
    }

    #[test]
    fn an_alert_that_could_never_work_is_refused_with_a_reason() {
        type Breaker = Box<dyn Fn(&mut PriceAlert)>;
        let cases: Vec<(Breaker, &str)> = vec![
            (Box::new(|a| a.symbol = "  ".into()), "symbol"),
            (Box::new(|a| a.price = 0.0), "above zero"),
            (Box::new(|a| a.price = -5.0), "above zero"),
            (Box::new(|a| a.price = f64::NAN), "above zero"),
            (Box::new(|a| a.price = f64::INFINITY), "above zero"),
            (Box::new(|a| a.condition = "sideways".into()), "condition"),
            (Box::new(|a| a.mode = "sometimes".into()), "mode"),
            (Box::new(|a| a.status = "sleeping".into()), "status"),
            (Box::new(|a| a.message = "x".repeat(201)), "too long"),
            (Box::new(|a| a.id = String::new()), "id"),
        ];
        for (break_it, expected) in cases {
            let mut a = valid();
            break_it(&mut a);
            let err = validate(&a).unwrap_err();
            assert!(err.contains(expected), "{err:?} should mention {expected:?}");
        }
    }

    #[test]
    fn a_note_of_exactly_the_limit_is_fine() {
        let mut a = valid();
        a.message = "é".repeat(200); // counted in characters, not bytes
        assert!(validate(&a).is_ok());
    }
}
