//! When a schedule fires, and what to do when one comes due. Pure: `now` is always an argument.
//!
//! Times are IST, like everything else about the markets this app reads (`market.rs`): a schedule
//! says "weekdays at 16:00" and means the Indian clock, with no daylight saving to shift it.

use serde::{Deserialize, Serialize};

use crate::market::IST_OFFSET_MS;

const DAY_MS: i64 = 86_400_000;
const MINUTE_MS: i64 = 60_000;
/// The shortest gap between runs: a script that screens a universe takes minutes.
pub const MIN_EVERY_MINUTES: u32 = 5;
pub const MAX_EVERY_MINUTES: u32 = 720;
/// How late a run may start and still count as on time. The engine looks every few seconds, so
/// only a machine that slept (or an app that was closed) is later than this — and then the run is
/// missed, not made up.
pub const GRACE_MS: i64 = 2 * MINUTE_MS;
/// Occurrences counted when saying how many runs were missed; past this it says "at least".
const MAX_COUNTED: usize = 10_000;

/// When a schedule fires: on the chosen weekdays, once at a time of day or every N minutes
/// between two times. Minutes are counted from midnight IST.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    /// Monday first: `days[0]` is Monday, `days[6]` Sunday.
    pub days: [bool; 7],
    #[serde(flatten)]
    pub when: When,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum When {
    /// Once a day at `at`.
    #[serde(rename_all = "camelCase")]
    Daily { at: u32 },
    /// At `from`, then every `minutes` up to and including `until`.
    #[serde(rename_all = "camelCase")]
    Every { minutes: u32, from: u32, until: u32 },
}

impl Rule {
    /// The problem with a rule, if it has one.
    pub fn check(&self) -> Result<(), String> {
        if !self.days.iter().any(|d| *d) {
            return Err("Choose at least one day.".into());
        }
        let in_day = |m: u32| m < 24 * 60;
        match self.when {
            When::Daily { at } if !in_day(at) => Err("The time must be within the day (00:00 to 23:59).".into()),
            When::Every { minutes, .. } if !(MIN_EVERY_MINUTES..=MAX_EVERY_MINUTES).contains(&minutes) => {
                Err(format!("Run every {MIN_EVERY_MINUTES} to {MAX_EVERY_MINUTES} minutes."))
            }
            When::Every { from, until, .. } if !in_day(from) || !in_day(until) => {
                Err("The times must be within the day (00:00 to 23:59).".into())
            }
            When::Every { from, until, .. } if until < from => Err("The last run can't come before the first.".into()),
            _ => Ok(()),
        }
    }

    /// The minutes of an allowed day this rule fires at, in order.
    fn times(&self) -> Vec<u32> {
        match self.when {
            When::Daily { at } => vec![at],
            When::Every { minutes, from, until } => (from..=until).step_by(minutes as usize).collect(),
        }
    }

    /// The first time this rule fires strictly after `after` (epoch ms).
    pub fn next_after(&self, after: i64) -> i64 {
        let times = self.times();
        let today = (after + IST_OFFSET_MS).div_euclid(DAY_MS);
        // A rule with at least one day always fires within a week and a day.
        for day in today..=today + 8 {
            if !self.days[weekday(day)] {
                continue;
            }
            let start = day * DAY_MS - IST_OFFSET_MS;
            if let Some(t) = times.iter().map(|m| start + *m as i64 * MINUTE_MS).find(|t| *t > after) {
                return t;
            }
        }
        unreachable!("a checked rule has at least one day")
    }
}

/// Monday = 0 … Sunday = 6, for a count of days since 1970-01-01 (a Thursday).
fn weekday(day: i64) -> usize {
    (day + 3).rem_euclid(7) as usize
}

/// What the engine does with a schedule on one look.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// Not due yet.
    Wait,
    /// It has never been planned (new, or just switched on): plan it from now, without running.
    Plan { next: i64 },
    /// Run it now; its next run is `next`.
    Run { next: i64 },
    /// It came due while the previous run of it was still going: this one is skipped.
    Busy { next: i64 },
    /// It came due while the app was closed or the machine slept: `count` runs were missed (the
    /// first at `first`). None is made up.
    Missed { first: i64, count: usize, next: i64 },
}

/// The decision for a schedule planned to run at `due` (`None`: not planned), at `now`. `first_look`
/// is the engine's first look since the app started: then anything already due was due while the
/// app was closed, so it is missed however recently — the app starting never runs a script.
pub fn decide(rule: &Rule, due: Option<i64>, now: i64, first_look: bool, busy: bool) -> Decision {
    let Some(due) = due else {
        return Decision::Plan {
            next: rule.next_after(now),
        };
    };
    if due > now {
        return Decision::Wait;
    }
    let next = rule.next_after(now);
    if first_look || now - due > GRACE_MS {
        return Decision::Missed {
            first: due,
            count: occurrences(rule, due, now),
            next,
        };
    }
    if busy {
        Decision::Busy { next }
    } else {
        Decision::Run { next }
    }
}

/// How many times the rule fired from `first` (itself one) up to `now`.
fn occurrences(rule: &Rule, first: i64, now: i64) -> usize {
    let mut count = 1;
    let mut t = first;
    while count < MAX_COUNTED {
        t = rule.next_after(t);
        if t > now {
            break;
        }
        count += 1;
    }
    count
}

#[cfg(test)]
mod tests {
    use super::*;

    const WEEKDAYS: [bool; 7] = [true, true, true, true, true, false, false];

    /// Monday 5 January 2026 plus `day` days, at `hour:minute` IST.
    fn ist(day: i64, hour: i64, minute: i64) -> i64 {
        let monday = 20_458 * DAY_MS - IST_OFFSET_MS;
        monday + day * DAY_MS + hour * 3_600_000 + minute * MINUTE_MS
    }

    fn daily(at: u32) -> Rule {
        Rule {
            days: WEEKDAYS,
            when: When::Daily { at },
        }
    }

    fn market_hours() -> Rule {
        Rule {
            days: WEEKDAYS,
            when: When::Every {
                minutes: 15,
                from: 9 * 60 + 15,
                until: 15 * 60 + 30,
            },
        }
    }

    #[test]
    fn the_test_clock_starts_on_a_monday() {
        // market.rs's tests start from the same Monday.
        assert_eq!(ist(0, 0, 0), 1_767_551_400_000);
        let day = |t: i64| weekday((t + IST_OFFSET_MS).div_euclid(DAY_MS));
        assert_eq!((day(ist(0, 12, 0)), day(ist(4, 23, 59)), day(ist(5, 0, 0))), (0, 4, 5));
    }

    #[test]
    fn a_daily_rule_fires_at_its_time_on_its_days_only() {
        let r = daily(16 * 60);
        assert_eq!(r.next_after(ist(0, 9, 0)), ist(0, 16, 0));
        // Exactly at the time, the next is tomorrow's: "after" is strict.
        assert_eq!(r.next_after(ist(0, 16, 0)), ist(1, 16, 0));
        // Friday evening → Monday.
        assert_eq!(r.next_after(ist(4, 17, 0)), ist(7, 16, 0));
        let sundays = Rule {
            days: [false, false, false, false, false, false, true],
            when: When::Daily { at: 0 },
        };
        assert_eq!(sundays.next_after(ist(6, 0, 0)), ist(13, 0, 0));
    }

    #[test]
    fn an_every_rule_fires_through_its_window_then_waits_for_the_next_day() {
        let r = market_hours();
        assert_eq!(r.next_after(ist(0, 8, 0)), ist(0, 9, 15));
        assert_eq!(r.next_after(ist(0, 9, 15)), ist(0, 9, 30));
        assert_eq!(r.next_after(ist(0, 9, 31)), ist(0, 9, 45));
        // 15:30 is the last run; after it, tomorrow's first.
        assert_eq!(r.next_after(ist(0, 15, 20)), ist(0, 15, 30));
        assert_eq!(r.next_after(ist(0, 15, 30)), ist(1, 9, 15));
        // A window that doesn't divide evenly stops at its last step inside it.
        let odd = Rule {
            days: WEEKDAYS,
            when: When::Every {
                minutes: 25,
                from: 600,
                until: 660,
            },
        };
        assert_eq!(odd.next_after(ist(0, 10, 40)), ist(0, 10, 50));
        assert_eq!(odd.next_after(ist(0, 10, 50)), ist(1, 10, 0));
    }

    #[test]
    fn a_rule_is_checked() {
        assert!(daily(16 * 60).check().is_ok());
        assert!(market_hours().check().is_ok());
        assert!(Rule {
            days: [false; 7],
            when: When::Daily { at: 0 }
        }
        .check()
        .is_err());
        assert!(daily(24 * 60).check().is_err());
        for (minutes, from, until) in [(4, 0, 60), (721, 0, 60), (15, 600, 540), (15, 0, 1440)] {
            assert!(Rule {
                days: WEEKDAYS,
                when: When::Every { minutes, from, until }
            }
            .check()
            .is_err());
        }
    }

    #[test]
    fn a_rule_reads_and_writes_as_the_webview_sends_it() {
        let json =
            r#"{"days":[true,true,true,true,true,false,false],"kind":"every","minutes":15,"from":555,"until":930}"#;
        let r: Rule = serde_json::from_str(json).unwrap();
        assert_eq!(r, market_hours());
        assert_eq!(serde_json::to_string(&r).unwrap(), json);
        let d: Rule =
            serde_json::from_str(r#"{"days":[true,true,true,true,true,false,false],"kind":"daily","at":960}"#).unwrap();
        assert_eq!(d, daily(960));
    }

    #[test]
    fn a_new_schedule_is_planned_without_running() {
        let r = daily(16 * 60);
        assert_eq!(
            decide(&r, None, ist(0, 17, 0), false, false),
            Decision::Plan { next: ist(1, 16, 0) }
        );
    }

    #[test]
    fn a_due_schedule_runs_on_time_or_a_little_late() {
        let r = daily(16 * 60);
        assert_eq!(
            decide(&r, Some(ist(0, 16, 0)), ist(0, 15, 59), false, false),
            Decision::Wait
        );
        assert_eq!(
            decide(&r, Some(ist(0, 16, 0)), ist(0, 16, 0), false, false),
            Decision::Run { next: ist(1, 16, 0) }
        );
        assert_eq!(
            decide(&r, Some(ist(0, 16, 0)), ist(0, 16, 1), false, false),
            Decision::Run { next: ist(1, 16, 0) }
        );
    }

    #[test]
    fn a_run_still_going_makes_the_next_one_skip() {
        let r = market_hours();
        assert_eq!(
            decide(&r, Some(ist(0, 9, 30)), ist(0, 9, 30), false, true),
            Decision::Busy { next: ist(0, 9, 45) }
        );
    }

    #[test]
    fn a_run_due_while_the_machine_slept_is_missed_not_made_up() {
        let r = market_hours();
        // Asleep from 9:20 to 11:02: 9:30 … 11:00 came and went.
        assert_eq!(
            decide(&r, Some(ist(0, 9, 30)), ist(0, 11, 2), false, false),
            Decision::Missed {
                first: ist(0, 9, 30),
                count: 7,
                next: ist(0, 11, 15)
            }
        );
    }

    #[test]
    fn starting_the_app_never_runs_a_script() {
        // Due a minute ago, within the grace — but it came due while the app was closed.
        let r = daily(16 * 60);
        assert_eq!(
            decide(&r, Some(ist(0, 16, 0)), ist(0, 16, 1), true, false),
            Decision::Missed {
                first: ist(0, 16, 0),
                count: 1,
                next: ist(1, 16, 0)
            }
        );
        // Closed over a long weekend: three weekday runs missed, counted.
        assert_eq!(
            decide(&r, Some(ist(4, 16, 0)), ist(9, 12, 0), true, false),
            Decision::Missed {
                first: ist(4, 16, 0),
                count: 3,
                next: ist(9, 16, 0)
            }
        );
    }
}
