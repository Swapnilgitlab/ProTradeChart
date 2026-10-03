//! Where provider credentials live.
//!
//! An access token or API secret belongs in the operating system's credential
//! store — Windows Credential Manager, the macOS Keychain, or the Secret
//! Service on Linux — not in the app's SQLite file. When that store isn't
//! available (a Linux box with no keyring daemon, say) the credential is kept
//! in the database instead, and `Storage::Database` is reported so the UI can
//! say plainly that it's unencrypted rather than pretending otherwise.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use rusqlite::Connection;

use crate::store::provider_settings::{self as settings, Table};

const SERVICE: &str = "io.github.swapnilgitlab.protradechart";

/// How long what the credential store said is remembered. Writes made through [`Secrets`]
/// update it at once; this only bounds how stale a credential edited outside the app (in
/// Credential Manager, say) can be.
const CACHE_TTL: Duration = Duration::from_secs(60);

/// Where a stored credential ended up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Storage {
    Keychain,
    Database,
}

impl Storage {
    pub fn as_str(self) -> &'static str {
        match self {
            Storage::Keychain => "keychain",
            Storage::Database => "database",
        }
    }
}

/// A credential store. Errors are plain strings: callers only need to know
/// "it failed, use the fallback".
pub trait Keychain: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn set(&self, account: &str, secret: &str) -> Result<(), String>;
    fn delete(&self, account: &str) -> Result<(), String>;
}

/// The real thing, via the `keyring` crate.
pub struct OsKeychain;

impl OsKeychain {
    fn entry(account: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE, account).map_err(|e| e.to_string())
    }
}

impl Keychain for OsKeychain {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        match Self::entry(account)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        Self::entry(account)?.set_password(secret).map_err(|e| e.to_string())
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        match Self::entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

pub struct Secrets {
    keychain: Box<dyn Keychain>,
    /// What the OS store last said for each account (`None`: nothing there). Only that is
    /// kept: the database fallback is read afresh, as it is no OS call. Reading a credential
    /// used to be one, and a script's worth of data requests made thousands of them, each
    /// while holding the database lock every other command waits on.
    cache: Mutex<HashMap<String, (Option<String>, Instant)>>,
    ttl: Duration,
}

fn account(provider: &str, key: &str) -> String {
    format!("{provider}.{key}")
}

impl Secrets {
    pub fn new(keychain: Box<dyn Keychain>) -> Self {
        Secrets {
            keychain,
            cache: Mutex::new(HashMap::new()),
            ttl: CACHE_TTL,
        }
    }

    #[cfg(test)]
    fn with_ttl(keychain: Box<dyn Keychain>, ttl: Duration) -> Self {
        Secrets {
            ttl,
            ..Self::new(keychain)
        }
    }

    fn cache(&self) -> MutexGuard<'_, HashMap<String, (Option<String>, Instant)>> {
        self.cache.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Runs `read` on what the credential store holds for `account`, asking the OS only when
    /// that isn't remembered. The cache stays locked across the OS call so a write can't slip
    /// in between a read and the remembering of it. A failing store reads as empty, as it
    /// always has: callers go on to the database.
    fn keychain_value<R>(&self, account: &str, read: impl FnOnce(Option<&str>) -> R) -> R {
        let mut cache = self.cache();
        if cache.get(account).is_none_or(|(_, at)| at.elapsed() >= self.ttl) {
            let value = self.keychain.get(account).unwrap_or(None);
            cache.insert(account.to_string(), (value, Instant::now()));
        }
        read(cache.get(account).and_then(|(value, _)| value.as_deref()))
    }

    pub fn os() -> Self {
        Self::new(Box::new(OsKeychain))
    }

    pub fn get(&self, conn: &Connection, provider: &str, key: &str) -> rusqlite::Result<Option<String>> {
        match self.keychain_value(&account(provider, key), |v| v.map(str::to_owned)) {
            Some(secret) => Ok(Some(secret)),
            // Not in the keychain (or the keychain is unreachable): it may
            // have been saved to the fallback earlier.
            None => settings::get(conn, Table::FallbackSecrets, provider, key),
        }
    }

    /// Whether a credential has a value, without copying the value out.
    pub fn has(&self, conn: &Connection, provider: &str, key: &str) -> rusqlite::Result<bool> {
        if self.keychain_value(&account(provider, key), |v| v.is_some_and(|s| !s.is_empty())) {
            return Ok(true);
        }
        Ok(settings::get(conn, Table::FallbackSecrets, provider, key)?.is_some_and(|s| !s.is_empty()))
    }

    pub fn set(&self, conn: &Connection, provider: &str, key: &str, value: &str) -> rusqlite::Result<Storage> {
        let account = account(provider, key);
        let mut cache = self.cache();
        match self.keychain.set(&account, value) {
            Ok(()) => {
                cache.insert(account, (Some(value.to_string()), Instant::now()));
                // Never leave a stale unencrypted copy behind.
                settings::delete(conn, Table::FallbackSecrets, provider, key)?;
                Ok(Storage::Keychain)
            }
            Err(e) => {
                // The store may still hold an older value; let the next read ask it.
                cache.remove(&account);
                log::warn!("OS credential store unavailable ({e}); storing {provider}.{key} in the database");
                settings::set(conn, Table::FallbackSecrets, provider, key, value)?;
                Ok(Storage::Database)
            }
        }
    }

    pub fn delete(&self, conn: &Connection, provider: &str, key: &str) -> rusqlite::Result<()> {
        let account = account(provider, key);
        let mut cache = self.cache();
        if let Err(e) = self.keychain.delete(&account) {
            log::warn!("could not remove {provider}.{key} from the OS credential store: {e}");
        }
        cache.remove(&account);
        settings::delete(conn, Table::FallbackSecrets, provider, key)
    }

    /// Where a credential currently lives, or `None` if it isn't set.
    pub fn storage_of(&self, conn: &Connection, provider: &str, key: &str) -> rusqlite::Result<Option<Storage>> {
        if self.keychain_value(&account(provider, key), |v| v.is_some()) {
            return Ok(Some(Storage::Keychain));
        }
        Ok(settings::get(conn, Table::FallbackSecrets, provider, key)?.map(|_| Storage::Database))
    }
}

#[cfg(test)]
pub mod testing {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// An in-memory credential store for tests. It counts the reads that reach it, which is
    /// how a test tells an answer from the cache from a trip to the OS.
    #[derive(Default)]
    pub struct MemoryKeychain {
        pub secrets: Mutex<HashMap<String, String>>,
        pub reads: AtomicUsize,
    }

    impl MemoryKeychain {
        pub fn reads(&self) -> usize {
            self.reads.load(Ordering::SeqCst)
        }
    }

    impl Keychain for MemoryKeychain {
        fn get(&self, account: &str) -> Result<Option<String>, String> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            Ok(self.secrets.lock().unwrap().get(account).cloned())
        }
        fn set(&self, account: &str, secret: &str) -> Result<(), String> {
            self.secrets
                .lock()
                .unwrap()
                .insert(account.to_string(), secret.to_string());
            Ok(())
        }
        fn delete(&self, account: &str) -> Result<(), String> {
            self.secrets.lock().unwrap().remove(account);
            Ok(())
        }
    }

    /// Lets a test keep a handle on the store it hands to [`Secrets`].
    impl<T: Keychain> Keychain for Arc<T> {
        fn get(&self, account: &str) -> Result<Option<String>, String> {
            (**self).get(account)
        }
        fn set(&self, account: &str, secret: &str) -> Result<(), String> {
            (**self).set(account, secret)
        }
        fn delete(&self, account: &str) -> Result<(), String> {
            (**self).delete(account)
        }
    }

    /// A credential store that always fails, like a Linux desktop with no keyring.
    pub struct BrokenKeychain;

    impl Keychain for BrokenKeychain {
        fn get(&self, _: &str) -> Result<Option<String>, String> {
            Err("no secret service".into())
        }
        fn set(&self, _: &str, _: &str) -> Result<(), String> {
            Err("no secret service".into())
        }
        fn delete(&self, _: &str) -> Result<(), String> {
            Err("no secret service".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testing::*;
    use super::*;
    use crate::db::Database;
    use std::sync::Arc;

    #[test]
    fn a_working_keychain_holds_the_secret_and_the_database_never_sees_it() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        let secrets = Secrets::new(Box::new(MemoryKeychain::default()));

        assert_eq!(
            secrets.set(&conn, "zerodha", "accessToken", "tok").unwrap(),
            Storage::Keychain
        );
        assert_eq!(
            secrets.get(&conn, "zerodha", "accessToken").unwrap().as_deref(),
            Some("tok")
        );
        assert_eq!(
            secrets.storage_of(&conn, "zerodha", "accessToken").unwrap(),
            Some(Storage::Keychain)
        );
        assert_eq!(
            settings::get(&conn, Table::FallbackSecrets, "zerodha", "accessToken").unwrap(),
            None
        );
    }

    #[test]
    fn a_broken_keychain_falls_back_to_the_database_and_says_so() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        let secrets = Secrets::new(Box::new(BrokenKeychain));

        assert_eq!(
            secrets.set(&conn, "zerodha", "accessToken", "tok").unwrap(),
            Storage::Database
        );
        assert_eq!(
            secrets.get(&conn, "zerodha", "accessToken").unwrap().as_deref(),
            Some("tok")
        );
        assert_eq!(
            secrets.storage_of(&conn, "zerodha", "accessToken").unwrap(),
            Some(Storage::Database)
        );
    }

    #[test]
    fn moving_to_a_working_keychain_removes_the_old_unencrypted_copy() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        // First saved while the keychain was down...
        Secrets::new(Box::new(BrokenKeychain))
            .set(&conn, "zerodha", "accessToken", "old")
            .unwrap();
        // ...then saved again once it works.
        let secrets = Secrets::new(Box::new(MemoryKeychain::default()));
        secrets.set(&conn, "zerodha", "accessToken", "new").unwrap();

        assert_eq!(
            secrets.get(&conn, "zerodha", "accessToken").unwrap().as_deref(),
            Some("new")
        );
        assert_eq!(
            settings::get(&conn, Table::FallbackSecrets, "zerodha", "accessToken").unwrap(),
            None
        );
    }

    #[test]
    fn delete_clears_both_places_and_a_missing_secret_reads_as_none() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        let secrets = Secrets::new(Box::new(MemoryKeychain::default()));
        assert_eq!(secrets.get(&conn, "zerodha", "accessToken").unwrap(), None);

        secrets.set(&conn, "zerodha", "accessToken", "tok").unwrap();
        secrets.delete(&conn, "zerodha", "accessToken").unwrap();
        assert_eq!(secrets.get(&conn, "zerodha", "accessToken").unwrap(), None);
        assert_eq!(secrets.storage_of(&conn, "zerodha", "accessToken").unwrap(), None);
    }

    /// A store that already holds a token, as after an earlier launch, handed to a `Secrets`
    /// while the test keeps a handle on it.
    fn holding(token: &str) -> (Arc<MemoryKeychain>, Secrets) {
        let store = Arc::new(MemoryKeychain::default());
        store
            .secrets
            .lock()
            .unwrap()
            .insert("zerodha.accessToken".into(), token.into());
        let secrets = Secrets::new(Box::new(store.clone()));
        (store, secrets)
    }

    #[test]
    fn a_credential_is_read_from_the_os_once_and_then_from_memory() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        let (store, secrets) = holding("tok");
        for _ in 0..50 {
            assert_eq!(
                secrets.get(&conn, "zerodha", "accessToken").unwrap().as_deref(),
                Some("tok")
            );
            assert!(secrets.has(&conn, "zerodha", "accessToken").unwrap());
            assert_eq!(
                secrets.storage_of(&conn, "zerodha", "accessToken").unwrap(),
                Some(Storage::Keychain)
            );
        }
        assert_eq!(store.reads(), 1);
    }

    #[test]
    fn a_credential_that_is_not_set_is_remembered_as_not_set() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        let (store, secrets) = holding("tok");
        for _ in 0..50 {
            assert_eq!(secrets.get(&conn, "zerodha", "apiSecret").unwrap(), None);
            assert!(!secrets.has(&conn, "zerodha", "apiSecret").unwrap());
            assert_eq!(secrets.storage_of(&conn, "zerodha", "apiSecret").unwrap(), None);
        }
        assert_eq!(store.reads(), 1);
    }

    #[test]
    fn saving_replaces_what_is_remembered_so_the_next_read_sees_the_new_value() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        let (store, secrets) = holding("old");
        assert_eq!(
            secrets.get(&conn, "zerodha", "accessToken").unwrap().as_deref(),
            Some("old")
        );

        secrets.set(&conn, "zerodha", "accessToken", "new").unwrap();
        assert_eq!(
            secrets.get(&conn, "zerodha", "accessToken").unwrap().as_deref(),
            Some("new")
        );
        assert_eq!(
            store.reads(),
            1,
            "the new value came from memory, not from a second read"
        );
    }

    #[test]
    fn deleting_forgets_at_once() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        let (_store, secrets) = holding("tok");
        assert!(secrets.has(&conn, "zerodha", "accessToken").unwrap());

        secrets.delete(&conn, "zerodha", "accessToken").unwrap();
        assert_eq!(secrets.get(&conn, "zerodha", "accessToken").unwrap(), None);
        assert!(!secrets.has(&conn, "zerodha", "accessToken").unwrap());
        assert_eq!(secrets.storage_of(&conn, "zerodha", "accessToken").unwrap(), None);
    }

    #[test]
    fn a_credential_edited_outside_the_app_is_seen_once_the_memory_expires_and_not_before() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        let read = |secrets: &Secrets| secrets.get(&conn, "zerodha", "accessToken").unwrap();

        let (store, secrets) = holding("a");
        assert_eq!(read(&secrets).as_deref(), Some("a"));
        store
            .secrets
            .lock()
            .unwrap()
            .insert("zerodha.accessToken".into(), "b".into());
        assert_eq!(read(&secrets).as_deref(), Some("a"), "still remembered");

        let store = Arc::new(MemoryKeychain::default());
        store
            .secrets
            .lock()
            .unwrap()
            .insert("zerodha.accessToken".into(), "a".into());
        let secrets = Secrets::with_ttl(Box::new(store.clone()), Duration::ZERO);
        assert_eq!(read(&secrets).as_deref(), Some("a"));
        store
            .secrets
            .lock()
            .unwrap()
            .insert("zerodha.accessToken".into(), "b".into());
        assert_eq!(
            read(&secrets).as_deref(),
            Some("b"),
            "an expired answer is asked for again"
        );
    }

    #[test]
    fn a_broken_keychain_is_still_answered_from_the_database_by_every_kind_of_read() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        let secrets = Secrets::new(Box::new(BrokenKeychain));
        secrets.set(&conn, "zerodha", "accessToken", "tok").unwrap();

        assert!(secrets.has(&conn, "zerodha", "accessToken").unwrap());
        assert!(!secrets.has(&conn, "zerodha", "apiKey").unwrap());
        assert_eq!(
            secrets.get(&conn, "zerodha", "accessToken").unwrap().as_deref(),
            Some("tok")
        );
    }
}
