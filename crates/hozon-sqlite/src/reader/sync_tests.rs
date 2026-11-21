use super::*;
use rusqlite::functions::FunctionFlags;
use std::{sync::mpsc, time::Duration};

struct Fixture {
    pool: Arc<ReaderPool>,
    path: std::path::PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "hozon-sync-pool-{}-{}.db",
            std::process::id(),
            crate::engine::next_id()
        ));
        let pool = Arc::new(
            ReaderPool::new(
                path.to_str().unwrap(),
                &OpenOptions {
                    readers: 1,
                    busy_timeout: Duration::from_millis(20),
                    ..OpenOptions::default()
                },
                Arc::new(|| {}),
            )
            .unwrap(),
        );
        Self { pool, path }
    }
    fn function(
        &self,
        f: impl FnMut(&rusqlite::functions::Context<'_>) -> rusqlite::Result<i64> + Send + 'static,
    ) {
        let f = Mutex::new(f);
        lock(&self.pool.shared.state)
            .sync_connection
            .as_ref()
            .unwrap()
            .create_scalar_function("probe", 1, FunctionFlags::SQLITE_UTF8, move |ctx| {
                lock(&f)(ctx)
            })
            .unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.pool.close();
        let _ = std::fs::remove_file(&self.path);
    }
}
const LONG: &str = "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n";

#[test]
fn sync_executes_on_caller_and_keeps_statement_snapshot() {
    let f = Fixture::new();
    let writer = Connection::open(&f.path).unwrap();
    writer
        .execute_batch("CREATE TABLE items(value); INSERT INTO items VALUES (1),(2)")
        .unwrap();
    let caller = thread::current().id();
    let (started, receive) = mpsc::channel();
    let (resume, resumed) = mpsc::channel();
    let mut first = true;
    f.function(move |ctx| {
        assert_eq!(thread::current().id(), caller);
        if first {
            first = false;
            started.send(()).unwrap();
            resumed.recv_timeout(Duration::from_secs(3)).unwrap();
        }
        ctx.get(0)
    });
    let commit = thread::spawn(move || {
        receive.recv_timeout(Duration::from_secs(3)).unwrap();
        writer
            .execute("UPDATE items SET value=value+10", [])
            .unwrap();
        resume.send(()).unwrap();
    });
    let result = f
        .pool
        .execute_read_sync("SELECT probe(value) FROM items", &[])
        .unwrap();
    commit.join().unwrap();
    assert_eq!(
        result.rows,
        vec![vec![Value::Integer(1)], vec![Value::Integer(2)]]
    );
    assert_eq!(
        f.pool
            .execute_read_sync("SELECT value FROM items", &[])
            .unwrap()
            .rows[0][0],
        Value::Integer(11)
    );
}

#[test]
fn leased_sync_connection_returns_busy_without_wait_and_close_drains() {
    let f = Fixture::new();
    let (started, receive) = mpsc::channel();
    let (resume, resumed) = mpsc::channel();
    f.function(move |_| {
        started.send(()).unwrap();
        resumed.recv_timeout(Duration::from_secs(3)).unwrap();
        Ok(1)
    });
    let pool = f.pool.clone();
    let read = thread::spawn(move || pool.execute_read_sync("SELECT probe(1)", &[]));
    receive.recv_timeout(Duration::from_secs(3)).unwrap();
    assert!(matches!(
        f.pool.execute_read_sync("SELECT 2", &[]),
        Err(Error::SyncReadBusy)
    ));
    let (closed, close_result) = mpsc::channel();
    let pool = f.pool.clone();
    let close = thread::spawn(move || {
        pool.close();
        closed.send(()).unwrap();
    });
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    while !lock(&f.pool.shared.state).closed {
        assert!(std::time::Instant::now() < deadline, "close did not start");
        thread::yield_now();
    }
    assert!(lock(&f.pool.shared.state).sync_leased);
    assert!(matches!(
        close_result.recv_timeout(Duration::from_millis(30)),
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    resume.send(()).unwrap();
    assert!(matches!(read.join().unwrap(), Err(Error::Closed)));
    close_result.recv_timeout(Duration::from_secs(3)).unwrap();
    close.join().unwrap();
    assert!(lock(&f.pool.shared.state).sync_connection.is_none());
}

#[test]
fn close_interrupts_long_sync_statement_and_failure_is_terminal() {
    let f = Fixture::new();
    let (started, receive) = mpsc::channel();
    f.function(move |_| {
        started.send(()).unwrap();
        Ok(1)
    });
    let pool = f.pool.clone();
    let read = thread::spawn(move || {
        pool.execute_read_sync("WITH RECURSIVE n(x) AS (VALUES(probe(1)) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n", &[])
    });
    receive.recv_timeout(Duration::from_secs(3)).unwrap();
    f.pool.close();
    assert!(matches!(read.join().unwrap(), Err(Error::Closed)));
    let f = Fixture::new();
    f.pool.fail();
    assert!(matches!(
        f.pool.execute_read_sync("SELECT 1", &[]),
        Err(Error::WorkerStopped)
    ));
}

#[test]
fn exhausted_async_pool_does_not_block_sync_read() {
    let f = Fixture::new();
    let (done, receive) = mpsc::channel();
    f.pool.execute(
        LONG.into(),
        vec![],
        Completion::new(Box::new(move |result| {
            done.send(result).unwrap();
        })),
    );
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    while !lock(&f.pool.shared.state).jobs.is_empty() {
        assert!(std::time::Instant::now() < deadline);
        thread::yield_now();
    }
    assert!(receive.try_recv().is_err());
    assert_eq!(
        f.pool.execute_read_sync("SELECT 42", &[]).unwrap().rows,
        vec![vec![Value::Integer(42)]]
    );
    f.pool.close();
    assert!(matches!(
        receive.recv_timeout(Duration::from_secs(3)).unwrap(),
        Err(Error::Closed)
    ));
}

#[test]
fn sqlite_busy_preserves_error_code_and_timeout() {
    let f = Fixture::new();
    let path = f.path.with_extension("locked.db");
    let external = Connection::open(&path).unwrap();
    external.execute_batch("CREATE TABLE items(value)").unwrap();
    // ATTACH is permitted by SQLite query_only; it does not mutate either database.
    f.pool
        .execute_read_sync(
            "ATTACH DATABASE ? AS locked",
            &[Value::Text(path.to_str().unwrap().into())],
        )
        .unwrap();
    external.execute_batch("BEGIN EXCLUSIVE").unwrap();
    let start = std::time::Instant::now();
    let error = f
        .pool
        .execute_read_sync("SELECT * FROM locked.items", &[])
        .unwrap_err();
    assert!(
        matches!(error, Error::SQLite(rusqlite::Error::SqliteFailure(e, _)) if e.code == rusqlite::ErrorCode::DatabaseBusy)
    );
    assert!(start.elapsed() >= Duration::from_millis(15));
    external.execute_batch("ROLLBACK").unwrap();
    f.pool.close();
    drop(external);
    std::fs::remove_file(path).unwrap();
}
