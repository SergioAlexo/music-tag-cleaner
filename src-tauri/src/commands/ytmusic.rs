//! YouTube Music playlist import (v0.9 F4): fetches a playlist's track list
//! via `yt-dlp` (metadata only — nothing is ever downloaded) so the frontend
//! can match it against the loaded collection and export a Rekordbox
//! playlist. yt-dlp is treated as an optional external tool, the same way
//! `components.rs` treats Ollama: detected on PATH or in a per-app bundled
//! location, with a one-click download if it's missing.
//!
//! Empirically validated against real playlists (see `fetch_ytmusic_playlist`
//! doc comment) before writing the matching logic that depends on it:
//! `yt-dlp -J --flat-playlist` returns each entry's `id`, `title` and
//! `duration` in a single fast request (no per-video fetch, so a 100-track
//! playlist costs one HTTP round trip, not a hundred) — but *not* separate
//! artist/track/album fields, even for videos uploaded to an artist's
//! official channel. Those fields exist in yt-dlp's schema and are read here
//! when present (a future yt-dlp version, or a differently-shaped playlist,
//! may populate them), but the matching step this feeds can't assume they
//! will be — it has to work from `title` and `duration` alone.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

/// Generation counter for `enrich_ytmusic_entries` — the owner may fetch a
/// different playlist while one enrichment run is still in flight, and only
/// the newest run is worth continuing. Each run takes the next generation and
/// its workers stop as soon as the counter moves past it (a new run started,
/// or `cancel_ytmusic_enrich` was called).
///
/// It used to be a bool that every new run reset to `false`, which un-cancelled
/// the run it was meant to replace: the old workers kept fetching and emitting
/// into the new playlist's view.
#[derive(Default)]
pub struct EnrichCancelFlag(pub Arc<AtomicU64>);

/// Seconds yt-dlp waits on a silent socket before giving up. Without it a
/// stalled request hangs its worker indefinitely.
const YTDLP_SOCKET_TIMEOUT: &str = "20";

#[cfg(target_os = "windows")]
const YTDLP_EXE: &str = "yt-dlp.exe";
#[cfg(not(target_os = "windows"))]
const YTDLP_EXE: &str = "yt-dlp";

#[cfg(target_os = "windows")]
const YTDLP_ASSET_URL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
#[cfg(target_os = "macos")]
const YTDLP_ASSET_URL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos";
#[cfg(all(unix, not(target_os = "macos")))]
const YTDLP_ASSET_URL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YtDlpInfo {
    pub installed: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    /// True when `version` parses as a `YYYY.MM.DD` release date more than
    /// ~6 months old. YouTube regularly breaks older extractors, and the
    /// owner has hit exactly that ("Precondition check failed" from a
    /// 2024.10.07 copy) — this is a nudge to update, not an error.
    pub stale: bool,
}

/// Days from a proleptic-Gregorian civil date to the Unix epoch (1970-01-01 =
/// day 0). Howard Hinnant's `days_from_civil` — avoids pulling in a date
/// crate just to compare a yt-dlp version string's age.
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let mp = ((m as i64 + 9) % 12) as u64;
    let doy = (153 * mp + 2) / 5 + d as u64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe as i64 - 719468
}

/// Parses a yt-dlp `YYYY.MM.DD` version string and returns true if it is more
/// than ~6 months (183 days) old. Any unparseable version is treated as not
/// stale — this is a nudge, not something worth failing loudly over.
fn version_is_stale(version: &str) -> bool {
    let parts: Vec<&str> = version.split('.').collect();
    let (Some(y), Some(m), Some(d)) = (
        parts.first().and_then(|s| s.parse::<i64>().ok()),
        parts.get(1).and_then(|s| s.parse::<u32>().ok()),
        parts.get(2).and_then(|s| s.parse::<u32>().ok()),
    ) else {
        return false;
    };
    let Ok(now) = SystemTime::now().duration_since(UNIX_EPOCH) else {
        return false;
    };
    let now_days = now.as_secs() as i64 / 86400;
    now_days - days_from_civil(y, m, d) > 183
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistEntry {
    pub index: usize,
    pub video_id: String,
    pub url: String,
    pub title: String,
    pub duration_secs: Option<f64>,
    /// The uploading channel, when yt-dlp includes one for this entry.
    /// Often the artist's name, sometimes suffixed " - Topic" for
    /// auto-generated YouTube Music uploads — stripping that suffix is left
    /// to the matching step, not this fetch.
    pub uploader: Option<String>,
    /// Structured artist metadata (`artist`/`creator`), when yt-dlp's
    /// flat-playlist extractor includes it for this entry. Stronger than
    /// `uploader` — see the field comment on `parse_playlist_json`.
    pub artist: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistFetchResult {
    pub title: String,
    pub entries: Vec<PlaylistEntry>,
}

#[cfg(target_os = "windows")]
fn hide_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}
#[cfg(not(target_os = "windows"))]
fn hide_console(_cmd: &mut Command) {}

fn bundled_ytdlp_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    Some(dir.join("bin").join(YTDLP_EXE))
}

/// Bundled copy first (something we downloaded ourselves and know the
/// version of), then anywhere on `PATH` (a system-wide install, e.g. via pip
/// or a package manager, which the user may already have for other tools).
fn find_ytdlp(app: &AppHandle) -> Option<PathBuf> {
    if let Some(p) = bundled_ytdlp_path(app) {
        if p.exists() {
            return Some(p);
        }
    }
    // Shared with FFmpeg's lookup, which also covers Homebrew on macOS — a
    // `brew install yt-dlp` was invisible to an app launched from the Dock.
    crate::commands::ffmpeg::on_path(YTDLP_EXE)
}

fn ytdlp_version(exe: &PathBuf) -> Option<String> {
    let mut cmd = Command::new(exe);
    cmd.arg("--version");
    hide_console(&mut cmd);
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if v.is_empty() {
        None
    } else {
        Some(v)
    }
}

#[tauri::command]
pub async fn ytdlp_info(app: AppHandle) -> YtDlpInfo {
    tauri::async_runtime::spawn_blocking(move || match find_ytdlp(&app) {
        Some(exe) => {
            let version = ytdlp_version(&exe);
            let stale = version.as_deref().map(version_is_stale).unwrap_or(false);
            YtDlpInfo {
                installed: true,
                version,
                path: Some(exe.to_string_lossy().to_string()),
                stale,
            }
        }
        None => YtDlpInfo { installed: false, version: None, path: None, stale: false },
    })
    .await
    .unwrap_or(YtDlpInfo { installed: false, version: None, path: None, stale: false })
}

fn emit_install_progress(app: &AppHandle, phase: &str, downloaded: u64, total: u64) {
    let _ = app.emit(
        "ytdlp-install-progress",
        serde_json::json!({ "phase": phase, "downloaded": downloaded, "total": total }),
    );
}

/// Downloads yt-dlp's standalone binary release straight from GitHub into
/// the app's own data directory — no installer, no PATH changes, and no
/// interference with a system-wide yt-dlp the user might already have (that
/// one is still preferred by `find_ytdlp` only if it's actually on `PATH`;
/// this bundled copy is the fallback either way covers).
#[tauri::command]
pub async fn install_ytdlp(app: AppHandle) -> Result<(), String> {
    let dest = bundled_ytdlp_path(&app).ok_or_else(|| "Could not resolve the app data directory".to_string())?;
    let dir = dest
        .parent()
        .ok_or_else(|| "Could not resolve the app data directory".to_string())?
        .to_path_buf();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let client = crate::commands::download::client()?;
    let downloaded = crate::commands::download::download_to_file(
        &client,
        YTDLP_ASSET_URL,
        &dest,
        |done, total| emit_install_progress(&app, "downloading", done, total),
    )
    .await?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&dest).map_err(|e| e.to_string())?.permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&dest, perms).map_err(|e| e.to_string())?;
    }

    emit_install_progress(&app, "done", downloaded, downloaded);
    Ok(())
}

/// Parses `yt-dlp -J --flat-playlist`'s output. Shared with tests so the
/// parsing logic can be checked against fixture JSON without running the
/// real binary.
///
/// Handles the shapes actually seen from real playlists: a `null` entry for
/// a removed/private video (skipped, not an error), an entry missing `id`
/// (skipped — nothing to match or link to), and a single-video URL where
/// yt-dlp returns one object with no `entries` wrapper at all (treated as a
/// one-track "playlist").
fn parse_playlist_json(raw: &str) -> Result<PlaylistFetchResult, String> {
    let v: Value = serde_json::from_str(raw).map_err(|e| format!("Could not parse yt-dlp output: {e}"))?;
    let title = v["title"].as_str().unwrap_or("YouTube Music Playlist").to_string();
    let raw_entries: Vec<Value> = match v.get("entries").and_then(Value::as_array) {
        Some(arr) => arr.clone(),
        None => vec![v.clone()],
    };

    let mut entries = Vec::with_capacity(raw_entries.len());
    for e in raw_entries.iter() {
        if e.is_null() {
            continue;
        }
        let Some(video_id) = e["id"].as_str().filter(|s| !s.is_empty()) else {
            continue;
        };
        let title = e["title"].as_str().unwrap_or("Unknown title").to_string();
        let uploader = e["uploader"]
            .as_str()
            .or_else(|| e["channel"].as_str())
            .map(String::from);
        // Real per-track metadata, when yt-dlp's flat-playlist extractor
        // happens to include it (music-typed uploads sometimes carry MP4/ID3
        // style `artist`/`creator` fields alongside `title`). This is a much
        // stronger signal than `uploader`/`channel`, which is the *uploading
        // channel* — often the artist, but also often a label, a compilation
        // channel, or "Various Artists". Kept separate from `uploader` so the
        // matching/display layer can tell a confirmed artist from a guess.
        let artist = e["artist"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .or_else(|| e["creator"].as_str().filter(|s| !s.trim().is_empty()))
            .map(String::from);
        entries.push(PlaylistEntry {
            index: entries.len(),
            url: format!("https://music.youtube.com/watch?v={video_id}"),
            video_id: video_id.to_string(),
            title,
            duration_secs: e["duration"].as_f64(),
            uploader,
            artist,
        });
    }
    Ok(PlaylistFetchResult { title, entries })
}

/// Real per-video YouTube Music metadata, from a *full* (non-flat)
/// `yt-dlp -j` extraction of a single watch URL. Unlike `PlaylistEntry` (from
/// `--flat-playlist`, one HTTP round trip for the whole playlist but no real
/// artist/album), this costs one yt-dlp process per video (~3-4s) but returns
/// exactly what YouTube Music's own UI shows — confirmed empirically against
/// `music.youtube.com/watch?v=…` before this was written (see
/// PLAN-v0.14-yt-import.md). Never guessed from the title or channel name.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryMeta {
    pub video_id: String,
    /// "track" when yt-dlp gives one (YouTube Music's clean track name),
    /// else "title" (the video title, which is usually the same thing).
    pub title: Option<String>,
    /// The "artists" array when present. `artists[0]` is the credited
    /// artist; anyone else is a feature, already named in the title.
    pub artists: Vec<String>,
    pub album: Option<String>,
    pub year: Option<i32>,
    /// The uploading channel/uploader, " - Topic" stripped. Never used as an
    /// artist by the matcher — display-only context.
    pub channel: Option<String>,
    pub duration_secs: Option<f64>,
    /// Set on failure (network error, private/removed video, yt-dlp error).
    /// `title`/`artists`/etc. are left empty rather than guessed.
    pub error: Option<String>,
}

/// Strips the trailing " - Topic" YouTube appends to auto-generated-audio
/// upload channel names. Mirrors `stripTopicSuffix` in `src/lib/ytMatch.ts`.
fn strip_topic_suffix(name: &str) -> String {
    const SUFFIX: &str = "- topic";
    let trimmed = name.trim();
    // Compared on the original string: byte offsets found in a lowercased copy
    // don't line up once lowercasing changes a character's length ("İ"), and
    // slicing with one cut the name wrong or panicked mid-character.
    match trimmed.len().checked_sub(SUFFIX.len()).and_then(|at| Some((at, trimmed.get(at..)?))) {
        Some((at, tail)) if tail.eq_ignore_ascii_case(SUFFIX) => trimmed[..at].trim_end().to_string(),
        _ => trimmed.to_string(),
    }
}

/// Parses one `yt-dlp -j --skip-download` video result into `EntryMeta`.
/// Pure and fixture-tested (no network) — see the tests module.
fn parse_video_json(raw: &str, video_id: &str) -> EntryMeta {
    let v: Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(e) => {
            return EntryMeta {
                video_id: video_id.to_string(),
                error: Some(format!("Could not parse yt-dlp output: {e}")),
                ..Default::default()
            };
        }
    };

    let title = v["track"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| v["title"].as_str())
        .map(String::from);

    let artists: Vec<String> = v["artists"]
        .as_array()
        .map(|arr| arr.iter().filter_map(Value::as_str).map(String::from).collect::<Vec<_>>())
        .filter(|a| !a.is_empty())
        .unwrap_or_else(|| {
            // Fallback only when the array is absent — split the flat
            // "artist" string on ", " (yt-dlp's own separator for it).
            v["artist"]
                .as_str()
                .map(|s| {
                    s.split(',')
                        .map(|p| p.trim().to_string())
                        .filter(|p| !p.is_empty())
                        .collect()
                })
                .unwrap_or_default()
        });

    let album = v["album"].as_str().filter(|s| !s.trim().is_empty()).map(String::from);

    let year = v["release_year"].as_i64().map(|y| y as i32).or_else(|| {
        v["release_date"]
            .as_str()
            .or_else(|| v["upload_date"].as_str())
            .and_then(|s| s.get(0..4))
            .and_then(|y| y.parse::<i32>().ok())
    });

    let channel = v["channel"]
        .as_str()
        .or_else(|| v["uploader"].as_str())
        .filter(|s| !s.trim().is_empty())
        .map(strip_topic_suffix);

    let duration_secs = v["duration"].as_f64();

    EntryMeta { video_id: video_id.to_string(), title, artists, album, year, channel, duration_secs, error: None }
}

fn fetch_one_video_meta(exe: &PathBuf, video_id: &str) -> EntryMeta {
    let url = format!("https://music.youtube.com/watch?v={video_id}");
    let mut cmd = Command::new(exe);
    cmd.args([
        "-j",
        "--skip-download",
        "--no-warnings",
        "--no-playlist",
        "--socket-timeout",
        YTDLP_SOCKET_TIMEOUT,
        &url,
    ]);
    hide_console(&mut cmd);
    let output = match cmd.output() {
        Ok(o) => o,
        Err(e) => {
            return EntryMeta {
                video_id: video_id.to_string(),
                error: Some(format!("Could not run yt-dlp: {e}")),
                ..Default::default()
            };
        }
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let msg = stderr
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("yt-dlp failed")
            .trim()
            .to_string();
        return EntryMeta { video_id: video_id.to_string(), error: Some(msg), ..Default::default() };
    }
    let raw = String::from_utf8_lossy(&output.stdout);
    parse_video_json(&raw, video_id)
}

fn read_cached_meta(conn: &Connection, video_id: &str) -> Option<EntryMeta> {
    conn.query_row(
        "SELECT json FROM yt_entry_meta WHERE video_id = ?1",
        rusqlite::params![video_id],
        |r| r.get::<_, String>(0),
    )
    .ok()
    .and_then(|j| serde_json::from_str(&j).ok())
}

fn cache_meta(conn: &Connection, meta: &EntryMeta) -> Result<(), String> {
    let json = serde_json::to_string(meta).map_err(|e| e.to_string())?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    conn.execute(
        "INSERT OR REPLACE INTO yt_entry_meta (video_id, json, fetched_at) VALUES (?1, ?2, ?3)",
        rusqlite::params![meta.video_id, json, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Cached metadata for the given ids, with no network call — lets a restored
/// session paint instantly while `enrich_ytmusic_entries` fills in the rest.
#[tauri::command]
pub async fn cached_ytmusic_meta(app: AppHandle, video_ids: Vec<String>) -> Result<Vec<EntryMeta>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = crate::commands::library_index::open_db(&app)?;
        Ok(video_ids.iter().filter_map(|id| read_cached_meta(&conn, id)).collect())
    })
    .await
    .map_err(|_| "Cache lookup task panicked".to_string())?
}

/// Fetches real per-video metadata for each id (full `yt-dlp -j`, not the
/// flat-playlist extraction), 4 at a time so a big playlist doesn't run
/// yt-dlp processes one after another. Cache hits are emitted immediately and
/// never re-fetched; only misses touch the network. Each result is emitted as
/// it finishes on `ytmusic-entry-meta`, plus a running `{done, total}` on
/// `ytmusic-enrich-progress`, so the frontend paints incrementally instead of
/// waiting for the whole playlist.
#[tauri::command]
pub async fn enrich_ytmusic_entries(
    app: AppHandle,
    cancel: tauri::State<'_, EnrichCancelFlag>,
    video_ids: Vec<String>,
) -> Result<(), String> {
    let generation = Arc::clone(&cancel.0);
    let run = generation.fetch_add(1, Ordering::SeqCst) + 1;
    let superseded = move || generation.load(Ordering::SeqCst) != run;

    let to_fetch = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || -> Result<Vec<String>, String> {
            let conn = crate::commands::library_index::open_db(&app)?;
            let mut misses = Vec::new();
            for id in &video_ids {
                match read_cached_meta(&conn, id) {
                    Some(meta) => {
                        let _ = app.emit("ytmusic-entry-meta", &meta);
                    }
                    None => misses.push(id.clone()),
                }
            }
            Ok(misses)
        }
    })
    .await
    .map_err(|_| "Cache lookup task panicked".to_string())??;

    let total = to_fetch.len();
    if total == 0 || superseded() {
        return Ok(());
    }

    let exe = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || find_ytdlp(&app)
    })
    .await
    .map_err(|_| "yt-dlp lookup task panicked".to_string())?
    .ok_or_else(|| "yt-dlp is not installed — install it from Settings first".to_string())?;

    let done = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let queue = Arc::new(StdMutex::new(VecDeque::from(to_fetch)));

    tauri::async_runtime::spawn_blocking(move || {
        std::thread::scope(|scope| {
            for _ in 0..4 {
                let queue = Arc::clone(&queue);
                let done = Arc::clone(&done);
                let superseded = superseded.clone();
                let app = app.clone();
                let exe = exe.clone();
                scope.spawn(move || {
                    // One connection per worker, not one per video.
                    let conn = crate::commands::library_index::open_db(&app).ok();
                    loop {
                        if superseded() {
                            break;
                        }
                        let id = queue.lock().unwrap_or_else(|e| e.into_inner()).pop_front();
                        let Some(id) = id else { break };
                        let meta = fetch_one_video_meta(&exe, &id);
                        if meta.error.is_none() {
                            if let Some(conn) = conn.as_ref() {
                                let _ = cache_meta(conn, &meta);
                            }
                        }
                        // A run replaced while this video was in flight must
                        // not paint its result into the newer playlist's view.
                        if superseded() {
                            break;
                        }
                        let _ = app.emit("ytmusic-entry-meta", &meta);
                        let n = done.fetch_add(1, Ordering::SeqCst) + 1;
                        let _ = app.emit(
                            "ytmusic-enrich-progress",
                            serde_json::json!({ "done": n, "total": total }),
                        );
                    }
                });
            }
        });
    })
    .await
    .map_err(|_| "Enrichment task panicked".to_string())?;

    Ok(())
}

/// The owner may fetch a different playlist while one enrichment run is
/// still in flight — this stops the workers between videos rather than
/// letting a stale run keep emitting into the new one.
#[tauri::command]
pub fn cancel_ytmusic_enrich(cancel: tauri::State<'_, EnrichCancelFlag>) {
    cancel.0.fetch_add(1, Ordering::SeqCst);
}

/// Fetches a playlist's track list — title, duration, video id — via one
/// `yt-dlp -J --flat-playlist` call (no per-video requests, no downloading).
/// Works for both `music.youtube.com/playlist?list=…` and plain
/// `youtube.com/playlist?list=…` URLs: both route through yt-dlp's same
/// `youtube:tab` extractor, confirmed by fetching the same playlist ID
/// through each domain during development and diffing the results.
#[tauri::command]
pub async fn fetch_ytmusic_playlist(app: AppHandle, url: String) -> Result<PlaylistFetchResult, String> {
    let exe = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || find_ytdlp(&app)
    })
    .await
    .map_err(|_| "yt-dlp lookup task panicked".to_string())?
    .ok_or_else(|| "yt-dlp is not installed — install it from Settings first".to_string())?;

    let output = tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new(&exe);
        cmd.args([
            "-J",
            "--flat-playlist",
            "--no-warnings",
            "--ignore-errors",
            "--socket-timeout",
            YTDLP_SOCKET_TIMEOUT,
            &url,
        ]);
        hide_console(&mut cmd);
        cmd.output()
    })
    .await
    .map_err(|_| "yt-dlp task panicked".to_string())?
    .map_err(|e| format!("Could not run yt-dlp: {e}"))?;

    // With `--ignore-errors` yt-dlp still exits non-zero when any entry failed
    // (one removed or region-locked video), yet prints the playlist it did
    // read. That is worth keeping: only a run with nothing usable on stdout is
    // an error.
    let raw = String::from_utf8_lossy(&output.stdout).to_string();
    let parsed = parse_playlist_json(&raw).ok().filter(|r| !r.entries.is_empty());
    if !output.status.success() && parsed.is_none() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let msg = stderr
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("yt-dlp failed")
            .trim()
            .to_string();
        return Err(format!("yt-dlp error: {msg}"));
    }
    let result = match parsed {
        Some(r) => r,
        None => parse_playlist_json(&raw)?,
    };
    if result.entries.is_empty() {
        return Err("No tracks found in that playlist — is it public?".to_string());
    }
    Ok(result)
}

/// A saved import session: the fetched playlist plus every decision made
/// about it.
///
/// The point is resumability. A playlist is rarely matched in one sitting —
/// you match what you own, go and buy the rest, come back a week later and
/// re-fetch. Without this, that second pass starts from zero and every
/// confirmation and denial from the first pass is lost, which is worse than
/// useless: the matcher will happily re-propose exactly the matches you
/// already rejected.
///
/// Decisions are keyed by video id inside `payload`, so they survive the
/// playlist gaining, losing or reordering tracks, and they survive the
/// library growing — which is the case that matters, since the whole reason
/// to come back is that you now own more of it.
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSession {
    pub key: String,
    pub title: String,
    pub url: String,
    pub saved_at: i64,
    /// Opaque JSON owned by the frontend (entries + overrides + denials).
    /// Kept opaque on purpose: the shape of a decision is a UI concern, and
    /// versioning it here would mean a migration every time the UI grows a
    /// new kind of decision.
    pub payload: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSessionSummary {
    pub key: String,
    pub title: String,
    pub url: String,
    pub saved_at: i64,
}

#[tauri::command]
pub async fn save_import_session(
    app: AppHandle,
    key: String,
    title: String,
    url: String,
    payload: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = crate::commands::library_index::open_db(&app)?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        conn.execute(
            "INSERT OR REPLACE INTO import_session (key, title, url, saved_at, payload)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![key, title, url, now, payload],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|_| "Saving the import session failed unexpectedly".to_string())?
}

#[tauri::command]
pub async fn load_import_session(app: AppHandle, key: String) -> Result<Option<ImportSession>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = crate::commands::library_index::open_db(&app)?;
        let found = conn
            .query_row(
                "SELECT key, title, url, saved_at, payload FROM import_session WHERE key = ?1",
                rusqlite::params![key],
                |r| {
                    Ok(ImportSession {
                        key: r.get(0)?,
                        title: r.get(1)?,
                        url: r.get(2)?,
                        saved_at: r.get(3)?,
                        payload: r.get(4)?,
                    })
                },
            )
            .ok();
        Ok(found)
    })
    .await
    .map_err(|_| "Loading the import session failed unexpectedly".to_string())?
}

#[tauri::command]
pub async fn list_import_sessions(app: AppHandle) -> Result<Vec<ImportSessionSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = crate::commands::library_index::open_db(&app)?;
        let mut stmt = conn
            .prepare("SELECT key, title, url, saved_at FROM import_session ORDER BY saved_at DESC")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(ImportSessionSummary {
                    key: r.get(0)?,
                    title: r.get(1)?,
                    url: r.get(2)?,
                    saved_at: r.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();
        Ok(rows)
    })
    .await
    .map_err(|_| "Listing import sessions failed unexpectedly".to_string())?
}

#[tauri::command]
pub async fn delete_import_session(app: AppHandle, key: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = crate::commands::library_index::open_db(&app)?;
        conn.execute("DELETE FROM import_session WHERE key = ?1", rusqlite::params![key])
            .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|_| "Deleting the import session failed unexpectedly".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_flat_playlist_with_entries_wrapper() {
        let raw = r#"{
            "title": "Uploads from Rick Astley",
            "entries": [
                {"id": "ihRdK3x3cUY", "title": "A message from Rick", "duration": 24, "_type": "url"},
                {"id": "JjI4o2w6D5A", "title": "Cologne thanks", "duration": 21, "_type": "url"}
            ]
        }"#;
        let result = parse_playlist_json(raw).unwrap();
        assert_eq!(result.title, "Uploads from Rick Astley");
        assert_eq!(result.entries.len(), 2);
        assert_eq!(result.entries[0].video_id, "ihRdK3x3cUY");
        assert_eq!(result.entries[0].duration_secs, Some(24.0));
        assert_eq!(result.entries[0].index, 0);
        assert_eq!(result.entries[1].index, 1);
        assert_eq!(
            result.entries[0].url,
            "https://music.youtube.com/watch?v=ihRdK3x3cUY"
        );
    }

    #[test]
    fn skips_null_entries_for_removed_or_private_videos() {
        let raw = r#"{
            "title": "Mixed availability",
            "entries": [
                {"id": "abc123", "title": "Still up", "duration": 200},
                null,
                {"id": "def456", "title": "Also up", "duration": 180}
            ]
        }"#;
        let result = parse_playlist_json(raw).unwrap();
        assert_eq!(result.entries.len(), 2);
        assert_eq!(result.entries[0].video_id, "abc123");
        assert_eq!(result.entries[1].video_id, "def456");
        // Re-indexed after skipping, not the original array position.
        assert_eq!(result.entries[1].index, 1);
    }

    #[test]
    fn skips_entries_missing_an_id() {
        let raw = r#"{"title": "x", "entries": [{"title": "no id here"}, {"id": "ok1", "title": "fine"}]}"#;
        let result = parse_playlist_json(raw).unwrap();
        assert_eq!(result.entries.len(), 1);
        assert_eq!(result.entries[0].video_id, "ok1");
    }

    #[test]
    fn falls_back_to_channel_when_uploader_is_absent() {
        let raw = r#"{"title": "x", "entries": [{"id": "v1", "title": "t", "channel": "Some Artist - Topic"}]}"#;
        let result = parse_playlist_json(raw).unwrap();
        assert_eq!(result.entries[0].uploader.as_deref(), Some("Some Artist - Topic"));
    }

    #[test]
    fn reads_structured_artist_metadata_when_present() {
        let raw = r#"{"title": "x", "entries": [
            {"id": "v1", "title": "t", "artist": "Real Artist", "channel": "Some Label Channel"}
        ]}"#;
        let result = parse_playlist_json(raw).unwrap();
        assert_eq!(result.entries[0].artist.as_deref(), Some("Real Artist"));
        assert_eq!(result.entries[0].uploader.as_deref(), Some("Some Label Channel"));
    }

    #[test]
    fn falls_back_to_creator_when_artist_is_absent() {
        let raw = r#"{"title": "x", "entries": [{"id": "v1", "title": "t", "creator": "Creator Name"}]}"#;
        let result = parse_playlist_json(raw).unwrap();
        assert_eq!(result.entries[0].artist.as_deref(), Some("Creator Name"));
    }

    #[test]
    fn parse_video_json_reads_full_metadata_when_the_artists_array_is_present() {
        let raw = r#"{
            "track": "Low (feat. T-Pain)", "title": "Low (feat. T-Pain)",
            "artists": ["Flo Rida", "T-Pain"], "album": "Mail on Sunday",
            "release_year": 2007, "channel": "Flo Rida", "duration": 200.5
        }"#;
        let meta = parse_video_json(raw, "uUL8a7eJCk8");
        assert_eq!(meta.video_id, "uUL8a7eJCk8");
        assert_eq!(meta.title.as_deref(), Some("Low (feat. T-Pain)"));
        assert_eq!(meta.artists, vec!["Flo Rida".to_string(), "T-Pain".to_string()]);
        assert_eq!(meta.album.as_deref(), Some("Mail on Sunday"));
        assert_eq!(meta.year, Some(2007));
        assert_eq!(meta.channel.as_deref(), Some("Flo Rida"));
        assert_eq!(meta.duration_secs, Some(200.5));
        assert!(meta.error.is_none());
    }

    #[test]
    fn parse_video_json_splits_a_flat_artist_string_only_when_the_array_is_absent() {
        let raw = r#"{"title": "Low", "artist": "Flo Rida, T-Pain"}"#;
        let meta = parse_video_json(raw, "v1");
        assert_eq!(meta.artists, vec!["Flo Rida".to_string(), "T-Pain".to_string()]);
    }

    #[test]
    fn parse_video_json_strips_the_topic_suffix_from_an_uploader_only_channel() {
        let raw = r#"{"title": "Gravity", "uploader": "Boris Brejcha - Topic"}"#;
        let meta = parse_video_json(raw, "v1");
        assert_eq!(meta.channel.as_deref(), Some("Boris Brejcha"));
        assert!(meta.artists.is_empty());
    }

    /// Lowercasing "İ" adds a byte, which shifted the offset found in the
    /// lowercased copy: the old code returned "İstanbul -" here, and could
    /// panic when the shifted offset fell inside a character.
    #[test]
    fn the_topic_suffix_comes_off_names_with_any_characters() {
        assert_eq!(strip_topic_suffix("İstanbul - Topic"), "İstanbul");
        assert_eq!(strip_topic_suffix("Mød - TOPIC "), "Mød");
        assert_eq!(strip_topic_suffix("Земфира - Topic"), "Земфира");
        assert_eq!(strip_topic_suffix("Topic"), "Topic");
        assert_eq!(strip_topic_suffix("- topic"), "");
        assert_eq!(strip_topic_suffix("Grupo Topicão"), "Grupo Topicão");
    }

    #[test]
    fn parse_video_json_falls_back_to_the_first_four_chars_of_upload_date_for_year() {
        let raw = r#"{"title": "x", "upload_date": "20190815"}"#;
        let meta = parse_video_json(raw, "v1");
        assert_eq!(meta.year, Some(2019));
    }

    #[test]
    fn parse_video_json_with_nothing_at_all_still_has_a_title_and_no_error() {
        let raw = r#"{"title": "Bare Title"}"#;
        let meta = parse_video_json(raw, "v1");
        assert_eq!(meta.title.as_deref(), Some("Bare Title"));
        assert!(meta.artists.is_empty());
        assert!(meta.album.is_none());
        assert!(meta.year.is_none());
        assert!(meta.channel.is_none());
        assert!(meta.error.is_none());
    }

    #[test]
    fn parse_video_json_reports_the_error_on_malformed_json() {
        let meta = parse_video_json("not json", "v1");
        assert!(meta.error.is_some());
        assert!(meta.title.is_none());
    }

    #[test]
    fn version_is_stale_flags_anything_older_than_six_months() {
        assert!(version_is_stale("2024.10.07"));
        assert!(!version_is_stale("garbage"));
    }

    #[test]
    fn leaves_artist_none_when_yt_dlp_gives_only_a_channel() {
        let raw = r#"{"title": "x", "entries": [{"id": "v1", "title": "t", "channel": "Some Channel"}]}"#;
        let result = parse_playlist_json(raw).unwrap();
        assert_eq!(result.entries[0].artist, None);
    }

    #[test]
    fn a_single_video_url_with_no_entries_wrapper_becomes_a_one_track_playlist() {
        let raw = r#"{"id": "solo1", "title": "Just one video", "duration": 213}"#;
        let result = parse_playlist_json(raw).unwrap();
        assert_eq!(result.entries.len(), 1);
        assert_eq!(result.entries[0].video_id, "solo1");
    }

    #[test]
    fn an_entirely_empty_playlist_parses_to_zero_entries_rather_than_erroring() {
        let raw = r#"{"title": "Empty", "entries": []}"#;
        let result = parse_playlist_json(raw).unwrap();
        assert_eq!(result.entries.len(), 0);
    }

    /// Runs the real `yt-dlp -J --flat-playlist` call this module relies on
    /// against a real, stable public playlist (a channel's own uploads
    /// list, which every channel has and which doesn't disappear the way a
    /// curated/auto-generated mix can) and feeds the output through
    /// `parse_playlist_json` — the same fixture-shaped assumptions the unit
    /// tests above check, but against what YouTube actually returns today.
    /// `MTC_TEST_PLAYLIST_URL` overrides the URL. Requires yt-dlp on `PATH`
    /// and network access, hence `#[ignore]`.
    #[test]
    #[ignore]
    fn real_playlist_fetch_smoke_test() {
        let url = std::env::var("MTC_TEST_PLAYLIST_URL")
            .unwrap_or_else(|_| "https://music.youtube.com/playlist?list=UUuAXFkgsw1L7xaCfnd5JJOw".to_string());
        let exe = std::env::var("PATH")
            .ok()
            .and_then(|path_var| std::env::split_paths(&path_var).map(|d| d.join(YTDLP_EXE)).find(|p| p.exists()))
            .expect("yt-dlp not found on PATH — install it to run this test");

        let mut cmd = Command::new(&exe);
        cmd.args(["-J", "--flat-playlist", "--no-warnings", "--ignore-errors", "--playlist-end", "5", &url]);
        hide_console(&mut cmd);
        let output = cmd.output().expect("failed to run yt-dlp");
        assert!(output.status.success(), "yt-dlp failed: {}", String::from_utf8_lossy(&output.stderr));

        let raw = String::from_utf8_lossy(&output.stdout);
        let result = parse_playlist_json(&raw).expect("parse_playlist_json failed on real yt-dlp output");
        println!("Playlist: {} — {} entries", result.title, result.entries.len());
        for e in &result.entries {
            println!("  [{}] {} — uploader={:?} duration={:?}s", e.video_id, e.title, e.uploader, e.duration_secs);
        }
        assert!(!result.entries.is_empty(), "expected at least one entry from a real playlist");
        assert!(result.entries.iter().all(|e| !e.video_id.is_empty()));
    }
}
