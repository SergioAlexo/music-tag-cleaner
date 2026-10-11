use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioFile {
    pub path: String,
    pub filename: String,
    pub format: String,
    pub size: u64,
    pub has_backup: bool,
    /// Playback length in seconds, when readable from the file's audio properties.
    pub duration_secs: Option<f64>,
    /// Audio bitrate in kbps, when readable — used by duplicate review to
    /// judge which of two matching files is the better-quality copy.
    pub bitrate_kbps: Option<u32>,
    pub sample_rate_hz: Option<u32>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagData {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub track_number: Option<String>,
    pub disc_number: Option<String>,
    pub year: Option<String>,
    pub genre: Option<String>,
    pub comment: Option<String>,
    pub composer: Option<String>,
    pub original_artist: Option<String>,
    /// App-assigned unique id (from "Generate IDs"), stored in a private
    /// `TXXX:TRACKID` frame so it never collides with Track Number.
    pub track_id: Option<String>,
    /// Rating in stars, 0-5 (mapped from the POPM/rating byte).
    pub rating: Option<u8>,
    /// Tempo as written in the file (TBPM / `tmpo` / Vorbis `BPM`), kept as
    /// text so a decimal such as "127.99" shows exactly as stored.
    pub bpm: Option<String>,
    /// Musical key as written in the file (TKEY / `initialkey` / `INITIALKEY`),
    /// in whatever notation the writing app used ("8A", "Am", "Fm"...).
    pub key: Option<String>,
    /// Language of the vocals as an ISO 639-2 code (`spa`, `eng`, `zxx` for
    /// instrumentals): ID3 TLAN, Vorbis `LANGUAGE`.
    pub language: Option<String>,
    pub has_cover_art: bool,
    /// Full dump of every text field in the tag, keyed by a canonical
    /// (format-independent) name like `TrackTitle` or `Unknown(FOO)`.
    pub all_fields: BTreeMap<String, String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagReadResult {
    pub path: String,
    pub tags: Option<TagData>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInfo {
    pub mime: String,
    pub size_bytes: u64,
    pub width: u32,
    pub height: u32,
}

/// Result of recompressing one file's cover art. `None` from the command means
/// nothing was done (no art, or it already meets the target).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtworkChange {
    /// `data:<mime>;base64,…` of the picture before and after — carried into
    /// the undo/redo history exactly like a manual artwork swap.
    pub before_data_url: String,
    pub after_data_url: String,
    pub before_bytes: u64,
    pub after_bytes: u64,
    pub before_width: u32,
    pub before_height: u32,
    pub after_width: u32,
    pub after_height: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUsage {
    pub model: String,
    pub prompt_eval_count: u64,
    pub eval_count: u64,
    pub tracks: usize,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct OllamaStatus {
    pub running: bool,
    pub models: Vec<String>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TrackInput {
    pub index: u32,
    pub filename: String,
    pub artist: String,
    pub title: String,
    pub year: String,
    pub genre: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CleanedTrack {
    pub index: u32,
    pub artist: Option<String>,
    pub title: Option<String>,
    pub year: Option<String>,
    pub genre: Option<String>,
}

/// One Library track as the AI playlist prompt sees it (D5). `id` is the
/// pool-local 1-based index, not a database id — the AI echoes it back in
/// `trackIds`, and anything it returns outside the pool is dropped rather
/// than trusted (the "AI must never invent tracks" rule).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaylistTrackInput {
    pub id: u32,
    pub artist: String,
    pub title: String,
    pub genre: String,
    pub year: String,
    pub bpm: String,
}

/// One requested set (D4) — a name, and optionally how many tracks it
/// should hold. `target_count` of `None` lets the AI decide the split.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistSetSpec {
    pub name: String,
    pub target_count: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistSet {
    pub name: String,
    pub track_ids: Vec<u32>,
}

/// The AI's full answer (D5 + D6): the requested sets, plus a separate list
/// of songs it thinks would fit but aren't in the Library at all.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistAiResult {
    pub sets: Vec<PlaylistSet>,
    #[serde(default)]
    pub suggestions: Vec<String>,
}

/// One file's table thumbnail, as returned by `read_cover_thumbnails`.
/// `data_url` is `None` both for "no embedded art" and for an unreadable
/// file — the table draws the same placeholder either way, and a per-file
/// error here would only produce a toast storm on a large library.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverThumbnail {
    pub path: String,
    pub data_url: Option<String>,
}

/// One file's artwork metadata, as returned by `image_info_batch`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInfoResult {
    pub path: String,
    pub info: Option<ImageInfo>,
}

/// One file's worth of work for `write_tags_batch`. The flags that are the
/// same for every file in a run (backup, art preservation, backup field) are
/// passed once on the command itself rather than repeated per item.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteTagsItem {
    pub path: String,
    pub tags: TagData,
    /// Canonical key names of non-common fields to carry over untouched.
    pub keep_extra: Vec<String>,
}

/// One file's worth of work for `write_raw_fields_batch`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteRawFieldItem {
    pub path: String,
    pub field_key: String,
    pub value: String,
}

/// Outcome of one file in a batch write. `error` is `None` on success.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub path: String,
    pub error: Option<String>,
}

/// Outcome of a `standardize_tag_containers` sweep.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerSweepResult {
    /// Files whose tags were moved into the format's canonical container.
    pub converted: usize,
    /// Files already carrying only that container — left untouched.
    pub already: usize,
    /// "path: error" for each file that could not be rewritten.
    pub failed: Vec<String>,
}

/// Progress payload for the `write-progress` event.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteProgress {
    pub done: usize,
    pub total: usize,
}
