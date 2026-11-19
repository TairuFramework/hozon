use hozon_sqlite::{Error, Mode, OpenOptions, Registry, Result, TxConnection, TxJob};
use std::{sync::mpsc, thread, time::Duration};

const WAIT: Duration = Duration::from_secs(5);
fn setup() -> (Registry, u64, u64) {
    let registry = Registry::new();
    let db = registry.open(":memory:", OpenOptions::default()).unwrap();
    registry
        .execute(
            db,
            None,
            "CREATE TABLE items (id INTEGER PRIMARY KEY)",
            &[],
            Mode::Write,
        )
        .unwrap();
    let tx = registry.begin_write(db, None).unwrap().tx_id;
    (registry, db, tx)
}
fn job<T: Send + 'static>(registry: &Registry, db: u64, tx: u64, job: TxJob<T>) -> Result<T> {
    let (send, receive) = mpsc::channel();
    registry.run_in_transaction_async(
        db,
        tx,
        job,
        Box::new(move |result| {
            send.send(result).unwrap();
        }),
    );
    receive.recv_timeout(WAIT).unwrap()
}
fn count(connection: &TxConnection<'_>) -> Result<i64> {
    connection.query_row("SELECT count(*) FROM items", [], |row| row.get(0))
}

#[test]
fn jobs_are_fifo_with_statements_and_bypass_sixteen_pending_begins() {
    let (registry, db, tx) = setup();
    let (send, receive) = mpsc::channel();
    registry.execute_async(
        db,
        Some(tx),
        "INSERT INTO items VALUES (1)",
        &[],
        Mode::Write,
        Box::new(move |r| send.send(r).unwrap()),
    );
    let mut pending = Vec::new();
    for _ in 0..16 {
        let (send, receive) = mpsc::channel();
        let id = registry.begin_write_pending_labeled_async(
            db,
            None,
            None,
            Box::new(move |r| send.send(r).unwrap()),
        );
        pending.push((id, receive));
    }
    assert_eq!(
        job(
            &registry,
            db,
            tx,
            Box::new(move |conn| {
                assert_eq!((conn.db_id(), conn.tx_id()), (db, tx));
                assert_eq!(count(conn)?, 1);
                conn.prepare_cached("INSERT INTO items VALUES (?)")?
                    .execute([2])?;
                Ok(2)
            })
        )
        .unwrap(),
        2
    );
    receive.recv_timeout(WAIT).unwrap().unwrap();
    assert_eq!(
        registry
            .execute(db, Some(tx), "SELECT count(*) FROM items", &[], Mode::Read)
            .unwrap()
            .rows[0][0],
        hozon_sqlite::Value::Integer(2)
    );
    for (id, receive) in pending {
        registry.abandon(db, id).unwrap();
        assert!(receive.recv_timeout(WAIT).unwrap().is_err());
    }
    registry.rollback(db, tx).unwrap();
    assert_eq!(
        registry
            .execute(db, None, "SELECT count(*) FROM items", &[], Mode::Read)
            .unwrap()
            .rows[0][0],
        hozon_sqlite::Value::Integer(0)
    );
    registry.close(db).unwrap();
}

#[test]
fn atomic_error_rolls_back_only_its_writes() {
    let (registry, db, tx) = setup();
    job(
        &registry,
        db,
        tx,
        Box::new(|conn| {
            conn.execute("INSERT INTO items VALUES (1)", [])?;
            let result: Result<()> = conn.atomic(|conn| {
                conn.execute("INSERT INTO items VALUES (2)", [])?;
                Err(Error::InvalidInput("injected".into()))
            });
            assert!(matches!(result, Err(Error::InvalidInput(_))));
            assert_eq!(count(conn)?, 1);
            Ok(())
        }),
    )
    .unwrap();
    registry.commit(db, tx).unwrap();
    registry.close(db).unwrap();
}

#[test]
fn atomic_unwind_leaves_no_rows_and_transaction_commits_normally() {
    let (registry, db, tx) = setup();
    let result: Result<()> = job(
        &registry,
        db,
        tx,
        Box::new(|conn| {
            conn.atomic(|conn| {
                conn.execute("INSERT INTO items VALUES (1)", [])?;
                panic!("injected atomic panic");
            })
        }),
    );
    assert!(matches!(result, Err(Error::JobPanic)));
    assert_eq!(job(&registry, db, tx, Box::new(count)).unwrap(), 0);
    job(
        &registry,
        db,
        tx,
        Box::new(|conn| {
            conn.execute("INSERT INTO items VALUES (2)", [])?;
            Ok(())
        }),
    )
    .unwrap();
    registry.commit(db, tx).unwrap();
    assert_eq!(
        registry
            .execute(db, None, "SELECT id FROM items", &[], Mode::Read)
            .unwrap()
            .rows,
        vec![vec![hozon_sqlite::Value::Integer(2)]]
    );
    registry.close(db).unwrap();
}

#[test]
fn panic_outside_atomic_keeps_transaction_usable() {
    let (registry, db, tx) = setup();
    let result: Result<()> = job(&registry, db, tx, Box::new(|_| panic!("job panic")));
    assert!(matches!(result, Err(Error::JobPanic)));
    assert_eq!(job(&registry, db, tx, Box::new(count)).unwrap(), 0);
    registry.commit(db, tx).unwrap();
    assert!(matches!(
        job(&registry, db, tx, Box::new(count)),
        Err(Error::InvalidTransaction)
    ));
    assert!(matches!(
        job(&registry, db, u64::MAX, Box::new(count)),
        Err(Error::InvalidTransaction)
    ));
    registry.close(db).unwrap();
}

#[test]
fn transaction_control_is_rejected_by_every_connection_method() {
    let (registry, db, tx) = setup();
    job(
        &registry,
        db,
        tx,
        Box::new(|conn| {
            for sql in [
                "BEGIN",
                "COMMIT",
                "END",
                "ROLLBACK",
                "SAVEPOINT x",
                "RELEASE x",
                "ROLLBACK TO x",
                "; -- comment\n /* comment */ cOmMiT",
            ] {
                assert!(
                    matches!(conn.execute(sql, []), Err(Error::InvalidInput(_))),
                    "{sql}"
                );
                assert!(
                    matches!(conn.prepare_cached(sql), Err(Error::InvalidInput(_))),
                    "{sql}"
                );
                assert!(
                    matches!(
                        conn.query_row(sql, [], |_| Ok(())),
                        Err(Error::InvalidInput(_))
                    ),
                    "{sql}"
                );
            }
            Ok(())
        }),
    )
    .unwrap();
    registry.commit(db, tx).unwrap();
    registry.close(db).unwrap();
}

#[test]
fn sqlite_implicit_rollback_retires_transaction() {
    let (registry, db, tx) = setup();
    let result = job(
        &registry,
        db,
        tx,
        Box::new(|conn| {
            conn.execute("INSERT INTO items VALUES (1)", [])?;
            conn.execute("INSERT OR ROLLBACK INTO items VALUES (1)", [])
        }),
    );
    assert!(matches!(result, Err(Error::JobEndedTransaction)));
    assert!(matches!(
        job(&registry, db, tx, Box::new(count)),
        Err(Error::InvalidTransaction)
    ));
    let next = registry.begin_write(db, None).unwrap();
    registry.rollback(db, next.tx_id).unwrap();
    registry.close(db).unwrap();
}

#[test]
fn callback_fires_once_on_writer_thread() {
    let (registry, db, tx) = setup();
    let (send, receive) = mpsc::channel();
    let retained = send.clone();
    registry.run_in_transaction_async(
        db,
        tx,
        Box::new(count),
        Box::new(move |result| {
            send.send((
                result,
                thread::current().id(),
                thread::current().name().map(str::to_owned),
            ))
            .unwrap();
        }),
    );
    let (result, id, name) = receive.recv_timeout(WAIT).unwrap();
    assert_eq!(result.unwrap(), 0);
    assert_ne!(id, thread::current().id());
    assert_eq!(name.as_deref(), Some("hozon-sqlite-writer"));
    assert!(matches!(
        receive.recv_timeout(Duration::from_millis(50)),
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    drop(retained);
    registry.rollback(db, tx).unwrap();
    registry.close(db).unwrap();
}

#[test]
fn close_fails_queued_job_exactly_once() {
    let (registry, db, tx) = setup();
    let (entered, entry) = mpsc::channel();
    let (resume, resumed) = mpsc::channel();
    let (finished, finish) = mpsc::channel();
    registry.run_in_transaction_async(
        db,
        tx,
        Box::new(move |_| {
            entered.send(()).unwrap();
            resumed.recv_timeout(WAIT).unwrap();
            Ok(())
        }),
        Box::new(move |result| finished.send(result).unwrap()),
    );
    entry.recv_timeout(WAIT).unwrap();
    let (send, receive) = mpsc::channel();
    let retained = send.clone();
    registry.run_in_transaction_async(
        db,
        tx,
        Box::new(|_| -> Result<()> { panic!("queued job must not run") }),
        Box::new(move |result| send.send(result).unwrap()),
    );
    let (closed, close) = mpsc::channel();
    registry.close_async(db, Box::new(move |result| closed.send(result).unwrap()));
    // shutdown drains the queue before waiting for the currently running job.
    assert!(matches!(
        receive.recv_timeout(WAIT).unwrap(),
        Err(Error::Closed)
    ));
    resume.send(()).unwrap();
    assert!(matches!(
        finish.recv_timeout(WAIT).unwrap(),
        Err(Error::Closed)
    ));
    close.recv_timeout(WAIT).unwrap().unwrap();
    assert!(matches!(
        receive.recv_timeout(Duration::from_millis(50)),
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    drop(retained);
}

#[test]
fn close_interrupts_running_job_with_terminal_error() {
    let (registry, db, tx) = setup();
    let (entered, entry) = mpsc::channel();
    let (finished, finish) = mpsc::channel();
    registry.run_in_transaction_async(
        db,
        tx,
        Box::new(move |conn| {
            entered.send(()).unwrap();
            conn.query_row(
                "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n",
                [],
                |row| row.get::<_, i64>(0),
            )
        }),
        Box::new(move |result| finished.send(result).unwrap()),
    );
    entry.recv_timeout(WAIT).unwrap();
    let (closed, close) = mpsc::channel();
    registry.close_async(db, Box::new(move |result| closed.send(result).unwrap()));
    assert!(matches!(
        finish.recv_timeout(WAIT).unwrap(),
        Err(Error::Closed)
    ));
    close.recv_timeout(WAIT).unwrap().unwrap();
}

#[cfg(feature = "test-util")]
#[test]
fn blocking_test_utility_runs_jobs() {
    let (registry, db, tx) = setup();
    assert_eq!(
        registry
            .run_in_transaction(db, tx, Box::new(count))
            .unwrap(),
        0
    );
    registry.rollback(db, tx).unwrap();
    registry.close(db).unwrap();
}

#[test]
fn job_rejects_blocking_execute_without_submitting_it() {
    let (registry, db, tx) = setup();
    let nested = registry.clone();
    let result = job(
        &registry,
        db,
        tx,
        Box::new(move |_| {
            nested.execute(
                db,
                Some(tx),
                "INSERT INTO items VALUES (1)",
                &[],
                Mode::Write,
            )
        }),
    );
    assert!(matches!(result, Err(Error::InvalidInput(_))));
    assert_eq!(job(&registry, db, tx, Box::new(count)).unwrap(), 0);
    registry.commit(db, tx).unwrap();
    registry.close(db).unwrap();
}

#[test]
fn job_queued_after_holder_abandon_is_invalid() {
    let registry = Registry::new();
    let db = registry.open(":memory:", OpenOptions::default()).unwrap();
    let admission = registry.begin_write(db, None).unwrap();
    let (send, receive) = mpsc::channel();
    registry.abandon_async(
        db,
        admission.admission_id,
        Box::new(move |r| send.send(r).unwrap()),
    );
    let result: Result<()> = job(
        &registry,
        db,
        admission.tx_id,
        Box::new(|_| panic!("abandoned job must not run")),
    );
    assert!(matches!(result, Err(Error::InvalidTransaction)));
    receive.recv_timeout(WAIT).unwrap().unwrap();
    let next = registry.begin_write(db, None).unwrap();
    registry.rollback(db, next.tx_id).unwrap();
    registry.close(db).unwrap();
}
