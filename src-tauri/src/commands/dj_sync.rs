//! Rekordbox <-> Mixxx sync: the Rust half.
//!
//! The diff engine itself lives in `src/lib/djSync.ts` next to the smart-list
//! rule evaluator and the rekordbox.xml builder it needs (Rekordbox smart
//! playlists have no stored members, so only the TS side can materialize
//! them). This file owns what has to be native:
//!
//! - reading each side's playlists AND the track metadata that is synced
//!   (reusing C1's readers, no second db layer),
//! - the last-synced snapshot per side, stored in the MTC library-index sqlite
//!   (`dj_sync_state`, created lazily, so no index version bump),
//! - writing to Mixxx: C1's `mixxx_db::apply_ops_with` runs relocations,
//!   playlist ops and metadata in ONE backed-up transaction,
//! - B4's old->new move maps.
//!
//! Rekordbox is never written: its changes are delivered as a rekordbox.xml.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::dj_playlists::{mixxx_running, path_key, rekordbox_running, DjOp, DjSnapshot, OpResult};
use super::library_index::open_db;
use super::{mixxx_db, rekordbox_db};

/// The per-track fields that sync. `color` is `#rrggbb` or empty.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncMeta {
    pub path: String,
    pub bpm: f64,
    pub key: String,
    pub rating: u8,
    pub plays: i64,
    pub comment: String,
    pub color: String,
    /// Mixxx only: the track has a beat grid, which owns its BPM.
    pub grid: bool,
}

/// One track's changes for Mixxx. `None` = leave alone; an empty string clears.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetaUpdate {
    pub path: String,
    pub bpm: Option<f64>,
    pub key: Option<String>,
    pub rating: Option<i64>,
    pub plays: Option<i64>,
    pub comment: Option<String>,
    pub color: Option<String>,
}

/// A moved file whose new location Mixxx should be pointed at.
#[derive(Debug, Clone, Deserialize)]
pub struct Relocation {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MixxxExtras {
    #[serde(default)]
    pub relocations: Vec<Relocation>,
    #[serde(default)]
    pub meta: Vec<MetaUpdate>,
}

impl MixxxExtras {
    pub fn is_empty(&self) -> bool {
        self.relocations.is_empty() && self.meta.is_empty()
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtrasReport {
    pub relocated: usize,
    /// "from -> to: why" for relocations that were not applied.
    pub relocate_skipped: Vec<String>,
    pub meta_tracks: usize,
    pub meta_unmatched: usize,
    pub bpm_skipped_grid: usize,
    pub key_unparsed: usize,
}

// --- Mixxx keys -------------------------------------------------------------

const MAJOR: [&str; 12] = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const MINOR: [&str; 12] = ["Cm", "Dbm", "Dm", "Ebm", "Em", "Fm", "F#m", "Gm", "Abm", "Am", "Bbm", "Bm"];

/// Musical key text ("Am", "F#", "Db min", "Bb minor", "E♭") to (pitch class,
/// minor). Camelot/Open Key codes are not accepted: the TS side normalizes.
pub fn parse_musical_key(raw: &str) -> Option<(usize, bool)> {
    let s: String = raw.trim().replace('♭', "b").replace('♯', "#").chars().filter(|c| !c.is_whitespace()).collect();
    let mut chars = s.chars();
    let letter = chars.next()?.to_ascii_uppercase();
    let base: i32 = match letter {
        'C' => 0,
        'D' => 2,
        'E' => 4,
        'F' => 5,
        'G' => 7,
        'A' => 9,
        'B' => 11,
        _ => return None,
    };
    let rest: String = chars.collect();
    let (acc, tail) = match rest.chars().next() {
        Some('#') => (1, &rest[1..]),
        Some('b') => (-1, &rest[1..]),
        _ => (0, rest.as_str()),
    };
    let tail = tail.to_ascii_lowercase();
    let minor = match tail.as_str() {
        "" | "maj" | "major" => false,
        "m" | "min" | "minor" => true,
        _ => return None,
    };
    Some((((base + acc).rem_euclid(12)) as usize, minor))
}

/// Mixxx's `ChromaticKey` id: 1-12 major C..B, 13-24 minor C..B (checked against
/// the owner's database: Cm 13, Dbm 14, ... Bm 24).
pub fn mixxx_key(raw: &str) -> Option<(i64, &'static str)> {
    let (pc, minor) = parse_musical_key(raw)?;
    Some(if minor { (13 + pc as i64, MINOR[pc]) } else { (1 + pc as i64, MAJOR[pc]) })
}

/// Mixxx keeps the key twice: `key`/`key_id` for the library table and a
/// protobuf `KeyMap` blob it actually loads: field 1 = id, field 2 = text,
/// field 4 = 1 (observed on every row of the owner's library).
pub fn keymap_blob(id: i64, text: &str) -> Vec<u8> {
    let mut v = vec![0x08, id as u8, 0x12, text.len() as u8];
    v.extend_from_slice(text.as_bytes());
    v.extend_from_slice(&[0x20, 0x01]);
    v
}

fn color_to_int(c: &str) -> Option<i64> {
    let h = c.trim().trim_start_matches('#');
    if h.len() != 6 {
        return None;
    }
    i64::from_str_radix(h, 16).ok().filter(|n| *n > 0)
}

// --- Mixxx writes (called from mixxx_db::apply_ops_with, inside its transaction) --

pub(crate) fn relocate(conn: &Connection, rels: &[Relocation], rep: &mut ExtrasReport) -> Result<(), String> {
    if rels.is_empty() {
        return Ok(());
    }
    let e = |e: rusqlite::Error| e.to_string();
    let mut by_key: HashMap<String, i64> = HashMap::new();
    {
        let mut stmt = conn.prepare("SELECT id, location FROM track_locations").map_err(e)?;
        for (id, loc) in stmt
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(1)?.unwrap_or_default())))
            .map_err(e)?
            .flatten()
        {
            by_key.insert(path_key(&loc), id);
        }
    }
    for r in rels {
        let (fk, tk) = (path_key(&r.from), path_key(&r.to));
        let Some(&id) = by_key.get(&fk) else { continue };
        if fk == tk {
            continue;
        }
        if by_key.contains_key(&tk) {
            rep.relocate_skipped.push(format!("{} -> {}: Mixxx already has a track there", r.from, r.to));
            continue;
        }
        if !Path::new(&r.to).is_file() {
            rep.relocate_skipped.push(format!("{} -> {}: the new file isn't there", r.from, r.to));
            continue;
        }
        let to = r.to.replace('\\', "/");
        let (dir, name) = to.rsplit_once('/').unwrap_or(("", to.as_str()));
        conn.execute(
            "UPDATE track_locations SET location = ?2, filename = ?3, directory = ?4, fs_deleted = 0 WHERE id = ?1",
            params![id, to, name, dir],
        )
        .map_err(e)?;
        by_key.remove(&fk);
        by_key.insert(tk, id);
        rep.relocated += 1;
    }
    Ok(())
}

pub(crate) fn write_meta(
    conn: &Connection,
    by_path: &HashMap<String, i64>,
    ups: &[MetaUpdate],
    rep: &mut ExtrasReport,
) -> Result<(), String> {
    let e = |e: rusqlite::Error| e.to_string();
    for u in ups {
        let Some(&id) = by_path.get(&path_key(&u.path)) else {
            rep.meta_unmatched += 1;
            continue;
        };
        if let Some(bpm) = u.bpm {
            // Only where Mixxx has no beat grid: with one, the grid owns the BPM
            // and would overwrite this on the next save. Beatgrids never sync.
            let n = conn
                .execute(
                    "UPDATE library SET bpm = ?2 WHERE id = ?1 AND (beats IS NULL OR length(beats) = 0)",
                    params![id, bpm],
                )
                .map_err(e)?;
            if n == 0 {
                rep.bpm_skipped_grid += 1;
            }
        }
        if let Some(k) = &u.key {
            if k.trim().is_empty() {
                conn.execute(
                    "UPDATE library SET key = '', key_id = 0, keys = NULL, keys_version = NULL, keys_sub_version = NULL WHERE id = ?1",
                    [id],
                )
                .map_err(e)?;
            } else if let Some((kid, text)) = mixxx_key(k) {
                conn.execute(
                    "UPDATE library SET key = ?2, key_id = ?3, keys = ?4, keys_version = 'KeyMap-1.0', keys_sub_version = NULL WHERE id = ?1",
                    params![id, text, kid, keymap_blob(kid, text)],
                )
                .map_err(e)?;
            } else {
                rep.key_unparsed += 1;
            }
        }
        if let Some(r) = u.rating {
            conn.execute("UPDATE library SET rating = ?2 WHERE id = ?1", params![id, r.clamp(0, 5)]).map_err(e)?;
        }
        if let Some(p) = u.plays {
            conn.execute("UPDATE library SET timesplayed = ?2 WHERE id = ?1", params![id, p.max(0)]).map_err(e)?;
        }
        if let Some(c) = &u.comment {
            conn.execute("UPDATE library SET comment = ?2 WHERE id = ?1", params![id, c]).map_err(e)?;
        }
        if let Some(c) = &u.color {
            conn.execute("UPDATE library SET color = ?2 WHERE id = ?1", params![id, color_to_int(c)]).map_err(e)?;
        }
        rep.meta_tracks += 1;
    }
    Ok(())
}

// --- last-synced snapshots ----------------------------------------------------

const STATE_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS dj_sync_state (
    side TEXT PRIMARY KEY,
    json TEXT NOT NULL,
    saved_at INTEGER NOT NULL
);";

fn state_conn(app: &AppHandle) -> Result<Connection, String> {
    let conn = open_db(app)?;
    conn.execute_batch(STATE_SCHEMA).map_err(|e| e.to_string())?;
    Ok(conn)
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStateRows {
    pub rekordbox: Option<String>,
    pub mixxx: Option<String>,
    pub saved_at: Option<i64>,
}

fn load_state(conn: &Connection) -> Result<SyncStateRows, String> {
    let e = |e: rusqlite::Error| e.to_string();
    let mut out = SyncStateRows::default();
    let mut stmt = conn.prepare("SELECT side, json, saved_at FROM dj_sync_state").map_err(e)?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)))
        .map_err(e)?;
    for (side, json, at) in rows.flatten() {
        match side.as_str() {
            "rekordbox" => out.rekordbox = Some(json),
            "mixxx" => out.mixxx = Some(json),
            _ => {}
        }
        out.saved_at = Some(out.saved_at.map_or(at, |a| a.max(at)));
    }
    Ok(out)
}

/// Both sides in one transaction: half a snapshot would read as phantom changes.
fn save_state(conn: &mut Connection, rekordbox: &str, mixxx: &str) -> Result<(), String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for (side, json) in [("rekordbox", rekordbox), ("mixxx", mixxx)] {
        tx.execute(
            "INSERT INTO dj_sync_state (side, json, saved_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(side) DO UPDATE SET json = excluded.json, saved_at = excluded.saved_at",
            params![side, json, now],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

// --- B4 move maps --------------------------------------------------------------

/// One CSV line into fields (RFC 4180 quoting, as `organize::moves_csv` writes).
fn csv_fields(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match (c, quoted) {
            ('"', true) if chars.peek() == Some(&'"') => {
                cur.push('"');
                chars.next();
            }
            ('"', _) => quoted = !quoted,
            (',', false) => out.push(std::mem::take(&mut cur)),
            _ => cur.push(c),
        }
    }
    out.push(cur);
    out
}

/// All old->new pairs from the CSVs B4 wrote, oldest file first (names carry a
/// timestamp), so a later move of the same file wins when chained.
pub fn read_move_maps(dir: &Path) -> Vec<(String, String)> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("csv")))
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    let mut out = Vec::new();
    for f in files {
        let Ok(text) = std::fs::read_to_string(&f) else { continue };
        for (i, line) in text.lines().enumerate() {
            if i == 0 && line.starts_with("old_path") {
                continue;
            }
            let f = csv_fields(line);
            if f.len() >= 2 && !f[0].is_empty() && !f[1].is_empty() {
                out.push((f[0].clone(), f[1].clone()));
            }
        }
    }
    out
}

// --- commands ------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRead {
    pub snapshot: DjSnapshot,
    pub meta: Vec<SyncMeta>,
}

/// Reads one side (`rekordbox` | `mixxx`): the playlist snapshot and the
/// metadata that syncs.
#[tauri::command]
pub async fn dj_sync_read(source: String, db_path: Option<String>) -> Result<SyncRead, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let over = db_path.filter(|s| !s.trim().is_empty()).map(PathBuf::from);
        match source.as_str() {
            "rekordbox" => {
                let p = over
                    .or_else(rekordbox_db::default_db_path)
                    .filter(|p| p.is_file())
                    .ok_or("Rekordbox's master.db wasn't found. Set its location on the Playlists page.")?;
                let (mut snapshot, meta) = rekordbox_db::read_sync(&p)?;
                snapshot.running = rekordbox_running();
                Ok(SyncRead { snapshot, meta })
            }
            "mixxx" => {
                let p = over
                    .or_else(mixxx_db::default_db_path)
                    .filter(|p| p.is_file())
                    .ok_or("Mixxx's mixxxdb.sqlite wasn't found. Set its location on the Playlists page.")?;
                let (mut snapshot, meta) = mixxx_db::read_sync(&p)?;
                snapshot.running = mixxx_running();
                Ok(SyncRead { snapshot, meta })
            }
            other => Err(format!("unknown source {other}")),
        }
    })
    .await
    .map_err(|_| "Reading the library failed unexpectedly".to_string())?
}

#[tauri::command]
pub async fn dj_sync_state_load(app: AppHandle) -> Result<SyncStateRows, String> {
    tauri::async_runtime::spawn_blocking(move || load_state(&state_conn(&app)?))
        .await
        .map_err(|_| "Loading the last sync failed unexpectedly".to_string())?
}

#[tauri::command]
pub async fn dj_sync_state_save(app: AppHandle, rekordbox: String, mixxx: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || save_state(&mut state_conn(&app)?, &rekordbox, &mixxx))
        .await
        .map_err(|_| "Saving the sync state failed unexpectedly".to_string())?
}

/// Forgets what was last synced (the next sync is a "first sync" again).
#[tauri::command]
pub async fn dj_sync_state_reset(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        state_conn(&app)?.execute("DELETE FROM dj_sync_state", []).map(|_| ()).map_err(|e| e.to_string())
    })
    .await
    .map_err(|_| "Resetting the sync state failed unexpectedly".to_string())?
}

#[tauri::command]
pub async fn dj_sync_move_maps(app: AppHandle) -> Result<Vec<(String, String)>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("move-maps");
        Ok(read_move_maps(&dir))
    })
    .await
    .map_err(|_| "Reading the move maps failed unexpectedly".to_string())?
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncApplyResult {
    pub ops: Vec<OpResult>,
    #[serde(flatten)]
    pub report: ExtrasReport,
}

/// Writes the Mixxx side of a sync: relocations, playlist ops and metadata in
/// one backed-up transaction. Refuses while Mixxx is running.
#[tauri::command]
pub async fn dj_sync_apply_mixxx(
    ops: Vec<DjOp>,
    extras: MixxxExtras,
    db_path: Option<String>,
) -> Result<SyncApplyResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if mixxx_running() {
            return Err("Mixxx is running. Close it first: it keeps its library in memory and would overwrite these changes.".to_string());
        }
        let p = db_path
            .filter(|s| !s.trim().is_empty())
            .map(PathBuf::from)
            .or_else(mixxx_db::default_db_path)
            .filter(|p| p.is_file())
            .ok_or("Mixxx's mixxxdb.sqlite wasn't found")?;
        let (ops, report) = mixxx_db::apply_ops_with(&p, &ops, &extras)?;
        Ok(SyncApplyResult { ops, report })
    })
    .await
    .map_err(|_| "Syncing to Mixxx failed unexpectedly".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_map_to_mixxx_ids_and_blobs() {
        assert_eq!(mixxx_key("Am"), Some((22, "Am")));
        assert_eq!(mixxx_key("C"), Some((1, "C")));
        assert_eq!(mixxx_key("C#m"), Some((14, "Dbm")));
        assert_eq!(mixxx_key("Db minor"), Some((14, "Dbm")));
        assert_eq!(mixxx_key("F♯"), Some((7, "F#")));
        assert_eq!(mixxx_key("Bb"), Some((11, "Bb")));
        assert_eq!(mixxx_key("B"), Some((12, "B")));
        assert_eq!(mixxx_key("Bm"), Some((24, "Bm")));
        assert_eq!(mixxx_key("8A"), None);
        assert_eq!(mixxx_key(""), None);
        // Byte-for-byte the blob Mixxx wrote for a Dbm track in the real library.
        assert_eq!(keymap_blob(14, "Dbm"), vec![0x08, 0x0E, 0x12, 0x03, 0x44, 0x62, 0x6D, 0x20, 0x01]);
    }

    #[test]
    fn csv_lines_round_trip_with_quotes() {
        assert_eq!(csv_fields("a,b"), vec!["a", "b"]);
        assert_eq!(csv_fields("\"a,b\",\"c\"\"d\""), vec!["a,b", "c\"d"]);
    }

    fn mixxx_conn() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(mixxx_db::tests::MIXXX_SCHEMA).unwrap();
        c.execute_batch(
            "ALTER TABLE library ADD COLUMN beats BLOB;
             ALTER TABLE library ADD COLUMN keys BLOB;
             ALTER TABLE library ADD COLUMN keys_version TEXT; ALTER TABLE library ADD COLUMN keys_sub_version TEXT;
             UPDATE library SET beats = x'0A09' WHERE id = 3;",
        )
        .unwrap();
        c
    }

    #[test]
    fn writes_metadata_but_never_a_bpm_over_a_beat_grid() {
        let c = mixxx_conn();
        let by_path = {
            let mut m = HashMap::new();
            m.insert(path_key("C:/Music/A - One.mp3"), 1);
            m.insert(path_key("C:/Music/C - Three.mp3"), 3);
            m
        };
        let mut rep = ExtrasReport::default();
        write_meta(
            &c,
            &by_path,
            &[
                MetaUpdate {
                    path: "c:\\music\\a - one.mp3".into(),
                    bpm: Some(128.5),
                    key: Some("F#m".into()),
                    rating: Some(4),
                    plays: Some(7),
                    comment: Some("hi".into()),
                    color: Some("#ff0000".into()),
                },
                MetaUpdate { path: "C:/Music/C - Three.mp3".into(), bpm: Some(99.0), rating: Some(1), ..Default::default() },
                MetaUpdate { path: "C:/nope.mp3".into(), rating: Some(1), ..Default::default() },
            ],
            &mut rep,
        )
        .unwrap();
        assert_eq!((rep.meta_tracks, rep.meta_unmatched, rep.bpm_skipped_grid), (2, 1, 1));
        let row: (f64, String, i64, Vec<u8>, i64, i64, String, i64) = c
            .query_row(
                "SELECT bpm, key, key_id, keys, rating, timesplayed, comment, color FROM library WHERE id = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?)),
            )
            .unwrap();
        assert_eq!(row.0, 128.5);
        assert_eq!((row.1.as_str(), row.2), ("F#m", 19));
        assert_eq!(row.3, keymap_blob(19, "F#m"));
        assert_eq!((row.4, row.5, row.6.as_str(), row.7), (4, 7, "hi", 0xff0000));
        // Track 3 has a beat grid: its BPM is untouched, the rating still lands.
        let t3: (f64, i64) = c.query_row("SELECT bpm, rating FROM library WHERE id = 3", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(t3.1, 1);
        assert_ne!(t3.0, 99.0);
        // Clearing.
        write_meta(
            &c,
            &by_path,
            &[MetaUpdate { path: "C:/Music/A - One.mp3".into(), key: Some(String::new()), color: Some(String::new()), ..Default::default() }],
            &mut rep,
        )
        .unwrap();
        let cleared: (String, Option<i64>) = c.query_row("SELECT key, color FROM library WHERE id = 1", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(cleared, (String::new(), None));
    }

    #[test]
    fn relocation_updates_location_and_refuses_clashes_and_missing_files() {
        let dir = std::env::temp_dir().join(format!("mtc-reloc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let moved = dir.join("B - Two.mp3");
        std::fs::write(&moved, b"x").unwrap();
        let moved_s = moved.to_string_lossy().replace('\\', "/");
        let c = mixxx_conn();
        let mut rep = ExtrasReport::default();
        relocate(
            &c,
            &[
                Relocation { from: "C:/Music/B - Two.mp3".into(), to: moved_s.clone() },
                Relocation { from: "C:/Music/A - One.mp3".into(), to: "C:/Music/C - Three.mp3".into() },
                Relocation { from: "C:/Music/C - Three.mp3".into(), to: "C:/Music/missing.mp3".into() },
                Relocation { from: "C:/not-in-mixxx.mp3".into(), to: moved_s.clone() },
            ],
            &mut rep,
        )
        .unwrap();
        assert_eq!(rep.relocated, 1);
        assert_eq!(rep.relocate_skipped.len(), 2);
        let (loc, name, d): (String, String, String) = c
            .query_row("SELECT location, filename, directory FROM track_locations WHERE id = 2", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap();
        assert_eq!(loc, moved_s);
        assert_eq!(name, "B - Two.mp3");
        assert!(moved_s.starts_with(&d));
        let _ = std::fs::remove_dir_all(&dir);
    }

    // --- dry run against COPIES of the owner's real databases ------------------
    // `MTC_SYNC_DRYRUN_DIR` holds `master-copy.db` and `mixxx-copy.sqlite`
    // (copied by hand from the live files; the live files are never opened).
    // Step 1 dumps both reads as JSON for `src/lib/djSync.dryrun.test.ts`;
    // step 2 applies the plan it wrote (`ops.json`) to the Mixxx copy.

    fn dry_dir() -> Option<PathBuf> {
        std::env::var_os("MTC_SYNC_DRYRUN_DIR").map(PathBuf::from)
    }

    #[test]
    #[ignore]
    fn dryrun_1_dump_real_copies() {
        let Some(d) = dry_dir() else { return };
        let (rs, rm) = rekordbox_db::read_sync(&d.join("master-copy.db")).unwrap();
        let (ms, mm) = mixxx_db::read_sync(&d.join("mixxx-copy.sqlite")).unwrap();
        for (name, v) in [
            ("rb.json", SyncRead { snapshot: rs, meta: rm }),
            ("mx.json", SyncRead { snapshot: ms, meta: mm }),
        ] {
            std::fs::write(d.join(name), serde_json::to_string(&v).unwrap()).unwrap();
        }
    }

    #[derive(Deserialize)]
    struct DryPlan {
        ops: Vec<DjOp>,
        extras: MixxxExtras,
    }

    #[test]
    #[ignore]
    fn dryrun_2_apply_to_mixxx_copy() {
        let Some(d) = dry_dir() else { return };
        let plan: DryPlan = serde_json::from_str(&std::fs::read_to_string(d.join("ops.json")).unwrap()).unwrap();
        let db = d.join("mixxx-copy.sqlite");
        let (res, rep) = mixxx_db::apply_ops_with(&db, &plan.ops, &plan.extras).unwrap();
        let unmatched: usize = res.iter().map(|r| r.unmatched.len()).sum();
        eprintln!("applied {} ops ({} unmatched paths); report: {:?}", res.len(), unmatched, rep);
        let conn = Connection::open(&db).unwrap();
        let ok: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
        assert_eq!(ok, "ok");
        let (ms, mm) = mixxx_db::read_sync(&db).unwrap();
        std::fs::write(d.join("mx.json"), serde_json::to_string(&SyncRead { snapshot: ms, meta: mm }).unwrap()).unwrap();
    }

    #[test]
    fn state_round_trips_and_overwrites() {
        let mut c = Connection::open_in_memory().unwrap();
        c.execute_batch(STATE_SCHEMA).unwrap();
        assert!(load_state(&c).unwrap().rekordbox.is_none());
        save_state(&mut c, "{\"a\":1}", "{\"b\":2}").unwrap();
        save_state(&mut c, "{\"a\":3}", "{\"b\":4}").unwrap();
        let s = load_state(&c).unwrap();
        assert_eq!((s.rekordbox.as_deref(), s.mixxx.as_deref()), (Some("{\"a\":3}"), Some("{\"b\":4}")));
        assert!(s.saved_at.is_some());
    }

    #[test]
    fn move_maps_read_oldest_first() {
        let dir = std::env::temp_dir().join(format!("mtc-maps-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("move-map-20260101-000000.csv"), "old_path,new_path\r\nC:/a.mp3,C:/b.mp3\r\n").unwrap();
        std::fs::write(dir.join("move-map-20260102-000000.csv"), "old_path,new_path\r\n\"C:/b,x.mp3\",C:/c.mp3\r\n").unwrap();
        let m = read_move_maps(&dir);
        assert_eq!(m, vec![("C:/a.mp3".to_string(), "C:/b.mp3".to_string()), ("C:/b,x.mp3".to_string(), "C:/c.mp3".to_string())]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
