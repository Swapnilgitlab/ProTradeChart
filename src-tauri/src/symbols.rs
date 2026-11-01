//! The Indian market's symbols: one namespace, whichever broker serves it.
//!
//! A symbol is `provider:TICKER`, and every Indian market symbol is `india:EXCHANGE:SYMBOL`
//! (`india:NSE:RELIANCE`). It never names a broker: which broker answers for it is a setting
//! ([`india_broker`]), so a watchlist, an alert, a drawing and a saved layout all survive a switch of
//! broker. `zerodha:` (the namespace's name while Zerodha was the only broker) and `fyers:` are read
//! as `india:` wherever a symbol comes in. Mirrors `src/lib/symbols.ts` and `protrade/api.py`.

use std::borrow::Cow;

use rusqlite::Connection;

use crate::providers;
use crate::secrets::Secrets;
use crate::store::preferences;

pub const INDIA: &str = "india";

/// Older spellings of [`INDIA`]: what symbols were saved under before it existed, and a broker's name
/// typed by hand.
const ALIASES: [&str; 2] = ["zerodha", "fyers"];

/// The providers a symbol can name.
const PROVIDERS: [&str; 2] = [INDIA, "csv"];

/// The longest symbol accepted from outside (a script, an import).
pub const MAX_SYMBOL_CHARS: usize = 64;

/// The namespace a provider prefix stands for: an old spelling of the Indian one reads as [`INDIA`],
/// any other prefix is returned as it was.
pub fn canonical_provider(provider: &str) -> &str {
    if provider.eq_ignore_ascii_case(INDIA) || ALIASES.iter().any(|a| provider.eq_ignore_ascii_case(a)) {
        INDIA
    } else {
        provider
    }
}

/// `symbol` with an old spelling of its prefix replaced (`zerodha:NSE:X` → `india:NSE:X`) and nothing
/// else changed. The same rule as `withCanonicalPrefix` and `canonical_symbol_prefix`.
pub fn with_canonical_prefix(symbol: &str) -> Cow<'_, str> {
    match symbol.split_once(':') {
        Some((prefix, rest)) if ALIASES.iter().any(|a| prefix.eq_ignore_ascii_case(a)) => {
            Cow::Owned(format!("{INDIA}:{rest}"))
        }
        _ => Cow::Borrowed(symbol),
    }
}

/// The canonical form of a symbol from outside the app, or `None` if it can't name anything the app
/// shows. An Indian ticker is upper-cased and, without an exchange, means NSE — as everywhere else in
/// the app (`normalizeSymbol`).
pub fn canonical_symbol(raw: &str) -> Option<String> {
    if raw.is_empty() || raw.len() > MAX_SYMBOL_CHARS || raw.chars().any(char::is_control) {
        return None;
    }
    let (provider, ticker) = raw.split_once(':')?;
    let provider = canonical_provider(provider.trim()).to_ascii_lowercase();
    let ticker = ticker.trim();
    if !PROVIDERS.contains(&provider.as_str()) || ticker.is_empty() {
        return None;
    }
    if provider == INDIA {
        let ticker = ticker.to_ascii_uppercase();
        let ticker = if ticker.contains(':') {
            ticker
        } else {
            format!("NSE:{ticker}")
        };
        return Some(format!("{provider}:{ticker}"));
    }
    Some(format!("{provider}:{ticker}"))
}

/// A broker that can serve `india:` symbols. Its id is what its settings and credentials are kept
/// under (`provider_settings`, the keychain), never a symbol prefix.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Broker {
    Zerodha,
    Fyers,
}

impl Broker {
    /// In order of preference when the user hasn't picked one and several are set up: Zerodha, the
    /// broker the app always had, first.
    pub const ALL: [Broker; 2] = [Broker::Zerodha, Broker::Fyers];

    pub fn id(self) -> &'static str {
        match self {
            Broker::Zerodha => "zerodha",
            Broker::Fyers => "fyers",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Broker::Zerodha => "Zerodha",
            Broker::Fyers => "FYERS",
        }
    }

    pub fn parse(id: &str) -> Option<Broker> {
        Broker::ALL.into_iter().find(|b| b.id().eq_ignore_ascii_case(id.trim()))
    }

    /// Its bit in a set of brokers (which brokers supplied a saved series' bars). Stored in the
    /// saved prices, so a broker's bit never changes.
    pub fn bit(self) -> u8 {
        match self {
            Broker::Zerodha => 1,
            Broker::Fyers => 2,
        }
    }
}

/// The preference naming the broker the user picked to serve `india:` symbols.
pub const SOURCE_PREF: &str = "india.source";

/// The broker the user picked, if they picked one the app still has.
pub fn chosen_broker(conn: &Connection) -> rusqlite::Result<Option<Broker>> {
    Ok(preferences::get(conn, SOURCE_PREF)?.as_deref().and_then(Broker::parse))
}

/// Which broker serves `india:` symbols: the one the user picked; otherwise the one that is set up
/// and switched on (the first in [`Broker::ALL`] when several are); otherwise the first. Never more
/// than one, and never a quiet switch to another when the picked one stops working: which broker
/// answers is the user's to say. The prices themselves don't depend on it (`store::bar_memory`).
pub fn india_broker(conn: &Connection, secrets: &Secrets) -> rusqlite::Result<Broker> {
    if let Some(chosen) = chosen_broker(conn)? {
        return Ok(chosen);
    }
    for broker in Broker::ALL {
        if providers::is_usable(conn, secrets, broker.id()).unwrap_or(false) {
            return Ok(broker);
        }
    }
    Ok(Broker::ALL[0])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_spellings_of_the_indian_namespace_read_as_india() {
        assert_eq!(canonical_provider("zerodha"), "india");
        assert_eq!(canonical_provider("FYERS"), "india");
        assert_eq!(canonical_provider("India"), "india");
        assert_eq!(canonical_provider("csv"), "csv");
        assert_eq!(with_canonical_prefix("zerodha:NSE:HFCL"), "india:NSE:HFCL");
        assert_eq!(with_canonical_prefix("Fyers:BSE:SBIN"), "india:BSE:SBIN");
        assert_eq!(
            with_canonical_prefix("india:hfcl"),
            "india:hfcl",
            "only the prefix changes"
        );
        assert_eq!(with_canonical_prefix("csv:ZERODHA"), "csv:ZERODHA");
        assert_eq!(with_canonical_prefix("RELIANCE"), "RELIANCE");
    }

    #[test]
    fn a_symbol_from_outside_is_made_canonical() {
        assert_eq!(canonical_symbol("zerodha:tcs").as_deref(), Some("india:NSE:TCS"));
        assert_eq!(canonical_symbol("india:bse:sbin").as_deref(), Some("india:BSE:SBIN"));
        assert_eq!(canonical_symbol("FYERS:NSE:INFY").as_deref(), Some("india:NSE:INFY"));
        assert_eq!(canonical_symbol("csv:My_Data").as_deref(), Some("csv:My_Data"));
        assert_eq!(canonical_symbol("binance:BTCUSDT"), None);
        assert_eq!(canonical_symbol("RELIANCE"), None, "a script names its provider");
        assert_eq!(canonical_symbol("india:"), None);
    }

    #[test]
    fn a_broker_is_parsed_by_its_settings_id() {
        assert_eq!(Broker::parse("zerodha"), Some(Broker::Zerodha));
        assert_eq!(Broker::parse(" Zerodha "), Some(Broker::Zerodha));
        assert_eq!(Broker::parse("FYERS"), Some(Broker::Fyers));
        assert_eq!(Broker::parse("india"), None, "a namespace is not a broker");
    }

    #[test]
    fn the_broker_picked_serves_india_and_otherwise_the_one_set_up() {
        use crate::db::Database;
        use crate::secrets::testing::MemoryKeychain;
        let db = Database::open_in_memory().unwrap();
        let secrets = Secrets::new(Box::new(MemoryKeychain::default()));
        let conn = db.conn.lock().unwrap();
        assert_eq!(
            india_broker(&conn, &secrets).unwrap(),
            Broker::Zerodha,
            "nothing set up"
        );
        preferences::set(&conn, SOURCE_PREF, "zerodha").unwrap();
        assert_eq!(chosen_broker(&conn).unwrap(), Some(Broker::Zerodha));
        preferences::set(&conn, SOURCE_PREF, "gone").unwrap();
        assert_eq!(
            chosen_broker(&conn).unwrap(),
            None,
            "a broker the app no longer has isn't a choice"
        );
    }
}
