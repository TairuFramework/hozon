use hozon_sqlite::{DBID, Error, Mode, OpenOptions, Registry, Value};
use std::{
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    r: Registry,
    db: DBID,
    path: PathBuf,
}
impl Fixture {
    fn new(memory: bool) -> Self {
        let path = std::env::temp_dir().join(format!(
            "hozon-sync-{}-{}.db",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let r = Registry::new();
        let db = r
            .open(
                if memory {
                    std::path::Path::new(":memory:")
                } else {
                    &path
                },
                OpenOptions {
                    readers: 1,
                    ..OpenOptions::default()
                },
            )
            .unwrap();
        Self { r, db, path }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.r.close(self.db).unwrap();
        let _ = std::fs::remove_file(&self.path);
    }
}
#[test]
fn rows_and_errors_match_async_including_memory() {
    for memory in [false, true] {
        let f = Fixture::new(memory);
        f.r.execute(f.db, None, "CREATE TABLE items (value)", &[], Mode::Write)
            .unwrap();
        f.r.execute(
            f.db,
            None,
            "INSERT INTO items VALUES (42)",
            &[],
            Mode::Write,
        )
        .unwrap();
        let params = [
            Value::Null,
            Value::Integer(i64::MAX),
            Value::Real(1.5),
            Value::Text("日本語".into()),
            Value::Blob(vec![0, 255]),
        ];
        let sql = "SELECT value, ?1, ?2, ?3, ?4, ?5 FROM items";
        assert_eq!(
            f.r.execute_read_sync(f.db, None, sql, &params).unwrap(),
            f.r.execute(f.db, None, sql, &params, Mode::Read).unwrap()
        );
        assert!(matches!(
            f.r.execute_read_sync(f.db, None, "SELEC broken", &[]),
            Err(Error::SQLite(_))
        ));
        for sql in ["INSERT INTO items VALUES (99)", "BEGIN", "SAVEPOINT x"] {
            assert!(
                f.r.execute_read_sync(f.db, None, sql, &[]).is_err(),
                "{sql}"
            );
        }
        assert_eq!(
            f.r.execute_read_sync(f.db, None, "PRAGMA query_only", &[])
                .unwrap()
                .rows,
            vec![vec![Value::Integer(1)]]
        );
        let tx = f.r.begin_write(f.db, None).unwrap().tx_id;
        f.r.execute(
            f.db,
            Some(tx),
            "INSERT INTO items VALUES (99)",
            &[],
            Mode::Write,
        )
        .unwrap();
        assert!(matches!(
            f.r.execute_read_sync(f.db, Some(tx), "SELECT * FROM items", &[]),
            Err(Error::SyncReadTransaction)
        ));
        assert_eq!(
            f.r.execute(f.db, Some(tx), "SELECT * FROM items", &[], Mode::Read)
                .unwrap()
                .rows
                .len(),
            2
        );
        assert_eq!(
            f.r.execute_read_sync(f.db, None, "SELECT * FROM items", &[])
                .unwrap()
                .rows
                .len(),
            1
        );
        f.r.rollback(f.db, tx).unwrap();
        assert!(matches!(
            Registry::new().execute_read_sync(f.db, None, "SELECT 1", &[]),
            Err(Error::Closed)
        ));
        f.r.close(f.db).unwrap();
        assert!(matches!(
            f.r.execute_read_sync(f.db, None, "SELECT 1", &[]),
            Err(Error::Closed)
        ));
    }
}

#[test]
fn registry_close_and_close_all_interrupt_and_drain_sync_reads() {
    for all in [false, true] {
        let f = Fixture::new(true);
        let r = f.r.clone();
        let db = f.db;
        let read = std::thread::spawn(move || {
            loop {
                match r.execute_read_sync(db, None, "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n", &[]) {
                Err(Error::SyncReadBusy) => std::thread::yield_now(),
                result => break result,
            }
            }
        });
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            if matches!(
                f.r.execute_read_sync(db, None, "SELECT 1", &[]),
                Err(Error::SyncReadBusy)
            ) {
                break;
            }
            assert!(std::time::Instant::now() < deadline);
            std::thread::yield_now();
        }
        if all {
            let (send, receive) = std::sync::mpsc::channel();
            f.r.close_all_async(Box::new(move |result| send.send(result).unwrap()));
            receive
                .recv_timeout(std::time::Duration::from_secs(3))
                .unwrap()
                .unwrap();
        } else {
            f.r.close(db).unwrap();
        }
        assert!(matches!(read.join().unwrap(), Err(Error::Closed)));
        assert!(matches!(
            f.r.execute_read_sync(db, None, "SELECT 1", &[]),
            Err(Error::Closed)
        ));
    }
}
