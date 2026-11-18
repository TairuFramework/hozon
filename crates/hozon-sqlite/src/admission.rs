use crate::{AdmissionID, Result, TxID};
use std::{
    sync::mpsc::Sender,
    time::{Duration, Instant},
};

/// Suspend-excluding elapsed time, injectable without replacing SQLite or threads.
pub trait Clock: Send + Sync {
    fn now(&self) -> Duration;
}

/// Rust's Unix Instant uses CLOCK_UPTIME_RAW on Apple and CLOCK_MONOTONIC on
/// Linux/Android. Neither includes system suspend time.
pub struct MonotonicClock(Instant);
impl Default for MonotonicClock {
    fn default() -> Self {
        Self(Instant::now())
    }
}
impl Clock for MonotonicClock {
    fn now(&self) -> Duration {
        self.0.elapsed()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Admission {
    pub admission_id: AdmissionID,
    pub tx_id: TxID,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct Stats {
    pub pending_admissions: usize,
    pub admission_warnings: u64,
}

pub(crate) struct Pending {
    pub id: AdmissionID,
    pub started: Duration,
    pub timeout: Duration,
    pub label: Option<String>,
    pub warned: bool,
    pub reply: Sender<Result<Admission>>,
}
pub(crate) struct Holder {
    pub admission: Admission,
    pub label: Option<String>,
}
