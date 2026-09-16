//! Read sources through a private copy so SQLite owns WAL/PERSIST semantics.
//! Never recover a hot journal: read-only open also prevents following a source
//! super-journal during recovery. Private copies are removed before returning.
use anyhow::{bail, Result};
use rusqlite::{
    backup::{Backup, StepResult},
    Connection, OpenFlags,
};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

const LIMIT: u64 = 256 * 1024 * 1024;

pub(crate) fn paths(path: &Path) -> [PathBuf; 3] {
    let sidecar = |suffix| {
        let mut name = path.as_os_str().to_os_string();
        name.push(suffix);
        PathBuf::from(name)
    };
    [path.to_owned(), sidecar("-wal"), sidecar("-journal")]
}

fn read(path: &Path) -> Result<Option<Vec<u8>>> {
    match fs::metadata(path) {
        Ok(meta) if !meta.is_file() || meta.len() > LIMIT => bail!("source_too_large"),
        Ok(_) => fs::read(path)
            .map(Some)
            .map_err(|_| anyhow::anyhow!("source_read_failed")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => bail!("source_read_failed"),
    }
}

struct PrivateCopy(PathBuf);
impl PrivateCopy {
    fn new() -> Result<Self> {
        let path = std::env::temp_dir().join(format!("hub-snapshot-{}", uuid::Uuid::new_v4()));
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder
            .create(&path)
            .map_err(|_| anyhow::anyhow!("snapshot_unavailable"))?;
        Ok(Self(path))
    }
    fn write(path: &Path, bytes: &[u8]) -> Result<()> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(path)?.write_all(bytes)?;
        Ok(())
    }
}
impl Drop for PrivateCopy {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn sqlite_error(error: rusqlite::Error) -> anyhow::Error {
    use rusqlite::ErrorCode;
    match error.sqlite_error_code() {
        Some(ErrorCode::ReadOnly | ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked) => {
            anyhow::anyhow!("source_busy")
        }
        _ => anyhow::anyhow!("invalid_source_database"),
    }
}

pub(crate) fn open(path: &Path) -> Result<Connection> {
    let source_paths = paths(path);
    let before = source_paths
        .iter()
        .map(|p| read(p))
        .collect::<Result<Vec<_>>>()?;
    if before[0].is_none() {
        bail!("source_read_failed");
    }
    let copy = PrivateCopy::new()?;
    let db = copy.0.join("source.db");
    for (path, bytes) in paths(&db).iter().zip(&before) {
        if let Some(bytes) = bytes {
            PrivateCopy::write(path, bytes).map_err(|_| anyhow::anyhow!("snapshot_unavailable"))?;
        }
    }
    // Re-check all files together, including rollback journal presence/content.
    if before
        != source_paths
            .iter()
            .map(|p| read(p))
            .collect::<Result<Vec<_>>>()?
    {
        bail!("source_busy");
    }
    let source =
        Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(sqlite_error)?;
    let mut result = Connection::open_in_memory()?;
    {
        let backup = Backup::new(&source, &mut result).map_err(sqlite_error)?;
        if !matches!(backup.step(-1).map_err(sqlite_error)?, StepResult::Done) {
            bail!("source_busy");
        }
    }
    result.pragma_update(None, "query_only", true)?;
    drop(source);
    drop(copy);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persist_committed_journal_is_readable_without_source_changes() {
        let temp = PrivateCopy::new().unwrap();
        let path = temp.0.join("persist.db");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("PRAGMA journal_mode=PERSIST; CREATE TABLE fixture(value); INSERT INTO fixture VALUES('committed')").unwrap();
        let before = paths(&path)
            .iter()
            .map(|p| read(p).unwrap())
            .collect::<Vec<_>>();
        let journal = before[2].as_ref().unwrap();
        assert!(journal.len() > 512);
        assert_eq!(&journal[..28], &[0; 28]);
        assert_eq!(
            open(&path)
                .unwrap()
                .query_row("SELECT value FROM fixture", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "committed"
        );
        assert_eq!(
            before,
            paths(&path)
                .iter()
                .map(|p| read(p).unwrap())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn wal_reads_only_committed_pages_and_keeps_source_untouched() {
        let temp = PrivateCopy::new().unwrap();
        let path = temp.0.join("wal.db");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE fixture(value); INSERT INTO fixture VALUES('committed'); BEGIN; INSERT INTO fixture VALUES('pending')").unwrap();
        let before = paths(&path)
            .iter()
            .map(|p| read(p).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            open(&path)
                .unwrap()
                .query_row("SELECT count(*) FROM fixture", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            before,
            paths(&path)
                .iter()
                .map(|p| read(p).unwrap())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn hot_journal_requires_retry_without_recovery_or_source_writes() {
        let temp = PrivateCopy::new().unwrap();
        let path = temp.0.join("hot.db");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("PRAGMA journal_mode=DELETE; PRAGMA cache_size=1; CREATE TABLE fixture(value); INSERT INTO fixture VALUES('committed'); BEGIN; INSERT INTO fixture VALUES(zeroblob(100000))").unwrap();
        let before = paths(&path)
            .iter()
            .map(|p| read(p).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(open(&path).err().unwrap().to_string(), "source_busy");
        assert_eq!(
            before,
            paths(&path)
                .iter()
                .map(|p| read(p).unwrap())
                .collect::<Vec<_>>()
        );
    }
}
