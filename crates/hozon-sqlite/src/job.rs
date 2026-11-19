//! Rust work on an active writer transaction, with no connection ownership escape.
use crate::{DBID, Error, Result, TxID, completion::Completion};
use rusqlite::{CachedStatement, Connection, Params, Row};
use std::panic::{AssertUnwindSafe, catch_unwind};

/// A borrowed writer connection. Transaction ownership stays with the engine.
pub struct TxConnection<'a> {
    connection: &'a Connection,
    db: DBID,
    tx: TxID,
}
impl TxConnection<'_> {
    pub fn db_id(&self) -> DBID {
        self.db
    }
    pub fn tx_id(&self) -> TxID {
        self.tx
    }
    pub fn prepare_cached(&self, sql: &str) -> Result<CachedStatement<'_>> {
        reject_transaction_control(sql)?;
        Ok(self.connection.prepare_cached(sql)?)
    }
    pub fn execute(&self, sql: &str, params: impl Params) -> Result<usize> {
        reject_transaction_control(sql)?;
        Ok(self.connection.execute(sql, params)?)
    }
    pub fn query_row<T>(
        &self,
        sql: &str,
        params: impl Params,
        f: impl FnOnce(&Row<'_>) -> rusqlite::Result<T>,
    ) -> Result<T> {
        reject_transaction_control(sql)?;
        Ok(self.connection.query_row(sql, params, f)?)
    }
    /// Roll back this span on errors and unwinding, preserving earlier writes.
    /// Nested calls are supported by SQLite's stack of identically named savepoints.
    pub fn atomic<T>(&self, f: impl FnOnce(&TxConnection<'_>) -> Result<T>) -> Result<T> {
        self.connection.execute_batch("SAVEPOINT hozon_job")?;
        let mut guard = Savepoint {
            connection: self.connection,
            released: false,
        };
        let value = f(self)?;
        self.connection.execute_batch("RELEASE hozon_job")?;
        guard.released = true;
        Ok(value)
    }
}
struct Savepoint<'a> {
    connection: &'a Connection,
    released: bool,
}
impl Drop for Savepoint<'_> {
    fn drop(&mut self) {
        if !self.released {
            // Never replace the original error or double-panic during unwinding.
            // A SQLite-initiated whole-transaction rollback is detected by Job::run.
            let _ = self
                .connection
                .execute_batch("ROLLBACK TO hozon_job; RELEASE hozon_job");
        }
    }
}

fn reject_transaction_control(mut sql: &str) -> Result<()> {
    loop {
        sql = sql
            .trim_start_matches(|c: char| c.is_ascii_whitespace() || c == ';' || c == '\u{feff}');
        if sql.starts_with("--") {
            sql = sql.find('\n').map_or("", |index| &sql[index + 1..]);
        } else if sql.starts_with("/*") {
            sql = sql.find("*/").map_or("", |index| &sql[index + 2..]);
        } else {
            break;
        }
    }
    let end = sql
        .find(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .unwrap_or(sql.len());
    if ["BEGIN", "COMMIT", "END", "ROLLBACK", "SAVEPOINT", "RELEASE"]
        .iter()
        .any(|word| sql[..end].eq_ignore_ascii_case(word))
    {
        return Err(Error::InvalidInput(
            "transaction control is forbidden in jobs".into(),
        ));
    }
    Ok(())
}

/// Work executed on the writer thread. Jobs must not call blocking registry APIs;
/// use the borrowed connection or submit follow-up work through callback APIs.
pub type TxJob<T> = Box<dyn FnOnce(&TxConnection<'_>) -> Result<T> + Send + 'static>;

pub(crate) trait JobCommand: Send {
    fn run(self: Box<Self>, connection: &Connection, terminal: &dyn Fn() -> Option<Error>);
    fn fail(self: Box<Self>, error: Error);
}
pub(crate) struct Job<T: Send + 'static> {
    pub db: DBID,
    pub tx: TxID,
    pub job: TxJob<T>,
    pub reply: Completion<T>,
}
impl<T: Send + 'static> JobCommand for Job<T> {
    fn run(self: Box<Self>, connection: &Connection, terminal: &dyn Fn() -> Option<Error>) {
        if connection.is_autocommit() {
            self.fail(Error::InvalidTransaction);
            return;
        }
        let Self { db, tx, job, reply } = *self;
        let result = catch_unwind(AssertUnwindSafe(|| {
            job(&TxConnection { connection, db, tx })
        }))
        .unwrap_or(Err(Error::JobPanic));
        reply.complete(if let Some(error) = terminal() {
            Err(error)
        } else if connection.is_autocommit() {
            Err(Error::JobEndedTransaction)
        } else {
            result
        });
    }
    fn fail(self: Box<Self>, error: Error) {
        self.reply.complete(Err(error));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    };

    #[test]
    fn autocommit_connection_rejects_job_without_running_it() {
        let connection = Connection::open_in_memory().unwrap();
        let ran = Arc::new(AtomicBool::new(false));
        let invoked = ran.clone();
        let (send, receive) = mpsc::channel();
        Box::new(Job {
            db: 1,
            tx: 2,
            job: Box::new(move |_| {
                invoked.store(true, Ordering::SeqCst);
                Ok(())
            }),
            reply: Completion::new(Box::new(move |result| send.send(result).unwrap())),
        })
        .run(&connection, &|| None);
        assert!(matches!(
            receive
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap(),
            Err(Error::InvalidTransaction)
        ));
        assert!(!ran.load(Ordering::SeqCst));
    }
}
