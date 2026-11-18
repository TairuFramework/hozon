use crate::{
    Admission, AdmissionID, DBID, Error, Mode, OpenOptions, QueryResult, Result, Stats, TxID,
    Value,
    engine::{Engine, next_id},
    reader::lock,
};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, Weak, atomic::Ordering},
    time::Duration,
};

struct FileOwner {
    engine: Weak<Engine>,
    #[cfg(unix)]
    identity: (u64, u64),
}
static FILES: OnceLock<Mutex<HashMap<PathBuf, FileOwner>>> = OnceLock::new();
#[cfg(unix)]
fn identity(path: &Path) -> Result<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let metadata = path.metadata()?;
    Ok((metadata.dev(), metadata.ino()))
}

/// Handles are registry-scoped; file ownership is process-wide across registries.
#[derive(Default)]
pub struct Registry {
    databases: Mutex<HashMap<DBID, Arc<Engine>>>,
}
impl Registry {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn open(&self, path: impl AsRef<Path>, options: OpenOptions) -> Result<DBID> {
        // rusqlite converts this to i32 milliseconds with expect(), so validate first.
        if options.busy_timeout.as_millis() > i32::MAX as u128 {
            return Err(Error::InvalidInput(
                "busy timeout exceeds SQLite's i32 millisecond range".into(),
            ));
        }
        if options.readers == 0 {
            return Err(Error::InvalidInput(
                "at least one reader is required".into(),
            ));
        }
        if options
            .encryption_key
            .as_ref()
            .is_some_and(|key| !key.is_empty())
        {
            return Err(Error::InvalidInput(
                "SQLCipher encryption is disabled".into(),
            ));
        }
        let path = path.as_ref();
        let memory = path == Path::new(":memory:");
        if path.as_os_str().is_empty() {
            return Err(Error::InvalidInput("empty database path".into()));
        }
        let id = next_id();
        let mut files = lock(FILES.get_or_init(|| Mutex::new(HashMap::new())));
        files.retain(|_, owner| owner.engine.strong_count() > 0);
        let canonical = if memory {
            None
        } else {
            Some(canonical_path(path)?)
        };
        if let Some(path) = &canonical {
            #[cfg(unix)]
            let requested_identity = if path.exists() {
                Some(identity(path)?)
            } else {
                None
            };
            for (owned_path, owner) in files.iter() {
                let same_file = owned_path == path;
                #[cfg(unix)]
                let same_file = same_file || requested_identity == Some(owner.identity);
                if same_file
                    && owner
                        .engine
                        .upgrade()
                        .is_some_and(|engine| !engine.finished.load(Ordering::Acquire))
                {
                    return Err(Error::AlreadyOpen);
                }
            }
        }
        let sqlite_path = if memory {
            String::new()
        } else {
            let path = canonical
                .as_ref()
                .ok_or_else(|| Error::InvalidInput("missing database path".into()))?;
            let text = path
                .to_str()
                .ok_or_else(|| Error::InvalidInput("database path must be UTF-8".into()))?;
            text.to_owned()
        };
        let engine = Arc::new(Engine::open(&sqlite_path, memory, options)?);
        if let Some(path) = canonical {
            let owner = FileOwner {
                engine: Arc::downgrade(&engine),
                #[cfg(unix)]
                identity: identity(&path)?,
            };
            files.insert(path, owner);
        }
        lock(&self.databases).insert(id, engine);
        Ok(id)
    }
    fn engine(&self, db: DBID) -> Result<Arc<Engine>> {
        lock(&self.databases).get(&db).cloned().ok_or(Error::Closed)
    }
    pub fn close(&self, db: DBID) -> Result<()> {
        let engine = lock(&self.databases).get(&db).cloned();
        if let Some(engine) = engine {
            engine.close()?;
            lock(&self.databases).remove(&db);
        }
        Ok(())
    }
    pub fn begin_write(&self, db: DBID, timeout: Option<Duration>) -> Result<Admission> {
        self.begin_write_labeled(db, timeout, None)
    }
    pub fn begin_write_labeled(
        &self,
        db: DBID,
        timeout: Option<Duration>,
        label: Option<String>,
    ) -> Result<Admission> {
        self.engine(db)?.begin(timeout, label)
    }
    pub fn abandon(&self, db: DBID, admission_id: AdmissionID) -> Result<()> {
        self.engine(db)?.abandon(admission_id)
    }
    pub fn commit(&self, db: DBID, tx_id: TxID) -> Result<()> {
        self.engine(db)?.finish(tx_id, true)
    }
    pub fn rollback(&self, db: DBID, tx_id: TxID) -> Result<()> {
        self.engine(db)?.finish(tx_id, false)
    }
    pub fn execute(
        &self,
        db: DBID,
        tx_id: Option<TxID>,
        sql: &str,
        params: &[Value],
        mode: Mode,
    ) -> Result<QueryResult> {
        self.engine(db)?.execute(tx_id, sql, params, mode)
    }
    pub fn stats(&self, db: DBID) -> Result<Stats> {
        Ok(self.engine(db)?.stats())
    }
}

fn canonical_path(path: &Path) -> Result<PathBuf> {
    if path.exists() {
        return Ok(path.canonicalize()?);
    }
    let absolute = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()?.join(path)
    };
    let parent = absolute
        .parent()
        .ok_or_else(|| Error::InvalidInput("database has no parent directory".into()))?
        .canonicalize()?;
    let name = absolute
        .file_name()
        .ok_or_else(|| Error::InvalidInput("database has no filename".into()))?;
    Ok(parent.join(name))
}
