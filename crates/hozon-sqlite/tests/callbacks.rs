use hozon_sqlite::{Callback, Error, Mode, OpenOptions, Registry, Value};
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
    mpsc,
};
use std::time::Duration;

fn result<T: Send + 'static>(submit: impl FnOnce(Callback<T>)) -> hozon_sqlite::Result<T> {
    let (send, receive) = mpsc::channel();
    submit(Box::new(move |value| {
        send.send(value).unwrap();
    }));
    receive
        .recv_timeout(Duration::from_secs(3))
        .expect("callback stranded")
}

#[test]
fn callbacks_cover_operations_and_commit_can_submit_begin() {
    let registry = Arc::new(Registry::new());
    let caller = std::thread::current().id();
    let db = result(|cb| {
        registry.open_async(
            ":memory:",
            OpenOptions::default(),
            Box::new(move |value| {
                assert_ne!(caller, std::thread::current().id());
                cb(value);
            }),
        )
    })
    .unwrap();
    result(|cb| {
        registry.execute_async(
            db,
            None,
            "CREATE TABLE sample (id INTEGER)",
            &[],
            Mode::Write,
            cb,
        )
    })
    .unwrap();
    let holder = result(|cb| registry.begin_write_async(db, None, cb)).unwrap();
    result(|cb| {
        registry.execute_async(
            db,
            Some(holder.tx_id),
            "INSERT INTO sample VALUES (1)",
            &[],
            Mode::Write,
            cb,
        )
    })
    .unwrap();
    assert_eq!(
        result(|cb| registry.execute_async(db, None, "SELECT * FROM sample", &[], Mode::Read, cb))
            .unwrap()
            .rows
            .len(),
        0
    );
    let next = result(|cb| {
        let r = registry.clone();
        registry.commit_async(
            db,
            holder.tx_id,
            Box::new(move |committed| {
                committed.unwrap();
                r.begin_write_async(db, None, cb);
            }),
        );
    })
    .unwrap();
    result(|cb| registry.abandon_async(db, next.admission_id, cb)).unwrap();
    let next = result(|cb| registry.begin_write_async(db, None, cb)).unwrap();
    result(|cb| registry.rollback_async(db, next.tx_id, cb)).unwrap();
    result(|cb| registry.close_async(db, cb)).unwrap();
    result(|cb| registry.close_async(db, cb)).unwrap();
}

#[test]
fn sixteen_never_expiring_admissions_do_not_block_holder_or_readers() {
    let registry = Registry::new();
    let db = registry
        .open(
            ":memory:",
            OpenOptions {
                expire_admissions: false,
                ..OpenOptions::default()
            },
        )
        .unwrap();
    let holder = registry.begin_write(db, None).unwrap();
    let (send, receive) = mpsc::channel();
    let count = Arc::new(AtomicUsize::new(0));
    for _ in 0..16 {
        let send = send.clone();
        let count = count.clone();
        registry.begin_write_async(
            db,
            Some(Duration::from_millis(5)),
            Box::new(move |value| {
                count.fetch_add(1, Ordering::SeqCst);
                send.send(value).unwrap();
            }),
        );
    }
    std::thread::sleep(Duration::from_millis(20));
    assert_eq!(registry.stats(db).unwrap().pending_admissions, 16);
    assert!(
        receive.try_recv().is_err(),
        "release-mode waiter expired or was granted early"
    );
    assert_eq!(
        result(|cb| registry.execute_async(
            db,
            Some(holder.tx_id),
            "SELECT 1",
            &[],
            Mode::Read,
            cb
        ))
        .unwrap()
        .rows,
        vec![vec![Value::Integer(1)]]
    );
    assert_eq!(
        result(|cb| registry.execute_async(db, None, "SELECT 2", &[], Mode::Read, cb))
            .unwrap()
            .rows,
        vec![vec![Value::Integer(2)]]
    );
    result(|cb| registry.commit_async(db, holder.tx_id, cb)).unwrap();
    for _ in 0..16 {
        let admission = receive
            .recv_timeout(Duration::from_secs(3))
            .unwrap()
            .unwrap();
        registry.rollback(db, admission.tx_id).unwrap();
    }
    registry.close(db).unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 16);
}

#[test]
fn close_fails_every_pending_callback_once_and_callbacks_can_reenter() {
    let registry = Arc::new(Registry::new());
    let db = registry.open(":memory:", OpenOptions::default()).unwrap();
    let _holder = registry.begin_write(db, None).unwrap();
    let count = Arc::new(AtomicUsize::new(0));
    let (send, receive) = mpsc::channel();
    for _ in 0..32 {
        let count = count.clone();
        let send = send.clone();
        let r = registry.clone();
        registry.begin_write_async(
            db,
            None,
            Box::new(move |value| {
                assert!(matches!(value, Err(Error::Closed)));
                // This takes the engine state lock and would deadlock under shutdown's lock.
                r.execute_async(
                    db,
                    None,
                    "SELECT 1",
                    &[],
                    Mode::Read,
                    Box::new(move |value| {
                        assert!(matches!(value, Err(Error::Closed)));
                        count.fetch_add(1, Ordering::SeqCst);
                        send.send(()).unwrap();
                    }),
                );
            }),
        );
    }
    result(|cb| registry.close_async(db, cb)).unwrap();
    for _ in 0..32 {
        receive.recv_timeout(Duration::from_secs(3)).unwrap();
    }
    registry.close(db).unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 32);
}

struct PanicClock(AtomicBool);
impl hozon_sqlite::Clock for PanicClock {
    fn now(&self) -> Duration {
        if std::thread::current().name() == Some("hozon-sqlite-writer") {
            assert!(!self.0.load(Ordering::SeqCst), "injected worker panic");
        }
        Duration::ZERO
    }
}
#[test]
fn worker_panic_fails_pending_and_future_callbacks_with_worker_stopped() {
    let registry = Registry::new();
    let clock = Arc::new(PanicClock(AtomicBool::new(false)));
    let db = registry
        .open(
            ":memory:",
            OpenOptions {
                clock: clock.clone(),
                ..OpenOptions::default()
            },
        )
        .unwrap();
    let holder = registry.begin_write(db, None).unwrap();
    clock.0.store(true, Ordering::SeqCst);
    let value = result(|cb| registry.begin_write_async(db, None, cb));
    assert!(matches!(value, Err(Error::WorkerStopped)));
    assert!(matches!(
        result(|cb| registry.execute_async(
            db,
            Some(holder.tx_id),
            "SELECT 1",
            &[],
            Mode::Read,
            cb
        )),
        Err(Error::WorkerStopped)
    ));
    assert!(matches!(
        result(|cb| registry.execute_async(db, None, "SELECT 1", &[], Mode::Read, cb)),
        Err(Error::WorkerStopped)
    ));
    let _ = registry.close(db);
}

#[test]
fn queued_reads_return_immediately_and_close_settles_every_reader_once() {
    let registry = Registry::new();
    let db = registry
        .open(
            ":memory:",
            OpenOptions {
                readers: 1,
                ..OpenOptions::default()
            },
        )
        .unwrap();
    let holder = registry.begin_write(db, None).unwrap();
    let count = Arc::new(AtomicUsize::new(0));
    let (send, receive) = mpsc::channel();
    let caller = std::thread::current().id();
    let callback = || {
        let send = send.clone();
        let count = count.clone();
        Box::new(
            move |value: hozon_sqlite::Result<hozon_sqlite::QueryResult>| {
                assert_ne!(caller, std::thread::current().id());
                assert!(matches!(value, Err(Error::Closed)), "{value:?}");
                count.fetch_add(1, Ordering::SeqCst);
                send.send(()).unwrap();
            },
        ) as Callback<hozon_sqlite::QueryResult>
    };
    registry.execute_async(db, None, "WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n", &[], Mode::Read, callback());
    std::thread::sleep(Duration::from_millis(20));
    let start = std::time::Instant::now();
    for _ in 0..16 {
        registry.execute_async(db, None, "SELECT 1", &[], Mode::Read, callback());
    }
    assert!(
        start.elapsed() < Duration::from_millis(100),
        "reader submission waited for the pool"
    );
    result(|cb| registry.execute_async(db, Some(holder.tx_id), "SELECT 2", &[], Mode::Read, cb))
        .unwrap();
    result(|cb| registry.close_async(db, cb)).unwrap();
    for _ in 0..17 {
        receive.recv_timeout(Duration::from_secs(3)).unwrap();
    }
    assert_eq!(count.load(Ordering::SeqCst), 17);
}

#[test]
fn writer_panic_also_fails_running_and_queued_reader_callbacks() {
    let registry = Registry::new();
    let clock = Arc::new(PanicClock(AtomicBool::new(false)));
    let db = registry
        .open(
            ":memory:",
            OpenOptions {
                readers: 1,
                clock: clock.clone(),
                ..OpenOptions::default()
            },
        )
        .unwrap();
    registry.begin_write(db, None).unwrap();
    let (send, receive) = mpsc::channel();
    let count = Arc::new(AtomicUsize::new(0));
    for index in 0..17 {
        let send = send.clone();
        let count = count.clone();
        let sql = if index == 0 {
            "WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n"
        } else {
            "SELECT 1"
        };
        registry.execute_async(
            db,
            None,
            sql,
            &[],
            Mode::Read,
            Box::new(move |value| {
                assert!(matches!(value, Err(Error::WorkerStopped)), "{value:?}");
                count.fetch_add(1, Ordering::SeqCst);
                send.send(()).unwrap();
            }),
        );
    }
    clock.0.store(true, Ordering::SeqCst);
    assert!(matches!(
        result(|cb| registry.begin_write_async(db, None, cb)),
        Err(Error::WorkerStopped)
    ));
    for _ in 0..17 {
        receive.recv_timeout(Duration::from_secs(3)).unwrap();
    }
    assert_eq!(count.load(Ordering::SeqCst), 17);
    let _ = registry.close(db);
}

#[test]
fn invalid_open_and_unknown_handle_callbacks_run_off_the_caller_thread() {
    let registry = Registry::new();
    let caller = std::thread::current().id();
    assert!(matches!(
        result(|cb| registry.open_async(
            "",
            OpenOptions::default(),
            Box::new(move |value| {
                assert_ne!(caller, std::thread::current().id());
                cb(value);
            })
        )),
        Err(Error::InvalidInput(_))
    ));
    assert!(matches!(
        result(|cb| registry.execute_async(
            999999999,
            None,
            "SELECT 1",
            &[],
            Mode::Read,
            Box::new(move |value| {
                assert_ne!(caller, std::thread::current().id());
                cb(value);
            })
        )),
        Err(Error::Closed)
    ));
}

#[test]
fn dropping_registry_settles_pending_callbacks_on_an_engine_thread() {
    let registry = Registry::new();
    let db = registry.open(":memory:", OpenOptions::default()).unwrap();
    registry.begin_write(db, None).unwrap();
    let caller = std::thread::current().id();
    let (send, receive) = mpsc::channel();
    registry.begin_write_async(
        db,
        None,
        Box::new(move |value| {
            send.send((std::thread::current().id(), value)).unwrap();
        }),
    );
    drop(registry);
    let (thread, value) = receive.recv_timeout(Duration::from_secs(3)).unwrap();
    assert_ne!(thread, caller);
    assert!(matches!(value, Err(Error::Closed)));
}

#[test]
fn last_registry_reference_can_be_released_inside_writer_and_reader_callbacks() {
    for mode in [Mode::Read, Mode::Write] {
        let registry = Arc::new(Registry::new());
        let db = registry.open(":memory:", OpenOptions::default()).unwrap();
        let owned = registry.clone();
        let (proceed, proceed_receive) = mpsc::channel();
        let (send, receive) = mpsc::channel();
        registry.execute_async(
            db,
            None,
            "SELECT 1",
            &[],
            mode,
            Box::new(move |value| {
                proceed_receive
                    .recv_timeout(Duration::from_secs(3))
                    .unwrap();
                drop(owned);
                send.send(value).unwrap();
            }),
        );
        drop(registry);
        proceed.send(()).unwrap();
        receive
            .recv_timeout(Duration::from_secs(3))
            .expect("callback joined its own worker")
            .unwrap();
    }
}

fn closed_counter<T: Send + 'static>(
    count: &Arc<AtomicUsize>,
    send: &mpsc::Sender<()>,
) -> Callback<T> {
    let count = count.clone();
    let send = send.clone();
    Box::new(move |value| {
        assert!(matches!(value, Err(Error::Closed)));
        count.fetch_add(1, Ordering::SeqCst);
        send.send(()).unwrap();
    })
}

#[test]
fn close_settles_all_writer_command_kinds_once_while_begin_is_busy() {
    let registry = Registry::new();
    let path = std::env::temp_dir().join(format!(
        "hozon-callback-close-{}-{}.db",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let db = registry.open(&path, OpenOptions::default()).unwrap();
    let external = rusqlite::Connection::open(&path).unwrap();
    external.execute_batch("BEGIN IMMEDIATE").unwrap();
    let count = Arc::new(AtomicUsize::new(0));
    let (send, receive) = mpsc::channel();
    registry.begin_write_async(db, None, closed_counter(&count, &send));
    // Allow the engine's BEGIN to enter SQLite's busy wait, outside its state lock.
    std::thread::sleep(Duration::from_millis(30));
    registry.commit_async(db, u64::MAX, closed_counter(&count, &send));
    registry.rollback_async(db, u64::MAX, closed_counter(&count, &send));
    registry.abandon_async(db, u64::MAX, closed_counter(&count, &send));
    registry.execute_async(
        db,
        Some(u64::MAX),
        "SELECT 1",
        &[],
        Mode::Read,
        closed_counter(&count, &send),
    );
    registry.execute_async(
        db,
        None,
        "CREATE TABLE queued (id INTEGER)",
        &[],
        Mode::Write,
        closed_counter(&count, &send),
    );
    let (closed, closed_receive) = mpsc::channel();
    registry.close_async(
        db,
        Box::new(move |value| {
            closed.send(value).unwrap();
        }),
    );
    for _ in 0..6 {
        receive
            .recv_timeout(Duration::from_secs(3))
            .expect("close stranded a writer callback");
    }
    external.execute_batch("ROLLBACK").unwrap();
    closed_receive
        .recv_timeout(Duration::from_secs(3))
        .unwrap()
        .unwrap();
    registry.close(db).unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 6);
    drop(external);
    std::fs::remove_file(path).unwrap();
}
