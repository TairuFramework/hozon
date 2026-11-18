use crate::{
    Admission, AdmissionID, Error, Mode, OpenOptions, QueryResult, Result, Stats, TxID, Value,
    admission::{Holder, Pending},
    reader::{ReaderPool, connect, lock},
    value,
};
use std::{
    collections::VecDeque,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        mpsc::{self, Sender},
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
        reply: Sender<Result<QueryResult>>,
    },
    Finish {
        tx: TxID,
        commit: bool,
        reply: Sender<Result<()>>,
    },
    Abandon {
        id: AdmissionID,
        reply: Sender<Result<()>>,
    },
}
impl Command {
    fn fail(self) {
        match self {
            Self::Execute { reply, .. } => {
                let _ = reply.send(Err(Error::Closed));
            }
            Self::Finish { reply, .. } | Self::Abandon { reply, .. } => {
                let _ = reply.send(Err(Error::Closed));
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
    pending: AtomicUsize,
    warnings: AtomicU64,
    state: Mutex<State>,
    ready: Condvar,
}
pub(crate) struct Engine {
    shared: Arc<Shared>,
    readers: Arc<ReaderPool>,
    worker: Mutex<Option<JoinHandle<Result<()>>>>,
    options: OpenOptions,
    interrupt: rusqlite::InterruptHandle,
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
        let interrupt = connection.get_interrupt_handle();
        let readers = Arc::new(ReaderPool::new(path, &options)?);
        let shared = Arc::new(Shared {
            closed: AtomicBool::new(false),
            pending: AtomicUsize::new(0),
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
        let worker_shared = shared.clone();
        let worker_readers = readers.clone();
        let worker_options = options.clone();
        let worker = thread::Builder::new()
            .name("hozon-sqlite-writer".into())
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    run(
                        connection,
                        worker_shared.clone(),
                        worker_readers.clone(),
                        worker_options,
                    )
                }))
                .unwrap_or(Err(Error::WorkerStopped));
                shutdown(&worker_shared);
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
    pub fn begin(&self, timeout: Option<Duration>, label: Option<String>) -> Result<Admission> {
        let (reply, receiver) = mpsc::channel();
        {
            let mut state = lock(&self.shared.state);
            if self.shared.closed.load(Ordering::Acquire) {
                return Err(Error::Closed);
            }
            state.pending.push_back(Pending {
                id: next_id(),
                started: self.options.clock.now(),
                timeout: timeout.unwrap_or(Duration::from_secs(10)),
                label,
                warned: false,
                reply,
            });
            self.shared.pending.fetch_add(1, Ordering::Release);
            self.shared.ready.notify_one();
        }
        receiver.recv().map_err(|_| Error::WorkerStopped)?
    }
    fn send(&self, command: Command) -> Result<()> {
        let mut state = lock(&self.shared.state);
        if self.shared.closed.load(Ordering::Acquire) {
            return Err(Error::Closed);
        }
        state.commands.push_back(command);
        self.shared.ready.notify_one();
        Ok(())
    }
    pub fn execute(
        &self,
        tx: Option<TxID>,
        sql: &str,
        params: &[Value],
        mode: Mode,
    ) -> Result<QueryResult> {
        if let Some(tx) = tx {
            let (reply, receiver) = mpsc::channel();
            self.send(Command::Execute {
                tx,
                sql: sql.into(),
                params: params.to_vec(),
                mode,
                reply,
            })?;
            receiver.recv().map_err(|_| Error::WorkerStopped)?
        } else if mode == Mode::Read {
            if self.shared.closed.load(Ordering::Acquire) {
                return Err(Error::Closed);
            }
            self.readers.execute(sql, params)
        } else {
            let admission = self.begin(None, None)?;
            let result = self.execute(Some(admission.tx_id), sql, params, mode);
            match result {
                Ok(result) => {
                    if let Err(error) = self.finish(admission.tx_id, true) {
                        let _ = self.finish(admission.tx_id, false);
                        return Err(error);
                    }
                    Ok(result)
                }
                Err(error) => {
                    let _ = self.finish(admission.tx_id, false);
                    Err(error)
                }
            }
        }
    }
    pub fn finish(&self, tx: TxID, commit: bool) -> Result<()> {
        let (reply, receiver) = mpsc::channel();
        self.send(Command::Finish { tx, commit, reply })?;
        receiver.recv().map_err(|_| Error::WorkerStopped)?
    }
    pub fn abandon(&self, id: AdmissionID) -> Result<()> {
        let (reply, receiver) = mpsc::channel();
        self.send(Command::Abandon { id, reply })?;
        receiver.recv().map_err(|_| Error::WorkerStopped)?
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
        shutdown(&self.shared);
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
        let _ = self.close();
    }
}

fn expire(state: &mut State, shared: &Shared, options: &OpenOptions) {
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
                let _ = pending.reply.send(Err(Error::AdmissionExpired {
                    admission_id: pending.id,
                    caller_label: pending.label,
                    holder_label: state
                        .holder
                        .as_ref()
                        .and_then(|holder| holder.label.clone()),
                }));
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
                let checkpoint =
                    connection.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, i64>(2)?,
                        ))
                    });
                if !matches!(checkpoint, Ok((0, _, _))) {
                    eprintln!("hozon-sqlite: WAL checkpoint incomplete on close: {checkpoint:?}");
                }
            }
            return connection.close().map_err(|(_, error)| error.into());
        }
        expire(&mut state, &shared, &options);
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
            expire(&mut state, &shared, &options);
            let granting = state.granting.take();
            let pending = state
                .pending
                .iter()
                .position(|pending| Some(pending.id) == granting)
                .and_then(|index| state.pending.remove(index));
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
                        if pending.reply.send(Ok(admission)).is_ok() {
                            continue;
                        }
                        state.holder = None;
                    }
                    Ok(()) => {
                        let _ = pending.reply.send(Err(Error::Closed));
                    }
                    Err(error) => {
                        let _ = pending.reply.send(Err(error.into()));
                    }
                }
            }
            drop(state);
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
            let _ = reply.send(result);
        }
        Command::Finish { tx, commit, reply } => {
            let result = if active(shared, tx) {
                connection
                    .execute_batch(if commit { "COMMIT" } else { "ROLLBACK" })
                    .map_err(Error::from)
            } else {
                Err(Error::InvalidTransaction)
            };
            release_if_finished(connection, shared);
            let _ = reply.send(result);
        }
        Command::Abandon { id, reply } => {
            let mut state = lock(&shared.state);
            let result = if state
                .holder
                .as_ref()
                .is_some_and(|holder| holder.admission.admission_id == id)
            {
                let result = connection.execute_batch("ROLLBACK").map_err(Error::from);
                if connection.is_autocommit() {
                    state.holder = None;
                }
                result
            } else {
                if let Some(index) = state.pending.iter().position(|pending| pending.id == id)
                    && let Some(pending) = state.pending.remove(index)
                {
                    shared.pending.fetch_sub(1, Ordering::Release);
                    let _ = pending
                        .reply
                        .send(Err(Error::InvalidInput("admission abandoned".into())));
                }
                Ok(())
            };
            shared.ready.notify_one();
            let _ = reply.send(result);
        }
    }
}

fn shutdown(shared: &Shared) {
    let mut state = lock(&shared.state);
    shared.closed.store(true, Ordering::Release);
    for pending in state.pending.drain(..) {
        let _ = pending.reply.send(Err(Error::Closed));
    }
    shared.pending.store(0, Ordering::Release);
    for command in state.commands.drain(..) {
        command.fail();
    }
    state.holder = None;
    shared.ready.notify_all();
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
