use crate::{Error, Mode, OpenOptions, QueryResult, Result, Value, value};
use rusqlite::Connection;
use std::sync::{Condvar, Mutex, MutexGuard};

pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

pub(crate) fn connect(path: &str, options: &OpenOptions) -> Result<Connection> {
    let connection = Connection::open(path)?;
    connection.busy_timeout(options.busy_timeout)?;
    connection.pragma_update(None, "foreign_keys", true)?;
    {
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
    interrupts: Vec<rusqlite::InterruptHandle>,
}
impl ReaderPool {
    pub fn new(path: &str, options: &OpenOptions) -> Result<Self> {
        let mut idle = Vec::new();
        let mut interrupts = Vec::new();
        for _ in 0..options.readers {
            let connection = connect(path, options)?;
            connection.pragma_update(None, "query_only", true)?;
            interrupts.push(connection.get_interrupt_handle());
            idle.push(connection);
        }
        Ok(Self {
            state: Mutex::new(State {
                idle,
                in_use: 0,
                closed: false,
            }),
            ready: Condvar::new(),
            interrupts,
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
    pub fn interrupt(&self) {
        let mut state = lock(&self.state);
        state.closed = true;
        state.idle.clear();
        for interrupt in &self.interrupts {
            interrupt.interrupt();
        }
        self.ready.notify_all();
    }
    pub fn close(&self) {
        self.interrupt();
        let mut state = lock(&self.state);
        state.closed = true;
        state.idle.clear();
        self.ready.notify_all();
        while state.in_use > 0 {
            for interrupt in &self.interrupts {
                interrupt.interrupt();
            }
            state = self
                .ready
                .wait_timeout(state, std::time::Duration::from_millis(5))
                .unwrap_or_else(|poison| poison.into_inner())
                .0;
        }
    }
}
