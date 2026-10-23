//! Artwork: fetch proper cover art (MusicBrainz / Cover Art Archive, then
//! iTunes, then Deezer) and find junk art (DJ-pool logos, placeholders) by
//! perceptual hash.
//!
//! Everything persistent lives in `artwork.sqlite`, a file this module owns —
//! HTTP cache, per-file image hashes and the junk-art blocklist — so none of it
//! touches the library index schema.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::files::{apply_cover_bytes, par_map};
use crate::models::ArtworkChange;

const USER_AGENT: &str = concat!(
    "VatraWave/",
    env!("CARGO_PKG_VERSION"),
    " ( https://github.com/sergioalexo/music-tag-cleaner )"
);
/// MusicBrainz asks for at most one request per second per client.
const MB_INTERVAL: Duration = Duration::from_millis(1100);
const CACHE_TTL_SECS: i64 = 30 * 24 * 3600;
/// Hamming distance (of 64) under which two covers count as the same image.
/// Re-encoding the same picture as JPEG moves a dHash by 0-3 bits.
pub const SAME_IMAGE_DISTANCE: u32 = 6;
/// A cluster is junk-art material when this many tracks by this many
/// different artists carry what is, visually, one picture.
const MIN_CLUSTER_TRACKS: usize = 3;
const MIN_CLUSTER_ARTISTS: usize = 3;
/// Suspicion at or above which a lone cover is flagged.
const SUSPICIOUS_THRESHOLD: f32 = 0.7;

// ---------------------------------------------------------------- storage

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("artwork.sqlite"))
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS http_cache (
    key TEXT PRIMARY KEY,
    body BLOB NOT NULL,
    fetched_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS art_hash (
    path TEXT PRIMARY KEY,
    mtime INTEGER NOT NULL,
    size INTEGER NOT NULL,
    hash INTEGER NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    suspicion REAL NOT NULL,
    reasons TEXT NOT NULL,
    artist TEXT NOT NULL,
    album TEXT NOT NULL,
    title TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS junk_blocklist (
    hash INTEGER PRIMARY KEY,
    label TEXT NOT NULL,
    added_at INTEGER NOT NULL
);
";

fn open_store(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    let _ = conn.pragma_update(None, "journal_mode", "WAL");
    let _ = conn.pragma_update(None, "synchronous", "NORMAL");
    let _ = conn.busy_timeout(Duration::from_secs(10));
    conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
    // Expired responses are never read again (`cache_get` filters them), so
    // they only took up space: drop them the first time the store is opened
    // in a session.
    static PRUNED: std::sync::Once = std::sync::Once::new();
    PRUNED.call_once(|| {
        let _ = conn.execute(
            "DELETE FROM http_cache WHERE fetched_at <= ?1",
            params![now_secs() - CACHE_TTL_SECS],
        );
    });
    Ok(conn)
}

fn now_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// Cached body for `key`, if fresh. An empty body is a remembered "not found".
fn cache_get(store: &Path, key: &str) -> Option<Vec<u8>> {
    let conn = open_store(store).ok()?;
    conn.query_row(
        "SELECT body FROM http_cache WHERE key = ?1 AND fetched_at > ?2",
        params![key, now_secs() - CACHE_TTL_SECS],
        |r| r.get::<_, Vec<u8>>(0),
    )
    .ok()
}

fn cache_put(store: &Path, key: &str, body: &[u8]) {
    if let Ok(conn) = open_store(store) {
        let _ = conn.execute(
            "INSERT OR REPLACE INTO http_cache (key, body, fetched_at) VALUES (?1, ?2, ?3)",
            params![key, body, now_secs()],
        );
    }
}

// ----------------------------------------------------------- rate limiter

/// Hands out time slots at least `interval` apart. Pure so the pacing can be
/// tested without sleeping: returns how long the caller must wait from `now`.
pub struct RateLimiter {
    interval: Duration,
    next_free: Option<Instant>,
}

impl RateLimiter {
    pub const fn new(interval: Duration) -> Self {
        Self { interval, next_free: None }
    }

    pub fn reserve(&mut self, now: Instant) -> Duration {
        let start = match self.next_free {
            Some(t) if t > now => t,
            _ => now,
        };
        self.next_free = Some(start + self.interval);
        start - now
    }
}

static MB_LIMITER: Mutex<RateLimiter> = Mutex::new(RateLimiter::new(MB_INTERVAL));

async fn mb_throttle() {
    let wait = MB_LIMITER.lock().map(|mut l| l.reserve(Instant::now())).unwrap_or_default();
    if !wait.is_zero() {
        tokio::time::sleep(wait).await;
    }
}

// ------------------------------------------------------------------- http

fn client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(c) = CLIENT.get() {
        return Ok(c);
    }
    let c = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    Ok(CLIENT.get_or_init(|| c))
}

/// GET returning the body, `Ok(None)` on 404. Cached in sqlite (404s too).
async fn fetch_cached(store: &Path, url: &str, rate_limited: bool) -> Result<Option<Vec<u8>>, String> {
    if let Some(body) = cache_get(store, url) {
        return Ok(if body.is_empty() { None } else { Some(body) });
    }
    if rate_limited {
        mb_throttle().await;
    }
    let fetched = fetch(url).await?;
    cache_put(store, url, fetched.as_deref().unwrap_or(&[]));
    Ok(fetched)
}

/// GET returning the body, `Ok(None)` on 404, never cached.
async fn fetch(url: &str) -> Result<Option<Vec<u8>>, String> {
    let resp = client()?.get(url).send().await.map_err(|e| format!("Network error: {e}"))?;
    if resp.status().as_u16() == 404 {
        return Ok(None);
    }
    if !resp.status().is_success() {
        return Err(format!("{} answered HTTP {}", host_of(url), resp.status()));
    }
    Ok(Some(resp.bytes().await.map_err(|e| format!("Network error: {e}"))?.to_vec()))
}

fn host_of(url: &str) -> &str {
    url.split("//").nth(1).and_then(|r| r.split('/').next()).unwrap_or(url)
}

fn data_url(bytes: &[u8]) -> String {
    let mime = match image::guess_format(bytes) {
        Ok(image::ImageFormat::Png) => "image/png",
        Ok(image::ImageFormat::Gif) => "image/gif",
        Ok(image::ImageFormat::WebP) => "image/webp",
        _ => "image/jpeg",
    };
    format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))
}

// -------------------------------------------------------------- candidates

/// One possible cover. Ranking happens in `artworkMatch.ts`; this carries the
/// facts it needs (what the source thinks the track and release are).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub source: &'static str,
    pub id: String,
    pub release: String,
    pub release_artist: String,
    pub track_title: String,
    pub track_artist: String,
    /// "Album", "Single", "EP", "Compilation"… as the source labels it.
    pub kind: String,
    pub date: String,
    pub track_count: Option<u32>,
    pub duration_ms: Option<u32>,
    /// MusicBrainz's own 0-100 match score for the recording.
    pub source_score: Option<u32>,
    /// Longest side of the full image as far as the source promises.
    pub nominal_size: u32,
    pub preview_data_url: String,
    /// Tried in order until one downloads (CAA may lack the 1200px thumbnail).
    pub full_urls: Vec<String>,
}

/// Escapes a value for use inside a quoted Lucene phrase.
fn lucene_quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

fn urlenc(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[derive(Deserialize)]
struct MbSearch {
    #[serde(default)]
    recordings: Vec<MbRecording>,
}
#[derive(Deserialize)]
struct MbRecording {
    #[serde(default)]
    score: u32,
    #[serde(default)]
    title: String,
    length: Option<u32>,
    #[serde(default, rename = "artist-credit")]
    artist_credit: Vec<MbCredit>,
    #[serde(default)]
    releases: Vec<MbRelease>,
}
#[derive(Deserialize)]
struct MbCredit {
    #[serde(default)]
    name: String,
}
#[derive(Deserialize)]
struct MbRelease {
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    date: String,
    #[serde(default, rename = "track-count")]
    track_count: Option<u32>,
    #[serde(default, rename = "artist-credit")]
    artist_credit: Vec<MbCredit>,
    #[serde(default, rename = "release-group")]
    release_group: Option<MbGroup>,
}
#[derive(Deserialize)]
struct MbGroup {
    #[serde(default)]
    id: String,
    #[serde(rename = "primary-type")]
    primary_type: Option<String>,
    #[serde(default, rename = "secondary-types")]
    secondary_types: Vec<String>,
}

fn credit_name(c: &[MbCredit]) -> String {
    c.iter().map(|c| c.name.as_str()).collect::<Vec<_>>().join(", ")
}

/// A release kind label from MusicBrainz types: a Compilation secondary type
/// wins over the primary (an "Album + Compilation" is a compilation).
fn mb_kind(g: &Option<MbGroup>) -> String {
    let Some(g) = g else { return String::new() };
    if g.secondary_types.iter().any(|t| t.eq_ignore_ascii_case("Compilation")) {
        return "Compilation".into();
    }
    g.primary_type.clone().unwrap_or_default()
}

/// MusicBrainz → Cover Art Archive. Releases without cover art are skipped.
#[tauri::command]
pub async fn artwork_search_musicbrainz(
    app: AppHandle,
    artist: String,
    title: String,
    duration_secs: Option<f64>,
) -> Result<Vec<Candidate>, String> {
    let store = store_path(&app)?;
    let mut q = format!("recording:{}", lucene_quote(&title));
    if !artist.trim().is_empty() {
        q.push_str(&format!(" AND artist:{}", lucene_quote(&artist)));
    }
    let url = format!("https://musicbrainz.org/ws/2/recording?query={}&fmt=json&limit=10", urlenc(&q));
    let Some(body) = fetch_cached(&store, &url, true).await? else {
        return Ok(vec![]);
    };
    let found: MbSearch = serde_json::from_slice(&body).map_err(|e| format!("MusicBrainz sent unreadable data: {e}"))?;

    let mut out: Vec<Candidate> = Vec::new();
    let mut seen_groups: HashSet<String> = HashSet::new();
    let mut tried = 0;
    'recs: for rec in &found.recordings {
        // A different length means a different edit/remix — its art is
        // usually right, but the *recording* is the wrong one to trust.
        if let (Some(want), Some(have)) = (duration_secs, rec.length) {
            if (have as f64 / 1000.0 - want).abs() > 5.0 {
                continue;
            }
        }
        for rel in &rec.releases {
            let group = rel.release_group.as_ref().map(|g| g.id.clone()).unwrap_or_else(|| rel.id.clone());
            if !seen_groups.insert(group) {
                continue;
            }
            tried += 1;
            if tried > 12 || out.len() >= 6 {
                break 'recs;
            }
            let thumb = format!("https://coverartarchive.org/release/{}/front-250", rel.id);
            let Ok(Some(bytes)) = fetch_cached(&store, &thumb, false).await else { continue };
            let base = format!("https://coverartarchive.org/release/{}", rel.id);
            out.push(Candidate {
                source: "musicbrainz",
                id: rel.id.clone(),
                release: rel.title.clone(),
                release_artist: credit_name(&rel.artist_credit),
                track_title: rec.title.clone(),
                track_artist: credit_name(&rec.artist_credit),
                kind: mb_kind(&rel.release_group),
                date: rel.date.clone(),
                track_count: rel.track_count,
                duration_ms: rec.length,
                source_score: Some(rec.score),
                nominal_size: 1200,
                preview_data_url: data_url(&bytes),
                full_urls: vec![format!("{base}/front-1200"), format!("{base}/front-500"), format!("{base}/front")],
            });
        }
    }
    Ok(out)
}

#[derive(Deserialize)]
struct ItunesSearch {
    #[serde(default)]
    results: Vec<ItunesTrack>,
}
#[derive(Deserialize)]
struct ItunesTrack {
    #[serde(default, rename = "trackName")]
    track_name: String,
    #[serde(default, rename = "artistName")]
    artist_name: String,
    #[serde(default, rename = "collectionName")]
    collection_name: String,
    #[serde(default, rename = "collectionArtistName")]
    collection_artist: String,
    #[serde(default, rename = "artworkUrl100")]
    artwork_url: String,
    #[serde(rename = "trackTimeMillis")]
    time_ms: Option<u32>,
    #[serde(rename = "trackCount")]
    track_count: Option<u32>,
    #[serde(default, rename = "releaseDate")]
    release_date: String,
    #[serde(default, rename = "collectionId")]
    collection_id: u64,
}

/// "… - Single" / "… - EP" are Apple's own labels for non-album releases.
fn itunes_kind(collection: &str, artist: &str) -> String {
    let c = collection.to_lowercase();
    if c.ends_with("- single") {
        "Single".into()
    } else if c.ends_with("- ep") {
        "EP".into()
    } else if artist.eq_ignore_ascii_case("various artists") {
        "Compilation".into()
    } else {
        "Album".into()
    }
}

#[tauri::command]
pub async fn artwork_search_itunes(app: AppHandle, artist: String, title: String) -> Result<Vec<Candidate>, String> {
    let store = store_path(&app)?;
    let term = format!("{artist} {title}");
    let url = format!("https://itunes.apple.com/search?term={}&entity=song&limit=15", urlenc(term.trim()));
    let Some(body) = fetch_cached(&store, &url, false).await? else { return Ok(vec![]) };
    let found: ItunesSearch = serde_json::from_slice(&body).map_err(|e| format!("iTunes sent unreadable data: {e}"))?;
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for t in found.results {
        if t.artwork_url.is_empty() || !seen.insert(t.collection_id) {
            continue;
        }
        if out.len() >= 5 {
            break;
        }
        let preview_url = t.artwork_url.replace("100x100bb", "300x300bb");
        let Ok(Some(bytes)) = fetch_cached(&store, &preview_url, false).await else { continue };
        let full = t.artwork_url.replace("100x100bb", "1200x1200bb");
        out.push(Candidate {
            source: "itunes",
            id: t.collection_id.to_string(),
            kind: itunes_kind(&t.collection_name, &t.collection_artist),
            release: t.collection_name,
            release_artist: if t.collection_artist.is_empty() { t.artist_name.clone() } else { t.collection_artist },
            track_title: t.track_name,
            track_artist: t.artist_name,
            date: t.release_date.chars().take(10).collect(),
            track_count: t.track_count,
            duration_ms: t.time_ms,
            source_score: None,
            nominal_size: 1200,
            preview_data_url: data_url(&bytes),
            full_urls: vec![full, t.artwork_url.replace("100x100bb", "600x600bb")],
        });
    }
    Ok(out)
}

#[derive(Deserialize)]
struct DeezerSearch {
    #[serde(default)]
    data: Vec<DeezerTrack>,
}
#[derive(Deserialize)]
struct DeezerTrack {
    #[serde(default)]
    title: String,
    duration: Option<u32>,
    artist: DeezerArtist,
    album: DeezerAlbum,
}
#[derive(Deserialize)]
struct DeezerArtist {
    #[serde(default)]
    name: String,
}
#[derive(Deserialize)]
struct DeezerAlbum {
    #[serde(default)]
    id: u64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    cover_medium: String,
    #[serde(default)]
    cover_xl: String,
}

#[tauri::command]
pub async fn artwork_search_deezer(app: AppHandle, artist: String, title: String) -> Result<Vec<Candidate>, String> {
    let store = store_path(&app)?;
    let mut q = format!("track:{}", lucene_quote(&title));
    if !artist.trim().is_empty() {
        q.push_str(&format!(" artist:{}", lucene_quote(&artist)));
    }
    let url = format!("https://api.deezer.com/search?q={}&limit=15", urlenc(&q));
    let Some(body) = fetch_cached(&store, &url, false).await? else { return Ok(vec![]) };
    let found: DeezerSearch = serde_json::from_slice(&body).map_err(|e| format!("Deezer sent unreadable data: {e}"))?;
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for t in found.data {
        if t.album.cover_xl.is_empty() || !seen.insert(t.album.id) {
            continue;
        }
        if out.len() >= 5 {
            break;
        }
        let Ok(Some(bytes)) = fetch_cached(&store, &t.album.cover_medium, false).await else { continue };
        out.push(Candidate {
            source: "deezer",
            id: t.album.id.to_string(),
            release: t.album.title,
            release_artist: t.artist.name.clone(),
            track_title: t.title,
            track_artist: t.artist.name,
            kind: String::new(),
            date: String::new(),
            track_count: None,
            duration_ms: t.duration.map(|s| s * 1000),
            source_score: None,
            nominal_size: 1000,
            preview_data_url: data_url(&bytes),
            full_urls: vec![t.album.cover_xl],
        });
    }
    Ok(out)
}

/// Downloads the chosen candidate and embeds it, honoring the artwork size and
/// quality settings. Returns the before/after pair for the undo history.
#[tauri::command]
pub async fn artwork_apply(
    path: String,
    full_urls: Vec<String>,
    max_dim: u32,
    quality: u8,
) -> Result<ArtworkChange, String> {
    let mut bytes = None;
    let mut last_err = String::from("No image address to try");
    for url in &full_urls {
        // Not cached: a full-size cover is embedded once and never looked up
        // again, and caching each one grew artwork.sqlite by hundreds of KB
        // per track - gigabytes after a library-wide auto-pick.
        match fetch(url).await {
            Ok(Some(b)) if image::guess_format(&b).is_ok() => {
                bytes = Some(b);
                break;
            }
            Ok(_) => last_err = "The image was not available".into(),
            Err(e) => last_err = e,
        }
    }
    let bytes = bytes.ok_or(last_err)?;
    crate::commands::files::run_blocking(move || apply_cover_bytes(&path, bytes, max_dim, quality)).await
}

// ----------------------------------------------------- hashing & scoring

/// 64-bit difference hash: shrink to 9×8 grey, one bit per "is this pixel
/// brighter than its right neighbour". Insensitive to re-encoding, scaling and
/// small colour shifts, which is exactly what a duplicated logo goes through.
pub fn dhash(img: &image::DynamicImage) -> u64 {
    let g = img.resize_exact(9, 8, image::imageops::FilterType::Triangle).to_luma8();
    let mut h = 0u64;
    for y in 0..8 {
        for x in 0..8 {
            h <<= 1;
            if g.get_pixel(x, y).0[0] > g.get_pixel(x + 1, y).0[0] {
                h |= 1;
            }
        }
    }
    h
}

pub fn hamming(a: u64, b: u64) -> u32 {
    (a ^ b).count_ones()
}

/// Starter heuristic for art that is probably a placeholder or logo, as a
/// 0..1 score plus human-readable reasons. Deliberately simple: tiny images,
/// near-solid fills, and images with only a handful of distinct colours.
pub fn suspicion(img: &image::DynamicImage, width: u32, height: u32) -> (f32, Vec<String>) {
    let mut score = 0.0f32;
    let mut reasons = Vec::new();
    let longest = width.max(height);
    if longest < 150 {
        score += 0.6;
        reasons.push(format!("tiny ({width}×{height})"));
    } else if longest < 300 {
        score += 0.4;
        reasons.push(format!("small ({width}×{height})"));
    }

    let small = img.resize_exact(48, 48, image::imageops::FilterType::Triangle).to_rgb8();
    let n = (48 * 48) as f32;
    let mut luma_sum = 0.0f32;
    let mut lumas = Vec::with_capacity(48 * 48);
    let mut buckets: HashMap<(u8, u8, u8), u32> = HashMap::new();
    for p in small.pixels() {
        let [r, g, b] = p.0;
        let l = 0.299 * r as f32 + 0.587 * g as f32 + 0.114 * b as f32;
        luma_sum += l;
        lumas.push(l);
        // 8 levels per channel: coarse enough that JPEG noise in a flat logo
        // doesn't inflate the count.
        *buckets.entry((r >> 5, g >> 5, b >> 5)).or_insert(0) += 1;
    }
    let mean = luma_sum / n;
    let var = lumas.iter().map(|l| (l - mean) * (l - mean)).sum::<f32>() / n;
    let significant = buckets.values().filter(|&&c| c as f32 / n >= 0.02).count();

    if var.sqrt() < 8.0 {
        score += 0.9;
        reasons.push("near-solid colour".into());
    } else if significant <= 3 {
        score += 0.45;
        reasons.push(format!("only {significant} main colours (logo or text-only?)"));
    }
    (score.min(1.0), reasons)
}

#[derive(Debug, Clone)]
pub struct HashItem {
    pub path: String,
    pub hash: u64,
    pub artist: String,
    pub album: String,
}

#[derive(Debug, Clone)]
pub struct Cluster {
    /// The most common exact hash in the cluster.
    pub representative: u64,
    pub members: Vec<usize>,
    pub artists: usize,
    pub albums: usize,
}

fn norm_key(s: &str) -> String {
    s.trim().to_lowercase()
}

/// Groups images whose hashes are within `max_dist` of a cluster's
/// representative, then keeps clusters spanning at least `min_artists`
/// distinct artists over at least `min_tracks` tracks: one album's own cover
/// repeated down its tracklist is not junk, the same picture on unrelated
/// artists is. Sorted by size, biggest first.
pub fn cluster_hashes(items: &[HashItem], max_dist: u32, min_tracks: usize, min_artists: usize) -> Vec<Cluster> {
    let mut by_hash: HashMap<u64, Vec<usize>> = HashMap::new();
    for (i, it) in items.iter().enumerate() {
        by_hash.entry(it.hash).or_default().push(i);
    }
    let mut groups: Vec<(u64, Vec<usize>)> = by_hash.into_iter().collect();
    // Biggest exact-match groups first so they anchor the clusters; ties by
    // hash value keep the result deterministic.
    groups.sort_by(|a, b| b.1.len().cmp(&a.1.len()).then(a.0.cmp(&b.0)));

    let mut clusters: Vec<(u64, Vec<usize>)> = Vec::new();
    for (hash, members) in groups {
        match clusters.iter_mut().find(|(rep, _)| hamming(*rep, hash) <= max_dist) {
            Some((_, m)) => m.extend(members),
            None => clusters.push((hash, members)),
        }
    }

    let mut out: Vec<Cluster> = clusters
        .into_iter()
        .filter_map(|(rep, members)| {
            if members.len() < min_tracks {
                return None;
            }
            let artists: HashSet<String> = members.iter().map(|&i| norm_key(&items[i].artist)).collect();
            if artists.len() < min_artists {
                return None;
            }
            let albums: HashSet<String> = members.iter().map(|&i| norm_key(&items[i].album)).collect();
            Some(Cluster { representative: rep, members, artists: artists.len(), albums: albums.len() })
        })
        .collect();
    out.sort_by(|a, b| b.members.len().cmp(&a.members.len()).then(a.representative.cmp(&b.representative)));
    out
}

// ---------------------------------------------------------------- scanning

struct Hashed {
    path: String,
    mtime: i64,
    size: i64,
    result: Result<Option<HashRow>, String>,
}

struct HashRow {
    hash: u64,
    width: u32,
    height: u32,
    suspicion: f32,
    reasons: Vec<String>,
    artist: String,
    album: String,
    title: String,
}

fn file_stat(path: &str) -> Option<(i64, i64)> {
    let m = std::fs::metadata(path).ok()?;
    let mtime = m.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_secs() as i64;
    Some((mtime, m.len() as i64))
}

fn hash_file(path: &str) -> Result<Option<HashRow>, String> {
    use lofty::prelude::*;
    let tagged = lofty::read_from_path(path).map_err(|e| e.to_string())?;
    let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) else { return Ok(None) };
    let Some(pic) = tag.pictures().first() else { return Ok(None) };
    let img = image::load_from_memory(pic.data()).map_err(|e| format!("Unreadable cover art: {e}"))?;
    use image::GenericImageView;
    let (w, h) = img.dimensions();
    let (score, reasons) = suspicion(&img, w, h);
    Ok(Some(HashRow {
        hash: dhash(&img),
        width: w,
        height: h,
        suspicion: score,
        reasons,
        artist: tag.artist().map(|s| s.to_string()).unwrap_or_default(),
        album: tag.album().map(|s| s.to_string()).unwrap_or_default(),
        title: tag.title().map(|s| s.to_string()).unwrap_or_default(),
    }))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSummary {
    pub total: usize,
    pub hashed: usize,
    pub unchanged: usize,
    pub no_art: usize,
    pub failed: usize,
}

/// Library paths that have embedded art, per the library index. Opened
/// read-only: the index belongs to `library_index.rs`.
fn indexed_paths_with_cover(app: &AppHandle) -> Result<Vec<String>, String> {
    let path = crate::commands::library_index::db_path(app)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let conn = Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| e.to_string())?;
    let _ = conn.busy_timeout(Duration::from_secs(10));
    let mut stmt = conn
        .prepare("SELECT path FROM library_track WHERE has_cover = 1")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// Hashes the embedded cover of every library track (or of `paths`), skipping
/// files unchanged since the last scan. Emits `artwork-scan-progress`.
#[tauri::command]
pub async fn artwork_scan(app: AppHandle, paths: Option<Vec<String>>) -> Result<ScanSummary, String> {
    let store = store_path(&app)?;
    let whole_library = paths.is_none();
    let paths = match paths {
        Some(p) => p,
        None => indexed_paths_with_cover(&app)?,
    };
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || scan_blocking(&app2, &store, paths, whole_library))
        .await
        .map_err(|_| "The artwork scan stopped unexpectedly".to_string())?
}

fn scan_blocking(app: &AppHandle, store: &Path, paths: Vec<String>, prune: bool) -> Result<ScanSummary, String> {
    let mut conn = open_store(store)?;
    let known: HashMap<String, (i64, i64)> = {
        let mut stmt = conn.prepare("SELECT path, mtime, size FROM art_hash").map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, (r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))))
            .map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };

    let mut summary = ScanSummary { total: paths.len(), hashed: 0, unchanged: 0, no_art: 0, failed: 0 };
    let mut todo: Vec<String> = Vec::new();
    for p in &paths {
        match file_stat(p) {
            Some(st) if known.get(p) == Some(&st) => summary.unchanged += 1,
            _ => todo.push(p.clone()),
        }
    }

    let mut done = summary.unchanged;
    let emit = |done: usize| {
        let _ = app.emit("artwork-scan-progress", serde_json::json!({ "done": done, "total": paths.len() }));
    };
    emit(done);

    for chunk in todo.chunks(200) {
        let results: Vec<Hashed> = par_map(
            chunk,
            |p| {
                let (mtime, size) = file_stat(p).unwrap_or((0, 0));
                Hashed { path: p.clone(), mtime, size, result: hash_file(p) }
            },
            |p| Hashed { path: p.clone(), mtime: 0, size: 0, result: Err("panic while reading cover".into()) },
        );
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for h in results {
            match h.result {
                Ok(Some(r)) => {
                    summary.hashed += 1;
                    tx.execute(
                        "INSERT OR REPLACE INTO art_hash (path, mtime, size, hash, width, height, suspicion, reasons, artist, album, title)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                        params![h.path, h.mtime, h.size, r.hash as i64, r.width, r.height, r.suspicion, r.reasons.join("; "), r.artist, r.album, r.title],
                    )
                    .map_err(|e| e.to_string())?;
                }
                Ok(None) => {
                    summary.no_art += 1;
                    let _ = tx.execute("DELETE FROM art_hash WHERE path = ?1", params![h.path]);
                }
                Err(_) => summary.failed += 1,
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        done += chunk.len();
        emit(done);
    }

    if prune {
        // Files that left the library (or lost their art) no longer count.
        let keep: HashSet<&String> = paths.iter().collect();
        let stale: Vec<&String> = known.keys().filter(|k| !keep.contains(k)).collect();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for p in stale {
            let _ = tx.execute("DELETE FROM art_hash WHERE path = ?1", params![p]);
        }
        tx.commit().map_err(|e| e.to_string())?;
    }
    Ok(summary)
}

struct StoredRow {
    item: HashItem,
    width: u32,
    height: u32,
    suspicion: f32,
    reasons: String,
    title: String,
}

fn load_rows(conn: &Connection) -> Result<Vec<StoredRow>, String> {
    let mut stmt = conn
        .prepare("SELECT path, hash, width, height, suspicion, reasons, artist, album, title FROM art_hash")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(StoredRow {
                item: HashItem {
                    path: r.get(0)?,
                    hash: r.get::<_, i64>(1)? as u64,
                    artist: r.get(6)?,
                    album: r.get(7)?,
                },
                width: r.get(2)?,
                height: r.get(3)?,
                suspicion: r.get(4)?,
                reasons: r.get(5)?,
                title: r.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

fn load_blocklist(conn: &Connection) -> Result<Vec<(u64, String)>, String> {
    let mut stmt = conn.prepare("SELECT hash, label FROM junk_blocklist").map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, i64>(0)? as u64, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleTrack {
    pub path: String,
    pub artist: String,
    pub title: String,
    pub album: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterDto {
    /// Hex, because a u64 does not survive a trip through a JS number.
    pub hash: String,
    pub count: usize,
    pub artists: usize,
    pub albums: usize,
    pub blocked: bool,
    pub label: String,
    pub thumbnail: Option<String>,
    pub samples: Vec<SampleTrack>,
    pub paths: Vec<String>,
}

fn thumbnail_of(path: &str, size: u32) -> Option<String> {
    use lofty::prelude::*;
    let tagged = lofty::read_from_path(path).ok()?;
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag())?;
    let img = image::load_from_memory(tag.pictures().first()?.data()).ok()?;
    let t = img.thumbnail(size, size).to_rgb8();
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 80).encode_image(&t).ok()?;
    Some(data_url(&out))
}

/// Clusters of identical-looking covers shared across unrelated artists, with
/// blocked ones (already marked junk) included so the UI can show/unmark them.
#[tauri::command]
pub async fn artwork_clusters(app: AppHandle) -> Result<Vec<ClusterDto>, String> {
    let store = store_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_store(&store)?;
        let rows = load_rows(&conn)?;
        let blocklist = load_blocklist(&conn)?;
        let items: Vec<HashItem> = rows.iter().map(|r| r.item.clone()).collect();
        let clusters = cluster_hashes(&items, SAME_IMAGE_DISTANCE, MIN_CLUSTER_TRACKS, MIN_CLUSTER_ARTISTS);
        Ok(clusters
            .into_iter()
            .map(|c| {
                let blocked = blocklist.iter().find(|(h, _)| hamming(*h, c.representative) <= SAME_IMAGE_DISTANCE);
                let samples: Vec<SampleTrack> = c
                    .members
                    .iter()
                    .take(5)
                    .map(|&i| SampleTrack {
                        path: rows[i].item.path.clone(),
                        artist: rows[i].item.artist.clone(),
                        title: rows[i].title.clone(),
                        album: rows[i].item.album.clone(),
                    })
                    .collect();
                ClusterDto {
                    hash: format!("{:016x}", c.representative),
                    count: c.members.len(),
                    artists: c.artists,
                    albums: c.albums,
                    blocked: blocked.is_some(),
                    label: blocked.map(|(_, l)| l.clone()).unwrap_or_default(),
                    thumbnail: c.members.first().and_then(|&i| thumbnail_of(&rows[i].item.path, 96)),
                    samples,
                    paths: c.members.iter().map(|&i| rows[i].item.path.clone()).collect(),
                }
            })
            .collect())
    })
    .await
    .map_err(|_| "Reading clusters failed unexpectedly".to_string())?
}

/// Marks (or unmarks) a cluster's picture as junk art.
#[tauri::command]
pub async fn artwork_blocklist_set(app: AppHandle, hash: String, label: String, blocked: bool) -> Result<(), String> {
    let h = u64::from_str_radix(&hash, 16).map_err(|_| "Bad hash".to_string())?;
    let conn = open_store(&store_path(&app)?)?;
    if blocked {
        conn.execute(
            "INSERT OR REPLACE INTO junk_blocklist (hash, label, added_at) VALUES (?1, ?2, ?3)",
            params![h as i64, label, now_secs()],
        )
    } else {
        // Unmark everything within the match radius, not only the exact hash.
        let near: Vec<i64> = load_blocklist(&conn)?
            .into_iter()
            .filter(|(b, _)| hamming(*b, h) <= SAME_IMAGE_DISTANCE)
            .map(|(b, _)| b as i64)
            .collect();
        let mut n = 0;
        for b in near {
            n += conn.execute("DELETE FROM junk_blocklist WHERE hash = ?1", params![b]).map_err(|e| e.to_string())?;
        }
        Ok(n)
    }
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlaggedTrack {
    pub path: String,
    pub artist: String,
    pub title: String,
    pub album: String,
    pub width: u32,
    pub height: u32,
    /// "Marked junk: <label>" or "Suspicious: <reasons>".
    pub reason: String,
    pub blocked: bool,
}

/// Tracks whose cover matches the junk blocklist or looks suspicious.
#[tauri::command]
pub async fn artwork_flagged(app: AppHandle) -> Result<Vec<FlaggedTrack>, String> {
    let store = store_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_store(&store)?;
        let rows = load_rows(&conn)?;
        let blocklist = load_blocklist(&conn)?;
        let mut out = Vec::new();
        for r in rows {
            let hit = blocklist.iter().find(|(h, _)| hamming(*h, r.item.hash) <= SAME_IMAGE_DISTANCE);
            let (reason, blocked) = match hit {
                Some((_, label)) => (
                    if label.is_empty() { "Marked as junk art".to_string() } else { format!("Marked as junk art: {label}") },
                    true,
                ),
                None if r.suspicion >= SUSPICIOUS_THRESHOLD => (format!("Suspicious: {}", r.reasons), false),
                None => continue,
            };
            out.push(FlaggedTrack {
                path: r.item.path,
                artist: r.item.artist,
                title: r.title,
                album: r.item.album,
                width: r.width,
                height: r.height,
                reason,
                blocked,
            });
        }
        out.sort_by(|a, b| b.blocked.cmp(&a.blocked).then(a.artist.cmp(&b.artist)));
        Ok(out)
    })
    .await
    .map_err(|_| "Reading flagged tracks failed unexpectedly".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, Rgb, RgbImage};

    /// A picture with real structure (gradient, a disc, bars) so its hash isn't degenerate.
    fn sample(seed: u32, size: u32) -> DynamicImage {
        let mut img = RgbImage::new(size, size);
        for (x, y, p) in img.enumerate_pixels_mut() {
            let fx = x as f32 / size as f32;
            let fy = y as f32 / size as f32;
            let mut v = ((fx * 200.0 + seed as f32 * 37.0) % 255.0) as u8;
            let dx = fx - 0.3 - (seed % 5) as f32 * 0.1;
            let dy = fy - 0.6;
            if dx * dx + dy * dy < 0.05 {
                v = 255 - v;
            }
            if ((fy * (4 + seed % 4) as f32) as u32) % 2 == 0 && fx > 0.6 {
                v = v / 2;
            }
            *p = Rgb([v, (fy * 255.0) as u8, 255 - v]);
        }
        DynamicImage::ImageRgb8(img)
    }

    fn jpeg_roundtrip(img: &DynamicImage, quality: u8) -> DynamicImage {
        let mut out = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality)
            .encode_image(&img.to_rgb8())
            .unwrap();
        image::load_from_memory(&out).unwrap()
    }

    #[test]
    fn hash_survives_reencode_and_rescale() {
        let img = sample(1, 600);
        let h = dhash(&img);
        for q in [95, 75, 50] {
            let d = hamming(h, dhash(&jpeg_roundtrip(&img, q)));
            assert!(d <= SAME_IMAGE_DISTANCE, "q{q} moved the hash by {d} bits");
        }
        let small = img.resize_exact(300, 300, image::imageops::FilterType::Lanczos3);
        assert!(hamming(h, dhash(&small)) <= SAME_IMAGE_DISTANCE);
        let small_jpeg = jpeg_roundtrip(&small, 60);
        assert!(hamming(h, dhash(&small_jpeg)) <= SAME_IMAGE_DISTANCE);
    }

    #[test]
    fn different_pictures_hash_far_apart() {
        let a = dhash(&sample(1, 400));
        let b = dhash(&sample(3, 400));
        assert!(hamming(a, b) > SAME_IMAGE_DISTANCE, "distinct images collided");
    }

    fn item(path: &str, hash: u64, artist: &str, album: &str) -> HashItem {
        HashItem { path: path.into(), hash, artist: artist.into(), album: album.into() }
    }

    #[test]
    fn clusters_need_many_artists() {
        let logo = 0xF0F0_F0F0_0F0F_0F0Fu64;
        let items = vec![
            item("1", logo, "A", "x"),
            item("2", logo ^ 0b11, "B", "y"), // 2 bits off: same picture re-encoded
            item("3", logo ^ 0b1_0000, "C", "z"),
            item("4", logo, "D", "w"),
            // one album's own cover, one artist: not junk
            item("5", 0x1234_5678_9ABC_DEF0, "Solo", "LP"),
            item("6", 0x1234_5678_9ABC_DEF0, "Solo", "LP"),
            item("7", 0x1234_5678_9ABC_DEF0, "Solo", "LP"),
            // far-off hash with a single track
            item("8", !logo, "E", "q"),
        ];
        let c = cluster_hashes(&items, SAME_IMAGE_DISTANCE, 3, 3);
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].members.len(), 4);
        assert_eq!(c[0].artists, 4);
        assert_eq!(c[0].representative, logo);
    }

    #[test]
    fn clusters_sorted_biggest_first() {
        let a = 0x0000_0000_0000_FFFFu64;
        let b = 0xFFFF_0000_0000_0000u64;
        let mut items = vec![];
        for i in 0..3 {
            items.push(item(&format!("a{i}"), a, &format!("art{i}"), "al"));
        }
        for i in 0..5 {
            items.push(item(&format!("b{i}"), b, &format!("art{i}"), "al"));
        }
        let c = cluster_hashes(&items, SAME_IMAGE_DISTANCE, 3, 3);
        assert_eq!(c.iter().map(|c| c.members.len()).collect::<Vec<_>>(), vec![5, 3]);
    }

    #[test]
    fn suspicion_flags_solid_tiny_and_logo_art() {
        let solid = DynamicImage::ImageRgb8(RgbImage::from_pixel(600, 600, Rgb([20, 20, 20])));
        assert!(suspicion(&solid, 600, 600).0 >= SUSPICIOUS_THRESHOLD);

        let tiny_photo = sample(2, 100);
        assert!(suspicion(&tiny_photo, 100, 100).0 >= 0.5);

        // Two-colour logo: white text block on red.
        let mut logo = RgbImage::from_pixel(500, 500, Rgb([200, 0, 0]));
        for y in 200..300 {
            for x in 50..450 {
                if (x / 20) % 2 == 0 {
                    logo.put_pixel(x, y, Rgb([255, 255, 255]));
                }
            }
        }
        let (s, why) = suspicion(&DynamicImage::ImageRgb8(logo), 500, 500);
        assert!(s > 0.4 && !why.is_empty());

        let (s, _) = suspicion(&sample(1, 800), 800, 800);
        assert!(s < SUSPICIOUS_THRESHOLD, "a normal cover was flagged ({s})");
    }

    #[test]
    fn rate_limiter_spaces_requests() {
        let mut l = RateLimiter::new(Duration::from_secs(1));
        let t0 = Instant::now();
        assert_eq!(l.reserve(t0), Duration::ZERO);
        assert_eq!(l.reserve(t0), Duration::from_secs(1));
        assert_eq!(l.reserve(t0), Duration::from_secs(2));
        // After a long idle spell the next request goes straight through.
        assert_eq!(l.reserve(t0 + Duration::from_secs(10)), Duration::ZERO);
        assert_eq!(l.reserve(t0 + Duration::from_millis(10_500)), Duration::from_millis(500));
    }

    #[test]
    fn lucene_and_url_escaping() {
        assert_eq!(lucene_quote(r#"a "b" \c"#), r#""a \"b\" \\c""#);
        assert_eq!(urlenc("a b&c/é"), "a%20b%26c%2F%C3%A9");
    }

    #[test]
    fn http_cache_roundtrip_and_negative_entry() {
        let dir = std::env::temp_dir().join(format!("mtc-art-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("artwork.sqlite");
        assert!(cache_get(&db, "k").is_none());
        cache_put(&db, "k", b"hello");
        assert_eq!(cache_get(&db, "k").unwrap(), b"hello");
        cache_put(&db, "gone", &[]);
        assert_eq!(cache_get(&db, "gone").unwrap(), Vec::<u8>::new());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Read-only survey of a real library: `MTC_INDEX_DB=<copy of
    /// library-index.sqlite> cargo test -- --ignored --nocapture owner_library`.
    /// Only reads embedded covers; nothing is written to the music files.
    #[test]
    #[ignore]
    fn owner_library_clusters() {
        let Ok(db) = std::env::var("MTC_INDEX_DB") else { return };
        let conn = Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let mut stmt = conn.prepare("SELECT path FROM library_track WHERE has_cover = 1").unwrap();
        let paths: Vec<String> = stmt.query_map([], |r| r.get(0)).unwrap().filter_map(|r| r.ok()).collect();
        let rows: Vec<Option<HashRow>> = par_map(&paths, |p| hash_file(p).ok().flatten(), |_| None);
        let items: Vec<(HashItem, f32, String, u32)> = paths
            .iter()
            .zip(rows)
            .filter_map(|(p, r)| {
                let r = r?;
                Some((HashItem { path: p.clone(), hash: r.hash, artist: r.artist, album: r.album }, r.suspicion, r.reasons.join("; "), r.width))
            })
            .collect();
        println!("tracks with art: {} / hashed {}", paths.len(), items.len());
        let only: Vec<HashItem> = items.iter().map(|i| i.0.clone()).collect();
        let clusters = cluster_hashes(&only, SAME_IMAGE_DISTANCE, MIN_CLUSTER_TRACKS, MIN_CLUSTER_ARTISTS);
        println!("clusters: {}", clusters.len());
        for c in clusters.iter().take(15) {
            let first = &only[c.members[0]];
            let w = items[c.members[0]].3;
            println!(
                "{:>4} tracks, {:>3} artists, {:>3} albums  hash {:016x}  {}px  e.g. {} | {} | {}",
                c.members.len(), c.artists, c.albums, c.representative, w, first.artist, first.album,
                Path::new(&first.path).file_name().unwrap().to_string_lossy()
            );
        }
        let flagged: Vec<_> = items.iter().filter(|i| i.1 >= SUSPICIOUS_THRESHOLD).collect();
        println!("suspicious (>= {SUSPICIOUS_THRESHOLD}): {}", flagged.len());
        let mut reasons: HashMap<String, usize> = HashMap::new();
        for f in &flagged {
            *reasons.entry(f.2.split(" (").next().unwrap_or("").to_string()).or_insert(0) += 1;
        }
        println!("{reasons:?}");
    }

    /// Live check against MusicBrainz + Cover Art Archive. Run with
    /// `cargo test -- --ignored mb_live`.
    #[test]
    #[ignore]
    fn mb_live_finds_cover_for_known_track() {
        // The app gets its provider from the updater plugin; a bare test must install one.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let dir = std::env::temp_dir().join(format!("mtc-art-live-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            let store = dir.join("artwork.sqlite");
            let url = format!(
                "https://musicbrainz.org/ws/2/recording?query={}&fmt=json&limit=5",
                urlenc(&format!("recording:{} AND artist:{}", lucene_quote("Get Lucky"), lucene_quote("Daft Punk")))
            );
            let body = fetch_cached(&store, &url, true).await.unwrap().expect("MB answered");
            let found: MbSearch = serde_json::from_slice(&body).unwrap();
            assert!(!found.recordings.is_empty());
            let mut got_art = false;
            for rel in found.recordings.iter().flat_map(|r| r.releases.iter()).take(6) {
                let u = format!("https://coverartarchive.org/release/{}/front-250", rel.id);
                if let Ok(Some(bytes)) = fetch_cached(&store, &u, false).await {
                    assert!(image::load_from_memory(&bytes).is_ok());
                    got_art = true;
                    break;
                }
            }
            assert!(got_art, "no Cover Art Archive image for any Get Lucky release");
            let _ = std::fs::remove_dir_all(&dir);
        });
    }
}
