//! The day's FYERS login: when to renew it with the refresh token and the user's PIN, and the state
//! that keeps renewals to one at a time.
//!
//! FYERS's access token stops working at 06:30 IST every day. A login also gives a refresh token,
//! which (by FYERS's community forum — the current documentation doesn't describe it) lasts about 15
//! days and buys a new access token with the user's PIN, from `validate-refresh-token`. The user chose
//! to keep the PIN in the OS keychain for that, knowing the endpoint is undocumented. So before a data
//! call, when the saved token has been through a reset and a refresh token and the PIN are saved,
//! the app renews first; and a call refused for its token renews and is tried once more. Any refusal
//! of the renewal itself forgets the refresh token, and the user is asked to log in.

use std::sync::Mutex;

use super::protocol::token_is_stale;

/// How long a refresh token is taken to last (FYERS's forum says 15 days); past that, renewing isn't
/// tried and the user is asked to log in.
pub const REFRESH_TOKEN_DAYS: i64 = 15;
const DAY_MS: i64 = 86_400_000;

/// Whether to renew the token before a data call.
pub fn should_renew(token_saved_at: Option<i64>, refresh_saved_at: Option<i64>, has_pin: bool, now_ms: i64) -> bool {
    let refresh_fresh = refresh_saved_at.is_some_and(|at| now_ms - at < REFRESH_TOKEN_DAYS * DAY_MS);
    let token_old = token_saved_at.is_none_or(|at| token_is_stale(at, now_ms));
    has_pin && refresh_fresh && token_old
}

/// Whether renewing could help a call refused for its token at all.
pub fn can_renew(refresh_saved_at: Option<i64>, has_pin: bool, now_ms: i64) -> bool {
    has_pin && refresh_saved_at.is_some_and(|at| now_ms - at < REFRESH_TOKEN_DAYS * DAY_MS)
}

/// Tauri state for the FYERS login.
#[derive(Default)]
pub struct FyersSession {
    /// One renewal at a time: the chart requests that arrive together after 06:30 wait for the first
    /// one's renewal instead of each sending their own. Held only around the renewal itself.
    pub gate: tokio::sync::Mutex<()>,
    /// The `state` of the browser login in progress, so a pasted redirect can be checked against it.
    pub pending_state: Mutex<Option<String>>,
    /// Why the last renewal failed, for the settings screen.
    pub renewal_error: Mutex<Option<String>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2026-10-27 15:40 IST.
    const SAVED: i64 = 1_793_095_800_000;
    /// The next morning at 07:10 IST, after the 06:30 reset.
    const NEXT_MORNING: i64 = SAVED + 15 * 3_600_000 + 1_800_000;

    #[test]
    fn a_token_from_before_the_reset_is_renewed_when_a_refresh_token_and_pin_are_saved() {
        assert!(should_renew(Some(SAVED), Some(SAVED), true, NEXT_MORNING));
        assert!(
            !should_renew(Some(SAVED), Some(SAVED), true, SAVED + 3_600_000),
            "still today's"
        );
        assert!(
            !should_renew(Some(SAVED), Some(SAVED), false, NEXT_MORNING),
            "no PIN, no renewal"
        );
        assert!(!should_renew(Some(SAVED), None, true, NEXT_MORNING), "no refresh token");
        assert!(
            should_renew(None, Some(SAVED), true, NEXT_MORNING),
            "a token of unknown age"
        );
    }

    #[test]
    fn a_refresh_token_older_than_its_lifetime_is_not_tried() {
        let much_later = SAVED + 16 * DAY_MS;
        assert!(!should_renew(Some(SAVED), Some(SAVED), true, much_later));
        assert!(!can_renew(Some(SAVED), true, much_later));
        assert!(can_renew(Some(SAVED), true, NEXT_MORNING));
    }
}
