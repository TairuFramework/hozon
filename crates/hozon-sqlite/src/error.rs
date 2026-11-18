use crate::AdmissionID;
use std::fmt;

#[derive(Debug)]
pub enum Error {
    Closed,
    InvalidTransaction,
    InvalidInput(String),
    AlreadyOpen,
    AdmissionExpired {
        admission_id: AdmissionID,
        caller_label: Option<String>,
        holder_label: Option<String>,
    },
    SQLite(rusqlite::Error),
    IO(std::io::Error),
    WorkerStopped,
}
pub type Result<T> = std::result::Result<T, Error>;
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Closed => write!(f, "database is closed"),
            Self::InvalidTransaction => write!(f, "transaction is not active"),
            Self::InvalidInput(message) => write!(f, "invalid input: {message}"),
            Self::AlreadyOpen => write!(f, "database file already has a writer"),
            Self::AdmissionExpired {
                admission_id,
                caller_label,
                holder_label,
            } => write!(
                f,
                "admission {admission_id} expired; caller stack: {caller_label:?}; holder stack: {holder_label:?}"
            ),
            Self::SQLite(error) => write!(f, "SQLite: {error}"),
            Self::IO(error) => write!(f, "IO: {error}"),
            Self::WorkerStopped => write!(f, "database worker stopped"),
        }
    }
}
impl std::error::Error for Error {}
impl From<rusqlite::Error> for Error {
    fn from(value: rusqlite::Error) -> Self {
        Self::SQLite(value)
    }
}
impl From<std::io::Error> for Error {
    fn from(value: std::io::Error) -> Self {
        Self::IO(value)
    }
}
