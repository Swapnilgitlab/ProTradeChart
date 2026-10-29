//! Live FYERS charts, from polled quotes.
//!
//! FYERS's data socket speaks a binary protocol that its documentation doesn't describe (only its
//! SDKs' source does), and its API terms forbid reverse-engineering, so the app doesn't use it. A
//! chart showing a FYERS symbol subscribes here instead: one task reads the shared quote cache
//! (`quotes.rs`) for every subscribed symbol whose exchange is trading, as often as the plan's
//! freshness allows (30 s on Standard, 3 s on Prime), and sends each one's last trade to every
//! window as a `fyers-tick`, in the same shape the webview's live-bar builder takes from Kite's ticks.
//! It reads in the background lane, so a chart's own history goes first, and status changes go out
//! as `fyers-status`. Between samples a chart doesn't see the highs and lows; a daily bar takes the
//! quote's own day range, so only intraday bars are near-live rather than exact until they reload.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Notify;

use super::client::FyersClient;
use super::protocol::FyersErrorKind;
use super::quotes::{cached_ticks, freshness_ms};
use crate::db::now_ms;
use crate::market::is_trading;
use crate::store::instrument_list::Instrument;
use crate::throttle::in_background;

pub const TICK_EVENT: &str = "fyers-tick";
pub const STATUS_EVENT: &str = "fyers-status";
/// How long to wait, with nothing trading, before looking again.
const IDLE_LOOK: Duration = Duration::from_secs(60);
/// How long to wait after a failure before trying again.
const AFTER_FAILURE: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Tick {
    /// The app's ticker (`NSE:RELIANCE`), which the webview keys subscriptions by.
    pub ticker: String,
    pub ltp: f64,
    /// The quote's own trade time, epoch seconds as FYERS sent it.
    pub ltt: Option<f64>,
    /// The day's cumulative volume.
    pub volume: Option<f64>,
    /// The day's own open, high and low, for a daily bar.
    pub open: Option<f64>,
    pub high: Option<f64>,
    pub low: Option<f64>,
}

/// The poller's state, in the shape the webview's feed hub reads (`FeedStatus`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Status {
    /// `idle`, `live` or `error`.
    pub state: &'static str,
    pub message: Option<String>,
}

struct Subscription {
    inst: Instrument,
    count: usize,
}

/// Tauri state: who is subscribed, and the poller's last status.
pub struct Poller {
    subs: Mutex<HashMap<String, Subscription>>,
    status: Mutex<Status>,
    wake: Notify,
}

impl Default for Poller {
    fn default() -> Self {
        Poller {
            subs: Mutex::new(HashMap::new()),
            status: Mutex::new(Status {
                state: "idle",
                message: None,
            }),
            wake: Notify::new(),
        }
    }
}

impl Poller {
    /// Counts one more chart showing `inst`, and wakes the loop so it ticks without waiting.
    pub fn subscribe(&self, inst: Instrument) {
        if let Ok(mut subs) = self.subs.lock() {
            subs.entry(inst.ticker.clone())
                .or_insert(Subscription { inst, count: 0 })
                .count += 1;
        }
        self.wake.notify_one();
    }

    /// Counts one fewer; the last one gone stops its polling.
    pub fn unsubscribe(&self, ticker: &str) {
        if let Ok(mut subs) = self.subs.lock() {
            if let Some(sub) = subs.get_mut(ticker) {
                sub.count = sub.count.saturating_sub(1);
                if sub.count == 0 {
                    subs.remove(ticker);
                }
            }
        }
    }

    /// The subscribed instruments whose exchange is trading at `now_ms`, and whether anything is
    /// subscribed at all.
    fn due(&self, now_ms: i64) -> (Vec<Instrument>, bool) {
        let Ok(subs) = self.subs.lock() else {
            return (Vec::new(), false);
        };
        let due = subs
            .values()
            .filter(|s| is_trading(&s.inst.exchange, now_ms))
            .map(|s| s.inst.clone())
            .collect();
        (due, !subs.is_empty())
    }

    pub fn status(&self) -> Status {
        self.status.lock().map(|s| s.clone()).unwrap_or(Status {
            state: "idle",
            message: None,
        })
    }

    /// Records the status, saying whether it changed (only a change is announced).
    fn set_status(&self, next: Status) -> bool {
        let Ok(mut status) = self.status.lock() else {
            return false;
        };
        let changed = *status != next;
        *status = next;
        changed
    }
}

fn announce(app: &AppHandle, next: Status) {
    if app.state::<Poller>().set_status(next.clone()) {
        let _ = app.emit(STATUS_EVENT, next);
    }
}

/// Waits `wait`, or less if a new chart subscribes meanwhile.
async fn pause(poller: &Poller, wait: Duration) {
    let _ = tokio::time::timeout(wait, poller.wake.notified()).await;
}

/// The polling loop. Started once, in `lib.rs`.
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let poller = app.state::<Poller>();
            let (due, any) = poller.due(now_ms());
            if !any {
                announce(
                    &app,
                    Status {
                        state: "idle",
                        message: None,
                    },
                );
                poller.wake.notified().await;
                continue;
            }
            if due.is_empty() {
                // Subscribed, but nothing is trading: the chart already shows the last bar.
                pause(&poller, IDLE_LOOK).await;
                continue;
            }
            let every = Duration::from_millis(freshness_ms(app.state::<FyersClient>().plan(), true) as u64);
            match in_background(cached_ticks(&app, &due)).await {
                Ok(ticks) => {
                    for (inst, tick) in due.iter().zip(ticks) {
                        let Some(t) = tick else { continue };
                        let _ = app.emit(
                            TICK_EVENT,
                            Tick {
                                ticker: inst.ticker.clone(),
                                ltp: t.ltp,
                                ltt: t.ltt,
                                volume: t.volume,
                                open: t.open,
                                high: t.high,
                                low: t.low,
                            },
                        );
                    }
                    announce(
                        &app,
                        Status {
                            state: "live",
                            message: None,
                        },
                    );
                    pause(&poller, every).await;
                }
                Err(e) => {
                    // An expired login or a spent budget is said once; the charts keep their bars.
                    let message = match e.kind {
                        FyersErrorKind::NotConfigured => None,
                        _ => Some(e.message()),
                    };
                    announce(
                        &app,
                        Status {
                            state: "error",
                            message,
                        },
                    );
                    pause(&poller, AFTER_FAILURE.max(every)).await;
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inst(ticker: &str, exchange: &str) -> Instrument {
        Instrument {
            ticker: ticker.into(),
            exchange: exchange.into(),
            token: 1,
            instrument: "EQUITY".into(),
            symbol: ticker.into(),
            name: None,
            expiry: None,
        }
    }

    /// 2026-10-16 (a Friday) 11:00 IST, and 20:00 IST.
    const MORNING: i64 = 1_792_128_600_000;
    const EVENING: i64 = MORNING + 9 * 3_600_000;

    #[test]
    fn a_symbol_is_polled_while_any_chart_shows_it_and_its_exchange_trades() {
        let p = Poller::default();
        p.subscribe(inst("NSE:A", "NSE"));
        p.subscribe(inst("NSE:A", "NSE"));
        p.subscribe(inst("MCX:CRUDE", "MCX"));
        assert_eq!(p.due(MORNING).0.len(), 2);
        let evening: Vec<String> = p.due(EVENING).0.into_iter().map(|i| i.ticker).collect();
        assert_eq!(evening, ["MCX:CRUDE"], "only MCX trades in the evening");
        p.unsubscribe("NSE:A");
        assert_eq!(p.due(MORNING).0.len(), 2, "one chart still shows it");
        p.unsubscribe("NSE:A");
        p.unsubscribe("MCX:CRUDE");
        assert_eq!(p.due(MORNING), (Vec::new(), false));
        p.unsubscribe("NSE:NEVER");
    }

    #[test]
    fn only_a_change_of_status_is_announced() {
        let p = Poller::default();
        assert!(!p.set_status(Status {
            state: "idle",
            message: None
        }));
        assert!(p.set_status(Status {
            state: "live",
            message: None
        }));
        assert!(!p.set_status(Status {
            state: "live",
            message: None
        }));
        assert_eq!(p.status().state, "live");
    }
}
