//! Submit without blocking. Engine callbacks settle thread-safe JS deferred promises.
use hozon_sqlite::{Mode, OpenOptions, Registry, Value};
use napi::bindgen_prelude::{Function, JsObjectValue, Object, ToNapiValue, TypeName, Uint8Array};
use napi::{Env, Error, JsDeferred, JsValue, Result, Unknown, ValueType};
use napi_derive::napi;
use std::{
    panic::{AssertUnwindSafe, catch_unwind},
    sync::OnceLock,
    time::Duration,
};

fn registry() -> &'static Registry {
    static REGISTRY: OnceLock<Registry> = OnceLock::new();
    REGISTRY.get_or_init(Registry::new)
}
fn invalid(message: impl Into<String>) -> Error {
    Error::from_reason(format!("HOZON_INVALID_INPUT: {}", message.into()))
}
fn milliseconds(value: f64) -> Result<Duration> {
    if !value.is_finite() || value.fract() != 0.0 || !(0.0..=i32::MAX as f64).contains(&value) {
        return Err(invalid(
            "timeout must be an integer from 0 to i32::MAX milliseconds",
        ));
    }
    Ok(Duration::from_millis(value as u64))
}
fn id(value: &str) -> Result<u64> {
    value.parse().map_err(|_| invalid("invalid native handle"))
}
fn engine_error(error: hozon_sqlite::Error) -> Error {
    let prefix = match &error {
        hozon_sqlite::Error::Closed => "HOZON_CLOSED",
        hozon_sqlite::Error::InvalidTransaction => "HOZON_INVALID_TRANSACTION",
        hozon_sqlite::Error::InvalidInput(_) => "HOZON_INVALID_INPUT",
        hozon_sqlite::Error::AlreadyOpen => "HOZON_ALREADY_OPEN",
        hozon_sqlite::Error::AdmissionExpired { .. } => "HOZON_ADMISSION_EXPIRED",
        hozon_sqlite::Error::SQLite(_) => "HOZON_SQLITE",
        hozon_sqlite::Error::IO(_) => "HOZON_IO",
        hozon_sqlite::Error::WorkerStopped => "HOZON_WORKER_STOPPED",
    };
    Error::from_reason(format!("{prefix}: {error}"))
}
#[napi(object)]
pub struct NativeOpenOptions {
    pub readers: f64,
    pub busy_timeout_ms: f64,
    pub journal_mode: String,
}
#[napi(object)]
pub struct BeginOptions {
    pub timeout_ms: Option<f64>,
}

enum Command {
    Open(String, OpenOptions),
    Close(u64),
    Begin(u64, Option<Duration>, Option<String>),
    Abandon(u64, u64),
    Commit(u64, u64),
    Rollback(u64, u64),
    Execute(u64, Option<u64>, String, Vec<Value>, Mode),
}
pub enum Output {
    Handle(u64),
    Admission(hozon_sqlite::Admission),
    Query(hozon_sqlite::QueryResult),
    Unit,
}

// N-API 4 has no bigint C API. Use the JS BigInt constructor on decimal strings,
// preserving every i64 bit without adding a feature or converting through f64.
struct Cell(Value);
impl TypeName for Cell {
    fn type_name() -> &'static str {
        "NativeValue"
    }
    fn value_type() -> ValueType {
        ValueType::Unknown
    }
}
/// # Safety
/// `env` must be a live N-API environment on its JavaScript thread, with an
/// active handle scope that outlives the returned value.
unsafe fn bigint(env: napi::sys::napi_env, text: String) -> Result<napi::sys::napi_value> {
    let env = Env::from_raw(env);
    let constructor: Function<String, Unknown> = env.get_global()?.get_named_property("BigInt")?;
    let value = constructor.call(text)?;
    // SAFETY: the returned value belongs to this live environment.
    unsafe { Unknown::to_napi_value(env.raw(), value) }
}
impl ToNapiValue for Cell {
    unsafe fn to_napi_value(
        env: napi::sys::napi_env,
        value: Self,
    ) -> Result<napi::sys::napi_value> {
        // SAFETY: napi supplies a live environment; conversions use that same env.
        unsafe {
            match value.0 {
                Value::Null => Option::<String>::to_napi_value(env, None),
                Value::Integer(v) if i32::try_from(v).is_ok() => i32::to_napi_value(env, v as i32),
                Value::Integer(v) => bigint(env, v.to_string()),
                Value::Real(v) => f64::to_napi_value(env, v),
                Value::Text(v) => String::to_napi_value(env, v),
                Value::Blob(v) => Uint8Array::to_napi_value(env, Uint8Array::from(v)),
            }
        }
    }
}
struct Integer(String);
impl ToNapiValue for Integer {
    unsafe fn to_napi_value(
        env: napi::sys::napi_env,
        value: Self,
    ) -> Result<napi::sys::napi_value> {
        // SAFETY: forwarded unchanged from napi.
        unsafe { bigint(env, value.0) }
    }
}
type Resolver = Box<dyn FnOnce(Env) -> Result<Resolved> + Send>;
type Deferred = JsDeferred<Resolved, Resolver>;

fn completion<T: Send + 'static>(
    deferred: Deferred,
    map: fn(T) -> Output,
) -> hozon_sqlite::Callback<T> {
    Box::new(move |result| match result {
        Ok(value) => deferred.resolve(Box::new(move |_env| Ok(Resolved(map(value))))),
        Err(error) => deferred.reject(engine_error(error)),
    })
}
fn submit(env: Env, command: Command) -> Result<Object<'static>> {
    let (deferred, promise) = env.create_deferred::<Resolved, Resolver>()?;
    // The JS handle is returned immediately in this callback's handle scope.
    // SAFETY: this aliases the live promise in the current JS handle scope;
    // it is returned immediately, never retained or used on an engine thread.
    let promise = Object::from_raw(env.raw(), promise.raw());
    let mut admission_id = None;
    let failure = deferred.clone();
    if catch_unwind(AssertUnwindSafe(|| {
        let r = registry();
        match command {
            Command::Open(path, options) => {
                r.open_async(path, options, completion(deferred, Output::Handle))
            }
            Command::Close(db) => r.close_async(db, completion(deferred, |_| Output::Unit)),
            Command::Begin(db, timeout, label) => {
                admission_id = Some(r.begin_write_pending_labeled_async(
                    db,
                    timeout,
                    label,
                    completion(deferred, Output::Admission),
                ));
            }
            Command::Abandon(db, admission) => {
                r.abandon_async(db, admission, completion(deferred, |_| Output::Unit))
            }
            Command::Commit(db, tx) => {
                r.commit_async(db, tx, completion(deferred, |_| Output::Unit))
            }
            Command::Rollback(db, tx) => {
                r.rollback_async(db, tx, completion(deferred, |_| Output::Unit))
            }
            Command::Execute(db, tx, sql, params, mode) => r.execute_async(
                db,
                tx,
                &sql,
                &params,
                mode,
                completion(deferred, Output::Query),
            ),
        }
    }))
    .is_err()
    {
        failure.reject(Error::from_reason(
            "HOZON_PANIC: engine submission panicked",
        ));
    }
    if let Some(id) = admission_id {
        let mut pending = Object::new(&env)?;
        pending.set("admissionID", id.to_string())?;
        pending.set("granted", promise)?;
        return Ok(pending);
    }
    Ok(promise)
}
pub struct Resolved(Output);
impl TypeName for Resolved {
    fn type_name() -> &'static str {
        "NativeResult"
    }
    fn value_type() -> ValueType {
        ValueType::Unknown
    }
}
impl ToNapiValue for Resolved {
    unsafe fn to_napi_value(
        raw_env: napi::sys::napi_env,
        value: Self,
    ) -> Result<napi::sys::napi_value> {
        let env = Env::from_raw(raw_env);
        let mut object;
        match value.0 {
            Output::Handle(id) => {
                return unsafe { String::to_napi_value(env.raw(), id.to_string()) };
            }
            Output::Unit => return unsafe { <()>::to_napi_value(env.raw(), ()) },
            Output::Admission(admission) => {
                object = Object::new(&env)?;
                object.set("admissionID", admission.admission_id.to_string())?;
                object.set("txID", admission.tx_id.to_string())?;
            }
            Output::Query(result) => {
                object = Object::new(&env)?;
                object.set("columns", result.columns)?;
                object.set(
                    "rows",
                    result
                        .rows
                        .into_iter()
                        .map(|r| r.into_iter().map(Cell).collect::<Vec<_>>())
                        .collect::<Vec<_>>(),
                )?;
                object.set("changes", Integer(result.changes.to_string()))?;
                object.set(
                    "lastInsertRowID",
                    Integer(result.last_insert_row_id.to_string()),
                )?;
            }
        }
        unsafe { Object::to_napi_value(env.raw(), object) }
    }
}

#[napi]
pub fn open(env: Env, path: String, options: NativeOpenOptions) -> Result<Object<'static>> {
    if options.journal_mode != "wal" {
        return Err(invalid("journalMode must be wal"));
    }
    if !options.readers.is_finite()
        || options.readers.fract() != 0.0
        || !(1.0..=64.0).contains(&options.readers)
    {
        return Err(invalid("readers must be an integer between 1 and 64"));
    }
    let busy_timeout = milliseconds(options.busy_timeout_ms)?;
    submit(
        env,
        Command::Open(
            path,
            OpenOptions {
                readers: options.readers as usize,
                busy_timeout,
                ..OpenOptions::default()
            },
        ),
    )
}
#[napi]
pub fn close(env: Env, db: String) -> Result<Object<'static>> {
    submit(env, Command::Close(id(&db)?))
}
#[napi]
pub fn begin_write(env: Env, db: String, options: Option<BeginOptions>) -> Result<Object<'static>> {
    let timeout = options
        .and_then(|o| o.timeout_ms)
        .map(milliseconds)
        .transpose()?;
    // Capture at the JS boundary, before the worker starts waiting.
    let error: Function<(), Object> = env.get_global()?.get_named_property("Error")?;
    let label = error
        .call(())?
        .get_named_property::<Option<String>>("stack")?;
    submit(env, Command::Begin(id(&db)?, timeout, label))
}
#[napi]
pub fn abandon(env: Env, db: String, admission_id: String) -> Result<Object<'static>> {
    submit(env, Command::Abandon(id(&db)?, id(&admission_id)?))
}
#[napi]
pub fn commit(env: Env, db: String, tx_id: String) -> Result<Object<'static>> {
    submit(env, Command::Commit(id(&db)?, id(&tx_id)?))
}
#[napi]
pub fn rollback(env: Env, db: String, tx_id: String) -> Result<Object<'static>> {
    submit(env, Command::Rollback(id(&db)?, id(&tx_id)?))
}
#[napi]
pub fn execute(
    env: Env,
    db: String,
    tx_id: Option<String>,
    sql: String,
    params: Vec<Unknown>,
    mode: String,
) -> Result<Object<'static>> {
    let mode = match mode.as_str() {
        "read" => Mode::Read,
        "write" => Mode::Write,
        _ => return Err(invalid("mode must be read or write")),
    };
    let params = params
        .into_iter()
        .map(|value| {
            // SAFETY: each cast follows a runtime type check. Uint8Array's conversion
            // additionally validates the typed array kind and copies before dispatch.
            unsafe {
                Ok(match value.get_type()? {
                    ValueType::Null => Value::Null,
                    ValueType::Number => {
                        let n: f64 = value.cast()?;
                        if !n.is_finite() {
                            return Err(invalid("non-finite number"));
                        }
                        if n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0 {
                            Value::Integer(n as i64)
                        } else if n.fract() == 0.0 {
                            return Err(invalid("unsafe integer; bind bigint instead"));
                        } else {
                            Value::Real(n)
                        }
                    }
                    ValueType::String => Value::Text(value.cast()?),
                    ValueType::Object => Value::Blob(value.cast::<Uint8Array>()?.to_vec()),
                    // With napi4, bigint is the only JS type reported as Unknown.
                    ValueType::Unknown => {
                        let stringify: Function<Unknown, String> =
                            env.get_global()?.get_named_property("String")?;
                        Value::Integer(
                            stringify
                                .call(value)?
                                .parse()
                                .map_err(|_| invalid("bigint outside signed i64 range"))?,
                        )
                    }
                    _ => return Err(invalid("unsupported bind value")),
                })
            }
        })
        .collect::<Result<Vec<_>>>()?;
    submit(
        env,
        Command::Execute(
            id(&db)?,
            tx_id.as_deref().map(id).transpose()?,
            sql,
            params,
            mode,
        ),
    )
}

#[napi]
pub fn sqlite_version() -> String {
    hozon_sqlite::sqlite_version().to_owned()
}
