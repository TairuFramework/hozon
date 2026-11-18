//! Node binding for hozon-sqlite, used by the Node conformance and compatibility tests.
use napi_derive::napi;

#[napi]
pub fn sqlite_version() -> String {
    hozon_sqlite::sqlite_version().to_owned()
}
