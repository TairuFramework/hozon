//! Blocking SQLite engine. FFI hosts must call it on worker threads.
#![forbid(unsafe_code)]

mod admission;
mod completion;
mod engine;
mod error;
mod job;
mod reader;
mod registry;
mod value;

pub use admission::{Admission, Clock, MonotonicClock, Stats, WritePriority};
pub use completion::Callback;
pub use error::{Error, Result};
pub use job::{TxConnection, TxJob};
pub use registry::Registry;
pub use rusqlite;
use std::{sync::Arc, time::Duration};
pub use value::{Mode, QueryResult, Value};

pub type DBID = u64;
pub type TxID = u64;
pub type AdmissionID = u64;

/// Admission expiry defaults to debug/test behaviour. Release never breaks ownership.
#[derive(Clone)]
pub struct OpenOptions {
    /// Pooled WAL readers see committed snapshots, including for `:memory:`.
    /// Each `:memory:` open uses an isolated temporary file deleted on close/drop.
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
