use crate::completion::Completion;
use crate::{Error, Mode, OpenOptions, QueryResult, Result, Value, value};
use rusqlite::Connection;
use std::{
    collections::VecDeque,
    panic::{AssertUnwindSafe, catch_unwind},
    sync::{Arc, Condvar, Mutex, MutexGuard},
    thread::{self, JoinHandle},
};

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

struct ReadJob {
    sql: String,
    params: Vec<Value>,
    reply: Completion<QueryResult>,
}
struct State {
    jobs: VecDeque<ReadJob>,
    closed: bool,
    failed: bool,
}
struct Shared {
    state: Mutex<State>,
    ready: Condvar,
}
pub(crate) struct ReaderPool {
    shared: Arc<Shared>,
    workers: Mutex<Vec<JoinHandle<()>>>,
    interrupts: Vec<rusqlite::InterruptHandle>,
    thread_ids: Vec<thread::ThreadId>,
}
impl ReaderPool {
    pub fn new(
        path: &str,
        options: &OpenOptions,
        on_failure: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<Self> {
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                jobs: VecDeque::new(),
                closed: false,
                failed: false,
            }),
            ready: Condvar::new(),
        });
        let mut pool = Self {
            shared,
            workers: Mutex::new(Vec::new()),
            interrupts: Vec::new(),
            thread_ids: Vec::new(),
        };
        for _ in 0..options.readers {
            let connection = connect(path, options)?;
            connection.pragma_update(None, "query_only", true)?;
            pool.interrupts.push(connection.get_interrupt_handle());
            let shared = pool.shared.clone();
            let on_failure = on_failure.clone();
            let worker = thread::Builder::new()
                .name("hozon-sqlite-reader".into())
                .spawn(move || {
                    crate::completion::enter_engine_thread();
                    let result =
                        catch_unwind(AssertUnwindSafe(|| reader_loop(&connection, &shared)));
                    // Finalize the reader's cached statements and close its connection before join returns.
                    drop(connection);
                    if result.is_err() {
                        stop(&shared, true);
                        on_failure();
                    }
                })?;
            pool.thread_ids.push(worker.thread().id());
            lock(&pool.workers).push(worker);
        }
        Ok(pool)
    }
    pub fn owns_current_thread(&self) -> bool {
        let current = thread::current().id();
        self.thread_ids.contains(&current)
    }
    pub fn execute(&self, sql: String, params: Vec<Value>, reply: Completion<QueryResult>) {
        let mut state = lock(&self.shared.state);
        if state.closed {
            let error = if state.failed {
                Error::WorkerStopped
            } else {
                Error::Closed
            };
            drop(state);
            reply.fail_async(error);
            return;
        }
        state.jobs.push_back(ReadJob { sql, params, reply });
        self.shared.ready.notify_one();
    }
    pub fn fail(&self) {
        stop(&self.shared, true);
        for interrupt in &self.interrupts {
            interrupt.interrupt();
        }
    }
    pub fn interrupt(&self) {
        stop(&self.shared, false);
        for interrupt in &self.interrupts {
            interrupt.interrupt();
        }
    }
    pub fn close(&self) {
        self.interrupt();
        // Only lifecycle/writer threads join readers; submission never waits for a connection.
        for worker in lock(&self.workers).drain(..) {
            while !worker.is_finished() {
                for interrupt in &self.interrupts {
                    interrupt.interrupt();
                }
                thread::sleep(std::time::Duration::from_millis(5));
            }
            let _ = worker.join();
        }
    }
}
impl Drop for ReaderPool {
    fn drop(&mut self) {
        self.close();
    }
}
fn stop(shared: &Shared, failed: bool) {
    let jobs = {
        let mut state = lock(&shared.state);
        state.closed = true;
        state.failed |= failed;
        let failed = state.failed;
        (state.jobs.drain(..).collect::<Vec<_>>(), failed)
    };
    shared.ready.notify_all();
    for job in jobs.0 {
        job.reply.complete(Err(if jobs.1 {
            Error::WorkerStopped
        } else {
            Error::Closed
        }));
    }
}
fn reader_loop(connection: &Connection, shared: &Shared) {
    loop {
        let job = {
            let mut state = lock(&shared.state);
            loop {
                if state.closed {
                    return;
                }
                if let Some(job) = state.jobs.pop_front() {
                    break job;
                }
                state = shared.ready.wait(state).unwrap_or_else(|p| p.into_inner());
            }
        };
        let result = value::execute(connection, &job.sql, &job.params, Mode::Read);
        let state = lock(&shared.state);
        let result = if state.closed {
            Err(if state.failed {
                Error::WorkerStopped
            } else {
                Error::Closed
            })
        } else {
            result
        };
        drop(state);
        job.reply.complete(result);
    }
}
