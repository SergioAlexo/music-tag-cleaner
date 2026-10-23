//! Crash-safe tag edits: every tag write in the app goes through `edit_file`.
//!
//! lofty saves in place. Its writers read the rest of the file, truncate it to
//! zero and write everything back, so anything that stopped the process inside
//! that window left a zero-length or truncated track: closing the app during a
//! batch (process exit doesn't wait for the worker threads, and a batch keeps
//! several of them inside that window at any moment), a crash, a full disk, a
//! USB stick or network share dropping out.
//!
//! Here lofty parses and edits a *working copy* — the whole file in memory, or
//! a temporary copy on disk for files too big to hold twice — and the result is
//! swapped in with one rename. The file on disk is always the old version or
//! the new one, never something in between.
//!
//! Deliberately no fsync before the rename: it made each save 5-15x slower on
//! the owner's SSD (17-50 ms against ~3 ms for a 10 MB file), which is minutes
//! on a library-wide batch, and the failures above don't need it. Power loss
//! mid-save is no worse than with lofty's own in-place write.

use std::collections::HashSet;
use std::fs::{File, Metadata, OpenOptions};
use std::io::{self, Cursor, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Condvar, Mutex};

use lofty::config::ParseOptions;
use lofty::file::{FileType, TaggedFile};
use lofty::probe::Probe;

/// Files up to this size are edited in memory; bigger ones (long WAV/AIFF
/// mixes) through a temporary copy on disk, so a batch of them can't need
/// several gigabytes of RAM at once. lofty itself buffers the file once while
/// saving either way.
const IN_MEMORY_MAX: u64 = 256 * 1024 * 1024;

/// The copy of a file that an edit works on. lofty reads and writes it
/// through `FileLike`, exactly as it would the file itself.
pub(crate) struct WorkingCopy {
    inner: Inner,
    /// Set by any write or truncate: an edit that changed nothing leaves the
    /// original file alone, modified time included.
    dirty: bool,
}

enum Inner {
    Memory(Cursor<Vec<u8>>),
    Disk(File),
}

impl Read for WorkingCopy {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match &mut self.inner {
            Inner::Memory(c) => c.read(buf),
            Inner::Disk(f) => f.read(buf),
        }
    }
}

impl Write for WorkingCopy {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.dirty = true;
        match &mut self.inner {
            Inner::Memory(c) => c.write(buf),
            Inner::Disk(f) => f.write(buf),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match &mut self.inner {
            Inner::Memory(c) => c.flush(),
            Inner::Disk(f) => f.flush(),
        }
    }
}

impl Seek for WorkingCopy {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        match &mut self.inner {
            Inner::Memory(c) => c.seek(pos),
            Inner::Disk(f) => f.seek(pos),
        }
    }
}

impl lofty::io::Truncate for WorkingCopy {
    type Error = io::Error;

    fn truncate(&mut self, new_len: u64) -> Result<(), Self::Error> {
        self.dirty = true;
        match &mut self.inner {
            Inner::Memory(c) => {
                c.get_mut().truncate(new_len as usize);
                Ok(())
            }
            Inner::Disk(f) => f.set_len(new_len),
        }
    }
}

impl lofty::io::Length for WorkingCopy {
    type Error = io::Error;

    fn len(&self) -> Result<u64, Self::Error> {
        match &self.inner {
            Inner::Memory(c) => Ok(c.get_ref().len() as u64),
            Inner::Disk(f) => f.metadata().map(|m| m.len()),
        }
    }
}

impl WorkingCopy {
    /// Back to the start, where lofty's probes and writers expect to begin.
    pub(crate) fn rewind_to_start(&mut self) -> Result<(), String> {
        self.seek(SeekFrom::Start(0)).map(|_| ()).map_err(|e| e.to_string())
    }

    /// Parses the copy the way `lofty::read_from_path(path)` parses the file:
    /// the type comes from `path`'s extension, with no content sniffing, so a
    /// file reads identically from disk and from its working copy.
    pub(crate) fn parse(&mut self, path: &str, options: ParseOptions) -> Result<TaggedFile, String> {
        self.rewind_to_start()?;
        let probe = match FileType::from_path(path) {
            Some(file_type) => Probe::with_file_type(&mut *self, file_type),
            // Same "no format could be determined" error `read_from_path` gives.
            None => Probe::new(&mut *self),
        };
        probe.options(options).read().map_err(|e| e.to_string())
    }
}

// --- one edit per file at a time --------------------------------------------

/// Files with an edit in progress in this process. Two edits of one file at
/// once — a batch write and a cover-art swap, or two raw fields of the same
/// file in one batch — would each start from the old contents, and whichever
/// finished last would silently undo the other.
static EDITING: (Mutex<Option<HashSet<PathBuf>>>, Condvar) = (Mutex::new(None), Condvar::new());

struct EditLock(PathBuf);

impl EditLock {
    fn acquire(path: &Path) -> Self {
        // One key per file however it is spelled (case, `.\`, short names).
        let key = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        let (lock, cv) = &EDITING;
        let mut held = lock.lock().unwrap_or_else(|e| e.into_inner());
        while held.get_or_insert_with(HashSet::new).contains(&key) {
            held = cv.wait(held).unwrap_or_else(|e| e.into_inner());
        }
        held.get_or_insert_with(HashSet::new).insert(key.clone());
        EditLock(key)
    }
}

impl Drop for EditLock {
    fn drop(&mut self) {
        let (lock, cv) = &EDITING;
        if let Some(held) = lock.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
            held.remove(&self.0);
        }
        cv.notify_all();
    }
}

// --- the edit itself ----------------------------------------------------------

/// Runs `edit` on a working copy of `path` and, if it wrote anything, swaps
/// the result in atomically. An `Err` from `edit` (or from saving) leaves the
/// file exactly as it was.
pub(crate) fn edit_file<T>(path: &str, edit: impl FnOnce(&mut WorkingCopy) -> Result<T, String>) -> Result<T, String> {
    edit_file_with(path, IN_MEMORY_MAX, temp_sibling, edit)
}

#[cfg(test)]
fn edit_file_with_limit<T>(
    path: &str,
    in_memory_max: u64,
    edit: impl FnOnce(&mut WorkingCopy) -> Result<T, String>,
) -> Result<T, String> {
    edit_file_with(path, in_memory_max, temp_sibling, edit)
}

/// Whether a failure to create the temporary copy means "this folder won't
/// take a new file" - a NAS share that vetoes dot-files, a folder that allows
/// editing files but not creating them - rather than a real problem. Then the
/// edit falls back to lofty's old in-place write instead of failing every
/// save there. A full disk is deliberately not one: an in-place write would
/// then die half way and truncate the track.
fn can_write_in_place_instead(e: &io::Error) -> bool {
    matches!(e.kind(), io::ErrorKind::PermissionDenied | io::ErrorKind::NotFound)
}

fn edit_file_with<T>(
    path: &str,
    in_memory_max: u64,
    temp_for: impl Fn(&Path) -> PathBuf,
    edit: impl FnOnce(&mut WorkingCopy) -> Result<T, String>,
) -> Result<T, String> {
    // A symlinked track is edited where it really lives: renaming over the
    // link itself would turn it into a detached copy.
    let real = std::fs::symlink_metadata(path)
        .is_ok_and(|m| m.file_type().is_symlink())
        .then(|| std::fs::canonicalize(path).ok())
        .flatten();
    let target = real.as_deref().unwrap_or(Path::new(path));
    let _lock = EditLock::acquire(target);
    let meta = std::fs::metadata(target).map_err(|e| e.to_string())?;
    if meta.permissions().readonly() {
        // lofty's in-place open failed on these; a rename would sail past the
        // read-only flag on some systems, so refuse explicitly instead.
        return Err("The file is read-only".to_string());
    }

    let temp = temp_for(target);
    let result = (|| {
        // `in_place`: the working copy *is* the original (the fallback above),
        // so there is nothing to swap in afterwards.
        let (inner, in_place) = if meta.len() <= in_memory_max {
            (Inner::Memory(Cursor::new(std::fs::read(target).map_err(|e| e.to_string())?)), false)
        } else {
            match std::fs::copy(target, &temp) {
                Ok(_) => (Inner::Disk(open_rw(&temp)?), false),
                Err(e) if can_write_in_place_instead(&e) => (Inner::Disk(open_rw(target)?), true),
                Err(e) => return Err(format!("Couldn't make a working copy: {e}")),
            }
        };
        let mut work = WorkingCopy { inner, dirty: false };
        let value = edit(&mut work)?;
        if work.dirty && !in_place {
            let file = match work.inner {
                Inner::Memory(cursor) => match File::create(&temp) {
                    Ok(mut f) => {
                        f.write_all(cursor.get_ref()).map_err(|e| format!("Couldn't write a working copy: {e}"))?;
                        f
                    }
                    Err(e) if can_write_in_place_instead(&e) => {
                        let mut f = OpenOptions::new().write(true).truncate(true).open(target).map_err(|e| e.to_string())?;
                        f.write_all(cursor.get_ref()).map_err(|e| e.to_string())?;
                        return Ok(value);
                    }
                    Err(e) => return Err(format!("Couldn't write a working copy: {e}")),
                },
                Inner::Disk(f) => f,
            };
            carry_over_metadata(&file, &meta);
            drop(file);
            replace(&temp, target)?;
        }
        Ok(value)
    })();
    // Gone after a successful rename; otherwise this is the leftover copy.
    let _ = std::fs::remove_file(&temp);
    result
}

fn open_rw(path: &Path) -> Result<File, String> {
    OpenOptions::new().read(true).write(true).open(path).map_err(|e| e.to_string())
}

/// A unique, non-audio name beside `path`: same folder so the final rename
/// never crosses volumes, and an extension no scan picks up as a track.
fn temp_sibling(path: &Path) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    path.with_file_name(format!(".mtc-{}-{n}.tmp", std::process::id()))
}

/// What the replaced file should keep: its permissions and, on Windows, its
/// creation date (Explorer's "Date created"). Best effort — the edit itself
/// already succeeded.
fn carry_over_metadata(file: &File, original: &Metadata) {
    let _ = file.set_permissions(original.permissions());
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileTimesExt;
        if let Ok(created) = original.created() {
            let _ = file.set_times(std::fs::FileTimes::new().set_created(created));
        }
    }
}

/// Renames `temp` over `target`, retrying briefly: a virus scanner or the
/// search indexer looking at the just-written copy can make the first attempt
/// fail with a sharing violation for a few milliseconds.
fn replace(temp: &Path, target: &Path) -> Result<(), String> {
    let mut attempt = 0;
    loop {
        match std::fs::rename(temp, target) {
            Ok(()) => return Ok(()),
            Err(e) if attempt < 4 && e.kind() != io::ErrorKind::NotFound => {
                attempt += 1;
                std::thread::sleep(std::time::Duration::from_millis(25 * attempt));
            }
            Err(e) if e.kind() == io::ErrorKind::PermissionDenied => {
                return Err(format!(
                    "Couldn't replace the file — it may be open in another program (a DJ app, a player): {e}"
                ))
            }
            Err(e) => return Err(format!("Couldn't replace the file: {e}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mtc-safesave-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn leftovers(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".tmp"))
            .collect()
    }

    fn append(work: &mut WorkingCopy, text: &[u8]) -> Result<(), String> {
        work.seek(SeekFrom::End(0)).map_err(|e| e.to_string())?;
        work.write_all(text).map_err(|e| e.to_string())
    }

    #[test]
    fn an_edit_replaces_the_file_in_memory_and_through_a_disk_copy() {
        for limit in [IN_MEMORY_MAX, 0] {
            let dir = scratch("edit");
            let path = dir.join("a.mp3");
            std::fs::write(&path, b"head").unwrap();
            edit_file_with_limit(path.to_str().unwrap(), limit, |w| append(w, b"-tail")).unwrap();
            assert_eq!(std::fs::read(&path).unwrap(), b"head-tail", "limit {limit}");
            assert!(leftovers(&dir).is_empty(), "no temp file left (limit {limit})");
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn a_failed_edit_leaves_the_original_untouched() {
        for limit in [IN_MEMORY_MAX, 0] {
            let dir = scratch("fail");
            let path = dir.join("a.mp3");
            std::fs::write(&path, b"original bytes").unwrap();
            // The edit truncates — exactly where lofty's own write used to die
            // — and then fails.
            let err = edit_file_with_limit(path.to_str().unwrap(), limit, |w| -> Result<(), String> {
                lofty::io::Truncate::truncate(w, 0).map_err(|e| e.to_string())?;
                Err("simulated failure mid-write".into())
            });
            assert!(err.is_err());
            assert_eq!(std::fs::read(&path).unwrap(), b"original bytes", "limit {limit}");
            assert!(leftovers(&dir).is_empty());
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// A folder that won't take the temporary file (here: one that doesn't
    /// exist, as a vetoed name on a NAS share reports) still gets its edit,
    /// written in place the old way, for both working-copy kinds.
    #[test]
    fn a_folder_refusing_the_temporary_copy_falls_back_to_an_in_place_write() {
        for limit in [IN_MEMORY_MAX, 0] {
            let dir = scratch("fallback");
            let path = dir.join("a.mp3");
            std::fs::write(&path, b"head").unwrap();
            let nowhere = |_: &Path| dir.join("missing-folder").join("x.tmp");
            edit_file_with(path.to_str().unwrap(), limit, nowhere, |w| append(w, b"-tail")).unwrap();
            assert_eq!(std::fs::read(&path).unwrap(), b"head-tail", "limit {limit}");
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn an_edit_that_writes_nothing_does_not_touch_the_file() {
        let dir = scratch("noop");
        let path = dir.join("a.flac");
        std::fs::write(&path, b"same").unwrap();
        let before = std::fs::metadata(&path).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        let n = edit_file(path.to_str().unwrap(), |w| {
            let mut s = String::new();
            w.read_to_string(&mut s).map_err(|e| e.to_string())?;
            Ok(s.len())
        })
        .unwrap();
        assert_eq!(n, 4);
        assert_eq!(std::fs::metadata(&path).unwrap().modified().unwrap(), before);
        assert!(leftovers(&dir).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_read_only_file_is_refused_and_kept() {
        let dir = scratch("ro");
        let path = dir.join("a.mp3");
        std::fs::write(&path, b"keep").unwrap();
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&path, perms.clone()).unwrap();
        assert!(edit_file(path.to_str().unwrap(), |w| append(w, b"x")).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"keep");
        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);
        std::fs::set_permissions(&path, perms).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Edits of one file serialize: each starts from the previous one's result,
    /// so none is lost — the race two parallel raw-field writes used to lose.
    #[test]
    fn concurrent_edits_of_one_file_all_land() {
        let dir = scratch("race");
        let path = dir.join("a.mp3");
        std::fs::write(&path, b"").unwrap();
        let p = path.to_str().unwrap().to_string();
        std::thread::scope(|s| {
            for i in 0..8u8 {
                let p = p.clone();
                s.spawn(move || {
                    edit_file(&p, |w| {
                        // Widen the window a lost update would need.
                        std::thread::sleep(std::time::Duration::from_millis(5));
                        append(w, &[b'a' + i])
                    })
                    .unwrap()
                });
            }
        });
        let mut got = std::fs::read(&path).unwrap();
        got.sort();
        assert_eq!(got, b"abcdefgh");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn the_creation_date_survives_the_replace() {
        let dir = scratch("ctime");
        let path = dir.join("a.mp3");
        std::fs::write(&path, b"x").unwrap();
        let created = std::fs::metadata(&path).unwrap().created().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(50));
        edit_file(path.to_str().unwrap(), |w| append(w, b"y")).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().created().unwrap(), created);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
