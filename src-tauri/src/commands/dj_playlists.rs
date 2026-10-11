//! DJ-software playlists as one model: Rekordbox (read-only), Mixxx
//! (read + write while closed) and Music Tag Cleaner's own playlists (stored
//! in the library index database).
//!
//! The frontend loads a whole `DjSnapshot` per source (tree + tracks +
//! members); even a 5,000-track library is a couple of MB of JSON, and it lets
//! smart-playlist rules be evaluated locally with one implementation
//! (`src/lib/smartRules.ts`). Writes go through `dj_apply` as small ops.

use std::collections::HashMap;
use std::path::PathBuf;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::library_index::open_db;
use super::{mixxx_db, rekordbox_db};

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DjNode {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    /// `folder` | `playlist` | `smart` | `crate` (Mixxx).
    pub kind: String,
    pub seq: i64,
    pub count: usize,
    /// Rekordbox smart list definition, verbatim.
    pub smart_xml: Option<String>,
    /// MTC smart list rules (`smartRules.ts` JSON), verbatim.
    pub rules_json: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DjTrack {
    pub id: String,
    pub path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub genre: String,
    pub key: String,
    pub bpm: f64,
    pub rating: u8,
    pub year: String,
    pub comment: String,
    pub date_added: String,
    pub duration: f64,
    pub language: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DjSnapshot {
    pub source: String,
    pub db_path: Option<String>,
    pub nodes: Vec<DjNode>,
    pub tracks: Vec<DjTrack>,
    /// node id -> ordered track ids (indexes into `tracks[].id`). Empty for
    /// smart nodes: their members are evaluated from the rules.
    pub members: HashMap<String, Vec<String>>,
    /// The program was running when we read (the data may be a few minutes old).
    pub running: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum DjOp {
    #[serde(rename_all = "camelCase")]
    Create {
        parent_id: Option<String>,
        name: String,
        kind: String,
        #[serde(default)]
        paths: Vec<String>,
        rules_json: Option<String>,
    },
    /// Create-or-update by name (+ parent + kind); what makes re-running an
    /// export update instead of duplicate.
    #[serde(rename_all = "camelCase")]
    Upsert {
        parent_id: Option<String>,
        name: String,
        kind: String,
        #[serde(default)]
        paths: Vec<String>,
        rules_json: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    SetTracks { id: String, paths: Vec<String> },
    #[serde(rename_all = "camelCase")]
    Rename { id: String, name: String },
    #[serde(rename_all = "camelCase")]
    Delete { id: String },
    #[serde(rename_all = "camelCase")]
    SetRules { id: String, rules_json: String },
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpResult {
    pub id: Option<String>,
    pub created: bool,
    pub matched: usize,
    /// Paths that weren't found in the target library. Reported, never dropped
    /// silently.
    pub unmatched: Vec<String>,
}

/// The key two paths are compared by across Rekordbox, Mixxx and the index:
/// forward slashes, no `file://localhost/`, percent-decoded once if it was a
/// URI, case-folded on the case-insensitive platforms (Windows/macOS). Both
/// Rekordbox (`djmdContent.FolderPath`) and Mixxx (`track_locations.location`)
/// store plain forward-slash paths (C0), so for them this is the identity plus
/// case-folding; the URI handling is for rekordbox.xml `Location`s.
pub fn path_key(p: &str) -> String {
    let mut s = p.trim().replace('\\', "/");
    if let Some(rest) = s.strip_prefix("file://localhost/") {
        s = percent_decode(rest);
    } else if let Some(rest) = s.strip_prefix("file:///") {
        s = percent_decode(rest);
    }
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        s = s.to_lowercase();
    }
    s
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

// --- process checks -------------------------------------------------------

/// Whether a process with one of these image names is running. Uses the OS's
/// own tools (`tasklist` / `pgrep`) rather than a process-listing crate.
pub fn process_running(names: &[&str]) -> bool {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let Ok(out) = std::process::Command::new("tasklist")
            .args(["/FO", "CSV", "/NH"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        else {
            return false;
        };
        let text = String::from_utf8_lossy(&out.stdout).to_lowercase();
        names.iter().any(|n| text.contains(&format!("\"{}.exe\"", n.to_lowercase())))
    }
    #[cfg(not(target_os = "windows"))]
    {
        names.iter().any(|n| {
            std::process::Command::new("pgrep")
                .args(["-ix", n])
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        })
    }
}

pub fn rekordbox_running() -> bool {
    process_running(&["rekordbox", "rekordboxAgent"])
}

pub fn mixxx_running() -> bool {
    process_running(&["mixxx"])
}

// --- MTC's own playlists --------------------------------------------------

const MTC_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS mtc_playlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id INTEGER,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    rules_json TEXT,
    created_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS mtc_playlist_track (
    playlist_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    path TEXT NOT NULL,
    PRIMARY KEY (playlist_id, position)
);
";

fn mtc_open(app: &AppHandle) -> Result<Connection, String> {
    let conn = open_db(app)?;
    conn.execute_batch(MTC_SCHEMA).map_err(|e| e.to_string())?;
    Ok(conn)
}

fn id_num(id: &str) -> Result<i64, String> {
    id.parse().map_err(|_| format!("bad playlist id {id}"))
}

pub(crate) fn mtc_snapshot(conn: &Connection) -> Result<DjSnapshot, String> {
    let e = |e: rusqlite::Error| e.to_string();
    let mut tracks = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT lt.path, lt.title, lt.artist, lt.album, lt.genre,
                        COALESCE(NULLIF(lt.key_tag, ''), rb.key, ''),
                        COALESCE(CAST(NULLIF(lt.bpm_tag, '') AS REAL), rb.bpm, 0),
                        lt.rating, lt.year, lt.comment, lt.indexed_at, lt.duration_secs, lt.language
                 FROM library_track lt
                 LEFT JOIN rekordbox_track rb ON LOWER(lt.path) = rb.path_lower
                 ORDER BY lt.path",
            )
            .map_err(e)?;
        let rows = stmt
            .query_map([], |r| {
                let s = |i: usize| -> rusqlite::Result<String> {
                    Ok(r.get::<_, Option<String>>(i)?.unwrap_or_default())
                };
                let path = s(0)?;
                let added = r.get::<_, Option<i64>>(10)?.unwrap_or(0);
                let added = chrono::DateTime::from_timestamp(added, 0)
                    .map(|d| d.format("%Y-%m-%d").to_string())
                    .unwrap_or_default();
                Ok(DjTrack {
                    id: path.clone(),
                    path,
                    title: s(1)?,
                    artist: s(2)?,
                    album: s(3)?,
                    genre: s(4)?,
                    key: s(5)?,
                    bpm: r.get::<_, Option<f64>>(6)?.unwrap_or(0.0),
                    rating: r.get::<_, Option<i64>>(7)?.unwrap_or(0).clamp(0, 5) as u8,
                    year: s(8)?,
                    comment: s(9)?,
                    date_added: added,
                    duration: r.get::<_, Option<f64>>(11)?.unwrap_or(0.0),
                    language: s(12)?,
                })
            })
            .map_err(e)?;
        for t in rows.flatten() {
            tracks.push(t);
        }
    }
    let mut members: HashMap<String, Vec<String>> = HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT playlist_id, path FROM mtc_playlist_track ORDER BY playlist_id, position")
            .map_err(e)?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))).map_err(e)?;
        for (p, path) in rows.flatten() {
            members.entry(p.to_string()).or_default().push(path);
        }
    }
    let mut nodes = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT id, parent_id, name, kind, position, rules_json FROM mtc_playlist ORDER BY parent_id, position, id")
            .map_err(e)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, Option<i64>>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, Option<String>>(5)?,
                ))
            })
            .map_err(e)?;
        for (id, parent, name, kind, seq, rules) in rows.flatten() {
            let key = id.to_string();
            nodes.push(DjNode {
                count: members.get(&key).map(|m| m.len()).unwrap_or(0),
                id: key,
                parent_id: parent.map(|p| p.to_string()),
                name,
                kind,
                seq,
                smart_xml: None,
                rules_json: rules,
            });
        }
    }
    Ok(DjSnapshot { source: "mtc".into(), db_path: None, nodes, tracks, members, running: false })
}

fn mtc_set_tracks(conn: &Connection, id: i64, paths: &[String]) -> Result<(), String> {
    let e = |e: rusqlite::Error| e.to_string();
    conn.execute("DELETE FROM mtc_playlist_track WHERE playlist_id = ?1", [id]).map_err(e)?;
    let mut ins = conn
        .prepare("INSERT INTO mtc_playlist_track (playlist_id, position, path) VALUES (?1, ?2, ?3)")
        .map_err(e)?;
    for (i, p) in paths.iter().enumerate() {
        ins.execute(params![id, i as i64 + 1, p]).map_err(e)?;
    }
    Ok(())
}

fn mtc_delete(conn: &Connection, id: i64) -> Result<(), String> {
    let e = |e: rusqlite::Error| e.to_string();
    let kids: Vec<i64> = {
        let mut stmt = conn.prepare("SELECT id FROM mtc_playlist WHERE parent_id = ?1").map_err(e)?;
        let v = stmt.query_map([id], |r| r.get(0)).map_err(e)?.flatten().collect();
        v
    };
    for k in kids {
        mtc_delete(conn, k)?;
    }
    conn.execute("DELETE FROM mtc_playlist_track WHERE playlist_id = ?1", [id]).map_err(e)?;
    conn.execute("DELETE FROM mtc_playlist WHERE id = ?1", [id]).map_err(e)?;
    Ok(())
}

fn mtc_find(conn: &Connection, parent: Option<i64>, name: &str, kind: &str) -> Option<i64> {
    conn.query_row(
        "SELECT id FROM mtc_playlist WHERE COALESCE(parent_id, 0) = COALESCE(?1, 0) AND name = ?2 AND kind = ?3 ORDER BY id LIMIT 1",
        params![parent, name, kind],
        |r| r.get(0),
    )
    .ok()
}

fn mtc_create(
    conn: &Connection,
    parent: Option<i64>,
    name: &str,
    kind: &str,
    paths: &[String],
    rules: Option<&str>,
) -> Result<i64, String> {
    let e = |e: rusqlite::Error| e.to_string();
    if !matches!(kind, "folder" | "playlist" | "smart") {
        return Err(format!("unknown playlist kind {kind}"));
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    conn.execute(
        "INSERT INTO mtc_playlist (parent_id, name, kind, position, rules_json, created_at)
         VALUES (?1, ?2, ?3, (SELECT COALESCE(MAX(position), 0) + 1 FROM mtc_playlist WHERE COALESCE(parent_id, 0) = COALESCE(?1, 0)), ?4, ?5)",
        params![parent, name, kind, rules, now],
    )
    .map_err(e)?;
    let id = conn.last_insert_rowid();
    mtc_set_tracks(conn, id, paths)?;
    Ok(id)
}

pub(crate) fn mtc_apply(conn: &mut Connection, ops: &[DjOp]) -> Result<Vec<OpResult>, String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for op in ops {
        let e = |e: rusqlite::Error| e.to_string();
        let r = match op {
            DjOp::Create { parent_id, name, kind, paths, rules_json } => {
                let parent = parent_id.as_deref().map(id_num).transpose()?;
                let id = mtc_create(&tx, parent, name, kind, paths, rules_json.as_deref())?;
                OpResult { id: Some(id.to_string()), created: true, matched: paths.len(), unmatched: vec![] }
            }
            DjOp::Upsert { parent_id, name, kind, paths, rules_json } => {
                let parent = parent_id.as_deref().map(id_num).transpose()?;
                if let Some(id) = mtc_find(&tx, parent, name, kind) {
                    mtc_set_tracks(&tx, id, paths)?;
                    tx.execute("UPDATE mtc_playlist SET rules_json = ?2 WHERE id = ?1", params![id, rules_json]).map_err(e)?;
                    OpResult { id: Some(id.to_string()), created: false, matched: paths.len(), unmatched: vec![] }
                } else {
                    let id = mtc_create(&tx, parent, name, kind, paths, rules_json.as_deref())?;
                    OpResult { id: Some(id.to_string()), created: true, matched: paths.len(), unmatched: vec![] }
                }
            }
            DjOp::SetTracks { id, paths } => {
                mtc_set_tracks(&tx, id_num(id)?, paths)?;
                OpResult { id: Some(id.clone()), matched: paths.len(), ..Default::default() }
            }
            DjOp::Rename { id, name } => {
                tx.execute("UPDATE mtc_playlist SET name = ?2 WHERE id = ?1", params![id_num(id)?, name]).map_err(e)?;
                OpResult { id: Some(id.clone()), ..Default::default() }
            }
            DjOp::Delete { id } => {
                mtc_delete(&tx, id_num(id)?)?;
                OpResult { id: Some(id.clone()), ..Default::default() }
            }
            DjOp::SetRules { id, rules_json } => {
                tx.execute("UPDATE mtc_playlist SET rules_json = ?2 WHERE id = ?1", params![id_num(id)?, rules_json]).map_err(e)?;
                OpResult { id: Some(id.clone()), ..Default::default() }
            }
        };
        out.push(r);
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(out)
}

// --- commands --------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DjStatus {
    pub rekordbox_path: Option<String>,
    pub rekordbox_running: bool,
    pub mixxx_path: Option<String>,
    pub mixxx_running: bool,
}

fn resolve_path(over: Option<String>, default: Option<PathBuf>) -> Option<PathBuf> {
    over.filter(|s| !s.trim().is_empty()).map(PathBuf::from).or(default)
}

#[tauri::command]
pub async fn dj_status(rekordbox_path: Option<String>, mixxx_path: Option<String>) -> Result<DjStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let rb = resolve_path(rekordbox_path, rekordbox_db::default_db_path()).filter(|p| p.is_file());
        let mx = resolve_path(mixxx_path, mixxx_db::default_db_path()).filter(|p| p.is_file());
        DjStatus {
            rekordbox_path: rb.map(|p| p.to_string_lossy().into_owned()),
            rekordbox_running: rekordbox_running(),
            mixxx_path: mx.map(|p| p.to_string_lossy().into_owned()),
            mixxx_running: mixxx_running(),
        }
    })
    .await
    .map_err(|_| "status check failed".to_string())
}

/// Loads the playlist tree, tracks and members for `source`
/// (`rekordbox` | `mixxx` | `mtc`).
#[tauri::command]
pub async fn dj_load(app: AppHandle, source: String, db_path: Option<String>) -> Result<DjSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || match source.as_str() {
        "rekordbox" => {
            let p = resolve_path(db_path, rekordbox_db::default_db_path())
                .filter(|p| p.is_file())
                .ok_or("Rekordbox's master.db wasn't found. Set its location, or open Rekordbox once.")?;
            let mut s = rekordbox_db::read_snapshot(&p)?;
            s.running = rekordbox_running();
            Ok(s)
        }
        "mixxx" => {
            let p = resolve_path(db_path, mixxx_db::default_db_path())
                .filter(|p| p.is_file())
                .ok_or("Mixxx's mixxxdb.sqlite wasn't found. Set its location, or open Mixxx once.")?;
            let mut s = mixxx_db::read_snapshot(&p)?;
            s.running = mixxx_running();
            Ok(s)
        }
        "mtc" => mtc_snapshot(&mtc_open(&app)?),
        other => Err(format!("unknown source {other}")),
    })
    .await
    .map_err(|_| "Loading playlists failed unexpectedly".to_string())?
}

/// Applies edits to `mixxx` or `mtc`. Rekordbox is deliberately not a target:
/// its playlists are written through a rekordbox.xml import.
#[tauri::command]
pub async fn dj_apply(
    app: AppHandle,
    source: String,
    ops: Vec<DjOp>,
    db_path: Option<String>,
) -> Result<Vec<OpResult>, String> {
    tauri::async_runtime::spawn_blocking(move || match source.as_str() {
        "mtc" => mtc_apply(&mut mtc_open(&app)?, &ops),
        "mixxx" => {
            if mixxx_running() {
                return Err("Mixxx is running. Close it first: it keeps its library in memory and would overwrite these changes.".into());
            }
            let p = resolve_path(db_path, mixxx_db::default_db_path())
                .filter(|p| p.is_file())
                .ok_or("Mixxx's mixxxdb.sqlite wasn't found")?;
            mixxx_db::apply_ops(&p, &ops)
        }
        "rekordbox" => Err("Rekordbox playlists are changed by importing a rekordbox.xml (use Export to Rekordbox)".into()),
        other => Err(format!("unknown source {other}")),
    })
    .await
    .map_err(|_| "Saving playlists failed unexpectedly".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_key_agrees_across_spellings() {
        let a = path_key("C:\\Users\\x\\Music\\Avicii - Levels.mp3");
        let b = path_key("C:/Users/x/Music/Avicii - Levels.mp3");
        let c = path_key("file://localhost/C:/Users/x/Music/Avicii%20-%20Levels.mp3");
        assert_eq!(a, b);
        assert_eq!(b, c);
        // Non-ASCII survives percent-decoding.
        assert_eq!(
            path_key("file://localhost/C:/M/%D0%9C%D1%83%D0%B7.mp3"),
            path_key("C:/M/Муз.mp3")
        );
        assert_eq!(percent_decode("100%"), "100%");
    }

    fn test_conn() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(MTC_SCHEMA).unwrap();
        c
    }

    fn up(name: &str, parent: Option<&str>, paths: &[&str]) -> DjOp {
        DjOp::Upsert {
            parent_id: parent.map(str::to_string),
            name: name.into(),
            kind: "playlist".into(),
            paths: paths.iter().map(|s| s.to_string()).collect(),
            rules_json: None,
        }
    }

    #[test]
    fn mtc_store_round_trip_and_idempotent_genre_export() {
        let mut c = test_conn();
        let folder = mtc_apply(
            &mut c,
            &[DjOp::Upsert { parent_id: None, name: "MTC Genres".into(), kind: "folder".into(), paths: vec![], rules_json: None }],
        )
        .unwrap()[0]
            .id
            .clone();
        let f = folder.as_deref();
        mtc_apply(&mut c, &[up("House", f, &["a.mp3", "b.mp3"]), up("Techno", f, &["c.mp3"])]).unwrap();
        // Re-run with changed membership: updates, never duplicates.
        let again = mtc_apply(&mut c, &[up("House", f, &["a.mp3", "b.mp3", "d.mp3"])]).unwrap();
        assert!(!again[0].created);
        let again2 = mtc_apply(
            &mut c,
            &[DjOp::Upsert { parent_id: None, name: "MTC Genres".into(), kind: "folder".into(), paths: vec![], rules_json: None }],
        )
        .unwrap();
        assert!(!again2[0].created);
        let n: i64 = c.query_row("SELECT count(*) FROM mtc_playlist", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 3);
        let house = mtc_find(&c, f.map(|s| s.parse().unwrap()), "House", "playlist").unwrap();
        let tracks: Vec<String> = c
            .prepare("SELECT path FROM mtc_playlist_track WHERE playlist_id = ?1 ORDER BY position")
            .unwrap()
            .query_map([house], |r| r.get(0))
            .unwrap()
            .flatten()
            .collect();
        assert_eq!(tracks, vec!["a.mp3", "b.mp3", "d.mp3"]);
        // Deleting the folder removes its children and their tracks.
        mtc_apply(&mut c, &[DjOp::Delete { id: folder.unwrap() }]).unwrap();
        let left: i64 = c.query_row("SELECT count(*) FROM mtc_playlist", [], |r| r.get(0)).unwrap();
        let tl: i64 = c.query_row("SELECT count(*) FROM mtc_playlist_track", [], |r| r.get(0)).unwrap();
        assert_eq!((left, tl), (0, 0));
    }
}
