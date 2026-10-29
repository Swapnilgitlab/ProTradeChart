//! The day's data requests to FYERS, counted so the app stops before FYERS does.
//!
//! FYERS allows a fixed number of data requests a day (5,000 on the Standard plan, 500,000 on Prime),
//! and an account that keeps going over its limits is blocked for the rest of the day. So the client
//! counts what it has sent since midnight IST and refuses, itself, before the limit: background work
//! (loading the market) stops at 80%, leaving the rest for the charts and the user's own scripts,
//! which stop at 97%. The count lives in memory and restarts with the app, so requests made before a
//! restart aren't known; it errs on the side of FYERS's own count being higher, never lower, only
//! within one session. When FYERS's day resets isn't documented; IST midnight is assumed.
//!
//! Pure: the day and the lane are arguments.

use crate::market::ist_day_start;
use crate::throttle::Lane;

/// The share of the day's limit background work may use.
const BACKGROUND_SHARE: f64 = 0.80;
/// The share interactive work may use, leaving a margin for requests this count doesn't see.
const INTERACTIVE_SHARE: f64 = 0.97;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Budget {
    /// Midnight IST of the day being counted.
    day: i64,
    used: u32,
}

impl Default for Budget {
    fn default() -> Self {
        Budget { day: i64::MIN, used: 0 }
    }
}

/// How much of today's allowance is gone, for the settings screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Usage {
    pub used: u32,
    pub limit: u32,
}

impl Budget {
    fn roll(&mut self, now_ms: i64) {
        let today = ist_day_start(now_ms);
        if today != self.day {
            *self = Budget { day: today, used: 0 };
        }
    }

    /// Counts one request if `lane` may still send one today, out of `limit`; otherwise says why not.
    pub fn admit(&mut self, lane: Lane, limit: u32, now_ms: i64) -> Result<(), String> {
        self.roll(now_ms);
        let share = match lane {
            Lane::Interactive => INTERACTIVE_SHARE,
            Lane::Background => BACKGROUND_SHARE,
        };
        let cap = (f64::from(limit) * share).floor() as u32;
        if self.used >= cap {
            return Err(match lane {
                Lane::Background => format!(
                    "FYERS allows {limit} data requests a day on your plan, and the app keeps the last part of them \
                     for your charts and scripts: loading stops here and carries on tomorrow."
                ),
                Lane::Interactive => format!(
                    "FYERS allows {limit} data requests a day on your plan, and today's are nearly used up. The app \
                     stops here, before FYERS blocks the account for the rest of the day; it carries on tomorrow \
                     (or with FYERS's Prime plan)."
                ),
            });
        }
        self.used += 1;
        Ok(())
    }

    pub fn usage(&mut self, limit: u32, now_ms: i64) -> Usage {
        self.roll(now_ms);
        Usage { used: self.used, limit }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: i64 = 86_400_000;
    /// 2026-10-16 10:00 IST.
    const MORNING: i64 = 1_792_125_000_000;

    #[test]
    fn background_work_stops_at_80_percent_and_interactive_at_97() {
        let mut b = Budget::default();
        for _ in 0..80 {
            b.admit(Lane::Background, 100, MORNING).unwrap();
        }
        assert!(b
            .admit(Lane::Background, 100, MORNING)
            .unwrap_err()
            .contains("loading stops"));
        for _ in 0..17 {
            b.admit(Lane::Interactive, 100, MORNING).unwrap();
        }
        let refused = b.admit(Lane::Interactive, 100, MORNING).unwrap_err();
        assert!(refused.contains("before FYERS blocks"), "{refused}");
        assert_eq!(b.usage(100, MORNING), Usage { used: 97, limit: 100 });
    }

    #[test]
    fn the_count_starts_again_at_midnight_in_india() {
        let mut b = Budget::default();
        for _ in 0..97 {
            b.admit(Lane::Interactive, 100, MORNING).unwrap();
        }
        assert!(b.admit(Lane::Interactive, 100, MORNING).is_err());
        let next_morning = MORNING + DAY;
        assert!(b.admit(Lane::Interactive, 100, next_morning).is_ok());
        assert_eq!(b.usage(100, next_morning).used, 1);
    }
}
