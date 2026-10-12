//! Read-only access to Rekordbox's `master.db` (SQLCipher 4).
//!
//! The file is never opened in place: it is decrypted page by page into a
//! temp SQLite file (`sqlcipher.rs`, HMAC-verified), read with plain rusqlite,
//! and the temp file is deleted. Nothing is ever written back to Rekordbox's
//! database; playlists reach Rekordbox through a `rekordbox.xml` import (see
//! plans/v0.19/notes/C1.md for why).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};

use super::dj_playlists::{DjNode, DjSnapshot, DjTrack};
use super::dj_sync::SyncMeta;
use super::sqlcipher::{decrypt_database, REKORDBOX_PASSPHRASE};

pub fn default_db_path() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    let p = std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("Pioneer").join("rekordbox").join("master.db"));
    #[cfg(target_os = "macos")]
    let p = std::env::var_os("HOME")
        .map(|h| PathBuf::from(h).join("Library").join("Pioneer").join("rekordbox").join("master.db"));
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let p: Option<PathBuf> = None;
    p.filter(|p| p.is_file())
}

/// Deletes the decrypted copy when dropped, so a failed read can't leave the
/// owner's whole library as an unencrypted file in the temp folder.
struct TempDb(PathBuf);
impl Drop for TempDb {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn temp_name() -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("mtc-rb-{}-{nanos}.db", std::process::id()))
}

/// SQLite `BPM` is stored x100; 0 means "not analysed".
fn bpm_from_db(raw: i64) -> f64 {
    raw as f64 / 100.0
}

pub fn read_snapshot(db: &Path) -> Result<DjSnapshot, String> {
    read_sync(db).map(|(s, _)| s)
}

/// The snapshot plus the per-track metadata C2's sync compares, from ONE
/// decryption (the key derivation is the slow part).
pub fn read_sync(db: &Path) -> Result<(DjSnapshot, Vec<SyncMeta>), String> {
    let tmp = TempDb(temp_name());
    decrypt_database(db, &tmp.0, REKORDBOX_PASSPHRASE).map_err(|e| {
        format!("Couldn't read Rekordbox's library ({e}). If Rekordbox is open, close it and try again.")
    })?;
    let conn = Connection::open_with_flags(&tmp.0, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| e.to_string())?;
    let snap = read_from_plain(&conn)?;
    let meta = read_meta(&conn)?;
    drop(conn);
    Ok((DjSnapshot { db_path: Some(db.to_string_lossy().into_owned()), ..snap }, meta))
}

/// Rekordbox's eight track colours (`djmdContent.ColorID` 1-8, in the order its
/// colour picker shows them) as the RGB values its rekordbox.xml format uses.
/// `djmdColor` only carries the owner's *names* for them (e.g. "Banger"), not
/// the RGB, so the table is fixed here. 0 = no colour.
pub const COLOR_RGB: [&str; 8] =
    ["#ff007f", "#ff0000", "#ffa500", "#ffff00", "#00ff00", "#25fde9", "#0000ff", "#660099"];

fn color_from_id(id: &str) -> String {
    id.trim()
        .parse::<usize>()
        .ok()
        .filter(|n| (1..=8).contains(n))
        .map(|n| COLOR_RGB[n - 1].to_string())
        .unwrap_or_default()
}

pub(crate) fn read_meta(conn: &Connection) -> Result<Vec<SyncMeta>, String> {
    let e = |e: rusqlite::Error| format!("Rekordbox library: {e}");
    let mut stmt = conn
        .prepare(
            "SELECT c.FolderPath, c.BPM, k.ScaleName, c.Rating, c.DJPlayCount, c.Commnt, c.ColorID
             FROM djmdContent c LEFT JOIN djmdKey k ON k.ID = c.KeyID
             WHERE COALESCE(c.rb_local_deleted, 0) = 0",
        )
        .map_err(e)?;
    let rows = stmt
        .query_map([], |r| {
            Ok(SyncMeta {
                path: r.get::<_, Option<String>>(0)?.unwrap_or_default(),
                bpm: bpm_from_db(r.get::<_, Option<i64>>(1)?.unwrap_or(0)),
                key: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                rating: r.get::<_, Option<i64>>(3)?.unwrap_or(0).clamp(0, 5) as u8,
                plays: r.get::<_, Option<i64>>(4)?.unwrap_or(0).max(0),
                comment: r.get::<_, Option<String>>(5)?.unwrap_or_default(),
                color: color_from_id(&r.get::<_, Option<String>>(6)?.unwrap_or_default()),
                grid: false,
            })
        })
        .map_err(e)?;
    Ok(rows.flatten().filter(|m| !m.path.is_empty()).collect())
}

pub(crate) fn read_from_plain(conn: &Connection) -> Result<DjSnapshot, String> {
    let e = |e: rusqlite::Error| format!("Rekordbox library: {e}");

    let mut tracks: Vec<DjTrack> = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT c.ID, c.FolderPath, c.Title, a.Name, al.Name, g.Name, k.ScaleName,
                        c.BPM, c.Rating, c.ReleaseYear, c.Commnt, c.StockDate, c.Length
                 FROM djmdContent c
                 LEFT JOIN djmdArtist a ON a.ID = c.ArtistID
                 LEFT JOIN djmdAlbum al ON al.ID = c.AlbumID
                 LEFT JOIN djmdGenre g ON g.ID = c.GenreID
                 LEFT JOIN djmdKey k ON k.ID = c.KeyID
                 WHERE COALESCE(c.rb_local_deleted, 0) = 0",
            )
            .map_err(e)?;
        let rows = stmt
            .query_map([], |r| {
                let s = |i: usize| -> rusqlite::Result<String> {
                    Ok(r.get::<_, Option<String>>(i)?.unwrap_or_default())
                };
                Ok(DjTrack {
                    id: s(0)?,
                    path: s(1)?,
                    title: s(2)?,
                    artist: s(3)?,
                    album: s(4)?,
                    genre: s(5)?,
                    key: s(6)?,
                    bpm: bpm_from_db(r.get::<_, Option<i64>>(7)?.unwrap_or(0)),
                    rating: r.get::<_, Option<i64>>(8)?.unwrap_or(0).clamp(0, 5) as u8,
                    year: r.get::<_, Option<i64>>(9)?.filter(|y| *y > 0).map(|y| y.to_string()).unwrap_or_default(),
                    comment: s(10)?,
                    date_added: s(11)?,
                    duration: r.get::<_, Option<i64>>(12)?.unwrap_or(0) as f64,
                    language: String::new(),
                })
            })
            .map_err(e)?;
        for t in rows.flatten() {
            tracks.push(t);
        }
    }

    // Members of static playlists, in playlist order. Smart playlists have no
    // rows here (Rekordbox evaluates them at runtime), so the UI evaluates
    // their rules itself.
    let mut members: HashMap<String, Vec<String>> = HashMap::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT PlaylistID, ContentID FROM djmdSongPlaylist
                 WHERE COALESCE(rb_local_deleted, 0) = 0
                 ORDER BY PlaylistID, TrackNo",
            )
            .map_err(e)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?))
            })
            .map_err(e)?;
        for (p, c) in rows.flatten() {
            if let (Some(p), Some(c)) = (p, c) {
                members.entry(p).or_default().push(c);
            }
        }
    }

    let mut nodes: Vec<DjNode> = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT ID, Seq, Name, Attribute, ParentID, SmartList FROM djmdPlaylist
                 WHERE COALESCE(rb_local_deleted, 0) = 0
                 ORDER BY ParentID, Seq",
            )
            .map_err(e)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<i64>>(1)?.unwrap_or(0),
                    r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    r.get::<_, Option<i64>>(3)?.unwrap_or(0),
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, Option<String>>(5)?,
                ))
            })
            .map_err(e)?;
        for (id, seq, name, attr, parent, smart) in rows.flatten() {
            let kind = match attr {
                1 => "folder",
                4 => "smart",
                _ => "playlist",
            };
            let parent_id = parent.filter(|p| p != "root" && !p.is_empty());
            nodes.push(DjNode {
                count: members.get(&id).map(|m| m.len()).unwrap_or(0),
                id,
                parent_id,
                name,
                kind: kind.to_string(),
                seq,
                smart_xml: if kind == "smart" { smart.filter(|s| !s.trim().is_empty()) } else { None },
                rules_json: None,
            });
        }
    }

    Ok(DjSnapshot { source: "rekordbox".into(), db_path: None, nodes, tracks, members, running: false })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reads a COPY of the owner's real master.db (never the live file) when
    /// one exists on this machine. Skips silently elsewhere (CI).
    #[test]
    fn reads_the_real_master_db_copy() {
        let Some(live) = default_db_path() else {
            eprintln!("no Rekordbox master.db here; skipping");
            return;
        };
        let dir = std::env::temp_dir().join(format!("mtc-rbtest-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let copy = dir.join("master-copy.db");
        std::fs::copy(&live, &copy).unwrap();
        let snap = read_snapshot(&copy).unwrap();
        let _ = std::fs::remove_dir_all(&dir);

        eprintln!(
            "real master.db: {} tracks, {} nodes ({} playlists, {} folders, {} smart)",
            snap.tracks.len(),
            snap.nodes.len(),
            snap.nodes.iter().filter(|n| n.kind == "playlist").count(),
            snap.nodes.iter().filter(|n| n.kind == "folder").count(),
            snap.nodes.iter().filter(|n| n.kind == "smart").count(),
        );
        assert!(snap.tracks.len() > 3500 && snap.tracks.len() < 6000, "track count {}", snap.tracks.len());
        assert!(snap.nodes.len() > 100);
        assert!(snap.nodes.iter().any(|n| n.kind == "folder"));
        let smart = snap.nodes.iter().find(|n| n.kind == "smart").expect("a smart playlist");
        assert!(smart.smart_xml.as_deref().unwrap_or("").contains("<NODE"));
        // Every static playlist member id resolves to a track (or is a
        // soft-deleted one; allow a small slack).
        let ids: std::collections::HashSet<&str> = snap.tracks.iter().map(|t| t.id.as_str()).collect();
        let total: usize = snap.members.values().map(|m| m.len()).sum();
        let missing: usize = snap.members.values().flatten().filter(|m| !ids.contains(m.as_str())).count();
        assert!(total > 1000 && missing * 20 < total, "total {total} missing {missing}");
        assert!(snap.tracks.iter().any(|t| !t.path.is_empty() && t.bpm > 0.0 && !t.genre.is_empty()));
    }
}
