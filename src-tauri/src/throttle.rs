//! Spaces out requests to a rate-limited broker API.

use std::time::Duration;

use tokio::sync::Mutex;
use tokio::time::{sleep, Instant};

/// Enforces a minimum gap between requests.
pub struct Throttle {
    gap: Duration,
    last: Mutex<Option<Instant>>,
}

impl Throttle {
    pub fn new(gap: Duration) -> Self {
        Throttle {
            gap,
            last: Mutex::new(None),
        }
    }

    /// Waits until the gap since the previous request has passed, then claims
    /// the slot. Concurrent callers queue up behind the lock, one gap apart.
    pub async fn wait(&self) {
        let mut last = self.last.lock().await;
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
}
