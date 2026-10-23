//! A durable second copy of the settings.
//!
//! Settings live in `settings.json`, written by the store plugin with a plain
//! `fs::write` (truncate, then write) and read back with any parse error
//! ignored. So a save cut short — the app killed mid-write, a power cut
//! before the data reached the disk — left an empty or half-written file,
//! the next launch silently started from defaults, and the first save after
//! that overwrote the owner's settings for good.
//!
//! The frontend sends every successful save here as well; this copy is
//! written to a temp file, flushed and renamed into place, so it is always a
//! complete earlier version. `useSettings` falls back to it when the store
//! comes back empty.

use std::io::Write;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

const BACKUP_FILE: &str = "settings.backup.json";

fn backup_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(BACKUP_FILE))
}

/// Writes `contents` to `path` so that `path` is never partial: temp file
/// beside it, flushed to the device (settings are tiny, so the cost is a few
/// milliseconds), then one rename.
pub(crate) fn write_durably(path: &Path, contents: &str) -> Result<(), String> {
    let mut name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(".tmp");
    let temp = path.with_file_name(name);
    let result = (|| {
        let mut f = std::fs::File::create(&temp).map_err(|e| e.to_string())?;
        f.write_all(contents.as_bytes()).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
        drop(f);
        std::fs::rename(&temp, path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

/// The last saved settings document, if there is a readable one.
pub(crate) fn read_backup(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    // Only a document that parses is worth offering back.
    serde_json::from_str::<serde_json::Value>(&text).ok()?.is_object().then_some(text)
}

/// The newest `seq` written so far. Saves arrive in bursts and these commands
/// run concurrently, so a later save can be handled first: writes are taken
/// one at a time (they share a temp file), and one older than what is already
/// on disk is dropped instead of replacing newer settings.
static LAST_SEQ: std::sync::Mutex<u64> = std::sync::Mutex::new(0);

pub(crate) fn write_if_newer(path: &Path, seq: u64, json: &str) -> Result<(), String> {
    let mut last = LAST_SEQ.lock().unwrap_or_else(|e| e.into_inner());
    if seq < *last {
        return Ok(());
    }
    write_durably(path, json)?;
    *last = seq;
    Ok(())
}

#[tauri::command]
pub async fn settings_backup_write(app: AppHandle, seq: u64, json: String) -> Result<(), String> {
    let path = backup_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || write_if_newer(&path, seq, &json))
        .await
        .map_err(|_| "Saving the settings backup failed unexpectedly".to_string())?
}

#[tauri::command]
pub async fn settings_backup_read(app: AppHandle) -> Result<Option<String>, String> {
    let path = backup_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || read_backup(&path))
        .await
        .map_err(|_| "Reading the settings backup failed unexpectedly".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_backup_round_trips_and_a_broken_one_is_not_offered() {
        let dir = std::env::temp_dir().join(format!("mtc-settings-backup-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(BACKUP_FILE);
        assert_eq!(read_backup(&path), None, "nothing saved yet");

        write_durably(&path, r#"{"settings":{"libraryFolder":"C:/Music"}}"#).unwrap();
        write_durably(&path, r#"{"settings":{"libraryFolder":"D:/Music"}}"#).unwrap();
        assert_eq!(read_backup(&path).as_deref(), Some(r#"{"settings":{"libraryFolder":"D:/Music"}}"#));
        assert!(!dir.join(format!("{BACKUP_FILE}.tmp")).exists());

        // A truncated or emptied file - what a cut-short write leaves - is
        // reported as no backup rather than as something to load.
        std::fs::write(&path, r#"{"settings":{"libr"#).unwrap();
        assert_eq!(read_backup(&path), None);
        std::fs::write(&path, "").unwrap();
        assert_eq!(read_backup(&path), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_older_save_arriving_late_does_not_replace_a_newer_one() {
        let dir = std::env::temp_dir().join(format!("mtc-settings-seq-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(BACKUP_FILE);
        // Well above anything another test could have stored in LAST_SEQ.
        let base = u64::MAX / 2;
        write_if_newer(&path, base + 2, r#"{"settings":{"v":2}}"#).unwrap();
        write_if_newer(&path, base + 1, r#"{"settings":{"v":1}}"#).unwrap();
        assert_eq!(read_backup(&path).as_deref(), Some(r#"{"settings":{"v":2}}"#));
        write_if_newer(&path, base + 3, r#"{"settings":{"v":3}}"#).unwrap();
        assert_eq!(read_backup(&path).as_deref(), Some(r#"{"settings":{"v":3}}"#));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
