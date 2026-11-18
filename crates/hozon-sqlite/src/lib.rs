//! Blocking SQLite engine. FFI hosts must call it on worker threads.
#![forbid(unsafe_code)]

mod admission;
mod engine;
mod error;
mod reader;
mod registry;
mod value;

pub use admission::{Admission, Clock, MonotonicClock, Stats};
pub use error::{Error, Result};
pub use registry::Registry;
use std::{sync::Arc, time::Duration};
pub use value::{Mode, QueryResult, Value};

pub type DBID = u64;
pub type TxID = u64;
pub type AdmissionID = u64;

/// Admission expiry defaults to debug/test behaviour. Release never breaks ownership.
#[derive(Clone)]
pub struct OpenOptions {
    /// File databases use WAL snapshots. `:memory:` uses SQLite shared-cache
    /// readers instead; reads of tables locked by a writer can return SQLITE_LOCKED.
    pub readers: usize,
    pub busy_timeout: Duration,
    pub expire_admissions: bool,
    pub clock: Arc<dyn Clock>,
    pub encryption_key: Option<String>,
}
impl Default for OpenOptions {
    fn default() -> Self {
        Self {
            readers: 4,
            busy_timeout: Duration::from_secs(5),
            expire_admissions: cfg!(debug_assertions),
            clock: Arc::new(MonotonicClock::default()),
            encryption_key: None,
        }
    }
}

pub fn sqlite_version() -> &'static str {
    rusqlite::version()
}
