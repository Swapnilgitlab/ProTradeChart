//! The catalogue of data providers, and their user-facing settings.
//!
//! This file is the single source of truth for what each provider is and what
//! it needs configured; the frontend renders its settings screen from
//! `describe()` rather than duplicating the field lists. To add a provider,
//! add a `ProviderSpec` here, implement its client beside `dhan/` and
//! `zerodha/`, and register a matching `DataProvider` on the TypeScript side.

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

/// What a user is shown, and agrees to, before a source whose data comes
/// under someone else's terms is switched on.
pub struct Terms {
    pub notice: &'static str,
    pub url: &'static str,
}

pub struct ProviderSpec {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    /// `free`, `broker` or `local`.
    pub category: &'static str,
    pub fields: &'static [FieldSpec],
    pub can_disable: bool,
    pub history: bool,
    pub live: bool,
    pub search: bool,
    pub quotes: bool,
    pub docs_url: Option<&'static str>,
    /// A provider with terms starts off: the user turns it on after reading them.
    pub terms: Option<Terms>,
}

pub const PROVIDERS: &[ProviderSpec] = &[
    ProviderSpec {
        id: "yahoo",
        label: "Yahoo Finance",
        description: "Stocks, ETFs, indices, FX and futures from most world exchanges, read from Yahoo Finance's \
                      public web endpoints. No account needed, but there is no official API behind them: prices \
                      can be delayed, and access can stop without notice.",
        category: "free",
        fields: &[],
        can_disable: true,
        history: true,
        live: true,
        search: true,
        quotes: true,
        docs_url: None,
        terms: Some(Terms {
            notice: "ProTradeChart is not affiliated with, endorsed by or sponsored by Yahoo. This source reads \
                     Yahoo Finance's public web endpoints directly from your computer; there is no official API \
                     or data licence behind them. Yahoo's terms of service govern that use, including their limits \
                     on automated access and on commercial use, so read them and decide for yourself. If you turn \
                     it on, use the data for your own information only: don't republish, resell or redistribute it.",
            url: "https://legal.yahoo.com/us/en/yahoo/terms/otos/index.html",
        }),
    },
    ProviderSpec {
        id: "binance",
        label: "Binance",
        description: "Spot and perpetual crypto with a live stream. Free, no account.",
        category: "free",
        fields: &[],
        can_disable: true,
        history: true,
        live: true,
        search: true,
        quotes: true,
        docs_url: None,
        terms: None,
    },
    ProviderSpec {
        id: "coinbase",
        label: "Coinbase",
        description: "Spot crypto with a live stream. Free, no account.",
        category: "free",
        fields: &[],
        can_disable: true,
        history: true,
        live: true,
        search: true,
        quotes: true,
        docs_url: None,
        terms: None,
    },
    ProviderSpec {
        id: "hyperliquid",
        label: "Hyperliquid",
        description: "Perpetual and spot crypto with a live stream. Free, no account.",
        category: "free",
        fields: &[],
        can_disable: true,
        history: true,
        live: true,
        search: true,
        quotes: true,
        docs_url: None,
        terms: None,
    },
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
        terms: None,
    },
    ProviderSpec {
        id: "dhan",
        label: "Dhan",
        description: "Indian equities, indices, futures and commodities from your own Dhan account: exchange \
                      historical data (up to 5 years intraday) and a live tick feed. Needs Dhan's paid Data API plan.",
        category: "broker",
        fields: &[
            FieldSpec {
                key: "clientId",
                label: "Client ID",
                secret: false,
                help: "Your Dhan client ID — shown on web.dhan.co under your profile.",
                placeholder: "1000000001",
            },
            FieldSpec {
                key: "accessToken",
                label: "Access token",
                secret: true,
                help: "Generate one at web.dhan.co → My Profile → Access DhanHQ APIs. Tokens last 24 hours; \
                       paste a new one when it expires, or use Renew.",
                placeholder: "eyJ0eXAiOiJKV1Qi…",
            },
        ],
        can_disable: true,
        history: true,
        live: true,
        search: true,
        quotes: true,
        docs_url: Some("https://dhanhq.co/docs/v2/"),
        terms: None,
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
        terms: None,
    },
];

pub fn spec(id: &str) -> Option<&'static ProviderSpec> {
    PROVIDERS.iter().find(|p| p.id == id)
}

fn require_spec(id: &str) -> Result<&'static ProviderSpec, String> {
    spec(id).ok_or_else(|| format!("unknown data provider '{id}'"))
}

/// Whether a provider is switched on. Free and local providers default to on;
/// broker providers, and any provider with terms to accept, stay off until the
/// user turns them on.
fn is_enabled(conn: &Connection, spec: &ProviderSpec) -> rusqlite::Result<bool> {
    if !spec.can_disable {
        return Ok(true);
    }
    Ok(
        match settings::get(conn, Table::Settings, spec.id, ENABLED_KEY)?.as_deref() {
            Some("1") => true,
            Some("0") => false,
            _ => spec.category != "broker" && spec.terms.is_none(),
        },
    )
}

/// Whether a provider is switched on — for data commands to check before they
/// touch the network, whatever the webview believes.
pub fn is_on(conn: &Connection, provider: &str) -> Result<bool, String> {
    is_enabled(conn, require_spec(provider)?).map_err(|e| e.to_string())
}

/// Trims what people paste: whitespace, newlines, wrapping quotes, and a
/// leading `Bearer ` from a copied Authorization header.
fn clean(value: &str) -> String {
    let v = value.trim().trim_matches(|c| c == '"' || c == '\'').trim();
    v.strip_prefix("Bearer ").unwrap_or(v).trim().to_string()
}

/// The current value of a credential field, secret or not.
pub fn credential(conn: &Connection, secrets: &Secrets, provider: &str, key: &str) -> rusqlite::Result<Option<String>> {
    let is_secret = spec(provider)
        .and_then(|s| s.fields.iter().find(|f| f.key == key))
        .map(|f| f.secret);
    match is_secret {
        Some(true) => secrets.get(conn, provider, key),
        _ => settings::get(conn, Table::Settings, provider, key),
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
            terms_notice: spec.terms.as_ref().map(|t| t.notice.to_string()),
            terms_url: spec.terms.as_ref().map(|t| t.url.to_string()),
        });
    }
    Ok(out)
}

/// Enabled and fully configured — what data code checks before using a provider.
pub fn is_usable(conn: &Connection, secrets: &Secrets, provider: &str) -> Result<bool, String> {
    let spec = require_spec(provider)?;
    let enabled = is_enabled(conn, spec).map_err(|e| e.to_string())?;
    for f in spec.fields {
        let present = credential(conn, secrets, provider, f.key).map_err(|e| e.to_string())?;
        if present.as_deref().is_none_or(str::is_empty) {
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
    fn free_providers_start_on_and_brokers_start_off() {
        let (db, secrets) = setup();
        let conn = db.conn.lock().unwrap();
        assert!(info(&conn, &secrets, "binance").enabled);
        assert!(info(&conn, &secrets, "csv").enabled);
        let dhan = info(&conn, &secrets, "dhan");
        assert!(!dhan.enabled);
        assert!(!dhan.configured);
    }

    #[test]
    fn yahoo_starts_off_until_its_terms_are_accepted() {
        let (db, secrets) = setup();
        let conn = db.conn.lock().unwrap();
        let yahoo = info(&conn, &secrets, "yahoo");
        assert!(!yahoo.enabled, "no request may reach Yahoo before the user turns it on");
        assert!(yahoo.configured, "nothing to fill in: turning it on is the only step");
        assert!(yahoo
            .terms_notice
            .as_deref()
            .is_some_and(|n| n.contains("not affiliated")));
        assert!(yahoo
            .terms_url
            .as_deref()
            .is_some_and(|u| u.starts_with("https://legal.yahoo.com/")));
        assert_eq!(is_on(&conn, "yahoo"), Ok(false));

        set_enabled(&conn, "yahoo", true).unwrap();
        assert_eq!(is_on(&conn, "yahoo"), Ok(true));
        assert!(is_usable(&conn, &secrets, "yahoo").unwrap());
        set_enabled(&conn, "yahoo", false).unwrap();
        assert_eq!(is_on(&conn, "yahoo"), Ok(false));
    }

    #[test]
    fn only_sources_with_terms_carry_a_notice() {
        let (db, secrets) = setup();
        let conn = db.conn.lock().unwrap();
        for p in describe(&conn, &secrets).unwrap() {
            assert_eq!(p.terms_notice.is_some(), p.terms_url.is_some(), "{}", p.id);
        }
        assert!(info(&conn, &secrets, "binance").terms_notice.is_none());
        assert!(is_on(&conn, "nope").is_err());
    }

    #[test]
    fn saving_config_stores_secrets_apart_and_never_echoes_them() {
        let (db, secrets) = setup();
        let conn = db.conn.lock().unwrap();
        let storage = save_config(
            &conn,
            &secrets,
            "dhan",
            &values(&[("clientId", " 1000000001 "), ("accessToken", "eyJ.tok.sig")]),
        )
        .unwrap();
        assert_eq!(storage, Some(Storage::Keychain));

        let dhan = info(&conn, &secrets, "dhan");
        assert!(dhan.configured);
        assert_eq!(dhan.secret_storage.as_deref(), Some("keychain"));
        let client = dhan.fields.iter().find(|f| f.key == "clientId").unwrap();
        assert_eq!(client.value.as_deref(), Some("1000000001"), "trimmed");
        let token = dhan.fields.iter().find(|f| f.key == "accessToken").unwrap();
        assert!(
            token.is_set && token.value.is_none(),
            "a secret is reported as set but never returned"
        );
        // The secret is in the credential store, not in the settings table.
        assert_eq!(
            settings::get(&conn, Table::Settings, "dhan", "accessToken").unwrap(),
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
            "dhan",
            &values(&[("clientId", "1"), ("accessToken", "keep-me")]),
        )
        .unwrap();
        save_config(
            &conn,
            &secrets,
            "dhan",
            &values(&[("clientId", "2"), ("accessToken", "")]),
        )
        .unwrap();
        assert_eq!(
            credential(&conn, &secrets, "dhan", "accessToken").unwrap().as_deref(),
            Some("keep-me")
        );
        assert_eq!(
            credential(&conn, &secrets, "dhan", "clientId").unwrap().as_deref(),
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
            "dhan",
            &values(&[("accessToken", "  \"Bearer abc.def.ghi\"\n")]),
        )
        .unwrap();
        assert_eq!(
            credential(&conn, &secrets, "dhan", "accessToken").unwrap().as_deref(),
            Some("abc.def.ghi")
        );
    }

    #[test]
    fn unknown_providers_and_fields_are_rejected() {
        let (db, secrets) = setup();
        let conn = db.conn.lock().unwrap();
        assert!(save_config(&conn, &secrets, "nope", &values(&[])).is_err());
        assert!(save_config(&conn, &secrets, "dhan", &values(&[("password", "x")])).is_err());
        assert!(set_enabled(&conn, "nope", true).is_err());
    }

    #[test]
    fn a_provider_is_usable_only_when_enabled_and_fully_configured() {
        let (db, secrets) = setup();
        let conn = db.conn.lock().unwrap();
        assert!(!is_usable(&conn, &secrets, "dhan").unwrap());

        save_config(
            &conn,
            &secrets,
            "dhan",
            &values(&[("clientId", "1"), ("accessToken", "t")]),
        )
        .unwrap();
        assert!(
            !is_usable(&conn, &secrets, "dhan").unwrap(),
            "configured but not switched on"
        );

        set_enabled(&conn, "dhan", true).unwrap();
        assert!(is_usable(&conn, &secrets, "dhan").unwrap());

        set_enabled(&conn, "dhan", false).unwrap();
        assert!(!is_usable(&conn, &secrets, "dhan").unwrap());
        assert!(
            is_usable(&conn, &secrets, "coinbase").unwrap(),
            "free providers need no setup"
        );
    }

    #[test]
    fn clearing_forgets_credentials_and_switches_the_provider_off() {
        let (db, secrets) = setup();
        let conn = db.conn.lock().unwrap();
        save_config(
            &conn,
            &secrets,
            "dhan",
            &values(&[("clientId", "1"), ("accessToken", "t")]),
        )
        .unwrap();
        set_enabled(&conn, "dhan", true).unwrap();
        clear_config(&conn, &secrets, "dhan").unwrap();

        let dhan = info(&conn, &secrets, "dhan");
        assert!(!dhan.configured && !dhan.enabled && dhan.secret_storage.is_none());
        assert_eq!(credential(&conn, &secrets, "dhan", "accessToken").unwrap(), None);
    }

    #[test]
    fn providers_that_cannot_be_disabled_stay_on() {
        let (db, _) = setup();
        let conn = db.conn.lock().unwrap();
        assert!(set_enabled(&conn, "csv", false).is_err());
    }
}
