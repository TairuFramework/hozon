//! Owned completions shared by Rust and FFI hosts. Callbacks must submit, not wait.
use crate::{Error, Result};
use std::{
    cell::Cell,
    panic::{AssertUnwindSafe, catch_unwind},
    sync::{OnceLock, mpsc},
    thread,
};

thread_local! { static ENGINE_THREAD: Cell<bool> = const { Cell::new(false) }; }
pub(crate) fn enter_engine_thread() {
    ENGINE_THREAD.set(true);
}

/// Invoked exactly once on an engine-owned thread. Submit follow-up work with
/// the callback API; blocking wrappers must not be called inside a callback.
pub type Callback<T> = Box<dyn FnOnce(Result<T>) + Send + 'static>;
pub(crate) type Job = Box<dyn FnOnce() + Send + 'static>;

/// Lifecycle work and failures after a worker has stopped use an engine-owned thread.
/// No task waits on admission or the reader pool here.
pub(crate) fn dispatch(job: Job) {
    static CONTROL: OnceLock<mpsc::Sender<Job>> = OnceLock::new();
    let sender = CONTROL.get_or_init(|| {
        let (send, receive) = mpsc::channel::<Job>();
        thread::Builder::new()
            .name("hozon-sqlite-control".into())
            .spawn(move || {
                enter_engine_thread();
                for job in receive {
                    let _ = catch_unwind(AssertUnwindSafe(job));
                }
            })
            .expect("unable to start SQLite lifecycle thread");
        send
    });
    // The process-wide receiver lives until process exit and catches job panics.
    if let Err(error) = sender.send(job) {
        let _ = catch_unwind(AssertUnwindSafe(error.0));
    }
}

/// An unwinding operation must still settle its owned completion exactly once.
pub(crate) struct Completion<T: Send + 'static>(Option<Callback<T>>);
impl<T: Send + 'static> Completion<T> {
    pub fn new(callback: Callback<T>) -> Self {
        Self(Some(callback))
    }
    pub fn complete(mut self, value: Result<T>) {
        if !ENGINE_THREAD.get() {
            dispatch(Box::new(move || self.complete(value)));
            return;
        }
        if let Some(callback) = self.0.take() {
            let _ = catch_unwind(AssertUnwindSafe(|| callback(value)));
        }
    }
    pub fn fail_async(self, error: Error) {
        dispatch(Box::new(move || self.complete(Err(error))));
    }
}
impl<T: Send + 'static> Drop for Completion<T> {
    fn drop(&mut self) {
        if let Some(callback) = self.0.take() {
            dispatch(Box::new(move || {
                let _ = catch_unwind(AssertUnwindSafe(|| callback(Err(Error::WorkerStopped))));
            }));
        }
    }
}

pub(crate) fn wait<T: Send + 'static>(submit: impl FnOnce(Callback<T>)) -> Result<T> {
    let (send, receive) = mpsc::channel();
    submit(Box::new(move |value| {
        let _ = send.send(value);
    }));
    receive.recv().map_err(|_| Error::WorkerStopped)?
}
