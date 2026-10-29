//! FYERS's quotes, shared. A watchlist, the tabs, the alerts and every live chart all want prices,
//! and on the Standard plan FYERS allows 50 data requests a minute and 5,000 a day for everything
//! together. So every FYERS quote (but the Screener's whole-market snapshot, which wants the moment)
//! is answered from one cache: a symbol is asked for again only once its last answer is older than
//! the plan's freshness, and the stale symbols of one request go to FYERS in batches of 50.
//!
//! | Plan | while its exchange trades | otherwise |
//! | --- | --- | --- |
//! | Standard | 30 seconds | 15 minutes |
//! | Prime | 3 seconds | 5 minutes |
//!
//! A 100-symbol watchlist is then about six requests a minute on Standard while the market is open.
//! The cache holds the last quote of each symbol for the session only; it is never written to disk.

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

use super::client::FyersClient;
use super::protocol::{FyersError, Plan, QuoteTick};
use crate::db::now_ms;
use crate::market::is_trading;
use crate::models::Quote;
use crate::store::instrument_list::Instrument;

/// How long a quote stays fresh enough to answer with.
pub fn freshness_ms(plan: Plan, trading: bool) -> i64 {
    match (plan, trading) {
        (Plan::Standard, true) => 30_000,
        (Plan::Standard, false) => 15 * 60_000,
        (Plan::Prime, true) => 3_000,
        (Plan::Prime, false) => 5 * 60_000,
    }
}

#[derive(Debug, Clone)]
struct Entry {
    quote: Quote,
    tick: Option<QuoteTick>,
    at_ms: i64,
}

/// Tauri state: the last answer for each FYERS symbol.
#[derive(Default)]
pub struct QuoteCache {
    entries: Mutex<HashMap<String, Entry>>,
}

impl QuoteCache {
    /// The instruments whose cached answer is missing or older than their freshness.
    fn stale<'a>(&self, instruments: &'a [Instrument], plan: Plan, now_ms: i64) -> Vec<&'a Instrument> {
        let Ok(entries) = self.entries.lock() else {
            return instruments.iter().collect();
        };
        instruments
            .iter()
            .filter(|i| {
                let fresh = freshness_ms(plan, is_trading(&i.exchange, now_ms));
                entries.get(&i.symbol).is_none_or(|e| now_ms - e.at_ms >= fresh)
            })
            .collect()
    }

    fn store(&self, answers: impl IntoIterator<Item = (String, Quote, Option<QuoteTick>)>, now_ms: i64) {
        if let Ok(mut entries) = self.entries.lock() {
            for (symbol, quote, tick) in answers {
                entries.insert(
                    symbol,
                    Entry {
                        quote,
                        tick,
                        at_ms: now_ms,
                    },
                );
            }
        }
    }

    fn get(&self, symbol: &str) -> Option<Entry> {
        self.entries.lock().ok()?.get(symbol).cloned()
    }

    /// Forgets everything: another broker serves `india:` now, or the user logged in again.
    pub fn clear(&self) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.clear();
        }
    }
}

/// Asks FYERS for whatever of `instruments` the cache can't answer, and stores the answers.
async fn refresh(app: &AppHandle, instruments: &[Instrument]) -> Result<(), FyersError> {
    let cache = app.state::<QuoteCache>();
    let client = app.state::<FyersClient>();
    let client = client.inner();
    let now = now_ms();
    let stale: Vec<Instrument> = cache
        .stale(instruments, client.plan(), now)
        .into_iter()
        .cloned()
        .collect();
    if stale.is_empty() {
        return Ok(());
    }
    let stale = &stale;
    let answers =
        crate::fyers_commands::with_credentials(
            app,
            |creds| async move { client.quotes_and_ticks(&creds, stale).await },
        )
        .await?;
    cache.store(
        stale
            .iter()
            .zip(answers)
            .map(|(i, (quote, tick))| (i.symbol.clone(), quote, tick)),
        now_ms(),
    );
    Ok(())
}

/// One quote per instrument, in order, named by the app's ticker.
pub async fn cached_quotes(app: &AppHandle, instruments: &[Instrument]) -> Result<Vec<Quote>, FyersError> {
    refresh(app, instruments).await?;
    let cache = app.state::<QuoteCache>();
    Ok(instruments
        .iter()
        .map(|i| {
            cache.get(&i.symbol).map(|e| e.quote).unwrap_or(Quote {
                symbol: i.ticker.clone(),
                price: None,
                previous_close: None,
                change_percent: None,
                currency: None,
                error: Some("FYERS has no quote for it".into()),
            })
        })
        .collect())
}

/// One tick per instrument, `None` for one FYERS has no price for.
pub async fn cached_ticks(app: &AppHandle, instruments: &[Instrument]) -> Result<Vec<Option<QuoteTick>>, FyersError> {
    refresh(app, instruments).await?;
    let cache = app.state::<QuoteCache>();
    Ok(instruments
        .iter()
        .map(|i| cache.get(&i.symbol).and_then(|e| e.tick))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inst(symbol: &str, exchange: &str) -> Instrument {
        Instrument {
            ticker: symbol.into(),
            exchange: exchange.into(),
            token: 1,
            instrument: "EQUITY".into(),
            symbol: symbol.into(),
            name: None,
            expiry: None,
        }
    }

    fn quote(symbol: &str) -> Quote {
        Quote {
            symbol: symbol.into(),
            price: Some(1.0),
            previous_close: None,
            change_percent: None,
            currency: None,
            error: None,
        }
    }

    /// 2026-10-16 (a Friday) 11:00 IST, and 20:00 IST the same evening.
    const MORNING: i64 = 1_792_128_600_000;
    const EVENING: i64 = MORNING + 9 * 3_600_000;

    #[test]
    fn a_quote_is_asked_again_only_once_it_is_older_than_the_plans_freshness() {
        let cache = QuoteCache::default();
        let asked = [inst("NSE:A-EQ", "NSE"), inst("NSE:B-EQ", "NSE")];
        assert_eq!(
            cache.stale(&asked, Plan::Standard, MORNING).len(),
            2,
            "nothing cached yet"
        );
        cache.store([("NSE:A-EQ".to_string(), quote("A"), None)], MORNING);
        let stale = cache.stale(&asked, Plan::Standard, MORNING + 10_000);
        assert_eq!(
            stale.iter().map(|i| i.symbol.as_str()).collect::<Vec<_>>(),
            ["NSE:B-EQ"]
        );
        assert_eq!(
            cache.stale(&asked, Plan::Standard, MORNING + 30_000).len(),
            2,
            "30 s on Standard"
        );
        assert_eq!(
            cache.stale(&asked[..1], Plan::Prime, MORNING + 3_000).len(),
            1,
            "3 s on Prime"
        );
    }

    #[test]
    fn after_the_close_a_quote_lasts_longer_except_on_mcx_which_trades_into_the_night() {
        let cache = QuoteCache::default();
        let (nse, mcx) = (inst("NSE:A-EQ", "NSE"), inst("MCX:CRUDE", "MCX"));
        cache.store(
            [
                ("NSE:A-EQ".to_string(), quote("A"), None),
                ("MCX:CRUDE".to_string(), quote("C"), None),
            ],
            EVENING,
        );
        assert!(cache
            .stale(std::slice::from_ref(&nse), Plan::Standard, EVENING + 60_000)
            .is_empty());
        assert_eq!(
            cache
                .stale(std::slice::from_ref(&mcx), Plan::Standard, EVENING + 60_000)
                .len(),
            1
        );
        cache.clear();
        assert_eq!(cache.stale(&[nse], Plan::Standard, EVENING).len(), 1);
    }
}
