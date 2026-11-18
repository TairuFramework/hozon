//! Each database owns a writer and reader pool. Lifecycle open/close uses one
//! process-wide control thread, so slow lifecycle work can delay other databases.
use crate::{
    Admission, AdmissionID, Error, Mode, OpenOptions, QueryResult, Result, Stats, TxID, Value,
    admission::{AdmissionWork, Holder, Pending},
    completion::{Completion, dispatch},
    reader::{ReaderPool, connect, lock},
    value,
};
use std::{
    collections::VecDeque,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    },
    thread::{self, JoinHandle},
    time::Duration,
};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);
pub(crate) fn next_id() -> u64 {
    NEXT_ID.fetch_add(1, Ordering::Relaxed)
}

enum Command {
    Execute {
        tx: TxID,
        sql: String,
        params: Vec<Value>,
        mode: Mode,
        reply: Completion<QueryResult>,
    },
    Finish {
        tx: TxID,
        commit: bool,
        reply: Completion<()>,
    },
    Abandon {
        id: AdmissionID,
        reply: Completion<()>,
    },
}
impl Command {
    fn fail(self, error: Error) {
        match self {
            Self::Execute { reply, .. } => {
                reply.complete(Err(error));
            }
            Self::Finish { reply, .. } | Self::Abandon { reply, .. } => {
                reply.complete(Err(error));
            }
        }
    }
}
struct State {
    holder: Option<Holder>,
    pending: VecDeque<Pending>,
    commands: VecDeque<Command>,
    granting: Option<AdmissionID>,
    stopping: bool,
}
struct Shared {
    closed: AtomicBool,
    failed: AtomicBool,
    pending: AtomicUsize,
    #[cfg(test)]
    after_sqlite_finish: Mutex<Option<crate::completion::Job>>,
    warnings: AtomicU64,
    state: Mutex<State>,
    ready: Condvar,
}
pub(crate) struct Engine {
    shared: Arc<Shared>,
    readers: Arc<ReaderPool>,
    worker: Mutex<Option<JoinHandle<Result<()>>>>,
    options: OpenOptions,
    interrupt: Arc<rusqlite::InterruptHandle>,
    temporary: Option<TemporaryDatabase>,
    pub finished: AtomicBool,
}
impl Engine {
    pub fn open(path: &str, memory: bool, options: OpenOptions) -> Result<Self> {
        let temporary = if memory {
            Some(TemporaryDatabase::new()?)
        } else {
            None
        };
        let path = temporary.as_ref().map_or(Ok(path), |file| {
            file.0
                .to_str()
                .ok_or_else(|| Error::InvalidInput("temporary path must be UTF-8".into()))
        })?;
        let connection = connect(path, &options)?;
        let interrupt = Arc::new(connection.get_interrupt_handle());
        let shared = Arc::new(Shared {
            closed: AtomicBool::new(false),
            failed: AtomicBool::new(false),
            pending: AtomicUsize::new(0),
            #[cfg(test)]
            after_sqlite_finish: Mutex::new(None),
            warnings: AtomicU64::new(0),
            state: Mutex::new(State {
                holder: None,
                pending: VecDeque::new(),
                commands: VecDeque::new(),
                granting: None,
                stopping: false,
            }),
            ready: Condvar::new(),
        });
        let failure_shared = shared.clone();
        let readers = Arc::new(ReaderPool::new(
            path,
            &options,
            Arc::new(move || shutdown(&failure_shared, true)),
        )?);
        let worker_shared = shared.clone();
        let worker_readers = readers.clone();
        let worker_options = options.clone();
        let worker = thread::Builder::new()
            .name("hozon-sqlite-writer".into())
            .spawn(move || {
                crate::completion::enter_engine_thread();
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    run(
                        connection,
                        worker_shared.clone(),
                        worker_readers.clone(),
                        worker_options,
                    )
                }))
                .unwrap_or(Err(Error::WorkerStopped));
                if result.is_err() {
                    worker_readers.fail();
                }
                shutdown(&worker_shared, result.is_err());
                worker_readers.close();
                result
            })?;
        Ok(Self {
            shared,
            readers,
            worker: Mutex::new(Some(worker)),
            options,
            interrupt,
            temporary,
            finished: AtomicBool::new(false),
        })
    }
    pub fn begin(
        &self,
        timeout: Option<Duration>,
        label: Option<String>,
        reply: Completion<Admission>,
    ) -> AdmissionID {
        self.admit(timeout, label, AdmissionWork::Begin(reply))
    }
    fn admit(
        &self,
        timeout: Option<Duration>,
        label: Option<String>,
        reply: AdmissionWork,
    ) -> AdmissionID {
        let id = next_id();
        // A custom clock may panic. Keep the completion outside the state lock until
        // all caller-side validation has finished, so its unwind guard can settle it.
        let started = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.options.clock.now()
        })) {
            Ok(now) => now,
            Err(_) => {
                reply.fail_async(Error::WorkerStopped);
                return id;
            }
        };
        let mut state = lock(&self.shared.state);
        if self.shared.closed.load(Ordering::Acquire) {
            drop(state);
            reply.fail_async(terminal_error(&self.shared));
            return id;
        }
        state.pending.push_back(Pending {
            id,
            started,
            timeout: timeout.unwrap_or(Duration::from_secs(10)),
            label,
            warned: false,
            reply,
        });
        self.shared.pending.fetch_add(1, Ordering::Release);
        self.shared.ready.notify_one();
        id
    }
    fn send(&self, command: Command) {
        let mut state = lock(&self.shared.state);
        if self.shared.closed.load(Ordering::Acquire) {
            drop(state);
            let error = terminal_error(&self.shared);
            dispatch(Box::new(move || command.fail(error)));
            return;
        }
        state.commands.push_back(command);
        self.shared.ready.notify_one();
    }
    pub fn execute(
        &self,
        tx: Option<TxID>,
        sql: String,
        params: Vec<Value>,
        mode: Mode,
        reply: Completion<QueryResult>,
    ) {
        if let Some(tx) = tx {
            self.send(Command::Execute {
                tx,
                sql,
                params,
                mode,
                reply,
            });
        } else if mode == Mode::Read {
            if self.shared.closed.load(Ordering::Acquire) {
                reply.fail_async(terminal_error(&self.shared));
            } else {
                self.readers.execute(sql, params, reply);
            }
        } else {
            self.admit(None, None, AdmissionWork::Execute { sql, params, reply });
        }
    }
    pub fn finish(&self, tx: TxID, commit: bool, reply: Completion<()>) {
        self.send(Command::Finish { tx, commit, reply });
    }
    pub fn abandon(&self, id: AdmissionID, reply: Completion<()>) {
        self.send(Command::Abandon { id, reply });
    }
    pub fn stats(&self) -> Stats {
        Stats {
            pending_admissions: self.shared.pending.load(Ordering::Acquire),
            admission_warnings: self.shared.warnings.load(Ordering::Acquire),
        }
    }
    pub fn close(&self) -> Result<()> {
        // Holding this mutex through join makes concurrent close callers wait for shutdown.
        let mut worker = lock(&self.worker);
        let Some(handle) = worker.take() else {
            return Ok(());
        };
        shutdown(&self.shared, false);
        // Repeat interrupts to cover a statement starting just after the close signal.
        while !handle.is_finished() {
            {
                let state = lock(&self.shared.state);
                if !state.stopping {
                    self.interrupt.interrupt();
                }
            }
            self.readers.interrupt();
            thread::sleep(Duration::from_millis(5));
        }
        let result = handle
            .join()
            .map_err(|_| Error::WorkerStopped)
            .and_then(|result| result);
        if let Some(temporary) = &self.temporary {
            temporary.remove();
        }
        self.finished.store(true, Ordering::Release);
        result
    }
}
impl Drop for Engine {
    fn drop(&mut self) {
        let own_worker = lock(&self.worker)
            .as_ref()
            .is_some_and(|handle| handle.thread().id() == thread::current().id());
        if own_worker || self.readers.owns_current_thread() {
            let handle = lock(&self.worker).take();
            let shared = self.shared.clone();
            let readers = self.readers.clone();
            let temporary = self.temporary.take();
            let interrupt = self.interrupt.clone();
            dispatch(Box::new(move || {
                shutdown(&shared, false);
                readers.interrupt();
                if let Some(handle) = handle {
                    while !handle.is_finished() {
                        if !lock(&shared.state).stopping {
                            interrupt.interrupt();
                        }
                        readers.interrupt();
                        thread::sleep(Duration::from_millis(5));
                    }
                    let _ = handle.join();
                }
                drop(temporary);
            }));
        } else {
            let _ = self.close();
        }
    }
}
fn terminal_error(shared: &Shared) -> Error {
    if shared.failed.load(Ordering::Acquire) {
        Error::WorkerStopped
    } else {
        Error::Closed
    }
}

fn expire(
    state: &mut State,
    shared: &Shared,
    options: &OpenOptions,
) -> Vec<(AdmissionWork, Error)> {
    let mut expired = Vec::new();
    let now = options.clock.now();
    let mut index = 0;
    while index < state.pending.len() {
        let pending = &mut state.pending[index];
        if now.saturating_sub(pending.started) < pending.timeout {
            index += 1;
            continue;
        }
        if options.expire_admissions {
            if let Some(pending) = state.pending.remove(index) {
                shared.pending.fetch_sub(1, Ordering::Release);
                expired.push((
                    pending.reply,
                    Error::AdmissionExpired {
                        admission_id: pending.id,
                        caller_label: pending.label,
                        holder_label: state
                            .holder
                            .as_ref()
                            .and_then(|holder| holder.label.clone()),
                    },
                ));
            }
        } else {
            if !pending.warned {
                pending.warned = true;
                shared.warnings.fetch_add(1, Ordering::Release);
                eprintln!(
                    "hozon-sqlite: admission {} waiting; caller stack: {:?}; holder stack: {:?}",
                    pending.id,
                    pending.label,
                    state
                        .holder
                        .as_ref()
                        .and_then(|holder| holder.label.as_ref())
                );
            }
            index += 1;
        }
    }
    expired
}

fn run(
    connection: rusqlite::Connection,
    shared: Arc<Shared>,
    readers: Arc<ReaderPool>,
    options: OpenOptions,
) -> Result<()> {
    loop {
        let mut state = lock(&shared.state);
        if shared.closed.load(Ordering::Acquire) {
            state.stopping = true;
            drop(state);
            readers.close();
            if !connection.is_autocommit() {
                connection.execute_batch("ROLLBACK")?;
            }
            connection.flush_prepared_statement_cache();
            {
                let checkpoint = checkpoint(&connection);
                if !matches!(checkpoint, Ok((0, _, _))) {
                    eprintln!("hozon-sqlite: WAL checkpoint incomplete on close: {checkpoint:?}");
                }
            }
            return connection.close().map_err(|(_, error)| error.into());
        }
        let expired = expire(&mut state, &shared, &options);
        if !expired.is_empty() {
            drop(state);
            for (reply, error) in expired {
                reply.fail(error);
            }
            continue;
        }
        // Admissions never occupy this command queue, so the holder can always finish.
        if let Some(command) = state.commands.pop_front() {
            drop(state);
            handle_command(&connection, &shared, command);
            continue;
        }
        if state.holder.is_none()
            && let Some(pending) = state.pending.front()
        {
            let id = pending.id;
            state.granting = Some(id);
            drop(state);
            let result = connection.execute_batch("BEGIN IMMEDIATE");
            let mut state = lock(&shared.state);
            // Expiry and grant are decided together after SQLite returns.
            let expired = expire(&mut state, &shared, &options);
            let granting = state.granting.take();
            let pending = state
                .pending
                .iter()
                .position(|pending| Some(pending.id) == granting)
                .and_then(|index| state.pending.remove(index));
            let mut granted = None;
            let mut failed = None;
            if let Some(pending) = pending {
                shared.pending.fetch_sub(1, Ordering::Release);
                match result {
                    Ok(()) if !shared.closed.load(Ordering::Acquire) => {
                        let admission = Admission {
                            admission_id: pending.id,
                            tx_id: next_id(),
                        };
                        state.holder = Some(Holder {
                            admission,
                            label: pending.label,
                        });
                        granted = Some((pending.reply, admission));
                    }
                    Ok(()) => failed = Some((pending.reply, terminal_error(&shared))),
                    Err(error) => failed = Some((pending.reply, error.into())),
                }
            }
            drop(state);
            for (reply, error) in expired {
                reply.fail(error);
            }
            if let Some((reply, admission)) = granted {
                match reply {
                    AdmissionWork::Begin(reply) => reply.complete(Ok(admission)),
                    AdmissionWork::Execute { sql, params, reply } => {
                        let mut result = value::execute(&connection, &sql, &params, Mode::Write);
                        if result.is_ok()
                            && let Err(error) = connection.execute_batch("COMMIT")
                        {
                            result = Err(error.into());
                        }
                        if !connection.is_autocommit() {
                            let _ = connection.execute_batch("ROLLBACK");
                        }
                        #[cfg(test)]
                        after_sqlite_finish(&shared);
                        release_if_finished(&connection, &shared);
                        if result.is_err() && shared.closed.load(Ordering::Acquire) {
                            result = Err(terminal_error(&shared));
                        }
                        reply.complete(result);
                    }
                }
                continue;
            }
            if let Some((reply, error)) = failed {
                reply.fail(error);
            }
            if !connection.is_autocommit() {
                connection.execute_batch("ROLLBACK")?;
            }
            continue;
        }
        if state.pending.is_empty()
            || (!options.expire_admissions && state.pending.iter().all(|pending| pending.warned))
        {
            // Idle databases and already-warned release waits need no periodic wakeups.
            drop(
                shared
                    .ready
                    .wait(state)
                    .unwrap_or_else(|poison| poison.into_inner()),
            );
        } else {
            let now = options.clock.now();
            let wait = state
                .pending
                .iter()
                .filter(|pending| !pending.warned)
                .map(|pending| {
                    pending
                        .timeout
                        .saturating_sub(now.saturating_sub(pending.started))
                })
                .min()
                .unwrap_or(Duration::from_millis(50))
                .min(Duration::from_millis(50));
            let _ = shared
                .ready
                .wait_timeout(state, wait)
                .unwrap_or_else(|poison| poison.into_inner());
        }
    }
}

fn active(shared: &Shared, tx: TxID) -> bool {
    lock(&shared.state)
        .holder
        .as_ref()
        .is_some_and(|holder| holder.admission.tx_id == tx)
}
fn release_if_finished(connection: &rusqlite::Connection, shared: &Shared) {
    if connection.is_autocommit() {
        lock(&shared.state).holder = None;
        shared.ready.notify_one();
    }
}
fn handle_command(connection: &rusqlite::Connection, shared: &Shared, command: Command) {
    match command {
        Command::Execute {
            tx,
            sql,
            params,
            mode,
            reply,
        } => {
            let result = if active(shared, tx) {
                value::execute(connection, &sql, &params, mode)
            } else {
                Err(Error::InvalidTransaction)
            };
            release_if_finished(connection, shared);
            reply.complete(if shared.closed.load(Ordering::Acquire) {
                Err(terminal_error(shared))
            } else {
                result
            });
        }
        Command::Finish { tx, commit, reply } => {
            let result = if active(shared, tx) {
                connection
                    .execute_batch(if commit { "COMMIT" } else { "ROLLBACK" })
                    .map_err(Error::from)
            } else {
                Err(Error::InvalidTransaction)
            };
            #[cfg(test)]
            after_sqlite_finish(shared);
            release_if_finished(connection, shared);
            reply.complete(
                if result.is_err() && shared.closed.load(Ordering::Acquire) {
                    Err(terminal_error(shared))
                } else {
                    result
                },
            );
        }
        Command::Abandon { id, reply } => {
            let mut state = lock(&shared.state);
            let holder = state
                .holder
                .as_ref()
                .is_some_and(|holder| holder.admission.admission_id == id);
            let pending = state
                .pending
                .iter()
                .position(|pending| pending.id == id)
                .and_then(|index| state.pending.remove(index));
            if pending.is_some() {
                shared.pending.fetch_sub(1, Ordering::Release);
            }
            drop(state);
            let result = if holder {
                connection.execute_batch("ROLLBACK").map_err(Error::from)
            } else {
                Ok(())
            };
            release_if_finished(connection, shared);
            shared.ready.notify_one();
            if let Some(pending) = pending {
                pending
                    .reply
                    .fail(Error::InvalidInput("admission abandoned".into()));
            }
            reply.complete(if shared.closed.load(Ordering::Acquire) {
                Err(terminal_error(shared))
            } else {
                result
            });
        }
    }
}

fn shutdown(shared: &Shared, failed: bool) {
    let (pending, commands) = {
        let mut state = lock(&shared.state);
        shared.failed.fetch_or(failed, Ordering::AcqRel);
        shared.closed.store(true, Ordering::Release);
        let pending = state.pending.drain(..).collect::<Vec<_>>();
        shared.pending.store(0, Ordering::Release);
        let commands = state.commands.drain(..).collect::<Vec<_>>();
        state.holder = None;
        (pending, commands)
    };
    shared.ready.notify_all();
    for pending in pending {
        pending.reply.fail(terminal_error(shared));
    }
    for command in commands {
        command.fail(terminal_error(shared));
    }
}

struct TemporaryDatabase(std::path::PathBuf);
impl TemporaryDatabase {
    fn new() -> Result<Self> {
        loop {
            let path = std::env::temp_dir().join(format!(
                "hozon-memory-{}-{}-{}.db",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos(),
                next_id()
            ));
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
            {
                Ok(_) => return Ok(Self(path)),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.into()),
            }
        }
    }
    fn remove(&self) {
        for suffix in ["", "-wal", "-shm"] {
            let mut path = self.0.as_os_str().to_os_string();
            path.push(suffix);
            let _ = std::fs::remove_file(path);
        }
    }
}
impl Drop for TemporaryDatabase {
    fn drop(&mut self) {
        self.remove();
    }
}

fn checkpoint(connection: &rusqlite::Connection) -> Result<(i64, i64, i64)> {
    // Unqualified checkpoint visits temp too. On a pristine zero-byte WAL file,
    // SQLite initializes WAL with a nested PRAGMA table_list; its temp read
    // transaction makes the subsequent temp checkpoint return SQLITE_LOCKED.
    // Only main owns persistent WAL data; temp has no WAL to checkpoint.
    Ok(
        connection.query_row("PRAGMA main.wal_checkpoint(TRUNCATE)", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pristine_wal_file_checkpoints_without_a_spurious_locked_error() {
        let temporary = TemporaryDatabase::new().unwrap();
        let connection = connect(temporary.0.to_str().unwrap(), &OpenOptions::default()).unwrap();
        assert!(!connection.is_busy());
        assert!(connection.is_autocommit());
        let result = checkpoint(&connection);
        assert!(matches!(result, Ok((0, _, _))), "{result:?}");
        connection.close().unwrap();
    }
}

#[cfg(test)]
fn after_sqlite_finish(shared: &Shared) {
    let hook = lock(&shared.after_sqlite_finish).take();
    if let Some(hook) = hook {
        hook();
    }
}

#[cfg(test)]
mod finish_race_tests {
    use super::*;
    use std::sync::mpsc;

    fn close_racing_write(explicit: bool) {
        let temporary = TemporaryDatabase::new().unwrap();
        let path = temporary.0.to_str().unwrap();
        for completed in [false, true] {
            let engine = Arc::new(Engine::open(path, false, OpenOptions::default()).unwrap());
            let setup = connect(path, &OpenOptions::default()).unwrap();
            setup
                .execute_batch("CREATE TABLE IF NOT EXISTS writes (id); DELETE FROM writes")
                .unwrap();
            drop(setup);
            let admission = if explicit {
                let (send, receive) = mpsc::channel();
                engine.begin(
                    None,
                    None,
                    Completion::new(Box::new(move |v| {
                        send.send(v).unwrap();
                    })),
                );
                let admission = receive
                    .recv_timeout(Duration::from_secs(3))
                    .unwrap()
                    .unwrap();
                let (send, receive) = mpsc::channel();
                engine.execute(
                    Some(admission.tx_id),
                    "INSERT INTO writes VALUES (1)".into(),
                    vec![],
                    Mode::Write,
                    Completion::new(Box::new(move |v| {
                        send.send(v).unwrap();
                    })),
                );
                receive
                    .recv_timeout(Duration::from_secs(3))
                    .unwrap()
                    .unwrap();
                Some(admission)
            } else {
                None
            };
            let (arrived, arrival) = mpsc::channel();
            let (resume, resumed) = mpsc::channel();
            // Pause after SQLite COMMIT and before the result reaches its callback.
            // The real close runs concurrently and marks the engine closed here.
            if completed {
                *lock(&engine.shared.after_sqlite_finish) = Some(Box::new(move || {
                    arrived.send(()).unwrap();
                    resumed.recv_timeout(Duration::from_secs(3)).unwrap();
                }));
            } else {
                engine.close().unwrap();
            }
            let (send, receive) = mpsc::channel();
            if let Some(admission) = admission {
                engine.finish(
                    admission.tx_id,
                    true,
                    Completion::new(Box::new(move |v| {
                        send.send(v).unwrap();
                    })),
                );
            } else {
                engine.execute(
                    None,
                    "INSERT INTO writes VALUES (1)".into(),
                    vec![],
                    Mode::Write,
                    Completion::new(Box::new(move |v| {
                        send.send(v.map(|_| ())).unwrap();
                    })),
                );
            }
            if completed {
                arrival.recv_timeout(Duration::from_secs(3)).unwrap();
                let closing = engine.clone();
                let close = thread::spawn(move || closing.close());
                let deadline = std::time::Instant::now() + Duration::from_secs(3);
                while !engine.shared.closed.load(Ordering::Acquire) {
                    assert!(std::time::Instant::now() < deadline);
                    thread::yield_now();
                }
                resume.send(()).unwrap();
                close.join().unwrap().unwrap();
            }
            let outcome = receive.recv_timeout(Duration::from_secs(3)).unwrap();
            let reopened = connect(path, &OpenOptions::default()).unwrap();
            let count: i64 = reopened
                .query_row("SELECT count(*) FROM writes", [], |row| row.get(0))
                .unwrap();
            if count == 1 {
                assert!(outcome.is_ok(), "durable commit reported {outcome:?}");
            } else {
                assert!(
                    matches!(outcome, Err(Error::Closed)),
                    "rolled back: {outcome:?}"
                );
            }
            assert_eq!(count, i64::from(completed));
        }
    }
    #[test]
    fn close_racing_commit_reports_durable_outcome() {
        close_racing_write(true);
    }
    #[test]
    fn close_racing_autocommit_reports_durable_outcome() {
        close_racing_write(false);
    }
}

#[cfg(test)]
mod drop_tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn unrelated_thread_with_reader_name_closes_synchronously() {
        let engine = Engine::open("", true, OpenOptions::default()).unwrap();
        let path = engine.temporary.as_ref().unwrap().0.clone();
        let (started, start) = mpsc::channel();
        let (resume, resumed) = mpsc::channel();
        dispatch(Box::new(move || {
            started.send(()).unwrap();
            let _ = resumed.recv_timeout(Duration::from_secs(3));
        }));
        start.recv_timeout(Duration::from_secs(3)).unwrap();
        let removed = thread::Builder::new()
            .name("hozon-sqlite-reader".into())
            .spawn(move || {
                drop(engine);
                !path.exists()
            })
            .unwrap()
            .join()
            .unwrap();
        resume.send(()).unwrap();
        assert!(
            removed,
            "unrelated named thread deferred this engine's close"
        );
    }
}
