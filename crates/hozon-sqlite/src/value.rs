use crate::{Error, Result};
pub use rusqlite::types::Value;
use rusqlite::{Connection, params_from_iter};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Read,
    Write,
}
#[derive(Debug, PartialEq)]
pub struct QueryResult {
    pub rows: Vec<Vec<Value>>,
    pub columns: Vec<String>,
    pub changes: u64,
    pub last_insert_row_id: i64,
}

pub(crate) fn execute(
    connection: &Connection,
    sql: &str,
    params: &[Value],
    mode: Mode,
) -> Result<QueryResult> {
    if params.len() > 500 {
        return Err(Error::InvalidInput(
            "at most 500 parameters are allowed".into(),
        ));
    }
    let mut prefix = sql;
    let first = keyword(&mut prefix);
    let second = keyword(&mut prefix);
    let third = keyword(&mut prefix);
    let rollback_to = second.eq_ignore_ascii_case("TO")
        || (second.eq_ignore_ascii_case("TRANSACTION") && third.eq_ignore_ascii_case("TO"));
    if ["BEGIN", "COMMIT", "END"]
        .iter()
        .any(|word| first.eq_ignore_ascii_case(word))
        || (first.eq_ignore_ascii_case("ROLLBACK") && !rollback_to)
        || (mode == Mode::Read
            && ["SAVEPOINT", "RELEASE", "ROLLBACK"]
                .iter()
                .any(|word| first.eq_ignore_ascii_case(word)))
    {
        return Err(Error::InvalidInput(
            "transaction control must use the handle API; savepoints require a write transaction"
                .into(),
        ));
    }
    let mut statement = connection.prepare_cached(sql)?;
    if mode == Mode::Read && !statement.readonly() && !is_journal_query(sql) {
        return Err(Error::InvalidInput("write statement in read mode".into()));
    }
    let readonly = statement.readonly();
    let columns = statement
        .column_names()
        .map(String::from)
        .collect::<Vec<_>>();
    let before = connection.total_changes();
    let mut rows = Vec::new();
    {
        let mut cursor = statement.query(params_from_iter(params))?;
        while let Some(row) = cursor.next()? {
            let mut values = Vec::with_capacity(columns.len());
            for index in 0..columns.len() {
                values.push(row.get(index)?);
            }
            rows.push(values);
        }
    }
    Ok(QueryResult {
        rows,
        columns,
        changes: if readonly || connection.total_changes() == before {
            0
        } else {
            connection.changes()
        },
        last_insert_row_id: connection.last_insert_rowid(),
    })
}

// SQLite marks journal_mode as writable even when it only queries the current mode.
fn is_journal_query(sql: &str) -> bool {
    let sql = sql.trim().trim_end_matches(';').trim();
    sql.eq_ignore_ascii_case("PRAGMA journal_mode")
        || sql.eq_ignore_ascii_case("PRAGMA main.journal_mode")
}

fn keyword<'a>(sql: &mut &'a str) -> &'a str {
    loop {
        *sql = sql.trim_start_matches(|c: char| c.is_ascii_whitespace() || c == ';');
        if sql.starts_with("--") {
            *sql = sql.find('\n').map_or("", |index| &sql[index + 1..]);
        } else if sql.starts_with("/*") {
            *sql = sql.find("*/").map_or("", |index| &sql[index + 2..]);
        } else {
            break;
        }
    }
    let end = sql
        .find(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .unwrap_or(sql.len());
    let word = &sql[..end];
    *sql = &sql[end..];
    word
}
