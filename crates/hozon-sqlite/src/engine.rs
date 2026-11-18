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
        atomic::{AtomicBool, AtomicU64, Ordering},
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
    closed: bool,
    holder: Option<Holder>,
    pending: VecDeque<Pending>,
    commands: VecDeque<Command>,
    warnings: u64,
}
struct Shared {
    state: Mutex<State>,
    ready: Condvar,
}
pub(crate) struct Engine {
    shared: Arc<Shared>,
    readers: Arc<ReaderPool>,
    worker: Mutex<Option<JoinHandle<Result<()>>>>,
    options: OpenOptions,
    pub finished: AtomicBool,
}
impl Engine {
    pub fn open(path: &str, memory: bool, options: OpenOptions) -> Result<Self> {
        let connection = connect(path, &options, memory)?;
        let readers = Arc::new(ReaderPool::new(path, &options, memory)?);
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                closed: false,
                holder: None,
                pending: VecDeque::new(),
                commands: VecDeque::new(),
                warnings: 0,
            }),
            ready: Condvar::new(),
        });
        let worker_shared = shared.clone();
        let worker_readers = readers.clone();
        let worker_options = options.clone();
        let worker = thread::Builder::new()
            .name("hozon-sqlite-writer".into())
            .spawn(move || {
                run(
                    connection,
                    worker_shared,
                    worker_readers,
                    worker_options,
                    memory,
                )
            })?;
        Ok(Self {
            shared,
            readers,
            worker: Mutex::new(Some(worker)),
            options,
            finished: AtomicBool::new(false),
        })
    }
    pub fn begin(&self, timeout: Option<Duration>, label: Option<String>) -> Result<Admission> {
        let (reply, receiver) = mpsc::channel();
        {
            let mut state = lock(&self.shared.state);
            if state.closed {
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
            self.shared.ready.notify_one();
        }
        receiver.recv().map_err(|_| Error::WorkerStopped)?
    }
    fn send(&self, command: Command) -> Result<()> {
        let mut state = lock(&self.shared.state);
        if state.closed {
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
            if lock(&self.shared.state).closed {
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
        let state = lock(&self.shared.state);
        Stats {
            pending_admissions: state.pending.len(),
            admission_warnings: state.warnings,
        }
    }
    pub fn close(&self) -> Result<()> {
        // Holding this mutex through join makes concurrent close callers wait for shutdown.
        let mut worker = lock(&self.worker);
        let Some(handle) = worker.take() else {
            return Ok(());
        };
        lock(&self.shared.state).closed = true;
        self.shared.ready.notify_all();
        let result = handle
            .join()
            .map_err(|_| Error::WorkerStopped)
            .and_then(|result| result);
        self.finished.store(true, Ordering::Release);
        result
    }
}
impl Drop for Engine {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

fn expire(state: &mut State, options: &OpenOptions) {
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
                state.warnings += 1;
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
    memory: bool,
) -> Result<()> {
    loop {
        let mut state = lock(&shared.state);
        if state.closed {
            for pending in state.pending.drain(..) {
                let _ = pending.reply.send(Err(Error::Closed));
            }
            for command in state.commands.drain(..) {
                command.fail();
            }
            state.holder = None;
            drop(state);
            readers.close();
            if !connection.is_autocommit() {
                connection.execute_batch("ROLLBACK")?;
            }
            connection.flush_prepared_statement_cache();
            if !memory {
                let (busy, _, _): (i64, i64, i64) =
                    connection.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
                        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                    })?;
                if busy != 0 {
                    return Err(Error::InvalidInput(
                        "WAL checkpoint blocked by another connection".into(),
                    ));
                }
            }
            return connection.close().map_err(|(_, error)| error.into());
        }
        expire(&mut state, &options);
        // Admissions never occupy this command queue, so the holder can always finish.
        if let Some(command) = state.commands.pop_front() {
            drop(state);
            handle_command(&connection, &shared, command);
            continue;
        }
        if state.holder.is_none()
            && let Some(pending) = state.pending.pop_front()
        {
            // Expiry and BEGIN/grant share this critical section.
            match connection.execute_batch("BEGIN IMMEDIATE") {
                Ok(()) => {
                    let admission = Admission {
                        admission_id: pending.id,
                        tx_id: next_id(),
                    };
                    state.holder = Some(Holder {
                        admission,
                        label: pending.label,
                    });
                    if pending.reply.send(Ok(admission)).is_err() {
                        let _ = connection.execute_batch("ROLLBACK");
                        state.holder = None;
                    }
                }
                Err(error) => {
                    let _ = pending.reply.send(Err(error.into()));
                }
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
            // Poll only admission deadlines, including clocks injected by the host.
            let _ = shared
                .ready
                .wait_timeout(state, Duration::from_millis(2))
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
