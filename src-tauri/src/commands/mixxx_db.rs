//! Mixxx's `mixxxdb.sqlite` (plain SQLite): read playlists/crates, and write
//! them while Mixxx is closed.
//!
//! Safety, in order, for every write (`apply_ops`): refuse if Mixxx is
//! running, copy the database to a timestamped backup next to it, then do all
//! changes in ONE transaction (all or nothing). Foreign keys stay off: the
//! schema's FKs point at a stale `library_old` table (a Mixxx migration
//! artefact), so turning them on would reject every insert.
//!
//! Mixxx has no smart crates. A "smart" list is a static crate named
//! `[smart] <name>` that we regenerate; the prefix means we only ever rebuild
//! our own.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OpenFlags};

use super::dj_playlists::{path_key, DjNode, DjOp, DjSnapshot, DjTrack, OpResult};

pub const SMART_PREFIX: &str = "[smart] ";

pub fn default_db_path() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    let p = std::env::var_os("LOCALAPPDATA").map(|a| PathBuf::from(a).join("Mixxx").join("mixxxdb.sqlite"));
    #[cfg(target_os = "macos")]
    let p = std::env::var_os("HOME").map(|h| {
        let base = PathBuf::from(h).join("Library");
        let sandbox = base.join("Containers/org.mixxx.mixxx/Data/Library/Application Support/Mixxx/mixxxdb.sqlite");
        if sandbox.is_file() {
            sandbox
        } else {
            base.join("Application Support/Mixxx/mixxxdb.sqlite")
        }
    });
    #[cfg(all(unix, not(target_os = "macos")))]
    let p = std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".mixxx").join("mixxxdb.sqlite"));
    p.filter(|p| p.is_file())
}

struct TempFile(PathBuf);
impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

pub fn read_snapshot(db: &Path) -> Result<DjSnapshot, String> {
    // Read a copy: a running Mixxx may hold locks or be mid-write.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = TempFile(std::env::temp_dir().join(format!("mtc-mixxx-{}-{nanos}.sqlite", std::process::id())));
    std::fs::copy(db, &tmp.0).map_err(|e| format!("Couldn't read Mixxx's library: {e}"))?;
    // A live Mixxx may keep recent changes in a -wal file; carry it along.
    let wal = PathBuf::from(format!("{}-wal", db.display()));
    let tmp_wal = PathBuf::from(format!("{}-wal", tmp.0.display()));
    let _wal_guard = if wal.is_file() && std::fs::copy(&wal, &tmp_wal).is_ok() { Some(TempFile(tmp_wal)) } else { None };
    let conn = Connection::open_with_flags(&tmp.0, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| e.to_string())?;
    let mut snap = read_from_conn(&conn)?;
    snap.db_path = Some(db.to_string_lossy().into_owned());
    Ok(snap)
}

pub(crate) fn read_from_conn(conn: &Connection) -> Result<DjSnapshot, String> {
    let e = |e: rusqlite::Error| format!("Mixxx library: {e}");
    let mut tracks = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT l.id, tl.location, l.title, l.artist, l.album, l.genre, l.key, l.bpm,
                        l.rating, l.year, l.comment, l.datetime_added, l.duration
                 FROM library l JOIN track_locations tl ON tl.id = l.location
                 WHERE COALESCE(l.mixxx_deleted, 0) = 0",
            )
            .map_err(e)?;
        let rows = stmt
            .query_map([], |r| {
                let s = |i: usize| -> rusqlite::Result<String> {
                    Ok(r.get::<_, Option<String>>(i)?.unwrap_or_default())
                };
                Ok(DjTrack {
                    id: r.get::<_, i64>(0)?.to_string(),
                    path: s(1)?,
                    title: s(2)?,
                    artist: s(3)?,
                    album: s(4)?,
                    genre: s(5)?,
                    key: s(6)?,
                    bpm: r.get::<_, Option<f64>>(7)?.unwrap_or(0.0),
                    rating: r.get::<_, Option<i64>>(8)?.unwrap_or(0).clamp(0, 5) as u8,
                    year: s(9)?,
                    comment: s(10)?,
                    date_added: s(11)?,
                    duration: r.get::<_, Option<f64>>(12)?.unwrap_or(0.0),
                    language: String::new(),
                })
            })
            .map_err(e)?;
        for t in rows.flatten() {
            tracks.push(t);
        }
    }

    let mut nodes = Vec::new();
    let mut members: HashMap<String, Vec<String>> = HashMap::new();
    {
        // hidden: 0 = normal, 1 = Auto DJ, 2 = set log (history). Only normal
        // playlists are ours to show.
        let mut stmt = conn
            .prepare("SELECT id, name, position FROM Playlists WHERE COALESCE(hidden, 0) = 0 ORDER BY position, id")
            .map_err(e)?;
        let lists: Vec<(i64, String, i64)> = stmt
            .query_map([], |r| {
                Ok((r.get(0)?, r.get::<_, Option<String>>(1)?.unwrap_or_default(), r.get::<_, Option<i64>>(2)?.unwrap_or(0)))
            })
            .map_err(e)?
            .flatten()
            .collect();
        let mut mstmt = conn
            .prepare("SELECT track_id FROM PlaylistTracks WHERE playlist_id = ?1 ORDER BY position, id")
            .map_err(e)?;
        for (id, name, seq) in lists {
            let ids: Vec<String> = mstmt
                .query_map([id], |r| r.get::<_, i64>(0).map(|v| v.to_string()))
                .map_err(e)?
                .flatten()
                .collect();
            let key = format!("p:{id}");
            nodes.push(DjNode {
                id: key.clone(),
                parent_id: None,
                name,
                kind: "playlist".into(),
                seq,
                count: ids.len(),
                smart_xml: None,
                rules_json: None,
            });
            members.insert(key, ids);
        }
    }
    {
        let mut stmt = conn.prepare("SELECT id, name FROM crates ORDER BY name COLLATE NOCASE").map_err(e)?;
        let lists: Vec<(i64, String)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get::<_, Option<String>>(1)?.unwrap_or_default())))
            .map_err(e)?
            .flatten()
            .collect();
        let mut mstmt = conn.prepare("SELECT track_id FROM crate_tracks WHERE crate_id = ?1").map_err(e)?;
        for (i, (id, name)) in lists.into_iter().enumerate() {
            let ids: Vec<String> = mstmt
                .query_map([id], |r| r.get::<_, i64>(0).map(|v| v.to_string()))
                .map_err(e)?
                .flatten()
                .collect();
            let key = format!("c:{id}");
            let smart = name.starts_with(SMART_PREFIX);
            nodes.push(DjNode {
                id: key.clone(),
                parent_id: None,
                name,
                kind: if smart { "smart" } else { "crate" }.into(),
                seq: i as i64,
                count: ids.len(),
                smart_xml: None,
                rules_json: None,
            });
            members.insert(key, ids);
        }
    }
    Ok(DjSnapshot { source: "mixxx".into(), db_path: None, nodes, tracks, members, running: false })
}

/// `Playlists`-or-`crates` addressing for ids like `p:12` / `c:3`.
fn parse_id(id: &str) -> Result<(bool, i64), String> {
    let (kind, n) = id.split_once(':').ok_or_else(|| format!("bad Mixxx id {id}"))?;
    let n: i64 = n.parse().map_err(|_| format!("bad Mixxx id {id}"))?;
    match kind {
        "p" => Ok((false, n)),
        "c" => Ok((true, n)),
        _ => Err(format!("bad Mixxx id {id}")),
    }
}

fn now_string() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

/// Copies the database (and its -wal, when present) to
/// `mixxxdb.sqlite.mtc-backup-<timestamp>` beside it and keeps only the ten
/// newest such backups.
pub fn backup(db: &Path) -> Result<PathBuf, String> {
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let name = db.file_name().and_then(|n| n.to_str()).unwrap_or("mixxxdb.sqlite");
    let dir = db.parent().ok_or("Mixxx database has no folder")?;
    let dest = dir.join(format!("{name}.mtc-backup-{stamp}"));
    std::fs::copy(db, &dest).map_err(|e| format!("Couldn't back up Mixxx's database first: {e}"))?;
    let prefix = format!("{name}.mtc-backup-");
    let mut old: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with(&prefix)))
                .collect()
        })
        .unwrap_or_default();
    old.sort();
    while old.len() > 10 {
        let _ = std::fs::remove_file(old.remove(0));
    }
    Ok(dest)
}

/// Applies `ops` to the Mixxx database at `db`. Callers must already have
/// verified Mixxx is not running (`dj_playlists::guard_not_running`); the
/// backup and the single transaction happen here.
pub fn apply_ops(db: &Path, ops: &[DjOp]) -> Result<Vec<OpResult>, String> {
    if ops.is_empty() {
        return Ok(vec![]);
    }
    backup(db)?;
    let mut conn = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_WRITE).map_err(|e| e.to_string())?;
    conn.busy_timeout(std::time::Duration::from_secs(3)).map_err(|e| e.to_string())?;
    // rusqlite's bundled SQLite compiles with foreign keys ON by default, and
    // Mixxx's FKs point at a table that no longer exists (`library_old`), so
    // every insert would fail with "no such table". Mixxx itself runs with
    // them off.
    conn.pragma_update(None, "foreign_keys", false).map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| format!("Mixxx database is busy ({e}). Is Mixxx still closing?"))?;
    let by_path = track_ids_by_path(&tx)?;
    let mut results = Vec::with_capacity(ops.len());
    for op in ops {
        results.push(apply_one(&tx, &by_path, op)?);
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(results)
}

fn track_ids_by_path(conn: &Connection) -> Result<HashMap<String, i64>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT l.id, tl.location FROM library l JOIN track_locations tl ON tl.id = l.location
             WHERE COALESCE(l.mixxx_deleted, 0) = 0",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    let mut m = HashMap::new();
    for (id, loc) in rows.flatten() {
        m.insert(path_key(&loc), id);
    }
    Ok(m)
}

/// Maps paths to Mixxx track ids; the rest are returned as unmatched (never
/// silently dropped).
fn resolve(by_path: &HashMap<String, i64>, paths: &[String]) -> (Vec<i64>, Vec<String>) {
    let mut ids = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut missing = Vec::new();
    for p in paths {
        match by_path.get(&path_key(p)) {
            Some(id) => {
                if seen.insert(*id) {
                    ids.push(*id);
                }
            }
            None => missing.push(p.clone()),
        }
    }
    (ids, missing)
}

fn fill(conn: &Connection, is_crate: bool, id: i64, ids: &[i64]) -> Result<(), String> {
    let e = |e: rusqlite::Error| e.to_string();
    if is_crate {
        conn.execute("DELETE FROM crate_tracks WHERE crate_id = ?1", [id]).map_err(e)?;
        let mut ins = conn
            .prepare("INSERT OR IGNORE INTO crate_tracks (crate_id, track_id) VALUES (?1, ?2)")
            .map_err(e)?;
        for t in ids {
            ins.execute(params![id, t]).map_err(e)?;
        }
        conn.execute("UPDATE crates SET count = ?2 WHERE id = ?1", params![id, ids.len() as i64]).map_err(e)?;
    } else {
        conn.execute("DELETE FROM PlaylistTracks WHERE playlist_id = ?1", [id]).map_err(e)?;
        let now = now_string();
        let mut ins = conn
            .prepare("INSERT INTO PlaylistTracks (playlist_id, track_id, position, pl_datetime_added) VALUES (?1, ?2, ?3, ?4)")
            .map_err(e)?;
        for (i, t) in ids.iter().enumerate() {
            ins.execute(params![id, t, i as i64 + 1, now]).map_err(e)?;
        }
        conn.execute("UPDATE Playlists SET date_modified = ?2 WHERE id = ?1", params![id, now]).map_err(e)?;
    }
    Ok(())
}

fn crate_name(kind: &str, name: &str) -> String {
    if kind == "smart" && !name.starts_with(SMART_PREFIX) {
        format!("{SMART_PREFIX}{name}")
    } else {
        name.to_string()
    }
}

fn create(conn: &Connection, kind: &str, name: &str, ids: &[i64]) -> Result<String, String> {
    let e = |e: rusqlite::Error| e.to_string();
    match kind {
        "folder" => Err("Mixxx has no folders".into()),
        "playlist" => {
            let now = now_string();
            conn.execute(
                "INSERT INTO Playlists (name, position, hidden, date_created, date_modified, locked)
                 VALUES (?1, (SELECT COALESCE(MAX(position), 0) + 1 FROM Playlists), 0, ?2, ?2, 0)",
                params![name, now],
            )
            .map_err(e)?;
            let id = conn.last_insert_rowid();
            fill(conn, false, id, ids)?;
            Ok(format!("p:{id}"))
        }
        _ => {
            let n = crate_name(kind, name);
            conn.execute(
                "INSERT INTO crates (name, count, show, locked, autodj_source) VALUES (?1, 0, 1, 0, 0)",
                params![n],
            )
            .map_err(|er| match er {
                rusqlite::Error::SqliteFailure(f, _) if f.code == rusqlite::ErrorCode::ConstraintViolation => {
                    format!("A Mixxx crate called \"{n}\" already exists")
                }
                other => other.to_string(),
            })?;
            let id = conn.last_insert_rowid();
            fill(conn, true, id, ids)?;
            Ok(format!("c:{id}"))
        }
    }
}

fn apply_one(conn: &Connection, by_path: &HashMap<String, i64>, op: &DjOp) -> Result<OpResult, String> {
    let e = |e: rusqlite::Error| e.to_string();
    match op {
        DjOp::Create { name, kind, paths, .. } => {
            let (ids, missing) = resolve(by_path, paths);
            let id = create(conn, kind, name, &ids)?;
            Ok(OpResult { id: Some(id), created: true, matched: ids.len(), unmatched: missing })
        }
        DjOp::Upsert { name, kind, paths, .. } => {
            let (ids, missing) = resolve(by_path, paths);
            // Idempotent by name within the kind (playlist vs crate): re-running
            // an export updates the existing list instead of duplicating it.
            if kind == "playlist" {
                let found: Option<i64> = conn
                    .query_row("SELECT id FROM Playlists WHERE name = ?1 AND COALESCE(hidden,0) = 0 ORDER BY id LIMIT 1", [name], |r| r.get(0))
                    .ok();
                if let Some(id) = found {
                    fill(conn, false, id, &ids)?;
                    return Ok(OpResult { id: Some(format!("p:{id}")), created: false, matched: ids.len(), unmatched: missing });
                }
            } else {
                let n = crate_name(kind, name);
                let found: Option<i64> = conn.query_row("SELECT id FROM crates WHERE name = ?1", [&n], |r| r.get(0)).ok();
                if let Some(id) = found {
                    fill(conn, true, id, &ids)?;
                    return Ok(OpResult { id: Some(format!("c:{id}")), created: false, matched: ids.len(), unmatched: missing });
                }
            }
            let id = create(conn, kind, name, &ids)?;
            Ok(OpResult { id: Some(id), created: true, matched: ids.len(), unmatched: missing })
        }
        DjOp::SetTracks { id, paths } => {
            let (is_crate, n) = parse_id(id)?;
            let (ids, missing) = resolve(by_path, paths);
            fill(conn, is_crate, n, &ids)?;
            Ok(OpResult { id: Some(id.clone()), created: false, matched: ids.len(), unmatched: missing })
        }
        DjOp::Rename { id, name } => {
            let (is_crate, n) = parse_id(id)?;
            if is_crate {
                conn.execute("UPDATE crates SET name = ?2 WHERE id = ?1", params![n, name]).map_err(e)?;
            } else {
                conn.execute("UPDATE Playlists SET name = ?2, date_modified = ?3 WHERE id = ?1", params![n, name, now_string()])
                    .map_err(e)?;
            }
            Ok(OpResult { id: Some(id.clone()), created: false, matched: 0, unmatched: vec![] })
        }
        DjOp::Delete { id } => {
            let (is_crate, n) = parse_id(id)?;
            if is_crate {
                conn.execute("DELETE FROM crate_tracks WHERE crate_id = ?1", [n]).map_err(e)?;
                conn.execute("DELETE FROM crates WHERE id = ?1", [n]).map_err(e)?;
            } else {
                // hidden = 0 only: never delete Auto DJ or a set log by id.
                let ok = conn
                    .execute("DELETE FROM Playlists WHERE id = ?1 AND COALESCE(hidden, 0) = 0", [n])
                    .map_err(e)?;
                if ok == 1 {
                    conn.execute("DELETE FROM PlaylistTracks WHERE playlist_id = ?1", [n]).map_err(e)?;
                }
            }
            Ok(OpResult { id: Some(id.clone()), created: false, matched: 0, unmatched: vec![] })
        }
        DjOp::SetRules { .. } => Err("Mixxx can't store smart rules; keep the rule in Music Tag Cleaner".into()),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub const MIXXX_SCHEMA: &str = "
        CREATE TABLE track_locations (id INTEGER PRIMARY KEY, location varchar(512), filename, directory, filesize, fs_deleted INTEGER, needs_verification INTEGER);
        CREATE TABLE library (id INTEGER PRIMARY KEY, artist, title, album, year, genre, tracknumber, location INTEGER, comment, duration, bpm FLOAT, rating INTEGER, key, key_id, grouping, album_artist, composer, color, datetime_added, mixxx_deleted INTEGER DEFAULT 0, timesplayed);
        CREATE TABLE Playlists (id INTEGER PRIMARY KEY, name varchar(48), position INTEGER, hidden INTEGER DEFAULT 0 NOT NULL, date_created datetime, date_modified datetime, locked INTEGER DEFAULT 0);
        CREATE TABLE PlaylistTracks (id INTEGER PRIMARY KEY, playlist_id INTEGER REFERENCES Playlists(id), track_id INTEGER REFERENCES \"library_old\"(id), position INTEGER, pl_datetime_added);
        CREATE TABLE crates (id INTEGER PRIMARY KEY AUTOINCREMENT, name varchar(48) UNIQUE NOT NULL, count INTEGER DEFAULT 0, show INTEGER DEFAULT 1, locked INTEGER DEFAULT 0, autodj_source INTEGER DEFAULT 0);
        CREATE TABLE crate_tracks (crate_id INTEGER NOT NULL REFERENCES crates(id), track_id INTEGER NOT NULL REFERENCES \"library_old\"(id), UNIQUE (crate_id, track_id));
        INSERT INTO track_locations (id, location) VALUES (1,'C:/Music/A - One.mp3'),(2,'C:/Music/B - Two.mp3'),(3,'C:/Music/C - Three.mp3');
        INSERT INTO library (id, artist, title, genre, bpm, rating, key, location, datetime_added) VALUES
          (1,'A','One','House',124.0,3,'Am',1,'2025-01-01 00:00:00'),
          (2,'B','Two','Techno',130.0,0,'Dbm',2,'2025-01-02 00:00:00'),
          (3,'C','Three','House',126.0,5,'8A',3,'2025-01-03 00:00:00');
        INSERT INTO Playlists (id, name, position, hidden) VALUES (1,'Auto DJ',1,1),(3,'2025-12-24',3,2);
    ";

    pub fn scratch_db(name: &str) -> (PathBuf, PathBuf) {
        let d = std::env::temp_dir().join(format!("mtc-mixxxtest-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let db = d.join("mixxxdb.sqlite");
        let c = Connection::open(&db).unwrap();
        c.execute_batch(MIXXX_SCHEMA).unwrap();
        (d, db)
    }

    fn create_op(name: &str, kind: &str, paths: &[&str]) -> DjOp {
        DjOp::Create {
            parent_id: None,
            name: name.into(),
            kind: kind.into(),
            paths: paths.iter().map(|s| s.to_string()).collect(),
            rules_json: None,
        }
    }

    #[test]
    fn writes_playlists_and_crates_in_one_transaction_with_a_backup() {
        let (d, db) = scratch_db("write");
        let res = apply_ops(
            &db,
            &[
                create_op("Warmup", "playlist", &["C:\\Music\\b - two.mp3", "C:/Music/A - One.mp3", "D:/gone.mp3"]),
                create_op("House", "smart", &["C:/Music/A - One.mp3", "C:/Music/C - Three.mp3"]),
            ],
        )
        .unwrap();
        assert_eq!(res[0].matched, 2);
        assert_eq!(res[0].unmatched, vec!["D:/gone.mp3".to_string()]);
        assert!(std::fs::read_dir(&d).unwrap().flatten().any(|e| e.file_name().to_string_lossy().contains("mtc-backup-")));

        let snap = read_snapshot(&db).unwrap();
        let pl = snap.nodes.iter().find(|n| n.name == "Warmup").unwrap();
        assert_eq!(pl.kind, "playlist");
        // Order preserved (case/slash-insensitive match): Two then One.
        assert_eq!(snap.members[&pl.id], vec!["2".to_string(), "1".to_string()]);
        let sm = snap.nodes.iter().find(|n| n.name == "[smart] House").unwrap();
        assert_eq!(sm.kind, "smart");
        assert_eq!(sm.count, 2);
        // Auto DJ and history stay hidden from the tree.
        assert!(snap.nodes.iter().all(|n| n.name != "Auto DJ" && n.name != "2025-12-24"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn upsert_is_idempotent_and_failure_rolls_everything_back() {
        let (d, db) = scratch_db("upsert");
        let up = |paths: &[&str]| DjOp::Upsert {
            parent_id: None,
            name: "Techno".into(),
            kind: "smart".into(),
            paths: paths.iter().map(|s| s.to_string()).collect(),
            rules_json: None,
        };
        let r1 = apply_ops(&db, &[up(&["C:/Music/B - Two.mp3"])]).unwrap();
        assert!(r1[0].created);
        let r2 = apply_ops(&db, &[up(&["C:/Music/B - Two.mp3", "C:/Music/C - Three.mp3"])]).unwrap();
        assert!(!r2[0].created);
        let snap = read_snapshot(&db).unwrap();
        assert_eq!(snap.nodes.iter().filter(|n| n.name == "[smart] Techno").count(), 1);
        assert_eq!(snap.nodes.iter().find(|n| n.name == "[smart] Techno").unwrap().count, 2);

        // Second op fails (duplicate crate name via Create) -> first op undone too.
        let before = snap.nodes.len();
        let err = apply_ops(&db, &[create_op("Fresh", "playlist", &[]), create_op("[smart] Techno", "smart", &[])]);
        assert!(err.is_err());
        assert_eq!(read_snapshot(&db).unwrap().nodes.len(), before);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn rename_delete_and_replace_tracks() {
        let (d, db) = scratch_db("edit");
        let id = apply_ops(&db, &[create_op("L", "playlist", &["C:/Music/A - One.mp3"])]).unwrap()[0].id.clone().unwrap();
        apply_ops(
            &db,
            &[
                DjOp::Rename { id: id.clone(), name: "L2".into() },
                DjOp::SetTracks { id: id.clone(), paths: vec!["C:/Music/C - Three.mp3".into(), "C:/Music/B - Two.mp3".into()] },
            ],
        )
        .unwrap();
        let s = read_snapshot(&db).unwrap();
        assert_eq!(s.nodes.iter().find(|n| n.id == id).unwrap().name, "L2");
        assert_eq!(s.members[&id], vec!["3".to_string(), "2".to_string()]);
        apply_ops(&db, &[DjOp::Delete { id: id.clone() }]).unwrap();
        assert!(read_snapshot(&db).unwrap().nodes.iter().all(|n| n.id != id));
        // Auto DJ (hidden=1) can't be deleted through the API.
        apply_ops(&db, &[DjOp::Delete { id: "p:1".into() }]).unwrap();
        let c = Connection::open(&db).unwrap();
        let n: i64 = c.query_row("SELECT count(*) FROM Playlists WHERE id = 1", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Runs the writer against a COPY of the owner's real mixxxdb.sqlite
    /// (never the live file) when present, to prove the real schema accepts it.
    #[test]
    fn writes_to_a_copy_of_the_real_mixxx_db() {
        let Some(live) = default_db_path() else {
            eprintln!("no Mixxx database here; skipping");
            return;
        };
        let d = std::env::temp_dir().join(format!("mtc-mixxxreal-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let copy = d.join("mixxxdb.sqlite");
        std::fs::copy(&live, &copy).unwrap();
        let before = read_snapshot(&copy).unwrap();
        assert!(before.tracks.len() > 100, "{} tracks", before.tracks.len());
        let some: Vec<String> = before.tracks.iter().take(5).map(|t| t.path.clone()).collect();
        let res = apply_ops(
            &copy,
            &[
                create_op("MTC test playlist", "playlist", &some.iter().map(String::as_str).collect::<Vec<_>>()),
                create_op("MTC test", "smart", &some.iter().map(String::as_str).collect::<Vec<_>>()),
            ],
        )
        .unwrap();
        assert_eq!(res[0].matched, 5);
        let after = read_snapshot(&copy).unwrap();
        assert_eq!(after.nodes.len(), before.nodes.len() + 2);
        assert_eq!(after.tracks.len(), before.tracks.len());
        let c = Connection::open(&copy).unwrap();
        let ic: String = c.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
        assert_eq!(ic, "ok");
        eprintln!("real mixxx copy: {} tracks, {} lists before", before.tracks.len(), before.nodes.len());
        let _ = std::fs::remove_dir_all(&d);
    }
}
