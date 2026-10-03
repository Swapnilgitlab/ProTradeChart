//! Spaces out requests to a rate-limited broker API, letting interactive work (a chart, a
//! script the user ran) go ahead of background work (the market-data download) without
//! ever exceeding the broker's pace.
//!
//! The lane is a task-local rather than a parameter, so every call path into a broker client
//! keeps its signature: work runs in the background lane only inside [`in_background`].
//! A task-local doesn't follow `tokio::spawn`, so a background job wraps each task it spawns.

use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use tokio::sync::{Mutex, Notify};
use tokio::time::{sleep, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lane {
    Interactive,
    Background,
}

tokio::task_local! {
    static LANE: Lane;
}

/// Runs `work` in the background lane: its broker requests wait while any interactive one is queued.
pub async fn in_background<F: Future>(work: F) -> F::Output {
    LANE.scope(Lane::Background, work).await
}

fn current_lane() -> Lane {
    LANE.try_with(|lane| *lane).unwrap_or(Lane::Interactive)
}

/// Enforces a minimum gap between requests.
pub struct Throttle {
    gap: Duration,
    last: Mutex<Option<Instant>>,
    interactive_waiting: AtomicUsize,
    interactive_done: Notify,
}

/// Counts an interactive caller as queued until it has claimed its slot, or given up.
struct Queued<'a>(&'a Throttle);

impl Drop for Queued<'_> {
    fn drop(&mut self) {
        self.0.interactive_waiting.fetch_sub(1, Ordering::SeqCst);
        self.0.interactive_done.notify_waiters();
    }
}

impl Throttle {
    pub fn new(gap: Duration) -> Self {
        Throttle {
            gap,
            last: Mutex::new(None),
            interactive_waiting: AtomicUsize::new(0),
            interactive_done: Notify::new(),
        }
    }

    /// Waits until the gap since the previous request has passed, then claims the slot.
    /// Callers in one lane queue behind the lock, one gap apart; a background caller also
    /// stands aside for as long as an interactive one is waiting.
    pub async fn wait(&self) {
        match current_lane() {
            Lane::Interactive => {
                self.interactive_waiting.fetch_add(1, Ordering::SeqCst);
                let _queued = Queued(self);
                self.claim(&mut *self.last.lock().await).await;
            }
            Lane::Background => loop {
                self.until_no_interactive().await;
                let mut last = self.last.lock().await;
                // One may have queued while this waited for the lock: let it through first.
                if self.interactive_waiting.load(Ordering::SeqCst) > 0 {
                    continue;
                }
                self.claim(&mut last).await;
                return;
            },
        }
    }

    async fn until_no_interactive(&self) {
        loop {
            // Registered before the check, so a release between the two can't be missed.
            let released = self.interactive_done.notified();
            tokio::pin!(released);
            released.as_mut().enable();
            if self.interactive_waiting.load(Ordering::SeqCst) == 0 {
                return;
            }
            released.await;
        }
    }

    async fn claim(&self, last: &mut Option<Instant>) {
        if let Some(at) = *last {
            let elapsed = at.elapsed();
            if elapsed < self.gap {
                sleep(self.gap - elapsed).await;
            }
        }
        *last = Some(Instant::now());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[tokio::test]
    async fn requests_are_spaced_by_the_gap() {
        let throttle = Throttle::new(Duration::from_millis(60));
        let start = Instant::now();
        for _ in 0..3 {
            throttle.wait().await;
        }
        // The first goes straight through; the next two each wait a gap.
        assert!(start.elapsed() >= Duration::from_millis(115), "{:?}", start.elapsed());
    }

    #[tokio::test]
    async fn a_zero_gap_never_waits() {
        let throttle = Throttle::new(Duration::ZERO);
        let start = Instant::now();
        for _ in 0..50 {
            throttle.wait().await;
        }
        assert!(start.elapsed() < Duration::from_millis(50));
    }

    #[tokio::test]
    async fn background_requests_keep_the_gap_too() {
        let throttle = Throttle::new(Duration::from_millis(60));
        let start = Instant::now();
        in_background(async {
            for _ in 0..3 {
                throttle.wait().await;
            }
        })
        .await;
        assert!(start.elapsed() >= Duration::from_millis(115), "{:?}", start.elapsed());
    }

    #[tokio::test]
    async fn an_interactive_request_goes_ahead_of_a_queued_background_download() {
        let gap = Duration::from_millis(40);
        let throttle = Arc::new(Throttle::new(gap));
        let order = Arc::new(std::sync::Mutex::new(Vec::new()));

        // A long background download, already queued.
        let download = {
            let (throttle, order) = (throttle.clone(), order.clone());
            tokio::spawn(in_background(async move {
                for i in 0..10 {
                    throttle.wait().await;
                    order.lock().unwrap().push(format!("bg{i}"));
                }
            }))
        };
        sleep(gap * 2 + Duration::from_millis(10)).await;

        let started = Instant::now();
        throttle.wait().await;
        let waited = started.elapsed();
        order.lock().unwrap().push("chart".to_string());
        download.await.unwrap();

        // It waited at most about one gap, not behind the seven background requests still queued.
        assert!(waited < gap * 3, "waited {waited:?}");
        let order = order.lock().unwrap();
        let chart = order.iter().position(|s| s == "chart").unwrap();
        assert!(chart <= 4, "{order:?}");
        assert_eq!(order.len(), 11);
    }

    #[tokio::test]
    async fn outside_a_background_scope_work_is_interactive() {
        assert_eq!(current_lane(), Lane::Interactive);
        assert_eq!(in_background(async { current_lane() }).await, Lane::Background);
    }
}
