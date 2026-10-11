use std::path::Path;
use std::time::Duration;

use lofty::config::WriteOptions;
// Imported unnamed so `save_to_path` is in scope without clashing with our
// own `AudioFile` model struct.
use lofty::file::AudioFile as _;
use lofty::prelude::*;
use lofty::tag::{ItemKey, ItemValue, Tag, TagItem, TagType};
use tauri::Emitter;
use walkdir::WalkDir;

use crate::commands::backup::{find_backup_in_file, make_backup_string, BACKUP_KEY};
use crate::models::{
    AudioFile, ContainerSweepResult, CoverThumbnail, ImageInfo, ImageInfoResult, TagData,
    TagReadResult, WriteProgress, WriteRawFieldItem, WriteResult, WriteTagsItem,
};

/// Mirrored by `AUDIO_EXTENSIONS` in `src/types.ts`. `opus` is here because
/// Convert can produce it — without it the app couldn't list its own output.
pub const AUDIO_EXTENSIONS: &[&str] =
    &["mp3", "flac", "ogg", "opus", "aac", "m4a", "wav", "aiff", "aif"];

const FILE_OP_TIMEOUT: Duration = Duration::from_secs(20);

/// `key_name()` of the private frame that holds the app-assigned track id.
const TRACK_ID_FIELD: &str = "Unknown(TRACKID)";


/// MP4 only stores a custom field as an iTunes freeform atom
/// (`----:com.apple.iTunes:NAME`); a bare `Unknown("NAME")` is dropped at save.
const MP4_FREEFORM_PREFIX: &str = "----:com.apple.iTunes:";

/// Keys a private text field (`TRACKID`, `ORIGINALARTIST`) may be stored
/// under, the one to write first. ID3v2 and Vorbis keep the bare name (TXXX
/// frame / comment field); MP4 needs the freeform atom form.
fn private_keys(tag_type: TagType, name: &str) -> Vec<ItemKey> {
    let freeform = ItemKey::Unknown(format!("{MP4_FREEFORM_PREFIX}{name}"));
    let bare = ItemKey::Unknown(name.to_string());
    if tag_type == TagType::Mp4Ilst {
        vec![freeform, bare]
    } else {
        vec![bare, freeform]
    }
}

/// Original Artist: the real frame where the format has one (TOPE), else a
/// private field — Vorbis comments and MP4 have no mapped key for it, which
/// silently dropped the value on FLAC/OGG/M4A.
fn original_artist_keys(tag_type: TagType) -> Vec<ItemKey> {
    let mut keys = vec![ItemKey::OriginalArtist];
    if ItemKey::OriginalArtist.map_key(tag_type, false).is_none() {
        keys = private_keys(tag_type, "ORIGINALARTIST");
        keys.push(ItemKey::OriginalArtist);
    }
    keys
}

fn first_text(tag: &Tag, keys: &[ItemKey]) -> Option<String> {
    keys.iter().find_map(|k| get_text(tag, k))
}

/// Runs blocking file I/O off the async runtime with a timeout, so a single
/// locked file (open in another app) or a cloud-storage placeholder that
/// hasn't downloaded yet fails fast with a clear message instead of hanging
/// the command forever — which otherwise leaves every toolbar button
/// disabled with no explanation, since they all share one busy flag.
pub(crate) async fn run_blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    match tokio::time::timeout(FILE_OP_TIMEOUT, tauri::async_runtime::spawn_blocking(f)).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("The file operation task panicked unexpectedly".to_string()),
        Err(_) => Err(format!(
            "Timed out after {}s — the file may be locked by another program (a DJ app, antivirus) or not fully downloaded from cloud storage",
            FILE_OP_TIMEOUT.as_secs()
        )),
    }
}

/// Maps `f` over `items` across a few threads. Each tag parse is an
/// independent file read + decode, so a folder scan or a batch tag read of a
/// few hundred files is otherwise a multi-second sequential stall. Small
/// inputs stay single-threaded to avoid the spawn overhead.
///
/// One core is deliberately left free. A fixed eight threads oversubscribed
/// anything smaller than an 8-core machine and saturated the rest, starving
/// the webview's own rendering — a long batch made the window itself feel
/// frozen, which is worse than the batch taking slightly longer.
fn worker_threads() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get().saturating_sub(1))
        .unwrap_or(4)
        .clamp(1, 8)
}

/// Per-file error for a file whose parse or write panicked inside lofty or an
/// image decoder (see `par_map`).
pub(crate) const CRASHED: &str =
    "This file could not be processed: it made the tag parser crash, so it is probably damaged";

/// Runs `f`, turning a panic into `on_panic`'s result. lofty and the image
/// decoders can panic on malformed input; one bad file must cost exactly one
/// result, not the whole batch.
fn guarded<T, R>(item: &T, f: &impl Fn(&T) -> R, on_panic: &impl Fn(&T) -> R) -> R {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(item)))
        .unwrap_or_else(|_| on_panic(item))
}

/// Maps `f` over `items` on `worker_threads()` threads and returns the
/// results in input order, exactly one per item.
///
/// Work is handed out one item at a time from a shared counter rather than in
/// fixed chunks: file sizes (and cloud placeholders, and slow USB drives)
/// vary wildly, and a fixed split left most threads idle while one chewed
/// through a chunk of big FLACs.
///
/// A panic while processing an item is caught and replaced with
/// `on_panic(item)`. Previously a panic took down its whole thread's chunk,
/// whose results then silently vanished — the batch came back shorter than
/// its input, breaking every caller that promises one result per path.
pub(crate) fn par_map<T: Sync, R: Send>(
    items: &[T],
    f: impl Fn(&T) -> R + Sync,
    on_panic: impl Fn(&T) -> R + Sync,
) -> Vec<R> {
    use std::sync::atomic::{AtomicUsize, Ordering};

    if items.len() <= 16 {
        return items.iter().map(|item| guarded(item, &f, &on_panic)).collect();
    }
    let next = AtomicUsize::new(0);
    let threads = worker_threads().min(items.len());
    let mut slots: Vec<Option<R>> = std::iter::repeat_with(|| None).take(items.len()).collect();
    std::thread::scope(|s| {
        let workers: Vec<_> = (0..threads)
            .map(|_| {
                s.spawn(|| {
                    let mut done = Vec::new();
                    loop {
                        let i = next.fetch_add(1, Ordering::Relaxed);
                        let Some(item) = items.get(i) else { break };
                        done.push((i, guarded(item, &f, &on_panic)));
                    }
                    done
                })
            })
            .collect();
        for worker in workers {
            for (i, r) in worker.join().unwrap_or_default() {
                slots[i] = Some(r);
            }
        }
    });
    slots
        .into_iter()
        .zip(items)
        .map(|(slot, item)| slot.unwrap_or_else(|| on_panic(item)))
        .collect()
}

/// Canonical, format-independent name for a tag key. Used for the
/// `allFields` dump and to match the frontend's kept-field list.
pub fn key_name(key: &ItemKey) -> String {
    match key {
        ItemKey::Unknown(s) => format!("Unknown({s})"),
        other => format!("{other:?}"),
    }
}

fn text_of(value: &ItemValue) -> Option<String> {
    match value {
        ItemValue::Text(s) | ItemValue::Locator(s) => Some(s.clone()),
        ItemValue::Binary(_) => None,
    }
}

fn get_text(tag: &Tag, key: &ItemKey) -> Option<String> {
    tag.get(key)
        .and_then(|item| text_of(item.value()))
        .filter(|s| !s.is_empty())
}

fn is_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| AUDIO_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Parses a file's tags without pulling its embedded artwork into memory.
///
/// Cover art is by far the largest thing in a typical music file's tag — often
/// hundreds of kilobytes per track — and the callers here only ever look at
/// text fields and audio properties. Skipping it makes scanning a folder
/// dramatically cheaper in both I/O and allocation.
fn read_without_pictures(path: &Path) -> Option<lofty::file::TaggedFile> {
    use lofty::config::ParseOptions;
    use lofty::probe::Probe;

    // Mirrors what `lofty::read_from_path` does (open, then read), with cover
    // art switched off — deliberately no extra content sniffing, so a file
    // that parses one way here parses the same way everywhere else.
    Probe::open(path)
        .ok()?
        .options(ParseOptions::new().read_cover_art(false))
        .read()
        .ok()
}

/// Listing-only info for a file whose parse crashed: still listed, so the
/// user sees it and gets a per-file error when they act on it.
fn file_info_unparsed(path: &Path) -> AudioFile {
    AudioFile {
        path: path.to_string_lossy().to_string(),
        filename: path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        format: path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default(),
        size: std::fs::metadata(path).map(|m| m.len()).unwrap_or(0),
        has_backup: false,
        duration_secs: None,
        bitrate_kbps: None,
        sample_rate_hz: None,
    }
}

fn file_info(path: &Path) -> AudioFile {
    let mut info = file_info_unparsed(path);
    if let Some(tagged) = read_without_pictures(path) {
        let props = tagged.properties();
        info.has_backup = find_backup_in_file(&tagged).is_some();
        info.duration_secs = Some(props.duration().as_secs_f64());
        info.bitrate_kbps = props.audio_bitrate();
        info.sample_rate_hz = props.sample_rate();
    }
    info
}

/// Every audio file under `root` (just its direct children unless `recursive`).
///
/// Skips macOS AppleDouble companions (`._Track.mp3`): a USB stick that has
/// been near a Mac is full of them, they carry the audio extension but hold
/// only Finder metadata, and each one surfaced as an unreadable "track".
fn audio_files_under(root: &Path, recursive: bool) -> impl Iterator<Item = std::path::PathBuf> {
    WalkDir::new(root)
        .max_depth(if recursive { usize::MAX } else { 1 })
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_type().is_file()
                && is_audio(e.path())
                && !e.file_name().to_string_lossy().starts_with("._")
        })
        .map(|e| e.into_path())
}

// scan_folder / list_files / import_paths each parse every file they touch, so
// they run on the blocking pool. Their duration scales with the folder size, so
// they intentionally skip run_blocking's fixed per-operation timeout.
#[tauri::command]
pub async fn scan_folder(path: String, recursive: bool) -> Result<Vec<AudioFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = Path::new(&path);
        if !root.is_dir() {
            return Err(format!("Not a folder: {path}"));
        }
        let paths: Vec<std::path::PathBuf> = audio_files_under(root, recursive).collect();
        let mut files = par_map(&paths, |p| file_info(p), |p| file_info_unparsed(p));
        files.sort_by_cached_key(|f| f.path.to_lowercase());
        Ok(files)
    })
    .await
    .map_err(|_| "Scanning the folder failed unexpectedly".to_string())?
}

#[tauri::command]
pub async fn list_files(paths: Vec<String>) -> Vec<AudioFile> {
    tauri::async_runtime::spawn_blocking(move || {
        par_map(
            &paths,
            |p| file_info(Path::new(p)),
            |p| file_info_unparsed(Path::new(p)),
        )
    })
    .await
    .unwrap_or_default()
}

/// Imports a mix of files and folders (as produced by a drag-and-drop),
/// recursing into any folders. Non-audio paths are ignored, and a file that
/// is reached twice (dropped alongside the folder that holds it) is listed once.
#[tauri::command]
pub async fn import_paths(paths: Vec<String>, recursive: bool) -> Vec<AudioFile> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut targets: Vec<std::path::PathBuf> = Vec::new();
        for p in paths {
            let path = Path::new(&p);
            if path.is_dir() {
                targets.extend(audio_files_under(path, recursive));
            } else if path.is_file() && is_audio(path) {
                targets.push(path.to_path_buf());
            }
        }
        let mut seen = std::collections::HashSet::new();
        targets.retain(|t| seen.insert(t.clone()));
        par_map(&targets, |p| file_info(p), |p| file_info_unparsed(p))
    })
    .await
    .unwrap_or_default()
}

pub fn read_tags_impl(path: &str) -> Result<TagData, String> {
    let tagged = lofty::read_from_path(path).map_err(|e| e.to_string())?;
    Ok(tag_data_from(tagged))
}

/// The raw field names of `tags` outside the curated set — the `keep_extra`
/// that preserves every other field through a `write_tags_blocking` call
/// (the Rust twin of `preserveExtras` in `useTags.ts`).
pub(crate) fn extra_field_keys(tags: &TagData) -> Vec<String> {
    tags.all_fields
        .keys()
        .filter(|k| !crate::commands::library_index::KEPT_FIELD_KEYS.contains(&k.as_str()))
        .cloned()
        .collect()
}

/// Everything the library index stores about one file, from a single parse.
///
/// The index needs the tags *and* the duration *and* whether a backup
/// snapshot is present. Reading the file once for each would triple the cost
/// of indexing a collection, so they come out together.
pub(crate) struct IndexRow {
    pub tags: TagData,
    pub duration_secs: Option<f64>,
    pub has_backup: bool,
}

pub(crate) fn read_for_index(path: &str) -> Result<IndexRow, String> {
    let tagged = lofty::read_from_path(path).map_err(|e| e.to_string())?;
    let duration_secs = Some(tagged.properties().duration().as_secs_f64()).filter(|d| *d > 0.0);
    let has_backup = find_backup_in_file(&tagged).is_some();
    Ok(IndexRow { tags: tag_data_from(tagged), duration_secs, has_backup })
}

/// Curated fields of a parsed file, including an ID3v2 POPM star rating.
///
/// Takes the file by value because the rating needs it: lofty keeps POPM
/// (like GEOB, PRIV, RVA2…) out of the generic `Tag` as a format-specific
/// "companion" frame, so it is only visible after converting the tag back
/// into an `Id3v2Tag` — which consumes it. Reading through the generic
/// accessors alone meant an MP3's rating (Rekordbox's included) was never read.
pub(crate) fn tag_data_from(mut tagged: lofty::file::TaggedFile) -> TagData {
    let mut data = tag_data_of(&tagged);
    if data.rating.is_none()
        && tagged
            .primary_tag()
            .is_some_and(|t| t.tag_type() == TagType::Id3v2 && t.has_format_specific_items())
    {
        if let Some(tag) = tagged.remove(TagType::Id3v2) {
            data.rating = popm_stars(&tag.into()).filter(|s| *s > 0);
        }
    }
    data
}

/// Pulls the curated fields out of an already-parsed file (without the ID3v2
/// POPM rating — see `tag_data_from`).
pub(crate) fn tag_data_of(tagged: &lofty::file::TaggedFile) -> TagData {
    tagged
        .primary_tag()
        .or_else(|| tagged.first_tag())
        .map(tag_data_of_tag)
        .unwrap_or_default()
}

/// The year as the app shows it: the full recording date when there is one,
/// else the bare year field.
fn year_of(tag: &Tag) -> Option<String> {
    get_text(tag, &ItemKey::RecordingDate)
        .or_else(|| get_text(tag, &ItemKey::Year))
        .or_else(|| tag.year().map(|y| y.to_string()))
}

/// The comment the app shows and edits: the first one without a description.
///
/// ID3v2 files routinely carry machine-written COMM frames with descriptions —
/// iTunes' `iTunNORM` (volume) and `iTunSMPB` (gapless playback info), media
/// players' custom slots — ahead of the real comment. Showing whichever came
/// first put hex gibberish in the Comment column.
fn displayed_comment(tag: &Tag) -> Option<&TagItem> {
    let comments = || tag.items().filter(|i| *i.key() == ItemKey::Comment);
    comments()
        .find(|i| i.description().is_empty())
        .or_else(|| comments().next())
        .filter(|i| text_of(i.value()).is_some_and(|t| !t.is_empty()))
}

/// The tempo as stored: `Bpm` (TBPM, Vorbis `BPM`) first, else `IntegerBpm`
/// (MP4 `tmpo`). Both are curated, so neither also shows as a raw column.
fn bpm_of(tag: &Tag) -> Option<String> {
    get_text(tag, &ItemKey::Bpm)
        .or_else(|| get_text(tag, &ItemKey::IntegerBpm))
        .filter(|s| !s.trim().is_empty())
}

/// The BPM text to store for `tag_type`. ID3v2 TBPM is defined as an integer
/// ("beats per minute... as an integer") and MP4 `tmpo` is a 16-bit integer,
/// so a decimal such as Rekordbox's 127.99 is rounded there; Vorbis comments
/// and APE take free text, so the decimal is kept.
fn bpm_for_format(tag_type: TagType, value: &str) -> String {
    let v = value.trim();
    match (tag_type, v.parse::<f64>()) {
        (TagType::Id3v2 | TagType::Mp4Ilst, Ok(n)) if n.is_finite() && n > 0.0 => {
            format!("{}", n.round() as i64)
        }
        _ => v.to_string(),
    }
}

/// Keys a BPM may live under, the one to write first: the first of
/// `IntegerBpm` (ID3v2 TBPM, MP4 `tmpo`) and `Bpm` (Vorbis/APE `BPM`) the
/// format maps. Writing a key the format doesn't map is dropped silently at
/// save, which is how ID3v2 BPM used to vanish when `Bpm` was tried first.
fn bpm_keys(tag_type: TagType) -> Vec<ItemKey> {
    let mut keys = vec![ItemKey::IntegerBpm, ItemKey::Bpm];
    if ItemKey::IntegerBpm.map_key(tag_type, false).is_none() {
        keys.reverse();
    }
    keys
}

fn tag_data_of_tag(tag: &Tag) -> TagData {
    let mut data = TagData {
        title: tag.title().map(|c| c.to_string()),
        artist: tag.artist().map(|c| c.to_string()),
        album: tag.album().map(|c| c.to_string()),
        album_artist: get_text(tag, &ItemKey::AlbumArtist),
        track_number: join_total(
            get_text(tag, &ItemKey::TrackNumber),
            get_text(tag, &ItemKey::TrackTotal),
        ),
        disc_number: join_total(
            get_text(tag, &ItemKey::DiscNumber),
            get_text(tag, &ItemKey::DiscTotal),
        ),
        year: year_of(tag),
        genre: tag.genre().map(|c| c.to_string()),
        comment: displayed_comment(tag).and_then(|i| text_of(i.value())),
        composer: get_text(tag, &ItemKey::Composer),
        original_artist: first_text(tag, &original_artist_keys(tag.tag_type())),
        track_id: first_text(tag, &private_keys(tag.tag_type(), "TRACKID")),
        rating: read_rating(tag),
        bpm: bpm_of(tag),
        key: get_text(tag, &ItemKey::InitialKey),
        has_cover_art: !tag.pictures().is_empty(),
        all_fields: Default::default(),
    };

    let backup_name = format!("Unknown({BACKUP_KEY})");
    for item in tag.items() {
        let name = key_name(item.key());
        // The backup blob is surfaced via AudioFile.hasBackup, not the field dump.
        if name == backup_name {
            continue;
        }
        if let Some(text) = text_of(item.value()) {
            data.all_fields
                .entry(name)
                .and_modify(|v| {
                    v.push_str(" | ");
                    v.push_str(&text);
                })
                .or_insert(text);
        }
    }
    // Fallback in case this format surfaces the private frame under a name the
    // typed accessor above missed.
    if data.track_id.is_none() {
        data.track_id = data.all_fields.get(TRACK_ID_FIELD).cloned();
    }
    data
}

fn join_total(num: Option<String>, total: Option<String>) -> Option<String> {
    match (num, total) {
        (Some(n), Some(t)) if !n.contains('/') => Some(format!("{n}/{t}")),
        (n, _) => n,
    }
}

/// A POPM rating byte (0-255) to 0-5 stars.
///
/// Bands rather than `byte / 51`: players disagree on the byte for each star —
/// Rekordbox and Traktor write 51/102/153/204/255, Windows Media Player and
/// MusicBee 1/64/128/196/255 — and plain division turned WMP's two stars (64)
/// into one and dropped any byte under 26 to "unrated". These bands put both
/// conventions on the right star. 1-5 are taken as literal star counts, which
/// a few taggers write.
fn stars_from_popm_byte(n: u32) -> u8 {
    match n {
        0 => 0,
        1..=5 => n as u8,
        6..=63 => 1,
        64..=127 => 2,
        128..=185 => 3,
        186..=229 => 4,
        _ => 5,
    }
}

/// The byte written for `stars` — Rekordbox's scale, which every band above
/// (and every other player) reads back as the same star count.
fn popm_byte(stars: u8) -> u8 {
    (stars.min(5) as u16 * 51) as u8
}

/// A text rating as written outside ID3v2 (Vorbis `RATING`, MP4 `rate`,
/// RIFF `IRTD`): 1-5 is a star count, anything larger is on the 0-100 scale
/// this app (and most taggers) write.
fn stars_from_text_rating(s: &str) -> Option<u8> {
    let n = s.trim().parse::<f64>().ok().filter(|n| *n > 0.0)?;
    let stars = if n <= 5.0 { n.round() } else { (n / 20.0).round() };
    Some((stars as u8).clamp(1, 5))
}

/// Stars from the first rated POPM frame of an ID3v2 tag.
fn popm_stars(tag: &lofty::id3::v2::Id3v2Tag) -> Option<u8> {
    tag.into_iter().find_map(|frame| match frame {
        lofty::id3::v2::Frame::Popularimeter(p) if p.rating > 0 => {
            Some(stars_from_popm_byte(p.rating as u32))
        }
        _ => None,
    })
}

/// Reads a rating (1-5 stars) from the generic tag: a text rating (Vorbis,
/// MP4, RIFF) or, should a format hand it over that way, a raw POPM body.
/// ID3v2's own POPM frames are read by `tag_data_from`. `None` when unrated.
fn read_rating(tag: &Tag) -> Option<u8> {
    let rating_key = ItemKey::Unknown("RATING".to_string());
    tag.items()
        .filter(|i| *i.key() == ItemKey::Popularimeter || *i.key() == rating_key)
        .find_map(|item| match item.value() {
            ItemValue::Text(s) => stars_from_text_rating(s),
            ItemValue::Binary(bytes) => {
                // POPM body: "email" + NUL + rating byte + play counter.
                let pos = bytes.iter().position(|&b| b == 0)?;
                let stars = stars_from_popm_byte(*bytes.get(pos + 1)? as u32);
                (stars > 0).then_some(stars)
            }
            ItemValue::Locator(_) => None,
        })
}

/// Sets every POPM frame's rating to `stars` (0 clears), keeping each frame's
/// email and play counter; adds one when the file has none. Leaves the frames
/// byte-for-byte alone when the star count isn't actually changing, so an
/// unrelated edit never rewrites another player's rating byte.
fn set_popm_rating(tag: &mut lofty::id3::v2::Id3v2Tag, stars: u8) {
    use lofty::id3::v2::{Frame, PopularimeterFrame};

    if popm_stars(tag).unwrap_or(0) == stars {
        return;
    }
    let mut frames: Vec<PopularimeterFrame<'static>> = (&*tag)
        .into_iter()
        .filter_map(|f| match f {
            Frame::Popularimeter(p) => Some(p.clone()),
            _ => None,
        })
        .collect();
    tag.retain(|f| !matches!(f, Frame::Popularimeter(_)));
    if frames.is_empty() {
        if stars == 0 {
            return;
        }
        frames.push(PopularimeterFrame::new(String::new(), 0, 0));
    }
    for mut frame in frames {
        frame.rating = popm_byte(stars);
        tag.insert(Frame::Popularimeter(frame));
    }
}

/// Writes a 0-5 star rating as a text rating on the 0-100 scale (0 clears),
/// for every format except ID3v2 (see `set_popm_rating`). Unchanged star
/// counts are left exactly as they are on disk.
fn set_text_rating(tag: &mut Tag, stars: u8) {
    if read_rating(tag).unwrap_or(0) == stars {
        return;
    }
    let rating_key = ItemKey::Unknown("RATING".to_string());
    tag.retain(|i| *i.key() != ItemKey::Popularimeter && *i.key() != rating_key);
    if stars == 0 {
        return;
    }
    let value = ItemValue::Text((stars.min(5) as u16 * 20).to_string());
    // Vorbis (RATING), MP4 (rate) and RIFF INFO (IRTD) have a native key;
    // anything else gets a plain RATING field rather than nothing at all.
    let key = if ItemKey::Popularimeter.map_key(tag.tag_type(), false).is_some() {
        ItemKey::Popularimeter
    } else {
        rating_key
    };
    tag.insert_unchecked(TagItem::new(key, value));
}

/// Resolves the human-readable "searchable backup" target field.
fn backup_item_key(field: &str) -> ItemKey {
    match field {
        "OriginalArtist" => ItemKey::OriginalArtist,
        "Comment" => ItemKey::Comment,
        "Album" => ItemKey::AlbumTitle,
        "AlbumArtist" => ItemKey::AlbumArtist,
        "Genre" => ItemKey::Genre,
        _ => ItemKey::Composer,
    }
}

/// Builds the searchable backup string "filename | | artist | | title | | year".
/// All four slots are always present (empty when unknown) so the layout is
/// stable and the filename slot is filled even for untagged files.
fn build_searchable_backup(
    path: &str,
    artist: Option<String>,
    title: Option<String>,
    year: Option<String>,
) -> String {
    let stem = Path::new(path)
        .file_stem()
        .map(|s| s.to_string_lossy().trim().to_string())
        .unwrap_or_default();
    let a = artist.map(|s| s.trim().to_string()).unwrap_or_default();
    let t = title.map(|s| s.trim().to_string()).unwrap_or_default();
    let y = year
        .map(|s| s.trim().chars().take(4).collect::<String>())
        .unwrap_or_default();
    [stem, a, t, y].join(" | | ")
}

#[tauri::command]
pub async fn read_tags(path: String) -> Result<TagData, String> {
    run_blocking(move || read_tags_impl(&path)).await
}

/// Reads many files' tags off the async runtime. Deliberately *not* wrapped in
/// `run_blocking`: its timeout is per-operation, and a legitimately large batch
/// can outlast it. Each file still reports its own error, so one unreadable
/// file never fails the batch.
#[tauri::command]
pub async fn read_tags_batch(paths: Vec<String>) -> Vec<TagReadResult> {
    let fallback: Vec<String> = paths.clone();
    let joined = tauri::async_runtime::spawn_blocking(move || {
        par_map(
            &paths,
            |p| match read_tags_impl(p) {
                Ok(tags) => TagReadResult {
                    path: p.clone(),
                    tags: Some(tags),
                    error: None,
                },
                Err(e) => TagReadResult {
                    path: p.clone(),
                    tags: None,
                    error: Some(e),
                },
            },
            |p| TagReadResult {
                path: p.clone(),
                tags: None,
                error: Some(CRASHED.to_string()),
            },
        )
    })
    .await;

    joined.unwrap_or_else(|_| {
        fallback
            .into_iter()
            .map(|p| TagReadResult {
                path: p,
                tags: None,
                error: Some("Reading tags failed unexpectedly".to_string()),
            })
            .collect()
    })
}

/// Writes the curated fields in `tags` over the file's existing tag.
///
/// `keep_extra` lists canonical key names (see `key_name`) of the other text
/// fields to carry over — every other text field is stripped. That is the
/// strip/"Clear Fields" mechanism: a raw field is removed by leaving it out.
///
/// The write is a *diff* against what is on disk, built on the file's own
/// parsed tag rather than a blank one:
///
/// * A curated field whose value didn't change is left exactly as stored —
///   multi-value artists, comment languages and descriptions, the original
///   date format all survive an unrelated edit.
/// * Everything the app doesn't show and can't edit survives untouched: lofty
///   keeps frames it has no generic key for (GEOB, PRIV, POPM, RVA2, UFID, …)
///   as a format-specific companion of the parsed tag. Building the new tag
///   from `Tag::new` dropped all of them on every write — Serato's hot cues,
///   beatgrid and overview (GEOB), Traktor's PRIV block and every POPM rating
///   were wiped by something as small as fixing a typo in a title.
/// * Binary items and the app's own backup snapshot are never stripped.
///
/// The JSON backup (when `backup` is set) is captured from the file's current
/// state before anything changes; an existing snapshot is always kept, whether
/// or not this write asked for one.
///
/// `backup_field` (when Some) writes "file name | | artist | | title | | year"
/// (from the pre-change values) into a chosen field — Composer by default, or
/// OriginalArtist / Comment / … — so the original identity stays searchable in
/// DJ software. It is only written when that field is empty both before and
/// after this write: existing data there (an older snapshot included) is never
/// overwritten by it, while a value the user deliberately typed into, or
/// cleared from, that field is honoured.
#[tauri::command]
pub async fn write_tags(
    path: String,
    tags: TagData,
    backup: bool,
    keep_extra: Vec<String>,
    preserve_art: bool,
    backup_field: Option<String>,
) -> Result<(), String> {
    run_blocking(move || {
        write_tags_blocking(&path, tags, backup, keep_extra, preserve_art, backup_field)
    })
    .await
}

/// Keys the curated `TagData` fields are written to. A write diffs each of
/// these against the file instead of stripping it with the other fields.
fn is_curated_key(key: &ItemKey) -> bool {
    matches!(
        key,
        ItemKey::TrackTitle
            | ItemKey::TrackArtist
            | ItemKey::AlbumTitle
            | ItemKey::AlbumArtist
            | ItemKey::TrackNumber
            | ItemKey::TrackTotal
            | ItemKey::DiscNumber
            | ItemKey::DiscTotal
            | ItemKey::RecordingDate
            | ItemKey::Year
            | ItemKey::Genre
            | ItemKey::Comment
            | ItemKey::Composer
            | ItemKey::OriginalArtist
            | ItemKey::Popularimeter
            | ItemKey::Bpm
            | ItemKey::IntegerBpm
            | ItemKey::InitialKey
    ) || matches!(key, ItemKey::Unknown(k)
        if matches!(
            k.strip_prefix(MP4_FREEFORM_PREFIX).unwrap_or(k.as_str()),
            "TRACKID" | "RATING" | "ORIGINALARTIST"
        ))
}

/// `Some(trimmed)` for a value worth writing, `None` for absent/blank.
fn non_blank(v: &Option<String>) -> Option<&str> {
    v.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

/// Rewrites one curated field — but only if it changed. `keys` are every key
/// the field may be stored under (the first is the one written).
///
/// The comparison is on the raw values, not trimmed ones, so a pass whose only
/// change is trimming stray whitespace still gets written.
fn write_field(tag: &mut Tag, keys: &[ItemKey], old: &Option<String>, new: &Option<String>) {
    let blank_to_none = |v: &Option<String>| v.clone().filter(|s| !s.is_empty());
    if blank_to_none(old) == blank_to_none(new) {
        return;
    }
    tag.retain(|i| !keys.contains(i.key()));
    if let Some(v) = non_blank(new) {
        // `insert_unchecked`, not `insert`/`insert_text`: the checked path runs
        // `ItemKey::re_map` with `allow_unknown: false`, which silently drops
        // any `ItemKey::Unknown` (our private TRACKID field among them) before
        // it is even added. The format's writer still rejects a genuinely
        // out-of-spec key at save time.
        tag.insert_unchecked(TagItem::new(keys[0].clone(), ItemValue::Text(v.to_string())));
    }
}

/// Track/disc "n/total" counterpart of `write_field`.
fn write_numbered(
    tag: &mut Tag,
    num_key: ItemKey,
    total_key: ItemKey,
    old: &Option<String>,
    new: &Option<String>,
) {
    let blank_to_none = |v: &Option<String>| v.clone().filter(|s| !s.is_empty());
    if blank_to_none(old) == blank_to_none(new) {
        return;
    }
    tag.retain(|i| *i.key() != num_key && *i.key() != total_key);
    let Some(v) = non_blank(new) else { return };
    let (n, t) = match v.split_once('/') {
        Some((n, t)) => (n.trim(), t.trim()),
        None => (v, ""),
    };
    if !n.is_empty() {
        tag.insert_text(num_key, n.to_string());
    }
    if !t.is_empty() {
        tag.insert_text(total_key, t.to_string());
    }
}

/// The comment counterpart of `write_field`: replaces only the comment the app
/// displays (see `displayed_comment`), leaving iTunes' `iTunNORM`/`iTunSMPB`
/// and other described, machine-written comments in place.
fn write_comment(tag: &mut Tag, old: &Option<String>, new: &Option<String>) {
    let blank_to_none = |v: &Option<String>| v.clone().filter(|s| !s.is_empty());
    if blank_to_none(old) == blank_to_none(new) {
        return;
    }
    let has_plain = tag
        .items()
        .any(|i| *i.key() == ItemKey::Comment && i.description().is_empty());
    let mut removed_fallback = false;
    tag.retain(|i| {
        if *i.key() != ItemKey::Comment {
            return true;
        }
        if has_plain {
            return !i.description().is_empty();
        }
        // No plain comment: the one displayed was the first comment of all.
        if removed_fallback {
            return true;
        }
        removed_fallback = true;
        false
    });
    if let Some(v) = non_blank(new) {
        tag.push_unchecked(TagItem::new(ItemKey::Comment, ItemValue::Text(v.to_string())));
    }
}

/// Gives every comment/lyrics item an ID3v2-valid language. lofty refuses to
/// write a COMM/USLT whose language isn't three ASCII letters, and some
/// recorders store `[0, 0, 0]`. A blank-slate write used to drop such a frame
/// (and its text) silently; a write that keeps unchanged items has to repair
/// it instead, or the whole edit fails. "XXX" is ID3's "unknown language".
fn repair_item_languages(tag: &mut Tag) {
    for key in [ItemKey::Comment, ItemKey::Lyrics] {
        let valid = |lang: &[u8; 3]| lang.iter().all(u8::is_ascii_alphabetic);
        if tag.items().all(|i| *i.key() != key || valid(i.lang())) {
            continue;
        }
        let items: Vec<TagItem> = tag.take(&key).collect();
        for mut item in items {
            if !valid(item.lang()) {
                item.set_lang(*b"XXX");
            }
            tag.push_unchecked(item);
        }
    }
}

/// Saves `tag` to `path`, applying `rating` (stars; `None` leaves the rating
/// alone). ID3v2 goes through `Id3v2Tag` so its POPM frames can be edited in
/// place — they live in the tag's format-specific companion, out of reach of
/// the generic API.
fn save_tag(mut tag: Tag, rating: Option<u8>, path: &str) -> Result<(), String> {
    repair_item_languages(&mut tag);
    if tag.tag_type() == TagType::Id3v2 {
        let mut id3: lofty::id3::v2::Id3v2Tag = tag.into();
        if let Some(stars) = rating {
            set_popm_rating(&mut id3, stars);
        }
        return id3
            .save_to_path(path, WriteOptions::default())
            .map_err(|e| e.to_string());
    }
    let mut tag = tag;
    if let Some(stars) = rating {
        set_text_rating(&mut tag, stars);
    }
    tag.save_to_path(path, WriteOptions::default())
        .map_err(|e| e.to_string())
}

pub(crate) fn write_tags_blocking(
    path: &str,
    tags: TagData,
    backup: bool,
    keep_extra: Vec<String>,
    preserve_art: bool,
    backup_field: Option<String>,
) -> Result<(), String> {
    let mut tagged = lofty::read_from_path(path).map_err(|e| e.to_string())?;
    // Always the format's canonical tag, so fields aren't lost to a limited
    // secondary tag (e.g. ID3v1) that happened to be present.
    let tag_type = tagged.file_type().primary_tag_type();

    // Everything needed from the pre-change state, taken before the tag is
    // reused as the base of the new one.
    let source = tagged.primary_tag().or_else(|| tagged.first_tag());
    let backup_blob = find_backup_in_file(&tagged)
        .or_else(|| backup.then(|| make_backup_string(source, tag_type)));
    let backup_key = backup_field.as_deref().map(backup_item_key);
    let old_backup_value = backup_key
        .as_ref()
        .and_then(|k| source.and_then(|t| get_text(t, k)));
    let identity = source.map(|t| {
        (
            t.artist().map(|c| c.to_string()),
            t.title().map(|c| c.to_string()),
            year_of(t),
        )
    });
    // A file carrying only a secondary tag (an mp3 with just ID3v1): that tag
    // is the source of the kept fields and art for the new primary one.
    let secondary_only = if tagged.primary_tag().is_none() {
        tagged.first_tag().cloned()
    } else {
        None
    };
    let other_types: Vec<TagType> = tagged
        .tags()
        .iter()
        .map(|t| t.tag_type())
        .filter(|t| *t != tag_type)
        .collect();

    let (mut tag, old) = match tagged.remove(tag_type) {
        Some(primary) => {
            let old = tag_data_of_tag(&primary);
            (primary, old)
        }
        // Fresh tag: nothing on disk to diff against, so every field is new.
        None => (Tag::new(tag_type), TagData::default()),
    };
    drop(tagged);

    // 1. Strip: drop the text fields that are neither curated nor kept.
    let keep: std::collections::HashSet<String> = keep_extra.into_iter().collect();
    let blob_key = ItemKey::Unknown(BACKUP_KEY.to_string());
    tag.retain(|item| {
        is_curated_key(item.key())
            || *item.key() == blob_key
            || matches!(item.value(), ItemValue::Binary(_))
            || keep.contains(&key_name(item.key()))
    });
    if let Some(ref secondary) = secondary_only {
        for item in secondary.items() {
            if keep.contains(&key_name(item.key())) {
                tag.push_unchecked(item.clone());
            }
        }
    }

    // 2. Cover art.
    if !preserve_art {
        while !tag.pictures().is_empty() {
            tag.remove_picture(0);
        }
    } else if let Some(ref secondary) = secondary_only {
        for pic in secondary.pictures() {
            tag.push_picture(pic.clone());
        }
    }

    // 3. Curated fields that changed.
    write_field(&mut tag, &[ItemKey::TrackTitle], &old.title, &tags.title);
    write_field(&mut tag, &[ItemKey::TrackArtist], &old.artist, &tags.artist);
    write_field(&mut tag, &[ItemKey::AlbumTitle], &old.album, &tags.album);
    write_field(&mut tag, &[ItemKey::AlbumArtist], &old.album_artist, &tags.album_artist);
    write_field(
        &mut tag,
        &[ItemKey::RecordingDate, ItemKey::Year],
        &old.year,
        &tags.year,
    );
    write_field(&mut tag, &[ItemKey::Genre], &old.genre, &tags.genre);
    write_comment(&mut tag, &old.comment, &tags.comment);
    write_numbered(
        &mut tag,
        ItemKey::TrackNumber,
        ItemKey::TrackTotal,
        &old.track_number,
        &tags.track_number,
    );
    write_numbered(
        &mut tag,
        ItemKey::DiscNumber,
        ItemKey::DiscTotal,
        &old.disc_number,
        &tags.disc_number,
    );
    write_field(&mut tag, &[ItemKey::Composer], &old.composer, &tags.composer);
    write_field(
        &mut tag,
        &original_artist_keys(tag_type),
        &old.original_artist,
        &tags.original_artist,
    );
    write_field(&mut tag, &private_keys(tag_type, "TRACKID"), &old.track_id, &tags.track_id);
    let new_bpm = tags.bpm.as_deref().map(|v| bpm_for_format(tag_type, v));
    write_field(&mut tag, &bpm_keys(tag_type), &old.bpm, &new_bpm);
    write_field(&mut tag, &[ItemKey::InitialKey], &old.key, &tags.key);

    // 4. Searchable backup — only into a field that is empty before and after.
    if let Some(key) = backup_key {
        if old_backup_value.is_none() && get_text(&tag, &key).is_none() {
            let (artist, title, year) = identity.unwrap_or_default();
            tag.insert_text(key, build_searchable_backup(path, artist, title, year));
        }
    }

    // 5. The JSON snapshot. See `write_field` for why this is unchecked.
    tag.retain(|i| *i.key() != blob_key);
    if let Some(blob) = backup_blob {
        tag.insert_unchecked(TagItem::new(blob_key, ItemValue::Text(blob)));
    }

    // 6. Drop secondary tag formats (ID3v1, APE, ...) so stripped fields
    // cannot linger in them.
    for tt in other_types {
        Tag::new(tt)
            .remove_from_path(path)
            .map_err(|e| e.to_string())?;
    }
    save_tag(tag, tags.rating, path)
}

/// Writes many files in one call, across `par_map`'s threads.
///
/// The per-file `write_tags` command is still there for one-off edits, but
/// applying a preview to a whole library through it meant one IPC round trip
/// *and* one React re-render per file — which dominated the actual write work
/// by an order of magnitude. This does the whole run in a single call and
/// reports progress through the `write-progress` event instead, throttled so a
/// 1000-file run emits ~50 events rather than 1000.
///
/// Every file reports its own error, so one locked or read-only file never
/// fails the rest of the batch. Results come back in input order.
#[tauri::command]
pub async fn write_tags_batch(
    app: tauri::AppHandle,
    items: Vec<WriteTagsItem>,
    backup: bool,
    preserve_art: bool,
    backup_field: Option<String>,
) -> Vec<WriteResult> {
    use std::sync::atomic::{AtomicUsize, Ordering};

    let fallback: Vec<String> = items.iter().map(|i| i.path.clone()).collect();
    let total = items.len();
    let joined = tauri::async_runtime::spawn_blocking(move || {
        let done = AtomicUsize::new(0);
        // Report ~50 times over the run, never more often than every file.
        let step = (total / 50).max(1);
        par_map(
            &items,
            |item| {
                let result = write_tags_blocking(
                    &item.path,
                    item.tags.clone(),
                    backup,
                    item.keep_extra.clone(),
                    preserve_art,
                    backup_field.clone(),
                );
                let n = done.fetch_add(1, Ordering::Relaxed) + 1;
                if n % step == 0 || n == total {
                    let _ = app.emit("write-progress", WriteProgress { done: n, total });
                }
                WriteResult {
                    path: item.path.clone(),
                    error: result.err(),
                }
            },
            |item| WriteResult {
                path: item.path.clone(),
                error: Some(CRASHED.to_string()),
            },
        )
    })
    .await;

    joined.unwrap_or_else(|_| {
        fallback
            .into_iter()
            .map(|path| WriteResult {
                path,
                error: Some("Writing tags failed unexpectedly".to_string()),
            })
            .collect()
    })
}

/// `write_raw_field` for many files at once — same batching rationale as
/// `write_tags_batch`, used by bulk edits of an "All Tags" column.
#[tauri::command]
pub async fn write_raw_fields_batch(items: Vec<WriteRawFieldItem>) -> Vec<WriteResult> {
    let fallback: Vec<String> = items.iter().map(|i| i.path.clone()).collect();
    tauri::async_runtime::spawn_blocking(move || {
        par_map(
            &items,
            |item| WriteResult {
                path: item.path.clone(),
                error: write_raw_field_blocking(&item.path, &item.field_key, &item.value).err(),
            },
            |item| WriteResult {
                path: item.path.clone(),
                error: Some(CRASHED.to_string()),
            },
        )
    })
    .await
    .unwrap_or_else(|_| {
        fallback
            .into_iter()
            .map(|path| WriteResult {
                path,
                error: Some("Writing tags failed unexpectedly".to_string()),
            })
            .collect()
    })
}

/// `backup_file` for a chunk of files at once. The caller keeps sending
/// chunks so its Stop button stays responsive between them; within a chunk the
/// files are written in parallel.
#[tauri::command]
pub async fn backup_files_batch(paths: Vec<String>, backup_field: String) -> Vec<WriteResult> {
    let fallback = paths.clone();
    tauri::async_runtime::spawn_blocking(move || {
        par_map(
            &paths,
            |p| WriteResult {
                path: p.clone(),
                error: backup_file_blocking(p, &backup_field).err(),
            },
            |p| WriteResult {
                path: p.clone(),
                error: Some(CRASHED.to_string()),
            },
        )
    })
    .await
    .unwrap_or_else(|_| {
        fallback
            .into_iter()
            .map(|path| WriteResult {
                path,
                error: Some("Backing up failed unexpectedly".to_string()),
            })
            .collect()
    })
}

/// Writes (or, when `value` is empty, completely removes) a raw tag field
/// identified by its `key_name()` display string — the same name shown in
/// the "All Tags" view. Matches against the tag's existing items rather than
/// reconstructing an `ItemKey` from the string, so it works for every key
/// `allFields` can surface, known or unknown to lofty.
#[tauri::command]
pub async fn write_raw_field(path: String, field_key: String, value: String) -> Result<(), String> {
    run_blocking(move || write_raw_field_blocking(&path, &field_key, &value)).await
}

fn write_raw_field_blocking(path: &str, field_key: &str, value: &str) -> Result<(), String> {
    let mut tagged = lofty::read_from_path(path).map_err(|e| e.to_string())?;
    let tag_type = tagged.file_type().primary_tag_type();
    let value = value.trim();
    if tagged.tag(tag_type).is_none() {
        if value.is_empty() {
            return Ok(()); // No tag, so nothing to clear.
        }
        tagged.insert_tag(Tag::new(tag_type));
    }
    let tag = tagged
        .tag_mut(tag_type)
        .ok_or_else(|| "Could not access the file's tag".to_string())?;
    let existing_key = tag
        .items()
        .find(|item| key_name(item.key()) == field_key)
        .map(|item| item.key().clone());
    let existing_key = match existing_key {
        Some(key) => key,
        None if value.is_empty() => return Ok(()), // Already gone.
        // Not on the file any more — typically undoing a Clear Fields of this
        // very column. Recreate it from its name; returning Ok without writing
        // (as before) made that undo silently do nothing.
        None => item_key_from_name(field_key)
            .ok_or_else(|| format!("Can't recreate the field \"{field_key}\" on this file"))?,
    };
    if value.is_empty() {
        tag.remove_key(&existing_key);
    } else {
        // `existing_key` is very often ItemKey::Unknown for a raw/"All Tags"
        // field — same silent-drop issue as set_text above, so this must go
        // through insert_unchecked too.
        tag.insert_unchecked(TagItem::new(existing_key, ItemValue::Text(value.to_string())));
    }
    tagged
        .save_to_path(path, WriteOptions::default())
        .map_err(|e| e.to_string())
}

/// The `ItemKey` whose `key_name` is `name` — the inverse of `key_name`, so a
/// raw field can be recreated by name once it is gone from the file (undoing
/// a Clear Fields of an "All Tags" column). The arms are every variant of
/// lofty 0.22's `ItemKey`; `item_key_names_round_trip` checks them.
fn item_key_from_name(name: &str) -> Option<ItemKey> {
    if let Some(inner) = name.strip_prefix("Unknown(").and_then(|s| s.strip_suffix(')')) {
        return Some(ItemKey::Unknown(inner.to_string()));
    }
    Some(match name {
        "AlbumTitle" => ItemKey::AlbumTitle,
        "SetSubtitle" => ItemKey::SetSubtitle,
        "ShowName" => ItemKey::ShowName,
        "ContentGroup" => ItemKey::ContentGroup,
        "TrackTitle" => ItemKey::TrackTitle,
        "TrackSubtitle" => ItemKey::TrackSubtitle,
        "OriginalAlbumTitle" => ItemKey::OriginalAlbumTitle,
        "OriginalArtist" => ItemKey::OriginalArtist,
        "OriginalLyricist" => ItemKey::OriginalLyricist,
        "AlbumTitleSortOrder" => ItemKey::AlbumTitleSortOrder,
        "AlbumArtistSortOrder" => ItemKey::AlbumArtistSortOrder,
        "TrackTitleSortOrder" => ItemKey::TrackTitleSortOrder,
        "TrackArtistSortOrder" => ItemKey::TrackArtistSortOrder,
        "ShowNameSortOrder" => ItemKey::ShowNameSortOrder,
        "ComposerSortOrder" => ItemKey::ComposerSortOrder,
        "AlbumArtist" => ItemKey::AlbumArtist,
        "TrackArtist" => ItemKey::TrackArtist,
        "TrackArtists" => ItemKey::TrackArtists,
        "Arranger" => ItemKey::Arranger,
        "Writer" => ItemKey::Writer,
        "Composer" => ItemKey::Composer,
        "Conductor" => ItemKey::Conductor,
        "Director" => ItemKey::Director,
        "Engineer" => ItemKey::Engineer,
        "Lyricist" => ItemKey::Lyricist,
        "MixDj" => ItemKey::MixDj,
        "MixEngineer" => ItemKey::MixEngineer,
        "MusicianCredits" => ItemKey::MusicianCredits,
        "Performer" => ItemKey::Performer,
        "Producer" => ItemKey::Producer,
        "Publisher" => ItemKey::Publisher,
        "Label" => ItemKey::Label,
        "InternetRadioStationName" => ItemKey::InternetRadioStationName,
        "InternetRadioStationOwner" => ItemKey::InternetRadioStationOwner,
        "Remixer" => ItemKey::Remixer,
        "DiscNumber" => ItemKey::DiscNumber,
        "DiscTotal" => ItemKey::DiscTotal,
        "TrackNumber" => ItemKey::TrackNumber,
        "TrackTotal" => ItemKey::TrackTotal,
        "Popularimeter" => ItemKey::Popularimeter,
        "ParentalAdvisory" => ItemKey::ParentalAdvisory,
        "RecordingDate" => ItemKey::RecordingDate,
        "Year" => ItemKey::Year,
        "ReleaseDate" => ItemKey::ReleaseDate,
        "OriginalReleaseDate" => ItemKey::OriginalReleaseDate,
        "Isrc" => ItemKey::Isrc,
        "Barcode" => ItemKey::Barcode,
        "CatalogNumber" => ItemKey::CatalogNumber,
        "Work" => ItemKey::Work,
        "Movement" => ItemKey::Movement,
        "MovementNumber" => ItemKey::MovementNumber,
        "MovementTotal" => ItemKey::MovementTotal,
        "MusicBrainzRecordingId" => ItemKey::MusicBrainzRecordingId,
        "MusicBrainzTrackId" => ItemKey::MusicBrainzTrackId,
        "MusicBrainzReleaseId" => ItemKey::MusicBrainzReleaseId,
        "MusicBrainzReleaseGroupId" => ItemKey::MusicBrainzReleaseGroupId,
        "MusicBrainzArtistId" => ItemKey::MusicBrainzArtistId,
        "MusicBrainzReleaseArtistId" => ItemKey::MusicBrainzReleaseArtistId,
        "MusicBrainzWorkId" => ItemKey::MusicBrainzWorkId,
        "FlagCompilation" => ItemKey::FlagCompilation,
        "FlagPodcast" => ItemKey::FlagPodcast,
        "FileType" => ItemKey::FileType,
        "FileOwner" => ItemKey::FileOwner,
        "TaggingTime" => ItemKey::TaggingTime,
        "Length" => ItemKey::Length,
        "OriginalFileName" => ItemKey::OriginalFileName,
        "OriginalMediaType" => ItemKey::OriginalMediaType,
        "EncodedBy" => ItemKey::EncodedBy,
        "EncoderSoftware" => ItemKey::EncoderSoftware,
        "EncoderSettings" => ItemKey::EncoderSettings,
        "EncodingTime" => ItemKey::EncodingTime,
        "ReplayGainAlbumGain" => ItemKey::ReplayGainAlbumGain,
        "ReplayGainAlbumPeak" => ItemKey::ReplayGainAlbumPeak,
        "ReplayGainTrackGain" => ItemKey::ReplayGainTrackGain,
        "ReplayGainTrackPeak" => ItemKey::ReplayGainTrackPeak,
        "AudioFileUrl" => ItemKey::AudioFileUrl,
        "AudioSourceUrl" => ItemKey::AudioSourceUrl,
        "CommercialInformationUrl" => ItemKey::CommercialInformationUrl,
        "CopyrightUrl" => ItemKey::CopyrightUrl,
        "TrackArtistUrl" => ItemKey::TrackArtistUrl,
        "RadioStationUrl" => ItemKey::RadioStationUrl,
        "PaymentUrl" => ItemKey::PaymentUrl,
        "PublisherUrl" => ItemKey::PublisherUrl,
        "Genre" => ItemKey::Genre,
        "InitialKey" => ItemKey::InitialKey,
        "Color" => ItemKey::Color,
        "Mood" => ItemKey::Mood,
        "Bpm" => ItemKey::Bpm,
        "IntegerBpm" => ItemKey::IntegerBpm,
        "CopyrightMessage" => ItemKey::CopyrightMessage,
        "License" => ItemKey::License,
        "PodcastDescription" => ItemKey::PodcastDescription,
        "PodcastSeriesCategory" => ItemKey::PodcastSeriesCategory,
        "PodcastUrl" => ItemKey::PodcastUrl,
        "PodcastGlobalUniqueId" => ItemKey::PodcastGlobalUniqueId,
        "PodcastKeywords" => ItemKey::PodcastKeywords,
        "Comment" => ItemKey::Comment,
        "Description" => ItemKey::Description,
        "Language" => ItemKey::Language,
        "Script" => ItemKey::Script,
        "Lyrics" => ItemKey::Lyrics,
        "AppleXid" => ItemKey::AppleXid,
        "AppleId3v2ContentGroup" => ItemKey::AppleId3v2ContentGroup,
        _ => return None,
    })
}

/// Explicit backup of a single file. Always (re)writes the searchable
/// backup field in the canonical "filename | | artist | | title | | year"
/// format from the file's current values, and writes the full JSON snapshot
/// if one isn't already present (the JSON snapshot is never overwritten, so
/// the earliest full state is always recoverable). All other tags are kept.
#[tauri::command]
pub async fn backup_file(path: String, backup_field: String) -> Result<(), String> {
    run_blocking(move || backup_file_blocking(&path, &backup_field)).await
}

fn backup_file_blocking(path: &str, backup_field: &str) -> Result<(), String> {
    let mut tagged = lofty::read_from_path(path).map_err(|e| e.to_string())?;
    // Write into the format's canonical tag (e.g. ID3v2 for MP3), never a
    // limited secondary tag like ID3v1 that can't hold Composer.
    let tag_type = tagged
        .primary_tag()
        .map(|t| t.tag_type())
        .unwrap_or_else(|| tagged.file_type().primary_tag_type());

    // Read current values and decide on the JSON snapshot (immutable borrow).
    let (artist, title, year, json_backup) = {
        let tag = tagged.primary_tag().or_else(|| tagged.first_tag());
        let (a, t, y) = match tag {
            Some(t) => (
                t.artist().map(|c| c.to_string()),
                t.title().map(|c| c.to_string()),
                get_text(t, &ItemKey::RecordingDate)
                    .or_else(|| get_text(t, &ItemKey::Year))
                    .or_else(|| t.year().map(|y| y.to_string())),
            ),
            None => (None, None, None),
        };
        let json = if find_backup_in_file(&tagged).is_some() {
            None
        } else {
            Some(make_backup_string(tag, tag_type))
        };
        (a, t, y, json)
    };
    let searchable = build_searchable_backup(path, artist, title, year);

    // Fetch the tag by type (creating it if missing) so this never depends on
    // whether that type happens to be the file's "primary" tag.
    if tagged.tag(tag_type).is_none() {
        tagged.insert_tag(Tag::new(tag_type));
    }
    let key = backup_item_key(backup_field);
    let tag = tagged
        .tag_mut(tag_type)
        .expect("tag of tag_type was just ensured");
    tag.insert_text(key, searchable);
    if let Some(json) = json_backup {
        // See the matching fix in write_tags_blocking: this must be
        // insert_unchecked, or the snapshot silently never gets written.
        tag.insert_unchecked(TagItem::new(
            ItemKey::Unknown(BACKUP_KEY.to_string()),
            ItemValue::Text(json),
        ));
    }
    tagged
        .save_to_path(path, WriteOptions::default())
        .map_err(|e| e.to_string())
}

/// Returns the first embedded picture as a `data:` URL, or None if the file
/// has no cover art. Used for lazy thumbnail loading in the track table.
#[tauri::command]
pub async fn read_cover_art(path: String) -> Result<Option<String>, String> {
    run_blocking(move || read_cover_art_blocking(&path)).await
}

fn read_cover_art_blocking(path: &str) -> Result<Option<String>, String> {
    use base64::Engine;
    let tagged = lofty::read_from_path(path).map_err(|e| e.to_string())?;
    let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) else {
        return Ok(None);
    };
    let Some(pic) = tag.pictures().first() else {
        return Ok(None);
    };
    let mime = pic
        .mime_type()
        .map(|m| m.as_str().to_string())
        .unwrap_or_else(|| "image/jpeg".to_string());
    let b64 = base64::engine::general_purpose::STANDARD.encode(pic.data());
    Ok(Some(format!("data:{mime};base64,{b64}")))
}

/// Returns a small JPEG data URL of the first embedded picture — for the track
/// table's tiny thumbnails, where handing back the full-resolution art (via
/// `read_cover_art`) for hundreds of rows at once would use hundreds of MB of
/// base64 and freeze the UI. `size` is the longest side in px (clamped 16–512).
#[tauri::command]
pub async fn read_cover_thumbnail(path: String, size: u32) -> Result<Option<String>, String> {
    run_blocking(move || read_cover_thumbnail_blocking(&path, size)).await
}

fn read_cover_thumbnail_blocking(path: &str, size: u32) -> Result<Option<String>, String> {
    use base64::Engine;
    use image::GenericImageView;

    let size = size.clamp(16, 512);
    let tagged = lofty::read_from_path(path).map_err(|e| e.to_string())?;
    let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) else {
        return Ok(None);
    };
    let Some(pic) = tag.pictures().first() else {
        return Ok(None);
    };
    let img = image::load_from_memory(pic.data()).map_err(|e| e.to_string())?;
    // `thumbnail` is a fast area-averaging downscale: several times quicker
    // than a filtered `resize` for the big reductions a table cell needs
    // (a 3000px cover down to 64px), and indistinguishable at that size.
    let thumb = if img.dimensions().0.max(img.dimensions().1) > size {
        img.thumbnail(size, size)
    } else {
        img
    };
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 78)
        .encode_image(&thumb.to_rgb8())
        .map_err(|e| e.to_string())?;
    Ok(Some(format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&out)
    )))
}

/// Thumbnails for many files in one call, decoded across `par_map`'s threads.
///
/// The table needs a thumbnail for every row, and doing that one file at a
/// time — a full IPC round trip per file, each costing a tag parse plus an
/// image decode/resize/encode — was the single slowest thing about opening a
/// large folder. Batching turns N round trips into N/chunk, and each chunk
/// fans out over several threads.
///
/// Always returns exactly one entry per input path, in order, so the caller
/// can mark every path as "loaded" and never re-request it.
#[tauri::command]
pub async fn read_cover_thumbnails(paths: Vec<String>, size: u32) -> Vec<CoverThumbnail> {
    let fallback = paths.clone();
    tauri::async_runtime::spawn_blocking(move || {
        par_map(
            &paths,
            |p| CoverThumbnail {
                path: p.clone(),
                data_url: read_cover_thumbnail_blocking(p, size).ok().flatten(),
            },
            |p| CoverThumbnail {
                path: p.clone(),
                data_url: None,
            },
        )
    })
    .await
    .unwrap_or_else(|_| {
        fallback
            .into_iter()
            .map(|path| CoverThumbnail {
                path,
                data_url: None,
            })
            .collect()
    })
}

/// Returns byte size, pixel dimensions, and mime type of the first embedded
/// picture, or None if the file has no cover art. Dimensions are decoded from
/// the picture bytes with the `image` crate (lofty exposes the mime/bytes only).
#[tauri::command]
pub async fn image_info(path: String) -> Result<Option<ImageInfo>, String> {
    run_blocking(move || image_info_blocking(&path)).await
}

/// Artwork metadata for many files in one call — the `image_info` equivalent
/// of `read_cover_thumbnails`, and used the same way by the Artwork column.
/// Always returns one entry per input path, in order.
#[tauri::command]
pub async fn image_info_batch(paths: Vec<String>) -> Vec<ImageInfoResult> {
    let fallback = paths.clone();
    tauri::async_runtime::spawn_blocking(move || {
        par_map(
            &paths,
            |p| ImageInfoResult {
                path: p.clone(),
                info: image_info_blocking(p).ok().flatten(),
            },
            |p| ImageInfoResult {
                path: p.clone(),
                info: None,
            },
        )
    })
    .await
    .unwrap_or_else(|_| {
        fallback
            .into_iter()
            .map(|path| ImageInfoResult { path, info: None })
            .collect()
    })
}

fn image_info_blocking(path: &str) -> Result<Option<ImageInfo>, String> {
    let tagged = lofty::read_from_path(path).map_err(|e| e.to_string())?;
    let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) else {
        return Ok(None);
    };
    let Some(pic) = tag.pictures().first() else {
        return Ok(None);
    };
    let mime = pic
        .mime_type()
        .map(|m| m.as_str().to_string())
        .unwrap_or_else(|| "image/jpeg".to_string());
    let size_bytes = pic.data().len() as u64;
    let (width, height) = image_dimensions(pic.data()).unwrap_or((0, 0));
    Ok(Some(ImageInfo { mime, size_bytes, width, height }))
}

/// Pixel size read from the image header alone. The Artwork column asks for
/// this on every row, and fully decoding a 3000×3000 cover just to learn its
/// size cost tens of milliseconds a track.
fn image_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .ok()?
        .into_dimensions()
        .ok()
}

/// The MIME type of known artwork bytes, from their signature.
fn sniff_cover_mime(bytes: &[u8]) -> Option<lofty::picture::MimeType> {
    use lofty::picture::MimeType;
    match image::guess_format(bytes).ok()? {
        image::ImageFormat::Jpeg => Some(MimeType::Jpeg),
        image::ImageFormat::Png => Some(MimeType::Png),
        image::ImageFormat::Gif => Some(MimeType::Gif),
        image::ImageFormat::Bmp => Some(MimeType::Bmp),
        _ => None,
    }
}

/// Artwork from a user-chosen image file, ready to embed.
///
/// The type comes from the bytes, not the extension — a ".jpg" saved from a
/// web page is often really a PNG or WebP, and labelling it by name embedded
/// a picture whose declared type was wrong. Formats DJ software can't show
/// (WebP above all) are re-encoded as JPEG rather than embedded unreadable.
fn prepare_cover(bytes: Vec<u8>) -> Result<(lofty::picture::MimeType, Vec<u8>), String> {
    if let Some(mime) = sniff_cover_mime(&bytes) {
        return Ok((mime, bytes));
    }
    let img = image::load_from_memory(&bytes)
        .map_err(|_| "That file isn't an image the app can read (JPEG, PNG, GIF, BMP or WebP)".to_string())?;
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 92)
        .encode_image(&img.to_rgb8())
        .map_err(|e| format!("Could not convert the image to JPEG: {e}"))?;
    Ok((lofty::picture::MimeType::Jpeg, out))
}

/// Embeds `bytes` as the file's sole cover art, replacing any existing picture.
fn embed_picture_bytes(path: &str, mime: lofty::picture::MimeType, bytes: Vec<u8>) -> Result<(), String> {
    let picture = lofty::picture::Picture::new_unchecked(
        lofty::picture::PictureType::CoverFront,
        Some(mime),
        None,
        bytes,
    );

    let mut tagged = lofty::read_from_path(path).map_err(|e| e.to_string())?;
    let tag_type = tagged
        .primary_tag()
        .map(|t| t.tag_type())
        .unwrap_or_else(|| tagged.file_type().primary_tag_type());
    if tagged.primary_tag().is_none() {
        tagged.insert_tag(Tag::new(tag_type));
    }
    let tag = tagged.tag_mut(tag_type).ok_or("Could not access tag")?;
    tag.set_picture(0, picture);
    tagged
        .save_to_path(path, WriteOptions::default())
        .map_err(|e| e.to_string())
}

/// Removes all embedded pictures from the file.
fn remove_all_pictures(path: &str) -> Result<(), String> {
    let mut tagged = lofty::read_from_path(path).map_err(|e| e.to_string())?;
    let tag_type = tagged
        .primary_tag()
        .map(|t| t.tag_type())
        .unwrap_or_else(|| tagged.file_type().primary_tag_type());
    let Some(tag) = tagged.tag_mut(tag_type) else {
        return Ok(());
    };
    while !tag.pictures().is_empty() {
        tag.remove_picture(0);
    }
    tagged
        .save_to_path(path, WriteOptions::default())
        .map_err(|e| e.to_string())
}

/// Embeds `image_path` as the file's cover art, replacing any existing picture.
#[tauri::command]
pub async fn set_cover_art(path: String, image_path: String) -> Result<(), String> {
    run_blocking(move || {
        let bytes = std::fs::read(&image_path).map_err(|e| e.to_string())?;
        let (mime, bytes) = prepare_cover(bytes)?;
        embed_picture_bytes(&path, mime, bytes)
    })
    .await
}

/// Removes all embedded cover art from the file.
#[tauri::command]
pub async fn remove_cover_art(path: String) -> Result<(), String> {
    run_blocking(move || remove_all_pictures(&path)).await
}

/// Re-embeds (or removes, if `data_url` is `None`/empty) cover art from a
/// `data:<mime>;base64,<data>` string — used to undo/redo artwork changes
/// without needing to keep the original source file around.
#[tauri::command]
pub async fn restore_cover_art(path: String, data_url: Option<String>) -> Result<(), String> {
    run_blocking(move || {
        use base64::Engine;
        let Some(url) = data_url.filter(|u| !u.is_empty()) else {
            return remove_all_pictures(&path);
        };
        let (meta, b64) = url.split_once(',').ok_or("Malformed image data")?;
        let mime_str = meta
            .strip_prefix("data:")
            .and_then(|m| m.strip_suffix(";base64"))
            .unwrap_or("image/jpeg");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| e.to_string())?;
        // Undo/redo must put back exactly what was there, so the bytes are
        // never re-encoded here; the declared type is only a fallback for a
        // format the signature check doesn't know.
        let mime = sniff_cover_mime(&bytes)
            .unwrap_or_else(|| lofty::picture::MimeType::from_str(mime_str));
        embed_picture_bytes(&path, mime, bytes)
    })
    .await
}

/// Recompresses one file's cover art to a standard form: JPEG at `quality`,
/// scaled so the longest side is at most `max_dim` (never upscaled). Returns
/// `None` when the file has no art, or the art is already JPEG, within size,
/// and re-encoding it would not shrink it. The before/after data URLs let the
/// caller record the change in the undo/redo history like a manual swap.
#[tauri::command]
pub async fn standardize_artwork(
    path: String,
    max_dim: u32,
    quality: u8,
) -> Result<Option<crate::models::ArtworkChange>, String> {
    run_blocking(move || standardize_artwork_blocking(&path, max_dim, quality)).await
}

/// A standardized cover: the new JPEG bytes plus the source and result pixel
/// sizes (for the history entry's before/after summary).
struct RecompressedCover {
    jpeg: Vec<u8>,
    from: (u32, u32),
    to: (u32, u32),
}

/// The pixel transform behind `standardize_artwork`, split out so it can be
/// tested without an audio container. Given the original picture bytes,
/// returns the standardized JPEG plus its dimensions — or `None` when the
/// original is already a JPEG within `max_dim` that a re-encode would not
/// shrink.
fn recompress_cover(
    orig: &[u8],
    is_jpeg: bool,
    max_dim: u32,
    quality: u8,
) -> Result<Option<RecompressedCover>, String> {
    use image::GenericImageView;

    let max_dim = max_dim.clamp(64, 4000);
    let quality = quality.clamp(40, 100);

    let img = image::load_from_memory(orig).map_err(|e| format!("Unreadable cover art: {e}"))?;
    let (w, h) = img.dimensions();

    let needs_resize = w.max(h) > max_dim;
    let scaled = if needs_resize {
        img.resize(max_dim, max_dim, image::imageops::FilterType::Lanczos3)
    } else {
        img
    };
    let (nw, nh) = scaled.dimensions();

    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality)
        .encode_image(&scaled.to_rgb8())
        .map_err(|e| format!("JPEG encode failed: {e}"))?;

    // Leave a JPEG that is already within bounds alone unless the re-encode
    // saves real space (>10%) — a marginal shave isn't worth a generation of
    // quality loss.
    if !needs_resize && is_jpeg && (out.len() as f64) > (orig.len() as f64) * 0.9 {
        return Ok(None);
    }
    Ok(Some(RecompressedCover {
        jpeg: out,
        from: (w, h),
        to: (nw, nh),
    }))
}

fn standardize_artwork_blocking(
    path: &str,
    max_dim: u32,
    quality: u8,
) -> Result<Option<crate::models::ArtworkChange>, String> {
    use base64::Engine;

    let tagged = lofty::read_from_path(path).map_err(|e| e.to_string())?;
    let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) else {
        return Ok(None);
    };
    let Some(pic) = tag.pictures().first() else {
        return Ok(None);
    };
    let orig = pic.data().to_vec();
    let is_jpeg = matches!(pic.mime_type(), Some(lofty::picture::MimeType::Jpeg));
    let before_mime = pic
        .mime_type()
        .map(|m| m.as_str().to_string())
        .unwrap_or_else(|| "image/jpeg".to_string());
    drop(tagged);

    let Some(new) = recompress_cover(&orig, is_jpeg, max_dim, quality)? else {
        return Ok(None);
    };

    embed_picture_bytes(path, lofty::picture::MimeType::Jpeg, new.jpeg.clone())?;

    let b64 = |bytes: &[u8]| base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(Some(crate::models::ArtworkChange {
        before_data_url: format!("data:{before_mime};base64,{}", b64(&orig)),
        after_data_url: format!("data:image/jpeg;base64,{}", b64(&new.jpeg)),
        before_bytes: orig.len() as u64,
        after_bytes: new.jpeg.len() as u64,
        before_width: new.from.0,
        before_height: new.from.1,
        after_width: new.to.0,
        after_height: new.to.1,
    }))
}

/// Renames the file to `new_stem` (extension preserved), resolving collisions
/// by appending " (2)", " (3)", … Returns the new absolute path.
#[tauri::command]
pub async fn rename_file(path: String, new_stem: String) -> Result<String, String> {
    run_blocking(move || rename_file_blocking(&path, &new_stem)).await
}

/// Validates and tidies a new file name (without extension).
///
/// The UI already builds names from letters, digits and spaces only, but this
/// is the last line of defence before the filesystem: a separator would move
/// the file into another folder, and Windows refuses reserved device names
/// (`CON`, `NUL`, `COM1`…), names ending in a dot or space, and components
/// over 255 characters.
fn safe_file_stem(raw: &str) -> Result<String, String> {
    const MAX_CHARS: usize = 200; // leaves room for " (n)" and the extension
    let stem = raw.trim().trim_end_matches(['.', ' ']);
    if stem.is_empty() {
        return Err("New name is empty".into());
    }
    if let Some(c) = stem
        .chars()
        .find(|c| matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control())
    {
        return Err(format!("A file name can't contain {c:?}"));
    }
    let base = stem.split('.').next().unwrap_or(stem).trim().to_ascii_uppercase();
    let reserved = matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (base.len() == 4
            && (base.starts_with("COM") || base.starts_with("LPT"))
            && base.as_bytes()[3].is_ascii_digit());
    if reserved {
        return Err(format!("\"{stem}\" is a name Windows reserves for devices"));
    }
    Ok(if stem.chars().count() > MAX_CHARS {
        let cut: String = stem.chars().take(MAX_CHARS).collect();
        cut.trim_end_matches(['.', ' ']).to_string()
    } else {
        stem.to_string()
    })
}

fn rename_file_blocking(path: &str, new_stem: &str) -> Result<String, String> {
    let src = Path::new(path);
    if !src.is_file() {
        return Err(format!("File not found: {path}"));
    }
    let stem = safe_file_stem(new_stem)?;
    let stem = stem.as_str();
    let parent = src.parent().unwrap_or_else(|| Path::new("."));
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("");

    let build = |candidate: &str| -> std::path::PathBuf {
        if ext.is_empty() {
            parent.join(candidate)
        } else {
            parent.join(format!("{candidate}.{ext}"))
        }
    };

    let mut target = build(stem);
    // Byte-identical path — nothing to do.
    if target == src {
        return Ok(path.to_string());
    }

    // Does `p` resolve to the very file we're renaming? On a case-insensitive
    // volume (Windows, default macOS) "Bonobo - Kerala.mp3" and an on-disk
    // "bonobo - kerala.mp3" are the same file, so `target.exists()` is true
    // even though the paths differ. Without this check the loop below would
    // treat the file as colliding with itself and append " (2)".
    let src_canon = std::fs::canonicalize(src).ok();
    let is_self = |p: &std::path::Path| {
        matches!(
            (std::fs::canonicalize(p).ok(), src_canon.as_ref()),
            (Some(a), Some(b)) if a == *b
        )
    };

    let mut n = 2;
    while target.exists() && !is_self(&target) {
        target = build(&format!("{stem} ({n})"));
        n += 1;
    }
    // A case-only / normalization-only change lands here with `target` still
    // pointing at `src`; fs::rename applies it (a case-only rename is fine on
    // Windows and macOS).
    std::fs::rename(src, &target).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().to_string())
}

/// Rewrites one file's tags into the single container its format calls
/// canonical, dropping every other container it carries.
///
/// The point is a library where the same information always lives in the same
/// place: an mp3 that has picked up an ID3v1 block and an APE tag alongside its
/// ID3v2 ends up with ID3v2 alone. Values are never edited — only moved.
///
/// It is deliberately *not* "delete the secondaries". A secondary container can
/// hold a field the primary lacks, and deleting it outright would silently lose
/// that, so the primary is copied into the new tag first and anything the
/// secondaries hold for keys the primary doesn't have is folded in behind it.
/// Pictures come from the primary, or from a secondary if the primary has none.
///
/// Returns whether the file actually needed rewriting, so the caller can report
/// how much of the library was already standard.
fn standardize_container_blocking(path: &str) -> Result<bool, String> {
    let mut tagged = lofty::read_from_path(path).map_err(|e| e.to_string())?;
    let target = tagged.file_type().primary_tag_type();
    let present: Vec<TagType> = tagged.tags().iter().map(|t| t.tag_type()).collect();

    // Nothing to unify: no tags at all, or exactly the canonical one already.
    if present.is_empty() || (present.len() == 1 && present[0] == target) {
        return Ok(false);
    }

    // The canonical tag is kept as it is — its format-specific frames (GEOB,
    // PRIV, POPM, …) included, which a blank tag would drop. Without one, the
    // first secondary becomes the base: `insert_unchecked`/`push_unchecked`
    // rather than the checked variants, so keys the target format has no
    // standard mapping for — the app's own backup JSON among them — survive
    // the move instead of being quietly dropped.
    let mut new_tag = tagged.remove(target).unwrap_or_else(|| Tag::new(target));
    let held: std::collections::HashSet<String> =
        new_tag.items().map(|i| key_name(i.key())).collect();

    // Fold in anything only a secondary container knows about.
    for tag in tagged.tags() {
        for item in tag.items() {
            if !held.contains(&key_name(item.key())) {
                new_tag.push_unchecked(item.clone());
            }
        }
        if new_tag.pictures().is_empty() {
            for pic in tag.pictures() {
                new_tag.push_picture(pic.clone());
            }
        }
    }

    let others: Vec<TagType> = present.into_iter().filter(|t| *t != target).collect();
    drop(tagged);
    for tt in others {
        Tag::new(tt)
            .remove_from_path(path)
            .map_err(|e| e.to_string())?;
    }
    repair_item_languages(&mut new_tag);
    new_tag
        .save_to_path(path, WriteOptions::default())
        .map_err(|e| e.to_string())?;
    Ok(true)
}

/// Runs `standardize_container_blocking` across `paths` on `par_map`'s threads,
/// reporting progress on the same `write-progress` event the batch writer uses.
#[tauri::command]
pub async fn standardize_tag_containers(
    app: tauri::AppHandle,
    paths: Vec<String>,
) -> Result<ContainerSweepResult, String> {
    use std::sync::atomic::{AtomicUsize, Ordering};

    let total = paths.len();
    tauri::async_runtime::spawn_blocking(move || {
        let done = AtomicUsize::new(0);
        let step = (total / 50).max(1);
        let results = par_map(
            &paths,
            |path| {
                let outcome = standardize_container_blocking(path);
                let n = done.fetch_add(1, Ordering::Relaxed) + 1;
                if n % step == 0 || n == total {
                    let _ = app.emit("write-progress", WriteProgress { done: n, total });
                }
                (path.clone(), outcome)
            },
            |path| (path.clone(), Err(CRASHED.to_string())),
        );
        let mut out = ContainerSweepResult {
            converted: 0,
            already: 0,
            failed: Vec::new(),
        };
        for (path, outcome) in results {
            match outcome {
                Ok(true) => out.converted += 1,
                Ok(false) => out.already += 1,
                Err(e) => out.failed.push(format!("{path}: {e}")),
            }
        }
        out
    })
    .await
    .map_err(|e| e.to_string())
}

/// Sends the file to the OS Recycle Bin / Trash rather than deleting it
/// permanently, so a mistaken delete from the app can still be recovered.
#[tauri::command]
pub async fn delete_file(path: String) -> Result<(), String> {
    run_blocking(move || {
        let src = Path::new(&path);
        if !src.is_file() {
            return Err(format!("File not found: {path}"));
        }
        trash::delete(src).map_err(|e| e.to_string())
    })
    .await
}

/// Opens the OS "Open with…" chooser for a file. On Windows this is the
/// native `shell32` "How do you want to open this file?" dialog, so the user
/// can hand a track straight to a converter, player or editor without leaving
/// the app. macOS opens the file's Info panel (the closest equivalent to a
/// chooser); on Linux there's no standard dialog, so it falls back to `xdg-open`.
#[tauri::command]
pub async fn open_with(path: String) -> Result<(), String> {
    run_blocking(move || {
        if !Path::new(&path).is_file() {
            return Err(format!("File not found: {path}"));
        }
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            std::process::Command::new("rundll32.exe")
                .args(["shell32.dll,OpenAs_RunDLL", &path])
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
                .map_err(|e| format!("Could not open the chooser: {e}"))?;
            Ok(())
        }
        #[cfg(target_os = "macos")]
        {
            // `open -R` reveals in Finder; there is no CLI "open with" chooser.
            std::process::Command::new("open")
                .args(["-R", &path])
                .spawn()
                .map_err(|e| e.to_string())?;
            Ok(())
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            std::process::Command::new("xdg-open")
                .arg(&path)
                .spawn()
                .map_err(|e| e.to_string())?;
            Ok(())
        }
    })
    .await
}

/// Generic text file write, used for exporting settings, match logs and
/// playlists to a user-chosen path.
#[tauri::command]
pub async fn write_text_file(path: String, contents: String) -> Result<(), String> {
    run_blocking(move || std::fs::write(&path, contents).map_err(|e| e.to_string())).await
}

/// Generic text file read, used for importing a previously exported settings file.
#[tauri::command]
pub async fn read_text_file(path: String) -> Result<String, String> {
    run_blocking(move || std::fs::read_to_string(&path).map_err(|e| e.to_string())).await
}

/// Whether a path exists on disk. Used for the first-launch Library prompt,
/// to offer `Music\Collection` as a default only when it's actually there.
#[tauri::command]
pub async fn path_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

/// A file's modified time in Unix seconds, or `None` if it doesn't exist.
/// Used to detect a changed Rekordbox XML export so it can be re-imported
/// automatically at launch instead of only on request.
#[tauri::command]
pub async fn file_mtime_secs(path: String) -> Option<i64> {
    std::fs::metadata(&path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mtc-test-{}-{:?}",
            name,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    // The sweep deletes tag containers, so the thing that must never regress is
    // that it moves what they held first. An mp3 carrying ID3v2 + APE + ID3v1,
    // where only the APE tag knows the album, has to come out as ID3v2 alone
    // with the album still on it.
    #[test]
    fn standardize_container_folds_secondaries_into_the_primary() {
        let dir = scratch("container");
        let path = dir.join("track.mp3");
        std::fs::write(&path, minimal_mp3_bytes()).unwrap();
        let path_str = path.to_str().unwrap().to_string();

        {
            let mut v2 = Tag::new(TagType::Id3v2);
            v2.insert_text(ItemKey::TrackTitle, "Kerala".to_string());
            v2.insert_text(ItemKey::TrackArtist, "Bonobo".to_string());
            v2.save_to_path(&path_str, WriteOptions::default()).unwrap();

            // Only the APE tag knows the album — deleting it naively loses this.
            let mut ape = Tag::new(TagType::Ape);
            ape.insert_text(ItemKey::AlbumTitle, "Migration".to_string());
            ape.save_to_path(&path_str, WriteOptions::default()).unwrap();

            let mut v1 = Tag::new(TagType::Id3v1);
            v1.insert_text(ItemKey::TrackTitle, "Kerala".to_string());
            v1.save_to_path(&path_str, WriteOptions::default()).unwrap();
        }

        let before = lofty::read_from_path(&path_str).unwrap();
        assert!(
            before.tags().len() > 1,
            "fixture should start with several containers, got {}",
            before.tags().len()
        );
        drop(before);

        let changed = standardize_container_blocking(&path_str)
            .expect("standardize_container_blocking should succeed");
        assert!(changed, "a multi-container file should report as rewritten");

        let after = lofty::read_from_path(&path_str).unwrap();
        let types: Vec<TagType> = after.tags().iter().map(|t| t.tag_type()).collect();
        assert_eq!(types, vec![TagType::Id3v2], "only ID3v2 should remain");

        let tag = after.primary_tag().expect("ID3v2 tag should exist");
        assert_eq!(tag.title().as_deref(), Some("Kerala"));
        assert_eq!(tag.artist().as_deref(), Some("Bonobo"));
        assert_eq!(
            get_text(tag, &ItemKey::AlbumTitle).as_deref(),
            Some("Migration"),
            "the album only the APE tag held must survive the sweep"
        );
        drop(after);

        // Idempotent: a file already standard is left alone and reports so.
        let again = standardize_container_blocking(&path_str).unwrap();
        assert!(!again, "a standard file should report no change");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rename_case_only_change_does_not_append_suffix() {
        let dir = scratch("case");
        let src = dir.join("bonobo - kerala.mp3");
        std::fs::write(&src, b"x").unwrap();

        let out = rename_file_blocking(src.to_str().unwrap(), "Bonobo - Kerala").unwrap();

        assert!(
            !out.contains("(2)"),
            "case-only rename should not collide with itself: {out}"
        );
        assert!(out.ends_with("Bonobo - Kerala.mp3"));
        // Exactly one file in the dir (the renamed one), not a stale duplicate.
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rename_refuses_names_the_filesystem_would_misread() {
        assert!(safe_file_stem("Artist - Title").is_ok());
        assert_eq!(safe_file_stem("  Title. . ").unwrap(), "Title");
        for bad in ["", "  ", "..\\escape", "a/b", "what?", "con", "Lpt1", "NUL.tar"] {
            assert!(safe_file_stem(bad).is_err(), "{bad:?} should be refused");
        }
        assert!(safe_file_stem("Console").is_ok(), "only exact device names are reserved");
        let long = "x".repeat(400);
        assert_eq!(safe_file_stem(&long).unwrap().chars().count(), 200);
    }

    #[test]
    fn rename_real_collision_still_appends_suffix() {
        let dir = scratch("collision");
        let a = dir.join("song a.mp3");
        let b = dir.join("song b.mp3");
        std::fs::write(&a, b"a").unwrap();
        std::fs::write(&b, b"b").unwrap();

        let out = rename_file_blocking(b.to_str().unwrap(), "song a").unwrap();

        assert!(out.ends_with("song a (2).mp3"), "got {out}");
        std::fs::remove_dir_all(&dir).ok();
    }

    fn png_bytes(w: u32, h: u32) -> Vec<u8> {
        let mut img = image::RgbImage::new(w, h);
        for (x, y, px) in img.enumerate_pixels_mut() {
            *px = image::Rgb([(x % 256) as u8, (y % 256) as u8, 128]);
        }
        let mut out = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut out, image::ImageFormat::Png)
            .unwrap();
        out.into_inner()
    }

    #[test]
    fn recompress_downscales_oversized_art() {
        let out = recompress_cover(&png_bytes(2000, 1500), false, 1000, 85).unwrap().unwrap();
        assert_eq!(out.from, (2000, 1500));
        assert_eq!(out.to, (1000, 750)); // longest side clamped, aspect kept
        assert_eq!(&out.jpeg[..3], b"\xFF\xD8\xFF"); // JPEG magic
    }

    #[test]
    fn recompress_converts_non_jpeg_even_when_small() {
        let res = recompress_cover(&png_bytes(400, 400), false, 1000, 85).unwrap();
        assert!(res.is_some(), "a PNG should still be converted to JPEG");
        assert_eq!(res.unwrap().to, (400, 400)); // not upscaled
    }

    #[test]
    fn recompress_skips_a_conformant_jpeg() {
        // Encode a small JPEG, then feed it back in as an existing JPEG.
        let jpeg = recompress_cover(&png_bytes(500, 500), false, 1000, 85).unwrap().unwrap().jpeg;
        let again = recompress_cover(&jpeg, true, 1000, 85).unwrap();
        assert!(again.is_none(), "a JPEG within bounds should not be rewritten");
    }

    /// A minimal valid MPEG-1 Layer III frame (128kbps / 44100Hz / stereo,
    /// no CRC), repeated so lofty's format prober has enough consecutive
    /// frames to identify the file as MP3.
    fn minimal_mp3_bytes() -> Vec<u8> {
        let mut bytes = Vec::new();
        for _ in 0..20 {
            bytes.extend_from_slice(&[0xFF, 0xFB, 0x90, 0x00]);
            bytes.extend(std::iter::repeat(0u8).take(413));
        }
        bytes
    }

    // Regression test for "Generate IDs" writing a Track ID that never shows
    // up on read-back: ItemKey::Unknown("TRACKID") is 7 bytes, not a valid
    // 4-byte ID3v2 frame id, so it must round-trip as a TXXX frame with
    // description "TRACKID" rather than being silently dropped.
    #[test]
    fn track_id_round_trips_through_id3v2() {
        let dir = scratch("trackid");
        let path = dir.join("track.mp3");
        std::fs::write(&path, minimal_mp3_bytes()).unwrap();
        let path_str = path.to_str().unwrap().to_string();

        let mut tags = TagData::default();
        tags.track_id = Some("000123".to_string());
        write_tags_blocking(&path_str, tags, false, vec![], false, None)
            .expect("write_tags_blocking should succeed");

        let read_back = read_tags_impl(&path_str).expect("read_tags_impl should succeed");
        assert_eq!(
            read_back.track_id.as_deref(),
            Some("000123"),
            "Track ID did not round-trip through ID3v2"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    // Same class of bug as the Track ID one above, hitting the searchable
    // backup: the JSON snapshot is stored under `ItemKey::Unknown(BACKUP_KEY)`
    // ("TAGBACKUP"), an unmapped private key, so it must go through
    // `insert_unchecked` too or it's silently dropped and "Restore Backup"
    // has nothing to restore from.
    #[test]
    fn backup_blob_round_trips_through_id3v2() {
        let dir = scratch("backupblob");
        let path = dir.join("track.mp3");
        std::fs::write(&path, minimal_mp3_bytes()).unwrap();
        let path_str = path.to_str().unwrap().to_string();

        let mut tags = TagData::default();
        tags.title = Some("Kerala".to_string());
        write_tags_blocking(&path_str, tags, true, vec![], false, None)
            .expect("write_tags_blocking should succeed");

        let tagged = lofty::read_from_path(&path_str).unwrap();
        assert!(
            find_backup_in_file(&tagged).is_some(),
            "searchable backup blob did not round-trip through ID3v2"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    // Same class of bug again: editing a raw "All Tags" field whose key
    // lofty doesn't have a built-in mapping for (e.g. a custom TXXX
    // description) went through checked `insert_text` and was silently
    // dropped instead of actually changing the value on disk.
    #[test]
    fn raw_field_edit_round_trips_through_id3v2() {
        let dir = scratch("rawfield");
        let path = dir.join("track.mp3");
        std::fs::write(&path, minimal_mp3_bytes()).unwrap();
        let path_str = path.to_str().unwrap().to_string();

        // Seed an unmapped custom field directly, the way a file ripped by
        // some other tool might already have one.
        {
            let mut tag = Tag::new(TagType::Id3v2);
            tag.insert_unchecked(TagItem::new(
                ItemKey::Unknown("CUSTOMFIELD".to_string()),
                ItemValue::Text("old value".to_string()),
            ));
            tag.save_to_path(&path_str, WriteOptions::default()).unwrap();
        }

        write_raw_field_blocking(&path_str, "Unknown(CUSTOMFIELD)", "new value")
            .expect("write_raw_field_blocking should succeed");

        let read_back = read_tags_impl(&path_str).expect("read_tags_impl should succeed");
        assert_eq!(
            read_back.all_fields.get("Unknown(CUSTOMFIELD)").map(String::as_str),
            Some("new value"),
            "raw field edit did not round-trip through ID3v2"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    // ---- Tag writes must not destroy what the app doesn't manage -------------

    use lofty::id3::v2::{
        BinaryFrame, CommentFrame, ExtendedTextFrame, Frame, FrameId, Id3v2Tag,
        PopularimeterFrame, PrivateFrame,
    };
    use lofty::TextEncoding;
    use std::borrow::Cow;

    /// The file's ID3v2 tag, read through the format-specific API so frames the
    /// generic `Tag` keeps out of sight (GEOB, PRIV, POPM) are visible.
    fn id3_of(path: &str) -> Id3v2Tag {
        let mut file = std::fs::File::open(path).unwrap();
        let mp3 = <lofty::mpeg::MpegFile as lofty::file::AudioFile>::read_from(
            &mut file,
            lofty::config::ParseOptions::new(),
        )
        .unwrap();
        mp3.id3v2().cloned().expect("file should carry an ID3v2 tag")
    }

    fn frames_with_id<'a>(tag: &'a Id3v2Tag, id: &str) -> Vec<&'a Frame<'static>> {
        tag.into_iter().filter(|f| f.id().as_str() == id).collect()
    }

    /// An mp3 shaped like one from a working DJ library: Serato's GEOB data,
    /// Traktor's PRIV block, a Rekordbox POPM rating with a play count, a
    /// custom TXXX field, an iTunes `iTunNORM` comment ahead of the real one,
    /// and a two-value artist.
    fn dj_library_mp3(dir: &Path) -> String {
        let path = dir.join("dj.mp3");
        std::fs::write(&path, minimal_mp3_bytes()).unwrap();
        let p = path.to_str().unwrap().to_string();
        let mut t = Id3v2Tag::new();
        t.set_title("Kerala".into());
        t.set_artist("Bonobo\0Totally Enormous".into());
        t.insert(Frame::Binary(BinaryFrame::new(
            FrameId::Valid(Cow::Borrowed("GEOB")),
            b"\0application/octet-stream\0\0Serato Markers2\0cue-data".to_vec(),
        )));
        t.insert(Frame::Private(PrivateFrame::new("TRAKTOR4".into(), vec![1, 2, 3])));
        t.insert(Frame::Popularimeter(PopularimeterFrame::new("rekordbox".into(), 204, 7)));
        t.insert(Frame::UserText(ExtendedTextFrame::new(
            TextEncoding::UTF8,
            "CUSTOMFIELD".into(),
            "keep me".into(),
        )));
        t.insert(Frame::Comment(CommentFrame::new(
            TextEncoding::UTF8,
            *b"eng",
            "iTunNORM".into(),
            " 00000A2B 00000B3C".into(),
        )));
        t.insert(Frame::Comment(CommentFrame::new(
            TextEncoding::UTF8,
            *b"eng",
            String::new(),
            "Peak time".into(),
        )));
        t.save_to_path(&p, WriteOptions::default()).unwrap();
        p
    }

    /// The `keepExtra` the UI sends for an ordinary edit: every raw field
    /// outside the curated set (mirrors `preserveExtras` in useTags.ts).
    fn ui_keep_extra(tags: &TagData) -> Vec<String> {
        const CURATED: &[&str] = &[
            "TrackTitle", "TrackArtist", "AlbumTitle", "AlbumArtist", "TrackNumber",
            "TrackTotal", "DiscNumber", "DiscTotal", "Year", "RecordingDate", "Genre",
            "Comment", "OriginalArtist", "Composer", "Popularimeter", "Unknown(TRACKID)",
            "Bpm", "IntegerBpm", "InitialKey", "Unknown(ORIGINALARTIST)",
            "Unknown(----:com.apple.iTunes:TRACKID)", "Unknown(----:com.apple.iTunes:ORIGINALARTIST)",
        ];
        tags.all_fields
            .keys()
            .filter(|k| !CURATED.contains(&k.as_str()))
            .cloned()
            .collect()
    }

    #[test]
    fn an_edit_keeps_serato_traktor_rating_and_custom_frames() {
        let dir = scratch("djframes");
        let p = dj_library_mp3(&dir);

        let tags = read_tags_impl(&p).unwrap();
        let keep = ui_keep_extra(&tags);
        let mut edited = tags.clone();
        edited.title = Some("Kerala (Original Mix)".into());
        write_tags_blocking(&p, edited, false, keep, true, None).unwrap();

        let id3 = id3_of(&p);
        assert_eq!(id3.title().as_deref(), Some("Kerala (Original Mix)"));
        assert_eq!(frames_with_id(&id3, "GEOB").len(), 1, "Serato GEOB data was dropped");
        assert_eq!(frames_with_id(&id3, "PRIV").len(), 1, "Traktor PRIV data was dropped");
        let popm: Vec<_> = id3
            .into_iter()
            .filter_map(|f| match f {
                Frame::Popularimeter(p) => Some(p),
                _ => None,
            })
            .collect();
        assert_eq!(popm.len(), 1, "POPM rating was dropped");
        assert_eq!((popm[0].email.as_str(), popm[0].rating, popm[0].counter), ("rekordbox", 204, 7));

        let back = read_tags_impl(&p).unwrap();
        assert_eq!(
            back.all_fields.get("Unknown(CUSTOMFIELD)").map(String::as_str),
            Some("keep me"),
            "a kept custom TXXX field was dropped"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unchanged_fields_are_left_as_stored() {
        let dir = scratch("unchanged");
        let p = dj_library_mp3(&dir);

        let tags = read_tags_impl(&p).unwrap();
        assert_eq!(tags.artist.as_deref(), Some("Bonobo"));
        assert_eq!(
            tags.comment.as_deref(),
            Some("Peak time"),
            "the plain comment, not iTunes' iTunNORM, is the one shown"
        );
        let keep = ui_keep_extra(&tags);
        let mut edited = tags.clone();
        edited.genre = Some("Downtempo".into());
        write_tags_blocking(&p, edited, false, keep, true, None).unwrap();

        let back = lofty::read_from_path(&p).unwrap();
        let tag = back.primary_tag().unwrap();
        let artists: Vec<_> = tag.get_strings(&ItemKey::TrackArtist).collect();
        assert_eq!(artists, ["Bonobo", "Totally Enormous"], "second artist was lost");
        let comments: Vec<_> = tag
            .items()
            .filter(|i| *i.key() == ItemKey::Comment)
            .map(|i| (i.description().to_string(), text_of(i.value()).unwrap()))
            .collect();
        assert!(comments.contains(&("iTunNORM".into(), " 00000A2B 00000B3C".into())));
        assert!(comments.contains(&(String::new(), "Peak time".into())));

        // Editing the comment replaces only the plain one.
        let tags = read_tags_impl(&p).unwrap();
        let keep = ui_keep_extra(&tags);
        let mut edited = tags.clone();
        edited.comment = Some("Closing track".into());
        write_tags_blocking(&p, edited, false, keep, true, None).unwrap();
        let back = read_tags_impl(&p).unwrap();
        assert_eq!(back.comment.as_deref(), Some("Closing track"));
        assert!(back.all_fields["Comment"].contains("00000A2B"), "iTunNORM was dropped");
        assert!(!back.all_fields["Comment"].contains("Peak time"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn stripping_removes_only_fields_left_out_of_keep_extra() {
        let dir = scratch("strip");
        let p = dj_library_mp3(&dir);

        let tags = read_tags_impl(&p).unwrap();
        write_tags_blocking(&p, tags, false, vec![], true, None).unwrap();

        let back = read_tags_impl(&p).unwrap();
        assert!(!back.all_fields.contains_key("Unknown(CUSTOMFIELD)"), "strip didn't strip");
        assert_eq!(frames_with_id(&id3_of(&p), "GEOB").len(), 1, "strip took the Serato data");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn mp3_popm_rating_is_read_and_rewritten_in_place() {
        let dir = scratch("popm");
        let p = dj_library_mp3(&dir);

        let tags = read_tags_impl(&p).unwrap();
        assert_eq!(tags.rating, Some(4), "Rekordbox's 204 is four stars");

        let mut edited = tags.clone();
        edited.rating = Some(2);
        write_tags_blocking(&p, edited, false, ui_keep_extra(&tags), true, None).unwrap();
        assert_eq!(read_tags_impl(&p).unwrap().rating, Some(2));
        let id3 = id3_of(&p);
        let popm: Vec<_> = id3
            .into_iter()
            .filter_map(|f| match f {
                Frame::Popularimeter(p) => Some(p),
                _ => None,
            })
            .collect();
        assert_eq!(popm.len(), 1);
        assert_eq!((popm[0].email.as_str(), popm[0].rating, popm[0].counter), ("rekordbox", 102, 7));

        let mut cleared = read_tags_impl(&p).unwrap();
        cleared.rating = Some(0);
        write_tags_blocking(&p, cleared.clone(), false, ui_keep_extra(&cleared), true, None).unwrap();
        assert_eq!(read_tags_impl(&p).unwrap().rating, None);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Found on a real recorder file: a COMM frame with language [0, 0, 0].
    /// Keeping unchanged frames verbatim made lofty refuse the whole write.
    #[test]
    fn a_comment_with_a_null_language_does_not_block_an_edit() {
        let dir = scratch("nulllang");
        let path = dir.join("rec.mp3");
        std::fs::write(&path, minimal_mp3_bytes()).unwrap();
        let p = path.to_str().unwrap().to_string();
        {
            let mut t = Id3v2Tag::new();
            t.set_title("REC".into());
            t.insert(Frame::Comment(CommentFrame::new(
                TextEncoding::Latin1,
                *b"eng",
                String::new(),
                "recorded live".into(),
            )));
            t.save_to_path(&p, WriteOptions::default()).unwrap();
        }
        // Patch the COMM frame's language bytes to NUL, as the recorder wrote them.
        let mut bytes = std::fs::read(&path).unwrap();
        let comm = bytes.windows(4).position(|w| w == b"COMM").unwrap();
        let lang = comm + 10 + 1; // frame header, then the encoding byte
        assert_eq!(&bytes[lang..lang + 3], b"eng");
        bytes[lang..lang + 3].copy_from_slice(&[0, 0, 0]);
        std::fs::write(&path, &bytes).unwrap();

        let tags = read_tags_impl(&p).unwrap();
        let mut edited = tags.clone();
        edited.title = Some("REC (edited)".into());
        write_tags_blocking(&p, edited, false, ui_keep_extra(&tags), true, None)
            .expect("an invalid comment language must not fail the write");
        let back = read_tags_impl(&p).unwrap();
        assert_eq!(back.title.as_deref(), Some("REC (edited)"));
        assert_eq!(back.comment.as_deref(), Some("recorded live"), "the comment text was lost");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rating_a_bare_mp3_adds_a_popm_frame() {
        let dir = scratch("popmnew");
        let path = dir.join("bare.mp3");
        std::fs::write(&path, minimal_mp3_bytes()).unwrap();
        let p = path.to_str().unwrap().to_string();

        let tags = TagData { rating: Some(5), ..TagData::default() };
        write_tags_blocking(&p, tags, false, vec![], true, None).unwrap();
        assert_eq!(read_tags_impl(&p).unwrap().rating, Some(5));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn popm_bytes_map_to_the_star_every_player_means() {
        // Rekordbox / Traktor scale.
        for (byte, stars) in [(51, 1), (102, 2), (153, 3), (204, 4), (255, 5)] {
            assert_eq!(stars_from_popm_byte(byte), stars, "rekordbox byte {byte}");
        }
        // Windows Media Player / MusicBee scale.
        for (byte, stars) in [(1, 1), (64, 2), (128, 3), (196, 4), (255, 5)] {
            assert_eq!(stars_from_popm_byte(byte), stars, "wmp byte {byte}");
        }
        assert_eq!(stars_from_popm_byte(0), 0);
        assert_eq!(stars_from_popm_byte(20), 1, "a low byte is rated, not unrated");
        for stars in 1..=5u8 {
            assert_eq!(stars_from_popm_byte(popm_byte(stars) as u32), stars);
        }
    }

    #[test]
    fn text_ratings_round_trip_on_the_0_100_scale() {
        for tag_type in [TagType::VorbisComments, TagType::Mp4Ilst, TagType::Ape] {
            for stars in 1..=5u8 {
                let mut tag = Tag::new(tag_type);
                set_text_rating(&mut tag, stars);
                assert_eq!(read_rating(&tag), Some(stars), "{tag_type:?} {stars}");
            }
            let mut tag = Tag::new(tag_type);
            set_text_rating(&mut tag, 3);
            set_text_rating(&mut tag, 0);
            assert_eq!(read_rating(&tag), None, "{tag_type:?} clear");
        }
        // Other taggers' conventions.
        assert_eq!(stars_from_text_rating("4"), Some(4));
        assert_eq!(stars_from_text_rating("80"), Some(4));
        assert_eq!(stars_from_text_rating("100"), Some(5));
        assert_eq!(stars_from_text_rating("0"), None);
        assert_eq!(stars_from_text_rating("junk"), None);
    }

    /// A FLAC file with STREAMINFO (16-bit stereo 44.1kHz), a PADDING block
    /// and a few bytes standing in for audio frames: enough for lofty to read
    /// and write Vorbis comments. (lofty 0.22's writer indexes past the end of
    /// a file that stops right after its metadata, which no real FLAC does.)
    fn minimal_flac_bytes() -> Vec<u8> {
        let mut b = b"fLaC".to_vec();
        b.extend_from_slice(&[0x00, 0x00, 0x00, 0x22]); // STREAMINFO, 34 bytes
        b.extend_from_slice(&[0x10, 0x00, 0x10, 0x00]); // min/max block size 4096
        b.extend_from_slice(&[0, 0, 0, 0, 0, 0]); // min/max frame size unknown
        b.extend_from_slice(&[0x0A, 0xC4, 0x42, 0xF0, 0, 0, 0, 0]); // 44100 Hz, 2 ch, 16 bit
        b.extend_from_slice(&[0u8; 16]); // MD5
        b.extend_from_slice(&[0x81, 0x00, 0x00, 0x10]); // last block, PADDING, 16 bytes
        b.extend_from_slice(&[0u8; 16]);
        b.extend_from_slice(&[0xFF, 0xF8]); // frame sync
        b.extend_from_slice(&[0u8; 62]);
        b
    }

    #[test]
    fn flac_rating_and_custom_fields_survive_edits() {
        let dir = scratch("flac");
        let path = dir.join("track.flac");
        std::fs::write(&path, minimal_flac_bytes()).unwrap();
        let p = path.to_str().unwrap().to_string();
        {
            let mut tag = Tag::new(TagType::VorbisComments);
            tag.insert_text(ItemKey::TrackTitle, "Kerala".into());
            // Serato keeps its FLAC cue data in Vorbis comments like this one.
            tag.insert_unchecked(TagItem::new(
                ItemKey::Unknown("SERATO_MARKERS_V2".into()),
                ItemValue::Text("YXBwbGljYXRpb24v".into()),
            ));
            tag.save_to_path(&p, WriteOptions::default()).unwrap();
        }

        let tags = read_tags_impl(&p).unwrap();
        let mut edited = tags.clone();
        edited.rating = Some(4);
        write_tags_blocking(&p, edited, false, ui_keep_extra(&tags), true, None).unwrap();

        let back = read_tags_impl(&p).unwrap();
        assert_eq!(back.rating, Some(4), "four stars must read back as four, not two");
        assert_eq!(
            back.all_fields.get("Unknown(SERATO_MARKERS_V2)").map(String::as_str),
            Some("YXBwbGljYXRpb24v"),
            "Serato's FLAC data was dropped"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn searchable_backup_fills_an_empty_field_and_never_overrides_the_user() {
        let dir = scratch("backupfield");
        let p = dj_library_mp3(&dir);

        // Empty Composer: the searchable backup goes in, from pre-change values.
        let tags = read_tags_impl(&p).unwrap();
        let mut edited = tags.clone();
        edited.title = Some("Renamed".into());
        write_tags_blocking(&p, edited, false, ui_keep_extra(&tags), true, Some("Composer".into()))
            .unwrap();
        let back = read_tags_impl(&p).unwrap();
        assert_eq!(back.composer.as_deref(), Some("dj | | Bonobo | | Kerala | | "));

        // An unrelated edit leaves the existing backup alone.
        let mut edited = back.clone();
        edited.title = Some("Renamed again".into());
        write_tags_blocking(&p, edited, false, ui_keep_extra(&back), true, Some("Composer".into()))
            .unwrap();
        let back = read_tags_impl(&p).unwrap();
        assert_eq!(back.composer.as_deref(), Some("dj | | Bonobo | | Kerala | | "));

        // Clearing the backup field on purpose (Clear Fields warns first) works.
        let mut edited = back.clone();
        edited.composer = None;
        write_tags_blocking(&p, edited, false, ui_keep_extra(&back), true, Some("Composer".into()))
            .unwrap();
        assert_eq!(read_tags_impl(&p).unwrap().composer, None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_existing_snapshot_survives_a_write_that_did_not_ask_for_one() {
        let dir = scratch("keepsnapshot");
        let p = dj_library_mp3(&dir);

        let tags = read_tags_impl(&p).unwrap();
        write_tags_blocking(&p, tags.clone(), true, ui_keep_extra(&tags), true, None).unwrap();
        let tags = read_tags_impl(&p).unwrap();
        let mut edited = tags.clone();
        edited.title = Some("Changed".into());
        write_tags_blocking(&p, edited, false, ui_keep_extra(&tags), true, None).unwrap();

        let tagged = lofty::read_from_path(&p).unwrap();
        assert!(find_backup_in_file(&tagged).is_some(), "the original snapshot was deleted");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn restore_brings_back_custom_fields_and_keeps_dj_frames() {
        let dir = scratch("restore");
        let p = dj_library_mp3(&dir);
        let mut seeded = read_tags_impl(&p).unwrap();
        seeded.track_id = Some("000042".into());
        write_tags_blocking(&p, seeded.clone(), false, ui_keep_extra(&seeded), true, None)
            .unwrap();

        // Snapshot, then wreck the tags.
        let tags = read_tags_impl(&p).unwrap();
        let mut wrecked = tags.clone();
        wrecked.title = Some("WRONG".into());
        wrecked.track_id = None;
        write_tags_blocking(&p, wrecked, true, vec![], true, None).unwrap();
        assert!(!read_tags_impl(&p).unwrap().all_fields.contains_key("Unknown(CUSTOMFIELD)"));

        crate::commands::backup::restore_from_backup_blocking(&p).unwrap();

        let back = read_tags_impl(&p).unwrap();
        assert_eq!(back.title.as_deref(), Some("Kerala"));
        assert_eq!(back.track_id.as_deref(), Some("000042"), "Track ID lost on restore");
        assert_eq!(
            back.all_fields.get("Unknown(CUSTOMFIELD)").map(String::as_str),
            Some("keep me"),
            "custom field lost on restore"
        );
        let id3 = id3_of(&p);
        assert_eq!(frames_with_id(&id3, "GEOB").len(), 1, "restore took the Serato data");
        assert_eq!(back.rating, Some(4), "restore took the rating");
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---- Tag audit matrix (v0.19 A3) ------------------------------------------
    //
    // Every curated field x every container: write it through the real write
    // path, re-read it, and require it to come back equal. Fixtures are 0.2 s
    // silent files (ffmpeg, no metadata) kept in `testdata/`, plus the
    // synthetic mp3/flac above.

    const SAMPLE_M4A: &[u8] = include_bytes!("testdata/s.m4a");
    const SAMPLE_OGG: &[u8] = include_bytes!("testdata/s.ogg");
    const SAMPLE_AIFF: &[u8] = include_bytes!("testdata/s.aiff");
    const SAMPLE_WAV: &[u8] = include_bytes!("testdata/s.wav");

    /// An MP3 whose ID3v2 tag is written as v2.3 (what older Traktor/iTunes
    /// libraries use) or v2.4, with the DJ companion frames already on it.
    fn mp3_with_version(dir: &Path, v23: bool) -> String {
        let path = dir.join(if v23 { "v23.mp3" } else { "v24.mp3" });
        std::fs::write(&path, minimal_mp3_bytes()).unwrap();
        let p = path.to_str().unwrap().to_string();
        let mut t = Id3v2Tag::new();
        t.set_title("Seed".into());
        t.insert(Frame::Binary(BinaryFrame::new(
            FrameId::Valid(Cow::Borrowed("GEOB")),
            b"\0application/octet-stream\0\0Serato Markers2\0cue-data".to_vec(),
        )));
        t.insert(Frame::Private(PrivateFrame::new("TRAKTOR4".into(), vec![1, 2, 3])));
        t.insert(Frame::Popularimeter(PopularimeterFrame::new(
            "Windows Media Player 9 Series".into(),
            128,
            3,
        )));
        t.save_to_path(&p, WriteOptions::default().use_id3v23(v23)).unwrap();
        p
    }

    fn full_tags() -> TagData {
        TagData {
            title: Some("Audit Title".into()),
            artist: Some("Audit Artist".into()),
            album: Some("Audit Album".into()),
            album_artist: Some("Audit AlbumArtist".into()),
            track_number: Some("3/12".into()),
            disc_number: Some("1/2".into()),
            year: Some("2019".into()),
            genre: Some("House".into()),
            comment: Some("Audit comment".into()),
            composer: Some("Audit Composer".into()),
            original_artist: Some("Audit Original".into()),
            track_id: Some("000777".into()),
            rating: Some(4),
            bpm: Some("128".into()),
            key: Some("8A".into()),
            ..TagData::default()
        }
    }

    /// (field name, read-back value as a string) for every curated field.
    fn curated_view(t: &TagData) -> Vec<(&'static str, Option<String>)> {
        vec![
            ("title", t.title.clone()),
            ("artist", t.artist.clone()),
            ("album", t.album.clone()),
            ("albumArtist", t.album_artist.clone()),
            ("trackNumber", t.track_number.clone()),
            ("discNumber", t.disc_number.clone()),
            ("year", t.year.clone()),
            ("genre", t.genre.clone()),
            ("comment", t.comment.clone()),
            ("composer", t.composer.clone()),
            ("originalArtist", t.original_artist.clone()),
            ("trackId", t.track_id.clone()),
            ("rating", t.rating.map(|r| r.to_string())),
            ("bpm", t.bpm.clone()),
            ("key", t.key.clone()),
        ]
    }

    fn matrix_files(dir: &Path) -> Vec<(&'static str, String)> {
        let mut out = vec![
            ("mp3 id3v2.3", mp3_with_version(dir, true)),
            ("mp3 id3v2.4", mp3_with_version(dir, false)),
        ];
        let flac = dir.join("m.flac");
        std::fs::write(&flac, minimal_flac_bytes()).unwrap();
        out.push(("flac", flac.to_str().unwrap().to_string()));
        for (label, name, bytes) in [
            ("m4a", "m.m4a", SAMPLE_M4A),
            ("ogg vorbis", "m.ogg", SAMPLE_OGG),
            ("aiff", "m.aiff", SAMPLE_AIFF),
            ("wav", "m.wav", SAMPLE_WAV),
        ] {
            let p = dir.join(name);
            std::fs::write(&p, bytes).unwrap();
            out.push((label, p.to_str().unwrap().to_string()));
        }
        out
    }

    #[test]
    fn every_curated_field_round_trips_in_every_container() {
        let dir = scratch("matrix");
        let mut failures = Vec::new();
        for (label, p) in matrix_files(&dir) {
            let seed = read_tags_impl(&p).unwrap_or_else(|e| panic!("{label}: unreadable fixture: {e}"));
            write_tags_blocking(&p, full_tags(), false, ui_keep_extra(&seed), true, None)
                .unwrap_or_else(|e| panic!("{label}: write failed: {e}"));
            let back = read_tags_impl(&p).unwrap();
            for ((name, want), (_, got)) in curated_view(&full_tags()).into_iter().zip(curated_view(&back)) {
                if want != got {
                    failures.push(format!("{label}: {name} wrote {want:?} read {got:?}"));
                }
            }
            // No curated value may also surface under a raw key the UI would
            // show as a second column: every key outside the curated list
            // must be one the file carried before we wrote.
            for k in back.all_fields.keys() {
                let curated = crate::commands::library_index::KEPT_FIELD_KEYS.contains(&k.as_str());
                if !curated && !seed.all_fields.contains_key(k) && !back.all_fields[k].is_empty() {
                    failures.push(format!("{label}: stray raw key {k} = {:?}", back.all_fields[k]));
                }
            }
        }
        std::fs::remove_dir_all(&dir).ok();
        assert!(failures.is_empty(), "audit failures:\n{}", failures.join("\n"));
    }

    #[test]
    fn a_second_identical_write_changes_nothing() {
        // Writing what is already there must be a no-op for every field
        // (this is what keeps a "no changes" save from touching the file).
        let dir = scratch("matrix-idem");
        for (label, p) in matrix_files(&dir) {
            write_tags_blocking(&p, full_tags(), false, vec![], true, None).unwrap();
            let once = read_tags_impl(&p).unwrap();
            write_tags_blocking(&p, once.clone(), false, ui_keep_extra(&once), true, None).unwrap();
            let twice = read_tags_impl(&p).unwrap();
            assert_eq!(curated_view(&once), curated_view(&twice), "{label}");
            assert_eq!(once.all_fields, twice.all_fields, "{label}: raw fields drifted");
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn id3_companion_frames_survive_a_full_edit_in_v23_and_v24() {
        let dir = scratch("matrix-companions");
        for v23 in [true, false] {
            let p = mp3_with_version(&dir, v23);
            let seed = read_tags_impl(&p).unwrap();
            let mut edit = full_tags();
            edit.rating = None; // leave the foreign POPM alone
            write_tags_blocking(&p, edit, false, ui_keep_extra(&seed), true, None).unwrap();
            let id3 = id3_of(&p);
            assert_eq!(frames_with_id(&id3, "GEOB").len(), 1, "v23={v23}: GEOB lost");
            assert_eq!(frames_with_id(&id3, "PRIV").len(), 1, "v23={v23}: PRIV lost");
            assert_eq!(frames_with_id(&id3, "POPM").len(), 1, "v23={v23}: POPM lost");
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn bpm_is_rounded_only_where_the_format_stores_an_integer() {
        assert_eq!(bpm_for_format(TagType::Id3v2, "127.99"), "128");
        assert_eq!(bpm_for_format(TagType::Mp4Ilst, " 90.4 "), "90");
        assert_eq!(bpm_for_format(TagType::VorbisComments, "127.99"), "127.99");
        assert_eq!(bpm_for_format(TagType::Id3v2, "fast"), "fast");
    }

    #[test]
    fn bpm_and_key_edits_leave_other_fields_alone_and_can_be_cleared() {
        let dir = scratch("bpmkey");
        let p = dj_library_mp3(&dir);
        let seed = read_tags_impl(&p).unwrap();
        let mut e = seed.clone();
        e.bpm = Some("127.6".into());
        e.key = Some("Am".into());
        write_tags_blocking(&p, e, false, ui_keep_extra(&seed), true, None).unwrap();
        let back = read_tags_impl(&p).unwrap();
        assert_eq!(back.bpm.as_deref(), Some("128"));
        assert_eq!(back.key.as_deref(), Some("Am"));
        assert_eq!(back.title, seed.title);
        assert_eq!(back.rating, seed.rating);
        assert_eq!(back.all_fields.get("Unknown(CUSTOMFIELD)").map(String::as_str), Some("keep me"));
        let mut c = back.clone();
        c.bpm = None;
        c.key = None;
        write_tags_blocking(&p, c, false, ui_keep_extra(&back), true, None).unwrap();
        let cleared = read_tags_impl(&p).unwrap();
        assert_eq!((cleared.bpm, cleared.key), (None, None));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn par_map_keeps_order_and_isolates_a_panicking_item() {
        let items: Vec<u32> = (0..500).collect();
        let out = par_map(
            &items,
            |n| {
                if *n == 137 {
                    panic!("simulated parser crash");
                }
                n * 2
            },
            |_| u32::MAX,
        );
        assert_eq!(out.len(), items.len(), "a panic must not shorten the batch");
        for (i, v) in out.iter().enumerate() {
            let expected = if i == 137 { u32::MAX } else { i as u32 * 2 };
            assert_eq!(*v, expected, "item {i}");
        }
    }

    #[test]
    fn item_key_names_round_trip() {
        const NAMES: &[&str] = &[
        "AlbumTitle",
        "SetSubtitle",
        "ShowName",
        "ContentGroup",
        "TrackTitle",
        "TrackSubtitle",
        "OriginalAlbumTitle",
        "OriginalArtist",
        "OriginalLyricist",
        "AlbumTitleSortOrder",
        "AlbumArtistSortOrder",
        "TrackTitleSortOrder",
        "TrackArtistSortOrder",
        "ShowNameSortOrder",
        "ComposerSortOrder",
        "AlbumArtist",
        "TrackArtist",
        "TrackArtists",
        "Arranger",
        "Writer",
        "Composer",
        "Conductor",
        "Director",
        "Engineer",
        "Lyricist",
        "MixDj",
        "MixEngineer",
        "MusicianCredits",
        "Performer",
        "Producer",
        "Publisher",
        "Label",
        "InternetRadioStationName",
        "InternetRadioStationOwner",
        "Remixer",
        "DiscNumber",
        "DiscTotal",
        "TrackNumber",
        "TrackTotal",
        "Popularimeter",
        "ParentalAdvisory",
        "RecordingDate",
        "Year",
        "ReleaseDate",
        "OriginalReleaseDate",
        "Isrc",
        "Barcode",
        "CatalogNumber",
        "Work",
        "Movement",
        "MovementNumber",
        "MovementTotal",
        "MusicBrainzRecordingId",
        "MusicBrainzTrackId",
        "MusicBrainzReleaseId",
        "MusicBrainzReleaseGroupId",
        "MusicBrainzArtistId",
        "MusicBrainzReleaseArtistId",
        "MusicBrainzWorkId",
        "FlagCompilation",
        "FlagPodcast",
        "FileType",
        "FileOwner",
        "TaggingTime",
        "Length",
        "OriginalFileName",
        "OriginalMediaType",
        "EncodedBy",
        "EncoderSoftware",
        "EncoderSettings",
        "EncodingTime",
        "ReplayGainAlbumGain",
        "ReplayGainAlbumPeak",
        "ReplayGainTrackGain",
        "ReplayGainTrackPeak",
        "AudioFileUrl",
        "AudioSourceUrl",
        "CommercialInformationUrl",
        "CopyrightUrl",
        "TrackArtistUrl",
        "RadioStationUrl",
        "PaymentUrl",
        "PublisherUrl",
        "Genre",
        "InitialKey",
        "Color",
        "Mood",
        "Bpm",
        "IntegerBpm",
        "CopyrightMessage",
        "License",
        "PodcastDescription",
        "PodcastSeriesCategory",
        "PodcastUrl",
        "PodcastGlobalUniqueId",
        "PodcastKeywords",
        "Comment",
        "Description",
        "Language",
        "Script",
        "Lyrics",
        "AppleXid",
        "AppleId3v2ContentGroup",
        ];
        for name in NAMES {
            let key = item_key_from_name(name).unwrap_or_else(|| panic!("no key for {name}"));
            assert_eq!(key_name(&key), *name);
        }
        assert_eq!(
            item_key_from_name("Unknown(SERATO_MARKERS_V2)"),
            Some(ItemKey::Unknown("SERATO_MARKERS_V2".into()))
        );
        assert_eq!(item_key_from_name("NotAKey"), None);
    }

    #[test]
    fn undoing_a_raw_field_removal_recreates_it() {
        let dir = scratch("rawundo");
        let path = dir.join("track.mp3");
        std::fs::write(&path, minimal_mp3_bytes()).unwrap();
        let p = path.to_str().unwrap().to_string();
        {
            let mut tag = Tag::new(TagType::Id3v2);
            tag.insert_text(ItemKey::TrackTitle, "Kerala".into());
            tag.insert_unchecked(TagItem::new(
                ItemKey::Unknown("CUSTOMFIELD".into()),
                ItemValue::Text("v1".into()),
            ));
            tag.insert_text(ItemKey::IntegerBpm, "122".into());
            tag.save_to_path(&p, WriteOptions::default()).unwrap();
        }
        for (field, value) in [("Unknown(CUSTOMFIELD)", "v1"), ("IntegerBpm", "122")] {
            write_raw_field_blocking(&p, field, "").unwrap();
            assert!(!read_tags_impl(&p).unwrap().all_fields.contains_key(field), "{field} not removed");
            write_raw_field_blocking(&p, field, value).unwrap();
            assert_eq!(
                read_tags_impl(&p).unwrap().all_fields.get(field).map(String::as_str),
                Some(value),
                "{field} not recreated"
            );
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Opt-in check of the tag writer against real files: copies up to
    /// `MTC_TEST_LIMIT` (default 200) mp3s from `MTC_TEST_DIR` to a scratch
    /// folder, edits each copy's title the way the UI does, and asserts every
    /// other ID3v2 frame survived. The originals are only ever read.
    ///   MTC_TEST_DIR="C:\Users\...\Music\Collection" cargo test real_library_write -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_library_write_preserves_every_frame() {
        let dir = std::env::var("MTC_TEST_DIR").expect("set MTC_TEST_DIR");
        let limit: usize = std::env::var("MTC_TEST_LIMIT").ok().and_then(|v| v.parse().ok()).unwrap_or(200);
        let scratch_dir = scratch("real-write");
        let sources: Vec<std::path::PathBuf> = audio_files_under(Path::new(&dir), true)
            .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("mp3")))
            .take(limit)
            .collect();
        let (mut checked, mut with_geob, mut with_priv, mut with_popm, mut rated) = (0, 0, 0, 0, 0);
        let mut write_errors: Vec<String> = Vec::new();
        for (i, src) in sources.iter().enumerate() {
            let copy = scratch_dir.join(format!("{i}.mp3"));
            std::fs::copy(src, &copy).unwrap();
            let p = copy.to_str().unwrap().to_string();
            let Ok(tags) = read_tags_impl(&p) else { continue };
            let frame_ids = |path: &str| -> Vec<String> {
                let mut ids: Vec<String> =
                    id3_of(path).into_iter().map(|f| f.id().as_str().to_string()).collect();
                ids.sort();
                ids
            };
            let mut file = std::fs::File::open(&p).unwrap();
            let has_id3 = <lofty::mpeg::MpegFile as lofty::file::AudioFile>::read_from(
                &mut file,
                lofty::config::ParseOptions::new(),
            )
            .map(|m| m.id3v2().is_some())
            .unwrap_or(false);
            drop(file);
            if !has_id3 {
                continue;
            }
            let before = frame_ids(&p);
            with_geob += before.iter().any(|f| f == "GEOB") as usize;
            with_priv += before.iter().any(|f| f == "PRIV") as usize;
            with_popm += before.iter().any(|f| f == "POPM") as usize;
            rated += tags.rating.is_some() as usize;

            let mut edited = tags.clone();
            edited.title = Some(format!("{} (edited)", tags.title.clone().unwrap_or_default()));
            if let Err(e) = write_tags_blocking(&p, edited, false, ui_keep_extra(&tags), true, None) {
                write_errors.push(format!("{}: {e}", src.display()));
                continue;
            }

            let mut after = frame_ids(&p);
            // The edit itself may add a TIT2 where there was none.
            if !before.contains(&"TIT2".to_string()) {
                after.retain(|f| f != "TIT2");
            }
            assert_eq!(before, after, "frames changed for {}", src.display());
            let back = read_tags_impl(&p).unwrap();
            assert_eq!(back.rating, tags.rating, "rating changed for {}", src.display());
            assert_eq!(back.artist, tags.artist, "artist changed for {}", src.display());
            assert_eq!(back.comment, tags.comment, "comment changed for {}", src.display());
            checked += 1;
        }
        println!(
            "checked {checked} real mp3s: {with_geob} with GEOB (Serato), {with_priv} with PRIV, \
             {with_popm} with POPM, {rated} rated — every frame preserved"
        );
        for e in write_errors.iter().take(20) {
            println!("WRITE ERROR {e}");
        }
        println!("{} write error(s)", write_errors.len());
        assert!(checked > 0, "no mp3s with ID3v2 found under {dir}");
        std::fs::remove_dir_all(&scratch_dir).ok();
    }
}
