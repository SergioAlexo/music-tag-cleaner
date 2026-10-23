//! Lyrics (LRCLIB) and language detection.
//!
//! Lyrics come from LRCLIB (free, no key). Results - including "not found" -
//! are cached in the library database so a bulk run over a big collection
//! never asks twice. They are stored as a sidecar `.lrc` next to the audio
//! file (what Resolume plugins, VirtualDJ and Mixxx skins read) and/or
//! embedded as plain text (ID3 USLT / Vorbis LYRICS / MP4 lyrics).
//!
//! Language detection is offline (`whatlang`) over the lyrics when we have
//! them, else over title + artist, and is only ever a *suggestion*; the
//! frontend previews it, nothing is written here.

use std::path::{Path, PathBuf};
use std::time::Duration;

use lofty::file::AudioFile;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;

use crate::commands::files;
use crate::commands::library_index::open_db;

const LRCLIB: &str = "https://lrclib.net";
/// How long a "LRCLIB has nothing for this" answer is trusted. Lyrics get
/// added to LRCLIB over time, so a miss is not permanent.
const MISS_TTL_SECS: i64 = 14 * 24 * 3600;
/// Requests in flight at once. LRCLIB is a donated service; be polite.
const CONCURRENCY: usize = 4;

// --- LRC -------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LrcLine {
    pub time_ms: u32,
    pub text: String,
}

/// Parses LRC text into time-ordered lines. Handles `[mm:ss.xx]`,
/// `[mm:ss.xxx]`, `[mm:ss]`, several time tags on one line (a repeated
/// chorus), and the `[offset:+/-ms]` tag; other `[key:value]` metadata tags
/// are ignored. Lines without a time tag are dropped (this is the synced view).
pub fn parse_lrc(src: &str) -> Vec<LrcLine> {
    let mut offset: i64 = 0;
    let mut out: Vec<LrcLine> = Vec::new();
    for raw in src.lines() {
        let mut rest = raw.trim_start_matches('\u{feff}').trim();
        let mut times: Vec<u32> = Vec::new();
        while let Some(stripped) = rest.strip_prefix('[') {
            let Some(end) = stripped.find(']') else { break };
            let tag = &stripped[..end];
            if let Some(t) = parse_timestamp(tag) {
                times.push(t);
            } else if let Some(v) = tag.strip_prefix("offset:") {
                offset = v.trim().parse().unwrap_or(0);
            } else if !tag.contains(':') {
                break;
            }
            rest = stripped[end + 1..].trim_start();
        }
        for t in times {
            let ms = (t as i64 - offset).max(0) as u32;
            out.push(LrcLine { time_ms: ms, text: rest.trim().to_string() });
        }
    }
    out.sort_by_key(|l| l.time_ms);
    out
}

/// `mm:ss`, `mm:ss.f`, `mm:ss.ff`, `mm:ss.fff` (also `:` before the fraction).
fn parse_timestamp(tag: &str) -> Option<u32> {
    let (mm, rest) = tag.split_once(':')?;
    let mins: u32 = mm.trim().parse().ok()?;
    let (ss, frac) = match rest.find(['.', ':']) {
        Some(i) => (&rest[..i], &rest[i + 1..]),
        None => (rest, ""),
    };
    let secs: u32 = ss.trim().parse().ok()?;
    if secs >= 100 || (!frac.is_empty() && !frac.chars().all(|c| c.is_ascii_digit())) {
        return None;
    }
    let millis: u32 = match frac.len() {
        0 => 0,
        1 => frac.parse::<u32>().ok()? * 100,
        2 => frac.parse::<u32>().ok()? * 10,
        _ => frac[..3].parse().ok()?,
    };
    Some(mins * 60_000 + secs * 1000 + millis)
}

/// Whether `text` is LRC with real timestamps, not plain lyrics.
pub fn looks_synced(text: &str) -> bool {
    parse_lrc(text).len() >= 2
}

/// Lyrics without timestamps, for embedding and for language detection.
pub fn strip_timestamps(lrc: &str) -> String {
    if !looks_synced(lrc) {
        return lrc.trim().to_string();
    }
    // Keep line order as written (not time-sorted) so repeated tags don't reorder verses.
    let mut lines = Vec::new();
    for raw in lrc.lines() {
        let mut rest = raw.trim_start_matches('\u{feff}').trim();
        let mut had_time = false;
        while let Some(stripped) = rest.strip_prefix('[') {
            let Some(end) = stripped.find(']') else { break };
            let tag = &stripped[..end];
            if parse_timestamp(tag).is_some() {
                had_time = true;
            } else if !tag.contains(':') {
                break;
            }
            rest = stripped[end + 1..].trim_start();
        }
        if had_time {
            lines.push(rest.trim().to_string());
        }
    }
    lines.join("\n").trim().to_string()
}

// --- Language detection ------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Level {
    High,
    Low,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Guess {
    /// ISO 639-3 code, which equals the ISO 639-2/T code ID3 TLAN expects for
    /// every language whatlang knows (`spa`, `fra`, `deu`...).
    pub code: String,
    pub confidence: f64,
    pub level: Level,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextSource {
    Lyrics,
    TitleArtist,
}

/// Minimum letters before a guess is worth making. Lyrics are long enough for
/// whatlang to be reliable; a title is a handful of words, so it needs a
/// higher bar and is never "high".
const MIN_LETTERS_LYRICS: usize = 40;
const MIN_LETTERS_TITLE: usize = 10;
const MIN_CONFIDENCE_LYRICS: f64 = 0.4;
/// whatlang's own "reliable" bar (0.8) is strict for sung text, where a
/// Spanish verse is close to Portuguese; with a full verse or more, this is
/// enough to tick the suggestion by default.
const HIGH_CONFIDENCE_LYRICS: f64 = 0.5;
const HIGH_MIN_LETTERS_LYRICS: usize = 80;
const MIN_CONFIDENCE_TITLE: f64 = 0.6;

/// Guesses the language of `text`. Lyrics with a reliable detection are
/// `High`; weaker lyrics matches and every title/artist guess are `Low` and
/// are the ones the UI offers to double-check with the AI. `None` when the
/// text is too short or too ambiguous to say.
pub fn guess_language(text: &str, source: TextSource) -> Option<Guess> {
    let letters = text.chars().filter(|c| c.is_alphabetic()).count();
    let (min_letters, min_conf) = match source {
        TextSource::Lyrics => (MIN_LETTERS_LYRICS, MIN_CONFIDENCE_LYRICS),
        TextSource::TitleArtist => (MIN_LETTERS_TITLE, MIN_CONFIDENCE_TITLE),
    };
    if letters < min_letters {
        return None;
    }
    let info = whatlang::detect(text)?;
    if info.confidence() < min_conf {
        return None;
    }
    let high = source == TextSource::Lyrics
        && (info.is_reliable()
            || (letters >= HIGH_MIN_LETTERS_LYRICS && info.confidence() >= HIGH_CONFIDENCE_LYRICS));
    let level = if high { Level::High } else { Level::Low };
    Some(Guess { code: info.lang().code().to_string(), confidence: info.confidence(), level })
}

// --- LRCLIB ------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
struct Meta {
    artist: String,
    title: String,
    album: String,
    duration_secs: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq)]
struct Found {
    synced: Option<String>,
    plain: Option<String>,
    instrumental: bool,
    duration: Option<f64>,
}

fn non_empty(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

fn found_of(v: &Value) -> Found {
    Found {
        synced: non_empty(v.get("syncedLyrics")),
        plain: non_empty(v.get("plainLyrics")),
        instrumental: v.get("instrumental").and_then(Value::as_bool).unwrap_or(false),
        duration: v.get("duration").and_then(Value::as_f64),
    }
}

impl Found {
    fn has_text(&self) -> bool {
        self.synced.is_some() || self.plain.is_some()
    }
}

/// The best entry of a `/api/search` answer for a track of `duration`:
/// durations must agree within 4 s when both are known (LRCLIB holds many
/// edits and live versions), synced beats plain beats nothing, and the closest
/// duration wins ties. An instrumental entry only counts if nothing has text.
fn pick_best(results: &[Value], duration: Option<f64>) -> Option<Found> {
    let mut best: Option<(f64, Found)> = None;
    for v in results {
        let f = found_of(v);
        if let (Some(want), Some(have)) = (duration, f.duration) {
            if (want - have).abs() > 4.0 {
                continue;
            }
        }
        if !f.has_text() && !f.instrumental {
            continue;
        }
        let diff = match (duration, f.duration) {
            (Some(a), Some(b)) => (a - b).abs(),
            _ => 2.0,
        };
        let score = if f.synced.is_some() {
            100.0
        } else if f.plain.is_some() {
            50.0
        } else {
            10.0
        } - diff;
        if best.as_ref().map_or(true, |(s, _)| score > *s) {
            best = Some((score, f));
        }
    }
    best.map(|(_, f)| f)
}

/// "Song (Original Mix) [feat. X]" -> "Song". A second, looser search term for
/// when the exact title finds nothing.
fn clean_title(title: &str) -> String {
    let mut out = String::new();
    let mut depth = 0i32;
    for c in title.chars() {
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' => depth = (depth - 1).max(0),
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    let lower = out.to_lowercase();
    let cut = [" feat.", " feat ", " ft.", " ft ", " featuring ", " - "]
        .iter()
        .filter_map(|m| lower.find(m))
        .min()
        .unwrap_or(out.len());
    out[..cut].trim().to_string()
}

fn first_artist(artist: &str) -> String {
    let lower = artist.to_lowercase();
    let cut = [",", " & ", " feat", " ft.", " x ", ";", " and "]
        .iter()
        .filter_map(|m| lower.find(m))
        .min()
        .unwrap_or(artist.len());
    artist[..cut].trim().to_string()
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(concat!(
            "music-tag-cleaner/",
            env!("CARGO_PKG_VERSION"),
            " (https://github.com/sergioalexo/music-tag-cleaner)"
        ))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("Could not start the lyrics client: {e}"))
}

async fn get_json(client: &reqwest::Client, url: &str, query: &[(&str, String)]) -> Result<Option<Value>, String> {
    // Built by hand: reqwest's `.query()` sits behind a feature we don't enable.
    let full = reqwest::Url::parse_with_params(url, query.iter().map(|(k, v)| (*k, v.as_str())))
        .map_err(|e| format!("Bad lyrics request: {e}"))?;
    // LRCLIB is a donated service and answers 429/502/503/504 when busy (25 of
    // 100 lookups did in a live run). Those are retried with a growing pause
    // rather than reported as failures; the cache never sees them either way.
    let mut attempt = 0u32;
    let resp = loop {
        let resp = client
            .get(full.clone())
            .send()
            .await
            .map_err(|e| format!("LRCLIB is unreachable: {e}"))?;
        let busy = matches!(resp.status().as_u16(), 429 | 502 | 503 | 504);
        if !busy || attempt >= 3 {
            break resp;
        }
        attempt += 1;
        tokio::time::sleep(Duration::from_millis(1200 * u64::from(attempt))).await;
    };
    let status = resp.status();
    if status.as_u16() == 404 {
        return Ok(None);
    }
    if !status.is_success() {
        // 400 = LRCLIB refused the parameters (e.g. no title); not an outage.
        if status.as_u16() == 400 {
            return Ok(None);
        }
        return Err(format!("LRCLIB answered {status}"));
    }
    resp.json::<Value>().await.map(Some).map_err(|e| format!("LRCLIB sent an unreadable answer: {e}"))
}

/// Exact lookup, then a search by title+artist, then a search with the
/// decorations stripped from both.
async fn lrclib_lookup(client: &reqwest::Client, base: &str, m: &Meta) -> Result<Option<Found>, String> {
    if m.title.trim().is_empty() || m.artist.trim().is_empty() {
        return Ok(None);
    }
    let mut q = vec![("artist_name", m.artist.clone()), ("track_name", m.title.clone())];
    if !m.album.is_empty() {
        q.push(("album_name", m.album.clone()));
    }
    if let Some(d) = m.duration_secs {
        q.push(("duration", format!("{}", d.round() as i64)));
    }
    if let Some(v) = get_json(client, &format!("{base}/api/get"), &q).await? {
        let f = found_of(&v);
        if f.has_text() || f.instrumental {
            return Ok(Some(f));
        }
    }
    let attempts = [
        (m.artist.clone(), m.title.clone()),
        (first_artist(&m.artist), clean_title(&m.title)),
    ];
    for (i, (artist, title)) in attempts.iter().enumerate() {
        if title.is_empty() || (i == 1 && attempts[0] == attempts[1]) {
            continue;
        }
        let q = vec![("artist_name", artist.clone()), ("track_name", title.clone())];
        if let Some(Value::Array(list)) = get_json(client, &format!("{base}/api/search"), &q).await? {
            if let Some(f) = pick_best(&list, m.duration_secs) {
                return Ok(Some(f));
            }
        }
    }
    Ok(None)
}

// --- Cache -------------------------------------------------------------------

fn ensure_cache(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS lyrics_cache (
            key TEXT PRIMARY KEY,
            found INTEGER NOT NULL,
            instrumental INTEGER NOT NULL DEFAULT 0,
            synced TEXT,
            plain TEXT,
            fetched_at INTEGER NOT NULL
        );",
    )
    .map_err(|e| e.to_string())
}

fn norm(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

fn cache_key(artist: &str, title: &str) -> String {
    format!("{}\u{1}{}", norm(artist), norm(title))
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// `Some(None)` = cached miss, `Some(Some(_))` = cached hit, `None` = not cached
/// (or the miss has expired).
fn cache_get(conn: &Connection, key: &str) -> Option<Option<Found>> {
    conn.query_row(
        "SELECT found, instrumental, synced, plain, fetched_at FROM lyrics_cache WHERE key = ?1",
        params![key],
        |r| {
            Ok((
                r.get::<_, i64>(0)? != 0,
                r.get::<_, i64>(1)? != 0,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, i64>(4)?,
            ))
        },
    )
    .ok()
    .and_then(|(found, instrumental, synced, plain, at)| {
        if found {
            Some(Some(Found { synced, plain, instrumental, duration: None }))
        } else if now_secs() - at < MISS_TTL_SECS {
            Some(None)
        } else {
            None
        }
    })
}

fn cache_put(conn: &Connection, key: &str, f: Option<&Found>) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO lyrics_cache (key, found, instrumental, synced, plain, fetched_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            key,
            f.is_some() as i64,
            f.map_or(false, |f| f.instrumental) as i64,
            f.and_then(|f| f.synced.clone()),
            f.and_then(|f| f.plain.clone()),
            now_secs()
        ],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

// --- Files -------------------------------------------------------------------

fn sidecar_lrc(path: &str) -> PathBuf {
    Path::new(path).with_extension("lrc")
}

fn sidecar_txt(path: &str) -> PathBuf {
    Path::new(path).with_extension("txt")
}

fn read_meta(path: &str) -> Result<(Meta, crate::models::TagData), String> {
    let tagged = lofty::read_from_path(path).map_err(|e| e.to_string())?;
    let duration = tagged.properties().duration().as_secs_f64();
    let tags = files::tag_data_from(tagged);
    let meta = Meta {
        artist: tags.artist.clone().unwrap_or_default().trim().to_string(),
        title: tags.title.clone().unwrap_or_default().trim().to_string(),
        album: tags.album.clone().unwrap_or_default().trim().to_string(),
        duration_secs: (duration > 0.0).then_some(duration),
    };
    Ok((meta, tags))
}

// --- Commands ----------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricsResult {
    pub path: String,
    /// `synced`, `plain`, `instrumental`, `notFound`, `have` (already stored,
    /// not overwritten) or `error`.
    pub status: String,
    pub detail: Option<String>,
    pub sidecar: Option<String>,
    pub embedded: bool,
}

impl LyricsResult {
    fn new(path: &str, status: &str) -> Self {
        Self { path: path.to_string(), status: status.to_string(), detail: None, sidecar: None, embedded: false }
    }
    fn error(path: &str, e: impl ToString) -> Self {
        Self { detail: Some(e.to_string()), ..Self::new(path, "error") }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Storage {
    Sidecar,
    Embedded,
    Both,
}

impl Storage {
    fn sidecar(self) -> bool {
        matches!(self, Storage::Sidecar | Storage::Both)
    }
    fn embedded(self) -> bool {
        matches!(self, Storage::Embedded | Storage::Both)
    }
}

/// Writes what was found. Synced lyrics go to `.lrc`; lyrics with no timing
/// go to `.txt` (a `.lrc` without timestamps would look synced to karaoke
/// tools and show everything at 0:00). Embedding is always plain text - the
/// generic `Tag` API cannot express SYLT without rebuilding the tag.
fn store(path: &str, f: &Found, storage: Storage, overwrite: bool) -> Result<(Option<String>, bool), String> {
    let mut sidecar = None;
    if storage.sidecar() {
        let (target, body) = match (&f.synced, &f.plain) {
            (Some(s), _) => (sidecar_lrc(path), Some(s.clone())),
            (None, Some(p)) => (sidecar_txt(path), Some(p.clone())),
            _ => (sidecar_lrc(path), None),
        };
        if let Some(body) = body {
            if overwrite || !target.exists() {
                std::fs::write(&target, body).map_err(|e| format!("Writing {}: {e}", target.display()))?;
            }
            sidecar = Some(target.to_string_lossy().to_string());
        }
    }
    let mut embedded = false;
    if storage.embedded() {
        let plain = f.plain.clone().or_else(|| f.synced.as_deref().map(strip_timestamps));
        if let Some(text) = plain.filter(|t| !t.trim().is_empty()) {
            files::write_raw_field_blocking(path, "Lyrics", &text)?;
            embedded = true;
        }
    }
    Ok((sidecar, embedded))
}

/// Whether this track already has everything `storage` asks for.
fn already_stored(path: &str, tags: &crate::models::TagData, storage: Storage) -> bool {
    let side = !storage.sidecar() || sidecar_lrc(path).exists() || sidecar_txt(path).exists();
    let emb = !storage.embedded() || tags.all_fields.get("Lyrics").is_some_and(|l| !l.trim().is_empty());
    side && emb
}

async fn fetch_one(
    app: AppHandle,
    client: reqwest::Client,
    path: String,
    storage: Storage,
    overwrite: bool,
) -> LyricsResult {
    let p = path.clone();
    let meta = tauri::async_runtime::spawn_blocking(move || read_meta(&p)).await;
    let (meta, tags) = match meta {
        Ok(Ok(m)) => m,
        Ok(Err(e)) => return LyricsResult::error(&path, e),
        Err(_) => return LyricsResult::error(&path, "Reading the file failed unexpectedly"),
    };
    if !overwrite && already_stored(&path, &tags, storage) {
        return LyricsResult::new(&path, "have");
    }
    if meta.title.is_empty() || meta.artist.is_empty() {
        return LyricsResult {
            detail: Some("Needs an artist and a title tag".into()),
            ..LyricsResult::new(&path, "notFound")
        };
    }
    let key = cache_key(&meta.artist, &meta.title);
    let app2 = app.clone();
    let k2 = key.clone();
    let cached = tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db(&app2)?;
        ensure_cache(&conn)?;
        Ok::<_, String>(cache_get(&conn, &k2))
    })
    .await
    .ok()
    .and_then(Result::ok)
    .flatten();

    let found = match cached {
        Some(f) => f,
        None => {
            let looked = lrclib_lookup(&client, LRCLIB, &meta).await;
            let f = match looked {
                Ok(f) => f,
                // A network failure is not a miss: don't cache it.
                Err(e) => return LyricsResult::error(&path, e),
            };
            let app3 = app.clone();
            let f2 = f.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || {
                let conn = open_db(&app3)?;
                ensure_cache(&conn)?;
                cache_put(&conn, &key, f2.as_ref())
            })
            .await;
            f
        }
    };
    let Some(found) = found else { return LyricsResult::new(&path, "notFound") };
    if found.instrumental && !found.has_text() {
        return LyricsResult::new(&path, "instrumental");
    }
    let status = if found.synced.is_some() { "synced" } else { "plain" };
    let p = path.clone();
    let stored = tauri::async_runtime::spawn_blocking(move || store(&p, &found, storage, overwrite)).await;
    match stored {
        Ok(Ok((sidecar, embedded))) => LyricsResult { sidecar, embedded, ..LyricsResult::new(&path, status) },
        Ok(Err(e)) => LyricsResult::error(&path, e),
        Err(_) => LyricsResult::error(&path, "Saving lyrics failed unexpectedly"),
    }
}

/// Fetches lyrics for `paths` from LRCLIB and stores them. Exactly one result
/// per input path, in order. (The UI calls this in chunks to show progress.)
#[tauri::command]
pub async fn lyrics_fetch(
    app: AppHandle,
    paths: Vec<String>,
    storage: Storage,
    overwrite: bool,
) -> Result<Vec<LyricsResult>, String> {
    let client = http_client()?;
    let mut results: Vec<LyricsResult> = Vec::with_capacity(paths.len());
    for chunk in paths.chunks(CONCURRENCY) {
        let handles: Vec<_> = chunk
            .iter()
            .map(|p| {
                tauri::async_runtime::spawn(fetch_one(
                    app.clone(),
                    client.clone(),
                    p.clone(),
                    storage,
                    overwrite,
                ))
            })
            .collect();
        for (h, p) in handles.into_iter().zip(chunk) {
            results.push(h.await.unwrap_or_else(|_| LyricsResult::error(p, "The lyrics lookup crashed")));
        }
    }
    Ok(results)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricsData {
    pub synced: Option<String>,
    pub plain: Option<String>,
    /// `sidecar`, `embedded` or `cache`.
    pub source: String,
    pub instrumental: bool,
}

/// What we already have for a track, with no network: sidecar `.lrc`/`.txt`,
/// then the embedded tag, then the LRCLIB cache.
fn lyrics_local(app: Option<&AppHandle>, path: &str) -> Option<LyricsData> {
    lyrics_local_with(app, path, None)
}

/// `lyrics_local` for a caller that has already parsed the file (`read_meta`),
/// so a language scan over a whole library reads each file once, not twice.
fn lyrics_local_with(
    app: Option<&AppHandle>,
    path: &str,
    parsed: Option<&(Meta, crate::models::TagData)>,
) -> Option<LyricsData> {
    let mk = |text: String, source: &str| {
        if looks_synced(&text) {
            LyricsData { synced: Some(text), plain: None, source: source.into(), instrumental: false }
        } else {
            LyricsData { synced: None, plain: Some(text), source: source.into(), instrumental: false }
        }
    };
    for side in [sidecar_lrc(path), sidecar_txt(path)] {
        if let Ok(t) = std::fs::read_to_string(&side) {
            if !t.trim().is_empty() {
                return Some(mk(t, "sidecar"));
            }
        }
    }
    let read;
    let (meta, tags) = match parsed {
        Some((m, t)) => (m, t),
        None => {
            read = read_meta(path).ok()?;
            (&read.0, &read.1)
        }
    };
    if let Some(t) = tags.all_fields.get("Lyrics").filter(|t| !t.trim().is_empty()) {
        return Some(mk(t.clone(), "embedded"));
    }
    let app = app?;
    let conn = open_db(app).ok()?;
    ensure_cache(&conn).ok()?;
    match cache_get(&conn, &cache_key(&meta.artist, &meta.title))?? {
        Found { synced: None, plain: None, instrumental: true, .. } => {
            Some(LyricsData { synced: None, plain: None, source: "cache".into(), instrumental: true })
        }
        f => Some(LyricsData { synced: f.synced, plain: f.plain, source: "cache".into(), instrumental: f.instrumental }),
    }
}

#[tauri::command]
pub async fn lyrics_for_path(app: AppHandle, path: String) -> Result<Option<LyricsData>, String> {
    tauri::async_runtime::spawn_blocking(move || lyrics_local(Some(&app), &path))
        .await
        .map_err(|_| "Reading lyrics failed unexpectedly".to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LangSuggestion {
    pub path: String,
    /// ISO 639-2/3 code, `zxx` for an instrumental. `None` = no suggestion.
    pub code: Option<String>,
    pub confidence: f64,
    /// `high` / `low`, see [`guess_language`].
    pub level: Option<Level>,
    /// `lyrics`, `instrumental` or `title`.
    pub source: String,
    pub error: Option<String>,
}

fn suggest_one(app: &AppHandle, path: &str) -> LangSuggestion {
    let none = |source: &str, error: Option<String>| LangSuggestion {
        path: path.to_string(),
        code: None,
        confidence: 0.0,
        level: None,
        source: source.to_string(),
        error,
    };
    let parsed = match read_meta(path) {
        Ok(m) => m,
        Err(e) => return none("title", Some(e)),
    };
    let meta = &parsed.0;
    if let Some(l) = lyrics_local_with(Some(app), path, Some(&parsed)) {
        if l.instrumental {
            return LangSuggestion {
                code: Some("zxx".into()),
                confidence: 1.0,
                level: Some(Level::High),
                ..none("instrumental", None)
            };
        }
        let text = match (&l.synced, &l.plain) {
            (Some(s), _) => strip_timestamps(s),
            (None, Some(p)) => p.clone(),
            _ => String::new(),
        };
        if let Some(g) = guess_language(&text, TextSource::Lyrics) {
            return LangSuggestion {
                code: Some(g.code),
                confidence: g.confidence,
                level: Some(g.level),
                ..none("lyrics", None)
            };
        }
    }
    let text = format!("{} {}", meta.title, meta.artist);
    match guess_language(&text, TextSource::TitleArtist) {
        Some(g) => LangSuggestion {
            code: Some(g.code),
            confidence: g.confidence,
            level: Some(g.level),
            ..none("title", None)
        },
        None => none("title", None),
    }
}

/// Offline language suggestions: from stored lyrics (sidecar, embedded or
/// cached) when there are some, else from title + artist at low confidence.
/// One result per input path, in order. Writes nothing.
#[tauri::command]
pub async fn detect_languages(app: AppHandle, paths: Vec<String>) -> Result<Vec<LangSuggestion>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        files::par_map(
            &paths,
            |p| suggest_one(&app, p),
            |p| LangSuggestion {
                path: p.clone(),
                code: None,
                confidence: 0.0,
                level: None,
                source: "title".into(),
                error: Some("Detection crashed on this file".into()),
            },
        )
    })
    .await
    .map_err(|_| "Language detection failed unexpectedly".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_timestamps_in_every_lrc_flavour() {
        let src = "[ar:Someone]\n[ti:Song]\n[00:12.00]First\n[00:15.5]Second\n[01:02.345]Third\n[01:05]Fourth\n[00:20.00][00:40.00]Chorus\n";
        let lines = parse_lrc(src);
        let got: Vec<(u32, &str)> = lines.iter().map(|l| (l.time_ms, l.text.as_str())).collect();
        assert_eq!(
            got,
            vec![
                (12_000, "First"),
                (15_500, "Second"),
                (20_000, "Chorus"),
                (40_000, "Chorus"),
                (62_345, "Third"),
                (65_000, "Fourth"),
            ]
        );
    }

    #[test]
    fn offset_tag_shifts_lines_and_never_goes_negative() {
        let lines = parse_lrc("[offset:+500]\n[00:00.20]a\n[00:10.00]b\n");
        assert_eq!(lines[0].time_ms, 0);
        assert_eq!(lines[1].time_ms, 9_500);
    }

    #[test]
    fn plain_text_is_not_synced_and_strips_to_itself() {
        let plain = "Just words\nmore words";
        assert!(!looks_synced(plain));
        assert_eq!(strip_timestamps(plain), plain);
        assert!(parse_lrc(plain).is_empty());
    }

    #[test]
    fn strip_keeps_blank_lines_and_drops_metadata() {
        let lrc = "[ar:X]\n[00:01.00]Hello\n[00:02.00]\n[00:03.00]World\n";
        assert_eq!(strip_timestamps(lrc), "Hello\n\nWorld");
    }

    #[test]
    fn bad_timestamps_are_rejected() {
        assert_eq!(parse_timestamp("ar:Someone"), None);
        assert_eq!(parse_timestamp("00:xx.00"), None);
        assert_eq!(parse_timestamp("00:12.ab"), None);
        assert_eq!(parse_timestamp("01:02.5"), Some(62_500));
    }

    const SPANISH: &str = "Yo te quiero tanto que no puedo vivir sin ti, cada noche pienso en tu sonrisa y en tus ojos, bailando contigo toda la noche bajo la luna";
    const ENGLISH: &str = "I just want to dance with you all night long, under the stars and the moon, holding you close and never letting go of this feeling";

    #[test]
    fn long_lyrics_are_detected_with_high_confidence() {
        let es = guess_language(SPANISH, TextSource::Lyrics).unwrap();
        assert_eq!((es.code.as_str(), es.level), ("spa", Level::High));
        let en = guess_language(ENGLISH, TextSource::Lyrics).unwrap();
        assert_eq!((en.code.as_str(), en.level), ("eng", Level::High));
    }

    #[test]
    fn short_text_gives_no_guess() {
        assert!(guess_language("La la la", TextSource::Lyrics).is_none());
        assert!(guess_language("Hi", TextSource::TitleArtist).is_none());
        assert!(guess_language("12345 67890 !!!", TextSource::Lyrics).is_none());
    }

    #[test]
    fn a_title_guess_is_never_high() {
        if let Some(g) = guess_language("Quiero bailar contigo esta noche Shakira", TextSource::TitleArtist) {
            assert_eq!(g.level, Level::Low);
        }
    }

    #[test]
    fn pick_best_prefers_synced_close_duration() {
        let list: Vec<Value> = serde_json::from_str(
            r#"[
              {"duration": 300, "syncedLyrics": "[00:01.00]long edit", "plainLyrics": "long edit"},
              {"duration": 201, "plainLyrics": "plain only"},
              {"duration": 203, "syncedLyrics": "[00:01.00]a\n[00:02.00]b", "plainLyrics": "a\nb"},
              {"duration": 200, "instrumental": true}
            ]"#,
        )
        .unwrap();
        let best = pick_best(&list, Some(200.0)).unwrap();
        assert!(best.synced.unwrap().contains("[00:02.00]b"));
        // Nothing within 4 s -> nothing.
        assert!(pick_best(&list[..1], Some(200.0)).is_none());
        // Instrumental only counts when nothing has text.
        let only_inst = pick_best(&list[3..], Some(200.0)).unwrap();
        assert!(only_inst.instrumental && !only_inst.has_text());
    }

    #[test]
    fn title_and_artist_cleaning() {
        assert_eq!(clean_title("Gravity (Original Mix) [Remastered]"), "Gravity");
        assert_eq!(clean_title("Song feat. Someone"), "Song");
        assert_eq!(clean_title("Song - Radio Edit"), "Song");
        assert_eq!(first_artist("Bad Bunny, Drake"), "Bad Bunny");
        assert_eq!(first_artist("A & B"), "A");
        assert_eq!(first_artist("Solo"), "Solo");
    }

    #[test]
    fn cache_round_trips_hits_and_misses() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_cache(&conn).unwrap();
        let key = cache_key("  The  Artist ", "Song");
        assert_eq!(key, cache_key("the artist", "SONG"));
        assert_eq!(cache_get(&conn, &key), None);
        cache_put(&conn, &key, None).unwrap();
        assert_eq!(cache_get(&conn, &key), Some(None));
        let f = Found { synced: Some("[00:01.00]x".into()), plain: Some("x".into()), instrumental: false, duration: None };
        cache_put(&conn, &key, Some(&f)).unwrap();
        assert_eq!(cache_get(&conn, &key), Some(Some(f)));
        // An expired miss is treated as not cached.
        conn.execute("UPDATE lyrics_cache SET found = 0, fetched_at = 1", []).unwrap();
        assert_eq!(cache_get(&conn, &key), None);
    }

    /// The app installs the TLS provider at startup; tests that reach the network must too.
    fn live_client() -> reqwest::Client {
        let _ = rustls::crypto::ring::default_provider().install_default();
        http_client().unwrap()
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mtc-lyrics-{name}-{}",
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn minimal_mp3() -> Vec<u8> {
        let mut bytes = Vec::new();
        for _ in 0..20 {
            bytes.extend_from_slice(&[0xFF, 0xFB, 0x90, 0x00]);
            bytes.extend(std::iter::repeat(0u8).take(413));
        }
        bytes
    }

    #[test]
    fn storing_writes_sidecars_and_embeds_plain_text() {
        let dir = scratch("store");
        let path = dir.join("t.mp3");
        std::fs::write(&path, minimal_mp3()).unwrap();
        let p = path.to_str().unwrap();
        let synced = Found {
            synced: Some("[00:01.00]one\n[00:02.00]two".into()),
            plain: None,
            instrumental: false,
            duration: None,
        };
        let (side, emb) = store(p, &synced, Storage::Both, false).unwrap();
        assert!(side.unwrap().ends_with("t.lrc"));
        assert!(emb);
        assert!(std::fs::read_to_string(dir.join("t.lrc")).unwrap().contains("[00:02.00]two"));
        // Embedded copy has no timestamps, and the read path finds it.
        let tags = files::read_tags_impl(p).unwrap();
        assert_eq!(tags.all_fields.get("Lyrics").map(String::as_str), Some("one\ntwo"));
        // An existing sidecar is not clobbered without `overwrite`.
        std::fs::write(dir.join("t.lrc"), "mine").unwrap();
        store(p, &synced, Storage::Sidecar, false).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("t.lrc")).unwrap(), "mine");
        store(p, &synced, Storage::Sidecar, true).unwrap();
        assert!(std::fs::read_to_string(dir.join("t.lrc")).unwrap().contains("one"));
        // Plain-only lyrics become .txt, never a timestamp-less .lrc.
        let plain = Found { plain: Some("just words".into()), ..Found::default() };
        let q = dir.join("u.mp3");
        std::fs::write(&q, minimal_mp3()).unwrap();
        let (side, _) = store(q.to_str().unwrap(), &plain, Storage::Sidecar, false).unwrap();
        assert!(side.unwrap().ends_with("u.txt"));
        assert!(!dir.join("u.lrc").exists());
        let local = lyrics_local(None, q.to_str().unwrap()).unwrap();
        assert_eq!(local.plain.as_deref(), Some("just words"));
        assert_eq!(local.source, "sidecar");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn already_stored_follows_the_chosen_storage() {
        let dir = scratch("have");
        let path = dir.join("t.mp3");
        std::fs::write(&path, minimal_mp3()).unwrap();
        let p = path.to_str().unwrap();
        let tags = crate::models::TagData::default();
        assert!(!already_stored(p, &tags, Storage::Sidecar));
        std::fs::write(dir.join("t.lrc"), "[00:01.00]x").unwrap();
        assert!(already_stored(p, &tags, Storage::Sidecar));
        assert!(!already_stored(p, &tags, Storage::Both));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Measures the hit rate on a real library. `MTC_LYRICS_SAMPLE` is a JSON
    /// array of `{artist,title,album,duration}` (read from a *copy* of the
    /// index; no audio file is opened or written). Prints a tally and every
    /// language guess. `cargo test hit_rate -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn lyrics_hit_rate_on_a_sample() {
        let Ok(path) = std::env::var("MTC_LYRICS_SAMPLE") else { return };
        let rows: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let client = live_client();
        let (mut synced, mut plain, mut inst, mut miss, mut err) = (0, 0, 0, 0, 0);
        let (mut high, mut low, mut none) = (0, 0, 0);
        for r in &rows {
            let s = |k: &str| r.get(k).and_then(Value::as_str).unwrap_or("").to_string();
            let m = Meta {
                artist: s("artist"),
                title: s("title"),
                album: s("album"),
                duration_secs: r.get("duration").and_then(Value::as_f64),
            };
            match tauri::async_runtime::block_on(lrclib_lookup(&client, LRCLIB, &m)) {
                Err(e) => {
                    err += 1;
                    eprintln!("ERR  {} - {}: {e}", m.artist, m.title);
                }
                Ok(None) => miss += 1,
                Ok(Some(f)) if f.instrumental && !f.has_text() => inst += 1,
                Ok(Some(f)) => {
                    if f.synced.is_some() { synced += 1 } else { plain += 1 }
                    let text = f.synced.as_deref().map(strip_timestamps).or(f.plain.clone()).unwrap_or_default();
                    match guess_language(&text, TextSource::Lyrics) {
                        Some(g) => {
                            if g.level == Level::High { high += 1 } else { low += 1 }
                            eprintln!("LANG {:?} {:.2} {} - {}", g.level, g.confidence, g.code, m.title);
                        }
                        None => none += 1,
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(300));
        }
        let n = rows.len();
        eprintln!("TOTAL {n}: synced {synced}, plain {plain}, instrumental {inst}, miss {miss}, error {err}");
        eprintln!("LANGUAGE from lyrics: high {high}, low {low}, none {none}");
    }

    /// Live: `cargo test -- --ignored lrclib_live`. Needs network.
    #[test]
    #[ignore]
    fn lrclib_live_finds_a_famous_song() {
        let client = live_client();
        let m = Meta {
            artist: "Rick Astley".into(),
            title: "Never Gonna Give You Up".into(),
            album: String::new(),
            duration_secs: Some(213.0),
        };
        let found = tauri::async_runtime::block_on(lrclib_lookup(&client, LRCLIB, &m)).unwrap().expect("LRCLIB should know this one");
        assert!(found.synced.as_deref().is_some_and(looks_synced));
        let g = guess_language(&strip_timestamps(found.synced.as_deref().unwrap()), TextSource::Lyrics).unwrap();
        assert_eq!(g.code, "eng");
    }
}
