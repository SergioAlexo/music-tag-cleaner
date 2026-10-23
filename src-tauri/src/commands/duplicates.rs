//! Audio-content duplicate detection (v0.8 F1).
//!
//! Three stages, cheapest first:
//! 1. **Exact** — a blake3 hash of the file bytes catches literal copies.
//! 2. **Fingerprint** — a Chromaprint-compatible fingerprint (`rusty-chromaprint`,
//!    pure Rust, no external binary) computed from PCM decoded by `symphonia`.
//!    Both are cached in a small local sqlite database keyed by path + mtime +
//!    size, so re-scanning an unchanged library is nearly free.
//! 3. **Match** — `rusty-chromaprint::match_fingerprints` gives alignment-
//!    tolerant segments, which we use to tell a real duplicate from a radio
//!    edit vs. extended mix of the same track (see `classify_pair`).

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use rusqlite::{params, Connection, OptionalExtension};
use rusty_chromaprint::{match_fingerprints, Configuration, Fingerprinter};
use serde::{Deserialize, Serialize};
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use tauri::{AppHandle, Emitter, Manager};

/// A duplicate/alternate-version group returned to the frontend. Facts for
/// judging which to keep (bitrate, tags, etc.) are looked up on the frontend
/// via the existing `list_files`/`read_tags_batch` commands — this only
/// carries what the matching itself produced.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateGroup {
    pub id: String,
    /// "duplicate" (same recording, safe to consider deleting) or
    /// "alternate" (e.g. radio edit vs. extended mix — never auto-suggested
    /// for deletion).
    pub kind: String,
    pub paths: Vec<String>,
    /// 0 (exact byte-identical) explanation, or the best pairwise chromaprint
    /// score in the group (lower = more similar; see `classify_pair`).
    pub score: f64,
    /// How the group was found: "audio" (fingerprints), "tags" (same
    /// artist+title from tags/file name, audio not confirmed) or "tags+audio"
    /// (tags and a partial fingerprint overlap agree).
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CachedFingerprint {
    pub(crate) blake3: String,
    pub(crate) fingerprint: Vec<u32>,
    pub(crate) duration_secs: f64,
    pub(crate) sample_rate: u32,
}

fn emit_progress(app: &AppHandle, done: usize, total: usize, phase: &str) {
    let _ = app.emit(
        "duplicate-scan-progress",
        serde_json::json!({ "done": done, "total": total, "phase": phase }),
    );
}

pub(crate) fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("fingerprint-cache.sqlite"))
}

/// Every cache column besides the path+mtime+size identity is nullable —
/// fingerprinting (F1) and waveform generation (F3) populate this table
/// independently (a file can have one without the other yet), and both
/// upsert by path rather than requiring a row to already exist. Reads
/// always re-check mtime/size, so a stale value left in an unrelated column
/// by a since-changed file is simply never returned, not a correctness risk.
/// Shared as a constant (rather than duplicated in tests) so the schema
/// used by `open_db` and by tests constructing their own connection can
/// never drift apart.
const FILE_CACHE_SCHEMA_SQL: &str = "CREATE TABLE IF NOT EXISTS file_cache (
    path TEXT PRIMARY KEY,
    mtime INTEGER NOT NULL,
    size INTEGER NOT NULL,
    blake3_hash TEXT,
    fingerprint TEXT,
    duration_secs REAL,
    sample_rate INTEGER,
    waveform_peaks TEXT,
    algo_version INTEGER
);";

/// Bump whenever `fingerprint_config()` or `WAVEFORM_BUCKETS` changes. A
/// cached row is only trusted when its `algo_version` matches this constant
/// (see `get_or_compute`/`get_or_compute_waveform`), so an algorithm change
/// invalidates existing cached fingerprints/waveforms instead of silently
/// comparing them against ones computed a different way — no manual
/// cache-clear step needed.
const ALGO_VERSION: i64 = 1;

pub(crate) fn open_db(app: &AppHandle) -> Result<Connection, String> {
    let conn = Connection::open(db_path(app)?).map_err(|e| e.to_string())?;
    // Waveforms are requested per row while a scan may be writing; WAL lets
    // those reads proceed, and the busy timeout makes a second writer wait
    // instead of failing with "database is locked".
    let _ = conn.pragma_update(None, "journal_mode", "WAL");
    let _ = conn.pragma_update(None, "synchronous", "NORMAL");
    let _ = conn.busy_timeout(std::time::Duration::from_secs(10));
    conn.execute_batch(FILE_CACHE_SCHEMA_SQL).map_err(|e| e.to_string())?;
    // `algo_version` was added after the original schema shipped — a fresh
    // database gets it from FILE_CACHE_SCHEMA_SQL above, but an existing
    // one predates the column. SQLite has no "ADD COLUMN IF NOT EXISTS", so
    // the "duplicate column name" error from a database that already has it
    // is simply ignored.
    let _ = conn.execute("ALTER TABLE file_cache ADD COLUMN algo_version INTEGER", []);
    Ok(conn)
}

fn file_stat(path: &Path) -> Result<(i64, i64), String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    let mtime = meta
        .modified()
        .map_err(|e| e.to_string())?
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs() as i64;
    Ok((mtime, meta.len() as i64))
}

fn compute_blake3(path: &Path) -> Result<String, String> {
    // Streamed rather than `fs::read` + hash: a long WAV is 50-100 MB, and
    // with fingerprinting running on several threads at once, holding whole
    // files in memory just to hash them added up to gigabytes.
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = blake3::Hasher::new();
    hasher
        .update_reader(std::io::BufReader::with_capacity(1 << 16, file))
        .map_err(|e| e.to_string())?;
    Ok(hasher.finalize().to_hex().to_string())
}

/// Fingerprint matching only needs the first couple of minutes of a track —
/// far cheaper than decoding a whole DJ mix start to end.
const FINGERPRINT_MAX_SAMPLES: usize = 44_100 * 2 * 120; // ~120s stereo @44.1kHz worst case

/// Decodes audio packet by packet, handing each packet's interleaved i16
/// samples to `sink` along with the stream's sample rate and channel count.
/// Stops early once `max_samples` interleaved samples have been delivered
/// (`None` decodes the whole file). Returns `(sample_rate, channels,
/// frames_decoded)`.
///
/// Streaming rather than collecting: the waveform needs the whole track, and
/// buffering a 10-minute WAV as PCM first cost ~100 MB per request; the
/// fingerprinter consumes samples incrementally anyway.
fn decode_stream(
    path: &str,
    max_samples: Option<usize>,
    mut sink: impl FnMut(&[i16], u32, u32),
) -> Result<(u32, u32, u64), String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = Path::new(path).extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let mut format = symphonia::default::get_probe()
        .probe(&hint, mss, FormatOptions::default(), MetadataOptions::default())
        .map_err(|e| format!("unsupported audio format: {e}"))?;
    let track = format
        .default_track(TrackType::Audio)
        .ok_or_else(|| "no audio track found".to_string())?;
    let track_id = track.id;
    let codec_params = track
        .codec_params
        .as_ref()
        .ok_or_else(|| "missing codec parameters".to_string())?
        .audio()
        .ok_or_else(|| "not an audio codec".to_string())?
        .clone();
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(&codec_params, &AudioDecoderOptions::default())
        .map_err(|e| format!("unsupported codec: {e}"))?;

    let mut chunk: Vec<i16> = Vec::new();
    let mut delivered = 0usize;
    let mut sample_rate = 0u32;
    let mut channels = 0u32;
    let mut total_frames: u64 = 0;

    loop {
        let packet = match format.next_packet() {
            Ok(Some(p)) => p,
            Ok(None) | Err(SymError::ResetRequired) | Err(_) => break,
        };
        if packet.track_id != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(audio_buf) => {
                if sample_rate == 0 {
                    sample_rate = audio_buf.spec().rate();
                    channels = (audio_buf.spec().channels().count() as u32).max(1);
                }
                total_frames += audio_buf.frames() as u64;
                // One scratch buffer reused across packets instead of a fresh
                // allocation per packet.
                chunk.resize(audio_buf.samples_interleaved(), 0);
                audio_buf.copy_to_slice_interleaved(&mut chunk);
                sink(&chunk, sample_rate, channels);
                delivered += chunk.len();
                if max_samples.is_some_and(|max| delivered >= max) {
                    break;
                }
            }
            Err(SymError::DecodeError(_)) => continue,
            Err(_) => break,
        }
    }

    if sample_rate == 0 {
        return Err("could not decode any audio frames".to_string());
    }
    Ok((sample_rate, channels, total_frames))
}

/// Decodes to one interleaved PCM buffer, capped like the fingerprint pass.
/// Only the tests need the samples themselves; the app streams them.
#[cfg(test)]
fn decode_to_pcm(path: &str) -> Result<(Vec<i16>, u32, u32, f64), String> {
    let mut pcm = Vec::new();
    let (rate, channels, frames) =
        decode_stream(path, Some(FINGERPRINT_MAX_SAMPLES), |s, _, _| pcm.extend_from_slice(s))?;
    Ok((pcm, rate, channels, frames as f64 / rate as f64))
}

/// The one Chromaprint configuration used everywhere a fingerprint is
/// computed or compared — two fingerprints are only comparable if they were
/// both produced with the same configuration, so this is centralized rather
/// than each call site picking its own preset.
///
/// Silence removal was added after testing against a real library turned up
/// a concrete false positive: three completely unrelated songs clustered
/// into one "alternate version" group. `preset_test2()` alone (no silence
/// removal) lets a quiet/faded intro or outro — low-energy audio carries
/// almost no distinguishing chroma information — spuriously "match" across
/// otherwise unrelated tracks. `with_removed_silence` (threshold from the
/// crate's own `preset_test4`) skips those frames instead of fingerprinting
/// near-silence as if it were real content.
fn fingerprint_config() -> Configuration {
    Configuration::preset_test2().with_removed_silence(50)
}

#[cfg(test)]
fn compute_fingerprint(pcm: &[i16], sample_rate: u32, channels: u32) -> Result<Vec<u32>, String> {
    let config = fingerprint_config();
    let mut printer = Fingerprinter::new(&config);
    printer
        .start(sample_rate, channels)
        .map_err(|e| format!("fingerprinter reset failed: {e:?}"))?;
    printer.consume(pcm);
    printer.finish();
    Ok(printer.fingerprint().to_vec())
}

/// Hashes and fingerprints one file from scratch (no cache).
///
/// Samples go straight from the decoder into the fingerprinter. Its input
/// stage buffers internally and only ever processes full fixed-size blocks,
/// so feeding it packet by packet yields exactly the fingerprint one big
/// buffer would — which matters, because imported Rekordbox cues are keyed by
/// a hash of the fingerprint.
fn compute_fingerprint_file(path: &str) -> Result<CachedFingerprint, String> {
    let blake3 = compute_blake3(Path::new(path))?;
    let config = fingerprint_config();
    let mut printer = Fingerprinter::new(&config);
    let mut start_error: Option<String> = None;
    let mut started = false;
    let (sample_rate, _channels, frames) =
        decode_stream(path, Some(FINGERPRINT_MAX_SAMPLES), |samples, rate, channels| {
            if !started {
                started = true;
                if let Err(e) = printer.start(rate, channels) {
                    start_error = Some(format!("fingerprinter reset failed: {e:?}"));
                }
            }
            if start_error.is_none() {
                printer.consume(samples);
            }
        })?;
    if let Some(e) = start_error {
        return Err(e);
    }
    printer.finish();
    Ok(CachedFingerprint {
        blake3,
        fingerprint: printer.fingerprint().to_vec(),
        // The audio actually fingerprinted (capped), not the track length.
        duration_secs: frames as f64 / sample_rate as f64,
        sample_rate,
    })
}

/// The cached fingerprint for `path`, if one exists for this exact file
/// state (mtime + size) and this build's `ALGO_VERSION`.
fn cached_fingerprint(
    conn: &Connection,
    path: &str,
    mtime: i64,
    size: i64,
) -> Result<Option<CachedFingerprint>, String> {
    let cached: Option<(Option<String>, Option<String>, Option<f64>, Option<u32>, Option<i64>)> = conn
        .prepare_cached(
            "SELECT blake3_hash, fingerprint, duration_secs, sample_rate, algo_version FROM file_cache
             WHERE path = ?1 AND mtime = ?2 AND size = ?3",
        )
        .and_then(|mut stmt| {
            stmt.query_row(params![path, mtime, size], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
            })
            .optional()
        })
        .map_err(|e| e.to_string())?;
    // All four fingerprint columns must be present — a row that only has a
    // cached waveform (F3, computed independently) doesn't count as a
    // fingerprint hit — and `algo_version` must match this build's, or a
    // fingerprint computed under a since-changed `fingerprint_config()`
    // would be returned as if it were still comparable to a fresh one.
    Ok(match cached {
        Some((Some(blake3), Some(fp_str), Some(duration_secs), Some(sample_rate), Some(v)))
            if v == ALGO_VERSION =>
        {
            Some(CachedFingerprint {
                blake3,
                fingerprint: fp_str.split(',').filter_map(|s| s.parse().ok()).collect(),
                duration_secs,
                sample_rate,
            })
        }
        _ => None,
    })
}

fn store_fingerprint(
    conn: &Connection,
    path: &str,
    mtime: i64,
    size: i64,
    fp: &CachedFingerprint,
) -> Result<(), String> {
    let fp_str = fp.fingerprint.iter().map(|v| v.to_string()).collect::<Vec<_>>().join(",");
    // The waveform cache (F3) is written by a separate upsert keyed on the
    // same path — preserve it only if mtime/size (the file's content) are
    // unchanged from what's already stored; if they differ, the existing
    // waveform_peaks belongs to an old version of this file and must not be
    // carried forward under the new mtime/size stamp, or a future waveform
    // read would silently return stale data for the changed file.
    conn.prepare_cached(
        "INSERT INTO file_cache (path, mtime, size, blake3_hash, fingerprint, duration_secs, sample_rate, algo_version)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(path) DO UPDATE SET
            mtime = excluded.mtime, size = excluded.size,
            blake3_hash = excluded.blake3_hash, fingerprint = excluded.fingerprint,
            duration_secs = excluded.duration_secs, sample_rate = excluded.sample_rate,
            algo_version = excluded.algo_version,
            waveform_peaks = CASE
                WHEN file_cache.mtime = excluded.mtime AND file_cache.size = excluded.size
                     AND file_cache.algo_version IS excluded.algo_version
                THEN file_cache.waveform_peaks ELSE NULL
            END",
    )
    .and_then(|mut stmt| {
        stmt.execute(params![
            path,
            mtime,
            size,
            fp.blake3,
            fp_str,
            fp.duration_secs,
            fp.sample_rate,
            ALGO_VERSION
        ])
    })
    .map(|_| ())
    .map_err(|e| e.to_string())
}

pub(crate) fn get_or_compute(conn: &Connection, path: &str) -> Result<CachedFingerprint, String> {
    let (mtime, size) = file_stat(Path::new(path))?;
    if let Some(fp) = cached_fingerprint(conn, path, mtime, size)? {
        return Ok(fp);
    }
    let fp = compute_fingerprint_file(path)?;
    store_fingerprint(conn, path, mtime, size, &fp)?;
    Ok(fp)
}

/// `get_or_compute` for many files: cache hits are read first, the misses
/// are decoded and fingerprinted in parallel (`par_map` — this is CPU-bound
/// decode + FFT work that used to run on a single core), and every new
/// fingerprint is written back in one transaction rather than one implicit
/// transaction (and fsync) per file. Results come back in input order.
///
/// `on_progress(done, total)` is called from worker threads as files finish.
pub(crate) fn fingerprint_many(
    conn: &mut Connection,
    paths: &[String],
    on_progress: impl Fn(usize, usize) + Sync,
) -> Vec<Result<CachedFingerprint, String>> {
    use std::sync::atomic::{AtomicUsize, Ordering};

    let total = paths.len();
    let mut results: Vec<Option<Result<CachedFingerprint, String>>> = Vec::with_capacity(total);
    // (index into `paths`, mtime, size) of each file that needs computing.
    let mut misses: Vec<(usize, i64, i64)> = Vec::new();
    for (i, path) in paths.iter().enumerate() {
        let hit = file_stat(Path::new(path)).and_then(|(mtime, size)| {
            let cached = cached_fingerprint(conn, path, mtime, size)?;
            if cached.is_none() {
                misses.push((i, mtime, size));
            }
            Ok(cached)
        });
        results.push(match hit {
            Ok(Some(fp)) => Some(Ok(fp)),
            Ok(None) => None,
            Err(e) => Some(Err(e)),
        });
    }

    let done = AtomicUsize::new(total - misses.len());
    on_progress(done.load(Ordering::Relaxed), total);
    let computed = crate::commands::files::par_map(
        &misses,
        |&(i, _, _)| {
            let fp = compute_fingerprint_file(&paths[i]);
            on_progress(done.fetch_add(1, Ordering::Relaxed) + 1, total);
            fp
        },
        |_| Err(crate::commands::files::CRASHED.to_string()),
    );

    // Caching is an optimisation: a failed write must not fail the scan.
    if let Ok(tx) = conn.transaction() {
        for (&(i, mtime, size), fp) in misses.iter().zip(&computed) {
            if let Ok(fp) = fp {
                let _ = store_fingerprint(&tx, &paths[i], mtime, size, fp);
            }
        }
        let _ = tx.commit();
    }
    for (&(i, _, _), fp) in misses.iter().zip(computed) {
        results[i] = Some(fp);
    }
    results
        .into_iter()
        .map(|r| r.unwrap_or_else(|| Err("fingerprint was not computed".to_string())))
        .collect()
}

/// Waveform peaks are downsampled to this many buckets — enough visual
/// resolution for spotting a duplicate/alternate-version's shape or a
/// track's structure, small enough to be a trivially cheap payload.
const WAVEFORM_BUCKETS: usize = 400;

/// Frames per block while streaming peaks. The final buckets are the max
/// over consecutive blocks, so this only bounds memory (~250 KB for a
/// 10-minute track) and is far narrower than one bucket of any real track.
const WAVEFORM_BLOCK_FRAMES: usize = 256;

/// Peak (max absolute amplitude, 0.0-1.0) per block of frames, built while
/// decoding so a track's PCM is never held in memory as a whole.
#[derive(Default)]
struct PeakBuilder {
    blocks: Vec<f32>,
    block_max: i32,
    in_block: usize,
}

impl PeakBuilder {
    fn to_peak(max_abs: i32) -> f32 {
        (max_abs as f32 / i16::MAX as f32).min(1.0)
    }

    /// One mono frame (channels already averaged).
    fn push(&mut self, mono: i32) {
        self.block_max = self.block_max.max(mono.abs());
        self.in_block += 1;
        if self.in_block == WAVEFORM_BLOCK_FRAMES {
            self.blocks.push(Self::to_peak(self.block_max));
            self.block_max = 0;
            self.in_block = 0;
        }
    }

    fn finish(mut self) -> Vec<f32> {
        if self.in_block > 0 {
            self.blocks.push(Self::to_peak(self.block_max));
        }
        bucket_peaks(&self.blocks)
    }
}

/// Peaks plus how many seconds of audio actually went into them, so a decode
/// that stopped early (corrupt frame, truncated file) can be told apart from a
/// complete one.
struct WaveformResult {
    peaks: Vec<f32>,
    decoded_secs: f64,
}

/// Symphonia pass. A decode error half way through keeps what was decoded so
/// far - a partial waveform beats none - and only "nothing decoded at all" is
/// an error.
fn compute_waveform_symphonia(path: &str) -> Result<WaveformResult, String> {
    let mut builder = PeakBuilder::default();
    let (rate, _channels, frames) = decode_stream(path, None, |samples, _rate, channels| {
        let channels = channels.max(1) as usize;
        for frame in samples.chunks_exact(channels) {
            let sum: i32 = frame.iter().map(|&s| s as i32).sum();
            builder.push(sum / channels as i32);
        }
    })?;
    Ok(WaveformResult { peaks: builder.finish(), decoded_secs: frames as f64 / rate.max(1) as f64 })
}

/// Sample rate FFmpeg resamples to for peaks: plenty for a 400-bucket shape
/// and keeps a 1-hour mix to ~57 MB of PCM streamed through, never held.
const FFMPEG_PEAK_RATE: u32 = 8000;

/// FFmpeg fallback for formats/streams symphonia can't (fully) decode.
fn compute_waveform_ffmpeg(ffmpeg: &Path, path: &str) -> Result<WaveformResult, String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-v", "error", "-nostdin", "-i", path, "-vn", "-ac", "1", "-ar", &FFMPEG_PEAK_RATE.to_string()])
        .args(["-f", "s16le", "-"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    crate::commands::ffmpeg::hide_console(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("couldn't start FFmpeg: {e}"))?;
    let mut out = child.stdout.take().ok_or("FFmpeg gave no output")?;
    let mut builder = PeakBuilder::default();
    let mut buf = vec![0u8; 1 << 16];
    let mut carry: Option<u8> = None;
    let mut frames: u64 = 0;
    loop {
        let n = out.read(&mut buf).map_err(|e| format!("reading FFmpeg output failed: {e}"))?;
        if n == 0 {
            break;
        }
        let mut bytes = &buf[..n];
        if let Some(lo) = carry.take() {
            builder.push(i16::from_le_bytes([lo, bytes[0]]) as i32);
            frames += 1;
            bytes = &bytes[1..];
        }
        let pairs = bytes.chunks_exact(2);
        if let [last] = pairs.remainder() {
            carry = Some(*last);
        }
        for pair in pairs {
            builder.push(i16::from_le_bytes([pair[0], pair[1]]) as i32);
            frames += 1;
        }
    }
    let _ = child.wait();
    if frames == 0 {
        return Err("FFmpeg could not decode any audio".to_string());
    }
    Ok(WaveformResult { peaks: builder.finish(), decoded_secs: frames as f64 / FFMPEG_PEAK_RATE as f64 })
}

/// The file's header-declared length, for spotting a decode that stopped early.
fn header_duration_secs(path: &str) -> Option<f64> {
    use lofty::file::AudioFile as _;
    let tf = lofty::probe::Probe::open(path).ok()?.options(lofty::config::ParseOptions::new().read_cover_art(false).read_tags(false)).read().ok()?;
    Some(tf.properties().duration().as_secs_f64()).filter(|d| *d > 0.0)
}

/// A decode that covers less than this share of the header length is treated
/// as having stopped early (and retried with FFmpeg when it is installed).
const WAVEFORM_MIN_COVERAGE: f64 = 0.9;

/// Waveform peaks for one file. Symphonia first; when it fails, yields
/// nothing, or stops well short of the file's length, FFmpeg (if installed)
/// gets a go. Whatever was decoded is kept if nothing better turns up.
fn compute_waveform_file(path: &str, ffmpeg: Option<&Path>) -> Result<Vec<f32>, String> {
    let sym = compute_waveform_symphonia(path);
    let complete = match &sym {
        Ok(r) if !r.peaks.is_empty() => match header_duration_secs(path) {
            Some(h) => r.decoded_secs >= h * WAVEFORM_MIN_COVERAGE - 1.0,
            None => true,
        },
        _ => false,
    };
    if complete {
        return sym.map(|r| r.peaks);
    }
    let mut ffmpeg_err = None;
    if let Some(ff) = ffmpeg {
        match compute_waveform_ffmpeg(ff, path) {
            Ok(f) if !f.peaks.is_empty() => {
                let better = sym.as_ref().map_or(true, |s| f.decoded_secs > s.decoded_secs);
                if better {
                    return Ok(f.peaks);
                }
            }
            Ok(_) => ffmpeg_err = Some("FFmpeg returned no audio".to_string()),
            Err(e) => ffmpeg_err = Some(e),
        }
    }
    match sym {
        Ok(s) if !s.peaks.is_empty() => Ok(s.peaks),
        Ok(_) => Err(waveform_error("no audio could be decoded", ffmpeg.is_some(), ffmpeg_err)),
        Err(e) => Err(waveform_error(&e, ffmpeg.is_some(), ffmpeg_err)),
    }
}

/// A message the UI can show as-is.
fn waveform_error(reason: &str, tried_ffmpeg: bool, ffmpeg_err: Option<String>) -> String {
    match (tried_ffmpeg, ffmpeg_err) {
        (true, Some(f)) => format!("Couldn't generate a waveform: {reason}; FFmpeg fallback also failed ({f})"),
        (true, None) => format!("Couldn't generate a waveform: {reason}"),
        (false, _) => format!("Couldn't generate a waveform: {reason}. Installing FFmpeg (Components page) may help."),
    }
}

/// Folds per-block peaks into at most `WAVEFORM_BUCKETS` buckets (max per bucket).
fn bucket_peaks(blocks: &[f32]) -> Vec<f32> {
    if blocks.len() <= WAVEFORM_BUCKETS {
        return blocks.to_vec();
    }
    (0..WAVEFORM_BUCKETS)
        .map(|k| {
            let start = k * blocks.len() / WAVEFORM_BUCKETS;
            let end = ((k + 1) * blocks.len() / WAVEFORM_BUCKETS).max(start + 1);
            blocks[start..end].iter().copied().fold(0.0, f32::max)
        })
        .collect()
}

/// Without the FFmpeg fallback; the app always passes its FFmpeg (or `None`)
/// to `get_or_compute_waveform_with` itself.
#[cfg(test)]
fn get_or_compute_waveform(conn: &Connection, path: &str) -> Result<Vec<f32>, String> {
    get_or_compute_waveform_with(conn, path, None)
}

/// Cache lookup, then `compute_waveform_file`, then a best-effort cache write.
///
/// An empty or NULL cached value is a cache miss, never "done". The cache
/// write is best-effort: while a duplicate scan holds the write lock (the busy
/// timeout is 10 s) the UPSERT used to fail and take the finished waveform
/// down with it - that track then showed no waveform until the scan ended.
fn get_or_compute_waveform_with(conn: &Connection, path: &str, ffmpeg: Option<&Path>) -> Result<Vec<f32>, String> {
    let (mtime, size) = file_stat(Path::new(path)).map_err(|e| format!("Couldn't read the file: {e}"))?;

    let cached: Option<(Option<String>, Option<i64>)> = conn
        .query_row(
            "SELECT waveform_peaks, algo_version FROM file_cache WHERE path = ?1 AND mtime = ?2 AND size = ?3",
            params![path, mtime, size],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .unwrap_or(None);
    if let Some((Some(peaks_str), Some(v))) = cached {
        if v == ALGO_VERSION {
            let peaks: Vec<f32> = peaks_str.split(',').filter_map(|s| s.parse().ok()).collect();
            if !peaks.is_empty() {
                return Ok(peaks);
            }
        }
    }

    let peaks = compute_waveform_file(path, ffmpeg)?;
    if peaks.is_empty() {
        return Err(waveform_error("no audio could be decoded", ffmpeg.is_some(), None));
    }
    let peaks_str = peaks.iter().map(|p| format!("{p:.4}")).collect::<Vec<_>>().join(",");

    // Same staleness guard as the fingerprint upsert above, mirrored: only
    // carry the existing fingerprint columns forward if mtime/size (the
    // file's content) haven't changed since they were cached.
    let _ = conn.execute(
        "INSERT INTO file_cache (path, mtime, size, waveform_peaks, algo_version)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(path) DO UPDATE SET
            mtime = excluded.mtime, size = excluded.size, waveform_peaks = excluded.waveform_peaks,
            algo_version = excluded.algo_version,
            blake3_hash = CASE
                WHEN file_cache.mtime = excluded.mtime AND file_cache.size = excluded.size
                     AND file_cache.algo_version IS excluded.algo_version
                THEN file_cache.blake3_hash ELSE NULL
            END,
            fingerprint = CASE
                WHEN file_cache.mtime = excluded.mtime AND file_cache.size = excluded.size
                     AND file_cache.algo_version IS excluded.algo_version
                THEN file_cache.fingerprint ELSE NULL
            END,
            duration_secs = CASE
                WHEN file_cache.mtime = excluded.mtime AND file_cache.size = excluded.size
                     AND file_cache.algo_version IS excluded.algo_version
                THEN file_cache.duration_secs ELSE NULL
            END,
            sample_rate = CASE
                WHEN file_cache.mtime = excluded.mtime AND file_cache.size = excluded.size
                     AND file_cache.algo_version IS excluded.algo_version
                THEN file_cache.sample_rate ELSE NULL
            END",
        params![path, mtime, size, peaks_str, ALGO_VERSION],
    );

    Ok(peaks)
}

/// How many waveforms may decode at once. A duplicate group (or a page of
/// them) mounts one `Waveform` per row and each fires `get_waveform` at once;
/// every call is a full-file decode, so unbounded they starve each other, the
/// scan and the UI, and the ones at the back of the queue sat on the busy
/// timeout until the rest finished.
const WAVEFORM_MAX_PARALLEL: usize = 4;

static WAVEFORM_SLOTS: (std::sync::Mutex<usize>, std::sync::Condvar) =
    (std::sync::Mutex::new(0), std::sync::Condvar::new());

struct WaveformSlot;

impl WaveformSlot {
    fn acquire() -> Self {
        let (lock, cv) = &WAVEFORM_SLOTS;
        let mut running = lock.lock().unwrap_or_else(|e| e.into_inner());
        while *running >= WAVEFORM_MAX_PARALLEL {
            running = cv.wait(running).unwrap_or_else(|e| e.into_inner());
        }
        *running += 1;
        WaveformSlot
    }
}

impl Drop for WaveformSlot {
    fn drop(&mut self) {
        let (lock, cv) = &WAVEFORM_SLOTS;
        *lock.lock().unwrap_or_else(|e| e.into_inner()) -= 1;
        cv.notify_one();
    }
}

#[tauri::command]
pub async fn get_waveform(app: AppHandle, path: String) -> Result<Vec<f32>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _slot = WaveformSlot::acquire();
        let ffmpeg = crate::commands::ffmpeg::find_ffmpeg(&app);
        // The cache is an optimisation: if it can't be opened, still decode.
        match open_db(&app) {
            Ok(conn) => get_or_compute_waveform_with(&conn, &path, ffmpeg.as_deref()),
            Err(_) => compute_waveform_file(&path, ffmpeg.as_deref()),
        }
    })
    .await
    .map_err(|_| "Couldn't generate a waveform: the task crashed on this file".to_string())?
}

/// A same-recording duplicate needs high similarity *and* matching duration.
/// A lower score (rusty-chromaprint: 0-32, lower = more similar) with
/// coverage this close on *both* sides is a very strong signal — these
/// thresholds are a starting point, not a scientifically calibrated cutoff,
/// and `ALTERNATE_SCORE_MAX` was tightened once already against a real
/// false positive found while testing against a real library (see
/// `classify_pair`'s doc comment).
const DUPLICATE_SCORE_MAX: f64 = 10.0;
const DUPLICATE_MIN_COVERAGE: f64 = 0.85;
/// A weaker/partial match still worth surfacing as a probable alternate
/// version (radio edit vs. extended mix, etc.) rather than discarding.
const ALTERNATE_SCORE_MAX: f64 = 4.0;
const ALTERNATE_MIN_COVERAGE: f64 = 0.35;

enum PairMatch {
    Duplicate { score: f64 },
    Alternate { score: f64 },
    NoMatch,
}

/// Compares two fingerprints and classifies the relationship using the
/// single largest matching segment. Reports **coverage** (how much of each
/// track's fingerprinted audio that one segment spans) and **score**
/// (chromaprint's own similarity measure) separately, which is what lets a
/// radio edit correctly match *inside* an extended mix without the two
/// being flagged as identical: coverage on the shorter file is high, but
/// coverage on the longer one is only partial — an "alternate version",
/// not a duplicate.
///
/// **Deliberately the single biggest segment, not a span/sum across every
/// segment returned by `match_fingerprints`.** A span-based version (union
/// of every segment's start-to-end range) was tried after finding that two
/// genuinely identical re-encoded copies fragmented into 5 segments with
/// small gaps, undercounting their coverage — but tested against the same
/// real library, span-based coverage badly over-counted the *opposite*
/// case: several scattered, individually brief coincidental matches (shared
/// drum patterns/timbral similarity common across unrelated electronic/pop
/// production) spread a "first match to last match" span across nearly an
/// entire file, which reads as high "coverage" despite almost none of the
/// content actually matching. That produced far worse false positives
/// (unrelated songs merged as "duplicate", one 14-file cluster of unrelated
/// tracks) than the fragmentation problem it was meant to fix. Reverted;
/// the fragmentation case is left as a known, narrower limitation (such a
/// pair under-classifies as "alternate" rather than "duplicate" — see
/// backlog) in favor of not reintroducing something worse.
///
/// **Score is the deciding signal for the shared-jingle case**, found on
/// the same real library: two completely unrelated songs shared one ~46s
/// segment positioned at the very start of one file and mid-track in the
/// other — the signature of a promotional jingle or station drop prepended
/// by whatever tool/source they were downloaded from, not the same
/// recording. It scored 9.55. `ALTERNATE_SCORE_MAX` was first tightened
/// from 14.0 to 6.0 on that single data point.
///
/// **Then tested against a second, larger, more varied real folder (3726
/// files, mostly dance/EDM)**, which surfaced six *more* shared-jingle false
/// positives that 6.0 didn't catch — unrelated tracks across trance, indie
/// pop and techno, clustering tightly at scores 4.84–5.93 (one confirmed
/// with `diagnose_pair`: two unrelated tracks both matching from 0.0s/1.2s,
/// the same "matches from the very start of the file" signature). In that
/// same run, every plausible *genuine* alternate — same-song variants,
/// edits, a mashup that legitimately samples another track — scored 3.14 or
/// lower. That's a real, consistent gap across two independent libraries
/// (genuine matches: 0.03–3.14; shared-jingle false positives: 4.84–9.55),
/// so `ALTERNATE_SCORE_MAX` was tightened again, from 6.0 to 4.0.
#[cfg(test)]
fn classify_pair(a: &CachedFingerprint, b: &CachedFingerprint, config: &Configuration) -> PairMatch {
    classify_pair_real(a, b, config, None)
}

/// `classify_pair` plus the files' *real* lengths. The fingerprint's own
/// `duration_secs` stops at the ~2 minutes that are analysed, so a 3-minute
/// radio edit and an 8-minute extended mix with the same opening both read as
/// "120 s", cover each other completely and used to be called `Duplicate`.
/// When the real lengths disagree by more than the duplicate tolerance, a
/// pair that would have been a duplicate is an alternate instead.
fn classify_pair_real(
    a: &CachedFingerprint,
    b: &CachedFingerprint,
    config: &Configuration,
    real_durations: Option<(f64, f64)>,
) -> PairMatch {
    let Ok(segments) = match_fingerprints(&a.fingerprint, &b.fingerprint, config) else {
        return PairMatch::NoMatch;
    };
    let Some(best) = segments.iter().max_by(|x, y| x.items_count.cmp(&y.items_count)) else {
        return PairMatch::NoMatch;
    };
    let match_secs = best.duration(config) as f64;
    let coverage_a = if a.duration_secs > 0.0 { (match_secs / a.duration_secs).min(1.0) } else { 0.0 };
    let coverage_b = if b.duration_secs > 0.0 { (match_secs / b.duration_secs).min(1.0) } else { 0.0 };
    let min_coverage = coverage_a.min(coverage_b);
    if std::env::var("MTC_DEBUG_CLASSIFY").is_ok() {
        eprintln!(
            "DEBUG classify_pair: segments={} match_secs={match_secs:.1} \
             a.dur={:.1} b.dur={:.1} coverage_a={coverage_a:.3} coverage_b={coverage_b:.3} \
             min_coverage={min_coverage:.3} score={:.2}",
            segments.len(),
            a.duration_secs,
            b.duration_secs,
            best.score,
        );
    }
    let duration_diff = (a.duration_secs - b.duration_secs).abs();

    let same_length = real_durations
        .map_or(true, |(ra, rb)| (ra - rb).abs() <= ra.max(rb) * 0.05 + 1.0);
    // The analysed window is capped in *samples*, not seconds, so the same
    // song at 48 kHz is analysed for ~110 s and at 44.1 kHz for 120 s - a
    // "9.7 s difference" that made a re-encoded copy of the same recording an
    // "alternate". With real lengths known they decide; the analysed lengths
    // are only a fallback.
    let analysed_length_ok = real_durations.is_some()
        || duration_diff <= a.duration_secs.max(b.duration_secs) * 0.05 + 1.0;

    if best.score <= DUPLICATE_SCORE_MAX && min_coverage >= DUPLICATE_MIN_COVERAGE && analysed_length_ok {
        if same_length {
            PairMatch::Duplicate { score: best.score }
        } else {
            // Nearly all of the analysed opening matches but the tracks are
            // different lengths: one is an edit/extension of the other.
            PairMatch::Alternate { score: best.score }
        }
    } else if best.score <= ALTERNATE_SCORE_MAX && min_coverage >= ALTERNATE_MIN_COVERAGE {
        PairMatch::Alternate { score: best.score }
    } else {
        PairMatch::NoMatch
    }
}

// ---------------------------------------------------------------------------
// Pairwise pre-check
//
// `match_fingerprints` costs a fresh concatenate + sort of both fingerprints
// (~2,000 items) for every pair, and the all-pairs stage is O(n²) of those -
// most of a scan's time on a big library, nearly all of it on a rescan whose
// fingerprints are cached. Almost every pair is unrelated, so `could_match`
// first answers a cheaper, *necessary* condition from data prepared once per
// file. It never changes a result: it returns false only when
// `classify_pair_real` would certainly say `NoMatch`, and every other pair
// still goes through the real matcher (`prefilter_never_changes_a_result`).
// ---------------------------------------------------------------------------

/// The top bits of an item `match_fingerprints` aligns on (its `ALIGN_BITS`).
const ALIGN_SHIFT: u32 = 20;
const ALIGN_HASHES: usize = 1 << (32 - ALIGN_SHIFT);
/// Fingerprints this long make `match_fingerprints` refuse (`OFFSET_MASK`).
const ALIGN_MAX_ITEMS: usize = (1 << 19) - 1;

/// One fingerprint's item positions grouped by alignment hash (a compressed
/// row layout), so a pair's offset histogram is a single pass over the other
/// fingerprint. Built once per row of the pairwise stage.
pub(crate) struct AlignBuckets {
    starts: Vec<u32>,
    positions: Vec<u32>,
}

pub(crate) fn align_buckets(fp: &[u32]) -> AlignBuckets {
    let mut starts = vec![0u32; ALIGN_HASHES + 1];
    for &x in fp {
        starts[(x >> ALIGN_SHIFT) as usize + 1] += 1;
    }
    for h in 0..ALIGN_HASHES {
        starts[h + 1] += starts[h];
    }
    let mut next = starts.clone();
    let mut positions = vec![0u32; fp.len()];
    for (i, &x) in fp.iter().enumerate() {
        let h = (x >> ALIGN_SHIFT) as usize;
        positions[next[h] as usize] = i as u32;
        next[h] += 1;
    }
    AlignBuckets { starts, positions }
}

/// Scratch buffers reused across one row of the pairwise stage.
#[derive(Default)]
struct PrecheckScratch {
    hist: Vec<u32>,
    touched: Vec<u32>,
    prefix: Vec<i64>,
}

/// The alignment `match_fingerprints` would pick: its offset histogram
/// (`hist[i + len(b) - j]` counts items i of `a`, j of `b` with the same
/// alignment hash), then the highest count above 1, ties to the larger offset
/// - exactly the peak its `best_alignments` sort puts first, since the global
/// maximum is always one of its local peaks. `None` = no bin above 1, where it
/// finds no segment at all. The maximum is tracked while counting, and only
/// the touched bins are cleared afterwards.
fn best_alignment(a: &AlignBuckets, a_len: usize, b: &[u32], scratch: &mut PrecheckScratch) -> Option<usize> {
    let nb = b.len();
    if scratch.hist.len() < a_len + nb {
        scratch.hist.resize(a_len + nb, 0);
    }
    let (hist, touched) = (&mut scratch.hist, &mut scratch.touched);
    let (mut best, mut best_count) = (None::<usize>, 1u32);
    for (j, &y) in b.iter().enumerate() {
        let h = (y >> ALIGN_SHIFT) as usize;
        let (from, to) = (a.starts[h] as usize, a.starts[h + 1] as usize);
        for &i in &a.positions[from..to] {
            let d = i as usize + nb - j;
            let c = hist[d] + 1;
            if c == 1 {
                touched.push(d as u32);
            }
            hist[d] = c;
            if c > best_count || (c == best_count && best.is_some_and(|bd| d > bd)) {
                best_count = c;
                best = Some(d);
            }
        }
    }
    for d in touched.drain(..) {
        hist[d as usize] = 0;
    }
    best
}

/// False only when `classify_pair_real(a, b, ..)` is certainly `NoMatch`.
///
/// Every match it can return needs its largest segment to score at most
/// `DUPLICATE_SCORE_MAX` (the looser of the two score limits) and to cover at
/// least `ALTERNATE_MIN_COVERAGE` of the longer fingerprint. Segments are
/// contiguous runs of the per-item bit differences at the one alignment the
/// matcher picks, and a segment's score is the mean over its run - so if no
/// run that long has a mean that low, no segment can. Both limits are rounded
/// the permissive way, so float rounding can only make this say "maybe".
fn could_match(
    a: &CachedFingerprint,
    a_buckets: &AlignBuckets,
    b: &CachedFingerprint,
    config: &Configuration,
    scratch: &mut PrecheckScratch,
) -> bool {
    let (fa, fb) = (&a.fingerprint, &b.fingerprint);
    if fa.len() >= ALIGN_MAX_ITEMS || fb.len() >= ALIGN_MAX_ITEMS {
        return true; // Out of the matcher's range: let it report that itself.
    }
    if fa.is_empty() || fb.is_empty() || a.duration_secs <= 0.0 || b.duration_secs <= 0.0 {
        return false; // No items, or a zero coverage denominator: never a match.
    }
    let Some(d) = best_alignment(a_buckets, fa.len(), fb, scratch) else {
        return false;
    };
    let shift = d as isize - fb.len() as isize;
    let (off_a, off_b) = (shift.max(0) as usize, (-shift).max(0) as usize);
    let size = (fa.len() - off_a).min(fb.len() - off_b);

    let min_coverage = ALTERNATE_MIN_COVERAGE.min(DUPLICATE_MIN_COVERAGE);
    let item_secs = config.item_duration_in_seconds() as f64;
    let wanted = min_coverage * a.duration_secs.max(b.duration_secs) / item_secs;
    let min_len = ((wanted * 0.999).floor() as usize).max(1);
    if size < min_len {
        return false;
    }
    // Is there a run of >= min_len items whose mean bit difference is
    // <= max_score? With P = prefix sums of (bits - max_score): is there
    // i <= j - min_len with P[j] <= P[i]?
    let max_score = DUPLICATE_SCORE_MAX.max(ALTERNATE_SCORE_MAX).ceil() as i64;
    let p = &mut scratch.prefix;
    p.clear();
    p.push(0);
    for k in 0..size {
        let bits = (fa[off_a + k] ^ fb[off_b + k]).count_ones() as i64;
        p.push(p[k] + bits - max_score);
    }
    let mut highest_start = i64::MIN;
    for j in min_len..=size {
        highest_start = highest_start.max(p[j - min_len]);
        if p[j] <= highest_start {
            return true;
        }
    }
    false
}

// ---------------------------------------------------------------------------
// Tag / filename matching (v0.19)
//
// Fingerprints only look at the first ~2 minutes and only find files whose
// audio overlaps there, so a radio edit and an extended mix with a different
// intro - or any pair whose shared audio sits after the 2-minute mark - never
// matched. DJ libraries also carry the same song under the same artist+title
// many times, so the tags themselves are a strong, cheap second signal. Pairs
// found this way are ALWAYS "alternate" (never suggested for removal) and are
// confirmed against the fingerprints where the audio does overlap.
// ---------------------------------------------------------------------------

/// What the tags (or, failing that, the file name) say about one file.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct TrackMeta {
    /// Compact (lowercase, accent-folded, alphanumeric only) artist tokens
    /// from the main artist field - `feat.` credits excluded.
    pub(crate) artists: Vec<String>,
    /// The whole artist string compacted, for the "one credit is a prefix of
    /// the other" check ("Adam Port" vs "Adam Port Stryv Keinemusik ...").
    pub(crate) artist_full: String,
    /// Compact base title with version tags, `feat.` credits and a leading
    /// "the" removed. Empty when unknown or too generic to identify a song.
    pub(crate) title: String,
    /// Version tags found in the title/file name ("extended mix", "clean"...),
    /// lowercase and sorted, with "original mix" and friends dropped (= none).
    pub(crate) versions: Vec<String>,
    /// Real track length from the file header (the fingerprint's own duration
    /// is capped at the ~2 minutes it analyses).
    pub(crate) duration_secs: Option<f64>,
}

fn fold_char(c: char) -> char {
    match c {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'ă' | 'ą' => 'a',
        'ç' | 'ć' | 'č' => 'c',
        'ď' | 'đ' => 'd',
        'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ė' | 'ę' | 'ě' => 'e',
        'ì' | 'í' | 'î' | 'ï' | 'ī' | 'į' | 'ı' => 'i',
        'ł' => 'l',
        'ñ' | 'ń' | 'ň' => 'n',
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' | 'ő' => 'o',
        'ř' => 'r',
        'ś' | 'š' | 'ş' => 's',
        'ť' | 'ţ' => 't',
        'ù' | 'ú' | 'û' | 'ü' | 'ū' | 'ů' | 'ű' => 'u',
        'ý' | 'ÿ' => 'y',
        'ź' | 'ż' | 'ž' => 'z',
        // Cyrillic: "ё"/"й" are routinely typed as "е"/"и" in file names.
        'ё' => 'е',
        'й' => 'и',
        c => c,
    }
}

/// Lowercase, accent-folded, alphanumerics only ("Don't" == "Dont" == "Don t").
/// `&` reads as "and" so "Tom & Jerry" == "Tom and Jerry".
fn compact(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c == '&' {
            out.push_str("and");
            continue;
        }
        for lc in c.to_lowercase() {
            let f = fold_char(lc);
            if f.is_alphanumeric() {
                out.push(f);
            }
        }
    }
    out
}

fn words(s: &str) -> Vec<String> {
    s.split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(|w| w.to_lowercase())
        .collect()
}

/// Words that only ever describe a *version* of a song, never its name.
const VERSION_VOCAB: &[&str] = &[
    "radio", "edit", "extended", "ext", "mix", "version", "original", "orig", "clean", "dirty", "explicit", "intro",
    "outro", "instrumental", "inst", "acapella", "acappella", "cappella", "a", "dub", "vip", "bootleg", "mashup",
    "rework", "flip", "remaster", "remastered", "remix", "remixed", "live", "acoustic", "club", "djcity", "dj",
    "city", "quick", "hit", "quickhit", "short", "full", "main", "album", "single", "hype", "tool", "transition",
    "segue", "broadcast", "censored", "uncensored", "edited",
];

/// Last words that mark a bracket as a version tag even when the rest is a
/// name ("Joe Smith Remix"). A bracket that is not all-vocabulary and does not
/// end in one of these ("Live Is Life", "Dirty Bit") stays part of the title.
const VERSION_TAIL: &[&str] = &[
    "remix", "mix", "edit", "version", "dub", "vip", "bootleg", "mashup", "rework", "flip", "remaster",
    "remastered", "intro", "outro", "instrumental", "acapella", "cappella", "remixed",
];

fn is_version_tag(content: &str) -> bool {
    let w = words(content);
    if w.is_empty() {
        return false;
    }
    let vocab = |x: &String| VERSION_VOCAB.contains(&x.as_str());
    // "(2012)" / "(126)" alone are not versions; "(126 Intro)" is.
    if w.iter().all(|x| vocab(x) || x.chars().all(|c| c.is_ascii_digit())) {
        return w.iter().any(vocab);
    }
    w.last().is_some_and(|l| VERSION_TAIL.contains(&l.as_str()))
}

fn is_feat_tag(content: &str) -> bool {
    let w = words(content);
    matches!(w.first().map(String::as_str), Some("feat" | "ft" | "featuring" | "prod")) && !is_version_tag(content)
}

/// "original mix", "original" ... mean "no particular edit".
fn normalize_version(content: &str) -> Option<String> {
    let joined = words(content).join(" ");
    const PLAIN: &[&str] = &[
        "original", "original mix", "original version", "orig", "orig mix", "main", "main mix", "album version",
        "single version", "full version", "album", "single", "explicit",
    ];
    if PLAIN.contains(&joined.as_str()) {
        None
    } else {
        Some(joined)
    }
}

/// Splits a raw title into (base title text, version tags, feat. credits).
pub(crate) fn split_title(raw: &str) -> (String, Vec<String>, Vec<String>) {
    let mut base = String::new();
    let mut versions = Vec::new();
    let mut feats = Vec::new();
    let chars: Vec<char> = raw.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let close = match c {
            '(' => Some(')'),
            '[' => Some(']'),
            _ => None,
        };
        if let Some(close) = close {
            if let Some(off) = chars[i + 1..].iter().position(|&x| x == close) {
                let content: String = chars[i + 1..i + 1 + off].iter().collect();
                if is_feat_tag(&content) {
                    feats.push(content);
                    i += off + 2;
                    continue;
                }
                if is_version_tag(&content) {
                    if let Some(v) = normalize_version(&content) {
                        versions.push(v);
                    }
                    i += off + 2;
                    continue;
                }
            }
        }
        base.push(c);
        i += 1;
    }
    // " - Radio Edit" style suffix (also " - feat. X").
    let mut base = base.trim().to_string();
    while let Some(pos) = base.rfind(" - ") {
        let suffix = base[pos + 3..].to_string();
        if is_version_tag(&suffix) {
            if let Some(v) = normalize_version(&suffix) {
                versions.push(v);
            }
        } else if is_feat_tag(&suffix) {
            feats.push(suffix);
        } else {
            break;
        }
        base.truncate(pos);
        base = base.trim().to_string();
    }
    versions.sort();
    versions.dedup();
    (base, versions, feats)
}

/// Separators between artists in a credit ("A & B", "A x B", "A feat. B"...).
fn split_artists(s: &str) -> Vec<String> {
    let mut parts = vec![s.to_string()];
    for sep in [
        " feat. ", " feat ", " ft. ", " ft ", " featuring ", " with ", " vs. ", " vs ", " & ", " and ", " x ", " × ",
        ", ", "; ", " / ", "/", ",", ";",
    ] {
        parts = parts
            .into_iter()
            .flat_map(|p| {
                let lower = p.to_lowercase();
                // Byte offsets of the lowercase copy only line up when casing
                // didn't change any char's width.
                if lower.len() != p.len() || !lower.contains(sep) {
                    return vec![p];
                }
                let mut out = Vec::new();
                let mut last = 0;
                for (idx, _) in lower.match_indices(sep) {
                    out.push(p[last..idx].to_string());
                    last = idx + sep.len();
                }
                out.push(p[last..].to_string());
                out
            })
            .collect();
    }
    parts.iter().map(|p| compact(p)).filter(|p| !p.is_empty()).collect()
}

/// Strips DJ-pool / downloader decoration from a file stem: a leading track
/// number or key block ("01 - ", "12A - ") and the trailing " - 000224" id
/// this app appends to avoid name collisions.
fn clean_stem(stem: &str) -> String {
    let mut s = stem.trim().to_string();
    while let Some(pos) = s.rfind(" - ") {
        let tail = s[pos + 3..].trim();
        if !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit()) {
            s.truncate(pos);
        } else {
            break;
        }
    }
    loop {
        let t = s.trim_start();
        let d = t.chars().take_while(|c| c.is_ascii_digit()).count();
        if d == 0 || d > 3 {
            break;
        }
        let mut rest = &t[d..];
        if d <= 2 && rest.chars().next().is_some_and(|c| c.eq_ignore_ascii_case(&'a') || c.eq_ignore_ascii_case(&'b'))
        {
            rest = &rest[1..];
        }
        let rest = rest.trim_start();
        let after = rest
            .strip_prefix('-')
            .or_else(|| rest.strip_prefix('.'))
            .or_else(|| rest.strip_prefix('_'))
            .map(str::trim_start);
        match after {
            // Only strip when an "Artist - Title" is still left.
            Some(a) if a.contains(" - ") => s = a.to_string(),
            _ => break,
        }
    }
    s
}

/// "Artist - Title" out of a file stem.
fn parse_stem(stem: &str) -> Option<(String, String)> {
    let s = clean_stem(stem);
    let (a, t) = s.split_once(" - ")?;
    let (a, t) = (a.trim(), t.trim());
    if a.is_empty() || t.is_empty() {
        None
    } else {
        Some((a.to_string(), t.to_string()))
    }
}

/// Titles too generic to identify a song on their own.
fn is_generic_title(t: &str) -> bool {
    t.chars().count() < 3
        || matches!(t, "intro" | "outro" | "untitled" | "unknown" | "track" | "audio" | "interlude" | "skit" | "demo" | "test")
        || (t.starts_with("track") && t[5..].chars().all(|c| c.is_ascii_digit()))
}

/// Builds the matching key from whatever artist/title the tags gave, falling
/// back to the file name when either is empty.
pub(crate) fn build_meta(
    tag_artist: Option<&str>,
    tag_title: Option<&str>,
    path: &str,
    duration_secs: Option<f64>,
) -> TrackMeta {
    let stem = Path::new(path).file_stem().and_then(|s| s.to_str()).unwrap_or("");
    let from_name = parse_stem(stem);
    let tag_artist = tag_artist.map(str::trim).filter(|s| !s.is_empty());
    let tag_title = tag_title.map(str::trim).filter(|s| !s.is_empty());
    let artist = tag_artist.map(str::to_string).or_else(|| from_name.as_ref().map(|(a, _)| a.clone()));
    let title = tag_title.map(str::to_string).or_else(|| from_name.as_ref().map(|(_, t)| t.clone()));
    let (Some(artist), Some(title)) = (artist, title) else {
        return TrackMeta { duration_secs, ..Default::default() };
    };
    let (base, mut versions, _feats) = split_title(&title);
    // The tag is often cleaned of its "(Joe Remix)" while the file name keeps
    // it, so versions found in the name count too.
    if let Some((_, name_title)) = &from_name {
        versions.extend(split_title(name_title).1);
        versions.sort();
        versions.dedup();
    }
    let mut title_key = compact(&base);
    if let Some(rest) = title_key.strip_prefix("the") {
        if rest.chars().count() >= 3 {
            title_key = rest.to_string();
        }
    }
    // "Artist (feat. X)" in the artist field.
    let (artist_main, _, _) = split_title(&artist);
    TrackMeta {
        artists: split_artists(&artist_main),
        artist_full: compact(&artist_main),
        title: if is_generic_title(&title_key) { String::new() } else { title_key },
        versions,
        duration_secs,
    }
}

/// Reads artist/title (no cover art) and the real duration with lofty.
fn read_meta(path: &str) -> TrackMeta {
    use lofty::config::ParseOptions;
    use lofty::file::AudioFile as _;
    use lofty::prelude::*;
    let parsed = lofty::probe::Probe::open(path)
        .and_then(|p| p.options(ParseOptions::new().read_cover_art(false)).read())
        .ok();
    let (artist, title, dur) = match &parsed {
        Some(tf) => {
            let tag = tf.primary_tag().or_else(|| tf.first_tag());
            let d = tf.properties().duration().as_secs_f64();
            (
                tag.and_then(|t| t.artist().map(|s| s.to_string())),
                tag.and_then(|t| t.title().map(|s| s.to_string())),
                Some(d).filter(|d| *d > 0.0),
            )
        }
        None => (None, None, None),
    };
    build_meta(artist.as_deref(), title.as_deref(), path, dur)
}

/// Same song? Same base title and overlapping artists. A missing/generic
/// title or artist never matches.
pub(crate) fn same_song(a: &TrackMeta, b: &TrackMeta) -> bool {
    if a.title.is_empty() || a.title != b.title || a.artists.is_empty() || b.artists.is_empty() {
        return false;
    }
    if a.artists.iter().any(|x| b.artists.contains(x)) {
        return true;
    }
    // One credit is a prefix of the other ("Adam Port" / "Adam Port Stryv ...").
    let (short, long) = if a.artist_full.len() <= b.artist_full.len() {
        (&a.artist_full, &b.artist_full)
    } else {
        (&b.artist_full, &a.artist_full)
    };
    short.chars().count() >= 4 && long.starts_with(short.as_str())
}

/// Whether two files carry different version tags ("clean" vs none,
/// "extended" vs "radio") even if their audio is the same length.
pub(crate) fn versions_differ(a: &TrackMeta, b: &TrackMeta) -> bool {
    a.versions != b.versions
}

/// Union-find so transitively-related files (A matches B, B matches C) land
/// in one group instead of three overlapping pairs.
struct UnionFind {
    parent: Vec<usize>,
}
impl UnionFind {
    fn new(n: usize) -> Self {
        Self { parent: (0..n).collect() }
    }
    fn find(&mut self, x: usize) -> usize {
        if self.parent[x] != x {
            self.parent[x] = self.find(self.parent[x]);
        }
        self.parent[x]
    }
    fn union(&mut self, a: usize, b: usize) {
        let (ra, rb) = (self.find(a), self.find(b));
        if ra != rb {
            self.parent[ra] = rb;
        }
    }
}

/// Loose audio check used only to *confirm* a tag-based pair: any single
/// shared stretch of at least `TAG_CONFIRM_MIN_SECS` that is reasonably close
/// in chromaprint terms. Far weaker than `classify_pair` on purpose - the tags
/// already say it is the same song, so this only has to rule out "same title,
/// different recording" and does not need to survive the shared-jingle
/// false positives that the strict thresholds were tuned against.
const TAG_CONFIRM_MIN_SECS: f64 = 10.0;
const TAG_CONFIRM_SCORE_MAX: f64 = 8.0;
/// Reported for a tag-only pair (no audio evidence): the top of chromaprint's scale.
const TAG_ONLY_SCORE: f64 = 32.0;
/// A tag-matched pair this lopsided in length is not a plausible edit of
/// the same song (an 8:00 extended mix of a 2:00 radio edit is 0.25).
const TAG_MIN_LENGTH_RATIO: f64 = 0.2;

fn confirm_by_audio(a: &CachedFingerprint, b: &CachedFingerprint, config: &Configuration) -> Option<f64> {
    let segments = match_fingerprints(&a.fingerprint, &b.fingerprint, config).ok()?;
    segments
        .iter()
        .filter(|s| s.duration(config) as f64 >= TAG_CONFIRM_MIN_SECS && s.score <= TAG_CONFIRM_SCORE_MAX)
        .map(|s| s.score)
        .fold(None, |best: Option<f64>, s| Some(best.map_or(s, |b| b.min(s))))
}

/// The actual detection pipeline, independent of Tauri — takes a plain
/// sqlite `Connection` and an optional progress callback (`(done, total,
/// phase)`) instead of an `AppHandle`, so it can be exercised directly
/// (real-library smoke testing, benchmarking) without a running app.
fn scan_duplicates_core(
    conn: &mut Connection,
    paths: &[String],
    on_progress: impl Fn(usize, usize, &str) + Sync,
) -> Vec<DuplicateGroup> {
    let total = paths.len();
    let mut fingerprints: Vec<(String, CachedFingerprint)> = Vec::with_capacity(total);
    let computed = fingerprint_many(conn, paths, |done, total| {
        on_progress(done, total, "fingerprinting")
    });
    for (path, fp) in paths.iter().zip(computed) {
        match fp {
            Ok(fp) => fingerprints.push((path.clone(), fp)),
            Err(e) => eprintln!("duplicate scan: skipping {path}: {e}"),
        }
    }

    // Tags / file names and the real track lengths. Cheap (headers only), and
    // a file whose tags can't be read just has no tag-based matches.
    let fp_paths: Vec<String> = fingerprints.iter().map(|(p, _)| p.clone()).collect();
    let metas: Vec<TrackMeta> =
        crate::commands::files::par_map(&fp_paths, |p| read_meta(p), |_| TrackMeta::default());
    let real_duration = |i: usize, j: usize| match (metas[i].duration_secs, metas[j].duration_secs) {
        (Some(a), Some(b)) => Some((a, b)),
        _ => None,
    };

    // Stage 1: exact byte-identical files (blake3), grouped immediately —
    // no need to fingerprint-compare files we already know are identical.
    let mut exact_groups: std::collections::HashMap<&str, Vec<usize>> = std::collections::HashMap::new();
    for (i, (_, fp)) in fingerprints.iter().enumerate() {
        exact_groups.entry(fp.blake3.as_str()).or_default().push(i);
    }

    // One node per file. Byte-identical copies are unioned up front and only
    // their first member takes part in the comparisons below: before this, every
    // member of an exact group was left out of the fingerprint stage entirely,
    // so "A, A-copy, A-extended" never linked the extended mix to either copy.
    let mut uf = UnionFind::new(fingerprints.len());
    let mut candidates: Vec<usize> = Vec::new();
    {
        let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
        for (i, (_, fp)) in fingerprints.iter().enumerate() {
            let idxs = &exact_groups[fp.blake3.as_str()];
            if idxs.len() > 1 {
                uf.union(i, idxs[0]);
            }
            if seen.insert(fp.blake3.as_str()) {
                candidates.push(i);
            }
        }
    }

    // Stage 2/3: fingerprint comparison between distinct recordings.
    let config = fingerprint_config();
    // (min index, max index) -> (is_duplicate, score, from_tags_only)
    let mut pair_kind: std::collections::HashMap<(usize, usize), (bool, f64, bool)> = std::collections::HashMap::new();
    let key = |a: usize, b: usize| if a < b { (a, b) } else { (b, a) };

    // The pairwise comparison is O(n²) `match_fingerprints` calls — by far the
    // slowest part of a big scan, and it ran on one core. Each row of the
    // triangle (one file against every later one) is independent, so rows
    // run in parallel and their matches are merged in row order afterwards;
    // the grouping that comes out is identical to the sequential loop's.
    let compared = std::sync::atomic::AtomicUsize::new(0);
    let rows: Vec<usize> = (0..candidates.len()).collect();
    let matches: Vec<Vec<(usize, PairMatch)>> = crate::commands::files::par_map(
        &rows,
        |&ci| {
            let i = candidates[ci];
            let (_, fa) = &fingerprints[i];
            let mut found = Vec::new();
            let buckets = align_buckets(&fa.fingerprint);
            let mut scratch = PrecheckScratch::default();
            for &j in candidates.iter().skip(ci + 1) {
                let (_, fb) = &fingerprints[j];
                let longer = fa.duration_secs.max(fb.duration_secs);
                let shorter = fa.duration_secs.min(fb.duration_secs);
                if longer <= 0.0 || shorter / longer < 0.30 {
                    continue; // durations too far apart to plausibly be related
                }
                if !could_match(fa, &buckets, fb, &config, &mut scratch) {
                    continue;
                }
                match classify_pair_real(fa, fb, &config, real_duration(i, j)) {
                    PairMatch::NoMatch => {}
                    m => found.push((j, m)),
                }
            }
            let n = compared.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
            on_progress(n, candidates.len(), "comparing");
            found
        },
        |_| Vec::new(),
    );
    for (ci, found) in matches.into_iter().enumerate() {
        let i = candidates[ci];
        for (j, m) in found {
            // The same audio under different version tags ("clean" vs "dirty",
            // "extended" vs none) is an alternate, not something to delete.
            let m = match m {
                PairMatch::Duplicate { score } if versions_differ(&metas[i], &metas[j]) => PairMatch::Alternate { score },
                m => m,
            };
            match m {
                PairMatch::Duplicate { score } => {
                    uf.union(i, j);
                    pair_kind.insert(key(i, j), (true, score, false));
                }
                PairMatch::Alternate { score } => {
                    uf.union(i, j);
                    pair_kind.entry(key(i, j)).or_insert((false, score, false));
                }
                PairMatch::NoMatch => {}
            }
        }
    }

    // Stage 4: same artist + title from tags / file names (radio vs extended
    // mix, clean vs dirty, intro edits...). Bucketed by title so this stays
    // linear on a big library; always an "alternate".
    let mut by_title: std::collections::HashMap<&str, Vec<usize>> = std::collections::HashMap::new();
    for &i in &candidates {
        if !metas[i].title.is_empty() {
            by_title.entry(metas[i].title.as_str()).or_default().push(i);
        }
    }
    for idxs in by_title.values() {
        for (x, &i) in idxs.iter().enumerate() {
            for &j in &idxs[x + 1..] {
                if pair_kind.contains_key(&key(i, j)) || !same_song(&metas[i], &metas[j]) {
                    continue;
                }
                if let (Some(a), Some(b)) = (metas[i].duration_secs, metas[j].duration_secs) {
                    if a.min(b) / a.max(b) < TAG_MIN_LENGTH_RATIO {
                        continue;
                    }
                }
                let (_, fa) = &fingerprints[i];
                let (_, fb) = &fingerprints[j];
                match confirm_by_audio(fa, fb, &config) {
                    Some(score) => pair_kind.insert(key(i, j), (false, score, false)),
                    None => pair_kind.insert(key(i, j), (false, TAG_ONLY_SCORE, true)),
                };
                uf.union(i, j);
            }
        }
    }

    let mut clusters: std::collections::HashMap<usize, Vec<usize>> = std::collections::HashMap::new();
    for i in 0..fingerprints.len() {
        let root = uf.find(i);
        clusters.entry(root).or_default().push(i);
    }
    let mut groups: Vec<DuplicateGroup> = Vec::new();
    for (root, members) in clusters {
        if members.len() < 2 {
            continue;
        }
        // A cluster is a "duplicate" group only if every pair inside it that
        // was actually compared came back "duplicate" — one alternate-version
        // pair downgrades the whole cluster, so an extended mix + radio edit
        // + a real duplicate of the radio edit doesn't get mislabeled as all
        // being identical.
        let mut is_pure_duplicate = true;
        let mut best_score = f64::MAX;
        let (mut any_tags_only, mut any_tag_confirmed) = (false, false);
        for a in 0..members.len() {
            for b in (a + 1)..members.len() {
                if let Some(&(dup, score, tags_only)) = pair_kind.get(&key(members[a], members[b])) {
                    if !dup {
                        is_pure_duplicate = false;
                    }
                    best_score = best_score.min(score);
                    any_tags_only |= tags_only;
                }
            }
        }
        // A tag-matched pair that did find audio overlap shows up as a plain
        // alternate with a real score; detect it by the tags agreeing.
        for a in 0..members.len() {
            for b in (a + 1)..members.len() {
                if same_song(&metas[members[a]], &metas[members[b]]) {
                    any_tag_confirmed = true;
                }
            }
        }
        let same_bytes = members.iter().all(|&m| fingerprints[m].1.blake3 == fingerprints[members[0]].1.blake3);
        let reason = if any_tags_only {
            "tags"
        } else if any_tag_confirmed && !is_pure_duplicate {
            "tags+audio"
        } else {
            "audio"
        };
        groups.push(DuplicateGroup {
            id: if same_bytes {
                format!("exact-{}", fingerprints[members[0]].1.blake3)
            } else {
                format!("cluster-{root}")
            },
            kind: if is_pure_duplicate { "duplicate" } else { "alternate" }.to_string(),
            paths: members.iter().map(|&i| fingerprints[i].0.clone()).collect(),
            score: if same_bytes || best_score == f64::MAX { 0.0 } else { best_score },
            reason: reason.to_string(),
        });
    }

    groups
}

fn scan_duplicates_blocking(app: &AppHandle, paths: Vec<String>) -> Result<Vec<DuplicateGroup>, String> {
    let mut conn = open_db(app)?;
    Ok(scan_duplicates_core(&mut conn, &paths, |done, total, phase| {
        emit_progress(app, done, total, phase)
    }))
}

#[tauri::command]
pub async fn scan_duplicates(app: AppHandle, paths: Vec<String>) -> Result<Vec<DuplicateGroup>, String> {
    tauri::async_runtime::spawn_blocking(move || scan_duplicates_blocking(&app, paths))
        .await
        .map_err(|_| "duplicate scan task panicked".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Diagnostic for a specific real-file false positive: prints exactly
    /// where the "match" lands in each file (timestamps, item count, score)
    /// instead of just the summary classification, so a spurious match can
    /// actually be understood rather than guessed at. Point it at two real
    /// paths with:
    ///   MTC_TEST_PATH_A="C:\...\a.mp3" MTC_TEST_PATH_B="C:\...\b.mp3" cargo test --release diagnose_pair -- --ignored --nocapture
    #[test]
    #[ignore]
    fn diagnose_pair() {
        let path_a = std::env::var("MTC_TEST_PATH_A").expect("set MTC_TEST_PATH_A");
        let path_b = std::env::var("MTC_TEST_PATH_B").expect("set MTC_TEST_PATH_B");

        let cache_dir = std::env::temp_dir().join("mtc-real-scan-cache");
        std::fs::create_dir_all(&cache_dir).unwrap();
        let conn = Connection::open(cache_dir.join("cache.sqlite")).unwrap();
        conn.execute_batch(FILE_CACHE_SCHEMA_SQL).unwrap();

        let fp_a = get_or_compute(&conn, &path_a).unwrap();
        let fp_b = get_or_compute(&conn, &path_b).unwrap();
        println!(
            "A: {path_a}\n   decoded duration (capped) = {:.1}s, fingerprint len = {}",
            fp_a.duration_secs,
            fp_a.fingerprint.len()
        );
        println!(
            "B: {path_b}\n   decoded duration (capped) = {:.1}s, fingerprint len = {}",
            fp_b.duration_secs,
            fp_b.fingerprint.len()
        );

        let config = fingerprint_config();
        let mut segments = match_fingerprints(&fp_a.fingerprint, &fp_b.fingerprint, &config).unwrap();
        println!("\n{} segment(s) found:", segments.len());
        segments.sort_by(|a, b| b.items_count.cmp(&a.items_count));
        for s in segments.iter().take(10) {
            println!(
                "  score={:.2} items={} dur={:.1}s | A: {:.1}s-{:.1}s | B: {:.1}s-{:.1}s",
                s.score,
                s.items_count,
                s.duration(&config),
                s.start1(&config),
                s.end1(&config),
                s.start2(&config),
                s.end2(&config)
            );
        }

        match classify_pair(&fp_a, &fp_b, &config) {
            PairMatch::Duplicate { score } => println!("\nClassified: Duplicate (score {score:.2})"),
            PairMatch::Alternate { score } => println!("\nClassified: Alternate (score {score:.2})"),
            PairMatch::NoMatch => println!("\nClassified: No match"),
        }
    }

    /// Manual, opt-in smoke test against a real folder of real music — the
    /// only way to see how the pipeline behaves on actual bitrate/format
    /// diversity and real edit relationships, which no synthetic fixture can
    /// stand in for. Not part of the normal suite: run explicitly with
    ///   MTC_TEST_DIR="C:\path\to\folder" cargo test --release real_library_scan_smoke_test -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_library_scan_smoke_test() {
        let dir = std::env::var("MTC_TEST_DIR")
            .expect("set MTC_TEST_DIR to a real folder of audio files to scan");
        let exts = ["mp3", "flac", "wav", "m4a", "aac", "aiff", "aif", "ogg"];
        let mut paths = Vec::new();
        for entry in walkdir::WalkDir::new(&dir).into_iter().filter_map(|e| e.ok()) {
            if entry.file_type().is_file() {
                if let Some(ext) = entry.path().extension().and_then(|e| e.to_str()) {
                    if exts.contains(&ext.to_ascii_lowercase().as_str()) {
                        paths.push(entry.path().to_string_lossy().to_string());
                    }
                }
            }
        }
        println!("Found {} audio files under {dir}", paths.len());

        let cache_dir = std::env::temp_dir().join("mtc-real-scan-cache");
        std::fs::create_dir_all(&cache_dir).unwrap();
        let mut conn = Connection::open(cache_dir.join("cache.sqlite")).unwrap();
        conn.execute_batch(FILE_CACHE_SCHEMA_SQL).unwrap();

        let start = std::time::Instant::now();
        let last_print = std::sync::Mutex::new(std::time::Instant::now());
        let groups = scan_duplicates_core(&mut conn, &paths, |done, total, phase| {
            let mut last = last_print.lock().unwrap();
            if last.elapsed().as_secs() >= 3 || done == total {
                println!(
                    "{phase}: {done}/{total} ({:.1}s elapsed)",
                    start.elapsed().as_secs_f64()
                );
                *last = std::time::Instant::now();
            }
        });
        println!("\nScan took {:?} for {} files", start.elapsed(), paths.len());
        println!("Found {} group(s)\n", groups.len());
        for g in &groups {
            println!("--- {} [{}] (score {:.2}, {} files) ---", g.kind, g.reason, g.score, g.paths.len());
            for p in &g.paths {
                println!("  {p}");
            }
        }
    }

    /// Opt-in: runs the waveform generator over every audio file under
    /// MTC_TEST_DIR and tallies failures by error text, so "some tracks never
    /// get a waveform" can be diagnosed on a real library.
    ///   MTC_TEST_DIR="C:\Music" cargo test --release real_library_waveform_sweep -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_library_waveform_sweep() {
        let dir = std::env::var("MTC_TEST_DIR").expect("set MTC_TEST_DIR");
        let limit: usize = std::env::var("MTC_TEST_LIMIT").ok().and_then(|v| v.parse().ok()).unwrap_or(usize::MAX);
        let exts = ["mp3", "flac", "wav", "m4a", "aac", "aiff", "aif", "ogg"];
        let paths: Vec<String> = walkdir::WalkDir::new(&dir)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
            .filter(|e| {
                e.path().extension().and_then(|x| x.to_str()).is_some_and(|x| exts.contains(&x.to_ascii_lowercase().as_str()))
            })
            .map(|e| e.path().to_string_lossy().to_string())
            .take(limit)
            .collect();
        let start = std::time::Instant::now();
        let results = crate::commands::files::par_map(
            &paths,
            |p| {
                let t = std::time::Instant::now();
                let r = compute_waveform_symphonia(p).and_then(|w| {
                    let h = header_duration_secs(p);
                    if w.peaks.is_empty() { Err("EMPTY peaks".to_string()) }
                    else if h.is_some_and(|h| w.decoded_secs < h * WAVEFORM_MIN_COVERAGE - 1.0) { Err("TRUNCATED decode".to_string()) }
                    else if w.peaks.iter().all(|p| *p == 0.0) { Err("ALL-ZERO peaks".to_string()) }
                    else { Ok(w.peaks) }
                });
                (r, t.elapsed().as_secs_f64())
            },
            |_| (Err("crashed".to_string()), 0.0),
        );
        let mut by_err: std::collections::BTreeMap<String, Vec<&String>> = Default::default();
        let (mut ok, mut slow) = (0, 0);
        for (p, (r, secs)) in paths.iter().zip(&results) {
            if *secs > 10.0 {
                slow += 1;
            }
            match r {
                Ok(peaks) if peaks.is_empty() => by_err.entry("EMPTY peaks".into()).or_default().push(p),
                Ok(_) => ok += 1,
                Err(e) => by_err.entry(e.clone()).or_default().push(p),
            }
        }
        println!("{} files in {:?}: ok={ok} slow(>10s)={slow}", paths.len(), start.elapsed());
        for (e, ps) in &by_err {
            println!("{} x {e}", ps.len());
            for p in ps.iter().take(5) {
                println!("    {p}");
            }
        }
    }

    fn sine_pcm(freq: f64, sample_rate: u32, seconds: f64) -> Vec<i16> {
        let n = (sample_rate as f64 * seconds) as usize;
        (0..n)
            .map(|i| {
                let t = i as f64 / sample_rate as f64;
                ((t * freq * std::f64::consts::TAU).sin() * i16::MAX as f64 * 0.8) as i16
            })
            .collect()
    }

    /// Minimal 16-bit mono PCM WAV writer — just enough to exercise the real
    /// `decode_to_pcm` (symphonia probe + decode) path against an actual file
    /// on disk, since every other test here calls `compute_fingerprint`
    /// directly on in-memory PCM and never touches decoding at all.
    fn write_wav(path: &Path, pcm: &[i16], sample_rate: u32) {
        let mut data = Vec::with_capacity(pcm.len() * 2);
        for s in pcm {
            data.extend_from_slice(&s.to_le_bytes());
        }
        let byte_rate = sample_rate * 2;
        let mut buf = Vec::new();
        buf.extend_from_slice(b"RIFF");
        buf.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
        buf.extend_from_slice(b"WAVEfmt ");
        buf.extend_from_slice(&16u32.to_le_bytes());
        buf.extend_from_slice(&1u16.to_le_bytes()); // PCM
        buf.extend_from_slice(&1u16.to_le_bytes()); // mono
        buf.extend_from_slice(&sample_rate.to_le_bytes());
        buf.extend_from_slice(&byte_rate.to_le_bytes());
        buf.extend_from_slice(&2u16.to_le_bytes()); // block align
        buf.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
        buf.extend_from_slice(b"data");
        buf.extend_from_slice(&(data.len() as u32).to_le_bytes());
        buf.extend_from_slice(&data);
        std::fs::write(path, buf).unwrap();
    }

    fn scratch_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mtc-dup-test-{name}-{:?}",
            std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn decode_to_pcm_reads_a_real_wav_file_from_disk() {
        let dir = scratch_dir("decode");
        let path = dir.join("tone.wav");
        let sr = 44_100;
        write_wav(&path, &sine_pcm(440.0, sr, 3.0), sr);

        let (pcm, rate, channels, duration) = decode_to_pcm(path.to_str().unwrap()).unwrap();
        assert_eq!(rate, sr);
        assert_eq!(channels, 1);
        assert!(!pcm.is_empty(), "decoded PCM should not be empty");
        assert!(
            (2.5..3.5).contains(&duration),
            "expected roughly a 3s file, got {duration}s"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Fingerprints from the streaming decoder must be bit-identical to the
    /// one-big-buffer computation: imported Rekordbox cues are keyed by a
    /// hash of the fingerprint, so any drift would orphan them.
    #[test]
    fn streamed_fingerprint_matches_the_buffered_one() {
        let dir = scratch_dir("streamed");
        let path = dir.join("melody.wav");
        let sr = 44_100;
        write_wav(&path, &melody_pcm(&[261.63, 329.63, 392.0, 523.25, 440.0], sr, 2.0), sr);
        let path_str = path.to_str().unwrap();

        let (pcm, rate, channels, _) = decode_to_pcm(path_str).unwrap();
        let buffered = compute_fingerprint(&pcm, rate, channels).unwrap();
        let streamed = compute_fingerprint_file(path_str).unwrap();
        assert!(!buffered.is_empty());
        assert_eq!(streamed.fingerprint, buffered);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The batch path (parallel compute + one transaction) agrees with the
    /// single-file path and serves the second run entirely from the cache.
    #[test]
    fn fingerprint_many_matches_get_or_compute_and_caches() {
        let dir = scratch_dir("many");
        let sr = 44_100;
        let mut paths = Vec::new();
        for (i, f) in [220.0, 330.0, 440.0].iter().enumerate() {
            let p = dir.join(format!("tone{i}.wav"));
            write_wav(&p, &sine_pcm(*f, sr, 2.0), sr);
            paths.push(p.to_string_lossy().to_string());
        }
        paths.push(dir.join("missing.wav").to_string_lossy().to_string());
        let mut conn = Connection::open(dir.join("cache.sqlite")).unwrap();
        conn.execute_batch(FILE_CACHE_SCHEMA_SQL).unwrap();

        let first = fingerprint_many(&mut conn, &paths, |_, _| {});
        assert_eq!(first.len(), 4);
        assert!(first[3].is_err(), "a missing file is an error, not a dropped entry");
        for (path, fp) in paths.iter().zip(&first).take(3) {
            let single = get_or_compute(&conn, path).unwrap();
            assert_eq!(fp.as_ref().unwrap().fingerprint, single.fingerprint);
        }
        let cached: i64 = conn
            .query_row("SELECT COUNT(*) FROM file_cache WHERE fingerprint IS NOT NULL", [], |r| r.get(0))
            .unwrap();
        assert_eq!(cached, 3);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn waveform_buckets_fold_blocks_by_max() {
        let blocks: Vec<f32> = (0..1000).map(|i| (i % 10) as f32 / 10.0).collect();
        let peaks = bucket_peaks(&blocks);
        assert_eq!(peaks.len(), WAVEFORM_BUCKETS);
        assert!(peaks.iter().all(|p| (0.0..=1.0).contains(p)));
        assert_eq!(bucket_peaks(&[0.5, 0.25]), vec![0.5, 0.25], "short input passes through");
    }

    #[test]
    fn get_or_compute_caches_and_reuses_the_fingerprint() {
        let dir = scratch_dir("cache");
        let path = dir.join("tone.wav");
        let sr = 44_100;
        write_wav(&path, &sine_pcm(440.0, sr, 3.0), sr);
        let path_str = path.to_str().unwrap();

        let db_path = dir.join("cache.sqlite");
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch(FILE_CACHE_SCHEMA_SQL).unwrap();

        let first = get_or_compute(&conn, path_str).unwrap();
        assert!(!first.fingerprint.is_empty());

        // Second call must hit the cache and return the identical fingerprint
        // without needing to touch symphonia again (mtime/size unchanged).
        let second = get_or_compute(&conn, path_str).unwrap();
        assert_eq!(first.fingerprint, second.fingerprint);
        assert_eq!(first.blake3, second.blake3);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn waveform_and_fingerprint_caches_survive_each_other() {
        let dir = scratch_dir("waveform");
        let path = dir.join("tone.wav");
        let sr = 44_100;
        write_wav(&path, &sine_pcm(440.0, sr, 3.0), sr);
        let path_str = path.to_str().unwrap();

        let conn = Connection::open(dir.join("cache.sqlite")).unwrap();
        conn.execute_batch(FILE_CACHE_SCHEMA_SQL).unwrap();

        // Fingerprint first, then waveform — writing the waveform must not
        // wipe out the fingerprint that was just cached for the same
        // unchanged file (the CASE-guarded upsert this test exists to check).
        let fp = get_or_compute(&conn, path_str).unwrap();
        let peaks = get_or_compute_waveform(&conn, path_str).unwrap();
        assert!(!peaks.is_empty());
        assert!(peaks.iter().all(|p| (0.0..=1.0).contains(p)), "peaks should be normalized 0-1");

        let fp_again = get_or_compute(&conn, path_str).unwrap();
        assert_eq!(fp.fingerprint, fp_again.fingerprint, "fingerprint should survive a waveform write");

        // And the reverse: waveform must be cached and reused, not just the
        // fingerprint.
        let peaks_again = get_or_compute_waveform(&conn, path_str).unwrap();
        // Not exact equality: peaks are stored as text rounded to 4 decimal
        // places, so a round trip through the cache loses a little precision
        // by design (keeps the cached payload small).
        assert_eq!(peaks.len(), peaks_again.len());
        for (a, b) in peaks.iter().zip(peaks_again.iter()) {
            assert!((a - b).abs() < 0.001, "peak drifted too far after a cache round-trip: {a} vs {b}");
        }

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_row_from_a_different_algo_version_is_treated_as_a_cache_miss() {
        let dir = scratch_dir("algo-version-mismatch");
        let path = dir.join("tone.wav");
        let sr = 44_100;
        write_wav(&path, &sine_pcm(440.0, sr, 3.0), sr);
        let path_str = path.to_str().unwrap();

        let conn = Connection::open(dir.join("cache.sqlite")).unwrap();
        conn.execute_batch(FILE_CACHE_SCHEMA_SQL).unwrap();

        let first = get_or_compute(&conn, path_str).unwrap();
        let first_peaks = get_or_compute_waveform(&conn, path_str).unwrap();

        // Simulate a row left behind by an older build, before an algorithm
        // change bumped ALGO_VERSION — same mtime/size, stale version.
        conn.execute("UPDATE file_cache SET algo_version = -1 WHERE path = ?1", params![path_str])
            .unwrap();

        // Both must recompute rather than trust the stale row, and the
        // recompute must restamp the row with the current ALGO_VERSION so a
        // third call hits the cache again instead of recomputing forever.
        let refreshed = get_or_compute(&conn, path_str).unwrap();
        assert_eq!(first.fingerprint, refreshed.fingerprint, "same audio, so the recomputed value matches");
        let refreshed_peaks = get_or_compute_waveform(&conn, path_str).unwrap();
        assert_eq!(first_peaks.len(), refreshed_peaks.len());

        let version: i64 =
            conn.query_row("SELECT algo_version FROM file_cache WHERE path = ?1", params![path_str], |r| r.get(0))
                .unwrap();
        assert_eq!(version, ALGO_VERSION);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_algo_version_migration_is_idempotent_on_a_pre_migration_database() {
        let dir = scratch_dir("pre-migration-db");
        let db_path = dir.join("cache.sqlite");

        // A database created before `algo_version` existed in the schema —
        // what `open_db`'s ALTER TABLE has to cope with on a real user's
        // existing database (it can't call `open_db` itself here, which
        // needs a live `AppHandle`, so this exercises the same migration
        // statement it runs).
        let legacy_schema = "CREATE TABLE IF NOT EXISTS file_cache (
            path TEXT PRIMARY KEY, mtime INTEGER NOT NULL, size INTEGER NOT NULL,
            blake3_hash TEXT, fingerprint TEXT, duration_secs REAL, sample_rate INTEGER,
            waveform_peaks TEXT
        );";
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch(legacy_schema).unwrap();

        // First run adds the column; a second run (a schema that already has
        // it, same as `open_db` running against an up-to-date database)
        // must not error even though SQLite has no "IF NOT EXISTS" for this.
        conn.execute("ALTER TABLE file_cache ADD COLUMN algo_version INTEGER", []).unwrap();
        let _ = conn.execute("ALTER TABLE file_cache ADD COLUMN algo_version INTEGER", []);

        conn.execute("INSERT INTO file_cache (path, mtime, size, algo_version) VALUES ('x', 1, 1, 1)", [])
            .unwrap();

        std::fs::remove_dir_all(&dir).ok();
    }

    /// A short melody (concatenated fixed-length notes) — Chromaprint works
    /// on tonal/chroma content, so a meaningful "these are different songs"
    /// fixture needs distinct pitch sequences over time. Plain white noise
    /// is a poor fixture here: it carries no chroma content, so two
    /// unrelated noise clips can score deceptively "similar" to a chroma-based
    /// algorithm in a way two different real songs would not.
    fn melody_pcm(note_freqs: &[f64], sample_rate: u32, seconds_per_note: f64) -> Vec<i16> {
        let mut out = Vec::new();
        for &freq in note_freqs {
            out.extend(sine_pcm(freq, sample_rate, seconds_per_note));
        }
        out
    }

    /// The pre-check is only worth having if it never changes an answer:
    /// whenever it skips a pair, the real matcher must say `NoMatch`, and its
    /// alignment must be the one `match_fingerprints` actually segments on.
    /// Checked over identical, noisy, shifted, truncated, low-entropy and
    /// unrelated fingerprints - random ones, and real chroma fingerprints of
    /// synthetic melodies (structured the way music is).
    #[test]
    fn prefilter_never_changes_a_result() {
        let config = fingerprint_config();
        let item_secs = config.item_duration_in_seconds() as f64;
        let mut seed = 0x9E37_79B9_7F4A_7C15u64;
        let mut rnd = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        let fp_of = |items: Vec<u32>| CachedFingerprint {
            blake3: String::new(),
            duration_secs: items.len() as f64 * item_secs,
            sample_rate: 44_100,
            fingerprint: items,
        };

        let mut bases: Vec<Vec<u32>> = (0..10)
            .map(|_| {
                let n = 150 + (rnd() % 900) as usize;
                (0..n).map(|_| rnd() as u32).collect()
            })
            .collect();
        let sr = 11_025;
        for notes in [
            &[261.63, 329.63, 392.0, 523.25, 440.0, 349.23][..],
            &[220.0, 246.94, 261.63, 293.66, 329.63][..],
            &[196.0, 174.61, 164.81, 261.63, 329.63, 392.0, 523.25][..],
        ] {
            bases.push(compute_fingerprint(&melody_pcm(notes, sr, 3.0), sr, 1).unwrap());
        }

        let mut fps: Vec<CachedFingerprint> = Vec::new();
        for base in &bases {
            let n = base.len();
            for flips in [0u32, 2, 5, 9, 14] {
                let noisy = base
                    .iter()
                    .map(|&x| (0..flips).fold(x, |y, _| y ^ (1 << (rnd() % 32))))
                    .collect();
                fps.push(fp_of(noisy));
            }
            fps.push(fp_of(base[n / 3..].to_vec()));
            fps.push(fp_of(base[..n - n / 3].to_vec()));
            fps.push(fp_of(base[n / 4..n - n / 4].to_vec()));
            fps.push(fp_of((0..n).map(|i| base[i % 7]).collect()));
        }
        fps.push(fp_of(Vec::new()));

        let buckets: Vec<AlignBuckets> = fps.iter().map(|f| align_buckets(&f.fingerprint)).collect();
        let mut scratch = PrecheckScratch::default();
        let (mut pairs, mut skipped, mut matched) = (0, 0, 0);
        for i in 0..fps.len() {
            for j in (i + 1)..fps.len() {
                pairs += 1;
                let (a, b) = (&fps[i], &fps[j]);
                if let Ok(segments) = match_fingerprints(&a.fingerprint, &b.fingerprint, &config) {
                    if let Some(s) = segments.first() {
                        let d = best_alignment(&buckets[i], a.fingerprint.len(), &b.fingerprint, &mut scratch)
                            .expect("matcher found segments, so an alignment exists");
                        let shift = d as isize - b.fingerprint.len() as isize;
                        assert_eq!(s.offset1 as isize - s.offset2 as isize, shift, "alignment differs ({i}, {j})");
                    }
                }
                let maybe = could_match(a, &buckets[i], b, &config, &mut scratch);
                for real in [None, Some((a.duration_secs, b.duration_secs)), Some((a.duration_secs, b.duration_secs * 3.0))] {
                    let m = classify_pair_real(a, b, &config, real);
                    if !maybe {
                        assert!(matches!(m, PairMatch::NoMatch), "pre-check skipped a real match ({i}, {j})");
                    } else if !matches!(m, PairMatch::NoMatch) {
                        matched += 1;
                    }
                }
                skipped += (!maybe) as usize;
            }
        }
        assert!(matched > 0, "the fixtures should contain real matches");
        // And it has to skip most unrelated pairs to be worth the code.
        assert!(skipped * 10 > pairs * 7, "only skipped {skipped} of {pairs} pairs");
    }

    /// Timing of the all-pairs stage with and without the pre-check, on
    /// fingerprints the size of real ones (~120 s analysed). Opt-in:
    ///   cargo test --release prefilter_speed -- --ignored --nocapture
    #[test]
    #[ignore]
    fn prefilter_speed() {
        let config = fingerprint_config();
        let mut seed = 42u64;
        let mut rnd = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        let fps: Vec<CachedFingerprint> = (0..400)
            .map(|_| CachedFingerprint {
                blake3: String::new(),
                fingerprint: (0..970).map(|_| rnd() as u32).collect(),
                duration_secs: 120.0,
                sample_rate: 44_100,
            })
            .collect();
        let started = std::time::Instant::now();
        let mut plain = 0;
        for i in 0..fps.len() {
            for j in (i + 1)..fps.len() {
                plain += !matches!(classify_pair_real(&fps[i], &fps[j], &config, None), PairMatch::NoMatch) as usize;
            }
        }
        let t_plain = started.elapsed();
        let started = std::time::Instant::now();
        let mut scratch = PrecheckScratch::default();
        let mut filtered = 0;
        for i in 0..fps.len() {
            let buckets = align_buckets(&fps[i].fingerprint);
            for j in (i + 1)..fps.len() {
                if could_match(&fps[i], &buckets, &fps[j], &config, &mut scratch) {
                    filtered +=
                        !matches!(classify_pair_real(&fps[i], &fps[j], &config, None), PairMatch::NoMatch) as usize;
                }
            }
        }
        let t_filtered = started.elapsed();
        println!("{} pairs: plain {t_plain:?}, with pre-check {t_filtered:?}", fps.len() * (fps.len() - 1) / 2);
        assert_eq!(plain, filtered);
    }

    #[test]
    fn radio_edit_inside_extended_mix_classifies_as_alternate_not_duplicate() {
        let sr = 11025;
        // "Radio edit": one shared melody phrase.
        let shared_phrase = [261.63, 329.63, 392.00, 523.25, 440.0, 349.23];
        let radio_pcm = melody_pcm(&shared_phrase, sr, 4.0);
        // "Extended mix": an intro and outro (never in the radio edit) around the same shared phrase.
        let mut extended_notes = vec![220.0, 246.94, 261.63];
        extended_notes.extend_from_slice(&shared_phrase);
        extended_notes.extend_from_slice(&[196.00, 174.61, 164.81]);
        let extended_pcm = melody_pcm(&extended_notes, sr, 4.0);

        let fp_radio = compute_fingerprint(&radio_pcm, sr, 1).unwrap();
        let fp_extended = compute_fingerprint(&extended_pcm, sr, 1).unwrap();
        let radio = CachedFingerprint {
            blake3: "radio".into(),
            fingerprint: fp_radio,
            duration_secs: radio_pcm.len() as f64 / sr as f64,
            sample_rate: sr,
        };
        let extended = CachedFingerprint {
            blake3: "extended".into(),
            fingerprint: fp_extended,
            duration_secs: extended_pcm.len() as f64 / sr as f64,
            sample_rate: sr,
        };
        let config = fingerprint_config();
        match classify_pair(&radio, &extended, &config) {
            PairMatch::Alternate { .. } => {}
            PairMatch::Duplicate { score } => {
                panic!("radio edit vs. extended mix should classify as Alternate, not Duplicate (score {score})")
            }
            PairMatch::NoMatch => panic!(
                "radio edit vs. extended mix should classify as Alternate, got NoMatch — the shared phrase wasn't matched"
            ),
        }
    }

    #[test]
    fn identical_audio_scores_as_a_strong_match() {
        let sr = 11025;
        let pcm_a = sine_pcm(440.0, sr, 20.0);
        let pcm_b = pcm_a.clone();
        let fp_a = compute_fingerprint(&pcm_a, sr, 1).unwrap();
        let fp_b = compute_fingerprint(&pcm_b, sr, 1).unwrap();
        let config = fingerprint_config();
        let segments = match_fingerprints(&fp_a, &fp_b, &config).unwrap();
        let best = segments.iter().max_by(|a, b| a.items_count.cmp(&b.items_count));
        assert!(best.is_some(), "identical audio should produce at least one matching segment");
        assert!(
            best.unwrap().score <= DUPLICATE_SCORE_MAX,
            "identical audio should score within the duplicate threshold, got {}",
            best.unwrap().score
        );
    }

    #[test]
    fn different_melodies_do_not_match_as_duplicates() {
        let sr = 11025;
        // Two clearly different, unrelated note sequences.
        let pcm_a = melody_pcm(&[261.63, 329.63, 392.00, 523.25], sr, 5.0); // C E G C (C major arpeggio)
        let pcm_b = melody_pcm(&[233.08, 277.18, 311.13, 466.16], sr, 5.0); // A#/Bb-ish minor-flavored run
        let fp_a = compute_fingerprint(&pcm_a, sr, 1).unwrap();
        let fp_b = compute_fingerprint(&pcm_b, sr, 1).unwrap();
        let config = fingerprint_config();
        let segments = match_fingerprints(&fp_a, &fp_b, &config).unwrap();
        let best_score = segments
            .iter()
            .max_by(|a, b| a.items_count.cmp(&b.items_count))
            .map(|s| s.score)
            .unwrap_or(f64::MAX);
        assert!(
            best_score > DUPLICATE_SCORE_MAX,
            "different melodies should not score as a duplicate, got {best_score}"
        );
    }

    // ---- v0.19: regression fixture for the classification history --------
    //
    // ROADMAP #34 records two earlier changes to classification that each fixed
    // one real case and broke another. These pin every behaviour that history
    // established, so a recall change cannot silently undo one of them.

    #[test]
    fn classification_thresholds_stay_where_real_libraries_put_them() {
        // Tightened 14.0 -> 6.0 -> 4.0 after shared-jingle false positives
        // (unrelated tracks scored 4.84-9.55; genuine alternates 0.03-3.14).
        assert_eq!(ALTERNATE_SCORE_MAX, 4.0);
        assert_eq!(ALTERNATE_MIN_COVERAGE, 0.35);
        assert_eq!(DUPLICATE_SCORE_MAX, 10.0);
        assert_eq!(DUPLICATE_MIN_COVERAGE, 0.85);
        // Silence removal is part of the fingerprint config (a cache-version event).
        assert_eq!(ALGO_VERSION, 1);
    }

    fn fp_of(pcm: &[i16], sr: u32, hash: &str) -> CachedFingerprint {
        CachedFingerprint {
            blake3: hash.into(),
            fingerprint: compute_fingerprint(pcm, sr, 1).unwrap(),
            duration_secs: pcm.len() as f64 / sr as f64,
            sample_rate: sr,
        }
    }

    #[test]
    fn same_opening_but_different_real_length_is_an_alternate_not_a_duplicate() {
        // The fingerprint only sees the first ~2 minutes, so a 3:00 radio edit
        // and an 8:00 extended mix with the same opening both read as 120 s
        // and used to be a "duplicate". Real lengths now break the tie.
        let sr = 11025;
        let pcm = sine_pcm(440.0, sr, 20.0);
        let a = fp_of(&pcm, sr, "a");
        let b = fp_of(&pcm, sr, "b");
        let config = fingerprint_config();
        assert!(matches!(classify_pair_real(&a, &b, &config, None), PairMatch::Duplicate { .. }));
        assert!(matches!(classify_pair_real(&a, &b, &config, Some((180.0, 181.0))), PairMatch::Duplicate { .. }));
        assert!(matches!(classify_pair_real(&a, &b, &config, Some((180.0, 480.0))), PairMatch::Alternate { .. }));
    }

    #[test]
    fn the_same_song_at_another_sample_rate_is_still_a_duplicate() {
        // The analysis cap is in samples, so a 48 kHz copy is analysed for
        // ~110 s against 120 s for a 44.1 kHz one (real case: Arash - Boro Boro).
        // Those analysed lengths differ by more than the 5 % tolerance even
        // though the files are the same length.
        let sr = 11025;
        let pcm = sine_pcm(440.0, sr, 20.0);
        let a = fp_of(&pcm, sr, "a");
        let mut b = fp_of(&pcm, sr, "b");
        b.duration_secs = a.duration_secs - 2.2;
        let config = fingerprint_config();
        assert!(matches!(classify_pair_real(&a, &b, &config, None), PairMatch::Alternate { .. }));
        assert!(matches!(classify_pair_real(&a, &b, &config, Some((192.0, 192.2))), PairMatch::Duplicate { .. }));
    }

    #[test]
    fn different_melodies_still_do_not_match_even_with_matching_tags_logic_untouched() {
        let sr = 11025;
        let a = fp_of(&melody_pcm(&[261.63, 329.63, 392.0, 523.25], sr, 5.0), sr, "a");
        let b = fp_of(&melody_pcm(&[196.0, 233.08, 277.18, 311.13], sr, 5.0), sr, "b");
        assert!(matches!(classify_pair_real(&a, &b, &fingerprint_config(), Some((20.0, 20.0))), PairMatch::NoMatch));
    }

    // ---- tag / file-name matching ----------------------------------------

    fn meta(artist: &str, title: &str, file: &str) -> TrackMeta {
        build_meta(Some(artist), Some(title), file, None)
    }

    #[test]
    fn version_tags_come_off_the_title_in_every_dj_pool_style() {
        for (raw, base, versions) in [
            ("Smack That (Radio Edit)", "Smack That", vec!["radio edit"]),
            ("Smack That [Extended Mix]", "Smack That", vec!["extended mix"]),
            ("Smack That - Extended Mix", "Smack That", vec!["extended mix"]),
            ("Smack That (DJcity Intro - Clean)", "Smack That", vec!["djcity intro clean"]),
            ("Smack That (Original Mix)", "Smack That", vec![]),
            ("Smack That (Dirty)", "Smack That", vec!["dirty"]),
            ("Smack That [Clean] (Intro)", "Smack That", vec!["clean", "intro"]),
            ("Smack That (Acapella)", "Smack That", vec!["acapella"]),
            ("Smack That (Instrumental)", "Smack That", vec!["instrumental"]),
            ("Smack That (feat. Eminem) [Radio Edit]", "Smack That", vec!["radio edit"]),
            ("Smack That - Joe Smith Remix", "Smack That", vec!["joe smith remix"]),
        ] {
            let (b, v, _) = split_title(raw);
            assert_eq!(b, base, "{raw}");
            assert_eq!(v, versions, "{raw}");
        }
    }

    #[test]
    fn real_title_brackets_are_not_mistaken_for_versions() {
        // All from the owner's library.
        for raw in [
            "Gonna Make You Sweat (Everybody Dance Now)",
            "I'm Gonna Be (500 Miles)",
            "The Time (Dirty Bit)",
            "Life Is Simple (Move Your Body)",
            "Live Is Life",
            "Song (2012)",
            "Tung Tung Tung Sahur (Italian Brainrot)",
            "Kernkraft 400 - Melody",
            "Destination Calabria - Melody",
        ] {
            let (b, v, _) = split_title(raw);
            assert_eq!(b, raw, "{raw} must keep its whole name");
            assert!(v.is_empty(), "{raw} -> {v:?}");
        }
    }

    #[test]
    fn radio_and_extended_of_one_song_are_the_same_song() {
        let radio = meta("David Guetta", "Titanium (Radio Edit)", "a.mp3");
        let extended = meta("David Guetta", "Titanium (Extended Mix)", "b.mp3");
        let plain = meta("David Guetta", "Titanium", "c.mp3");
        assert!(same_song(&radio, &extended));
        assert!(same_song(&radio, &plain));
        assert!(versions_differ(&radio, &extended));
        assert!(versions_differ(&radio, &plain));
        assert!(!versions_differ(&plain, &meta("David Guetta", "Titanium (Original Mix)", "d.mp3")));
    }

    #[test]
    fn artist_and_title_normalisation_covers_the_usual_spellings() {
        let a = meta("Beyoncé", "Crazy In Love", "a.mp3");
        let b = meta("Beyonce", "Crazy in Love", "b.mp3");
        assert!(same_song(&a, &b), "accents and case");
        assert!(same_song(&meta("Basshunter", "Now You're Gone", "a.mp3"), &meta("Basshunter", "Now You re Gone", "b.mp3")), "apostrophe vs space");
        assert!(same_song(&meta("Calvin Harris & Rihanna", "We Found Love", "a.mp3"), &meta("Calvin Harris", "We Found Love", "b.mp3")), "extra credited artist");
        assert!(same_song(&meta("Calvin Harris feat. Rihanna", "We Found Love", "a.mp3"), &meta("Calvin Harris", "We Found Love", "b.mp3")), "feat. credit");
        assert!(same_song(&meta("Calvin Harris ft. Rihanna", "We Found Love", "a.mp3"), &meta("Rihanna", "We Found Love", "b.mp3")), "ft. credit on either side");
        assert!(same_song(&meta("Adam Port", "Move", "a.mp3"), &meta("Adam Port Stryv Keinemusik Orso Malachiii", "Move", "b.mp3")), "space-joined credits");
        assert!(same_song(&meta("Tom & Jerry", "Cat & Dog", "a.mp3"), &meta("Tom and Jerry", "Cat and Dog", "b.mp3")), "& vs and");
        assert!(same_song(&meta("Foo", "The Bomb", "a.mp3"), &meta("Foo", "Bomb", "b.mp3")), "leading The");
        assert!(same_song(&meta("Artik N Asti", "Грустный Дэнс", "a.mp3"), &meta("ARTIK N ASTI", "грустный дэнс", "b.mp3")), "Cyrillic case");
    }

    #[test]
    fn different_songs_do_not_match() {
        assert!(!same_song(&meta("Foo", "Levels", "a.mp3"), &meta("Bar", "Levels", "b.mp3")), "same title, different artist");
        assert!(!same_song(&meta("Foo", "Levels", "a.mp3"), &meta("Foo", "Levels Two", "b.mp3")), "different title");
        assert!(!same_song(&meta("Foo", "Intro", "a.mp3"), &meta("Foo", "Intro", "b.mp3")), "generic title never identifies a song");
        assert!(!same_song(&meta("Foo", "", "a.mp3"), &meta("Foo", "", "b.mp3")), "no title");
        assert!(!same_song(&meta("", "Levels", "a.mp3"), &meta("", "Levels", "b.mp3")), "no artist");
        assert!(!same_song(&meta("Ed", "Perfect", "a.mp3"), &meta("Edward Sharp", "Perfect", "b.mp3")), "short names are not a prefix match");
    }

    #[test]
    fn missing_tags_fall_back_to_the_file_name() {
        let path = r"C:\Music\Akon - Smack That (Radio Edit) - 000224.mp3";
        let m = build_meta(None, None, path, Some(212.0));
        assert_eq!(m.title, "smackthat");
        assert_eq!(m.artists, vec!["akon"]);
        assert_eq!(m.versions, vec!["radio edit"]);
        assert_eq!(m.duration_secs, Some(212.0));

        let numbered = build_meta(None, None, r"C:\Music\01 - Akon - Smack That.mp3", None);
        assert_eq!(numbered.title, "smackthat");
        assert_eq!(numbered.artists, vec!["akon"]);

        let keyed = build_meta(None, None, r"C:\Music\8A - 126 - Akon - Smack That.mp3", None);
        assert_eq!(keyed.title, "smackthat");

        // One tag present, the other from the name.
        let half = build_meta(Some("Akon"), None, r"C:\Music\Akon - Smack That.mp3", None);
        assert_eq!(half.title, "smackthat");

        // Artist names that start with a number are not stripped.
        let num = build_meta(None, None, r"C:\Music\50 Cent - In Da Club.mp3", None);
        assert_eq!(num.artists, vec!["50cent"]);

        // No " - " and no tags: nothing to match on.
        assert_eq!(build_meta(None, None, r"C:\Music\song.mp3", None).title, "");
    }

    #[test]
    fn the_tag_title_keeps_versions_that_only_the_file_name_remembers() {
        // The owner's tags are cleaned ("Despacito") while the file keeps "(B-Phisto Remix)".
        let m = build_meta(Some("Luis Fonsi"), Some("Despacito"), r"C:\Music\Luis Fonsi - Despacito (B-Phisto Remix).mp3", None);
        assert_eq!(m.title, "despacito");
        assert_eq!(m.versions, vec!["b phisto remix"]);
    }

    // ---- end-to-end scan on synthetic files ------------------------------

    fn scan_dir(files: &[(&str, Vec<i16>)], sr: u32) -> (Vec<DuplicateGroup>, Vec<String>, PathBuf) {
        let dir = scratch_dir("scan");
        let mut paths = Vec::new();
        for (name, pcm) in files {
            let p = dir.join(name);
            write_wav(&p, pcm, sr);
            paths.push(p.to_str().unwrap().to_string());
        }
        let mut conn = Connection::open(dir.join("cache.sqlite")).unwrap();
        conn.execute_batch(FILE_CACHE_SCHEMA_SQL).unwrap();
        let groups = scan_duplicates_core(&mut conn, &paths, |_, _, _| {});
        (groups, paths, dir)
    }

    #[test]
    fn radio_and_extended_with_unrelated_audio_are_grouped_by_tags_as_alternate() {
        // Different audio in the analysed window (a long DJ intro), so
        // fingerprints alone can never connect them.
        let sr = 11025;
        let radio = melody_pcm(&[261.63, 329.63, 392.0, 523.25], sr, 3.0);
        let extended = melody_pcm(&[110.0, 123.47, 130.81, 146.83, 164.81, 174.61], sr, 3.0);
        let (groups, paths, dir) = scan_dir(
            &[
                ("Some Artist - Great Song (Radio Edit).wav", radio),
                ("Some Artist - Great Song (Extended Mix).wav", extended),
                ("Other Artist - Different Song.wav", melody_pcm(&[300.0, 350.0, 400.0, 450.0], sr, 3.0)),
            ],
            sr,
        );
        assert_eq!(groups.len(), 1, "{groups:?}");
        let g = &groups[0];
        assert_eq!(g.kind, "alternate");
        assert_eq!(g.reason, "tags");
        let mut got = g.paths.clone();
        got.sort();
        assert_eq!(got, vec![paths[0].clone(), paths[1].clone()].into_iter().collect::<std::collections::BTreeSet<_>>().into_iter().collect::<Vec<_>>());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn identical_audio_with_different_version_tags_is_an_alternate() {
        // Same audio, "Clean" vs "Dirty": two files, not one to delete.
        let sr = 11025;
        let pcm = melody_pcm(&[261.63, 329.63, 392.0, 523.25, 440.0, 349.23], sr, 3.0);
        // A tiny tail change so the bytes (and blake3) differ.
        let mut pcm2 = pcm.clone();
        pcm2.extend_from_slice(&[0; 200]);
        let (groups, _, dir) = scan_dir(
            &[("Artist - Song (Clean).wav", pcm), ("Artist - Song (Dirty).wav", pcm2)],
            sr,
        );
        assert_eq!(groups.len(), 1, "{groups:?}");
        assert_eq!(groups[0].kind, "alternate");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn identical_audio_with_identical_tags_is_still_a_duplicate() {
        let sr = 11025;
        let pcm = melody_pcm(&[261.63, 329.63, 392.0, 523.25, 440.0, 349.23], sr, 3.0);
        let mut pcm2 = pcm.clone();
        pcm2.extend_from_slice(&[0; 200]);
        let (groups, _, dir) = scan_dir(&[("Artist - Song.wav", pcm), ("Artist - Song - 000224.wav", pcm2)], sr);
        assert_eq!(groups.len(), 1, "{groups:?}");
        assert_eq!(groups[0].kind, "duplicate");
        assert_eq!(groups[0].reason, "audio");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn byte_identical_copies_still_link_to_an_alternate_version() {
        // A, A-copy (byte-identical) and an extended mix: before, the exact
        // copies were left out of the fingerprint stage, so the extended mix
        // was never connected to either.
        let sr = 11025;
        let radio = melody_pcm(&[261.63, 329.63, 392.0, 523.25], sr, 3.0);
        let extended = melody_pcm(&[110.0, 123.47, 130.81, 146.83, 164.81, 174.61], sr, 3.0);
        let (groups, _, dir) = scan_dir(
            &[
                ("Artist - Song (Radio Edit).wav", radio.clone()),
                ("Artist - Song (Radio Edit) - 000224.wav", radio),
                ("Artist - Song (Extended Mix).wav", extended),
            ],
            sr,
        );
        assert_eq!(groups.len(), 1, "{groups:?}");
        assert_eq!(groups[0].paths.len(), 3);
        assert_eq!(groups[0].kind, "alternate");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn exact_copies_alone_keep_their_exact_group() {
        let sr = 11025;
        let pcm = melody_pcm(&[261.63, 329.63, 392.0, 523.25], sr, 3.0);
        let (groups, _, dir) = scan_dir(&[("One - Track.wav", pcm.clone()), ("Two - Other.wav", pcm)], sr);
        assert_eq!(groups.len(), 1);
        assert!(groups[0].id.starts_with("exact-"));
        assert_eq!(groups[0].kind, "duplicate");
        assert_eq!(groups[0].score, 0.0);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn same_title_with_wildly_different_lengths_is_not_grouped_by_tags() {
        let sr = 11025;
        let (groups, _, dir) = scan_dir(
            &[
                ("Artist - Song.wav", melody_pcm(&[261.63, 329.63], sr, 1.0)),
                ("Artist - Song (Live Set).wav", melody_pcm(&[110.0, 123.47, 130.81, 146.83, 164.81, 174.61, 196.0, 220.0, 246.94, 261.63], sr, 5.0)),
            ],
            sr,
        );
        assert!(groups.is_empty(), "{groups:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---- waveforms --------------------------------------------------------

    #[test]
    fn an_empty_cached_waveform_is_recomputed() {
        let dir = scratch_dir("wave-empty");
        let path = dir.join("tone.wav");
        write_wav(&path, &sine_pcm(440.0, 11025, 3.0), 11025);
        let path_str = path.to_str().unwrap();
        let (mtime, size) = file_stat(&path).unwrap();
        let conn = Connection::open(dir.join("cache.sqlite")).unwrap();
        conn.execute_batch(FILE_CACHE_SCHEMA_SQL).unwrap();
        for bad in ["", ",,,", "nan,x"] {
            conn.execute(
                "INSERT INTO file_cache (path, mtime, size, waveform_peaks, algo_version) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(path) DO UPDATE SET waveform_peaks = excluded.waveform_peaks",
                params![path_str, mtime, size, bad, ALGO_VERSION],
            )
            .unwrap();
            let peaks = get_or_compute_waveform(&conn, path_str).unwrap();
            assert!(!peaks.is_empty(), "cached {bad:?} must be treated as a miss");
        }
        // NULL too.
        conn.execute("UPDATE file_cache SET waveform_peaks = NULL", []).unwrap();
        assert!(!get_or_compute_waveform(&conn, path_str).unwrap().is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_truncated_file_keeps_the_peaks_decoded_so_far() {
        let dir = scratch_dir("wave-trunc");
        let path = dir.join("cut.wav");
        write_wav(&path, &sine_pcm(440.0, 11025, 10.0), 11025);
        // Header still promises 10 s; only ~4 s of samples are left.
        let bytes = std::fs::read(&path).unwrap();
        std::fs::write(&path, &bytes[..bytes.len() * 2 / 5]).unwrap();
        let peaks = compute_waveform_file(path.to_str().unwrap(), None).expect("partial waveform, not an error");
        assert!(peaks.len() > 10, "{} peaks", peaks.len());
        assert!(peaks.iter().any(|p| *p > 0.5));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_undecodable_file_reports_a_readable_error_never_an_empty_waveform() {
        let dir = scratch_dir("wave-bad");
        let path = dir.join("junk.mp3");
        std::fs::write(&path, b"this is not audio at all, just some text bytes").unwrap();
        let conn = Connection::open(dir.join("cache.sqlite")).unwrap();
        conn.execute_batch(FILE_CACHE_SCHEMA_SQL).unwrap();
        let err = get_or_compute_waveform(&conn, path.to_str().unwrap()).unwrap_err();
        assert!(err.starts_with("Couldn't generate a waveform"), "{err}");
        assert!(get_or_compute_waveform(&conn, dir.join("missing.mp3").to_str().unwrap()).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_failing_cache_write_does_not_lose_the_waveform() {
        // A scan holding the write lock made the UPSERT time out and the
        // finished waveform was thrown away with the error.
        let dir = scratch_dir("wave-ro");
        let path = dir.join("tone.wav");
        write_wav(&path, &sine_pcm(440.0, 11025, 3.0), 11025);
        let conn = Connection::open(dir.join("cache.sqlite")).unwrap();
        conn.execute_batch(FILE_CACHE_SCHEMA_SQL).unwrap();
        conn.pragma_update(None, "query_only", true).unwrap();
        let peaks = get_or_compute_waveform(&conn, path.to_str().unwrap()).expect("computed even though caching failed");
        assert!(!peaks.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn ffmpeg_peaks_agree_with_symphonia_when_ffmpeg_is_installed() {
        let Some(ffmpeg) = crate::commands::ffmpeg::on_path(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" }) else {
            eprintln!("ffmpeg not installed: skipping");
            return;
        };
        let dir = scratch_dir("wave-ffmpeg");
        let path = dir.join("tone.wav");
        let mut pcm = sine_pcm(440.0, 22050, 4.0);
        pcm.extend(vec![0i16; 22050 * 4]); // loud half then silent half
        write_wav(&path, &pcm, 22050);
        let p = path.to_str().unwrap();
        let sym = compute_waveform_symphonia(p).unwrap();
        let ff = compute_waveform_ffmpeg(&ffmpeg, p).unwrap();
        assert!((sym.decoded_secs - ff.decoded_secs).abs() < 0.2, "{} vs {}", sym.decoded_secs, ff.decoded_secs);
        assert_eq!(ff.peaks.len().min(WAVEFORM_BUCKETS), ff.peaks.len());
        let (head, tail) = (ff.peaks[ff.peaks.len() / 4], ff.peaks[ff.peaks.len() * 3 / 4]);
        assert!(head > 0.5 && tail < 0.01, "head {head}, tail {tail}");
        std::fs::remove_dir_all(&dir).ok();
    }
}
