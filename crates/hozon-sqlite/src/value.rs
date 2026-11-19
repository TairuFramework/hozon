use crate::{Error, Result};
pub use rusqlite::types::Value;
use rusqlite::{Connection, limits::Limit, params_from_iter};

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
    let limit = connection.limit(Limit::SQLITE_LIMIT_VARIABLE_NUMBER)? as usize;
    if params.len() > limit {
        return Err(Error::InvalidInput(format!(
            "at most {limit} parameters are allowed"
        )));
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

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_binds(connection: &Connection, count: usize) {
        let placeholders = vec!["(?)"; count].join(",");
        let result = execute(
            connection,
            &format!("SELECT sum(column1) FROM (VALUES {placeholders})"),
            &vec![Value::Integer(1); count],
            Mode::Read,
        )
        .unwrap();
        assert_eq!(result.rows, vec![vec![Value::Integer(count as i64)]]);
    }

    #[test]
    fn binds_more_than_500_parameters() {
        let connection = Connection::open_in_memory().unwrap();
        for count in [501, 2000] {
            assert_binds(&connection, count);
        }
    }

    #[test]
    fn enforces_connection_parameter_limit() {
        let connection = Connection::open_in_memory().unwrap();
        let limit = connection
            .limit(Limit::SQLITE_LIMIT_VARIABLE_NUMBER)
            .unwrap();
        eprintln!("SQLite connection variable limit: {limit}");
        assert_exceeds_limit(&connection, limit as usize);
        assert_binds(&connection, limit as usize);
    }

    #[test]
    fn honours_lowered_connection_parameter_limit() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .set_limit(Limit::SQLITE_LIMIT_VARIABLE_NUMBER, 700)
            .unwrap();
        assert_exceeds_limit(&connection, 700);
        assert_binds(&connection, 700);
    }

    fn assert_exceeds_limit(connection: &Connection, limit: usize) {
        let error = execute(
            connection,
            "SELECT 1",
            &vec![Value::Null; limit + 1],
            Mode::Read,
        )
        .unwrap_err();
        assert!(
            matches!(&error, Error::InvalidInput(message) if message == &format!("at most {limit} parameters are allowed"))
        );
        assert_eq!(
            error.to_string(),
            format!("invalid input: at most {limit} parameters are allowed")
        );
    }
}
