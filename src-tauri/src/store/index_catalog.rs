//! The Indices watchlist: a curated set of Indian market indices, grouped as people follow them —
//! the broad market, sectors, and themes — with the app's ticker for each (`NSE:NIFTY_BANK`, Kite's
//! spelling; each broker's instrument list is read under it).
//! Strategy, factor and bond indices are left out.
//!
//! Only index *levels* are listed: no source the app uses publishes which stocks make up an index,
//! so there are no sector stock lists here. An index the broker's instrument list doesn't have is
//! skipped, so a renamed or retired one never becomes a symbol that can't load.

use std::collections::HashSet;

use rusqlite::Connection;

use crate::store::instrument_list::{self, Filter, Source};
use crate::store::watchlists;
use crate::symbols::INDIA;

pub const SECTIONS: [&str; 3] = ["Broad market", "Sectors", "Themes"];

/// `(section, ticker)`.
const CATALOG: &[(usize, &str)] = &[
    // Broad market
    (0, "NSE:NIFTY_50"),
    (0, "BSE:SENSEX"),
    (0, "NSE:NIFTY_NEXT_50"),
    (0, "NSE:NIFTY_100"),
    (0, "NSE:NIFTY_200"),
    (0, "NSE:NIFTY_500"),
    (0, "NSE:NIFTY_TOTAL_MKT"),
    (0, "NSE:NIFTY_LARGEMID250"),
    (0, "NSE:NIFTY_MID_SELECT"),
    (0, "NSE:NIFTY_MIDCAP_50"),
    (0, "NSE:NIFTY_MIDCAP_100"),
    (0, "NSE:NIFTY_MIDCAP_150"),
    (0, "NSE:NIFTY_MIDSML_400"),
    (0, "NSE:NIFTY_SMLCAP_50"),
    (0, "NSE:NIFTY_SMLCAP_100"),
    (0, "NSE:NIFTY_SMLCAP_250"),
    (0, "NSE:NIFTY_MICROCAP250"),
    (0, "NSE:INDIA_VIX"),
    // Sectors
    (1, "NSE:NIFTY_AUTO"),
    (1, "NSE:NIFTY_BANK"),
    (1, "NSE:NIFTY_PVT_BANK"),
    (1, "NSE:NIFTY_PSU_BANK"),
    (1, "BSE:BANKEX"),
    (1, "NSE:NIFTY_FIN_SERVICE"),
    (1, "NSE:NIFTY_FINSRV25_50"),
    (1, "NSE:NIFTY_FINSEREXBNK"),
    (1, "NSE:NIFTY_CHEMICALS"),
    (1, "NSE:NIFTY_CONSR_DURBL"),
    (1, "NSE:NIFTY_FMCG"),
    (1, "NSE:NIFTY_HEALTHCARE"),
    (1, "NSE:NIFTY_PHARMA"),
    (1, "NSE:NIFTY_IT"),
    (1, "NSE:NIFTY_MEDIA"),
    (1, "NSE:NIFTY_METAL"),
    (1, "NSE:NIFTY_OIL_AND_GAS"),
    (1, "NSE:NIFTY_REALTY"),
    (1, "NSE:NIFTY_MS_FIN_SERV"),
    (1, "NSE:NIFTY_MIDSML_HLTH"),
    (1, "NSE:NIFTY_MS_IT_TELCM"),
    // Themes
    (2, "NSE:NIFTY_CAPITAL_MKT"),
    (2, "NSE:NIFTY_COMMODITIES"),
    (2, "NSE:NIFTY_CONSUMPTION"),
    (2, "NSE:NIFTY_CPSE"),
    (2, "NSE:NIFTY_ENERGY"),
    (2, "NSE:NIFTY_EV"),
    (2, "NSE:NIFTY_HOUSING"),
    (2, "NSE:NIFTY_IND_DEFENCE"),
    (2, "NSE:NIFTY_IND_DIGITAL"),
    (2, "NSE:NIFTY_INDIA_MFG"),
    (2, "NSE:NIFTY_IND_TOURISM"),
    (2, "NSE:NIFTY_INFRA"),
    (2, "NSE:NIFTY_MNC"),
    (2, "NSE:NIFTY_MOBILITY"),
    (2, "NSE:NIFTY_PSE"),
    (2, "NSE:NIFTY_RAILWAYS_PSU"),
    (2, "NSE:NIFTY_RURAL"),
    (2, "NSE:NIFTY_SERV_SECTOR"),
    (2, "NSE:NIFTY_TRANS_LOGIS"),
];

/// Every catalogue ticker, for the brokers' live tests.
#[cfg(test)]
pub fn catalog_tickers() -> impl Iterator<Item = &'static str> {
    CATALOG.iter().map(|(_, ticker)| *ticker)
}

/// The list from `available` (the tickers of the broker's instrument list): each section with its
/// symbols (`india:TICKER`, whichever broker listed them), and how many catalogue entries that
/// broker lacked.
pub fn plan(available: &HashSet<String>) -> (Vec<(&'static str, Vec<String>)>, usize) {
    let provider = INDIA;
    let mut sections: Vec<(&'static str, Vec<String>)> = SECTIONS.iter().map(|s| (*s, Vec::new())).collect();
    let mut missing = 0;
    for (section, ticker) in CATALOG {
        match Some(*ticker).filter(|t| available.contains(*t)) {
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
    let (sections, skipped) = plan(&available);
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
        for (section, t) in CATALOG {
            assert!(*section < SECTIONS.len());
            assert!(t.contains(':') && !t.contains(' '), "{t}");
            assert!(seen.insert(*t), "{t} twice");
        }
    }

    #[test]
    fn the_plan_keeps_what_the_broker_lists_in_catalogue_order() {
        let available: HashSet<String> = [
            "NSE:NIFTY_BANK",
            "NSE:NIFTY_50",
            "NSE:NIFTY_EV",
            "NSE:NOT_IN_THE_CATALOGUE",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let (sections, missing) = plan(&available);
        assert_eq!(
            sections,
            vec![
                ("Broad market", vec!["india:NSE:NIFTY_50".to_string()]),
                ("Sectors", vec!["india:NSE:NIFTY_BANK".to_string()]),
                ("Themes", vec!["india:NSE:NIFTY_EV".to_string()]),
            ]
        );
        assert_eq!(missing, CATALOG.len() - 3);
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
            ["india:NSE:NIFTY_50", "india:NSE:NIFTY_BANK", "india:NSE:NIFTY_IT"]
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
