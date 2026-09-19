//! Dhan (dhanhq.co) as a market-data provider: exchange-grade historical bars,
//! a live tick feed, and quotes for Indian equities, indices, futures and
//! commodities, from the user's own Dhan account.
//!
//! - `protocol`   — pure: request bodies, response parsing, error mapping.
//! - `instruments`— the instrument master (symbol ↔ security id) in SQLite.
//! - `client`     — HTTP: history, quotes, token renewal.
//! - `feed`       — the live WebSocket, shared by every chart and window.

pub mod client;
pub mod feed;
pub mod instruments;
pub mod protocol;

/// Dhan's exchange segments (annexure of the v2 API docs). The discriminants
/// are the numeric codes the live feed uses in its packet headers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Segment {
    IdxI = 0,
    NseEq = 1,
    NseFno = 2,
    NseCurrency = 3,
    BseEq = 4,
    McxComm = 5,
    BseCurrency = 7,
    BseFno = 8,
}

impl Segment {
    pub fn code(self) -> u8 {
        self as u8
    }

    pub fn from_code(code: i64) -> Option<Segment> {
        Some(match code {
            0 => Segment::IdxI,
            1 => Segment::NseEq,
            2 => Segment::NseFno,
            3 => Segment::NseCurrency,
            4 => Segment::BseEq,
            5 => Segment::McxComm,
            7 => Segment::BseCurrency,
            8 => Segment::BseFno,
            _ => return None,
        })
    }

    /// The enum string the REST API expects.
    pub fn api_name(self) -> &'static str {
        match self {
            Segment::IdxI => "IDX_I",
            Segment::NseEq => "NSE_EQ",
            Segment::NseFno => "NSE_FNO",
            Segment::NseCurrency => "NSE_CURRENCY",
            Segment::BseEq => "BSE_EQ",
            Segment::McxComm => "MCX_COMM",
            Segment::BseCurrency => "BSE_CURRENCY",
            Segment::BseFno => "BSE_FNO",
        }
    }

    /// The short exchange code used in chart tickers (`NSE:RELIANCE`). These
    /// are the codes Indian traders already use, and the ones other Indian
    /// brokers (Zerodha next) share, so tickers stay consistent across providers.
    pub fn exchange(self) -> &'static str {
        match self {
            Segment::IdxI => "IDX",
            Segment::NseEq => "NSE",
            Segment::NseFno => "NFO",
            Segment::NseCurrency => "CDS",
            Segment::BseEq => "BSE",
            Segment::McxComm => "MCX",
            Segment::BseCurrency => "BCD",
            Segment::BseFno => "BFO",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segment_codes_round_trip() {
        for code in [0, 1, 2, 3, 4, 5, 7, 8] {
            assert_eq!(Segment::from_code(code).unwrap().code() as i64, code);
        }
        assert!(Segment::from_code(6).is_none(), "6 is unused in Dhan's enum");
        assert!(Segment::from_code(99).is_none());
    }

    #[test]
    fn segments_have_distinct_api_names_and_exchange_codes() {
        let all = [
            Segment::IdxI,
            Segment::NseEq,
            Segment::NseFno,
            Segment::NseCurrency,
            Segment::BseEq,
            Segment::McxComm,
            Segment::BseCurrency,
            Segment::BseFno,
        ];
        let names: std::collections::HashSet<_> = all.iter().map(|s| s.api_name()).collect();
        let exchanges: std::collections::HashSet<_> = all.iter().map(|s| s.exchange()).collect();
        assert_eq!(names.len(), all.len());
        assert_eq!(exchanges.len(), all.len());
        assert_eq!(Segment::NseEq.api_name(), "NSE_EQ");
    }
}
