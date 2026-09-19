//! Keeps the app a polite client of Yahoo Finance's unofficial endpoints.
//!
//! Yahoo publishes no rate limits for these endpoints, and what people report
//! varies with time, IP address and endpoint. So instead of aiming at a number
//! we can't verify, every request to Yahoo passes through a [`Gate`] that
//!
//! 1. **paces** requests: a minimum gap between starts and a rolling
//!    per-minute budget, both far below what normal use needs;
//! 2. **sheds load** rather than queueing without bound: a request that would
//!    have to wait too long is refused, and its caller falls back to the cache;
//! 3. **backs off** on `HTTP 429`: nothing is sent to Yahoo at all until the
//!    pause ends, and each consecutive 429 doubles the pause. Carrying on
//!    against a limiter that has said "stop" is what turns a short throttle
//!    into a block that lasts hours.
//!
//! The gate is a plain state machine: callers pass the current time in, so it
//! has no clock or I/O of its own and is fully unit-testable.

use std::collections::VecDeque;
use std::fmt;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const WINDOW: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// Minimum time between the starts of two requests.
    pub min_gap: Duration,
    /// Most requests started in any rolling minute.
    pub per_minute: usize,
    /// A request that would have to wait longer than this for its turn is refused.
    pub max_queue_wait: Duration,
    /// Pause after the first 429; doubles with each consecutive one.
    pub pause_base: Duration,
    pub pause_max: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            min_gap: Duration::from_millis(250),
            per_minute: 60,
            max_queue_wait: Duration::from_secs(12),
            pause_base: Duration::from_secs(30),
            pause_max: Duration::from_secs(15 * 60),
        }
    }
}

/// Why the gate turned a request away.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// Yahoo answered 429 recently; no requests until this much time has passed.
    Paused(Duration),
    /// Too many requests are already waiting for their turn.
    Saturated,
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Refusal::Paused(left) => {
                let secs = left.as_secs_f64().ceil() as u64;
                let wait = if secs >= 90 {
                    format!("about {} minutes", secs.div_ceil(60))
                } else {
                    format!("{secs}s")
                };
                write!(
                    f,
                    "Yahoo Finance is rate limiting this app — requests are paused for {wait} to let it recover"
                )
            }
            Refusal::Saturated => write!(f, "Too many Yahoo Finance requests are queued — try again in a moment"),
        }
    }
}

#[derive(Default)]
struct State {
    /// Earliest start time for the next request.
    next_slot: Option<Instant>,
    /// Start times of recent requests, oldest first (may lie in the future:
    /// a slot is reserved when the request is admitted, not when it is sent).
    slots: VecDeque<Instant>,
    paused_until: Option<Instant>,
    /// Consecutive 429s, cleared by a request that gets through.
    strikes: u32,
}

pub struct Gate {
    limits: Limits,
    state: Mutex<State>,
}

impl Gate {
    pub fn new(limits: Limits) -> Self {
        Gate {
            limits,
            state: Mutex::new(State::default()),
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        // The state stays consistent between statements, so a poisoned lock is safe to reuse.
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Asks to send one request at `now`. On success returns how long to wait
    /// before sending, and reserves that slot; on refusal reserves nothing.
    pub fn admit(&self, now: Instant) -> Result<Duration, Refusal> {
        let mut st = self.state();
        if let Some(left) = remaining(st.paused_until, now) {
            return Err(Refusal::Paused(left));
        }

        let mut slot = st.next_slot.map_or(now, |next| next.max(now));
        while st.slots.front().is_some_and(|&t| t + WINDOW <= slot) {
            st.slots.pop_front();
        }
        if st.slots.len() >= self.limits.per_minute {
            // Full window: this request may start once the one `per_minute`
            // places back has aged out of it.
            slot = slot.max(st.slots[st.slots.len() - self.limits.per_minute] + WINDOW);
        }

        let wait = slot.saturating_duration_since(now);
        if wait > self.limits.max_queue_wait {
            return Err(Refusal::Saturated);
        }
        st.slots.push_back(slot);
        st.next_slot = Some(slot + self.limits.min_gap);
        Ok(wait)
    }

    /// Whether the gate is closed at `now`, and for how much longer. Checked
    /// again after a request has waited for its turn, because a 429 may have
    /// arrived while it queued.
    pub fn paused_for(&self, now: Instant) -> Option<Duration> {
        remaining(self.state().paused_until, now)
    }

    /// A request got an answer other than 429.
    pub fn succeeded(&self, now: Instant) {
        let mut st = self.state();
        // A straggler that was already in flight when the gate closed proves nothing.
        if remaining(st.paused_until, now).is_none() {
            st.strikes = 0;
        }
    }

    /// A request got a 429. Closes the gate and returns the pause length. A 429
    /// arriving while the gate is already closed (other requests were in
    /// flight) doesn't count as another strike.
    pub fn rate_limited(&self, now: Instant, retry_after: Option<Duration>) -> Duration {
        let mut st = self.state();
        if let Some(left) = remaining(st.paused_until, now) {
            return left;
        }
        st.strikes = st.strikes.saturating_add(1);
        let doubling = self.limits.pause_base.saturating_mul(1u32 << (st.strikes - 1).min(16));
        // Honour the server's own hint when it asks for longer than we'd wait.
        let pause = retry_after
            .map_or(doubling, |r| r.max(doubling))
            .min(self.limits.pause_max);
        st.paused_until = Some(now + pause);
        pause
    }
}

fn remaining(until: Option<Instant>, now: Instant) -> Option<Duration> {
    until
        .and_then(|t| t.checked_duration_since(now))
        .filter(|d| !d.is_zero())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    fn gate() -> (Gate, Instant) {
        (Gate::new(Limits::default()), Instant::now())
    }

    #[test]
    fn the_first_request_goes_straight_out() {
        let (gate, t0) = gate();
        assert_eq!(gate.admit(t0), Ok(Duration::ZERO));
    }

    #[test]
    fn a_burst_is_spread_out_by_the_minimum_gap() {
        let (gate, t0) = gate();
        let waits: Vec<_> = (0..4).map(|_| gate.admit(t0).unwrap()).collect();
        assert_eq!(waits, [ms(0), ms(250), ms(500), ms(750)]);
    }

    #[test]
    fn requests_that_arrive_after_the_gap_are_not_delayed() {
        let (gate, t0) = gate();
        gate.admit(t0).unwrap();
        assert_eq!(gate.admit(t0 + ms(300)), Ok(Duration::ZERO));
    }

    #[test]
    fn the_rolling_minute_budget_delays_the_request_that_would_exceed_it() {
        let gate = Gate::new(Limits {
            min_gap: ms(1),
            per_minute: 5,
            max_queue_wait: secs(3600),
            ..Limits::default()
        });
        let t0 = Instant::now();
        for i in 0..5 {
            gate.admit(t0 + ms(i * 10)).unwrap();
        }
        // The sixth must wait for the first to leave the window (at t0 + 60s).
        let wait = gate.admit(t0 + ms(100)).unwrap();
        assert!(wait > secs(59) && wait <= secs(60), "waited {wait:?}");
    }

    #[test]
    fn the_budget_never_lets_more_than_the_limit_start_in_any_minute() {
        let gate = Gate::new(Limits {
            min_gap: ms(1),
            per_minute: 10,
            max_queue_wait: secs(3600),
            ..Limits::default()
        });
        let t0 = Instant::now();
        let mut starts: Vec<Instant> = (0..100).map(|_| t0 + gate.admit(t0).unwrap()).collect();
        starts.sort();
        for (i, &start) in starts.iter().enumerate() {
            let in_window = starts[i..].iter().take_while(|&&t| t < start + WINDOW).count();
            assert!(in_window <= 10, "{in_window} requests start within one minute of #{i}");
        }
    }

    #[test]
    fn an_exhausted_budget_sheds_load_instead_of_queueing_a_minute_ahead() {
        let gate = Gate::new(Limits {
            min_gap: ms(1),
            per_minute: 5,
            ..Limits::default()
        });
        let t0 = Instant::now();
        for _ in 0..5 {
            gate.admit(t0).unwrap();
        }
        assert_eq!(gate.admit(t0), Err(Refusal::Saturated));
    }

    #[test]
    fn a_request_that_would_wait_too_long_is_refused_and_reserves_nothing() {
        let gate = Gate::new(Limits {
            min_gap: ms(500),
            max_queue_wait: secs(2),
            ..Limits::default()
        });
        let t0 = Instant::now();
        // Slots at 0, 0.5, 1, 1.5 and 2 seconds are all within the limit.
        for _ in 0..5 {
            gate.admit(t0).unwrap();
        }
        assert_eq!(gate.admit(t0), Err(Refusal::Saturated));
        // The refusal took no slot: once the queue drains a request goes straight through.
        assert_eq!(gate.admit(t0 + secs(10)), Ok(Duration::ZERO));
    }

    #[test]
    fn a_429_closes_the_gate_for_the_base_pause() {
        let (gate, t0) = gate();
        assert_eq!(gate.rate_limited(t0, None), secs(30));
        assert_eq!(gate.admit(t0 + secs(10)), Err(Refusal::Paused(secs(20))));
        assert_eq!(gate.paused_for(t0 + secs(10)), Some(secs(20)));
        assert!(gate.admit(t0 + secs(31)).is_ok());
        assert_eq!(gate.paused_for(t0 + secs(31)), None);
    }

    #[test]
    fn consecutive_429s_double_the_pause_up_to_the_cap() {
        let (gate, mut now) = gate();
        let mut pauses = Vec::new();
        for _ in 0..8 {
            let pause = gate.rate_limited(now, None);
            pauses.push(pause.as_secs());
            now += pause + ms(1); // the pause ends, the next request is limited again
        }
        assert_eq!(pauses, [30, 60, 120, 240, 480, 900, 900, 900]);
    }

    #[test]
    fn a_request_that_gets_through_resets_the_backoff() {
        let (gate, t0) = gate();
        gate.rate_limited(t0, None);
        gate.rate_limited(t0 + secs(31), None);
        gate.succeeded(t0 + secs(100));
        assert_eq!(gate.rate_limited(t0 + secs(200), None), secs(30));
    }

    #[test]
    fn a_straggler_from_before_the_pause_neither_resets_nor_escalates() {
        let (gate, t0) = gate();
        gate.rate_limited(t0, None);
        // Requests already in flight when the gate closed report back during the pause.
        gate.succeeded(t0 + secs(1));
        assert_eq!(gate.rate_limited(t0 + secs(2), None), secs(28), "not a second strike");
        assert_eq!(
            gate.rate_limited(t0 + secs(31), None),
            secs(60),
            "strike count survived the straggler"
        );
    }

    #[test]
    fn a_retry_after_hint_lengthens_the_pause_but_never_shortens_it() {
        let (gate, t0) = gate();
        assert_eq!(gate.rate_limited(t0, Some(secs(5))), secs(30));
        let (gate, t0) = self::gate();
        assert_eq!(gate.rate_limited(t0, Some(secs(120))), secs(120));
        let (gate, t0) = self::gate();
        assert_eq!(gate.rate_limited(t0, Some(secs(86_400))), secs(900), "capped");
    }

    #[test]
    fn refusals_read_clearly() {
        assert_eq!(
            Refusal::Paused(secs(20)).to_string(),
            "Yahoo Finance is rate limiting this app — requests are paused for 20s to let it recover"
        );
        assert!(Refusal::Paused(secs(240)).to_string().contains("about 4 minutes"));
        assert!(Refusal::Saturated.to_string().contains("queued"));
    }
}
