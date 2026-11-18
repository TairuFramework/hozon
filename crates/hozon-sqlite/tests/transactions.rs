use hozon_sqlite::{Clock, Error, Mode, OpenOptions, Registry, Value};
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    registry: Arc<Registry>,
    db: u64,
    path: PathBuf,
}
impl Fixture {
    fn new(options: OpenOptions) -> Self {
        let path = std::env::temp_dir().join(format!(
            "hozon-engine-{}-{}.db",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let registry = Arc::new(Registry::new());
        let db = registry.open(&path, options).unwrap();
        registry
            .execute(
                db,
                None,
                "CREATE TABLE items(id INTEGER PRIMARY KEY, value)",
                &[],
                Mode::Write,
            )
            .unwrap();
        Self { registry, db, path }
    }
    fn count(&self, tx: Option<u64>) -> i64 {
        match self
            .registry
            .execute(self.db, tx, "SELECT count(*) FROM items", &[], Mode::Read)
            .unwrap()
            .rows[0][0]
        {
            Value::Integer(n) => n,
            _ => panic!("integer count expected"),
        }
    }
    fn queued(&self, n: usize) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while self.registry.stats(self.db).unwrap().pending_admissions != n {
            assert!(Instant::now() < deadline, "admission failed to queue");
            thread::yield_now();
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.registry.close(self.db);
        let _ = std::fs::remove_file(&self.path);
    }
}

#[test]
fn queued_writers_do_not_block_active_commands_and_are_fifo() {
    let f = Fixture::new(OpenOptions::default());
    let holder = f.registry.begin_write(f.db, None).unwrap();
    let mut threads = Vec::new();
    let order = Arc::new(std::sync::Mutex::new(Vec::new()));
    for i in 0..8 {
        let r = f.registry.clone();
        let db = f.db;
        let order = order.clone();
        threads.push(thread::spawn(move || {
            let a = r.begin_write(db, None).unwrap();
            order.lock().unwrap().push(i);
            r.commit(db, a.tx_id).unwrap();
        }));
        f.queued(i + 1);
    }
    f.registry
        .execute(
            f.db,
            Some(holder.tx_id),
            "SAVEPOINT nested",
            &[],
            Mode::Write,
        )
        .unwrap();
    f.registry
        .execute(
            f.db,
            Some(holder.tx_id),
            "INSERT INTO items(value) VALUES ('own')",
            &[],
            Mode::Write,
        )
        .unwrap();
    assert_eq!(f.count(Some(holder.tx_id)), 1);
    f.registry
        .execute(
            f.db,
            Some(holder.tx_id),
            "ROLLBACK TO nested",
            &[],
            Mode::Write,
        )
        .unwrap();
    f.registry
        .execute(f.db, Some(holder.tx_id), "RELEASE nested", &[], Mode::Write)
        .unwrap();
    f.registry.commit(f.db, holder.tx_id).unwrap();
    for t in threads {
        t.join().unwrap();
    }
    assert_eq!(*order.lock().unwrap(), (0..8).collect::<Vec<_>>());
    let hook = f.registry.begin_write(f.db, None).unwrap();
    f.registry.rollback(f.db, hook.tx_id).unwrap();
}

#[test]
fn autocommit_waits_for_rollback_and_readers_see_only_committed_rows() {
    let f = Fixture::new(OpenOptions::default());
    let a = f.registry.begin_write(f.db, None).unwrap();
    f.registry
        .execute(
            f.db,
            Some(a.tx_id),
            "INSERT INTO items VALUES (1, 'pending')",
            &[],
            Mode::Write,
        )
        .unwrap();
    assert_eq!(f.count(Some(a.tx_id)), 1);
    assert_eq!(f.count(None), 0);
    let r = f.registry.clone();
    let db = f.db;
    let t = thread::spawn(move || {
        r.execute(
            db,
            None,
            "INSERT INTO items VALUES (2, 'committed')",
            &[],
            Mode::Write,
        )
    });
    f.queued(1);
    f.registry.rollback(f.db, a.tx_id).unwrap();
    assert_eq!(t.join().unwrap().unwrap().changes, 1);
    assert_eq!(f.count(None), 1);
    let a = f.registry.begin_write(f.db, None).unwrap();
    f.registry
        .execute(
            f.db,
            Some(a.tx_id),
            "INSERT INTO items VALUES (3, 'commit')",
            &[],
            Mode::Write,
        )
        .unwrap();
    assert_eq!(f.count(None), 1);
    f.registry.commit(f.db, a.tx_id).unwrap();
    assert_eq!(f.count(None), 2);
}

#[test]
fn sqlite_values_and_returning_metadata_are_lossless() {
    let f = Fixture::new(OpenOptions::default());
    let values = vec![
        Value::Integer(i64::MAX),
        Value::Integer(i64::MIN),
        Value::Integer(1_i64 << 40),
        Value::Null,
        Value::Blob(vec![0, 255, 128]),
        Value::Real(1.25),
        Value::Text("{\"valid\":true}".into()),
        Value::Integer(0),
        Value::Integer(1),
    ];
    let result = f
        .registry
        .execute(
            f.db,
            None,
            "SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?",
            &values,
            Mode::Read,
        )
        .unwrap();
    assert_eq!(result.rows, vec![values]);
    assert_eq!(result.changes, 0);
    let result = f
        .registry
        .execute(
            f.db,
            None,
            "INSERT INTO items(id, value) VALUES (?, ?) RETURNING id, value",
            &[Value::Integer(i64::MAX), Value::Blob(vec![1, 2, 3])],
            Mode::Write,
        )
        .unwrap();
    assert_eq!(result.changes, 1);
    assert_eq!(result.last_insert_row_id, i64::MAX);
    assert_eq!(result.columns, vec!["id", "value"]);
    assert_eq!(
        result.rows[0],
        vec![Value::Integer(i64::MAX), Value::Blob(vec![1, 2, 3])]
    );
    assert_eq!(
        f.registry
            .execute(
                f.db,
                None,
                "UPDATE items SET value = NULL",
                &[],
                Mode::Write
            )
            .unwrap()
            .changes,
        1
    );
    assert!(
        f.registry
            .execute(
                f.db,
                None,
                "INSERT INTO items VALUES (2, 0)",
                &[],
                Mode::Read
            )
            .is_err()
    );
    assert_eq!(f.count(None), 1);
}

#[derive(Default)]
struct FakeClock(AtomicU64);
impl Clock for FakeClock {
    fn now(&self) -> Duration {
        Duration::from_millis(self.0.load(Ordering::SeqCst))
    }
}

#[test]
fn timeout_names_both_stacks_and_removes_the_admission() {
    let clock = Arc::new(FakeClock::default());
    let f = Fixture::new(OpenOptions {
        clock: clock.clone(),
        expire_admissions: true,
        ..OpenOptions::default()
    });
    let holder = f
        .registry
        .begin_write_labeled(f.db, None, Some("holder stack".into()))
        .unwrap();
    let r = f.registry.clone();
    let db = f.db;
    let t = thread::spawn(move || r.begin_write_labeled(db, None, Some("caller stack".into())));
    f.queued(1);
    clock.0.store(10_000, Ordering::SeqCst);
    match t.join().unwrap().unwrap_err() {
        Error::AdmissionExpired {
            caller_label,
            holder_label,
            ..
        } => {
            assert_eq!(caller_label.as_deref(), Some("caller stack"));
            assert_eq!(holder_label.as_deref(), Some("holder stack"));
        }
        other => panic!("unexpected error: {other}"),
    }
    assert_eq!(f.registry.stats(f.db).unwrap().pending_admissions, 0);
    f.registry.abandon(f.db, holder.admission_id).unwrap();
    assert!(
        f.registry
            .execute(f.db, Some(holder.tx_id), "SELECT 1", &[], Mode::Read)
            .is_err()
    );
    let next = f.registry.begin_write(f.db, None).unwrap();
    f.registry.rollback(f.db, next.tx_id).unwrap();
}

#[test]
fn grant_expiry_and_abandon_race_never_leaks_a_writer() {
    let clock = Arc::new(FakeClock::default());
    let f = Fixture::new(OpenOptions {
        clock: clock.clone(),
        expire_admissions: true,
        ..OpenOptions::default()
    });
    for i in 0..2000 {
        let base = i * 100;
        clock.0.store(base, Ordering::SeqCst);
        let holder = f.registry.begin_write(f.db, None).unwrap();
        let r = f.registry.clone();
        let db = f.db;
        let t = thread::spawn(move || r.begin_write(db, Some(Duration::from_millis(1))));
        f.queued(1);
        thread::scope(|s| {
            s.spawn(|| {
                clock.0.store(base + 1, Ordering::SeqCst);
            });
            f.registry.commit(f.db, holder.tx_id).unwrap();
        });
        match t.join().unwrap() {
            Ok(a) => {
                f.registry.abandon(f.db, a.admission_id).unwrap();
                assert!(f.registry.commit(f.db, a.tx_id).is_err());
            }
            Err(Error::AdmissionExpired { .. }) => (),
            Err(e) => panic!("unexpected: {e}"),
        }
        let next = f.registry.begin_write(f.db, None).unwrap();
        f.registry.rollback(f.db, next.tx_id).unwrap();
    }
}

#[test]
fn release_wait_warns_once_and_never_expires() {
    let clock = Arc::new(FakeClock::default());
    let f = Fixture::new(OpenOptions {
        clock: clock.clone(),
        expire_admissions: false,
        ..OpenOptions::default()
    });
    let holder = f.registry.begin_write(f.db, None).unwrap();
    let r = f.registry.clone();
    let db = f.db;
    let t = thread::spawn(move || r.begin_write(db, Some(Duration::from_millis(1))));
    f.queued(1);
    clock.0.store(100, Ordering::SeqCst);
    let deadline = Instant::now() + Duration::from_secs(5);
    while f.registry.stats(f.db).unwrap().admission_warnings == 0 {
        assert!(Instant::now() < deadline);
        thread::yield_now();
    }
    assert_eq!(f.registry.stats(f.db).unwrap().pending_admissions, 1);
    clock.0.store(1000, Ordering::SeqCst);
    f.registry.commit(f.db, holder.tx_id).unwrap();
    let a = t.join().unwrap().unwrap();
    assert_eq!(f.registry.stats(f.db).unwrap().admission_warnings, 1);
    f.registry.rollback(f.db, a.tx_id).unwrap();
}

#[test]
fn close_rolls_back_fails_waiters_checkpoints_and_is_idempotent() {
    let f = Fixture::new(OpenOptions::default());
    let a = f.registry.begin_write(f.db, None).unwrap();
    f.registry
        .execute(
            f.db,
            Some(a.tx_id),
            "INSERT INTO items VALUES (1, 'rollback')",
            &[],
            Mode::Write,
        )
        .unwrap();
    let r = f.registry.clone();
    let db = f.db;
    let t = thread::spawn(move || r.begin_write(db, None));
    f.queued(1);
    f.registry.close(f.db).unwrap();
    f.registry.close(f.db).unwrap();
    assert!(matches!(t.join().unwrap(), Err(Error::Closed)));
    assert!(
        f.registry
            .execute(f.db, Some(a.tx_id), "SELECT 1", &[], Mode::Read)
            .is_err()
    );
    let wal = PathBuf::from(format!("{}-wal", f.path.display()));
    assert!(!wal.exists() || std::fs::metadata(wal).unwrap().len() == 0);
    let reopened = f.registry.open(&f.path, OpenOptions::default()).unwrap();
    assert_eq!(
        f.registry
            .execute(
                reopened,
                None,
                "SELECT count(*) FROM items",
                &[],
                Mode::Read
            )
            .unwrap()
            .rows,
        vec![vec![Value::Integer(0)]]
    );
    f.registry.close(reopened).unwrap();
}

#[test]
fn open_pragmas_extensions_and_unique_file_owner() {
    let f = Fixture::new(OpenOptions {
        busy_timeout: Duration::from_millis(137),
        ..OpenOptions::default()
    });
    for (sql, value) in [
        ("PRAGMA foreign_keys", Value::Integer(1)),
        ("PRAGMA journal_mode", Value::Text("wal".into())),
        ("PRAGMA busy_timeout", Value::Integer(137)),
        ("SELECT json_extract('{\"n\":7}', '$.n')", Value::Integer(7)),
    ] {
        assert_eq!(
            f.registry
                .execute(f.db, None, sql, &[], Mode::Read)
                .unwrap()
                .rows[0][0],
            value
        );
    }
    f.registry
        .execute(
            f.db,
            None,
            "CREATE VIRTUAL TABLE search USING fts5(content)",
            &[],
            Mode::Write,
        )
        .unwrap();
    assert!(
        Registry::new()
            .open(&f.path, OpenOptions::default())
            .is_err()
    );
    assert!(f.registry.open(&f.path, OpenOptions::default()).is_err());
    assert!(
        f.registry
            .open(
                ":memory:",
                OpenOptions {
                    readers: 0,
                    ..OpenOptions::default()
                }
            )
            .is_err()
    );
    assert!(
        f.registry
            .open(
                ":memory:",
                OpenOptions {
                    encryption_key: Some("secret".into()),
                    ..OpenOptions::default()
                }
            )
            .is_err()
    );
}

#[test]
fn rejects_multiple_statements_and_transaction_control_without_losing_ownership() {
    let f = Fixture::new(OpenOptions::default());
    let a = f.registry.begin_write(f.db, None).unwrap();
    for sql in [
        "COMMIT",
        "-- caller SQL\nROLLBACK",
        "/* comment */ END TRANSACTION",
        "INSERT INTO items VALUES (1, 'bad'); INSERT INTO items VALUES (2, 'bad')",
    ] {
        assert!(
            f.registry
                .execute(f.db, Some(a.tx_id), sql, &[], Mode::Write)
                .is_err(),
            "must reject: {sql}"
        );
        assert_eq!(f.count(Some(a.tx_id)), 0);
    }
    f.registry.rollback(f.db, a.tx_id).unwrap();
    // An outside read must never leave an explicit transaction on a pooled connection.
    assert!(
        f.registry
            .execute(f.db, None, "BEGIN", &[], Mode::Read)
            .is_err()
    );
    assert!(
        f.registry
            .execute(f.db, None, "SAVEPOINT leaked", &[], Mode::Read)
            .is_err()
    );
}

#[test]
fn sqlite_failures_preserve_or_release_ownership_as_sqlite_requires() {
    let f = Fixture::new(OpenOptions::default());
    assert!(
        f.registry
            .execute(
                f.db,
                None,
                "INSERT INTO missing VALUES (1)",
                &[],
                Mode::Write
            )
            .is_err()
    );
    f.registry
        .execute(
            f.db,
            None,
            "CREATE TABLE child(id INTEGER REFERENCES items(id) DEFERRABLE INITIALLY DEFERRED)",
            &[],
            Mode::Write,
        )
        .unwrap();
    let a = f.registry.begin_write(f.db, None).unwrap();
    f.registry
        .execute(
            f.db,
            Some(a.tx_id),
            "INSERT INTO child VALUES (99)",
            &[],
            Mode::Write,
        )
        .unwrap();
    assert!(f.registry.commit(f.db, a.tx_id).is_err());
    f.registry.rollback(f.db, a.tx_id).unwrap();
    // Autocommit failure at COMMIT must also roll back and free the writer.
    assert!(
        f.registry
            .execute(
                f.db,
                None,
                "INSERT INTO child VALUES (100)",
                &[],
                Mode::Write
            )
            .is_err()
    );
    let a = f
        .registry
        .begin_write(f.db, Some(Duration::from_millis(20)))
        .unwrap();
    f.registry
        .execute(
            f.db,
            Some(a.tx_id),
            "INSERT INTO items VALUES (1, 'kept')",
            &[],
            Mode::Write,
        )
        .unwrap();
    assert!(
        f.registry
            .execute(
                f.db,
                Some(a.tx_id),
                "INSERT OR ROLLBACK INTO items VALUES (1, 'duplicate')",
                &[],
                Mode::Write
            )
            .is_err()
    );
    assert!(f.registry.commit(f.db, a.tx_id).is_err());
    let a = f.registry.begin_write(f.db, None).unwrap();
    f.registry.rollback(f.db, a.tx_id).unwrap();
    assert_eq!(f.count(None), 0);
}

#[test]
fn memory_database_is_shared_with_readers_and_can_be_reopened_independently() {
    let registry = Registry::new();
    let db = registry.open(":memory:", OpenOptions::default()).unwrap();
    registry
        .execute(db, None, "CREATE TABLE sample(n)", &[], Mode::Write)
        .unwrap();
    registry
        .execute(db, None, "INSERT INTO sample VALUES (7)", &[], Mode::Write)
        .unwrap();
    assert_eq!(
        registry
            .execute(db, None, "SELECT n FROM sample", &[], Mode::Read)
            .unwrap()
            .rows,
        vec![vec![Value::Integer(7)]]
    );
    assert_eq!(
        registry
            .execute(db, None, "PRAGMA journal_mode", &[], Mode::Read)
            .unwrap()
            .rows,
        vec![vec![Value::Text("wal".into())]]
    );
    registry.close(db).unwrap();
}

#[test]
fn ddl_and_queries_do_not_repeat_the_previous_dml_change_count() {
    let f = Fixture::new(OpenOptions::default());
    let a = f.registry.begin_write(f.db, None).unwrap();
    f.registry
        .execute(
            f.db,
            Some(a.tx_id),
            "INSERT INTO items VALUES (1, 'row')",
            &[],
            Mode::Write,
        )
        .unwrap();
    let ddl = f
        .registry
        .execute(
            f.db,
            Some(a.tx_id),
            "CREATE TABLE other(n)",
            &[],
            Mode::Write,
        )
        .unwrap();
    assert_eq!(ddl.changes, 0);
    let read = f
        .registry
        .execute(f.db, Some(a.tx_id), "SELECT * FROM items", &[], Mode::Read)
        .unwrap();
    assert_eq!(read.changes, 0);
    f.registry.commit(f.db, a.tx_id).unwrap();
}

#[cfg(unix)]
#[test]
fn file_aliases_cannot_acquire_a_second_writer() {
    let f = Fixture::new(OpenOptions::default());
    let alias = f.path.with_extension("hardlink");
    std::fs::hard_link(&f.path, &alias).unwrap();
    let registry = Registry::new();
    let result = registry.open(&alias, OpenOptions::default());
    if let Ok(db) = result {
        registry.close(db).unwrap();
    }
    std::fs::remove_file(alias).unwrap();
    assert!(matches!(result, Err(Error::AlreadyOpen)));
}

#[test]
fn abandoning_a_grant_after_the_callers_deadline_rolls_back_its_writes() {
    let clock = Arc::new(FakeClock::default());
    let f = Fixture::new(OpenOptions {
        clock: clock.clone(),
        expire_admissions: true,
        ..OpenOptions::default()
    });
    let holder = f.registry.begin_write(f.db, None).unwrap();
    let r = f.registry.clone();
    let db = f.db;
    let waiter = thread::spawn(move || r.begin_write(db, Some(Duration::from_secs(1))));
    f.queued(1);
    clock.0.store(999, Ordering::SeqCst);
    f.registry.commit(f.db, holder.tx_id).unwrap();
    let granted = waiter.join().unwrap().unwrap();
    f.registry
        .execute(
            f.db,
            Some(granted.tx_id),
            "INSERT INTO items VALUES (1, 'abandoned')",
            &[],
            Mode::Write,
        )
        .unwrap();
    clock.0.store(1000, Ordering::SeqCst);
    f.registry.abandon(f.db, granted.admission_id).unwrap();
    f.registry.abandon(f.db, granted.admission_id).unwrap();
    assert_eq!(f.count(None), 0);
    assert!(
        f.registry
            .execute(f.db, Some(granted.tx_id), "SELECT 1", &[], Mode::Read)
            .is_err()
    );
    let next = f.registry.begin_write(f.db, None).unwrap();
    f.registry.rollback(f.db, next.tx_id).unwrap();
}

#[test]
fn foreign_keys_and_sqlite_busy_timeout_are_enforced() {
    let f = Fixture::new(OpenOptions {
        busy_timeout: Duration::from_millis(40),
        ..OpenOptions::default()
    });
    f.registry
        .execute(
            f.db,
            None,
            "CREATE TABLE child(parent INTEGER REFERENCES items(id))",
            &[],
            Mode::Write,
        )
        .unwrap();
    assert!(
        f.registry
            .execute(
                f.db,
                None,
                "INSERT INTO child VALUES (99)",
                &[],
                Mode::Write
            )
            .is_err()
    );
    let other = rusqlite::Connection::open(&f.path).unwrap();
    other.execute_batch("BEGIN IMMEDIATE").unwrap();
    let start = Instant::now();
    let error = f.registry.begin_write(f.db, None).unwrap_err();
    assert!(
        matches!(error, Error::SQLite(rusqlite::Error::SqliteFailure(error, _)) if error.code == rusqlite::ErrorCode::DatabaseBusy)
    );
    assert!(start.elapsed() >= Duration::from_millis(25));
    other.execute_batch("ROLLBACK").unwrap();
    let next = f.registry.begin_write(f.db, None).unwrap();
    f.registry.rollback(f.db, next.tx_id).unwrap();
}

#[test]
fn oversized_busy_timeout_is_an_error_without_a_panic() {
    let result = std::panic::catch_unwind(|| {
        Registry::new().open(
            ":memory:",
            OpenOptions {
                busy_timeout: Duration::MAX,
                ..OpenOptions::default()
            },
        )
    });
    assert!(matches!(result, Ok(Err(Error::InvalidInput(_)))));
}

fn memory_path(registry: &Registry, db: u64) -> PathBuf {
    let result = registry
        .execute(db, None, "PRAGMA database_list", &[], Mode::Read)
        .unwrap();
    match &result.rows[0][2] {
        Value::Text(path) => PathBuf::from(path),
        other => panic!("expected filename, got {other:?}"),
    }
}

#[test]
fn memory_readers_see_committed_snapshots_and_opens_are_isolated() {
    let registry = Registry::new();
    let db = registry.open(":memory:", OpenOptions::default()).unwrap();
    registry
        .execute(db, None, "CREATE TABLE sample(n)", &[], Mode::Write)
        .unwrap();
    let a = registry.begin_write(db, None).unwrap();
    registry
        .execute(
            db,
            Some(a.tx_id),
            "INSERT INTO sample VALUES (1)",
            &[],
            Mode::Write,
        )
        .unwrap();
    assert_eq!(
        registry
            .execute(db, None, "SELECT count(*) FROM sample", &[], Mode::Read)
            .unwrap()
            .rows,
        vec![vec![Value::Integer(0)]]
    );
    registry.commit(db, a.tx_id).unwrap();
    let other = registry.open(":memory:", OpenOptions::default()).unwrap();
    assert!(
        registry
            .execute(other, None, "SELECT * FROM sample", &[], Mode::Read)
            .is_err()
    );
    registry.close(db).unwrap();
    registry.close(other).unwrap();
}

#[test]
fn memory_files_are_removed_on_close_and_drop() {
    for explicit_close in [true, false] {
        let registry = Registry::new();
        let db = registry.open(":memory:", OpenOptions::default()).unwrap();
        let path = memory_path(&registry, db);
        assert!(
            path.is_file(),
            "memory DB must have a temporary backing file"
        );
        assert!(
            path.canonicalize()
                .unwrap()
                .starts_with(std::env::temp_dir().canonicalize().unwrap())
        );
        if explicit_close {
            registry.close(db).unwrap();
        }
        drop(registry);
        for suffix in ["", "-wal", "-shm"] {
            assert!(!PathBuf::from(format!("{}{suffix}", path.display())).exists());
        }
    }
}

#[test]
fn memory_writer_runs_while_reader_statement_is_in_progress() {
    let registry = Registry::new();
    let db = registry.open(":memory:", OpenOptions::default()).unwrap();
    registry
        .execute(db, None, "CREATE TABLE sample(n)", &[], Mode::Write)
        .unwrap();
    registry
        .execute(
            db,
            None,
            "INSERT INTO sample VALUES (1), (2)",
            &[],
            Mode::Write,
        )
        .unwrap();
    // Open the same URI on the old implementation to reproduce shared-cache locks.
    let path = memory_path(&registry, db);
    let path = if path.as_os_str().is_empty() {
        format!("file:hozon-memory-{db}?mode=memory&cache=shared")
    } else {
        path.to_str().unwrap().to_owned()
    };
    let reader = rusqlite::Connection::open(path).unwrap();
    let mut statement = reader.prepare("SELECT * FROM sample").unwrap();
    let mut rows = statement.query([]).unwrap();
    assert!(rows.next().unwrap().is_some());
    registry
        .execute(db, None, "INSERT INTO sample VALUES (3)", &[], Mode::Write)
        .unwrap();
    drop(rows);
    drop(statement);
    drop(reader);
    registry.close(db).unwrap();
}

#[test]
fn busy_begin_does_not_block_reads_stats_or_enqueue_and_expires_before_grant() {
    use std::sync::mpsc;
    let clock = Arc::new(FakeClock::default());
    let f = Fixture::new(OpenOptions {
        busy_timeout: Duration::from_secs(2),
        expire_admissions: true,
        clock: clock.clone(),
        ..OpenOptions::default()
    });
    let other = rusqlite::Connection::open(&f.path).unwrap();
    other.execute_batch("BEGIN IMMEDIATE").unwrap();
    let r = f.registry.clone();
    let db = f.db;
    let waiter = thread::spawn(move || r.begin_write(db, Some(Duration::from_millis(10))));
    thread::sleep(Duration::from_millis(60));
    let r = f.registry.clone();
    let second = thread::spawn(move || r.begin_write(db, Some(Duration::from_millis(10))));
    let (reply, receive) = mpsc::channel();
    let r = f.registry.clone();
    let probe = thread::spawn(move || {
        let result = r.execute(db, None, "SELECT count(*) FROM items", &[], Mode::Read);
        let deadline = Instant::now() + Duration::from_millis(150);
        let stats = loop {
            let stats = r.stats(db).unwrap();
            if stats.pending_admissions == 2 || Instant::now() >= deadline {
                break stats;
            }
            thread::yield_now();
        };
        reply.send((result, stats)).unwrap();
    });
    let prompt = receive.recv_timeout(Duration::from_millis(250));
    clock.0.store(10, Ordering::SeqCst);
    other.execute_batch("ROLLBACK").unwrap();
    let admission = waiter.join().unwrap();
    if let Ok(a) = admission {
        f.registry.rollback(db, a.tx_id).unwrap();
    }
    let second = second.join().unwrap();
    if let Ok(a) = second {
        f.registry.rollback(db, a.tx_id).unwrap();
    }
    probe.join().unwrap();
    let (read, stats) = prompt.expect("read and stats blocked on BEGIN");
    assert!(read.is_ok());
    assert_eq!(stats.pending_admissions, 2);
    assert!(matches!(second, Err(Error::AdmissionExpired { .. })));
    assert!(matches!(admission, Err(Error::AdmissionExpired { .. })));
    let a = f.registry.begin_write(db, None).unwrap();
    f.registry.rollback(db, a.tx_id).unwrap();
}

#[derive(Default)]
struct ObservedClock {
    calls: AtomicU64,
    panic: std::sync::atomic::AtomicBool,
}
impl Clock for ObservedClock {
    fn now(&self) -> Duration {
        if thread::current().name() == Some("hozon-sqlite-writer") {
            assert!(!self.panic.load(Ordering::SeqCst), "injected worker panic");
            self.calls.fetch_add(1, Ordering::SeqCst);
        }
        Duration::ZERO
    }
}

#[test]
fn admission_waits_use_deadlines_instead_of_two_ms_polling() {
    let clock = Arc::new(ObservedClock::default());
    let f = Fixture::new(OpenOptions {
        clock: clock.clone(),
        ..OpenOptions::default()
    });
    let holder = f.registry.begin_write(f.db, None).unwrap();
    let r = f.registry.clone();
    let db = f.db;
    let waiter = thread::spawn(move || r.begin_write(db, None));
    f.queued(1);
    clock.calls.store(0, Ordering::SeqCst);
    thread::sleep(Duration::from_millis(160));
    let calls = clock.calls.load(Ordering::SeqCst);
    f.registry.rollback(db, holder.tx_id).unwrap();
    let a = waiter.join().unwrap().unwrap();
    f.registry.rollback(db, a.tx_id).unwrap();
    assert!(calls <= 8, "worker polled clock {calls} times in 160ms");
}

#[test]
fn worker_panic_during_begin_fails_pending_and_queued_commands() {
    use std::sync::mpsc;
    let clock = Arc::new(ObservedClock::default());
    let f = Fixture::new(OpenOptions {
        clock: clock.clone(),
        busy_timeout: Duration::from_secs(2),
        ..OpenOptions::default()
    });
    let other = rusqlite::Connection::open(&f.path).unwrap();
    other.execute_batch("BEGIN IMMEDIATE").unwrap();
    let (reply, receive) = mpsc::channel();
    let r = f.registry.clone();
    let db = f.db;
    thread::spawn(move || {
        let _ = reply.send(r.begin_write(db, None));
    });
    f.queued(1);
    thread::sleep(Duration::from_millis(60));
    let (reply, command) = mpsc::channel();
    let r = f.registry.clone();
    thread::spawn(move || {
        let _ = reply.send(r.execute(db, Some(u64::MAX), "SELECT 1", &[], Mode::Read));
    });
    clock.panic.store(true, Ordering::SeqCst);
    other.execute_batch("ROLLBACK").unwrap();
    let result = receive
        .recv_timeout(Duration::from_secs(1))
        .expect("worker panic stranded admission");
    assert!(matches!(result, Err(Error::Closed | Error::WorkerStopped)));
    let result = command
        .recv_timeout(Duration::from_secs(1))
        .expect("worker panic stranded command");
    assert!(matches!(result, Err(Error::Closed | Error::WorkerStopped)));
    assert!(matches!(
        f.registry.execute(db, None, "SELECT 1", &[], Mode::Read),
        Err(Error::Closed | Error::WorkerStopped)
    ));
}

#[test]
fn close_interrupts_a_long_running_reader_and_writer() {
    use std::sync::mpsc;
    for writer in [false, true] {
        let f = Fixture::new(OpenOptions::default());
        let tx = if writer {
            Some(f.registry.begin_write(f.db, None).unwrap().tx_id)
        } else {
            None
        };
        let r = f.registry.clone();
        let db = f.db;
        let (reply, receive) = mpsc::channel();
        let query = thread::spawn(move || {
            r.execute(db, tx,
            "WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<20000000) SELECT sum(x) FROM n", &[], Mode::Read)
        });
        thread::sleep(Duration::from_millis(60));
        let r = f.registry.clone();
        thread::spawn(move || {
            let _ = reply.send(r.close(db));
        });
        receive
            .recv_timeout(Duration::from_millis(200))
            .expect("close stranded on SQL")
            .unwrap();
        let error = query.join().unwrap().unwrap_err();
        assert!(matches!(
            error,
            Error::Closed | Error::SQLite(rusqlite::Error::SqliteFailure(_, _))
        ));
        assert!(error.to_string().contains("interrupt") || error.to_string().contains("closed"));
    }
}

#[test]
fn busy_checkpoint_warns_but_close_succeeds() {
    let f = Fixture::new(OpenOptions {
        busy_timeout: Duration::from_millis(40),
        ..OpenOptions::default()
    });
    let other = rusqlite::Connection::open(&f.path).unwrap();
    other.execute_batch("BEGIN; SELECT * FROM items;").unwrap();
    f.registry
        .execute(
            f.db,
            None,
            "INSERT INTO items VALUES (1, 'committed')",
            &[],
            Mode::Write,
        )
        .unwrap();
    f.registry
        .close(f.db)
        .expect("busy checkpoint must not fail close");
    f.registry.close(f.db).unwrap();
    other.execute_batch("ROLLBACK").unwrap();
}

#[test]
fn memory_pooled_reader_does_not_block_writer() {
    let registry = Arc::new(Registry::new());
    let db = registry.open(":memory:", OpenOptions::default()).unwrap();
    registry
        .execute(db, None, "CREATE TABLE sample(n)", &[], Mode::Write)
        .unwrap();
    registry
        .execute(
            db,
            None,
            "INSERT INTO sample VALUES (1), (2)",
            &[],
            Mode::Write,
        )
        .unwrap();
    let r = registry.clone();
    let reader = thread::spawn(move || {
        r.execute(db, None,
        "WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<20000000) SELECT sum(n.x + sample.n) FROM sample, n",
        &[], Mode::Read)
    });
    thread::sleep(Duration::from_millis(60));
    let write = registry.execute(db, None, "INSERT INTO sample VALUES (3)", &[], Mode::Write);
    let still_reading = !reader.is_finished();
    registry.close(db).unwrap();
    assert!(reader.join().unwrap().is_err());
    write.unwrap();
    assert!(still_reading, "reader must overlap the write");
}

#[test]
fn worker_panic_fails_pending_and_future_calls() {
    use std::sync::mpsc;
    let clock = Arc::new(ObservedClock::default());
    let f = Fixture::new(OpenOptions {
        clock: clock.clone(),
        ..OpenOptions::default()
    });
    let _holder = f.registry.begin_write(f.db, None).unwrap();
    clock.panic.store(true, Ordering::SeqCst);
    let (reply, receive) = mpsc::channel();
    let r = f.registry.clone();
    let db = f.db;
    thread::spawn(move || {
        let _ = reply.send(r.begin_write(db, None));
    });
    let result = receive
        .recv_timeout(Duration::from_secs(1))
        .expect("worker panic stranded admission");
    assert!(matches!(result, Err(Error::Closed | Error::WorkerStopped)));
    assert!(matches!(
        f.registry.execute(db, None, "SELECT 1", &[], Mode::Read),
        Err(Error::Closed | Error::WorkerStopped)
    ));
}
