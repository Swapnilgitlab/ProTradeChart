//! The Indices watchlist: a curated set of Indian market indices, grouped as people follow them —
//! the broad market, sectors, and themes — with each broker's own ticker for it (Zerodha writes
//! `NSE:NIFTY_BANK`, Dhan `IDX:BANKNIFTY`). Strategy, factor and bond indices are left out.
//!
//! Only index *levels* are listed: no source the app uses publishes which stocks make up an index,
//! so there are no sector stock lists here. An index the broker's instrument list doesn't have is
//! skipped, so a renamed or retired one never becomes a symbol that can't load.

use std::collections::HashSet;

use rusqlite::Connection;

use crate::store::instrument_list::{self, Filter, Source};
use crate::store::watchlists;

pub const SECTIONS: [&str; 3] = ["Broad market", "Sectors", "Themes"];

/// `(section, Zerodha ticker, Dhan ticker)`; `None` where that broker doesn't list the index.
const CATALOG: &[(usize, Option<&str>, Option<&str>)] = &[
    // Broad market
    (0, Some("NSE:NIFTY_50"), Some("IDX:NIFTY")),
    (0, Some("BSE:SENSEX"), Some("IDX:SENSEX")),
    (0, Some("NSE:NIFTY_NEXT_50"), Some("IDX:NIFTYNXT50")),
    (0, Some("NSE:NIFTY_100"), Some("IDX:NIFTY_100")),
    (0, Some("NSE:NIFTY_200"), Some("IDX:NIFTY_200")),
    (0, Some("NSE:NIFTY_500"), Some("IDX:NIFTY_500")),
    (0, Some("NSE:NIFTY_TOTAL_MKT"), Some("IDX:NIFTY_TOTAL_MKT")),
    (0, Some("NSE:NIFTY_LARGEMID250"), Some("IDX:NIFTY_LARGEMID250")),
    (0, Some("NSE:NIFTY_MID_SELECT"), Some("IDX:MIDCPNIFTY")),
    (0, Some("NSE:NIFTY_MIDCAP_50"), Some("IDX:NIFTYMCAP50")),
    (0, Some("NSE:NIFTY_MIDCAP_100"), Some("IDX:NIFTY_MID100_FREE")),
    (0, Some("NSE:NIFTY_MIDCAP_150"), Some("IDX:NIFTY_MIDCAP_150")),
    (0, Some("NSE:NIFTY_MIDSML_400"), Some("IDX:NIFTY_MIDSMALLCAP_400")),
    (0, Some("NSE:NIFTY_SMLCAP_50"), Some("IDX:NIFTY_SMALLCAP_50")),
    (0, Some("NSE:NIFTY_SMLCAP_100"), Some("IDX:NIFTY_SMALLCAP_100")),
    (0, Some("NSE:NIFTY_SMLCAP_250"), Some("IDX:NIFTY_SMALLCAP_250")),
    (0, Some("NSE:NIFTY_MICROCAP250"), Some("IDX:NIFTY_MICROCAP250")),
    (0, Some("NSE:INDIA_VIX"), Some("IDX:INDIA_VIX")),
    // Sectors
    (1, Some("NSE:NIFTY_AUTO"), Some("IDX:NIFTY_AUTO")),
    (1, Some("NSE:NIFTY_BANK"), Some("IDX:BANKNIFTY")),
    (1, Some("NSE:NIFTY_PVT_BANK"), Some("IDX:NIFTY_PVT_BANK")),
    (1, Some("NSE:NIFTY_PSU_BANK"), Some("IDX:NIFTY_PSU_BANK")),
    (1, Some("BSE:BANKEX"), Some("IDX:BANKEX")),
    (1, Some("NSE:NIFTY_FIN_SERVICE"), Some("IDX:FINNIFTY")),
    (1, Some("NSE:NIFTY_FINSRV25_50"), Some("IDX:NIFTY_FINSRV25_50")),
    (1, Some("NSE:NIFTY_FINSEREXBNK"), Some("IDX:NIFTY_FINSEREXBNK")),
    (1, Some("NSE:NIFTY_CHEMICALS"), None),
    (1, Some("NSE:NIFTY_CONSR_DURBL"), Some("IDX:NIFTY_CONSR_DURBL")),
    (1, Some("NSE:NIFTY_FMCG"), Some("IDX:NIFTY_FMCG")),
    (1, Some("NSE:NIFTY_HEALTHCARE"), Some("IDX:NIFTY_HEALTHCARE")),
    (1, Some("NSE:NIFTY_PHARMA"), Some("IDX:NIFTY_PHARMA")),
    (1, Some("NSE:NIFTY_IT"), Some("IDX:NIFTYIT")),
    (1, Some("NSE:NIFTY_MEDIA"), Some("IDX:NIFTY_MEDIA")),
    (1, Some("NSE:NIFTY_METAL"), Some("IDX:NIFTY_METAL")),
    (1, Some("NSE:NIFTY_OIL_AND_GAS"), Some("IDX:NIFTY_OIL_AND_GAS")),
    (1, Some("NSE:NIFTY_REALTY"), Some("IDX:NIFTY_REALTY")),
    (1, Some("NSE:NIFTY_MS_FIN_SERV"), Some("IDX:NIFTY_MS_FIN_SERV")),
    (1, Some("NSE:NIFTY_MIDSML_HLTH"), Some("IDX:NIFTY_MIDSML_HLTH")),
    (1, Some("NSE:NIFTY_MS_IT_TELCM"), Some("IDX:NIFTY_MS_IT_TELCM")),
    // Themes
    (2, Some("NSE:NIFTY_CAPITAL_MKT"), Some("IDX:NIFTY_CAPITAL_MKT")),
    (2, Some("NSE:NIFTY_COMMODITIES"), Some("IDX:NIFTY_COMMODITIES")),
    (2, Some("NSE:NIFTY_CONSUMPTION"), Some("IDX:NIFTY_CONSUMPTION")),
    (2, Some("NSE:NIFTY_CPSE"), Some("IDX:NIFTYCPSE")),
    (2, Some("NSE:NIFTY_ENERGY"), Some("IDX:NIFTY_ENERGY")),
    (2, Some("NSE:NIFTY_EV"), Some("IDX:NIFTY_EV")),
    (2, Some("NSE:NIFTY_HOUSING"), Some("IDX:NIFTY_HOUSING")),
    (2, Some("NSE:NIFTY_IND_DEFENCE"), Some("IDX:NIFTY_IND_DEFENCE")),
    (2, Some("NSE:NIFTY_IND_DIGITAL"), Some("IDX:NIFTY_IND_DIGITAL")),
    (2, Some("NSE:NIFTY_INDIA_MFG"), Some("IDX:NIFTY_INDIA_MFG")),
    (2, Some("NSE:NIFTY_IND_TOURISM"), Some("IDX:NIFTY_IND_TOURISM")),
    (2, Some("NSE:NIFTY_INFRA"), Some("IDX:NIFTYINFRA")),
    (2, Some("NSE:NIFTY_MNC"), Some("IDX:NIFTY_MNC")),
    (2, Some("NSE:NIFTY_MOBILITY"), Some("IDX:NIFTY_MOBILITY")),
    (2, Some("NSE:NIFTY_PSE"), Some("IDX:NIFTYPSE")),
    (2, Some("NSE:NIFTY_RAILWAYS_PSU"), None),
    (2, Some("NSE:NIFTY_RURAL"), Some("IDX:NIFTY_RURAL")),
    (2, Some("NSE:NIFTY_SERV_SECTOR"), Some("IDX:NIFTY_SERV_SECTOR")),
    (2, Some("NSE:NIFTY_TRANS_LOGIS"), Some("IDX:NIFTY_TRANS_LOGIS")),
];

/// The list for `source`: each section with its symbols (`provider:TICKER`), keeping only
/// tickers in `available`, and how many catalogue entries that broker lacked.
pub fn plan(source: Source, available: &HashSet<String>) -> (Vec<(&'static str, Vec<String>)>, usize) {
    let provider = match source {
        Source::Zerodha => "zerodha",
        Source::Dhan => "dhan",
    };
    let mut sections: Vec<(&'static str, Vec<String>)> = SECTIONS.iter().map(|s| (*s, Vec::new())).collect();
    let mut missing = 0;
    for (section, zerodha, dhan) in CATALOG {
        let ticker = match source {
            Source::Zerodha => zerodha,
            Source::Dhan => dhan,
        };
        match ticker.filter(|t| available.contains(*t)) {
            Some(t) => sections[*section].1.push(format!("{provider}:{t}")),
            None => missing += 1,
        }
    }
    sections.retain(|(_, symbols)| !symbols.is_empty());
    (sections, missing)
}

/// What [`create`] made.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Created {
    pub id: i64,
    pub name: String,
    pub symbols: usize,
    /// Catalogue entries the broker's instrument list didn't have.
    pub skipped: usize,
}

/// Makes the Indices watchlist from `source`'s instrument list, named "Indices" (or "Indices 2"…
/// when that is taken), with a section per group. Fails when the instrument list has no indices
/// (it hasn't been downloaded yet).
pub fn create(conn: &mut Connection, source: Source) -> Result<Created, String> {
    let sql = |e: rusqlite::Error| e.to_string();
    let filter = Filter {
        exchange: None,
        kind: Some("INDEX".into()),
        query: None,
    };
    let available: HashSet<String> = instrument_list::list(conn, source, &filter, 50_000)
        .map_err(sql)?
        .into_iter()
        .map(|l| l.ticker)
        .collect();
    let (sections, skipped) = plan(source, &available);
    if sections.is_empty() {
        return Err("The broker's instrument list has no indices yet. Open Data providers and update it first.".into());
    }
    let taken: HashSet<String> = watchlists::list(conn)
        .map_err(sql)?
        .into_iter()
        .map(|w| w.name.to_lowercase())
        .collect();
    let name = (1..)
        .map(|n| {
            if n == 1 {
                "Indices".to_string()
            } else {
                format!("Indices {n}")
            }
        })
        .find(|n| !taken.contains(&n.to_lowercase()))
        .expect("some name is free");
    let id = watchlists::create(conn, &name).map_err(sql)?;
    let mut symbols = 0;
    for (section, list) in &sections {
        watchlists::add_section(conn, id, section, None).map_err(sql)?;
        let items: Vec<_> = list
            .iter()
            .map(|s| crate::models::NewWatchlistItem {
                symbol: s.clone(),
                name: None,
            })
            .collect();
        symbols += watchlists::add_items(conn, id, &items).map_err(sql)? as usize;
    }
    Ok(Created {
        id,
        name,
        symbols,
        skipped,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use rusqlite::params;

    #[test]
    fn every_catalogue_entry_is_well_formed_and_listed_once() {
        let mut seen = HashSet::new();
        for (section, zerodha, dhan) in CATALOG {
            assert!(*section < SECTIONS.len());
            assert!(zerodha.is_some() || dhan.is_some());
            for t in [zerodha, dhan].into_iter().flatten() {
                assert!(t.contains(':') && !t.contains(' '), "{t}");
                assert!(seen.insert(*t), "{t} twice");
            }
        }
    }

    #[test]
    fn the_plan_keeps_what_the_broker_lists_in_catalogue_order() {
        let available: HashSet<String> = ["NSE:NIFTY_BANK", "NSE:NIFTY_50", "NSE:NIFTY_EV", "IDX:BANKNIFTY"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let (sections, missing) = plan(Source::Zerodha, &available);
        assert_eq!(
            sections,
            vec![
                ("Broad market", vec!["zerodha:NSE:NIFTY_50".to_string()]),
                ("Sectors", vec!["zerodha:NSE:NIFTY_BANK".to_string()]),
                ("Themes", vec!["zerodha:NSE:NIFTY_EV".to_string()]),
            ]
        );
        assert_eq!(missing, CATALOG.len() - 3);
        let (dhan, _) = plan(Source::Dhan, &available);
        assert_eq!(dhan, vec![("Sectors", vec!["dhan:IDX:BANKNIFTY".to_string()])]);
    }

    fn seed(conn: &Connection, tickers: &[&str]) {
        for t in tickers {
            conn.execute(
                "INSERT INTO zerodha_instruments (ticker, exchange, token, instrument, symbol, name, expiry)
                 VALUES (?1, 'NSE', 1, 'INDEX', ?1, ?1, NULL)",
                params![t],
            )
            .unwrap();
        }
    }

    #[test]
    fn the_list_is_made_with_a_section_per_group_under_a_free_name() {
        let db = Database::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        assert!(create(&mut conn, Source::Zerodha).is_err(), "no instrument list yet");
        seed(&conn, &["NSE:NIFTY_50", "NSE:NIFTY_BANK", "NSE:NIFTY_IT"]);
        let made = create(&mut conn, Source::Zerodha).unwrap();
        assert_eq!((made.name.as_str(), made.symbols), ("Indices", 3));
        let detail = watchlists::get(&conn, made.id).unwrap().unwrap();
        assert_eq!(
            detail.sections.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
            ["Broad market", "Sectors"]
        );
        assert_eq!(
            detail.items.iter().map(|i| i.symbol.as_str()).collect::<Vec<_>>(),
            ["zerodha:NSE:NIFTY_50", "zerodha:NSE:NIFTY_BANK", "zerodha:NSE:NIFTY_IT"]
        );
        // Each section sits right above its own symbols.
        assert!(detail.sections[0].position < detail.items[0].position);
        assert!(
            detail.items[0].position < detail.sections[1].position
                && detail.sections[1].position < detail.items[1].position
        );
        assert_eq!(create(&mut conn, Source::Zerodha).unwrap().name, "Indices 2");
    }
}
