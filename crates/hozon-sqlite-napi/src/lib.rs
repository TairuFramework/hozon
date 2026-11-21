//! Optional standalone addon over the reusable, nonblocking SQLite API.
pub mod api;
pub use api::{BeginOptions, NativeOpenOptions, registry};

#[cfg(feature = "addon")]
use napi::{Env, Result, Unknown, bindgen_prelude::Object};
#[cfg(feature = "addon")]
use napi_derive::napi;

#[cfg(feature = "addon")]
fn boundary<T>(f: impl FnOnce() -> Result<T>) -> Result<T> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).unwrap_or_else(|_| {
        Err(napi::Error::from_reason(
            "HOZON_PANIC: SQLite boundary panicked",
        ))
    })
}

#[cfg(feature = "addon")]
#[napi]
pub fn open(env: Env, path: String, options: NativeOpenOptions) -> Result<Object<'static>> {
    boundary(|| api::open(env, path, options))
}
#[cfg(feature = "addon")]
#[napi]
pub fn admission_expiry(db: String) -> Result<bool> {
    boundary(|| api::admission_expiry(db))
}
#[cfg(feature = "addon")]
#[napi]
pub fn close(env: Env, db: String) -> Result<Object<'static>> {
    boundary(|| api::close(env, db))
}
#[cfg(feature = "addon")]
#[napi]
pub fn begin_write(env: Env, db: String, options: Option<BeginOptions>) -> Result<Object<'static>> {
    boundary(|| api::begin_write(env, db, options))
}
#[cfg(feature = "addon")]
#[napi]
pub fn abandon(env: Env, db: String, admission_id: String) -> Result<Object<'static>> {
    boundary(|| api::abandon(env, db, admission_id))
}
#[cfg(feature = "addon")]
#[napi]
pub fn commit(env: Env, db: String, tx_id: String) -> Result<Object<'static>> {
    boundary(|| api::commit(env, db, tx_id))
}
#[cfg(feature = "addon")]
#[napi]
pub fn rollback(env: Env, db: String, tx_id: String) -> Result<Object<'static>> {
    boundary(|| api::rollback(env, db, tx_id))
}
#[cfg(feature = "addon")]
#[napi]
pub fn execute(
    env: Env,
    db: String,
    tx_id: Option<String>,
    sql: String,
    params: Vec<Unknown>,
    mode: String,
) -> Result<Object<'static>> {
    boundary(|| api::execute(env, db, tx_id, sql, params, mode))
}
#[cfg(feature = "addon")]
#[napi]
pub fn execute_read_sync(
    env: Env,
    db: String,
    tx_id: Option<String>,
    sql: String,
    params: Vec<Unknown>,
) -> Result<api::Resolved> {
    boundary(|| api::execute_read_sync(env, db, tx_id, sql, params))
}
#[cfg(feature = "addon")]
#[napi]
pub fn sqlite_version() -> Result<String> {
    boundary(|| Ok(api::sqlite_version()))
}
