//! SQLite transaction engine for Hozon: one writer thread per database file, FIFO write
//! admission and pooled WAL readers.
#![forbid(unsafe_code)]

/// SQLite library version linked into this crate.
pub fn sqlite_version() -> &'static str {
    rusqlite::version()
}

#[cfg(test)]
mod tests {
    #[test]
    fn links_bundled_sqlite() {
        assert!(super::sqlite_version().starts_with('3'));
    }
}
