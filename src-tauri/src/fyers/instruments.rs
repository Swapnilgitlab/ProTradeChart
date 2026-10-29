//! FYERS's symbol master: the public CSVs (`public.fyers.in/sym_details/NSE_CM.csv`, …) that list
//! every instrument with its FYERS symbol (`NSE:SBIN-EQ`) and `fyToken`. They need no login and have
//! no header row. Only what can be charted (equities, ETFs, indices, futures) is kept, under the
//! app's own tickers — Kite's spelling, which is what every stored `india:` symbol uses:
//!
//! | FYERS | app |
//! | --- | --- |
//! | `NSE:SBIN-EQ` | `NSE:SBIN` (the ordinary series has no suffix) |
//! | `NSE:HFCL-BE`, `NSE:KODYTECH-ST` | `NSE:HFCL-BE`, `NSE:KODYTECH-ST` |
//! | `BSE:SBIN-A` (the BSE group after the hyphen) | `BSE:SBIN` |
//! | `NSE:NIFTYMIDCAP100-INDEX` | `NSE:NIFTY_MIDCAP_100`, from the index's own name |
//! | `NSE:NIFTY50-INDEX` | `NSE:NIFTY_50`, from [`INDEX_SPELLINGS`] |
//! | `NSE:NIFTY26OCTFUT` (segment 11) | `NFO:NIFTY26OCTFUT` |
//! | `MCX:CRUDEOIL26OCTFUT` | `MCX:CRUDEOIL26OCTFUT` |

use std::io::Read;

use rusqlite::Connection;

use super::protocol::expiry_date;
use crate::models::SymbolMatch;
pub use crate::store::instrument_list::Instrument;
use crate::store::instrument_list::{self, Source};

/// The lists downloaded: NSE and BSE cash, both derivatives segments, and MCX.
pub const MASTERS: [&str; 5] = ["NSE_CM", "BSE_CM", "NSE_FO", "BSE_FO", "MCX_COM"];

/// The indices whose FYERS name isn't the app's ticker spelled without its spaces: FYERS symbol →
/// the app's ticker and name. Every other index's ticker comes from its own name (FYERS's
/// "underlying symbol", `NIFTY MIDCAP 100`), the way Kite spells it. `fyers::live` checks this
/// against the real list.
pub const INDEX_SPELLINGS: &[(&str, &str, &str)] = &[
    ("NSE:NIFTY50-INDEX", "NSE:NIFTY_50", "NIFTY 50"),
    ("NSE:NIFTYBANK-INDEX", "NSE:NIFTY_BANK", "NIFTY BANK"),
    ("NSE:FINNIFTY-INDEX", "NSE:NIFTY_FIN_SERVICE", "NIFTY FIN SERVICE"),
    ("NSE:MIDCPNIFTY-INDEX", "NSE:NIFTY_MID_SELECT", "NIFTY MID SELECT"),
    ("NSE:INDIAVIX-INDEX", "NSE:INDIA_VIX", "INDIA VIX"),
    ("NSE:NIFTY100-INDEX", "NSE:NIFTY_100", "NIFTY 100"),
    ("NSE:NIFTYNXT50-INDEX", "NSE:NIFTY_NEXT_50", "NIFTY NEXT 50"),
    ("NSE:NIFTYIT-INDEX", "NSE:NIFTY_IT", "NIFTY IT"),
    ("NSE:NIFTYMIDCAP50-INDEX", "NSE:NIFTY_MIDCAP_50", "NIFTY MIDCAP 50"),
    ("NSE:NIFTYCPSE-INDEX", "NSE:NIFTY_CPSE", "NIFTY CPSE"),
    ("NSE:NIFTYINFRA-INDEX", "NSE:NIFTY_INFRA", "NIFTY INFRA"),
    ("NSE:NIFTYPSE-INDEX", "NSE:NIFTY_PSE", "NIFTY PSE"),
];

/// The app's exchange for FYERS's exchange and segment codes: 10 NSE, 11 MCX, 12 BSE; segments 10
/// cash, 11 equity derivatives, 20 commodities. Currency derivatives (segment 12) are left out.
fn exchange_of(exchange: &str, segment: &str) -> Option<&'static str> {
    match (exchange, segment) {
        ("10", "10") => Some("NSE"),
        ("12", "10") => Some("BSE"),
        ("10", "11") => Some("NFO"),
        ("12", "11") => Some("BFO"),
        ("11", "20") => Some("MCX"),
        _ => None,
    }
}

/// Whether an ISIN is a company's equity share: `INE` (an Indian company), then four characters
/// for the issuer, then `01`, the security type for equity shares (`INE002A01018` is Reliance's).
fn is_equity_isin(isin: &str) -> bool {
    isin.len() == 12 && isin.starts_with("INE") && isin.get(7..9) == Some("01")
}

/// What a row is, from its instrument type: in the cash segment 0 is a share and 9 an ETF (both
/// `EQUITY`, as Kite lists them) and 10 an index; in the others 11, 13 and 30 are index, stock and
/// commodity futures. Options, bonds, SGBs and the rest are left out.
///
/// BSE lists most of its shares — every group but A and T (B, X, XT, Z, M, the SME and
/// trade-for-trade ones) — under type 50, "miscellaneous", together with debentures, government
/// securities and fund units. The ISIN tells them apart, so a share is kept whichever group it is in.
fn kind_of(segment: &str, instrument_type: &str, isin: &str) -> Option<&'static str> {
    match (segment, instrument_type) {
        ("10", "0" | "9") => Some("EQUITY"),
        ("10", "50") if is_equity_isin(isin) => Some("EQUITY"),
        ("10", "10") => Some("INDEX"),
        ("11" | "20", "11" | "13" | "30") => Some("FUT"),
        _ => None,
    }
}

/// The app's ticker for an exchange and a name: spaces become underscores (`NIFTY_50`).
fn make_ticker(exchange: &str, symbol: &str) -> String {
    format!("{exchange}:{}", symbol.trim().to_uppercase().replace(' ', "_"))
}

/// An NSE share's ticker: the trading symbol, then its series unless that is the ordinary `EQ`.
/// FYERS writes `NSE:BAJAJ-AUTO-EQ` with the underlying `BAJAJ-AUTO`, so the series is what follows it.
fn nse_share(fyers_symbol: &str, underlying: &str) -> String {
    let body = fyers_symbol.strip_prefix("NSE:").unwrap_or(fyers_symbol);
    let series = body
        .strip_prefix(underlying)
        .and_then(|rest| rest.strip_prefix('-'))
        .or_else(|| body.rsplit_once('-').map(|(_, s)| s))
        .unwrap_or("EQ");
    let base = if body.starts_with(underlying) && !underlying.is_empty() {
        underlying
    } else {
        body.rsplit_once('-').map_or(body, |(b, _)| b)
    };
    if series.eq_ignore_ascii_case("EQ") {
        make_ticker("NSE", base)
    } else {
        make_ticker("NSE", &format!("{base}-{series}"))
    }
}

/// Parses one master file (`NSE_CM`, …), keeping chartable rows. `today` is `YYYY-MM-DD`; expired
/// futures are dropped.
pub fn parse_master(reader: impl Read, today: &str) -> Result<Vec<Instrument>, String> {
    let mut csv = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .from_reader(reader);
    let mut out = Vec::with_capacity(12_000);
    let mut seen = std::collections::HashSet::new();
    let mut rows = 0usize;
    for record in csv.records() {
        let Ok(r) = record else { continue };
        rows += 1;
        let get = |i: usize| r.get(i).unwrap_or("").trim();
        // The documented layout: 0 fyToken, 1 symbol details, 2 instrument type, 5 ISIN, 8 expiry
        // (epoch seconds), 9 symbol, 10 exchange, 11 segment, 13 underlying symbol.
        let (Some(kind), Some(exchange)) = (kind_of(get(11), get(2), get(5)), exchange_of(get(10), get(11))) else {
            continue;
        };
        let Ok(token) = get(0).parse::<i64>() else { continue };
        let (symbol, details, underlying) = (get(9), get(1), get(13));
        if symbol.is_empty() || !symbol.contains(':') {
            continue;
        }
        let expiry = (kind == "FUT").then(|| expiry_date(get(8))).flatten();
        if kind == "FUT" && expiry.as_deref().is_none_or(|d| d < today) {
            continue;
        }

        let (ticker, name) = match (kind, exchange) {
            ("INDEX", _) => match INDEX_SPELLINGS.iter().find(|(fy, _, _)| *fy == symbol) {
                Some((_, ticker, name)) => (ticker.to_string(), name.to_string()),
                None => {
                    let own = Some(underlying)
                        .filter(|u| !u.is_empty())
                        .unwrap_or_else(|| details.trim_end_matches("-INDEX"));
                    (make_ticker(exchange, own), own.to_string())
                }
            },
            ("EQUITY", "NSE") => (nse_share(symbol, underlying), details.to_string()),
            ("EQUITY", _) => {
                let base = Some(underlying).filter(|u| !u.is_empty()).unwrap_or_else(|| {
                    symbol
                        .split_once(':')
                        .map_or(symbol, |(_, s)| s.rsplit_once('-').map_or(s, |(b, _)| b))
                });
                (make_ticker(exchange, base), details.to_string())
            }
            // A future keeps FYERS's own trading symbol, which is Kite's (`NIFTY26OCTFUT`).
            _ => (
                make_ticker(exchange, symbol.split_once(':').map_or(symbol, |(_, s)| s)),
                details.to_string(),
            ),
        };
        if !seen.insert(ticker.clone()) {
            continue;
        }
        out.push(Instrument {
            ticker,
            exchange: exchange.to_string(),
            token,
            instrument: kind.to_string(),
            symbol: symbol.to_string(),
            name: Some(name).filter(|n| !n.is_empty()),
            expiry,
        });
    }
    if rows > 0 && out.is_empty() {
        // Rows, but none in the documented layout: FYERS has changed its format.
        return Err(
            "FYERS's symbol master isn't in the layout the app reads; FYERS may have changed its format.".into(),
        );
    }
    Ok(out)
}

// ---- Storage ---------------------------------------------------------------
//
// FYERS's own table (`fyers_instruments`), through the code both brokers share.

pub fn replace_all(conn: &mut Connection, items: &[Instrument]) -> rusqlite::Result<usize> {
    instrument_list::replace_all(conn, Source::Fyers, items)
}

pub fn count(conn: &Connection) -> rusqlite::Result<i64> {
    instrument_list::count(conn, Source::Fyers)
}

pub fn resolve(conn: &Connection, ticker: &str) -> rusqlite::Result<Option<Instrument>> {
    instrument_list::resolve(conn, Source::Fyers, ticker)
}

pub fn search(conn: &Connection, query: &str, limit: usize) -> rusqlite::Result<Vec<SymbolMatch>> {
    instrument_list::search(conn, Source::Fyers, query, limit)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    /// Rows copied from FYERS's real lists (2026-10-16), one of each kind that matters.
    const NSE_CM: &str = "\
101000000003045,STATE BANK OF INDIA,0,1,0.05,INE062A01020,0915-1530|1815-1915:,2026-10-16,,NSE:SBIN-EQ,10,10,3045,SBIN,3045,-1.0,XX,10100000003045,None,1,3.7
101000000016669,BAJAJ AUTO LIMITED,0,1,0.5,INE917I01010,0915-1530|1815-1915:,2026-10-16,,NSE:BAJAJ-AUTO-EQ,10,10,16669,BAJAJ-AUTO,16669,-1.0,XX,101000000016669,None,1,2.0
101000000002031,MAHINDRA & MAHINDRA LTD,0,1,0.1,INE101A01026,0915-1530|1815-1915:,2026-10-16,,NSE:M&M-EQ,10,10,2031,M&M,2031,-1.0,XX,101000000002031,None,1,2.0
101000000021954,HFCL LIMITED,0,1,0.01,INE548A01028,0915-1530|1815-1915:,2026-10-16,,NSE:HFCL-BE,10,10,21954,HFCL,21954,-1.0,XX,101000000021954,None,1,2.0
101000000018754,KODY TECHNOLAB LIMITED,0,1,0.05,INE0NAV01010,0915-1530|1815-1915:,2026-10-16,,NSE:KODYTECH-ST,10,10,18754,KODYTECH,18754,-1.0,XX,101000000018754,None,1,2.0
101000000015068,NIPPON INDIA ETF NIFTY BEES,9,1,0.01,INF204KB14I2,0915-1530|1815-1915:,2026-10-16,,NSE:NIFTYBEES-EQ,10,10,15068,NIFTYBEES,15068,-1.0,XX,101000000015068,None,1,2.0
101000000026000,NIFTY50-INDEX,10,0,0.05,,0915-1530|1815-1915:,2026-10-16,,NSE:NIFTY50-INDEX,10,10,26000,NIFTY,26000,-1.0,XX,101000000026000,None,0,0.0
101000000026009,NIFTYBANK-INDEX,10,0,0.05,,0915-1530|1815-1915:,2026-10-16,,NSE:NIFTYBANK-INDEX,10,10,26009,BANKNIFTY,26009,-1.0,XX,101000000026009,None,0,0.0
1010000000999022,NIFTYMIDCAP100-INDEX,10,0,0.05,,0915-1530|1815-1915:,2026-10-16,,NSE:NIFTYMIDCAP100-INDEX,10,10,999022,NIFTY MIDCAP 100,999022,-1.0,XX,1010000000999022,None,0,0.0
101000000014359,SGB 2.50 PCT 2032 SR-II,5,1,0.01,IN0020200252,0915-1530|1815-1915:,2026-10-16,,NSE:SGBJUN32-GB,10,10,14359,SGBJUN32,14359,-1.0,XX,101000000014359,None,0,0.0
";

    const BSE_CM: &str = "\
1210000000500112,STATE BANK OF INDIA,0,1,0.05,INE062A01020,0915-1530|1815-1915:,2026-10-16,,BSE:SBIN-A,12,10,500112,SBIN,500112,-1.0,XX,1210000000500112,None,1,3.7
121000000001,SENSEX-INDEX,10,0,0.01,,0915-1530|1815-1915:,2026-10-16,,BSE:SENSEX-INDEX,12,10,1,SENSEX,1,-1.0,XX,121000000001,None,0,0.0
1210000000530001,7SEAS ENTERTAINMENT LIMITED,50,1,0.01,INE454F01010,0915-1530|1815-1915:,2026-10-16,,BSE:7SEASL-X,12,10,530001,7SEASL,530001,-1.0,XX,1210000000530001,None,0,0.0
1210000000950001,HCC-0.01%-31-3-29-PVT,50,1,0.01,INE549A07221,0915-1530|1815-1915:,2026-10-16,,BSE:001HCCL29B-F,12,10,950001,001HCCL29B,950001,-1.0,XX,1210000000950001,None,0,0.0
1210000000590001,Nippon India Mutual Fund,50,1,0.01,INF204KB17R6,0915-1530|1815-1915:,2026-10-16,,BSE:08ABB-B,12,10,590001,08ABB,590001,-1.0,XX,1210000000590001,None,0,0.0
";

    const NSE_FO: &str = "\
101126102748699,BANKNIFTY 27 Oct 26 FUT,11,30,0.2,,0915-1530|1815-1915:,2026-10-16,1793095800,NSE:BANKNIFTY26OCTFUT,10,11,48699,BANKNIFTY,26009,-1.0,XX,101000000026009,None,0,0.0
101126102748700,BANKNIFTY 27 Oct 26 55000 CE,15,30,0.05,,0915-1530|1815-1915:,2026-10-16,1793095800,NSE:BANKNIFTY26OCT55000CE,10,11,48700,BANKNIFTY,26009,55000.0,CE,101000000026009,None,0,0.0
101120092648601,NIFTY 29 Sep 26 FUT,11,65,0.1,,0915-1530|1815-1915:,2026-09-26,1790675400,NSE:NIFTY26SEPFUT,10,11,48601,NIFTY,26000,-1.0,XX,101000000026000,None,0,0.0
";

    const MCX_COM: &str = "\
1120261019458921,CRUDEOIL 19 Oct 26 FUT,30,100,1.0,,0900-2330|1815-1915:,2026-10-16,1792432800,MCX:CRUDEOIL26OCTFUT,11,20,458921,CRUDEOIL,294,-1.0,XX,1120000000294,None,0,0.0
";

    const TODAY: &str = "2026-10-16";

    fn parsed() -> Vec<Instrument> {
        [NSE_CM, BSE_CM, NSE_FO, MCX_COM]
            .iter()
            .flat_map(|csv| parse_master(csv.as_bytes(), TODAY).unwrap())
            .collect()
    }

    fn by<'a>(all: &'a [Instrument], ticker: &str) -> &'a Instrument {
        all.iter()
            .find(|i| i.ticker == ticker)
            .unwrap_or_else(|| panic!("{ticker} missing"))
    }

    #[test]
    fn shares_get_the_apps_tickers_series_kept_unless_ordinary() {
        let all = parsed();
        assert_eq!(by(&all, "NSE:SBIN").symbol, "NSE:SBIN-EQ");
        assert_eq!(
            by(&all, "NSE:BAJAJ-AUTO").symbol,
            "NSE:BAJAJ-AUTO-EQ",
            "a hyphen inside the symbol"
        );
        assert_eq!(by(&all, "NSE:M&M").symbol, "NSE:M&M-EQ");
        assert_eq!(by(&all, "NSE:HFCL-BE").symbol, "NSE:HFCL-BE");
        assert_eq!(by(&all, "NSE:KODYTECH-ST").symbol, "NSE:KODYTECH-ST");
        assert_eq!(
            by(&all, "NSE:NIFTYBEES").instrument,
            "EQUITY",
            "an ETF is listed like a share"
        );
        assert_eq!(
            by(&all, "BSE:SBIN").symbol,
            "BSE:SBIN-A",
            "BSE's group isn't part of the ticker"
        );
        assert_eq!(
            by(&all, "BSE:7SEASL").symbol,
            "BSE:7SEASL-X",
            "a share in a group BSE files as misc"
        );
        assert!(!all.iter().any(|i| i.symbol == "BSE:001HCCL29B-F"), "a debenture isn't");
        assert!(
            !all.iter().any(|i| i.symbol == "BSE:08ABB-B"),
            "nor a fund unit, though it is in group B"
        );
        assert_eq!(by(&all, "NSE:SBIN").name.as_deref(), Some("STATE BANK OF INDIA"));
        assert_eq!(by(&all, "NSE:SBIN").token, 101_000_000_003_045);
    }

    #[test]
    fn indices_are_named_as_kite_names_them() {
        let all = parsed();
        assert_eq!(by(&all, "NSE:NIFTY_50").symbol, "NSE:NIFTY50-INDEX");
        assert_eq!(by(&all, "NSE:NIFTY_50").name.as_deref(), Some("NIFTY 50"));
        assert_eq!(by(&all, "NSE:NIFTY_BANK").symbol, "NSE:NIFTYBANK-INDEX");
        assert_eq!(
            by(&all, "NSE:NIFTY_MIDCAP_100").symbol,
            "NSE:NIFTYMIDCAP100-INDEX",
            "from the index's own name"
        );
        assert_eq!(by(&all, "BSE:SENSEX").instrument, "INDEX");
    }

    #[test]
    fn live_futures_are_kept_under_their_exchange_and_options_and_bonds_are_not() {
        let all = parsed();
        let fut = by(&all, "NFO:BANKNIFTY26OCTFUT");
        assert_eq!(
            (fut.symbol.as_str(), fut.instrument.as_str()),
            ("NSE:BANKNIFTY26OCTFUT", "FUT")
        );
        assert_eq!(fut.expiry.as_deref(), Some("2026-10-27"));
        assert_eq!(by(&all, "MCX:CRUDEOIL26OCTFUT").exchange, "MCX");
        let tickers: Vec<&str> = all.iter().map(|i| i.ticker.as_str()).collect();
        assert!(!tickers.iter().any(|t| t.contains("55000")), "options are left out");
        assert!(!tickers.contains(&"NFO:NIFTY26SEPFUT"), "an expired future is dropped");
        assert!(!tickers.iter().any(|t| t.contains("SGB")), "bonds are left out");
        assert_eq!(all.len(), 14);
    }

    #[test]
    fn a_master_in_another_layout_is_refused_with_a_clear_message() {
        let err = parse_master("a,b,c\n1,2,3\n".as_bytes(), TODAY).unwrap_err();
        assert!(err.contains("layout"), "{err}");
        assert!(parse_master("".as_bytes(), TODAY).unwrap().is_empty());
    }

    #[test]
    fn an_index_saved_through_the_other_broker_resolves_here_too() {
        let db = Database::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        replace_all(&mut conn, &parsed()).unwrap();
        assert_eq!(count(&conn).unwrap(), 14);
        let found = |t: &str| resolve(&conn, t).unwrap().map(|i| i.symbol);
        assert_eq!(found("NSE:SBIN").as_deref(), Some("NSE:SBIN-EQ"));
        assert_eq!(found("sbin").as_deref(), Some("NSE:SBIN-EQ"), "bare means NSE");
        assert_eq!(found("NSE:HFCL").as_deref(), Some("NSE:HFCL-BE"), "the series fallback");
        assert_eq!(
            found("NSE:NIFTYMIDCAP100").as_deref(),
            Some("NSE:NIFTYMIDCAP100-INDEX"),
            "spelled without spaces"
        );
        assert_eq!(
            found("NSE:NIFTY_MIDCAP100").as_deref(),
            Some("NSE:NIFTYMIDCAP100-INDEX")
        );
        assert_eq!(
            found("NSE:SB_IN"),
            None,
            "only an index is matched without its punctuation"
        );
        assert_eq!(search(&conn, "nifty", 8).unwrap()[0].symbol, "NSE:NIFTY_50");
        assert_eq!(search(&conn, "state bank", 8).unwrap()[0].symbol, "NSE:SBIN");
    }
}
