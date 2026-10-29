//! The catalogue of data providers, and their user-facing settings.
//!
//! This file is the single source of truth for what each provider is and what
//! it needs configured; the frontend renders its settings screen from
//! `describe()` rather than duplicating the field lists. To add a provider,
//! add a `ProviderSpec` here, implement its client beside `zerodha/`, and register a matching `DataProvider` on the TypeScript side.

use std::collections::HashMap;

use rusqlite::Connection;

use crate::models::{ProviderCapabilities, ProviderField, ProviderInfo};
use crate::secrets::{Secrets, Storage};
use crate::store::provider_settings::{self as settings, Table};

const ENABLED_KEY: &str = "enabled";

pub struct FieldSpec {
    pub key: &'static str,
    pub label: &'static str,
    pub secret: bool,
    pub help: &'static str,
    pub placeholder: &'static str,
}

pub struct ProviderSpec {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    /// `broker` or `local`.
    pub category: &'static str,
    pub fields: &'static [FieldSpec],
    pub can_disable: bool,
    pub history: bool,
    pub live: bool,
    pub search: bool,
    pub quotes: bool,
    pub docs_url: Option<&'static str>,
}

pub const PROVIDERS: &[ProviderSpec] = &[
    ProviderSpec {
        id: "csv",
        label: "Imported data",
        description: "Your own OHLCV files, stored on this computer.",
        category: "local",
        fields: &[],
        can_disable: false,
        history: true,
        live: false,
        search: true,
        quotes: true,
        docs_url: None,
    },
    ProviderSpec {
        id: "zerodha",
        label: "Zerodha",
        description: "Indian equities, indices, futures and commodities from your own Kite Connect app: \
                      historical candles and a live tick feed. Needs Zerodha's paid Kite Connect subscription, \
                      and a fresh login each morning.",
        category: "broker",
        fields: &[
            FieldSpec {
                key: "apiKey",
                label: "API key",
                secret: false,
                help: "From your Kite Connect app at developers.kite.trade.",
                placeholder: "a1b2c3d4e5f6g7h8",
            },
            FieldSpec {
                key: "apiSecret",
                label: "API secret",
                secret: true,
                help: "From the same app. Used only to log in from here; it never leaves this computer.",
                placeholder: "••••••••••••••••",
            },
            FieldSpec {
                key: "accessToken",
                label: "Access token",
                secret: true,
                help: "Filled in for you when you log in below. Kite tokens expire every morning around 6 AM. \
                       You can also paste one you generated yourself.",
                placeholder: "set by logging in",
            },
        ],
        can_disable: true,
        history: true,
        live: true,
        search: true,
        quotes: true,
        docs_url: Some("https://kite.trade/docs/connect/v3/"),
    },
    ProviderSpec {
        id: "fyers",
        label: "FYERS",
        description: "Indian equities, indices, futures and commodities from your own FYERS API app: historical \
                      candles, and quotes that keep charts live. Free with a FYERS account (the Standard plan's \
                      limits are tight; Prime allows far more), and a fresh login each morning unless you let the \
                      app renew it with your PIN.",
        category: "broker",
        fields: &[
            FieldSpec {
                key: "appId",
                label: "App ID",
                secret: false,
                help: "From your app at myapi.fyers.in, like XXXXXXXXXX-100.",
                placeholder: "ABCD1234EF-100",
            },
            FieldSpec {
                key: "appSecret",
                label: "Secret ID",
                secret: true,
                help: "From the same app. Used only to log in from here; it never leaves this computer.",
                placeholder: "••••••••••",
            },
            FieldSpec {
                key: "accessToken",
                label: "Access token",
                secret: true,
                help: "Filled in for you when you log in below. FYERS tokens expire every morning at 6:30 AM.",
                placeholder: "set by logging in",
            },
        ],
        can_disable: true,
        history: true,
        live: true,
        search: true,
        quotes: true,
        docs_url: Some("https://fyers.in/api-docs/"),
    },
];

pub fn spec(id: &str) -> Option<&'static ProviderSpec> {
    PROVIDERS.iter().find(|p| p.id == id)
}

fn require_spec(id: &str) -> Result<&'static ProviderSpec, String> {
    spec(id).ok_or_else(|| format!("unknown data provider '{id}'"))
}

/// Whether a provider is switched on. Local providers default to on; broker
/// providers stay off until the user sets them up and turns them on.
fn is_enabled(conn: &Connection, spec: &ProviderSpec) -> rusqlite::Result<bool> {
    if !spec.can_disable {
        return Ok(true);
    }
    Ok(
        match settings::get(conn, Table::Settings, spec.id, ENABLED_KEY)?.as_deref() {
            Some("1") => true,
            Some("0") => false,
            _ => spec.category != "broker",
        },
    )
}

/// Trims what people paste: whitespace, newlines, wrapping quotes, and a
/// leading `Bearer ` from a copied Authorization header.
fn clean(value: &str) -> String {
    let v = value.trim().trim_matches(|c| c == '"' || c == '\'').trim();
    v.strip_prefix("Bearer ").unwrap_or(v).trim().to_string()
}

/// Whether a credential field is a secret; `None` for a field the provider doesn't have.
fn is_secret(provider: &str, key: &str) -> Option<bool> {
    spec(provider)
        .and_then(|s| s.fields.iter().find(|f| f.key == key))
        .map(|f| f.secret)
}

/// The current value of a credential field, secret or not.
pub fn credential(conn: &Connection, secrets: &Secrets, provider: &str, key: &str) -> rusqlite::Result<Option<String>> {
    match is_secret(provider, key) {
        Some(true) => secrets.get(conn, provider, key),
        _ => settings::get(conn, Table::Settings, provider, key),
    }
}

/// Whether a credential field has a value. Unlike [`credential`] it never copies a secret out.
fn has_credential(conn: &Connection, secrets: &Secrets, provider: &str, key: &str) -> rusqlite::Result<bool> {
    match is_secret(provider, key) {
        Some(true) => secrets.has(conn, provider, key),
        _ => Ok(settings::get(conn, Table::Settings, provider, key)?.is_some_and(|v| !v.is_empty())),
    }
}

pub fn describe(conn: &Connection, secrets: &Secrets) -> rusqlite::Result<Vec<ProviderInfo>> {
    let mut out = Vec::with_capacity(PROVIDERS.len());
    for spec in PROVIDERS {
        let mut fields = Vec::with_capacity(spec.fields.len());
        let mut storage: Option<Storage> = None;
        for f in spec.fields {
            let (value, is_set) = if f.secret {
                let stored = secrets.storage_of(conn, spec.id, f.key)?;
                if stored == Some(Storage::Database) || (stored.is_some() && storage.is_none()) {
                    storage = stored;
                }
                (None, stored.is_some())
            } else {
                let v = settings::get(conn, Table::Settings, spec.id, f.key)?;
                let set = v.as_deref().is_some_and(|s| !s.is_empty());
                (v, set)
            };
            fields.push(ProviderField {
                key: f.key.into(),
                label: f.label.into(),
                secret: f.secret,
                help: f.help.into(),
                placeholder: f.placeholder.into(),
                value,
                is_set,
            });
        }
        out.push(ProviderInfo {
            id: spec.id.into(),
            label: spec.label.into(),
            description: spec.description.into(),
            category: spec.category.into(),
            configured: fields.iter().all(|f| f.is_set),
            fields,
            enabled: is_enabled(conn, spec)?,
            can_disable: spec.can_disable,
            capabilities: ProviderCapabilities {
                history: spec.history,
                live: spec.live,
                search: spec.search,
                quotes: spec.quotes,
            },
            docs_url: spec.docs_url.map(str::to_string),
            secret_storage: storage.map(|s| s.as_str().to_string()),
        });
    }
    Ok(out)
}

/// Enabled and fully configured — what data code checks before using a provider.
pub fn is_usable(conn: &Connection, secrets: &Secrets, provider: &str) -> Result<bool, String> {
    let spec = require_spec(provider)?;
    let enabled = is_enabled(conn, spec).map_err(|e| e.to_string())?;
    for f in spec.fields {
        if !has_credential(conn, secrets, provider, f.key).map_err(|e| e.to_string())? {
            return Ok(false);
        }
    }
    Ok(enabled)
}

/// Saves the fields present in `values`. A blank secret means "leave it as it
/// is" (the settings form never has the old value to send back); a blank
/// non-secret clears it. Returns where a secret ended up, if one was written.
pub fn save_config(
    conn: &Connection,
    secrets: &Secrets,
    provider: &str,
    values: &HashMap<String, String>,
) -> Result<Option<Storage>, String> {
    let spec = require_spec(provider)?;
    for key in values.keys() {
        if !spec.fields.iter().any(|f| f.key == key) {
            return Err(format!("{} has no setting called '{key}'", spec.label));
        }
    }
    let mut storage = None;
    for f in spec.fields {
        let Some(raw) = values.get(f.key) else { continue };
        let value = clean(raw);
        if f.secret {
            if !value.is_empty() {
                storage = Some(secrets.set(conn, provider, f.key, &value).map_err(|e| e.to_string())?);
            }
        } else if value.is_empty() {
            settings::delete(conn, Table::Settings, provider, f.key).map_err(|e| e.to_string())?;
        } else {
            settings::set(conn, Table::Settings, provider, f.key, &value).map_err(|e| e.to_string())?;
        }
    }
    Ok(storage)
}

/// Forgets everything saved for a provider (credentials and settings), and
/// switches it off.
pub fn clear_config(conn: &Connection, secrets: &Secrets, provider: &str) -> Result<(), String> {
    let spec = require_spec(provider)?;
    for f in spec.fields {
        if f.secret {
            secrets.delete(conn, provider, f.key).map_err(|e| e.to_string())?;
        } else {
            settings::delete(conn, Table::Settings, provider, f.key).map_err(|e| e.to_string())?;
        }
    }
    if spec.can_disable {
        settings::set(conn, Table::Settings, provider, ENABLED_KEY, "0").map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn set_enabled(conn: &Connection, provider: &str, enabled: bool) -> Result<(), String> {
    let spec = require_spec(provider)?;
    if !spec.can_disable && !enabled {
        return Err(format!("{} can't be turned off", spec.label));
    }
    settings::set(
        conn,
        Table::Settings,
        provider,
        ENABLED_KEY,
        if enabled { "1" } else { "0" },
    )
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use crate::secrets::testing::MemoryKeychain;
    use std::sync::Arc;

    fn setup() -> (Database, Secrets) {
        (
            Database::open_in_memory().unwrap(),
            Secrets::new(Box::new(MemoryKeychain::default())),
        )
    }

    fn values(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    fn info(conn: &Connection, secrets: &Secrets, id: &str) -> ProviderInfo {
        describe(conn, secrets)
            .unwrap()
            .into_iter()
            .find(|p| p.id == id)
            .unwrap()
    }

    #[test]
    fn provider_ids_and_field_keys_are_unique() {
        let ids: std::collections::HashSet<_> = PROVIDERS.iter().map(|p| p.id).collect();
        assert_eq!(ids.len(), PROVIDERS.len());
        for p in PROVIDERS {
            let keys: std::collections::HashSet<_> = p.fields.iter().map(|f| f.key).collect();
            assert_eq!(keys.len(), p.fields.len(), "{}", p.id);
        }
    }

    #[test]
    fn local_providers_start_on_and_brokers_start_off() {
        let (db, secrets) = setup();
        let conn = db.conn.lock().unwrap();
        assert!(info(&conn, &secrets, "csv").enabled);
        let zerodha = info(&conn, &secrets, "zerodha");
        assert!(!zerodha.enabled);
        assert!(!zerodha.configured);
    }

    #[test]
    fn crypto_providers_are_not_data_sources() {
        for id in ["binance", "coinbase", "hyperliquid"] {
            assert!(
                spec(id).is_none(),
                "{id} was removed; nothing should serve or configure it"
            );
            let (db, secrets) = setup();
            let conn = db.conn.lock().unwrap();
            assert!(is_usable(&conn, &secrets, id).is_err());
            assert!(describe(&conn, &secrets).unwrap().iter().all(|p| p.id != id));
        }
    }

    #[test]
    fn saving_config_stores_secrets_apart_and_never_echoes_them() {
        let (db, secrets) = setup();
        let conn = db.conn.lock().unwrap();
        let storage = save_config(
            &conn,
            &secrets,
            "zerodha",
            &values(&[("apiKey", " a1b2c3 "), ("accessToken", "tok123")]),
        )
        .unwrap();
        assert_eq!(storage, Some(Storage::Keychain));

        let zerodha = info(&conn, &secrets, "zerodha");
        assert_eq!(zerodha.secret_storage.as_deref(), Some("keychain"));
        let key = zerodha.fields.iter().find(|f| f.key == "apiKey").unwrap();
        assert_eq!(key.value.as_deref(), Some("a1b2c3"), "trimmed");
        let token = zerodha.fields.iter().find(|f| f.key == "accessToken").unwrap();
        assert!(
            token.is_set && token.value.is_none(),
            "a secret is reported as set but never returned"
        );
        // The secret is in the credential store, not in the settings table.
        assert_eq!(
            settings::get(&conn, Table::Settings, "zerodha", "accessToken").unwrap(),
            None
        );
    }

    #[test]
    fn a_blank_secret_leaves_the_existing_one_alone() {
        let (db, secrets) = setup();
        let conn = db.conn.lock().unwrap();
        save_config(
            &conn,
            &secrets,
            "zerodha",
            &values(&[("apiKey", "1"), ("accessToken", "keep-me")]),
        )
        .unwrap();
        save_config(
            &conn,
            &secrets,
            "zerodha",
            &values(&[("apiKey", "2"), ("accessToken", "")]),
        )
        .unwrap();
        assert_eq!(
            credential(&conn, &secrets, "zerodha", "accessToken")
                .unwrap()
                .as_deref(),
            Some("keep-me")
        );
        assert_eq!(
            credential(&conn, &secrets, "zerodha", "apiKey").unwrap().as_deref(),
            Some("2")
        );
    }

    #[test]
    fn pasted_tokens_are_cleaned() {
        let (db, secrets) = setup();
        let conn = db.conn.lock().unwrap();
        save_config(
            &conn,
            &secrets,
            "zerodha",
            &values(&[("accessToken", "  \"Bearer abc.def.ghi\"\n")]),
        )
        .unwrap();
        assert_eq!(
            credential(&conn, &secrets, "zerodha", "accessToken")
                .unwrap()
                .as_deref(),
            Some("abc.def.ghi")
        );
    }

    #[test]
    fn unknown_providers_and_fields_are_rejected() {
        let (db, secrets) = setup();
        let conn = db.conn.lock().unwrap();
        assert!(save_config(&conn, &secrets, "nope", &values(&[])).is_err());
        assert!(save_config(&conn, &secrets, "zerodha", &values(&[("password", "x")])).is_err());
        assert!(set_enabled(&conn, "nope", true).is_err());
    }

    #[test]
    fn a_provider_is_usable_only_when_enabled_and_fully_configured() {
        let (db, secrets) = setup();
        let conn = db.conn.lock().unwrap();
        assert!(!is_usable(&conn, &secrets, "zerodha").unwrap());

        save_config(
            &conn,
            &secrets,
            "zerodha",
            &values(&[("apiKey", "1"), ("apiSecret", "s"), ("accessToken", "t")]),
        )
        .unwrap();
        assert!(
            !is_usable(&conn, &secrets, "zerodha").unwrap(),
            "configured but not switched on"
        );

        set_enabled(&conn, "zerodha", true).unwrap();
        assert!(is_usable(&conn, &secrets, "zerodha").unwrap());

        set_enabled(&conn, "zerodha", false).unwrap();
        assert!(!is_usable(&conn, &secrets, "zerodha").unwrap());
        assert!(
            is_usable(&conn, &secrets, "csv").unwrap(),
            "local providers need no setup"
        );
    }

    #[test]
    fn clearing_forgets_credentials_and_switches_the_provider_off() {
        let (db, secrets) = setup();
        let conn = db.conn.lock().unwrap();
        save_config(
            &conn,
            &secrets,
            "zerodha",
            &values(&[("apiKey", "1"), ("apiSecret", "s"), ("accessToken", "t")]),
        )
        .unwrap();
        set_enabled(&conn, "zerodha", true).unwrap();
        clear_config(&conn, &secrets, "zerodha").unwrap();

        let zerodha = info(&conn, &secrets, "zerodha");
        assert!(!zerodha.configured && !zerodha.enabled && zerodha.secret_storage.is_none());
        assert_eq!(credential(&conn, &secrets, "zerodha", "accessToken").unwrap(), None);
    }

    #[test]
    fn providers_that_cannot_be_disabled_stay_on() {
        let (db, _) = setup();
        let conn = db.conn.lock().unwrap();
        assert!(set_enabled(&conn, "csv", false).is_err());
    }

    /// A zerodha setup saved through one `Secrets`, then opened through a second one that
    /// remembers nothing, as after a launch. Returns the store so a test can count its reads.
    fn a_configured_zerodha() -> (Database, Arc<MemoryKeychain>, Secrets) {
        let db = Database::open_in_memory().unwrap();
        let store = Arc::new(MemoryKeychain::default());
        {
            let conn = db.conn.lock().unwrap();
            let saving = Secrets::new(Box::new(store.clone()));
            let all = values(&[("apiKey", "key"), ("apiSecret", "secret"), ("accessToken", "token")]);
            save_config(&conn, &saving, "zerodha", &all).unwrap();
            set_enabled(&conn, "zerodha", true).unwrap();
        }
        let secrets = Secrets::new(Box::new(store.clone()));
        (db, store, secrets)
    }

    #[test]
    fn a_hundred_requests_cost_two_keychain_reads_not_three_hundred() {
        // Every broker request checks the provider is usable and then reads its credentials;
        // that was three trips to the OS a request, 6,048 over one screen of the watchlist.
        let (db, store, secrets) = a_configured_zerodha();
        let conn = db.conn.lock().unwrap();
        for _ in 0..100 {
            assert!(is_usable(&conn, &secrets, "zerodha").unwrap());
            for key in ["apiKey", "apiSecret", "accessToken"] {
                assert!(credential(&conn, &secrets, "zerodha", key).unwrap().is_some());
            }
        }
        assert_eq!(store.reads(), 2, "one for each secret, ever after from memory");
    }

    #[test]
    fn turning_a_provider_off_takes_effect_at_once_even_with_credentials_remembered() {
        let (db, _store, secrets) = a_configured_zerodha();
        let conn = db.conn.lock().unwrap();
        assert!(is_usable(&conn, &secrets, "zerodha").unwrap());

        set_enabled(&conn, "zerodha", false).unwrap();
        assert!(!is_usable(&conn, &secrets, "zerodha").unwrap());
        set_enabled(&conn, "zerodha", true).unwrap();
        assert!(is_usable(&conn, &secrets, "zerodha").unwrap());
    }

    #[test]
    fn a_token_saved_after_the_daily_login_is_the_one_the_next_request_uses() {
        let (db, _store, secrets) = a_configured_zerodha();
        let conn = db.conn.lock().unwrap();
        let token = |secrets: &Secrets| credential(&conn, secrets, "zerodha", "accessToken").unwrap();
        assert_eq!(token(&secrets).as_deref(), Some("token"));

        save_config(&conn, &secrets, "zerodha", &values(&[("accessToken", "tomorrows")])).unwrap();
        assert_eq!(token(&secrets).as_deref(), Some("tomorrows"));
    }

    #[test]
    fn forgetting_a_providers_credentials_makes_it_unusable_at_once() {
        let (db, _store, secrets) = a_configured_zerodha();
        let conn = db.conn.lock().unwrap();
        assert!(is_usable(&conn, &secrets, "zerodha").unwrap());

        clear_config(&conn, &secrets, "zerodha").unwrap();
        assert!(!is_usable(&conn, &secrets, "zerodha").unwrap());
        assert_eq!(credential(&conn, &secrets, "zerodha", "accessToken").unwrap(), None);
    }
}
