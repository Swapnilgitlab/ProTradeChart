//! The real [`Backend`], bound to the app's managed state.
//!
//! The logic worth testing is in free functions over a `&Connection` or in pure error
//! mappings; the [`AppBackend`] methods only take the lock and delegate. Credentials are
//! read here, in Rust, exactly as the charts' commands read them, and never leave: a
//! broker's error text is passed on, the token itself is not.

use futures::future::BoxFuture;
use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::data::{
    self, BarsData, BarsRequest, Fetched, Fetcher, PanelRequest, PanelSeries, SyncReport, SyncRequest, DEFAULT_LIMIT,
    MAX_LIMIT,
};
use super::routes::{Backend, InstrumentQuery, WatchlistSel};
use super::wire::{
    InstrumentRow, ProviderStatus, ResultPost, WatchlistContent, WatchlistInfo, WatchlistSymbol, WatchlistSync,
    WatchlistUpdate,
};
use super::{split_symbol, ApiError};
use crate::db::{now_ms, Database, ResearchDb};
use crate::models::DaySnapshot;
use crate::providers;
use crate::secrets::Secrets;
use crate::store::instrument_list::{self, Source};
use crate::store::research_bars::canonical_interval;
use crate::store::{datasets, watchlists};
use crate::zerodha::client::ZerodhaClient;
use crate::zerodha::instruments as zerodha_instruments;
use crate::zerodha::protocol::{
    plan_windows as kite_windows, Interval as KiteInterval, ZerodhaError, ZerodhaErrorKind,
};
use crate::zerodha_commands::zerodha_credentials;

/// Tells every window a watchlist was written from outside its panel; the payload is its id.
pub const WATCHLISTS_CHANGED: &str = "watchlists-changed";

/// The `python-result` event: something a script asked the app to show. `data` is passed on
/// untouched; the webview validates its shape before drawing.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResultEvent {
    run_id: String,
    kind: String,
    title: Option<String>,
    data: serde_json::Value,
}

pub struct AppBackend {
    app: AppHandle,
}

impl AppBackend {
    pub fn new(app: AppHandle) -> Self {
        AppBackend { app }
    }

    fn with_conn<T>(&self, f: impl FnOnce(&Connection) -> Result<T, ApiError>) -> Result<T, ApiError> {
        let db = self.app.state::<Database>();
        let conn = db.conn.lock().map_err(|e| ApiError::internal(e.to_string()))?;
        f(&conn)
    }
}

// ---- Errors ------------------------------------------------------------------

/// Maps a Kite failure onto the API's codes. `auth` is the one a script most often meets:
/// Kite tokens expire every morning.
pub fn zerodha_error(e: ZerodhaError) -> ApiError {
    let (status, code) = match e.kind {
        ZerodhaErrorKind::NotConfigured => (409, "not_configured"),
        ZerodhaErrorKind::Token => (401, "auth"),
        ZerodhaErrorKind::Permission => (403, "no_access"),
        ZerodhaErrorKind::RateLimited => (429, "rate_limited"),
        ZerodhaErrorKind::BadRequest => (400, "bad_request"),
        ZerodhaErrorKind::Network | ZerodhaErrorKind::Server | ZerodhaErrorKind::Other => (502, "upstream"),
    };
    ApiError::new(status, code, e.message())
}

fn unsupported_provider(provider: &str) -> ApiError {
    ApiError::bad_request(format!(
        "Python can't read '{provider}' data. Supported: zerodha and csv (your imported files)."
    ))
}

// ---- Logic over a connection ----------------------------------------------------

/// A CSV dataset is served as it was imported: no broker, no store, no resampling.
pub fn csv_bars(conn: &Connection, ticker: &str, req: &BarsRequest) -> Result<BarsData, ApiError> {
    let newest = match (req.limit, req.from_ms) {
        (Some(n), _) => n,
        (None, None) => DEFAULT_LIMIT,
        (None, Some(_)) => MAX_LIMIT,
    };
    let found = datasets::bars(conn, ticker, req.from_ms, req.to_ms, Some(newest))?
        .ok_or_else(|| ApiError::not_found(format!("There is no imported dataset called '{ticker}'.")))?;
    let stored = canonical_interval(&found.base_tf).unwrap_or_else(|| found.base_tf.to_uppercase());
    if stored != req.interval {
        return Err(ApiError::bad_request(format!(
            "'{ticker}' was imported as {} bars. Ask for that interval and resample in pandas.",
            found.base_tf
        )));
    }
    let first = found.bars.first().map(|b| b.time);
    let last = found.bars.last().map(|b| b.time);
    Ok(BarsData {
        covered_from_ms: first.or(req.from_ms).unwrap_or(0),
        covered_to_ms: last.or(req.to_ms).unwrap_or(0),
        bars: found.bars,
        // An imported file carries no exchange, so its times are read as UTC.
        timezone: "UTC".to_string(),
        limited_from_ms: None,
    })
}

/// `FUTIDX`, `FUTSTK`, … are all just futures to a script.
fn kind_of(instrument: &str) -> String {
    let upper = instrument.to_uppercase();
    if upper.starts_with("FUT") {
        "FUT".to_string()
    } else {
        upper
    }
}

pub fn list_instruments(conn: &Connection, q: &InstrumentQuery) -> Result<Vec<InstrumentRow>, ApiError> {
    let source = Source::parse(&q.provider)
        .ok_or_else(|| ApiError::bad_request(format!("'{}' has no instrument list. Ask for zerodha.", q.provider)))?;
    Ok(instrument_list::list(conn, source, &q.filter, q.limit)?
        .into_iter()
        .map(|i| InstrumentRow {
            symbol: format!("{}:{}", q.provider, i.ticker),
            name: i.name,
            exchange: i.exchange,
            kind: kind_of(&i.instrument),
            expiry: i.expiry,
        })
        .collect())
}

pub fn watchlist_infos(conn: &Connection) -> Result<Vec<WatchlistInfo>, ApiError> {
    Ok(watchlists::list(conn)?
        .into_iter()
        .map(|w| WatchlistInfo {
            id: w.id,
            name: w.name,
            count: w.item_count,
        })
        .collect())
}

/// "Your watchlists: A, B, C." — so a script that asked for the wrong name is told the right ones.
fn which_watchlists(all: &[crate::models::WatchlistSummary]) -> String {
    const SHOWN: usize = 10;
    if all.is_empty() {
        return "You have no watchlists yet; make one in the app.".to_string();
    }
    let names: Vec<&str> = all.iter().take(SHOWN).map(|w| w.name.as_str()).collect();
    let more = if all.len() > SHOWN { ", …" } else { "" };
    format!("Your watchlists: {}{more}.", names.join(", "))
}

pub fn watchlist_content(conn: &Connection, which: &WatchlistSel) -> Result<WatchlistContent, ApiError> {
    let id = match which {
        WatchlistSel::Id(id) => *id,
        WatchlistSel::Name(name) => {
            let all = watchlists::list(conn)?;
            match all.iter().find(|w| w.name.trim().eq_ignore_ascii_case(name.trim())) {
                Some(found) => found.id,
                None => {
                    return Err(ApiError::not_found(format!(
                        "There is no watchlist called '{name}'. {}",
                        which_watchlists(&all)
                    )))
                }
            }
        }
    };
    let detail =
        watchlists::get(conn, id)?.ok_or_else(|| ApiError::not_found(format!("There is no watchlist #{id}.")))?;
    Ok(WatchlistContent {
        id: detail.id,
        name: detail.name,
        symbols: detail
            .items
            .into_iter()
            .map(|i| WatchlistSymbol {
                symbol: i.symbol,
                name: i.name,
            })
            .collect(),
    })
}

// ---- The trait -------------------------------------------------------------------

impl Backend for AppBackend {
    fn providers(&self) -> Result<Vec<ProviderStatus>, ApiError> {
        let db = self.app.state::<Database>();
        let secrets = self.app.state::<Secrets>();
        let conn = db.conn.lock().map_err(|e| ApiError::internal(e.to_string()))?;
        let usable = |id: &str| providers::is_usable(&conn, &secrets, id).unwrap_or(false);
        Ok(vec![
            ProviderStatus {
                id: "zerodha",
                label: "Zerodha",
                usable: usable("zerodha"),
            },
            ProviderStatus {
                id: "csv",
                label: "Imported files",
                usable: true,
            },
        ])
    }

    fn instruments(&self, query: &InstrumentQuery) -> Result<Vec<InstrumentRow>, ApiError> {
        self.with_conn(|conn| list_instruments(conn, query))
    }

    fn watchlists(&self) -> Result<Vec<WatchlistInfo>, ApiError> {
        self.with_conn(watchlist_infos)
    }

    fn watchlist(&self, which: &WatchlistSel) -> Result<WatchlistContent, ApiError> {
        self.with_conn(|conn| watchlist_content(conn, which))
    }

    fn publish(&self, post: ResultPost) -> Result<(), ApiError> {
        self.app
            .emit(
                "python-result",
                ResultEvent {
                    run_id: post.run_id,
                    kind: post.kind,
                    title: post.title,
                    data: post.data,
                },
            )
            .map_err(|e| ApiError::internal(format!("couldn't show the result: {e}")))
    }

    fn set_watchlist(&self, update: WatchlistUpdate) -> Result<WatchlistSync, ApiError> {
        let synced = {
            let db = self.app.state::<Database>();
            let mut conn = db.conn.lock().map_err(|e| ApiError::internal(e.to_string()))?;
            watchlists::sync_named(&mut conn, &update.name, &update.symbols, update.replace)
                .map_err(|e| ApiError::internal(format!("couldn't write the watchlist: {e}")))?
        };
        // Every window's watchlist panel reads its lists again.
        let _ = self.app.emit(WATCHLISTS_CHANGED, synced.id);
        Ok(WatchlistSync {
            name: update.name,
            created: synced.created,
            added: synced.added,
            removed: synced.removed,
            total: synced.total,
        })
    }

    fn bars<'a>(&'a self, request: BarsRequest) -> BoxFuture<'a, Result<BarsData, ApiError>> {
        Box::pin(async move {
            let (provider, ticker) = split_symbol(&request.symbol)
                .ok_or_else(|| ApiError::bad_request("a symbol looks like zerodha:NSE:RELIANCE"))?;
            match provider {
                "csv" => self.with_conn(|conn| csv_bars(conn, ticker, &request)),
                "zerodha" => {
                    let research = self.app.state::<ResearchDb>();
                    data::load_bars(&research.write, self, &request, now_ms()).await
                }
                other => Err(unsupported_provider(other)),
            }
        })
    }

    fn sync_bars<'a>(&'a self, request: SyncRequest) -> BoxFuture<'a, Result<SyncReport, ApiError>> {
        Box::pin(async move {
            let research = self.app.state::<ResearchDb>();
            Ok(data::sync_daily(&research.write, self, &request, now_ms()).await)
        })
    }

    fn panel<'a>(&'a self, request: PanelRequest) -> BoxFuture<'a, Result<Vec<PanelSeries>, ApiError>> {
        let app = self.app.clone();
        Box::pin(async move {
            // A whole market's history is a second or so of reading: off the async threads.
            tauri::async_runtime::spawn_blocking(move || {
                let research = app.state::<ResearchDb>();
                let conn = research
                    .read
                    .conn
                    .lock()
                    .map_err(|e| ApiError::internal(e.to_string()))?;
                data::read_panel(&conn, &request, now_ms())
            })
            .await
            .map_err(|e| ApiError::internal(e.to_string()))?
        })
    }
}

impl data::Snapshots for AppBackend {
    fn snapshots<'a>(
        &'a self,
        provider: &'a str,
        tickers: &'a [String],
    ) -> BoxFuture<'a, Result<Vec<Option<DaySnapshot>>, ApiError>> {
        Box::pin(async move {
            match provider {
                "zerodha" => self.zerodha_day_snapshots(tickers).await,
                other => Err(unsupported_provider(other)),
            }
        })
    }
}

impl Fetcher for AppBackend {
    fn fetch<'a>(
        &'a self,
        symbol: &'a str,
        interval: &'a str,
        from_ms: i64,
        to_ms: i64,
    ) -> BoxFuture<'a, Result<Fetched, ApiError>> {
        Box::pin(async move {
            let (provider, ticker) = split_symbol(symbol)
                .ok_or_else(|| ApiError::bad_request("a symbol looks like zerodha:NSE:RELIANCE"))?;
            match provider {
                "zerodha" => self.fetch_zerodha(ticker, interval, from_ms, to_ms).await,
                other => Err(unsupported_provider(other)),
            }
        })
    }
}

impl AppBackend {
    async fn fetch_zerodha(&self, ticker: &str, interval: &str, from_ms: i64, to_ms: i64) -> Result<Fetched, ApiError> {
        let kind = KiteInterval::parse(interval).ok_or_else(|| {
            ApiError::bad_request(format!(
                "Zerodha doesn't serve a '{interval}' interval. It serves D and 1, 3, 5, 10, 15, 30 or 60 minutes; \
                 resample the rest in pandas."
            ))
        })?;
        let db = self.app.state::<Database>();
        let secrets = self.app.state::<Secrets>();
        let client = self.app.state::<ZerodhaClient>();
        let (creds, inst) = {
            let conn = db.conn.lock().map_err(|e| ApiError::internal(e.to_string()))?;
            let creds = zerodha_credentials(&conn, &secrets).map_err(zerodha_error)?;
            let inst = zerodha_instruments::resolve(&conn, ticker)?.ok_or_else(|| {
                ApiError::not_found(format!(
                    "Zerodha has no instrument called '{ticker}'. Search with pt.instruments(), or update the \
                     instrument list in Data providers."
                ))
            })?;
            (creds, inst)
        };
        let now = now_ms();
        // The client answers a span longer than one call may cover with only its newest part.
        let began = kite_windows(kind, Some(from_ms), Some(to_ms), now)
            .first()
            .map_or(from_ms, |w| w.from_ms.max(from_ms));
        let bars = client
            .fetch_history(&creds, &inst, kind, Some(from_ms), Some(to_ms), now)
            .await
            .map_err(zerodha_error)?;
        Ok(Fetched { bars, from_ms: began })
    }

    /// `tickers` not in the instrument list come back `None`, same as a ticker the broker itself
    /// had nothing for — `day_topup`'s caller treats both as "fall back to the historical read."
    async fn zerodha_day_snapshots(&self, tickers: &[String]) -> Result<Vec<Option<DaySnapshot>>, ApiError> {
        let db = self.app.state::<Database>();
        let secrets = self.app.state::<Secrets>();
        let client = self.app.state::<ZerodhaClient>();
        let (creds, resolved) = {
            let conn = db.conn.lock().map_err(|e| ApiError::internal(e.to_string()))?;
            let creds = zerodha_credentials(&conn, &secrets).map_err(zerodha_error)?;
            let resolved: Vec<Option<zerodha_instruments::Instrument>> = tickers
                .iter()
                .map(|t| zerodha_instruments::resolve(&conn, t))
                .collect::<rusqlite::Result<_>>()
                .map_err(|e| ApiError::internal(e.to_string()))?;
            (creds, resolved)
        };
        let (known_idx, known): (Vec<usize>, Vec<zerodha_instruments::Instrument>) = resolved
            .into_iter()
            .enumerate()
            .filter_map(|(i, inst)| inst.map(|inst| (i, inst)))
            .unzip();
        let mut out = vec![None; tickers.len()];
        if !known.is_empty() {
            let snapshots = client.day_snapshots(&creds, &known).await.map_err(zerodha_error)?;
            for (i, snapshot) in known_idx.into_iter().zip(snapshots) {
                out[i] = snapshot;
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Bar, DatasetInput, NewWatchlistItem};
    use crate::store::instrument_list::Filter;

    fn err(status: u16, code: &str, e: ApiError) {
        assert_eq!((e.status, e.code), (status, code), "{}", e.message);
    }

    #[test]
    fn kite_failures_map_to_the_codes_a_script_can_act_on() {
        let map = |kind, detail: &str| zerodha_error(ZerodhaError::new(kind, detail));
        err(409, "not_configured", zerodha_error(ZerodhaError::not_configured()));
        err(401, "auth", map(ZerodhaErrorKind::Token, ""));
        err(
            403,
            "no_access",
            map(ZerodhaErrorKind::Permission, "Insufficient permission"),
        );
        err(429, "rate_limited", map(ZerodhaErrorKind::RateLimited, ""));
        err(400, "bad_request", map(ZerodhaErrorKind::BadRequest, "bad dates"));
        for kind in [
            ZerodhaErrorKind::Network,
            ZerodhaErrorKind::Server,
            ZerodhaErrorKind::Other,
        ] {
            err(502, "upstream", map(kind, "boom"));
        }
    }

    #[test]
    fn a_rejected_kite_token_says_to_log_in_again() {
        let e = zerodha_error(ZerodhaError::new(ZerodhaErrorKind::Token, ""));
        assert!(e.message.contains("log in again"), "{}", e.message);
    }

    #[test]
    fn no_error_message_carries_a_credential() {
        // The messages are the brokers' own words about what went wrong; the clients never
        // put the key or token into an error, and this pins that the mapping adds nothing.
        let e = zerodha_error(ZerodhaError::new(ZerodhaErrorKind::Other, "Something failed"));
        assert!(!e.message.contains("token abc123:"), "{}", e.message);
    }

    #[test]
    fn a_provider_that_python_cannot_read_is_named() {
        let e = unsupported_provider("binance");
        assert_eq!(e.status, 400);
        assert!(
            e.message.contains("binance") && e.message.contains("zerodha"),
            "{}",
            e.message
        );
    }

    #[test]
    fn futures_of_every_kind_are_just_fut() {
        assert_eq!(kind_of("FUTIDX"), "FUT");
        assert_eq!(kind_of("futstk"), "FUT");
        assert_eq!(kind_of("FUT"), "FUT");
        assert_eq!(kind_of("equity"), "EQUITY");
        assert_eq!(kind_of("INDEX"), "INDEX");
    }

    // ---- Over a database -----------------------------------------------------

    fn dataset(conn: &mut Connection, ticker: &str, base_tf: &str, times: &[i64]) {
        datasets::save(
            conn,
            &DatasetInput {
                ticker: ticker.into(),
                description: None,
                base_tf: base_tf.into(),
                bars: times
                    .iter()
                    .map(|t| Bar {
                        time: *t,
                        open: 1.0,
                        high: 2.0,
                        low: 0.5,
                        close: 1.5,
                        volume: Some(3.0),
                    })
                    .collect(),
            },
        )
        .unwrap();
    }

    fn csv_request(interval: &str, from: Option<i64>, limit: Option<usize>) -> BarsRequest {
        BarsRequest {
            symbol: "csv:MY_DATA".into(),
            interval: interval.into(),
            from_ms: from,
            to_ms: None,
            limit,
        }
    }

    #[test]
    fn a_csv_dataset_is_served_as_imported() {
        let db = Database::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        dataset(&mut conn, "MY_DATA", "D", &[1_000, 2_000, 3_000]);

        let out = csv_bars(&conn, "MY_DATA", &csv_request("D", None, None)).unwrap();
        assert_eq!(
            out.bars.iter().map(|b| b.time).collect::<Vec<_>>(),
            [1_000, 2_000, 3_000]
        );
        assert_eq!((out.covered_from_ms, out.covered_to_ms), (1_000, 3_000));
        assert_eq!(out.timezone, "UTC");
        assert_eq!(out.limited_from_ms, None);

        let newest = csv_bars(&conn, "my_data", &csv_request("D", None, Some(2))).unwrap();
        assert_eq!(newest.bars.iter().map(|b| b.time).collect::<Vec<_>>(), [2_000, 3_000]);
        let from = csv_bars(&conn, "MY_DATA", &csv_request("D", Some(2_000), None)).unwrap();
        assert_eq!(from.bars.len(), 2);
    }

    #[test]
    fn a_csv_dataset_is_asked_for_at_its_own_interval() {
        let db = Database::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        dataset(&mut conn, "MY_DATA", "5", &[1_000]);
        err(
            400,
            "bad_request",
            csv_bars(&conn, "MY_DATA", &csv_request("D", None, None)).unwrap_err(),
        );
        assert!(csv_bars(&conn, "MY_DATA", &csv_request("5", None, None)).is_ok());
    }

    #[test]
    fn a_dataset_that_does_not_exist_is_not_found() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        err(
            404,
            "not_found",
            csv_bars(&conn, "NOPE", &csv_request("D", None, None)).unwrap_err(),
        );
    }

    #[test]
    fn instruments_come_back_as_chart_symbols_with_normalised_kinds() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        conn.execute_batch(
            "INSERT INTO zerodha_instruments (ticker, exchange, token, instrument, symbol, name, expiry)
               VALUES ('NSE:INFY','NSE',1,'EQUITY','INFY','Infosys',NULL),
                      ('NFO:NIFTY26SEPFUT','NFO',2,'FUT','NIFTY26SEPFUT','NIFTY','2026-09-29');",
        )
        .unwrap();
        let q = |provider: &str, kind: Option<&str>| InstrumentQuery {
            provider: provider.into(),
            filter: Filter {
                kind: kind.map(str::to_string),
                ..Filter::default()
            },
            limit: 100,
        };

        let all = list_instruments(&conn, &q("zerodha", None)).unwrap();
        assert_eq!(all.len(), 2);
        let infy = all.iter().find(|r| r.symbol == "zerodha:NSE:INFY").unwrap();
        assert_eq!((infy.kind.as_str(), infy.name.as_deref()), ("EQUITY", Some("Infosys")));

        let futures = list_instruments(&conn, &q("zerodha", Some("FUT"))).unwrap();
        assert_eq!(futures.len(), 1);
        assert_eq!(futures[0].kind, "FUT");
        assert_eq!(futures[0].expiry.as_deref(), Some("2026-09-29"));

        for retired_or_unknown in ["binance", "nosuch"] {
            err(
                400,
                "bad_request",
                list_instruments(&conn, &q(retired_or_unknown, None)).unwrap_err(),
            );
        }
    }

    #[test]
    fn a_missing_watchlist_with_no_lists_at_all_says_to_make_one() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        let e = watchlist_content(&conn, &WatchlistSel::Name("Nifty 50".into())).unwrap_err();
        assert!(e.message.contains("no watchlists yet"), "{}", e.message);
    }

    #[test]
    fn the_watchlists_named_in_that_message_are_capped() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        for i in 0..14 {
            watchlists::create(&conn, &format!("List {i}")).unwrap();
        }
        let e = watchlist_content(&conn, &WatchlistSel::Name("Nope".into())).unwrap_err();
        assert!(
            e.message.contains("List 0") && e.message.contains("List 9"),
            "{}",
            e.message
        );
        assert!(
            !e.message.contains("List 13") && e.message.contains('…'),
            "{}",
            e.message
        );
    }

    #[test]
    fn a_watchlist_is_found_by_name_without_regard_to_case_or_by_id() {
        let db = Database::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        let id = watchlists::create(&conn, "Nifty 50").unwrap();
        watchlists::add_items(
            &mut conn,
            id,
            &[
                NewWatchlistItem {
                    symbol: "zerodha:NSE:RELIANCE".into(),
                    name: Some("Reliance".into()),
                },
                NewWatchlistItem {
                    symbol: "zerodha:NSE:TCS".into(),
                    name: None,
                },
            ],
        )
        .unwrap();

        let by_name = watchlist_content(&conn, &WatchlistSel::Name("  nifty 50 ".into())).unwrap();
        assert_eq!(by_name.id, id);
        assert_eq!(
            by_name.symbols.iter().map(|s| s.symbol.as_str()).collect::<Vec<_>>(),
            ["zerodha:NSE:RELIANCE", "zerodha:NSE:TCS"]
        );
        assert_eq!(
            watchlist_content(&conn, &WatchlistSel::Id(id)).unwrap().name,
            "Nifty 50"
        );

        let missing = watchlist_content(&conn, &WatchlistSel::Name("Nope".into())).unwrap_err();
        assert_eq!((missing.status, missing.code), (404, "not_found"));
        assert!(
            missing.message.contains("'Nope'") && missing.message.contains("Your watchlists: Nifty 50."),
            "the message should name what does exist: {}",
            missing.message
        );
        err(
            404,
            "not_found",
            watchlist_content(&conn, &WatchlistSel::Id(9999)).unwrap_err(),
        );

        let listed = watchlist_infos(&conn).unwrap();
        assert!(listed.iter().any(|w| w.name == "Nifty 50" && w.count == 2));
    }
}
