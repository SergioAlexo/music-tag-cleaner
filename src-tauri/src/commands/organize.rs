//! B4: "Move to collection" (pattern-driven organise) and the relocatable,
//! snapshot-able library database.
//!
//! Two unrelated halves that share a file because both are small and both
//! answer "where do my files live":
//!   1. Rendering `{genre}/{artist} - {title}.{ext}` into a destination under
//!      `collectionRoot`, previewing conflicts, then moving (rename when the
//!      volume is the same, copy + verify + delete otherwise). Never overwrites.
//!   2. Putting the sqlite index somewhere the owner can back up, plus
//!      snapshot export/restore. The *live* db should not sit in a syncing
//!      folder (OneDrive/Dropbox and sqlite's WAL corrupt each other), which
//!      is why snapshots exist: a folder that syncs is fine for snapshots.
//!
//! `library_index::db_path` consults `resolve_db_path` here; nothing else in
//! the index code knows the file can move.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};

use crate::commands::library_index;

// --- Pattern rendering ------------------------------------------------------

/// Tag values for one track. All optional; empty ones render as a placeholder
/// for the path-forming tokens and as nothing for the rest.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizeItem {
    pub path: String,
    pub genre: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub artist: Option<String>,
    pub title: Option<String>,
    pub year: Option<String>,
    pub bpm: Option<String>,
    pub key: Option<String>,
    pub track_id: Option<String>,
}

pub const DEFAULT_PATTERN: &str = "{genre}/{artist} - {title}.{ext}";
/// Windows' classic MAX_PATH is 260 including the terminator; stay clear of it
/// so the moved file is still openable by every DJ app.
const MAX_TOTAL_PATH: usize = 250;
const MAX_SEGMENT: usize = 120;

const RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Makes one path segment legal on Windows (the strictest of the three
/// platforms, so a collection built here also works on a Mac or on exFAT USB).
pub fn sanitize_segment(s: &str) -> String {
    let mut out: String = s
        .chars()
        .map(|c| match c {
            '/' | '\\' => '-',
            '<' | '>' | ':' | '"' | '|' | '?' | '*' => '_',
            c if (c as u32) < 32 => '_',
            c => c,
        })
        .collect();
    // Collapse the whitespace runs that empty tokens leave behind.
    out = out.split_whitespace().collect::<Vec<_>>().join(" ");
    // Windows silently strips trailing dots/spaces, which would make the path
    // we report differ from the one on disk.
    out = out.trim_matches(|c: char| c == '.' || c == ' ').to_string();
    let head = out.split('.').next().unwrap_or("").to_ascii_uppercase();
    if RESERVED.contains(&head.as_str()) {
        out.insert(0, '_');
    }
    truncate_chars(&out, MAX_SEGMENT)
}

fn truncate_chars(s: &str, max: usize) -> String {
    let t: String = s.chars().take(max).collect();
    t.trim_end_matches(|c: char| c == '.' || c == ' ').to_string()
}

fn token_value(item: &OrganizeItem, token: &str, ext: &str, stem_fallback: &str) -> Option<String> {
    let clean = |o: &Option<String>| {
        o.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(String::from)
    };
    match token {
        "genre" => Some(clean(&item.genre).unwrap_or_else(|| "Unknown Genre".into())),
        "album" => Some(clean(&item.album).unwrap_or_else(|| "Unknown Album".into())),
        "albumartist" => clean(&item.album_artist)
            .or_else(|| clean(&item.artist))
            .or(Some("Unknown Artist".into())),
        "artist" => Some(clean(&item.artist).unwrap_or_else(|| "Unknown Artist".into())),
        "title" => Some(clean(&item.title).unwrap_or_else(|| stem_fallback.to_string())),
        "year" => Some(clean(&item.year).map(|y| y.chars().take(4).collect()).unwrap_or_default()),
        "bpm" => Some(clean(&item.bpm).unwrap_or_default()),
        "key" => Some(clean(&item.key).unwrap_or_default()),
        "trackid" => Some(clean(&item.track_id).unwrap_or_default()),
        "ext" => Some(ext.to_string()),
        _ => None,
    }
}

/// Renders `pattern` for `item` into a path relative to the collection root.
/// `root_len` is the length of the root so the whole result can be kept under
/// the Windows path limit by shortening the file name (never the folders, which
/// would make two long titles collide into one folder name).
pub fn render_pattern(pattern: &str, item: &OrganizeItem, root_len: usize) -> Result<PathBuf, String> {
    let src = Path::new(&item.path);
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let stem_fallback = src.file_stem().and_then(|s| s.to_str()).unwrap_or("Unknown").to_string();

    let pattern = if pattern.trim().is_empty() { DEFAULT_PATTERN } else { pattern.trim() };
    // The file must keep its extension even if the pattern forgot {ext}.
    let mut pattern = pattern.to_string();
    if !pattern.contains("{ext}") && !ext.is_empty() {
        pattern.push_str(".{ext}");
    }

    let mut segments: Vec<String> = Vec::new();
    for raw in pattern.split(|c| c == '/' || c == '\\') {
        let mut seg = String::new();
        let mut rest = raw;
        while let Some(open) = rest.find('{') {
            seg.push_str(&rest[..open]);
            match rest[open..].find('}') {
                Some(close) => {
                    let name = rest[open + 1..open + close].trim().to_ascii_lowercase();
                    match token_value(item, &name, &ext, &stem_fallback) {
                        Some(v) => seg.push_str(&v),
                        None => return Err(format!("Unknown token {{{name}}} in pattern")),
                    }
                    rest = &rest[open + close + 1..];
                }
                None => {
                    seg.push_str(&rest[open..]);
                    rest = "";
                }
            }
        }
        seg.push_str(rest);
        segments.push(seg);
    }

    // Sanitise each segment on its own so a "/" inside a tag value can never
    // add a folder level. The last segment is the file name.
    let last = segments.len().saturating_sub(1);
    let suffix = format!(".{ext}");
    let has_ext = !ext.is_empty();
    // The file segment is sanitised without its extension so the 120-char cap
    // can never chop the extension off.
    let mut cleaned: Vec<String> = segments
        .iter()
        .enumerate()
        .map(|(i, s)| {
            if i == last && has_ext && s.to_ascii_lowercase().ends_with(&suffix) {
                let stem = sanitize_segment(&s[..s.len() - suffix.len()]);
                if stem.is_empty() {
                    String::new()
                } else {
                    format!("{stem}{suffix}")
                }
            } else {
                sanitize_segment(s)
            }
        })
        .collect();
    let file_seg = cleaned.pop().unwrap_or_default();
    cleaned.retain(|s| !s.is_empty());
    if file_seg.is_empty() {
        return Err("Pattern produced an empty file name".into());
    }

    // Fit the total length by trimming the stem of the file name.
    let dir_len: usize = cleaned.iter().map(|s| s.chars().count() + 1).sum();
    let (stem, dot_ext) = match file_seg.rfind('.') {
        Some(i) if i > 0 && !ext.is_empty() && file_seg[i + 1..].eq_ignore_ascii_case(&ext) => {
            (file_seg[..i].to_string(), file_seg[i..].to_string())
        }
        _ => (file_seg.clone(), String::new()),
    };
    let fixed = root_len + 1 + dir_len + dot_ext.chars().count() + 4; // +4: room for " (2)"
    let budget = MAX_TOTAL_PATH.saturating_sub(fixed).max(20);
    let stem = truncate_chars(&stem, budget);
    let file_name = format!("{stem}{dot_ext}");

    let mut rel = PathBuf::new();
    for s in cleaned {
        rel.push(s);
    }
    rel.push(file_name);
    Ok(rel)
}

// --- Planning -----------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanEntry {
    pub from: String,
    pub to: String,
    /// "move" | "inPlace" (already where the pattern wants it) | "renamed"
    /// (target taken by a different file; a " (n)" suffix was added) | "error"
    pub status: String,
    pub note: Option<String>,
}

fn same_file(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    matches!((fs::canonicalize(a), fs::canonicalize(b)), (Ok(x), Ok(y)) if x == y)
}

fn with_suffix(target: &Path, n: u32) -> PathBuf {
    let stem = target.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    let name = match target.extension().and_then(|e| e.to_str()) {
        Some(e) => format!("{stem} ({n}).{e}"),
        None => format!("{stem} ({n})"),
    };
    target.with_file_name(name)
}

/// First free spelling of `target`: itself if nothing is there (or if what is
/// there *is* `src`), otherwise " (2)", " (3)"... `claimed` holds targets already
/// promised to earlier items in the same batch (compared case-insensitively,
/// like the filesystems we care about).
fn free_target(src: &Path, target: PathBuf, claimed: &HashSet<String>) -> PathBuf {
    let taken = |p: &Path| {
        claimed.contains(&p.to_string_lossy().to_lowercase()) || (p.exists() && !same_file(src, p))
    };
    if !taken(&target) {
        return target;
    }
    let mut n = 2;
    loop {
        let cand = with_suffix(&target, n);
        if !taken(&cand) {
            return cand;
        }
        n += 1;
    }
}

pub fn plan_moves(items: &[OrganizeItem], root: &str, pattern: &str) -> Vec<PlanEntry> {
    let root_path = Path::new(root);
    let mut claimed: HashSet<String> = HashSet::new();
    items
        .iter()
        .map(|item| {
            let src = Path::new(&item.path);
            let err = |msg: String| PlanEntry {
                from: item.path.clone(),
                to: String::new(),
                status: "error".into(),
                note: Some(msg),
            };
            if root.trim().is_empty() {
                return err("Set a collection folder in Settings first".into());
            }
            if !src.is_file() {
                return err("File not found".into());
            }
            let rel = match render_pattern(pattern, item, root.chars().count()) {
                Ok(r) => r,
                Err(e) => return err(e),
            };
            let wanted = root_path.join(rel);
            if same_file(src, &wanted) {
                claimed.insert(src.to_string_lossy().to_lowercase());
                return PlanEntry {
                    from: item.path.clone(),
                    to: item.path.clone(),
                    status: "inPlace".into(),
                    note: None,
                };
            }
            let target = free_target(src, wanted.clone(), &claimed);
            claimed.insert(target.to_string_lossy().to_lowercase());
            let renamed = target != wanted;
            PlanEntry {
                from: item.path.clone(),
                to: target.to_string_lossy().to_string(),
                status: if renamed { "renamed" } else { "move" }.into(),
                note: renamed.then(|| "A different file already has that name".into()),
            }
        })
        .collect()
}

// --- Moving -------------------------------------------------------------------

/// Copy to a `.part` sibling, verify the byte count, publish with a rename,
/// then delete the source. Used when `fs::rename` can't cross volumes. The
/// source is only removed after the copy is verified, so a failure at any
/// point leaves the original intact.
pub fn copy_verify_delete(src: &Path, dst: &Path) -> Result<(), String> {
    let part = dst.with_file_name(format!(
        "{}.part",
        dst.file_name().and_then(|n| n.to_str()).unwrap_or("move")
    ));
    let _ = fs::remove_file(&part);
    let result = (|| -> Result<(), String> {
        let want = fs::metadata(src).map_err(|e| e.to_string())?.len();
        fs::copy(src, &part).map_err(|e| format!("Copy failed: {e}"))?;
        let got = fs::metadata(&part).map_err(|e| e.to_string())?.len();
        if got != want {
            return Err(format!("Copy verification failed ({got} of {want} bytes)"));
        }
        if dst.exists() {
            return Err("Destination appeared while copying; not overwriting".into());
        }
        fs::rename(&part, dst).map_err(|e| e.to_string())?;
        Ok(())
    })();
    if let Err(e) = result {
        let _ = fs::remove_file(&part);
        return Err(e);
    }
    fs::remove_file(src).map_err(|e| format!("Copied, but couldn't remove the original: {e}"))
}

/// Moves `src` to `dst`, never overwriting. If `dst` has meanwhile been taken
/// by another file, the first free " (n)" spelling is used. Returns the final path.
pub fn move_file_safely(src: &Path, dst: &Path) -> Result<PathBuf, String> {
    if !src.is_file() {
        return Err(format!("File not found: {}", src.display()));
    }
    if same_file(src, dst) {
        return Ok(src.to_path_buf());
    }
    let dst = free_target(src, dst.to_path_buf(), &HashSet::new());
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // fs::rename silently replaces an existing file on Windows/Unix, hence
    // free_target() first. The window between the check and the rename is tiny
    // and only another process creating that exact name could hit it.
    match fs::rename(src, &dst) {
        Ok(()) => Ok(dst),
        Err(_) => {
            copy_verify_delete(src, &dst)?;
            Ok(dst)
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct MoveReq {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveResult {
    pub from: String,
    pub to: String,
    pub ok: bool,
    pub error: Option<String>,
}

fn csv_field(s: &str) -> String {
    if s.contains(',') || s.contains('"') || s.contains('\n') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

pub fn moves_csv(pairs: &[(String, String)]) -> String {
    let mut out = String::from("old_path,new_path\r\n");
    for (a, b) in pairs {
        out.push_str(&format!("{},{}\r\n", csv_field(a), csv_field(b)));
    }
    out
}

fn stamp(fmt: &str) -> String {
    chrono::Local::now().format(fmt).to_string()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveOutcome {
    pub results: Vec<MoveResult>,
    /// Where the old->new CSV was written (for C2 sync / Rekordbox relocate).
    pub csv_path: Option<String>,
}

fn run_moves(app: &AppHandle, moves: Vec<MoveReq>) -> Result<MoveOutcome, String> {
    let mut results = Vec::with_capacity(moves.len());
    let mut done: Vec<(String, String)> = Vec::new();
    // Sequential on purpose: collision suffixes are resolved against disk.
    for m in moves {
        match move_file_safely(Path::new(&m.from), Path::new(&m.to)) {
            Ok(final_path) => {
                let to = final_path.to_string_lossy().to_string();
                if to != m.from {
                    done.push((m.from.clone(), to.clone()));
                }
                results.push(MoveResult { from: m.from, to, ok: true, error: None });
            }
            Err(e) => results.push(MoveResult { from: m.from, to: m.to, ok: false, error: Some(e) }),
        }
    }
    let mut csv_path = None;
    if !done.is_empty() {
        let touched: Vec<String> = done.iter().flat_map(|(a, b)| [a.clone(), b.clone()]).collect();
        // Index failures must not undo a completed move; the next re-index heals.
        let _ = library_index::reindex_paths(app, &touched);
        if let Ok(dir) = app.path().app_data_dir() {
            let dir = dir.join("move-maps");
            if fs::create_dir_all(&dir).is_ok() {
                let p = dir.join(format!("move-map-{}.csv", stamp("%Y%m%d-%H%M%S")));
                if fs::write(&p, moves_csv(&done)).is_ok() {
                    csv_path = Some(p.to_string_lossy().to_string());
                }
            }
        }
    }
    Ok(MoveOutcome { results, csv_path })
}

#[tauri::command]
pub async fn organize_preview(
    items: Vec<OrganizeItem>,
    root: String,
    pattern: String,
) -> Result<Vec<PlanEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || plan_moves(&items, &root, &pattern))
        .await
        .map_err(|_| "Planning the move failed unexpectedly".to_string())
}

#[tauri::command]
pub async fn organize_move(app: AppHandle, moves: Vec<MoveReq>) -> Result<MoveOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || run_moves(&app, moves))
        .await
        .map_err(|_| "Moving files failed unexpectedly".to_string())?
}

/// Reverses a previous `organize_move`: each `to` goes back to its `from`.
#[tauri::command]
pub async fn organize_undo(app: AppHandle, moves: Vec<MoveReq>) -> Result<MoveOutcome, String> {
    let reversed = moves.into_iter().map(|m| MoveReq { from: m.to, to: m.from }).collect();
    tauri::async_runtime::spawn_blocking(move || run_moves(&app, reversed))
        .await
        .map_err(|_| "Undoing the move failed unexpectedly".to_string())?
}

// --- Library db location ------------------------------------------------------

const DB_FILE: &str = "library-index.sqlite";
const POINTER_FILE: &str = "db-location.txt";
const SNAPSHOT_CONFIG: &str = "snapshot-config.json";

/// Where the index lives. `data_dir` is the app-data directory, which also
/// holds the pointer file (the db can't store its own location). A pointer to
/// a folder that no longer exists (unplugged drive) falls back to the default
/// so the app still opens; `library_db_info` reports the mismatch.
pub fn resolve_db_path(data_dir: &Path) -> PathBuf {
    configured_db_path(data_dir)
        .filter(|p| p.parent().map(|d| d.is_dir()).unwrap_or(false))
        .unwrap_or_else(|| data_dir.join(DB_FILE))
}

fn configured_db_path(data_dir: &Path) -> Option<PathBuf> {
    let text = fs::read_to_string(data_dir.join(POINTER_FILE)).ok()?;
    let t = text.trim();
    (!t.is_empty()).then(|| PathBuf::from(t))
}

fn app_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Opens `path` and returns Err unless it is a sound sqlite db with our table.
pub fn verify_db(path: &Path) -> Result<i64, String> {
    let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("Can't open {}: {e}", path.display()))?;
    let check: String = conn
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if check != "ok" {
        return Err(format!("Integrity check failed: {check}"));
    }
    conn.query_row("SELECT COUNT(*) FROM library_track", [], |r| r.get(0))
        .map_err(|_| "Not a Music Tag Cleaner library file (no library_track table)".to_string())
}

/// Consistent copy of a live db (folds in the WAL) to a new file.
fn vacuum_into(src: &Path, dst: &Path) -> Result<(), String> {
    let conn = Connection::open(src).map_err(|e| e.to_string())?;
    let _ = conn.busy_timeout(std::time::Duration::from_secs(10));
    let _ = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()));
    if let Some(p) = dst.parent() {
        fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    if dst.exists() {
        fs::remove_file(dst).map_err(|e| e.to_string())?;
    }
    conn.execute("VACUUM INTO ?1", [dst.to_string_lossy().as_ref()])
        .map_err(|e| format!("Couldn't write {}: {e}", dst.display()))?;
    Ok(())
}

fn remove_wal(db: &Path) {
    for suffix in ["-wal", "-shm"] {
        let mut s = db.as_os_str().to_os_string();
        s.push(suffix);
        let _ = fs::remove_file(PathBuf::from(s));
    }
}

fn bak_path(p: &Path) -> PathBuf {
    let mut s = p.as_os_str().to_os_string();
    s.push(".bak");
    PathBuf::from(s)
}

/// Moves the db from `cur` to `target`: copy, verify, switch the pointer,
/// keep the old file as `.bak`. `pointer` is what to write ("" = default).
pub fn relocate_db(data_dir: &Path, cur: &Path, target: &Path, pointer: &str) -> Result<(), String> {
    if target == cur {
        return Ok(());
    }
    if target.exists() {
        return Err(format!(
            "{} already exists. Pick a new file name, or use Restore to load it.",
            target.display()
        ));
    }
    let before = if cur.exists() { Some(verify_db(cur)?) } else { None };
    if cur.exists() {
        vacuum_into(cur, target)?;
        let after = verify_db(target).map_err(|e| {
            let _ = fs::remove_file(target);
            e
        })?;
        if Some(after) != before {
            let _ = fs::remove_file(target);
            return Err("The copy has a different track count; nothing was changed".into());
        }
    } else if let Some(p) = target.parent() {
        // Nothing to copy yet; the schema is created on first open_db.
        fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    fs::write(data_dir.join(POINTER_FILE), pointer).map_err(|e| e.to_string())?;
    if cur.exists() {
        let bak = bak_path(cur);
        let _ = fs::remove_file(&bak);
        remove_wal(cur);
        fs::rename(cur, &bak).map_err(|e| format!("Switched, but couldn't keep the old file: {e}"))?;
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbInfo {
    pub path: String,
    pub default_path: String,
    pub is_default: bool,
    /// A custom location is set but its folder is unavailable, so the default is in use.
    pub configured_missing: bool,
    pub size_bytes: u64,
}

#[tauri::command]
pub fn library_db_info(app: AppHandle) -> Result<DbInfo, String> {
    let dir = app_dir(&app)?;
    let default_path = dir.join(DB_FILE);
    let live = resolve_db_path(&dir);
    let configured = configured_db_path(&dir);
    Ok(DbInfo {
        is_default: live == default_path,
        configured_missing: configured.map(|c| c != live).unwrap_or(false),
        size_bytes: fs::metadata(&live).map(|m| m.len()).unwrap_or(0),
        path: live.to_string_lossy().to_string(),
        default_path: default_path.to_string_lossy().to_string(),
    })
}

/// `new_path` empty = back to the default location.
#[tauri::command]
pub async fn set_library_db_path(app: AppHandle, new_path: String) -> Result<DbInfo, String> {
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let dir = app_dir(&app2)?;
        let cur = resolve_db_path(&dir);
        let t = new_path.trim();
        let (target, pointer) = if t.is_empty() {
            (dir.join(DB_FILE), String::new())
        } else {
            let mut p = PathBuf::from(t);
            if p.is_dir() {
                p.push(DB_FILE);
            }
            let ptr = p.to_string_lossy().to_string();
            (p, ptr)
        };
        relocate_db(&dir, &cur, &target, &pointer)
    })
    .await
    .map_err(|_| "Moving the library file failed unexpectedly".to_string())??;
    library_db_info(app)
}

// --- Snapshots ----------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotConfig {
    pub on_exit: bool,
    pub folder: String,
    pub keep: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInfo {
    pub sqlite_path: String,
    pub json_path: String,
    pub tracks: i64,
}

fn dump_table(conn: &Connection, table: &str) -> Result<Vec<Value>, String> {
    // `table` comes from sqlite_master / a constant, never from the user.
    let mut stmt = conn.prepare(&format!("SELECT * FROM \"{table}\"")).map_err(|e| e.to_string())?;
    let cols: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let rows = stmt
        .query_map([], |r| {
            let mut m = Map::new();
            for (i, c) in cols.iter().enumerate() {
                let v = match r.get_ref(i)? {
                    rusqlite::types::ValueRef::Null => Value::Null,
                    rusqlite::types::ValueRef::Integer(n) => json!(n),
                    rusqlite::types::ValueRef::Real(f) => json!(f),
                    rusqlite::types::ValueRef::Text(t) => json!(String::from_utf8_lossy(t)),
                    rusqlite::types::ValueRef::Blob(b) => json!(format!("<{} bytes>", b.len())),
                };
                m.insert(c.clone(), v);
            }
            Ok(Value::Object(m))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Readable dump: tracks (all columns, so new index columns are picked up
/// automatically), library roots, and any table whose name mentions "playlist".
pub fn library_json(db: &Path) -> Result<(Value, i64), String> {
    let conn = Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| e.to_string())?;
    let tracks = dump_table(&conn, "library_track")?;
    let n = tracks.len() as i64;
    let roots = dump_table(&conn, "library_root").unwrap_or_default();
    let mut playlists = Map::new();
    let names: Vec<String> = {
        let mut st = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%playlist%'")
            .map_err(|e| e.to_string())?;
        let v = st.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
        v.filter_map(Result::ok).collect()
    };
    for name in names {
        playlists.insert(name.clone(), Value::Array(dump_table(&conn, &name)?));
    }
    Ok((
        json!({
            "exportedAt": stamp("%Y-%m-%dT%H:%M:%S%z"),
            "trackCount": n,
            "roots": roots,
            "tracks": tracks,
            "playlists": playlists,
        }),
        n,
    ))
}

pub fn write_snapshot(live: &Path, folder: &Path, keep: usize) -> Result<SnapshotInfo, String> {
    fs::create_dir_all(folder).map_err(|e| e.to_string())?;
    let sqlite = folder.join(format!("library-{}.sqlite", stamp("%Y%m%d-%H%M")));
    vacuum_into(live, &sqlite)?;
    let tracks = verify_db(&sqlite)?;
    let (doc, _) = library_json(&sqlite)?;
    let json_path = folder.join("library.json");
    fs::write(&json_path, serde_json::to_vec_pretty(&doc).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if keep > 0 {
        let mut snaps: Vec<PathBuf> = fs::read_dir(folder)
            .map_err(|e| e.to_string())?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| {
                let n = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                n.starts_with("library-") && n.ends_with(".sqlite")
            })
            .collect();
        snaps.sort(); // timestamped names sort chronologically
        while snaps.len() > keep {
            let _ = fs::remove_file(snaps.remove(0));
        }
    }
    Ok(SnapshotInfo {
        sqlite_path: sqlite.to_string_lossy().to_string(),
        json_path: json_path.to_string_lossy().to_string(),
        tracks,
    })
}

#[tauri::command]
pub async fn export_library_snapshot(
    app: AppHandle,
    folder: String,
    keep: Option<usize>,
) -> Result<SnapshotInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let live = library_index::db_path(&app)?;
        write_snapshot(&live, Path::new(&folder), keep.unwrap_or(0))
    })
    .await
    .map_err(|_| "Exporting the snapshot failed unexpectedly".to_string())?
}

/// Replaces the live index with a snapshot. The previous live file is kept as
/// `<name>.pre-restore.bak` so a wrong pick is recoverable.
pub fn restore_snapshot(live: &Path, snapshot: &Path) -> Result<i64, String> {
    let n = verify_db(snapshot)?;
    let staged = live.with_extension("restore-tmp");
    vacuum_into(snapshot, &staged)?;
    if live.exists() {
        let mut keep = live.as_os_str().to_os_string();
        keep.push(".pre-restore.bak");
        let keep = PathBuf::from(keep);
        let _ = fs::remove_file(&keep);
        let conn = Connection::open(live).map_err(|e| e.to_string())?;
        let _ = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()));
        drop(conn);
        fs::rename(live, &keep).map_err(|e| e.to_string())?;
    }
    remove_wal(live);
    fs::rename(&staged, live).map_err(|e| e.to_string())?;
    Ok(n)
}

#[tauri::command]
pub async fn restore_library_snapshot(app: AppHandle, snapshot: String) -> Result<i64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let live = library_index::db_path(&app)?;
        restore_snapshot(&live, Path::new(&snapshot))
    })
    .await
    .map_err(|_| "Restoring the snapshot failed unexpectedly".to_string())?
}

/// Frontend mirrors its settings here so the exit hook (Rust, no JS left to
/// ask) knows whether and where to snapshot.
#[tauri::command]
pub fn set_snapshot_config(app: AppHandle, config: SnapshotConfig) -> Result<(), String> {
    let dir = app_dir(&app)?;
    fs::write(
        dir.join(SNAPSHOT_CONFIG),
        serde_json::to_vec(&config).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

/// Called from the main window's close request. Best effort, never blocks exit on error.
pub fn snapshot_on_exit(app: &AppHandle) {
    let Ok(dir) = app_dir(app) else { return };
    let Ok(bytes) = fs::read(dir.join(SNAPSHOT_CONFIG)) else { return };
    let Ok(cfg) = serde_json::from_slice::<SnapshotConfig>(&bytes) else { return };
    if !cfg.on_exit || cfg.folder.trim().is_empty() {
        return;
    }
    let live = resolve_db_path(&dir);
    if live.exists() {
        let _ = write_snapshot(&live, Path::new(&cfg.folder), cfg.keep);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("mtc-organize-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn item(path: &str) -> OrganizeItem {
        OrganizeItem {
            path: path.into(),
            genre: Some("House".into()),
            artist: Some("AC/DC".into()),
            title: Some("Who: Made? Who*".into()),
            ..Default::default()
        }
    }

    #[test]
    fn pattern_strips_illegal_chars_and_keeps_levels() {
        let rel = render_pattern(DEFAULT_PATTERN, &item("C:/x/a.MP3"), 10).unwrap();
        let parts: Vec<_> = rel.iter().map(|s| s.to_str().unwrap()).collect();
        assert_eq!(parts, ["House", "AC-DC - Who_ Made_ Who_.mp3"]);
    }

    #[test]
    fn pattern_defaults_and_appends_ext() {
        let mut it = item("C:/x/a.flac");
        it.genre = None;
        it.title = None;
        let rel = render_pattern("{genre}/{year}/{artist} - {title}", &it, 10).unwrap();
        // empty {year} segment is dropped; title falls back to the file stem
        assert_eq!(rel, PathBuf::from("Unknown Genre").join("AC-DC - a.flac"));
        assert!(render_pattern("{nope}/{title}.{ext}", &it, 0).is_err());
    }

    #[test]
    fn reserved_names_and_trailing_dots() {
        assert_eq!(sanitize_segment("CON"), "_CON");
        assert_eq!(sanitize_segment("Mr. Oizo..."), "Mr. Oizo");
        assert_eq!(sanitize_segment("  a   b  "), "a b");
    }

    #[test]
    fn long_titles_are_trimmed_to_fit() {
        let mut it = item("C:/x/a.mp3");
        it.title = Some("T".repeat(400));
        let root = "C:/Music/Collection";
        let rel = render_pattern(DEFAULT_PATTERN, &it, root.len()).unwrap();
        let full = format!("{root}/{}", rel.to_string_lossy());
        assert!(full.chars().count() <= MAX_TOTAL_PATH, "{}", full.chars().count());
        assert!(rel.to_string_lossy().ends_with(".mp3"));
    }

    #[test]
    fn plan_conflicts_get_suffix_only_for_different_files() {
        let d = tmp("plan");
        let root = d.join("coll");
        let a = d.join("a.mp3");
        let b = d.join("b.mp3");
        fs::write(&a, b"aaa").unwrap();
        fs::write(&b, b"bbb").unwrap();
        let mk = |p: &Path| OrganizeItem {
            path: p.to_string_lossy().into(),
            genre: Some("G".into()),
            artist: Some("A".into()),
            title: Some("T".into()),
            ..Default::default()
        };
        let plan = plan_moves(&[mk(&a), mk(&b)], root.to_str().unwrap(), DEFAULT_PATTERN);
        assert_eq!(plan[0].status, "move");
        assert_eq!(plan[1].status, "renamed"); // same batch target
        assert!(plan[1].to.ends_with("A - T (2).mp3"));

        // Already in place: not a conflict with itself.
        fs::create_dir_all(root.join("G")).unwrap();
        let placed = root.join("G").join("A - T.mp3");
        fs::write(&placed, b"x").unwrap();
        let plan = plan_moves(&[mk(&placed)], root.to_str().unwrap(), DEFAULT_PATTERN);
        assert_eq!(plan[0].status, "inPlace");
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn move_never_overwrites_and_cross_volume_path_verifies() {
        let d = tmp("move");
        let src = d.join("s.mp3");
        let existing = d.join("out").join("s.mp3");
        fs::create_dir_all(existing.parent().unwrap()).unwrap();
        fs::write(&src, b"new").unwrap();
        fs::write(&existing, b"old").unwrap();
        let got = move_file_safely(&src, &existing).unwrap();
        assert!(got.to_string_lossy().ends_with("s (2).mp3"));
        assert_eq!(fs::read(&existing).unwrap(), b"old");
        assert_eq!(fs::read(&got).unwrap(), b"new");
        assert!(!src.exists());

        // The copy+verify+delete branch (what a cross-volume move takes).
        let s2 = d.join("c.mp3");
        let t2 = d.join("out").join("c.mp3");
        fs::write(&s2, vec![7u8; 4096]).unwrap();
        copy_verify_delete(&s2, &t2).unwrap();
        assert!(!s2.exists());
        assert_eq!(fs::read(&t2).unwrap().len(), 4096);
        assert!(!d.join("out").join("c.mp3.part").exists());
        // Refuses to overwrite, and leaves the source alone.
        fs::write(&s2, b"z").unwrap();
        assert!(copy_verify_delete(&s2, &t2).is_err());
        assert!(s2.exists());
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn csv_quotes_commas_and_quotes() {
        let csv = moves_csv(&[("a,b".into(), "c\"d".into())]);
        assert_eq!(csv, "old_path,new_path\r\n\"a,b\",\"c\"\"d\"\r\n");
    }

    fn make_db(path: &Path, rows: i64) {
        let conn = Connection::open(path).unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        conn.execute_batch(
            "CREATE TABLE library_track (path TEXT PRIMARY KEY, title TEXT, track_id TEXT);
             CREATE TABLE library_root (path TEXT PRIMARY KEY, added_at INTEGER);",
        )
        .unwrap();
        for i in 0..rows {
            conn.execute(
                "INSERT INTO library_track VALUES (?1, ?2, ?3)",
                rusqlite::params![format!("/m/{i}.mp3"), format!("T{i}"), format!("{i:04}")],
            )
            .unwrap();
        }
    }

    #[test]
    fn db_relocation_round_trip() {
        let d = tmp("reloc");
        let data = d.join("data");
        let far = d.join("backup-drive");
        fs::create_dir_all(&data).unwrap();
        fs::create_dir_all(&far).unwrap();
        let live = data.join(DB_FILE);
        make_db(&live, 5);
        assert_eq!(resolve_db_path(&data), live);

        let target = far.join(DB_FILE);
        relocate_db(&data, &live, &target, target.to_str().unwrap()).unwrap();
        assert_eq!(resolve_db_path(&data), target);
        assert_eq!(verify_db(&target).unwrap(), 5);
        assert!(!live.exists());
        assert!(bak_path(&live).exists());

        // Back to default.
        relocate_db(&data, &target, &live, "").unwrap();
        assert_eq!(resolve_db_path(&data), live);
        assert_eq!(verify_db(&live).unwrap(), 5);

        // Refuses to clobber an existing file; unavailable folder falls back.
        assert!(relocate_db(&data, &live, &bak_path(&live), "x").is_err());
        fs::write(data.join(POINTER_FILE), far.join("gone").join("x.sqlite").to_str().unwrap()).unwrap();
        assert_eq!(resolve_db_path(&data), live);
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn snapshot_export_prune_and_restore() {
        let d = tmp("snap");
        let live = d.join(DB_FILE);
        make_db(&live, 3);
        let folder = d.join("snaps");
        // Pre-existing old snapshots to prune.
        fs::create_dir_all(&folder).unwrap();
        for n in ["library-20200101-0000.sqlite", "library-20200102-0000.sqlite"] {
            make_db(&folder.join(n), 1);
        }
        let info = write_snapshot(&live, &folder, 2).unwrap();
        assert_eq!(info.tracks, 3);
        let json: Value = serde_json::from_slice(&fs::read(&info.json_path).unwrap()).unwrap();
        assert_eq!(json["trackCount"], 3);
        assert_eq!(json["tracks"][0]["track_id"], "0000");
        let left = fs::read_dir(&folder)
            .unwrap()
            .filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().ends_with(".sqlite"))
            .count();
        assert_eq!(left, 2);

        // Mutate live, then restore the snapshot over it.
        Connection::open(&live).unwrap().execute("DELETE FROM library_track", []).unwrap();
        assert_eq!(restore_snapshot(&live, Path::new(&info.sqlite_path)).unwrap(), 3);
        assert_eq!(verify_db(&live).unwrap(), 3);
        assert!(d.join(format!("{DB_FILE}.pre-restore.bak")).exists());
        // Garbage is rejected before anything is touched.
        let junk = d.join("junk.sqlite");
        fs::write(&junk, b"not a db").unwrap();
        assert!(restore_snapshot(&live, &junk).is_err());
        assert_eq!(verify_db(&live).unwrap(), 3);
        let _ = fs::remove_dir_all(d);
    }
}
