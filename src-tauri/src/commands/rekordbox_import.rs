//! Rekordbox cue import (v0.9 F5): reads memory cues, hot cues, loops and
//! the beat grid from a `rekordbox.xml` collection export. Read-only — this
//! never writes anything back to Rekordbox.
//!
//! Cues are stored keyed by **audio fingerprint, not file path** (reusing
//! the exact same Chromaprint pipeline and sqlite database `duplicates.rs`
//! already built for duplicate detection), so a cue survives a rename or a
//! move — the whole reason the roadmap called for this instead of the
//! simpler path-keyed approach.

use std::collections::HashMap;
use std::path::Path;

use quick_xml::events::Event;
use quick_xml::Reader;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use super::duplicates::{fingerprint_many, get_or_compute, open_db};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TempoPoint {
    pub position_secs: f64,
    pub bpm: f64,
    pub meter: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CuePoint {
    pub position_secs: f64,
    /// `None` for a memory cue; `Some(pad)` (0-7) for a hot cue.
    pub pad: Option<i32>,
    pub name: String,
    pub color: Option<(u8, u8, u8)>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopPoint {
    pub start_secs: f64,
    pub end_secs: f64,
    pub pad: Option<i32>,
    pub name: String,
    pub color: Option<(u8, u8, u8)>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CueData {
    pub average_bpm: Option<f64>,
    pub tempo: Vec<TempoPoint>,
    pub memory_cues: Vec<CuePoint>,
    pub hot_cues: Vec<CuePoint>,
    pub loops: Vec<LoopPoint>,
}

#[derive(Debug, Clone, Default)]
struct ParsedTrack {
    track_id: i64,
    location: String,
    name: String,
    artist: String,
    /// Whole seconds, straight from rekordbox's `TotalTime` attribute.
    total_time_secs: Option<i64>,
    average_bpm: Option<f64>,
    /// Rekordbox's `Tonality` attribute, e.g. "8A" or "Fm" — whatever key
    /// notation the user has Rekordbox set to export in. Not normalized here.
    tonality: Option<String>,
    /// Stars 0-5 from the `Rating` attribute (0/51/102/153/204/255); `None`
    /// when the attribute is absent or the track is unrated.
    rating: Option<u8>,
    cues: CueData,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub total_entries: usize,
    pub matched: usize,
    pub not_found_on_disk: usize,
    pub errors: Vec<String>,
}

/// Decodes `%XX` percent-escapes (the only encoding rekordbox.xml's
/// `file://` URIs use) without pulling in a full URL-parsing crate for it.
fn percent_decode(s: &str) -> String {
    // Works on bytes throughout: slicing the `&str` to read the two hex
    // digits panicked when a literal '%' was followed by a multi-byte
    // character ("100%é"), since that slice ends mid-character.
    fn hex(b: u8) -> Option<u8> {
        (b as char).to_digit(16).map(|d| d as u8)
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push(hi << 4 | lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A rekordbox.xml `Location` URI as a native path:
/// `file://localhost/C:/Users/x/song.flac` -> `C:\Users\x\song.flac` on
/// Windows, `file://localhost/Users/x/song.flac` -> `/Users/x/song.flac` on
/// macOS. (Converting to backslashes unconditionally broke every macOS
/// import: no path it produced could exist.)
fn location_to_path(location: &str) -> String {
    let rest = location
        .strip_prefix("file://localhost")
        .or_else(|| location.strip_prefix("file://"))
        .unwrap_or(location);
    let decoded = percent_decode(rest);
    if cfg!(windows) {
        // `file://localhost//server/share/x.mp3`: a network share keeps its
        // leading `\\` - trimming every slash turned it into a relative path.
        if let Some(unc) = decoded.strip_prefix("//").filter(|s| !s.starts_with('/')) {
            return format!(r"\\{}", unc.replace('/', "\\"));
        }
        decoded.trim_start_matches('/').replace('/', "\\")
    } else {
        decoded
    }
}

// `unescape_value()`'s replacement (`normalized_value`) takes an XML version
// parameter this codebase has no reason to track for a private XML-reading
// helper; the deprecated method is unremoved and behaves identically here.
#[allow(deprecated)]
fn attr_str(e: &quick_xml::events::BytesStart, name: &str) -> Option<String> {
    e.attributes()
        .flatten()
        .find(|a| a.key.as_ref() == name)
        .and_then(|a| a.unescape_value().ok().map(|v| v.into_owned()))
}

fn attr_f64(e: &quick_xml::events::BytesStart, name: &str) -> Option<f64> {
    attr_str(e, name).and_then(|v| v.parse().ok())
}

fn attr_i32(e: &quick_xml::events::BytesStart, name: &str) -> Option<i32> {
    attr_str(e, name).and_then(|v| v.parse().ok())
}

/// Rekordbox's `Rating` attribute (0, 51, 102, 153, 204, 255) as 0-5 stars,
/// `None` for unrated. Rounds to the nearest step so a hand-edited export
/// (e.g. 200) still lands on a star; anything above 255 clamps to five.
fn stars_from_rekordbox_rating(raw: i32) -> Option<u8> {
    if raw <= 0 {
        return None;
    }
    let stars = ((raw.min(255) + 25) / 51).clamp(1, 5);
    Some(stars as u8)
}

/// Reads the plain (non-cue) fields off a `<TRACK>`'s attributes — shared by
/// the `Start` (has cue children) and `Empty` (self-closed, no children,
/// e.g. a track with no memory/hot cues) cases below.
fn track_from_attrs(e: &quick_xml::events::BytesStart) -> ParsedTrack {
    let location = attr_str(e, "Location").map(|l| location_to_path(&l)).unwrap_or_default();
    ParsedTrack {
        track_id: attr_str(e, "TrackID").and_then(|v| v.parse().ok()).unwrap_or(0),
        location,
        name: attr_str(e, "Name").unwrap_or_default(),
        artist: attr_str(e, "Artist").unwrap_or_default(),
        total_time_secs: attr_i32(e, "TotalTime").map(|v| v as i64),
        average_bpm: attr_f64(e, "AverageBpm"),
        tonality: attr_str(e, "Tonality").filter(|v| !v.is_empty()),
        rating: attr_i32(e, "Rating").and_then(stars_from_rekordbox_rating),
        cues: CueData::default(),
    }
}

/// Parses a rekordbox.xml collection export into one entry per `<TRACK>`.
/// Ignores `<PLAYLISTS>` entirely — out of scope for cue import (see
/// `parse_playlist_tree` below, which reads that section separately).
fn parse_rekordbox_xml(xml_path: &str) -> Result<Vec<ParsedTrack>, String> {
    let mut reader = Reader::from_file(xml_path).map_err(|e| e.to_string())?;
    reader.config_mut().trim_text(true);

    let mut tracks = Vec::new();
    let mut current: Option<ParsedTrack> = None;
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Eof) => break,
            Ok(Event::Start(e)) if e.name().as_ref() == "TRACK" => {
                current = Some(track_from_attrs(&e));
            }
            // A track with no memory/hot cues at all may be self-closed
            // rather than an empty Start/End pair.
            Ok(Event::Empty(e)) if e.name().as_ref() == "TRACK" => {
                tracks.push(track_from_attrs(&e));
            }
            Ok(Event::End(e)) if e.name().as_ref() == "TRACK" => {
                if let Some(track) = current.take() {
                    tracks.push(track);
                }
            }
            Ok(Event::Empty(e)) if e.name().as_ref() == "TEMPO" => {
                if let Some(track) = current.as_mut() {
                    track.cues.tempo.push(TempoPoint {
                        position_secs: attr_f64(&e, "Inizio").unwrap_or(0.0),
                        bpm: attr_f64(&e, "Bpm").unwrap_or(0.0),
                        meter: attr_str(&e, "Metro").unwrap_or_default(),
                    });
                }
            }
            Ok(Event::Empty(e)) if e.name().as_ref() == "POSITION_MARK" => {
                if let Some(track) = current.as_mut() {
                    let start = attr_f64(&e, "Start").unwrap_or(0.0);
                    let end = attr_f64(&e, "End");
                    let num = attr_i32(&e, "Num");
                    let name = attr_str(&e, "Name").unwrap_or_default();
                    let color = match (attr_i32(&e, "Red"), attr_i32(&e, "Green"), attr_i32(&e, "Blue")) {
                        (Some(r), Some(g), Some(b)) => Some((r as u8, g as u8, b as u8)),
                        _ => None,
                    };
                    // Type="4" is a saved loop (has both Start and End); everything
                    // else observed in real exports (Type="0", the common case, and
                    // the rare Type="1") is a plain position — memory cue when
                    // Num is -1/absent, hot cue pad otherwise.
                    if let Some(end) = end {
                        track.cues.loops.push(LoopPoint {
                            start_secs: start,
                            end_secs: end,
                            pad: num.filter(|&n| n >= 0),
                            name,
                            color,
                        });
                    } else {
                        let cue = CuePoint { position_secs: start, pad: num.filter(|&n| n >= 0), name, color };
                        if cue.pad.is_some() {
                            track.cues.hot_cues.push(cue);
                        } else {
                            track.cues.memory_cues.push(cue);
                        }
                    }
                }
            }
            Ok(_) => {}
            Err(e) => return Err(format!("XML parse error: {e}")),
        }
        buf.clear();
    }

    Ok(tracks)
}

// --- Playlist export (v0.14 Mixxx bridge): reads <PLAYLISTS> from a
// rekordbox.xml (skipped entirely by the cue importer above) and writes each
// playlist out as a standalone .m3u8 that Mixxx's "Import Playlist" reads
// directly — no USB/SD device export required. Folder structure in
// Rekordbox is mirrored as subfolders of the chosen output directory.

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistNode {
    /// Stable within one parse of one file; built from the node's position
    /// in the tree plus its name, not persisted across imports.
    pub id: String,
    pub name: String,
    pub is_folder: bool,
    /// A playlist's own entry count, or the sum of a folder's descendants.
    pub track_count: usize,
    pub children: Vec<PlaylistNode>,
}

/// playlist id -> (folder path components, playlist name, ordered track keys).
type PlaylistData = HashMap<String, (Vec<String>, String, Vec<i64>)>;

fn read_playlist_children<R: std::io::BufRead>(
    reader: &mut Reader<R>,
    buf: &mut Vec<u8>,
    parent_id: &str,
    parent_path: &[String],
    data: &mut PlaylistData,
) -> Result<Vec<PlaylistNode>, String> {
    let mut children = Vec::new();
    let mut index = 0usize;
    loop {
        match reader.read_event_into(buf) {
            Ok(Event::Eof) => return Err("unexpected EOF inside <NODE>".to_string()),
            Ok(Event::End(e)) if e.name().as_ref() == "NODE" => {
                let _ = e;
                break;
            }
            Ok(Event::Start(e)) if e.name().as_ref() == "NODE" => {
                let owned = e.into_owned();
                buf.clear();
                let node = read_playlist_node(reader, buf, &owned, parent_id, index, parent_path, data)?;
                index += 1;
                children.push(node);
            }
            Ok(Event::Empty(e)) if e.name().as_ref() == "NODE" => {
                children.push(playlist_leaf(&e, parent_id, index, parent_path, data));
                index += 1;
            }
            Ok(_) => {}
            Err(e) => return Err(format!("XML parse error: {e}")),
        }
        buf.clear();
    }
    Ok(children)
}

fn read_playlist_node<R: std::io::BufRead>(
    reader: &mut Reader<R>,
    buf: &mut Vec<u8>,
    attrs: &quick_xml::events::BytesStart,
    parent_id: &str,
    index: usize,
    parent_path: &[String],
    data: &mut PlaylistData,
) -> Result<PlaylistNode, String> {
    let name = attr_str(attrs, "Name").unwrap_or_default();
    let is_folder = attr_str(attrs, "Type").as_deref() != Some("1");
    let id = format!("{parent_id}/{index}:{name}");

    if is_folder {
        let mut child_path = parent_path.to_vec();
        child_path.push(name.clone());
        let children = read_playlist_children(reader, buf, &id, &child_path, data)?;
        let track_count = children.iter().map(|c| c.track_count).sum();
        Ok(PlaylistNode { id, name, is_folder: true, track_count, children })
    } else {
        // A playlist NODE's children are <TRACK Key="…"/> entries, not sub-NODEs.
        let mut track_ids = Vec::new();
        loop {
            match reader.read_event_into(buf) {
                Ok(Event::Eof) => return Err("unexpected EOF inside playlist NODE".to_string()),
                Ok(Event::End(e)) if e.name().as_ref() == "NODE" => {
                    let _ = e;
                    break;
                }
                Ok(Event::Empty(e)) if e.name().as_ref() == "TRACK" => {
                    if let Some(key) = attr_str(&e, "Key").and_then(|v| v.parse::<i64>().ok()) {
                        track_ids.push(key);
                    }
                }
                Ok(_) => {}
                Err(e) => return Err(format!("XML parse error: {e}")),
            }
            buf.clear();
        }
        let track_count = track_ids.len();
        data.insert(id.clone(), (parent_path.to_vec(), name.clone(), track_ids));
        Ok(PlaylistNode { id, name, is_folder: false, track_count, children: Vec::new() })
    }
}

/// A self-closed `<NODE .../>` — an empty folder or empty playlist, either
/// way it has no children to recurse into.
fn playlist_leaf(
    e: &quick_xml::events::BytesStart,
    parent_id: &str,
    index: usize,
    parent_path: &[String],
    data: &mut PlaylistData,
) -> PlaylistNode {
    let name = attr_str(e, "Name").unwrap_or_default();
    let is_folder = attr_str(e, "Type").as_deref() != Some("1");
    let id = format!("{parent_id}/{index}:{name}");
    if !is_folder {
        data.insert(id.clone(), (parent_path.to_vec(), name.clone(), Vec::new()));
    }
    PlaylistNode { id, name, is_folder, track_count: 0, children: Vec::new() }
}

/// Parses the `<PLAYLISTS>` tree of a rekordbox.xml. The root `<NODE
/// Name="ROOT">` itself is synthesized (id `"root"`) rather than surfaced as
/// a real folder, since its own name is never part of a playlist's path.
fn parse_playlist_tree(xml_path: &str) -> Result<(PlaylistNode, PlaylistData), String> {
    let mut reader = Reader::from_file(xml_path).map_err(|e| e.to_string())?;
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Eof) => return Err("no <PLAYLISTS> section found in this XML".to_string()),
            Ok(Event::Start(e)) if e.name().as_ref() == "PLAYLISTS" => break,
            Ok(_) => {}
            Err(e) => return Err(format!("XML parse error: {e}")),
        }
        buf.clear();
    }
    buf.clear();

    let mut data: PlaylistData = HashMap::new();
    let root_children = loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Eof) => return Err("<PLAYLISTS> has no root NODE".to_string()),
            Ok(Event::Start(e)) if e.name().as_ref() == "NODE" => {
                let _ = e;
                buf.clear();
                break read_playlist_children(&mut reader, &mut buf, "root", &[], &mut data)?;
            }
            Ok(Event::Empty(e)) if e.name().as_ref() == "NODE" => {
                let _ = e;
                break Vec::new();
            }
            Ok(_) => {}
            Err(e) => return Err(format!("XML parse error: {e}")),
        }
        buf.clear();
    };

    let track_count = root_children.iter().map(|c| c.track_count).sum();
    let root = PlaylistNode { id: "root".to_string(), name: "ROOT".to_string(), is_folder: true, track_count, children: root_children };
    Ok((root, data))
}

/// Strips characters Windows (and, harmlessly, everyone else) rejects in a
/// path segment, so a Rekordbox folder/playlist name can never break the
/// output path.
fn sanitize_filename(name: &str) -> String {
    let cleaned: String = name.chars().map(|c| if "<>:\"/\\|?*".contains(c) { '_' } else { c }).collect();
    let trimmed = cleaned.trim().trim_end_matches('.');
    if trimmed.is_empty() {
        "Untitled".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Builds an `.m3u8` body identical in shape to the TS `buildM3u8()` in
/// `rekordboxExport.ts` (same `#EXTINF` convention, `-1` for unknown
/// duration) so a Rekordbox-sourced and an app-sourced playlist look the
/// same to Mixxx. Track ids with no COLLECTION match (deleted from
/// Rekordbox since the playlist was built, or a parse mismatch) are skipped.
fn build_m3u8(track_ids: &[i64], tracks_by_id: &HashMap<i64, ParsedTrack>) -> (String, usize) {
    let mut lines = vec!["#EXTM3U".to_string()];
    let mut matched = 0;
    for id in track_ids {
        let Some(t) = tracks_by_id.get(id) else { continue };
        matched += 1;
        let title = if t.name.is_empty() {
            Path::new(&t.location).file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default()
        } else {
            t.name.clone()
        };
        let label = if t.artist.is_empty() { title } else { format!("{} - {}", t.artist, title) };
        let duration = t.total_time_secs.unwrap_or(-1);
        lines.push(format!("#EXTINF:{duration},{label}"));
        lines.push(t.location.clone());
    }
    (lines.join("\n") + "\n", matched)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistExportEntry {
    pub playlist_id: String,
    pub playlist_name: String,
    pub file_path: String,
    pub track_count: usize,
    pub matched: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistExportResult {
    pub exported: Vec<PlaylistExportEntry>,
}

fn export_playlists_blocking(
    xml_path: &str,
    output_dir: &str,
    playlist_ids: Option<Vec<String>>,
) -> Result<PlaylistExportResult, String> {
    let tracks = parse_rekordbox_xml(xml_path)?;
    let tracks_by_id: HashMap<i64, ParsedTrack> = tracks.into_iter().map(|t| (t.track_id, t)).collect();

    let (_, playlist_data) = parse_playlist_tree(xml_path)?;

    let wanted: Vec<String> = match playlist_ids {
        Some(ids) => ids,
        None => playlist_data.keys().cloned().collect(),
    };

    let mut exported = Vec::new();
    for id in wanted {
        let Some((folder_path, name, track_ids)) = playlist_data.get(&id) else { continue };

        let mut dir = std::path::PathBuf::from(output_dir);
        for segment in folder_path {
            dir.push(sanitize_filename(segment));
        }
        std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;

        let file_path = dir.join(format!("{}.m3u8", sanitize_filename(name)));
        let (content, matched) = build_m3u8(track_ids, &tracks_by_id);
        std::fs::write(&file_path, content).map_err(|e| format!("could not write {}: {e}", file_path.display()))?;

        exported.push(PlaylistExportEntry {
            playlist_id: id.clone(),
            playlist_name: name.clone(),
            file_path: file_path.display().to_string(),
            track_count: track_ids.len(),
            matched,
        });
    }

    Ok(PlaylistExportResult { exported })
}

#[tauri::command]
pub async fn read_rekordbox_playlists(xml_path: String) -> Result<PlaylistNode, String> {
    tauri::async_runtime::spawn_blocking(move || parse_playlist_tree(&xml_path).map(|(tree, _)| tree))
        .await
        .map_err(|_| "rekordbox playlist read task panicked".to_string())?
}

#[tauri::command]
pub async fn export_rekordbox_playlists_for_mixxx(
    xml_path: String,
    output_dir: String,
    playlist_ids: Option<Vec<String>>,
) -> Result<PlaylistExportResult, String> {
    tauri::async_runtime::spawn_blocking(move || export_playlists_blocking(&xml_path, &output_dir, playlist_ids))
        .await
        .map_err(|_| "rekordbox playlist export task panicked".to_string())?
}

const CUES_SCHEMA_SQL: &str = "CREATE TABLE IF NOT EXISTS cues (
    fingerprint_key TEXT PRIMARY KEY,
    source_path TEXT NOT NULL,
    data TEXT NOT NULL,
    imported_at INTEGER NOT NULL
);";

/// The stable, path-independent lookup key: a hash of the audio fingerprint
/// itself (not the byte-exact blake3 used for exact-duplicate detection,
/// which would change on every tag edit since tags are embedded in the same
/// file — the fingerprint is decoded-audio-only and untouched by that).
fn fingerprint_key(fingerprint: &[u32]) -> String {
    let joined = fingerprint.iter().map(|v| v.to_string()).collect::<Vec<_>>().join(",");
    blake3::hash(joined.as_bytes()).to_hex().to_string()
}

fn emit_progress(app: &AppHandle, done: usize, total: usize) {
    let _ = app.emit("rekordbox-import-progress", serde_json::json!({ "done": done, "total": total }));
}

fn import_rekordbox_cues_blocking(app: &AppHandle, xml_path: &str) -> Result<ImportResult, String> {
    let tracks = parse_rekordbox_xml(xml_path)?;
    let mut conn = open_db(app)?;
    conn.execute_batch(CUES_SCHEMA_SQL).map_err(|e| e.to_string())?;

    let total = tracks.len();
    let (present, missing): (Vec<_>, Vec<_>) =
        tracks.iter().partition(|t| Path::new(&t.location).is_file());
    let not_found = missing.len();

    // Fingerprinting is the slow part (decode + FFT per track); it runs in
    // parallel with cache reuse, and the cue rows go in as one transaction
    // instead of one implicit transaction — and fsync — per track.
    let locations: Vec<String> = present.iter().map(|t| t.location.clone()).collect();
    let fingerprints = fingerprint_many(&mut conn, &locations, |done, _| {
        emit_progress(app, not_found + done, total)
    });

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let mut matched = 0;
    let mut errors = Vec::new();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for (track, fp) in present.iter().zip(fingerprints) {
        match fp {
            Ok(fp) => {
                let key = fingerprint_key(&fp.fingerprint);
                let mut data = track.cues.clone();
                data.average_bpm = track.average_bpm;
                let data_json = serde_json::to_string(&data).map_err(|e| e.to_string())?;
                tx.execute(
                    "INSERT INTO cues (fingerprint_key, source_path, data, imported_at)
                     VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(fingerprint_key) DO UPDATE SET
                        source_path = excluded.source_path, data = excluded.data, imported_at = excluded.imported_at",
                    params![key, track.location, data_json, now],
                )
                .map_err(|e| e.to_string())?;
                matched += 1;
            }
            Err(e) => errors.push(format!("{}: {e}", track.location)),
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    emit_progress(app, total, total);

    Ok(ImportResult { total_entries: total, matched, not_found_on_disk: not_found, errors })
}

#[tauri::command]
pub async fn import_rekordbox_cues(app: AppHandle, xml_path: String) -> Result<ImportResult, String> {
    tauri::async_runtime::spawn_blocking(move || import_rekordbox_cues_blocking(&app, &xml_path))
        .await
        .map_err(|_| "rekordbox import task panicked".to_string())?
}

fn get_cues_for_path_blocking(app: &AppHandle, path: &str) -> Result<Option<CueData>, String> {
    let conn = open_db(app)?;
    conn.execute_batch(CUES_SCHEMA_SQL).map_err(|e| e.to_string())?;
    let fp = get_or_compute(&conn, path)?;
    let key = fingerprint_key(&fp.fingerprint);
    let data_json: Option<String> = conn
        .query_row("SELECT data FROM cues WHERE fingerprint_key = ?1", params![key], |row| row.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    match data_json {
        Some(json) => serde_json::from_str(&json).map(Some).map_err(|e| e.to_string()),
        None => Ok(None),
    }
}

/// Looks up previously-imported cues for `path` by computing (or reusing
/// the cached) fingerprint and matching on that, not the path itself — so
/// this still finds cues imported under a different filename/location for
/// the same audio.
#[tauri::command]
pub async fn get_cues_for_path(app: AppHandle, path: String) -> Result<Option<CueData>, String> {
    tauri::async_runtime::spawn_blocking(move || get_cues_for_path_blocking(&app, &path))
        .await
        .map_err(|_| "cue lookup task panicked".to_string())?
}

// --- BPM/key into the Library index (v0.15 D0): a separate, path-keyed
// table (not the fingerprint-keyed `cues` one above) because this is read
// back by `library_index.rs` with a plain SQL join against `library_track`,
// where a fingerprint lookup per row would be far too slow to run on every
// `library_tracks()` call.

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RekordboxTagSummary {
    /// Library tracks that now have a matching Rekordbox row.
    pub matched: usize,
    /// Total tracks currently in the Library index.
    pub library_track_count: usize,
    /// `<TRACK>` entries read from the XML.
    pub xml_entries: usize,
}

/// Normalizes a path for the case-insensitive join against `library_track`:
/// Windows paths differ only by case between Rekordbox's export and the
/// app's own `canonicalize`/`WalkDir` reads often enough that an exact match
/// would silently miss real tracks.
///
/// ASCII-only on purpose: the other side of the join is SQLite's `LOWER()`,
/// which folds only A-Z. A Unicode `to_lowercase` here turned "C:\Музыка\..."
/// or "...\Énergie.mp3" into a key `LOWER(path)` can never produce, so every
/// track with a non-ASCII capital in its path silently lost its BPM and key.
fn normalize_path_for_join(path: &str) -> String {
    path.to_ascii_lowercase()
}

/// `rekordbox_track` predates ratings; a database created by an older build
/// lacks the column (CREATE TABLE IF NOT EXISTS leaves it alone).
fn ensure_rating_column(conn: &rusqlite::Connection) -> Result<(), String> {
    let has: bool = conn
        .prepare("SELECT 1 FROM pragma_table_info('rekordbox_track') WHERE name = 'rating'")
        .and_then(|mut s| s.exists([]))
        .map_err(|e| e.to_string())?;
    if !has {
        conn.execute("ALTER TABLE rekordbox_track ADD COLUMN rating INTEGER", [])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// What the last imported rekordbox.xml says about one file.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RekordboxEntry {
    pub path: String,
    pub bpm: Option<f64>,
    pub key: Option<String>,
    /// Stars 0-5; `None` when unrated in Rekordbox.
    pub rating: Option<u8>,
}

fn rekordbox_lookup_blocking(conn: &rusqlite::Connection, paths: &[String]) -> Result<Vec<RekordboxEntry>, String> {
    ensure_rating_column(conn)?;
    let mut stmt = conn
        .prepare_cached("SELECT bpm, key, rating FROM rekordbox_track WHERE path_lower = ?1")
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for p in paths {
        let row = stmt
            .query_row(params![normalize_path_for_join(p)], |r| {
                Ok((
                    r.get::<_, Option<f64>>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<i64>>(2)?,
                ))
            })
            .ok();
        if let Some((bpm, key, rating)) = row {
            out.push(RekordboxEntry {
                path: p.clone(),
                bpm,
                key,
                rating: rating.filter(|r| *r > 0).map(|r| r as u8),
            });
        }
    }
    Ok(out)
}

/// Rekordbox's BPM / key / rating for the given file paths (only those the
/// last imported rekordbox.xml knows about). Read-only; works for any loaded
/// file, not just ones under a Library root.
#[tauri::command]
pub async fn rekordbox_lookup(app: AppHandle, paths: Vec<String>) -> Result<Vec<RekordboxEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = super::library_index::open_db(&app)?;
        rekordbox_lookup_blocking(&conn, &paths)
    })
    .await
    .map_err(|_| "Rekordbox lookup task panicked".to_string())?
}

fn import_rekordbox_library_tags_blocking(
    app: &AppHandle,
    xml_path: &str,
) -> Result<RekordboxTagSummary, String> {
    let tracks = parse_rekordbox_xml(xml_path)?;
    let xml_entries = tracks.len();

    // `open_db` runs the shared schema, which already includes `rekordbox_track`.
    let mut conn = super::library_index::open_db(app)?;
    ensure_rating_column(&conn)?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    // One transaction: the replace is all-or-nothing (a failure half way left
    // the table cleared and half refilled), and thousands of rows commit once
    // instead of once each.
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM rekordbox_track", [])
        .map_err(|e| e.to_string())?;
    {
        let mut insert = tx
            .prepare(
                "INSERT OR REPLACE INTO rekordbox_track (path_lower, bpm, key, rating, imported_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            )
            .map_err(|e| e.to_string())?;
        for t in &tracks {
            if t.location.is_empty()
                || (t.average_bpm.is_none() && t.tonality.is_none() && t.rating.is_none())
            {
                continue;
            }
            insert
                .execute(params![
                    normalize_path_for_join(&t.location),
                    // Rekordbox writes AverageBpm="0.00" for unanalysed tracks.
                    t.average_bpm.filter(|b| *b > 0.0),
                    t.tonality,
                    t.rating.map(|r| r as i64),
                    now
                ])
                .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;

    let library_track_count: usize = conn
        .query_row("SELECT COUNT(*) FROM library_track", [], |r| r.get::<_, i64>(0))
        .unwrap_or(0) as usize;
    let matched: usize = conn
        .query_row(
            "SELECT COUNT(*) FROM library_track lt
             JOIN rekordbox_track rb ON LOWER(lt.path) = rb.path_lower",
            [],
            |r| r.get::<_, i64>(0),
        )
        .unwrap_or(0) as usize;

    Ok(RekordboxTagSummary { matched, library_track_count, xml_entries })
}

/// Reads `AverageBpm`/`Tonality` out of a rekordbox.xml export and stores
/// them keyed by (lowercased) file path, for `library_index.rs` to join
/// against the Library on every read. Read-only against Rekordbox, same as
/// the cue importer above; this only ever writes to our own sqlite file.
#[tauri::command]
pub async fn import_rekordbox_library_tags(
    app: AppHandle,
    xml_path: String,
) -> Result<RekordboxTagSummary, String> {
    tauri::async_runtime::spawn_blocking(move || import_rekordbox_library_tags_blocking(&app, &xml_path))
        .await
        .map_err(|_| "Rekordbox BPM/key import task panicked".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Manual, opt-in smoke test against a real rekordbox.xml — parsing
    /// only, no fingerprinting/sqlite (which need an AppHandle). Confirms
    /// the parser survives a real, full-size export (not just the excerpt
    /// the other test is built from) and reports how many tracks actually
    /// resolve to a file on disk. Run explicitly with:
    ///   MTC_TEST_REKORDBOX_XML="C:\path\to\rekordbox.xml" cargo test --release parse_real_rekordbox_xml -- --ignored --nocapture
    #[test]
    #[ignore]
    fn parse_real_rekordbox_xml() {
        let xml_path = std::env::var("MTC_TEST_REKORDBOX_XML")
            .expect("set MTC_TEST_REKORDBOX_XML to a real rekordbox.xml export");
        let tracks = parse_rekordbox_xml(&xml_path).expect("parsing should succeed");
        println!("Parsed {} track entries", tracks.len());

        let mut found_on_disk = 0;
        let mut with_memory_cues = 0;
        let mut with_hot_cues = 0;
        let mut with_loops = 0;
        let mut with_tempo = 0;
        for t in &tracks {
            if Path::new(&t.location).is_file() {
                found_on_disk += 1;
            } else {
                println!("  not found on disk: {}", t.location);
            }
            if !t.cues.memory_cues.is_empty() {
                with_memory_cues += 1;
            }
            if !t.cues.hot_cues.is_empty() {
                with_hot_cues += 1;
            }
            if !t.cues.loops.is_empty() {
                with_loops += 1;
            }
            if !t.cues.tempo.is_empty() {
                with_tempo += 1;
            }
        }
        println!(
            "found_on_disk={found_on_disk}/{} with_memory_cues={with_memory_cues} \
             with_hot_cues={with_hot_cues} with_loops={with_loops} with_tempo={with_tempo}",
            tracks.len()
        );
        assert!(!tracks.is_empty(), "a real export should have at least one track");
    }

    #[test]
    fn normalize_path_for_join_lowercases_for_a_case_insensitive_match() {
        assert_eq!(normalize_path_for_join(r"C:\Music\Song.flac"), r"c:\music\song.flac");
    }

    /// The stored key must equal what SQLite's `LOWER()` makes of the library
    /// path, or the join in `library_tracks` never matches.
    #[test]
    fn join_key_matches_sqlite_lower_for_non_ascii_paths() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        for path in [r"C:\Музыка\Трек.mp3", r"C:\Music\Énergie Über.flac", r"C:\Music\Plain.mp3"] {
            let sqlite: String =
                conn.query_row("SELECT LOWER(?1)", [path], |r| r.get(0)).unwrap();
            assert_eq!(normalize_path_for_join(path), sqlite, "{path}");
        }
    }

    #[test]
    fn parses_tonality_from_a_track_attribute() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <COLLECTION Entries="1">
    <TRACK TrackID="1" Name="Coming Home" Artist="A-Trak" AverageBpm="123.00" Tonality="8A"
           Location="file://localhost/C:/Users/sopas/Music/Collection/song.flac"/>
  </COLLECTION>
</DJ_PLAYLISTS>"#;
        let dir = std::env::temp_dir().join(format!(
            "mtc-rb-tonality-{:?}",
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let xml_path = dir.join("rekordbox.xml");
        std::fs::write(&xml_path, xml).unwrap();

        let tracks = parse_rekordbox_xml(xml_path.to_str().unwrap()).unwrap();
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0].tonality.as_deref(), Some("8A"));
        assert_eq!(tracks[0].average_bpm, Some(123.0));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(windows)]
    #[test]
    fn location_to_path_decodes_percent_escapes_and_strips_file_uri() {
        assert_eq!(
            location_to_path("file://localhost/C:/Users/x/Music/A-Trak,%20Ferreck%20Dawn.flac"),
            r"C:\Users\x\Music\A-Trak, Ferreck Dawn.flac"
        );
        assert_eq!(location_to_path("file:///C:/Music/a.mp3"), r"C:\Music\a.mp3");
        // A track on a network share keeps its UNC prefix.
        assert_eq!(
            location_to_path("file://localhost//nas/Music/DJ%20Set/a.mp3"),
            r"\\nas\Music\DJ Set\a.mp3"
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn location_to_path_keeps_a_unix_path_absolute() {
        assert_eq!(
            location_to_path("file://localhost/Users/x/Music/A%20B.flac"),
            "/Users/x/Music/A B.flac"
        );
    }

    #[test]
    fn location_to_path_decodes_multibyte_utf8_percent_escapes() {
        // "é" as it appears in a real rekordbox.xml export (Dajaé).
        assert!(location_to_path("file://localhost/Daja%c3%a9.flac").ends_with("Dajaé.flac"));
    }

    #[test]
    fn percent_decode_leaves_a_stray_percent_before_multibyte_text_alone() {
        assert_eq!(percent_decode("100%é mix"), "100%é mix");
        assert_eq!(percent_decode("50%"), "50%");
        assert_eq!(percent_decode("a%2Fb"), "a/b");
    }

    #[test]
    fn parses_a_real_rekordbox_xml_track_with_cues_hot_cues_and_a_loop() {
        // A trimmed excerpt matching the real schema this was built against
        // (a genuine rekordbox 7.2.18 collection export), not a guess.
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="rekordbox" Version="7.2.18" Company="AlphaTheta"/>
  <COLLECTION Entries="1">
    <TRACK TrackID="1" Name="Coming Home" Artist="A-Trak" AverageBpm="123.00"
           Location="file://localhost/C:/Users/sopas/Music/Collection/song.flac">
      <TEMPO Inizio="0.054" Bpm="123.00" Metro="4/4" Battito="1"/>
      <POSITION_MARK Name="AutoGrid" Type="0" Start="0.048" Num="-1"/>
      <POSITION_MARK Name="n.n." Type="0" Start="62.487" Num="0" Red="48" Green="90" Blue="255"/>
      <POSITION_MARK Name="n.n." Type="4" Start="281.024" End="296.634" Num="3" Red="224" Green="100" Blue="27"/>
    </TRACK>
  </COLLECTION>
</DJ_PLAYLISTS>"#;
        let dir = std::env::temp_dir().join(format!(
            "mtc-rb-test-{:?}",
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let xml_path = dir.join("rekordbox.xml");
        std::fs::write(&xml_path, xml).unwrap();

        let tracks = parse_rekordbox_xml(xml_path.to_str().unwrap()).unwrap();
        assert_eq!(tracks.len(), 1);
        let t = &tracks[0];
        assert_eq!(t.location, r"C:\Users\sopas\Music\Collection\song.flac");
        assert_eq!(t.average_bpm, Some(123.0));
        assert_eq!(t.cues.tempo.len(), 1);
        assert_eq!(t.cues.tempo[0].bpm, 123.0);
        assert_eq!(t.cues.memory_cues.len(), 1, "the Num=-1 AutoGrid marker is a memory cue");
        assert_eq!(t.cues.hot_cues.len(), 1, "the Num=0 marker is hot cue pad 0");
        assert_eq!(t.cues.hot_cues[0].pad, Some(0));
        assert_eq!(t.cues.hot_cues[0].color, Some((48, 90, 255)));
        assert_eq!(t.cues.loops.len(), 1, "Type=4 with a Start/End pair is a saved loop");
        assert_eq!(t.cues.loops[0].start_secs, 281.024);
        assert_eq!(t.cues.loops[0].end_secs, 296.634);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn cues_survive_a_sql_round_trip_and_a_path_change_under_the_same_fingerprint() {
        let dir = std::env::temp_dir().join(format!(
            "mtc-rb-sql-test-{:?}",
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let conn = rusqlite::Connection::open(dir.join("cache.sqlite")).unwrap();
        conn.execute_batch(CUES_SCHEMA_SQL).unwrap();

        // A fake fingerprint stands in for a real decoded one — this test is
        // only exercising the SQL/JSON layer, not audio decoding (that's
        // covered by duplicates.rs's own tests, which this module reuses).
        let fingerprint = vec![1u32, 2, 3, 4, 5];
        let key = fingerprint_key(&fingerprint);

        let data = CueData {
            average_bpm: Some(128.0),
            tempo: vec![TempoPoint { position_secs: 0.05, bpm: 128.0, meter: "4/4".into() }],
            memory_cues: vec![CuePoint { position_secs: 10.0, pad: None, name: "".into(), color: None }],
            hot_cues: vec![CuePoint {
                position_secs: 20.0,
                pad: Some(0),
                name: "n.n.".into(),
                color: Some((48, 90, 255)),
            }],
            loops: vec![],
        };
        let data_json = serde_json::to_string(&data).unwrap();
        conn.execute(
            "INSERT INTO cues (fingerprint_key, source_path, data, imported_at) VALUES (?1, ?2, ?3, ?4)",
            params![key, "C:\\old\\path.mp3", data_json, 0i64],
        )
        .unwrap();

        // Look up by fingerprint, as if the file had since been renamed —
        // the whole point of keying on audio content instead of path.
        let found_json: String = conn
            .query_row("SELECT data FROM cues WHERE fingerprint_key = ?1", params![key], |row| row.get(0))
            .unwrap();
        let found: CueData = serde_json::from_str(&found_json).unwrap();
        assert_eq!(found.average_bpm, Some(128.0));
        assert_eq!(found.hot_cues.len(), 1);
        assert_eq!(found.hot_cues[0].pad, Some(0));
        assert_eq!(found.hot_cues[0].color, Some((48, 90, 255)));
        assert_eq!(found.memory_cues.len(), 1);

        // A different fingerprint must not match.
        let other_key = fingerprint_key(&[9u32, 9, 9]);
        let miss: Option<String> = conn
            .query_row("SELECT data FROM cues WHERE fingerprint_key = ?1", params![other_key], |row| row.get(0))
            .optional()
            .unwrap();
        assert!(miss.is_none());

        std::fs::remove_dir_all(&dir).ok();
    }

    /// A folder containing a nested folder and two top-level playlists — the
    /// shape a real Rekordbox collection with any organization actually has.
    const PLAYLIST_TREE_XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="rekordbox" Version="7.2.18" Company="AlphaTheta"/>
  <COLLECTION Entries="3">
    <TRACK TrackID="1" Name="Coming Home" Artist="A-Trak" TotalTime="245"
           Location="file://localhost/C:/Music/song1.flac"/>
    <TRACK TrackID="2" Name="Loom" Artist="Ferreck Dawn" TotalTime="312"
           Location="file://localhost/C:/Music/song2.flac"/>
    <TRACK TrackID="3" Name="No Name Track" TotalTime="0"
           Location="file://localhost/C:/Music/song3.flac"/>
  </COLLECTION>
  <PLAYLISTS>
    <NODE Type="0" Name="ROOT" Count="2">
      <NODE Type="1" Name="Openers" KeyType="0" Entries="2">
        <TRACK Key="1"/>
        <TRACK Key="2"/>
      </NODE>
      <NODE Type="0" Name="Sets" Count="1">
        <NODE Type="1" Name="Friday" KeyType="0" Entries="1">
          <TRACK Key="3"/>
        </NODE>
      </NODE>
    </NODE>
  </PLAYLISTS>
</DJ_PLAYLISTS>"#;

    fn write_temp_xml(contents: &str, tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mtc-rb-{tag}-{:?}",
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let xml_path = dir.join("rekordbox.xml");
        std::fs::write(&xml_path, contents).unwrap();
        xml_path
    }

    #[test]
    fn parses_a_playlist_tree_with_nested_folders() {
        let xml_path = write_temp_xml(PLAYLIST_TREE_XML, "tree");

        let (root, data) = parse_playlist_tree(xml_path.to_str().unwrap()).unwrap();
        assert_eq!(root.name, "ROOT");
        assert!(root.is_folder);
        assert_eq!(root.track_count, 3, "2 in Openers + 1 in Sets/Friday");
        assert_eq!(root.children.len(), 2);

        let openers = &root.children[0];
        assert_eq!(openers.name, "Openers");
        assert!(!openers.is_folder);
        assert_eq!(openers.track_count, 2);

        let sets = &root.children[1];
        assert_eq!(sets.name, "Sets");
        assert!(sets.is_folder);
        assert_eq!(sets.children.len(), 1);
        let friday = &sets.children[0];
        assert_eq!(friday.name, "Friday");
        assert!(!friday.is_folder);
        assert_eq!(friday.track_count, 1);

        // "Openers" sits directly under ROOT, so its folder path is empty;
        // "Friday" sits under ROOT/Sets, so its path is just ["Sets"].
        let (openers_path, _, openers_tracks) = data.get(&openers.id).unwrap();
        assert!(openers_path.is_empty());
        assert_eq!(openers_tracks, &vec![1, 2]);
        let (friday_path, _, friday_tracks) = data.get(&friday.id).unwrap();
        assert_eq!(friday_path, &vec!["Sets".to_string()]);
        assert_eq!(friday_tracks, &vec![3]);

        std::fs::remove_dir_all(xml_path.parent().unwrap()).ok();
    }

    #[test]
    fn rekordbox_ratings_map_to_stars() {
        for (raw, stars) in [(0, None), (51, Some(1)), (102, Some(2)), (153, Some(3)), (204, Some(4)), (255, Some(5)), (200, Some(4)), (999, Some(5)), (-3, None)] {
            assert_eq!(stars_from_rekordbox_rating(raw), stars, "raw {raw}");
        }
    }

    #[test]
    fn parses_rating_bpm_and_key_from_track_attributes() {
        let dir = std::env::temp_dir().join(format!("mtc-rbxml-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let xml = dir.join("rb.xml");
        std::fs::write(
            &xml,
            r#"<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0"><COLLECTION Entries="3">
<TRACK TrackID="1" Name="A" Artist="X" TotalTime="200" AverageBpm="127.99" Tonality="8A" Rating="204" Location="file://localhost/C:/Music/a.mp3"/>
<TRACK TrackID="2" Name="B" Artist="Y" TotalTime="200" AverageBpm="0.00" Rating="0" Location="file://localhost/C:/Music/b.mp3"><TEMPO Inizio="0.0" Bpm="120" Metro="4/4" Battito="1"/></TRACK>
<TRACK TrackID="3" Name="C" Artist="Z" TotalTime="200" Rating="51" Location="file://localhost/C:/Music/c.mp3"/>
</COLLECTION></DJ_PLAYLISTS>"#,
        )
        .unwrap();
        let tracks = parse_rekordbox_xml(xml.to_str().unwrap()).unwrap();
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(tracks.len(), 3);
        assert_eq!((tracks[0].rating, tracks[0].tonality.as_deref()), (Some(4), Some("8A")));
        assert_eq!(tracks[1].rating, None);
        assert_eq!(tracks[2].rating, Some(1));
    }

    #[test]
    fn lookup_adds_the_rating_column_to_an_old_table_and_matches_case_insensitively() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        // The table exactly as v0.15-v0.18 created it: no rating column.
        conn.execute_batch(
            "CREATE TABLE rekordbox_track (path_lower TEXT PRIMARY KEY, bpm REAL, key TEXT, imported_at INTEGER NOT NULL);
             INSERT INTO rekordbox_track VALUES ('c:\\music\\a.mp3', 128.0, '8A', 1);",
        )
        .unwrap();
        ensure_rating_column(&conn).unwrap();
        conn.execute("UPDATE rekordbox_track SET rating = 4", []).unwrap();
        let got = rekordbox_lookup_blocking(&conn, &["C:\\Music\\A.mp3".into(), "C:\\nope.mp3".into()]).unwrap();
        assert_eq!(
            got,
            vec![RekordboxEntry { path: "C:\\Music\\A.mp3".into(), bpm: Some(128.0), key: Some("8A".into()), rating: Some(4) }]
        );
    }

    #[test]
    fn exports_playlists_as_m3u8_mirroring_rekordbox_folders() {
        let xml_path = write_temp_xml(PLAYLIST_TREE_XML, "export");
        let out_dir = xml_path.parent().unwrap().join("out");

        let result = export_playlists_blocking(xml_path.to_str().unwrap(), out_dir.to_str().unwrap(), None).unwrap();
        assert_eq!(result.exported.len(), 2, "one entry per playlist, folders excluded");

        let openers = result.exported.iter().find(|e| e.playlist_name == "Openers").unwrap();
        assert_eq!(std::path::Path::new(&openers.file_path), out_dir.join("Openers.m3u8"));
        assert_eq!(openers.matched, 2);
        let openers_body = std::fs::read_to_string(&openers.file_path).unwrap();
        assert!(openers_body.starts_with("#EXTM3U\n"));
        assert!(openers_body.contains("#EXTINF:245,A-Trak - Coming Home\n"));
        assert!(openers_body.contains(r"C:\Music\song1.flac"));

        let friday = result.exported.iter().find(|e| e.playlist_name == "Friday").unwrap();
        assert_eq!(
            std::path::Path::new(&friday.file_path),
            out_dir.join("Sets").join("Friday.m3u8"),
            "nested Rekordbox folder becomes a nested output folder"
        );
        let friday_body = std::fs::read_to_string(&friday.file_path).unwrap();
        assert!(
            friday_body.contains("#EXTINF:0,No Name Track\n"),
            "a track with no Artist falls back to just the title"
        );

        std::fs::remove_dir_all(xml_path.parent().unwrap()).ok();
    }

    #[test]
    fn export_can_be_scoped_to_selected_playlist_ids() {
        let xml_path = write_temp_xml(PLAYLIST_TREE_XML, "scoped");
        let out_dir = xml_path.parent().unwrap().join("out");

        let (root, _) = parse_playlist_tree(xml_path.to_str().unwrap()).unwrap();
        let openers_id = root.children[0].id.clone();

        let result = export_playlists_blocking(
            xml_path.to_str().unwrap(),
            out_dir.to_str().unwrap(),
            Some(vec![openers_id]),
        )
        .unwrap();
        assert_eq!(result.exported.len(), 1);
        assert_eq!(result.exported[0].playlist_name, "Openers");
        assert!(!out_dir.join("Sets").exists(), "unselected playlist's folder is never created");

        std::fs::remove_dir_all(xml_path.parent().unwrap()).ok();
    }

    #[test]
    fn sanitize_filename_strips_windows_reserved_characters() {
        assert_eq!(sanitize_filename("Friday: Peak Time / Techno"), "Friday_ Peak Time _ Techno");
        assert_eq!(sanitize_filename("   "), "Untitled");
    }
}
