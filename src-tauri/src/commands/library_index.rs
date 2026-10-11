//! Whole-library index (v0.13).
//!
//! Everything before this worked only on the files loaded into the current
//! session, which is fine for editing a folder and wrong for every question
//! about the *collection*: which genres do I actually use, is this playlist
//! track something I already own, where is that track I remember but haven't
//! opened. Those need to know about tracks nobody opened today.
//!
//! So: a persistent sqlite index of one or more root folders, holding the
//! curated tag fields plus enough file identity (`mtime` + `size`) to skip
//! unchanged files on a re-index. It is deliberately a *cache of the files*,
//! never a source of truth — the tags on disk always win, a row whose file
//! has changed is re-read, and a row whose file is gone is dropped. Nothing
//! is ever written to a file because of what the index says.
//!
//! It lives in its own database rather than joining `fingerprint-cache.sqlite`
//! (duplicates/waveforms): that one is a derived-computation cache that can be
//! deleted at any time to reclaim space, and this one is user-facing state
//! whose loss means re-walking the whole collection.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use walkdir::WalkDir;

use crate::commands::files::{par_map, read_for_index, read_tags_impl, AUDIO_EXTENSIONS, CRASHED};
use crate::models::WriteResult;

/// Canonical tag keys that survive a write as typed fields, so they must not
/// be re-sent as "extra" frames to preserve.
///
/// This mirrors `KEPT_FIELD_KEYS` in `src/types.ts`; the two are checked
/// against each other by `kept_field_keys_match_the_frontend` below, which
/// fails if either list is edited without the other.
pub const KEPT_FIELD_KEYS: &[&str] = &[
    "TrackTitle",
    "TrackArtist",
    "AlbumTitle",
    "AlbumArtist",
    "TrackNumber",
    "TrackTotal",
    "DiscNumber",
    "DiscTotal",
    "Year",
    "RecordingDate",
    "Genre",
    "Comment",
    "OriginalArtist",
    "Composer",
    "Popularimeter",
    "Unknown(TRACKID)",
    "Bpm",
    "IntegerBpm",
    "InitialKey",
    // Format-specific spellings of Track ID / Original Artist (Vorbis has no
    // mapped Original Artist key; MP4 only stores custom fields as freeform atoms).
    "Unknown(ORIGINALARTIST)",
    "Unknown(----:com.apple.iTunes:TRACKID)",
    "Unknown(----:com.apple.iTunes:ORIGINALARTIST)",
];

const SCHEMA_SQL: &str = "
CREATE TABLE IF NOT EXISTS library_track (
    path TEXT PRIMARY KEY,
    mtime INTEGER NOT NULL,
    size INTEGER NOT NULL,
    format TEXT NOT NULL,
    duration_secs REAL,
    has_backup INTEGER NOT NULL DEFAULT 0,
    has_cover INTEGER NOT NULL DEFAULT 0,
    title TEXT,
    artist TEXT,
    album TEXT,
    album_artist TEXT,
    genre TEXT,
    year TEXT,
    comment TEXT,
    composer TEXT,
    original_artist TEXT,
    track_id TEXT,
    rating INTEGER,
    indexed_at INTEGER NOT NULL,
    bpm_tag TEXT,
    key_tag TEXT
);
CREATE INDEX IF NOT EXISTS library_track_genre ON library_track(genre);
CREATE INDEX IF NOT EXISTS library_track_album ON library_track(album);
CREATE INDEX IF NOT EXISTS library_track_artist ON library_track(artist);
CREATE TABLE IF NOT EXISTS library_root (
    path TEXT PRIMARY KEY,
    added_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS index_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS import_session (
    key TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    saved_at INTEGER NOT NULL,
    payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS yt_entry_meta (
    video_id TEXT PRIMARY KEY,
    json TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rekordbox_track (
    path_lower TEXT PRIMARY KEY,
    bpm REAL,
    key TEXT,
    imported_at INTEGER NOT NULL
);
";

/// What the indexer extracts per file. Bump this whenever a row gains a
/// column, or an existing column starts being filled in differently.
///
/// Indexing is incremental — a file whose size and modified time still match
/// is skipped without being opened — which is exactly wrong when it is *our*
/// idea of a row that changed rather than the file. Without this, v1 rows
/// kept their empty `duration_secs` forever and duration silently stopped
/// contributing to playlist matching for anyone who had already indexed.
/// A mismatch forces one full re-read, after which the stamp is updated.
///
/// v2: `duration_secs` and `has_backup` are populated (they were always NULL/0).
/// v3: MP3 star ratings are read from their POPM frames (always NULL before),
///     and `comment` is the plain comment rather than whichever came first
///     (often iTunes' `iTunNORM` hex).
///
/// v4: the file's own BPM and key tags are stored (`bpm_tag`, `key_tag`), so
///     tracks that are only in the index show them, not just Rekordbox's.
const INDEX_VERSION: i64 = 4;

fn stored_index_version(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT value FROM index_meta WHERE key = 'index_version'",
        [],
        |r| r.get::<_, String>(0),
    )
    .ok()
    .and_then(|v| v.parse().ok())
    .unwrap_or(0)
}

pub(crate) fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("library-index.sqlite"))
}

pub(crate) fn open_db(app: &AppHandle) -> Result<Connection, String> {
    let conn = Connection::open(db_path(app)?).map_err(|e| e.to_string())?;
    // WAL keeps a long indexing write from blocking the reads the UI makes
    // while it runs (stats polling, the search dock). NORMAL sync is the
    // documented pairing for WAL: still crash-safe, far fewer fsyncs.
    let _ = conn.pragma_update(None, "journal_mode", "WAL");
    let _ = conn.pragma_update(None, "synchronous", "NORMAL");
    // Two writers can overlap (a re-index running while an edit refreshes its
    // rows, an import session autosaving). Without a busy timeout the second
    // fails at once with "database is locked" instead of waiting its turn.
    let _ = conn.busy_timeout(std::time::Duration::from_secs(10));
    conn.execute_batch(SCHEMA_SQL).map_err(|e| e.to_string())?;
    migrate_columns(&conn)?;
    Ok(conn)
}

/// Columns added after the first release. `CREATE TABLE IF NOT EXISTS` does
/// nothing for a database that already has the table, so a column the schema
/// gained later has to be added by hand; the INDEX_VERSION bump that
/// accompanies it makes the next index re-read every file to fill it in.
fn migrate_columns(conn: &Connection) -> Result<(), String> {
    let have: BTreeSet<String> = {
        let mut stmt = conn
            .prepare("SELECT name FROM pragma_table_info('library_track')")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();
        rows
    };
    for (col, ty) in [("bpm_tag", "TEXT"), ("key_tag", "TEXT")] {
        if !have.contains(col) {
            conn.execute(&format!("ALTER TABLE library_track ADD COLUMN {col} {ty}"), [])
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn is_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| AUDIO_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// An audio file worth indexing — not a macOS `._` AppleDouble companion,
/// which carries the audio extension but holds only Finder metadata.
fn is_track_file(e: &walkdir::DirEntry) -> bool {
    e.file_type().is_file()
        && is_audio(e.path())
        && !e.file_name().to_string_lossy().starts_with("._")
}

/// Whether `path` sits under `root`, compared by path component — a plain
/// string prefix would put `C:\Music2\x.mp3` under the root `C:\Music`.
fn is_under(path: &str, root: &str) -> bool {
    Path::new(path).starts_with(Path::new(root))
}

/// Inserts or refreshes one track's row.
fn upsert_track(
    tx: &rusqlite::Transaction,
    path: &str,
    mtime: i64,
    size: i64,
    row: crate::commands::files::IndexRow,
    now: i64,
) -> Result<(), String> {
    let tags = row.tags;
    let mut stmt = tx
        .prepare_cached(
            "INSERT OR REPLACE INTO library_track (
                path, mtime, size, format, duration_secs, has_backup, has_cover,
                title, artist, album, album_artist, genre, year, comment,
                composer, original_artist, track_id, rating, indexed_at,
                bpm_tag, key_tag
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21)",
        )
        .map_err(|e| e.to_string())?;
    stmt.execute(params![
        path,
        mtime,
        size,
        Path::new(path)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase(),
        row.duration_secs,
        row.has_backup as i64,
        tags.has_cover_art as i64,
        tags.title,
        tags.artist,
        tags.album,
        tags.album_artist,
        tags.genre,
        tags.year,
        tags.comment,
        tags.composer,
        tags.original_artist,
        tags.track_id,
        tags.rating.map(|r| r as i64),
        now,
        tags.bpm.filter(|b| !b.trim().is_empty()),
        tags.key.filter(|k| !k.trim().is_empty()),
    ])
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// Folder name the Stems action writes into, which sits *inside* the track's
/// own folder by default — i.e. usually inside an indexed root.
///
/// Demucs writes four files per track, so indexing them would quietly triple
/// or quadruple the collection with things that are not tracks: they would
/// become playlist-match candidates, show up in search, and their (empty)
/// genre would count. Skipped by name, which also covers the
/// `stems/<model>/<track>/` tree beneath it.
const STEMS_DIR: &str = "stems";

fn is_stems_dir(e: &walkdir::DirEntry) -> bool {
    e.file_type().is_dir()
        && e.file_name()
            .to_str()
            .map(|n| n.eq_ignore_ascii_case(STEMS_DIR))
            .unwrap_or(false)
}

fn file_stat(path: &Path) -> Option<(i64, i64)> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_secs() as i64;
    Some((mtime, meta.len() as i64))
}

/// One track as the index has it. Flat (rather than the `AudioFile` +
/// `TagData` pair the rest of the app passes around) because it is one
/// database row; the frontend splits it back into that pair.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedTrack {
    pub path: String,
    pub filename: String,
    pub format: String,
    pub size: i64,
    pub duration_secs: Option<f64>,
    pub has_backup: bool,
    pub has_cover_art: bool,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub genre: Option<String>,
    pub year: Option<String>,
    pub comment: Option<String>,
    pub composer: Option<String>,
    pub original_artist: Option<String>,
    pub track_id: Option<String>,
    pub rating: Option<u8>,
    /// The file's own BPM / key tags (index v4), as written. Unlike `bpm` /
    /// `key` below, which come from Rekordbox.
    pub tag_bpm: Option<String>,
    pub tag_key: Option<String>,
    /// From a Rekordbox XML import (D0), joined in by path — not file-tag
    /// data, so it's `None` for every track until that's been run once.
    pub bpm: Option<f64>,
    pub key: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexSummary {
    pub scanned: usize,
    pub added: usize,
    pub updated: usize,
    pub removed: usize,
    pub unchanged: usize,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenreCount {
    pub name: String,
    pub count: i64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryStats {
    pub track_count: i64,
    pub roots: Vec<String>,
    pub last_indexed_at: Option<i64>,
    pub genre_count: i64,
    pub artist_count: i64,
    /// Library tracks with a matching Rekordbox BPM/key row (D0). `None`
    /// before any Rekordbox XML has ever been imported.
    pub rekordbox_matched: i64,
}

// --- Roots -----------------------------------------------------------------

#[tauri::command]
pub async fn library_roots(app: AppHandle) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db(&app)?;
        let mut stmt = conn
            .prepare("SELECT path FROM library_root ORDER BY path")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();
        Ok(rows)
    })
    .await
    .map_err(|_| "Reading library roots failed unexpectedly".to_string())?
}

/// Replaces the whole root list. Rows under a root that is no longer listed
/// are dropped, so removing a folder from the index actually removes its
/// tracks rather than leaving them as orphans nothing will ever refresh.
/// An empty list used to mean "delete every indexed track" — the exact shape
/// of the bug that wiped the index with no confirmation. Changing the
/// Library folder always goes through `set_library_roots` with exactly one
/// new root; nothing legitimate ever calls it with zero. Clearing the index
/// on purpose has its own command (`clear_library_index`).
fn validate_roots(roots: &[String]) -> Result<(), String> {
    if roots.is_empty() {
        Err(
            "Refusing to clear every library folder this way — use Clear Index if that's what you want."
                .to_string(),
        )
    } else {
        Ok(())
    }
}

#[tauri::command]
pub async fn set_library_roots(app: AppHandle, roots: Vec<String>) -> Result<(), String> {
    validate_roots(&roots)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open_db(&app)?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM library_root", []).map_err(|e| e.to_string())?;
        for r in &roots {
            tx.execute(
                "INSERT OR REPLACE INTO library_root (path, added_at) VALUES (?1, ?2)",
                params![r, now_secs()],
            )
            .map_err(|e| e.to_string())?;
        }
        let mut keep = String::new();
        for (i, _) in roots.iter().enumerate() {
            if i > 0 {
                keep.push_str(" OR ");
            }
            keep.push_str(&format!("path LIKE ?{} ESCAPE '\\'", i + 1));
        }
        let patterns: Vec<String> = roots.iter().map(|r| format!("{}%", escape_like(r))).collect();
        let sql = format!("DELETE FROM library_track WHERE NOT ({keep})");
        tx.execute(&sql, rusqlite::params_from_iter(patterns.iter()))
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|_| "Saving library roots failed unexpectedly".to_string())?
}

/// `LIKE` treats `%` and `_` as wildcards, and Windows paths legitimately
/// contain neither — but a folder named "100_%" would otherwise match far
/// more than itself, so escape them rather than trusting the path shape.
fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

// --- Indexing --------------------------------------------------------------

fn emit_progress(app: &AppHandle, phase: &str, done: usize, total: usize, current: &str) {
    let _ = app.emit(
        "library-index-progress",
        serde_json::json!({ "phase": phase, "done": done, "total": total, "current": current }),
    );
}

/// Walks every root and brings the index up to date.
///
/// Incremental by default: a file whose `mtime` and `size` both match the
/// stored row is skipped without opening it, which is the difference between
/// a re-index taking seconds and taking as long as the first one.
/// `rescan_all` forces every file to be re-read — for when the *index schema*
/// changed rather than the files.
#[tauri::command]
pub async fn index_library(app: AppHandle, rescan_all: bool) -> Result<IndexSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open_db(&app)?;

        let roots: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT path FROM library_root ORDER BY path")
                .map_err(|e| e.to_string())?;
            let r = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .filter_map(Result::ok)
                .collect();
            r
        };
        if roots.is_empty() {
            return Err("No library folders chosen yet — add one first".to_string());
        }

        // A stale stamp means the rows are the right files but the wrong
        // shape, so the mtime/size shortcut would happily keep them.
        let rescan_all = rescan_all || stored_index_version(&conn) != INDEX_VERSION;

        emit_progress(&app, "walking", 0, 0, "");
        let mut found: Vec<PathBuf> = Vec::new();
        // Roots that actually resolved to a directory this run. A root that
        // doesn't (an unplugged external drive, a renamed folder) must never
        // cause its tracks to be pruned as "deleted" — there is no way to
        // tell "offline" from "gone" from here, so the safer read is assumed.
        let mut available_roots: Vec<String> = Vec::new();
        for root in &roots {
            let rp = Path::new(root);
            if !rp.is_dir() {
                continue;
            }
            available_roots.push(root.clone());
            for e in WalkDir::new(rp)
                // depth 0 is the root itself: if someone deliberately adds a
                // folder called "stems" as a library root, index it.
                .into_iter()
                .filter_entry(|e| e.depth() == 0 || !is_stems_dir(e))
                .filter_map(|e| e.ok())
            {
                if is_track_file(&e) {
                    found.push(e.into_path());
                }
            }
        }

        // Existing rows, so we can tell added/updated/unchanged apart and
        // spot the ones whose file no longer exists.
        let mut known: std::collections::HashMap<String, (i64, i64)> = std::collections::HashMap::new();
        {
            let mut stmt = conn
                .prepare("SELECT path, mtime, size FROM library_track")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))
                })
                .map_err(|e| e.to_string())?;
            for row in rows.flatten() {
                known.insert(row.0, (row.1, row.2));
            }
        }

        let total = found.len();
        emit_progress(&app, "reading", 0, total, "");

        // Decide what actually needs re-reading before touching any tags.
        let mut to_read: Vec<PathBuf> = Vec::new();
        let mut unchanged = 0usize;
        let mut seen: BTreeSet<String> = BTreeSet::new();
        for p in &found {
            let key = p.to_string_lossy().to_string();
            seen.insert(key.clone());
            let stat = file_stat(p);
            match (known.get(&key), stat) {
                (Some(&(m, s)), Some((mtime, size))) if !rescan_all && m == mtime && s == size => {
                    unchanged += 1;
                }
                _ => to_read.push(p.clone()),
            }
        }

        // Tag parsing is the expensive part, so it runs in parallel and the
        // database write happens afterwards in one transaction — sqlite is
        // single-writer, and interleaving would serialise the parses too.
        // Progress is reported from the parse itself: reporting it from the
        // insert loop below left the bar at zero for the whole (slow) parse of
        // a first index, then raced it to the end during the (fast) inserts.
        let parsed_count = std::sync::atomic::AtomicUsize::new(0);
        let reading_total = to_read.len();
        let parsed = par_map(
            &to_read,
            |p| {
                let path = p.to_string_lossy().to_string();
                let (mtime, size) = file_stat(p).unwrap_or((0, 0));
                let row = read_for_index(&path);
                let n = parsed_count.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                if n % 32 == 0 || n == reading_total {
                    emit_progress(&app, "reading", n, reading_total, &path);
                }
                (path, mtime, size, row)
            },
            |p| (p.to_string_lossy().to_string(), 0, 0, Err(CRASHED.to_string())),
        );

        let mut summary = IndexSummary {
            scanned: total,
            unchanged,
            ..Default::default()
        };

        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let now = now_secs();
        for (path, mtime, size, row) in parsed {
            let row = match row {
                Ok(r) => r,
                Err(e) => {
                    summary.errors.push(format!("{path}: {e}"));
                    continue;
                }
            };
            let existed = known.contains_key(&path);
            upsert_track(&tx, &path, mtime, size, row, now)?;
            if existed {
                summary.updated += 1;
            } else {
                summary.added += 1;
            }
        }

        // Drop rows whose file is gone — but only under a root that actually
        // resolved to a directory this run. Without `available_roots`, an
        // unplugged external drive makes every path under it fail
        // `Path::exists()` too, so its whole half of the index would be
        // deleted as "removed" instead of correctly reported as offline.
        let stale: Vec<String> = known
            .keys()
            .filter(|k| !seen.contains(*k))
            .filter(|k| !Path::new(k).exists())
            .filter(|k| available_roots.iter().any(|r| is_under(k, r)))
            .cloned()
            .collect();
        for path in &stale {
            tx.execute("DELETE FROM library_track WHERE path = ?1", params![path])
                .map_err(|e| e.to_string())?;
        }
        summary.removed = stale.len();
        tx.execute(
            "INSERT OR REPLACE INTO index_meta (key, value) VALUES ('index_version', ?1)",
            params![INDEX_VERSION.to_string()],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;

        emit_progress(&app, "done", total, total, "");
        Ok(summary)
    })
    .await
    .map_err(|_| "Indexing the library failed unexpectedly".to_string())?
}

#[tauri::command]
pub async fn clear_library_index(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db(&app)?;
        conn.execute("DELETE FROM library_track", []).map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|_| "Clearing the index failed unexpectedly".to_string())?
}

// --- Reads -----------------------------------------------------------------

fn row_to_track(r: &rusqlite::Row) -> rusqlite::Result<IndexedTrack> {
    let path: String = r.get("path")?;
    let filename = Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());
    Ok(IndexedTrack {
        filename,
        format: r.get("format")?,
        size: r.get("size")?,
        duration_secs: r.get("duration_secs")?,
        has_backup: r.get::<_, i64>("has_backup")? != 0,
        has_cover_art: r.get::<_, i64>("has_cover")? != 0,
        title: r.get("title")?,
        artist: r.get("artist")?,
        album: r.get("album")?,
        album_artist: r.get("album_artist")?,
        genre: r.get("genre")?,
        year: r.get("year")?,
        comment: r.get("comment")?,
        composer: r.get("composer")?,
        original_artist: r.get("original_artist")?,
        track_id: r.get("track_id")?,
        rating: r.get::<_, Option<i64>>("rating")?.map(|v| v as u8),
        tag_bpm: r.get("bpm_tag")?,
        tag_key: r.get("key_tag")?,
        bpm: r.get("rb_bpm")?,
        key: r.get("rb_key")?,
        path,
    })
}

/// The whole index. The frontend holds it in memory for matching and search;
/// at ~200 bytes of JSON per track even a 50k-track collection is a one-off
/// read of a few megabytes, which is cheaper than round-tripping a query per
/// keystroke.
#[tauri::command]
pub async fn library_tracks(app: AppHandle) -> Result<Vec<IndexedTrack>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db(&app)?;
        let mut stmt = conn
            .prepare(
                "SELECT lt.*, rb.bpm AS rb_bpm, rb.key AS rb_key
                 FROM library_track lt
                 LEFT JOIN rekordbox_track rb ON LOWER(lt.path) = rb.path_lower
                 ORDER BY lt.path",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], row_to_track)
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();
        Ok(rows)
    })
    .await
    .map_err(|_| "Reading the library index failed unexpectedly".to_string())?
}

#[tauri::command]
pub async fn library_stats(app: AppHandle) -> Result<LibraryStats, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db(&app)?;
        let track_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM library_track", [], |r| r.get(0))
            .unwrap_or(0);
        let last_indexed_at: Option<i64> = conn
            .query_row("SELECT MAX(indexed_at) FROM library_track", [], |r| r.get(0))
            .unwrap_or(None);
        let genre_count: i64 = conn
            .query_row(
                "SELECT COUNT(DISTINCT genre) FROM library_track WHERE genre IS NOT NULL AND genre <> ''",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let artist_count: i64 = conn
            .query_row(
                "SELECT COUNT(DISTINCT artist) FROM library_track WHERE artist IS NOT NULL AND artist <> ''",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let mut stmt = conn
            .prepare("SELECT path FROM library_root ORDER BY path")
            .map_err(|e| e.to_string())?;
        let roots = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();
        let rekordbox_matched: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM library_track lt
                 JOIN rekordbox_track rb ON LOWER(lt.path) = rb.path_lower",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        Ok(LibraryStats {
            track_count,
            roots,
            last_indexed_at,
            genre_count,
            artist_count,
            rekordbox_matched,
        })
    })
    .await
    .map_err(|_| "Reading library stats failed unexpectedly".to_string())?
}

/// Every genre actually present in the collection, most-used first.
///
/// This is what replaced the hardcoded genre presets: the list you pick from
/// is the list you already use, so it can't drift from the files.
#[tauri::command]
pub async fn library_genres(app: AppHandle) -> Result<Vec<GenreCount>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db(&app)?;
        let mut stmt = conn
            .prepare(
                "SELECT genre, COUNT(*) AS n FROM library_track
                 WHERE genre IS NOT NULL AND TRIM(genre) <> ''
                 GROUP BY genre ORDER BY n DESC, genre ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok(GenreCount { name: r.get(0)?, count: r.get(1)? }))
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();
        Ok(rows)
    })
    .await
    .map_err(|_| "Reading library genres failed unexpectedly".to_string())?
}

/// A column the sidebar can browse by. Adding one (B3's language) means a
/// column, an arm in each method here, and a TS entry in `src/lib/facets.ts`;
/// the queries, commands and sidebar need no other change.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Facet {
    Genre,
    Album,
}

impl Facet {
    /// The indexed column holding the facet's value. Never user input: this is
    /// spliced into SQL, so it comes from the enum and nothing else.
    fn column(self) -> &'static str {
        match self {
            Facet::Genre => "genre",
            Facet::Album => "album",
        }
    }
    /// SQL for the second grouping key. Albums are told apart by album artist
    /// so two "Greatest Hits" do not merge; other facets have none.
    fn artist_expr(self) -> &'static str {
        match self {
            Facet::Album => "COALESCE(TRIM(album_artist), '')",
            _ => "''",
        }
    }
}

/// One entry of a facet list. `name == ""` is the "no value" bucket (tracks
/// whose field is empty), which the sidebar shows as "No genre" / "No album".
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FacetCount {
    pub name: String,
    /// Album artist for albums, else empty.
    pub artist: String,
    pub count: i64,
}

fn facet_counts(conn: &Connection, facet: Facet) -> Result<Vec<FacetCount>, String> {
    let (col, art) = (facet.column(), facet.artist_expr());
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {col}, {art}, COUNT(*) AS n FROM library_track
             WHERE {col} IS NOT NULL AND TRIM({col}) <> ''
             GROUP BY {col}, {art} ORDER BY n DESC, {col} ASC, {art} ASC"
        ))
        .map_err(|e| e.to_string())?;
    let mut rows: Vec<FacetCount> = stmt
        .query_map([], |r| {
            Ok(FacetCount { name: r.get(0)?, artist: r.get(1)?, count: r.get(2)? })
        })
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();
    let empty: i64 = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM library_track WHERE {col} IS NULL OR TRIM({col}) = ''"),
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if empty > 0 {
        rows.insert(0, FacetCount { name: String::new(), artist: String::new(), count: empty });
    }
    Ok(rows)
}

/// Paths in one facet bucket. An empty `name` is the "no value" bucket.
fn facet_paths(conn: &Connection, facet: Facet, name: &str, artist: &str) -> Result<Vec<String>, String> {
    let (col, art) = (facet.column(), facet.artist_expr());
    let (sql, bound): (String, Vec<&str>) = if name.trim().is_empty() {
        (
            format!("SELECT path FROM library_track WHERE {col} IS NULL OR TRIM({col}) = '' ORDER BY path"),
            vec![],
        )
    } else {
        (
            format!("SELECT path FROM library_track WHERE {col} = ?1 AND {art} = ?2 ORDER BY path"),
            vec![name, artist],
        )
    };
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(bound), |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();
    Ok(rows)
}

/// Every value of `facet` in the collection with counts, plus the "none" bucket.
#[tauri::command]
pub async fn library_facets(app: AppHandle, facet: Facet) -> Result<Vec<FacetCount>, String> {
    tauri::async_runtime::spawn_blocking(move || facet_counts(&open_db(&app)?, facet))
        .await
        .map_err(|_| "Reading library facets failed unexpectedly".to_string())?
}

#[tauri::command]
pub async fn library_paths_with_facet(
    app: AppHandle,
    facet: Facet,
    name: String,
    artist: Option<String>,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        facet_paths(&open_db(&app)?, facet, &name, artist.as_deref().unwrap_or("").trim())
    })
    .await
    .map_err(|_| "Reading tracks failed unexpectedly".to_string())?
}

#[tauri::command]
pub async fn library_paths_with_genre(app: AppHandle, genre: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db(&app)?;
        let mut stmt = conn
            .prepare("SELECT path FROM library_track WHERE genre = ?1 ORDER BY path")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![genre], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();
        Ok(rows)
    })
    .await
    .map_err(|_| "Reading tracks by genre failed unexpectedly".to_string())?
}

// --- Writes ----------------------------------------------------------------

/// Rewrites one field across a set of files that may not be loaded in the
/// session, then refreshes their index rows.
///
/// Used by the genre rename: renaming a genre has to reach every track that
/// carries it, not just the handful currently on screen, or the preset and
/// the files drift apart — which is the whole thing the library-derived genre
/// list exists to prevent.
///
/// Every other tag frame is preserved: the file's own `all_fields` dump minus
/// the typed fields is passed back as `keep_extra`, matching what the
/// frontend does for an ordinary inline edit.
///
/// `backup` carries the user's "Backup original tags before changes" setting.
/// It must be threaded through rather than assumed: this path can rewrite
/// thousands of files the user never opened, which is precisely when they
/// would most want the full pre-change snapshot they asked for.
#[tauri::command]
pub async fn retag_field(
    app: AppHandle,
    paths: Vec<String>,
    field: String,
    value: String,
    backup: bool,
    preserve_art: bool,
    backup_field: Option<String>,
) -> Result<Vec<WriteResult>, String> {
    let app2 = app.clone();
    let results = tauri::async_runtime::spawn_blocking(move || {
        let total = paths.len();
        let done = std::sync::atomic::AtomicUsize::new(0);
        par_map(
            &paths,
            |path| {
                let n = done.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                if n % 16 == 0 {
                    emit_progress(&app2, "retagging", n, total, path);
                }
                let mut tags = match read_tags_impl(path) {
                    Ok(t) => t,
                    Err(e) => return WriteResult { path: path.clone(), error: Some(e) },
                };
                let v = if value.trim().is_empty() { None } else { Some(value.clone()) };
                match field.as_str() {
                    "genre" => tags.genre = v,
                    "artist" => tags.artist = v,
                    "album" => tags.album = v,
                    "albumArtist" => tags.album_artist = v,
                    "year" => tags.year = v,
                    "comment" => tags.comment = v,
                    "composer" => tags.composer = v,
                    "originalArtist" => tags.original_artist = v,
                    other => {
                        return WriteResult {
                            path: path.clone(),
                            error: Some(format!("Unsupported field: {other}")),
                        }
                    }
                }
                let keep_extra = crate::commands::files::extra_field_keys(&tags);
                let err = crate::commands::files::write_tags_blocking(
                    path,
                    tags,
                    backup,
                    keep_extra,
                    preserve_art,
                    backup_field.clone(),
                )
                .err();
                WriteResult { path: path.clone(), error: err }
            },
            |path| WriteResult { path: path.clone(), error: Some(CRASHED.to_string()) },
        )
    })
    .await
    .map_err(|_| "Retagging failed unexpectedly".to_string())?;

    // Refresh the rows we just changed, so the index doesn't claim the old
    // value until the next full re-index.
    let written: Vec<String> = results
        .iter()
        .filter(|r| r.error.is_none())
        .map(|r| r.path.clone())
        .collect();
    if !written.is_empty() {
        let app3 = app.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || reindex_paths(&app3, &written)).await;
    }
    Ok(results)
}

/// Re-reads specific paths into the index, for any write made outside
/// `retag_field` (an ordinary AI Clean/manual edit on a track that happens to
/// sit inside the Library folder) — so genres and search see the change
/// immediately instead of waiting for the next full re-index.
#[tauri::command]
pub async fn reindex_library_paths(app: AppHandle, paths: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || reindex_paths(&app, &paths))
        .await
        .map_err(|_| "Refreshing the library index failed unexpectedly".to_string())?
}

/// Re-reads specific paths into the index. Cheap enough to run right after a
/// write, so the index never lags the files it describes. A path whose file
/// is gone (renamed, deleted) has its row dropped rather than left behind as
/// a ghost track until the next full re-index.
pub(crate) fn reindex_paths(app: &AppHandle, paths: &[String]) -> Result<(), String> {
    let parsed = par_map(
        paths,
        |path| {
            let p = Path::new(path);
            let (mtime, size) = file_stat(p).unwrap_or((0, 0));
            (path.clone(), mtime, size, read_for_index(path))
        },
        |path| (path.clone(), 0, 0, Err(CRASHED.to_string())),
    );
    let mut conn = open_db(app)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let now = now_secs();
    for (path, mtime, size, row) in parsed {
        match row {
            Ok(row) => upsert_track(&tx, &path, mtime, size, row, now)?,
            Err(_) if !Path::new(&path).exists() => {
                tx.execute("DELETE FROM library_track WHERE path = ?1", params![path])
                    .map_err(|e| e.to_string())?;
            }
            // Present but unreadable right now (locked, mid-download): keep
            // the last good row rather than dropping a track that exists.
            Err(_) => {}
        }
    }
    tx.commit().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA_SQL).unwrap();
        conn
    }

    fn insert(conn: &Connection, path: &str, genre: Option<&str>, artist: Option<&str>) {
        conn.execute(
            "INSERT INTO library_track (path, mtime, size, format, genre, artist, indexed_at)
             VALUES (?1, 1, 1, 'mp3', ?2, ?3, 100)",
            params![path, genre, artist],
        )
        .unwrap();
    }

    /// The Rust and TypeScript kept-key lists must stay identical: a field in
    /// one but not the other is either dropped on write or duplicated as a
    /// raw frame, and neither shows up until someone's tags are already
    /// damaged. Parsing the .ts constant is ugly but it is the only thing
    /// that actually fails when the two drift.
    #[test]
    fn kept_field_keys_match_the_frontend() {
        let ts = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/types.ts"),
        )
        .expect("could not read src/types.ts");
        let start = ts
            .find("export const KEPT_FIELD_KEYS = new Set([")
            .expect("KEPT_FIELD_KEYS not found in types.ts");
        let body = &ts[start..];
        let end = body.find("]);").expect("unterminated KEPT_FIELD_KEYS");
        let mut from_ts: Vec<String> = body[..end]
            .lines()
            .filter_map(|l| {
                let t = l.trim();
                let t = t.strip_prefix('"')?;
                t.split('"').next().map(str::to_string)
            })
            .collect();
        from_ts.sort();
        let mut from_rs: Vec<String> = KEPT_FIELD_KEYS.iter().map(|s| s.to_string()).collect();
        from_rs.sort();
        assert_eq!(from_rs, from_ts, "KEPT_FIELD_KEYS drifted between Rust and TypeScript");
    }

    #[test]
    fn genre_tally_counts_and_orders_by_use() {
        let conn = mem_db();
        insert(&conn, "a.mp3", Some("Techno"), None);
        insert(&conn, "b.mp3", Some("Techno"), None);
        insert(&conn, "c.mp3", Some("House Melodic"), None);
        insert(&conn, "d.mp3", Some(""), None);
        insert(&conn, "e.mp3", None, None);

        let mut stmt = conn
            .prepare(
                "SELECT genre, COUNT(*) AS n FROM library_track
                 WHERE genre IS NOT NULL AND TRIM(genre) <> ''
                 GROUP BY genre ORDER BY n DESC, genre ASC",
            )
            .unwrap();
        let rows: Vec<(String, i64)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .filter_map(Result::ok)
            .collect();

        // Blank and NULL genres are not genres — they must not become an
        // empty-string entry in the picker.
        assert_eq!(rows, vec![("Techno".to_string(), 2), ("House Melodic".to_string(), 1)]);
    }

    #[test]
    fn paths_with_genre_returns_only_exact_matches() {
        let conn = mem_db();
        insert(&conn, "a.mp3", Some("Techno"), None);
        insert(&conn, "b.mp3", Some("Techno Melodic"), None);
        let mut stmt = conn
            .prepare("SELECT path FROM library_track WHERE genre = ?1 ORDER BY path")
            .unwrap();
        let rows: Vec<String> = stmt
            .query_map(params!["Techno"], |r| r.get(0))
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        assert_eq!(rows, vec!["a.mp3".to_string()]);
    }

    #[test]
    fn escape_like_neutralises_wildcards_in_a_folder_name() {
        assert_eq!(escape_like("C:/100%_mixes"), "C:/100\\%\\_mixes");
        // A Windows separator is escaped too, so it stays a literal backslash
        // under LIKE ... ESCAPE '\'.
        assert_eq!(escape_like("C:\\Music"), "C:\\\\Music");
    }

    /// The Stems action writes four files per track into a `stems` folder
    /// *inside* the track's own folder, which is normally inside a library
    /// root. Indexing those would quietly multiply the collection with things
    /// that are not tracks — they would become playlist-match candidates and
    /// show up in search — so the walk prunes that subtree.
    #[test]
    fn the_walk_skips_stem_output_but_not_a_root_called_stems() {
        let dir = std::env::temp_dir().join(format!("mtc-stems-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let deep = dir.join("stems").join("htdemucs").join("Some Track");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::create_dir_all(dir.join("Album")).unwrap();
        std::fs::write(dir.join("Album").join("real.mp3"), b"x").unwrap();
        std::fs::write(dir.join("Album").join("._real.mp3"), b"x").unwrap();
        std::fs::write(deep.join("vocals.wav"), b"x").unwrap();
        std::fs::write(deep.join("drums.wav"), b"x").unwrap();

        let walk = |root: &Path| -> Vec<String> {
            WalkDir::new(root)
                .into_iter()
                .filter_entry(|e| e.depth() == 0 || !is_stems_dir(e))
                .filter_map(Result::ok)
                .filter(is_track_file)
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect()
        };

        // Scanning the library: the real track, none of the stems.
        assert_eq!(walk(&dir), vec!["real.mp3".to_string()]);

        // But a folder someone deliberately added *as a root* is still indexed,
        // even if it happens to be called "stems".
        let mut from_stems_root = walk(&dir.join("stems"));
        from_stems_root.sort();
        assert_eq!(from_stems_root, vec!["drums.wav".to_string(), "vocals.wav".to_string()]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Workstream A3: `set_library_roots([])` must never silently wipe the
    /// index again — the 09-30 bug this plan exists to make impossible.
    #[test]
    fn set_library_roots_rejects_an_empty_list() {
        assert!(validate_roots(&[]).is_err());
        assert!(validate_roots(&["C:/Music/Collection".to_string()]).is_ok());
    }

    /// Workstream A3: an unplugged/offline root must not cause its tracks to
    /// be pruned as "deleted" — only a root that actually resolved to a
    /// directory this run may have stale rows removed under it.
    #[test]
    fn stale_rows_under_an_offline_root_are_not_pruned() {
        // "Music2" is an unplugged root whose name merely *starts with* the
        // online root's: a string-prefix check counted its tracks as under
        // "Music" and deleted them.
        let known_paths = ["C:/Music/a.mp3", "C:/Offline/b.mp3", "C:/Music2/c.mp3"];
        let seen: BTreeSet<String> = BTreeSet::new(); // none was walked this run
        let available_roots = vec!["C:/Music".to_string()]; // only Music resolved to a dir
        let stale: Vec<&&str> = known_paths
            .iter()
            .filter(|k| !seen.contains(**k))
            .filter(|k| available_roots.iter().any(|r| is_under(k, r)))
            .collect();
        assert_eq!(stale, vec![&"C:/Music/a.mp3"]);
    }

    /// Workstream D0: a Rekordbox row joins onto its Library track by a
    /// case-insensitive path match, and a track with no Rekordbox row reads
    /// back as `None` rather than failing the query.
    #[test]
    fn rekordbox_bpm_and_key_join_case_insensitively_by_path() {
        let conn = mem_db();
        insert(&conn, r"C:\Music\Song.mp3", Some("Techno"), None);
        insert(&conn, r"C:\Music\Other.mp3", Some("Techno"), None);
        conn.execute(
            "INSERT INTO rekordbox_track (path_lower, bpm, key, imported_at) VALUES (?1, ?2, ?3, 100)",
            params![r"c:\music\song.mp3", 128.0, "8A"],
        )
        .unwrap();

        let mut stmt = conn
            .prepare(
                "SELECT lt.*, rb.bpm AS rb_bpm, rb.key AS rb_key
                 FROM library_track lt
                 LEFT JOIN rekordbox_track rb ON LOWER(lt.path) = rb.path_lower
                 ORDER BY lt.path",
            )
            .unwrap();
        let rows: Vec<IndexedTrack> =
            stmt.query_map([], row_to_track).unwrap().filter_map(Result::ok).collect();

        let other = rows.iter().find(|t| t.path.ends_with("Other.mp3")).unwrap();
        assert_eq!(other.bpm, None);
        assert_eq!(other.key, None);

        let song = rows.iter().find(|t| t.path.ends_with("Song.mp3")).unwrap();
        assert_eq!(song.bpm, Some(128.0));
        assert_eq!(song.key.as_deref(), Some("8A"));
    }

    #[test]
    fn a_row_round_trips_through_the_index_shape() {
        let conn = mem_db();
        conn.execute(
            "INSERT INTO library_track (path, mtime, size, format, genre, artist, title, rating, has_cover, indexed_at)
             VALUES ('C:/m/x.mp3', 1, 2, 'mp3', 'Techno', 'Boris Brejcha', 'Gravity', 4, 1, 100)",
            [],
        )
        .unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT lt.*, rb.bpm AS rb_bpm, rb.key AS rb_key
                 FROM library_track lt
                 LEFT JOIN rekordbox_track rb ON LOWER(lt.path) = rb.path_lower",
            )
            .unwrap();
        let t = stmt.query_row([], row_to_track).unwrap();
        assert_eq!(t.filename, "x.mp3");
        assert_eq!(t.artist.as_deref(), Some("Boris Brejcha"));
        assert_eq!(t.rating, Some(4));
        assert!(t.has_cover_art);
        assert!(!t.has_backup);
    }

    fn insert_album(
        conn: &Connection,
        path: &str,
        album: Option<&str>,
        album_artist: Option<&str>,
        genre: Option<&str>,
    ) {
        conn.execute(
            "INSERT INTO library_track (path, mtime, size, format, album, album_artist, genre, indexed_at)
             VALUES (?1, 1, 1, 'mp3', ?2, ?3, ?4, 100)",
            params![path, album, album_artist, genre],
        )
        .unwrap();
    }

    fn fc(name: &str, artist: &str, count: i64) -> FacetCount {
        FacetCount { name: name.into(), artist: artist.into(), count }
    }

    #[test]
    fn album_facet_keeps_same_titled_albums_by_different_artists_apart() {
        let conn = mem_db();
        insert_album(&conn, "a1.mp3", Some("Greatest Hits"), Some("Queen"), None);
        insert_album(&conn, "a2.mp3", Some("Greatest Hits"), Some("Queen"), None);
        insert_album(&conn, "b1.mp3", Some("Greatest Hits"), Some("ABBA"), None);
        insert_album(&conn, "c1.mp3", Some("Solo"), None, None);
        insert_album(&conn, "d1.mp3", Some("  "), Some("X"), None);
        insert_album(&conn, "e1.mp3", None, None, None);

        let rows = facet_counts(&conn, Facet::Album).unwrap();
        // The "No album" bucket (blank and NULL) leads; the rest by use.
        assert_eq!(
            rows,
            vec![
                fc("", "", 2),
                fc("Greatest Hits", "Queen", 2),
                fc("Greatest Hits", "ABBA", 1),
                fc("Solo", "", 1),
            ]
        );
        assert_eq!(
            facet_paths(&conn, Facet::Album, "Greatest Hits", "Queen").unwrap(),
            vec!["a1.mp3", "a2.mp3"]
        );
        assert_eq!(facet_paths(&conn, Facet::Album, "Greatest Hits", "ABBA").unwrap(), vec!["b1.mp3"]);
        // An album with no album artist is found with an empty artist.
        assert_eq!(facet_paths(&conn, Facet::Album, "Solo", "").unwrap(), vec!["c1.mp3"]);
        assert_eq!(facet_paths(&conn, Facet::Album, "", "").unwrap(), vec!["d1.mp3", "e1.mp3"]);
    }

    #[test]
    fn genre_facet_has_a_no_genre_bucket_only_when_something_is_untagged() {
        let conn = mem_db();
        insert(&conn, "a.mp3", Some("Techno"), None);
        insert(&conn, "b.mp3", Some("Techno"), None);
        insert(&conn, "c.mp3", Some(" "), None);
        insert(&conn, "d.mp3", None, None);
        assert_eq!(
            facet_counts(&conn, Facet::Genre).unwrap(),
            vec![fc("", "", 2), fc("Techno", "", 2)]
        );
        assert_eq!(facet_paths(&conn, Facet::Genre, "", "").unwrap(), vec!["c.mp3", "d.mp3"]);
        assert_eq!(facet_paths(&conn, Facet::Genre, "Techno", "").unwrap(), vec!["a.mp3", "b.mp3"]);

        let conn = mem_db();
        insert(&conn, "a.mp3", Some("House"), None);
        assert_eq!(facet_counts(&conn, Facet::Genre).unwrap(), vec![fc("House", "", 1)]);
    }

    #[test]
    fn an_old_database_gains_the_tag_bpm_and_key_columns() {
        let conn = Connection::open_in_memory().unwrap();
        // The v3 shape: no bpm_tag / key_tag.
        conn.execute_batch(
            "CREATE TABLE library_track (path TEXT PRIMARY KEY, mtime INTEGER NOT NULL, size INTEGER NOT NULL,
             format TEXT NOT NULL, indexed_at INTEGER NOT NULL, album TEXT, genre TEXT);
             INSERT INTO library_track VALUES ('a.mp3', 1, 1, 'mp3', 1, NULL, NULL);",
        )
        .unwrap();
        migrate_columns(&conn).unwrap();
        // Idempotent: opening the database again must not fail on a duplicate column.
        migrate_columns(&conn).unwrap();
        conn.execute("UPDATE library_track SET bpm_tag = '128', key_tag = '8A'", []).unwrap();
        let (b, k): (String, String) = conn
            .query_row("SELECT bpm_tag, key_tag FROM library_track", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!((b.as_str(), k.as_str()), ("128", "8A"));
    }

    #[test]
    fn index_rows_carry_the_files_own_bpm_and_key() {
        let conn = mem_db();
        conn.execute(
            "INSERT INTO library_track (path, mtime, size, format, bpm_tag, key_tag, indexed_at)
             VALUES ('C:/m/x.mp3', 1, 2, 'mp3', '127.99', 'Am', 100)",
            [],
        )
        .unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT lt.*, rb.bpm AS rb_bpm, rb.key AS rb_key FROM library_track lt
                 LEFT JOIN rekordbox_track rb ON LOWER(lt.path) = rb.path_lower",
            )
            .unwrap();
        let t = stmt.query_row([], row_to_track).unwrap();
        assert_eq!(t.tag_bpm.as_deref(), Some("127.99"));
        assert_eq!(t.tag_key.as_deref(), Some("Am"));
        assert_eq!(t.bpm, None);
    }
}
