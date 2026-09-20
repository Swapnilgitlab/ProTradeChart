//! Where provider credentials live.
//!
//! An access token or API secret belongs in the operating system's credential
//! store — Windows Credential Manager, the macOS Keychain, or the Secret
//! Service on Linux — not in the app's SQLite file. When that store isn't
//! available (a Linux box with no keyring daemon, say) the credential is kept
//! in the database instead, and `Storage::Database` is reported so the UI can
//! say plainly that it's unencrypted rather than pretending otherwise.

use rusqlite::Connection;

use crate::store::provider_settings::{self as settings, Table};

const SERVICE: &str = "io.github.swapnilgitlab.protradechart";

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
}

fn account(provider: &str, key: &str) -> String {
    format!("{provider}.{key}")
}

impl Secrets {
    pub fn new(keychain: Box<dyn Keychain>) -> Self {
        Secrets { keychain }
    }

    pub fn os() -> Self {
        Self::new(Box::new(OsKeychain))
    }

    pub fn get(&self, conn: &Connection, provider: &str, key: &str) -> rusqlite::Result<Option<String>> {
        match self.keychain.get(&account(provider, key)) {
            Ok(Some(secret)) => Ok(Some(secret)),
            // Not in the keychain (or the keychain is unreachable): it may
            // have been saved to the fallback earlier.
            Ok(None) | Err(_) => settings::get(conn, Table::FallbackSecrets, provider, key),
        }
    }

    pub fn set(&self, conn: &Connection, provider: &str, key: &str, value: &str) -> rusqlite::Result<Storage> {
        match self.keychain.set(&account(provider, key), value) {
            Ok(()) => {
                // Never leave a stale unencrypted copy behind.
                settings::delete(conn, Table::FallbackSecrets, provider, key)?;
                Ok(Storage::Keychain)
            }
            Err(e) => {
                log::warn!("OS credential store unavailable ({e}); storing {provider}.{key} in the database");
                settings::set(conn, Table::FallbackSecrets, provider, key, value)?;
                Ok(Storage::Database)
            }
        }
    }

    pub fn delete(&self, conn: &Connection, provider: &str, key: &str) -> rusqlite::Result<()> {
        if let Err(e) = self.keychain.delete(&account(provider, key)) {
            log::warn!("could not remove {provider}.{key} from the OS credential store: {e}");
        }
        settings::delete(conn, Table::FallbackSecrets, provider, key)
    }

    /// Where a credential currently lives, or `None` if it isn't set.
    pub fn storage_of(&self, conn: &Connection, provider: &str, key: &str) -> rusqlite::Result<Option<Storage>> {
        if matches!(self.keychain.get(&account(provider, key)), Ok(Some(_))) {
            return Ok(Some(Storage::Keychain));
        }
        Ok(settings::get(conn, Table::FallbackSecrets, provider, key)?.map(|_| Storage::Database))
    }
}

#[cfg(test)]
pub mod testing {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// An in-memory credential store for tests.
    #[derive(Default)]
    pub struct MemoryKeychain(pub Mutex<HashMap<String, String>>);

    impl Keychain for MemoryKeychain {
        fn get(&self, account: &str) -> Result<Option<String>, String> {
            Ok(self.0.lock().unwrap().get(account).cloned())
        }
        fn set(&self, account: &str, secret: &str) -> Result<(), String> {
            self.0.lock().unwrap().insert(account.to_string(), secret.to_string());
            Ok(())
        }
        fn delete(&self, account: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(account);
            Ok(())
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

    #[test]
    fn a_working_keychain_holds_the_secret_and_the_database_never_sees_it() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        let secrets = Secrets::new(Box::new(MemoryKeychain::default()));

        assert_eq!(
            secrets.set(&conn, "dhan", "accessToken", "tok").unwrap(),
            Storage::Keychain
        );
        assert_eq!(
            secrets.get(&conn, "dhan", "accessToken").unwrap().as_deref(),
            Some("tok")
        );
        assert_eq!(
            secrets.storage_of(&conn, "dhan", "accessToken").unwrap(),
            Some(Storage::Keychain)
        );
        assert_eq!(
            settings::get(&conn, Table::FallbackSecrets, "dhan", "accessToken").unwrap(),
            None
        );
    }

    #[test]
    fn a_broken_keychain_falls_back_to_the_database_and_says_so() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        let secrets = Secrets::new(Box::new(BrokenKeychain));

        assert_eq!(
            secrets.set(&conn, "dhan", "accessToken", "tok").unwrap(),
            Storage::Database
        );
        assert_eq!(
            secrets.get(&conn, "dhan", "accessToken").unwrap().as_deref(),
            Some("tok")
        );
        assert_eq!(
            secrets.storage_of(&conn, "dhan", "accessToken").unwrap(),
            Some(Storage::Database)
        );
    }

    #[test]
    fn moving_to_a_working_keychain_removes_the_old_unencrypted_copy() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        // First saved while the keychain was down...
        Secrets::new(Box::new(BrokenKeychain))
            .set(&conn, "dhan", "accessToken", "old")
            .unwrap();
        // ...then saved again once it works.
        let secrets = Secrets::new(Box::new(MemoryKeychain::default()));
        secrets.set(&conn, "dhan", "accessToken", "new").unwrap();

        assert_eq!(
            secrets.get(&conn, "dhan", "accessToken").unwrap().as_deref(),
            Some("new")
        );
        assert_eq!(
            settings::get(&conn, Table::FallbackSecrets, "dhan", "accessToken").unwrap(),
            None
        );
    }

    #[test]
    fn delete_clears_both_places_and_a_missing_secret_reads_as_none() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        let secrets = Secrets::new(Box::new(MemoryKeychain::default()));
        assert_eq!(secrets.get(&conn, "dhan", "accessToken").unwrap(), None);

        secrets.set(&conn, "dhan", "accessToken", "tok").unwrap();
        secrets.delete(&conn, "dhan", "accessToken").unwrap();
        assert_eq!(secrets.get(&conn, "dhan", "accessToken").unwrap(), None);
        assert_eq!(secrets.storage_of(&conn, "dhan", "accessToken").unwrap(), None);
    }
}
