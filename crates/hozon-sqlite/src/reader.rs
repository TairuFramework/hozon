use crate::{Error, Mode, OpenOptions, QueryResult, Result, Value, value};
use rusqlite::Connection;
use std::sync::{Condvar, Mutex, MutexGuard};

pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

pub(crate) fn connect(path: &str, options: &OpenOptions, memory: bool) -> Result<Connection> {
    let connection = Connection::open(path)?;
    connection.busy_timeout(options.busy_timeout)?;
    connection.pragma_update(None, "foreign_keys", true)?;
    if !memory {
        let mode: String =
            connection.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
        if !mode.eq_ignore_ascii_case("wal") {
            return Err(Error::InvalidInput("WAL journal mode unavailable".into()));
        }
    }
    connection.set_prepared_statement_cache_capacity(64);
    let _: String = connection.query_row("SELECT json('{}')", [], |row| row.get(0))?;
    connection.execute_batch("CREATE VIRTUAL TABLE temp.__hozon_fts_check USING fts5(value); DROP TABLE temp.__hozon_fts_check;")?;
    Ok(connection)
}

struct State {
    idle: Vec<Connection>,
    in_use: usize,
    closed: bool,
}
pub(crate) struct ReaderPool {
    state: Mutex<State>,
    ready: Condvar,
}
impl ReaderPool {
    pub fn new(path: &str, options: &OpenOptions, memory: bool) -> Result<Self> {
        let mut idle = Vec::new();
        for _ in 0..options.readers {
            let connection = connect(path, options, memory)?;
            connection.pragma_update(None, "query_only", true)?;
            idle.push(connection);
        }
        Ok(Self {
            state: Mutex::new(State {
                idle,
                in_use: 0,
                closed: false,
            }),
            ready: Condvar::new(),
        })
    }
    pub fn execute(&self, sql: &str, params: &[Value]) -> Result<QueryResult> {
        let connection = {
            let mut state = lock(&self.state);
            loop {
                if state.closed {
                    return Err(Error::Closed);
                }
                if let Some(connection) = state.idle.pop() {
                    state.in_use += 1;
                    break connection;
                }
                state = self
                    .ready
                    .wait(state)
                    .unwrap_or_else(|poison| poison.into_inner());
            }
        };
        let result = value::execute(&connection, sql, params, Mode::Read);
        let mut state = lock(&self.state);
        if state.closed {
            drop(connection);
        } else {
            state.idle.push(connection);
        }
        state.in_use -= 1;
        self.ready.notify_all();
        result
    }
    pub fn close(&self) {
        let mut state = lock(&self.state);
        state.closed = true;
        state.idle.clear();
        self.ready.notify_all();
        while state.in_use > 0 {
            state = self
                .ready
                .wait(state)
                .unwrap_or_else(|poison| poison.into_inner());
        }
    }
}
