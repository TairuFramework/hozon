use hozon_sqlite::{DBID, Mode, OpenOptions, QueryResult, Registry, TxID, Value};
use std::{
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    registry: Registry,
    db: DBID,
    tx: Option<TxID>,
    path: PathBuf,
}

impl Fixture {
    fn new(transaction: bool) -> Self {
        let path = std::env::temp_dir().join(format!(
            "hozon-schema-cache-{}-{}.db",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let registry = Registry::new();
        let db = registry.open(&path, OpenOptions::default()).unwrap();
        let tx = transaction.then(|| registry.begin_write(db, None).unwrap().tx_id);
        Self {
            registry,
            db,
            tx,
            path,
        }
    }

    fn query(&self, sql: &str) -> QueryResult {
        // Autocommit SELECTs must use the writer too, so cache reuse is deterministic.
        self.registry
            .execute(self.db, self.tx, sql, &[], Mode::Write)
            .unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.registry.close(self.db).unwrap();
        std::fs::remove_file(&self.path).unwrap();
    }
}

fn schema_change(transaction: bool, add: bool, populated: bool) {
    let fixture = Fixture::new(transaction);
    let (create, alter, before, after) = if add {
        (
            "CREATE TABLE items (id INTEGER)",
            "ALTER TABLE items ADD COLUMN label TEXT NOT NULL DEFAULT 'default'",
            vec!["id"],
            vec!["id", "label"],
        )
    } else {
        (
            "CREATE TABLE items (id INTEGER, label TEXT NOT NULL DEFAULT 'default')",
            "ALTER TABLE items DROP COLUMN label",
            vec!["id", "label"],
            vec!["id"],
        )
    };
    fixture.query(create);
    if populated {
        fixture.query("INSERT INTO items (id) VALUES (1), (2)");
    }
    let select = "SELECT * FROM items ORDER BY id";
    for _ in 0..2 {
        assert_eq!(fixture.query(select).columns, before);
    }
    fixture.query(alter);
    let expected_rows: Vec<Vec<Value>> = if populated {
        (1..=2)
            .map(|id| {
                let mut row = vec![Value::Integer(id)];
                if add {
                    row.push(Value::Text("default".into()));
                }
                row
            })
            .collect()
    } else {
        vec![]
    };
    for _ in 0..3 {
        let result = fixture.query(select);
        assert_eq!(result.rows, expected_rows);
        assert_eq!(result.columns, after);
    }
    if let Some(tx) = fixture.tx {
        fixture.registry.commit(fixture.db, tx).unwrap();
    }
}

fn unchanged_schema(transaction: bool) {
    let fixture = Fixture::new(transaction);
    fixture.query("CREATE TABLE items (id INTEGER, label TEXT)");
    fixture.query("INSERT INTO items VALUES (1, 'first'), (2, 'second')");
    for _ in 0..3 {
        let result = fixture.query("SELECT * FROM items ORDER BY id");
        assert_eq!(result.columns, vec!["id", "label"]);
        assert_eq!(
            result.rows,
            vec![
                vec![Value::Integer(1), Value::Text("first".into())],
                vec![Value::Integer(2), Value::Text("second".into())],
            ]
        );
    }
}

macro_rules! schema_test {
    ($name:ident, $transaction:expr, $add:expr, $populated:expr) => {
        #[test]
        fn $name() {
            schema_change($transaction, $add, $populated);
        }
    };
}

schema_test!(add_column_autocommit, false, true, true);
schema_test!(add_column_transaction, true, true, true);
schema_test!(drop_column_autocommit, false, false, true);
schema_test!(drop_column_transaction, true, false, true);
schema_test!(add_column_empty_autocommit, false, true, false);
schema_test!(add_column_empty_transaction, true, true, false);
schema_test!(drop_column_empty_autocommit, false, false, false);
schema_test!(drop_column_empty_transaction, true, false, false);

#[test]
fn unchanged_schema_autocommit() {
    unchanged_schema(false);
}

#[test]
fn unchanged_schema_transaction() {
    unchanged_schema(true);
}
