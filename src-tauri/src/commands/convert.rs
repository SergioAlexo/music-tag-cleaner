//! Audio format conversion via FFmpeg (v0.10 F2).
//!
//! Transcodes selected tracks to a chosen target format/quality preset. After
//! FFmpeg produces the file, the source's tags — including the private
//! `TXXX:TRACKID` frame that `write_tags_blocking` writes — are copied onto
//! the output with `lofty`, so a converted file lands in the library already
//! carrying its Track ID (which is what groups it with the original under one
//! track, F3) and its curated metadata, regardless of how faithfully the
//! container's own metadata mapping survived the transcode.
//!
//! FFmpeg is the same optional managed component `ffmpeg.rs` installs; if it
//! isn't resolvable the command fails with a message pointing at Components.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::commands::ffmpeg::{find_ffmpeg, hide_console};
use crate::commands::files::{read_tags_impl, write_tags_blocking};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertOutcome {
    pub source: String,
    pub output: Option<String>,
    pub ok: bool,
    /// Set on failure, or as a warning ("converted, but …") when the file was
    /// produced but tag copy-over failed.
    pub error: Option<String>,
}

struct Preset {
    ext: &'static str,
    /// FFmpeg's muxer for `ext`, passed explicitly so the output can go to a
    /// temporary name FFmpeg couldn't guess a format from (see `convert_one`).
    /// `ipod` is the one FFmpeg itself picks for `.m4a`.
    muxer: &'static str,
    codec_args: &'static [&'static str],
    /// Whether the target container can carry the embedded cover art through
    /// FFmpeg's video stream ( `-c:v copy` ). Off for wav/aiff/ogg/opus.
    copy_art: bool,
}

fn preset(name: &str) -> Result<Preset, String> {
    Ok(match name {
        "mp3-320" => Preset { ext: "mp3", muxer: "mp3", codec_args: &["-c:a", "libmp3lame", "-b:a", "320k"], copy_art: true },
        "mp3-v0" => Preset { ext: "mp3", muxer: "mp3", codec_args: &["-c:a", "libmp3lame", "-q:a", "0"], copy_art: true },
        "flac" => Preset { ext: "flac", muxer: "flac", codec_args: &["-c:a", "flac"], copy_art: true },
        "alac" => Preset { ext: "m4a", muxer: "ipod", codec_args: &["-c:a", "alac"], copy_art: true },
        "aac-256" => Preset { ext: "m4a", muxer: "ipod", codec_args: &["-c:a", "aac", "-b:a", "256k"], copy_art: true },
        "wav" => Preset { ext: "wav", muxer: "wav", codec_args: &["-c:a", "pcm_s16le"], copy_art: false },
        "aiff" => Preset { ext: "aiff", muxer: "aiff", codec_args: &["-c:a", "pcm_s16be"], copy_art: false },
        "ogg-q8" => Preset { ext: "ogg", muxer: "ogg", codec_args: &["-c:a", "libvorbis", "-q:a", "8"], copy_art: false },
        "opus-192" => Preset { ext: "opus", muxer: "opus", codec_args: &["-c:a", "libopus", "-b:a", "192k"], copy_art: false },
        other => return Err(format!("Unknown convert preset: {other}")),
    })
}

/// Target file extension for a preset (used by the frontend's dialog too, via
/// the mirrored `CONVERT_PRESETS` table in `types.ts`).
pub fn preset_ext(name: &str) -> Result<&'static str, String> {
    preset(name).map(|p| p.ext)
}

/// The full FFmpeg argument vector for one conversion. Isolated and
/// unit-tested so the codec flags are checked without invoking FFmpeg.
fn ffmpeg_args(name: &str, src: &Path, dst: &Path) -> Result<Vec<String>, String> {
    let p = preset(name)?;
    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-y".into(),
        "-i".into(),
        src.to_string_lossy().into_owned(),
        "-map".into(),
        "0:a".into(),
        "-map_metadata".into(),
        "0".into(),
    ];
    if p.copy_art {
        // `?` — don't fail when the source has no embedded picture.
        args.push("-map".into());
        args.push("0:v?".into());
        args.push("-c:v".into());
        args.push("copy".into());
        args.push("-disposition:v:0".into());
        args.push("attached_pic".into());
    }
    for a in p.codec_args {
        args.push((*a).into());
    }
    if p.ext == "mp3" {
        args.push("-id3v2_version".into());
        args.push("3".into());
    }
    args.push("-f".into());
    args.push(p.muxer.into());
    args.push(dst.to_string_lossy().into_owned());
    Ok(args)
}

/// Where FFmpeg writes before the result is published under `dst`: a name no
/// library scan takes for a track, beside `dst` so publishing is a rename.
fn part_path(dst: &Path) -> PathBuf {
    let mut name = dst.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(".mtc-part");
    dst.with_file_name(name)
}

fn dst_path(src: &Path, ext: &str, subfolder: bool) -> PathBuf {
    let stem = src.file_stem().map(|s| s.to_os_string()).unwrap_or_default();
    let mut dir = src.parent().map(Path::to_path_buf).unwrap_or_default();
    if subfolder {
        dir = dir.join("converted");
    }
    let mut name = std::ffi::OsString::from(stem);
    name.push(".");
    name.push(ext);
    dir.join(name)
}

fn convert_one(
    ffmpeg: &Path,
    preset_name: &str,
    src_str: &str,
    subfolder: bool,
    overwrite: bool,
) -> ConvertOutcome {
    let src = Path::new(src_str);
    let ext = match preset_ext(preset_name) {
        Ok(e) => e,
        Err(e) => return failed(src_str, e),
    };
    let dst = dst_path(src, ext, subfolder);

    if same_file(src, &dst) {
        return failed(src_str, format!("target is the same file as the source ({ext})"));
    }
    if dst.exists() && !overwrite {
        return failed(src_str, format!("{} already exists", dst.display()));
    }
    if let Some(parent) = dst.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return failed(src_str, format!("could not create output folder: {e}"));
        }
    }

    // FFmpeg writes to a temporary name that is renamed into place only once it
    // has finished. Written straight to `dst`, a failure (or the app closing)
    // left a truncated file behind under a real track name, and a failed
    // overwrite deleted the earlier, good conversion along with it.
    let part = part_path(&dst);
    let args = match ffmpeg_args(preset_name, src, &part) {
        Ok(a) => a,
        Err(e) => return failed(src_str, e),
    };
    let mut cmd = Command::new(ffmpeg);
    cmd.args(&args);
    hide_console(&mut cmd);
    let output = match cmd.output() {
        Ok(o) => o,
        Err(e) => return failed(src_str, format!("could not run ffmpeg: {e}")),
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let msg = stderr
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("ffmpeg failed")
            .trim()
            .to_string();
        let _ = std::fs::remove_file(&part);
        return failed(src_str, format!("ffmpeg: {msg}"));
    }
    if dst.exists() && !overwrite {
        let _ = std::fs::remove_file(&part);
        return failed(src_str, format!("{} appeared while converting; not overwriting it", dst.display()));
    }
    if let Err(e) = std::fs::rename(&part, &dst) {
        let _ = std::fs::remove_file(&part);
        return failed(src_str, format!("could not save {}: {e}", dst.display()));
    }

    let dst_str = dst.to_string_lossy().to_string();

    // Copy the source's tags (incl. the private Track ID frame) onto the new
    // file. A failure here doesn't invalidate the conversion — report it as a
    // warning but keep the produced file.
    //
    // FFmpeg's `-map_metadata 0` has already carried the source's fields
    // across, so they are all kept: an empty keep-list here stripped the BPM,
    // key, label, ISRC and the rest from every converted file.
    let tag_warning = match read_tags_impl(src_str) {
        Ok(tags) => {
            let keep = read_tags_impl(&dst_str)
                .map(|t| crate::commands::files::extra_field_keys(&t))
                .unwrap_or_default();
            write_tags_blocking(&dst_str, tags, false, keep, true, None).err()
        }
        Err(e) => Some(format!("could not read source tags: {e}")),
    };

    ConvertOutcome {
        source: src_str.to_string(),
        output: Some(dst_str),
        ok: true,
        error: tag_warning.map(|e| format!("converted, but tag copy failed: {e}")),
    }
}

fn failed(src: &str, msg: String) -> ConvertOutcome {
    ConvertOutcome { source: src.to_string(), output: None, ok: false, error: Some(msg) }
}

/// Windows/macOS path comparison isn't reliably case- or normalization-exact,
/// so fall back to canonicalize when both exist.
fn same_file(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(ca), Ok(cb)) => ca == cb,
        _ => false,
    }
}

#[tauri::command]
pub async fn convert_files(
    app: AppHandle,
    paths: Vec<String>,
    preset: String,
    subfolder: bool,
    overwrite: bool,
) -> Result<Vec<ConvertOutcome>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let ffmpeg = find_ffmpeg(&app).ok_or_else(|| {
            "FFmpeg is not installed — install it on the Components page first.".to_string()
        })?;
        let ext = preset_ext(&preset)?;
        let total = paths.len();
        // Two sources that would land on one output name ("Song.flac" and
        // "Song.wav" -> "Song.mp3") can't both convert, now that conversions
        // run side by side: the later one is refused, as it was when the first
        // had already finished.
        let mut claimed = std::collections::HashSet::new();
        let clash: Vec<bool> = paths
            .iter()
            .map(|p| !claimed.insert(dst_path(Path::new(p), ext, subfolder).to_string_lossy().to_lowercase()))
            .collect();
        let jobs: Vec<(&String, bool)> = paths.iter().zip(clash).collect();
        let _ = app.emit("convert-progress", serde_json::json!({ "done": 0, "total": total, "file": serde_json::Value::Null }));
        let done = AtomicUsize::new(0);
        // Every FFmpeg encoder used here runs on one core, so a few at once is
        // close to that many times faster; more than four mostly fights over
        // the disk.
        let results = crate::commands::files::par_map_on(
            &jobs,
            crate::commands::files::worker_threads().min(4),
            |&(src, clash)| {
                let outcome = if clash {
                    failed(src, "another file in this batch converts to the same name".to_string())
                } else {
                    convert_one(&ffmpeg, &preset, src, subfolder, overwrite)
                };
                let n = done.fetch_add(1, Ordering::Relaxed) + 1;
                let _ = app.emit("convert-progress", serde_json::json!({ "done": n, "total": total, "file": src }));
                outcome
            },
            |&(src, _)| failed(src, crate::commands::files::CRASHED.to_string()),
        );
        Ok(results)
    })
    .await
    .map_err(|_| "convert task panicked".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preset_ext_maps_known_presets_and_rejects_unknown() {
        assert_eq!(preset_ext("mp3-320").unwrap(), "mp3");
        assert_eq!(preset_ext("alac").unwrap(), "m4a");
        assert_eq!(preset_ext("aac-256").unwrap(), "m4a");
        assert_eq!(preset_ext("opus-192").unwrap(), "opus");
        assert!(preset_ext("wat").is_err());
    }

    #[test]
    fn ffmpeg_args_build_a_sane_command() {
        let src = Path::new("/music/a.flac");
        let dst = Path::new("/music/a.mp3");
        let args = ffmpeg_args("mp3-320", src, dst).unwrap();
        // input, output, codec, and no leftover placeholder
        assert_eq!(args.first().unwrap(), "-hide_banner");
        assert_eq!(args.last().unwrap(), "/music/a.mp3");
        assert!(args.windows(2).any(|w| w == ["-i", "/music/a.flac"]));
        assert!(args.windows(2).any(|w| w == ["-c:a", "libmp3lame"]));
        assert!(args.windows(2).any(|w| w == ["-b:a", "320k"]));
        assert!(args.windows(2).any(|w| w == ["-id3v2_version", "3"]));
        assert!(args.windows(2).any(|w| w == ["-c:v", "copy"]));
        assert!(args.windows(2).any(|w| w == ["-f", "mp3"]));
        assert!(!args.iter().any(|a| a == "-vn"));
        // m4a is FFmpeg's `ipod` muxer, which it can no longer infer from a
        // temporary file name.
        assert!(ffmpeg_args("alac", src, Path::new("/music/a.m4a.mtc-part"))
            .unwrap()
            .windows(2)
            .any(|w| w == ["-f", "ipod"]));
        assert_eq!(part_path(dst), PathBuf::from("/music/a.mp3.mtc-part"));
    }

    /// End to end with a real FFmpeg, when one is installed: a conversion is
    /// published under its final name with no temporary file left, and a
    /// failed one leaves an existing earlier output untouched.
    #[test]
    fn a_conversion_publishes_atomically_with_real_ffmpeg() {
        let Some(ffmpeg) = crate::commands::ffmpeg::on_path(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" }) else {
            eprintln!("no FFmpeg on PATH; skipping");
            return;
        };
        let dir = std::env::temp_dir().join(format!("mtc-convert-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // One second of a 440 Hz tone as a 16-bit mono WAV.
        let src = dir.join("tone.wav");
        let pcm: Vec<u8> = (0..8000)
            .flat_map(|i| (((i as f64 / 8000.0 * 440.0 * std::f64::consts::TAU).sin() * 12000.0) as i16).to_le_bytes())
            .collect();
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + pcm.len() as u32).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        for v in [16u32.to_le_bytes(), [1, 0, 1, 0], 8000u32.to_le_bytes(), 16000u32.to_le_bytes(), [2, 0, 16, 0]] {
            wav.extend_from_slice(&v);
        }
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
        wav.extend_from_slice(&pcm);
        std::fs::write(&src, wav).unwrap();
        let src = src.to_string_lossy().to_string();

        // Every preset's explicit muxer must produce a file lofty can read.
        for preset in ["mp3-320", "mp3-v0", "alac", "aac-256", "aiff", "ogg-q8", "opus-192", "wav"] {
            let r = convert_one(&ffmpeg, preset, &src, true, true);
            assert!(r.ok, "{preset}: {:?}", r.error);
            let out = PathBuf::from(r.output.unwrap());
            assert!(read_tags_impl(&out.to_string_lossy()).is_ok(), "{preset}: unreadable output");
            assert!(!part_path(&out).exists(), "{preset}: temporary file left behind");
        }

        let ok = convert_one(&ffmpeg, "flac", &src, false, false);
        assert!(ok.ok, "{:?}", ok.error);
        let out = PathBuf::from(ok.output.unwrap());
        assert!(out.is_file() && !part_path(&out).exists());

        // A broken source converting to that same name with overwrite on:
        // FFmpeg fails, and the earlier output must survive it.
        assert_eq!(out, dir.join("tone.flac"));
        let before = std::fs::read(&out).unwrap();
        let broken = dir.join("tone.mp3");
        std::fs::write(&broken, b"not audio").unwrap();
        let bad = convert_one(&ffmpeg, "flac", &broken.to_string_lossy(), false, true);
        assert!(!bad.ok);
        assert_eq!(std::fs::read(dir.join("tone.flac")).unwrap(), before);
        assert!(!part_path(&dir.join("tone.flac")).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ffmpeg_args_skip_art_copy_for_containers_that_cant_hold_it() {
        let args = ffmpeg_args("wav", Path::new("a.flac"), Path::new("a.wav")).unwrap();
        assert!(!args.iter().any(|a| a == "-c:v"));
        assert!(args.windows(2).any(|w| w == ["-c:a", "pcm_s16le"]));
    }

    #[test]
    fn dst_path_swaps_extension_and_honors_subfolder() {
        let d = dst_path(Path::new("/a/b/song.flac"), "mp3", false);
        assert_eq!(d, PathBuf::from("/a/b/song.mp3"));
        let d2 = dst_path(Path::new("/a/b/song.flac"), "mp3", true);
        assert_eq!(d2, PathBuf::from("/a/b/converted/song.mp3"));
    }

    /// End-to-end: needs a real ffmpeg. Run with:
    ///   cargo test -- --ignored convert_roundtrip --nocapture
    #[test]
    #[ignore]
    fn convert_roundtrip_carries_tags() {
        let ffmpeg = which_ffmpeg().expect("ffmpeg not on PATH — needed for this test");

        let dir = std::env::temp_dir().join(format!(
            "mtc-convert-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let wav = dir.join("tone.wav");
        write_sine_wav(&wav, 44_100, 2.0);

        // Give the source a Track ID so we can prove it carries over.
        let mut tags = crate::models::TagData::default();
        tags.title = Some("Test Tone".into());
        tags.artist = Some("MTC".into());
        tags.track_id = Some("000123".into());
        write_tags_blocking(wav.to_str().unwrap(), tags, false, Vec::new(), false, None).unwrap();

        let out = convert_one(&ffmpeg, "mp3-320", wav.to_str().unwrap(), false, true);
        assert!(out.ok, "conversion failed: {:?}", out.error);
        let mp3 = out.output.unwrap();
        assert!(Path::new(&mp3).exists());
        assert!(std::fs::metadata(&mp3).unwrap().len() > 0);

        let carried = read_tags_impl(&mp3).unwrap();
        assert_eq!(carried.title.as_deref(), Some("Test Tone"));
        assert_eq!(carried.track_id.as_deref(), Some("000123"));

        std::fs::remove_dir_all(&dir).ok();
    }

    fn which_ffmpeg() -> Option<PathBuf> {
        let exe = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
        std::env::var("PATH").ok().and_then(|p| {
            std::env::split_paths(&p).map(|d| d.join(exe)).find(|c| c.is_file())
        })
    }

    fn write_sine_wav(path: &Path, sample_rate: u32, seconds: f64) {
        let n = (sample_rate as f64 * seconds) as usize;
        let mut data = Vec::with_capacity(n * 2);
        for i in 0..n {
            let t = i as f64 / sample_rate as f64;
            let s = ((t * 440.0 * std::f64::consts::TAU).sin() * i16::MAX as f64 * 0.6) as i16;
            data.extend_from_slice(&s.to_le_bytes());
        }
        let byte_rate = sample_rate * 2;
        let mut buf = Vec::new();
        buf.extend_from_slice(b"RIFF");
        buf.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
        buf.extend_from_slice(b"WAVEfmt ");
        buf.extend_from_slice(&16u32.to_le_bytes());
        buf.extend_from_slice(&1u16.to_le_bytes());
        buf.extend_from_slice(&1u16.to_le_bytes());
        buf.extend_from_slice(&sample_rate.to_le_bytes());
        buf.extend_from_slice(&byte_rate.to_le_bytes());
        buf.extend_from_slice(&2u16.to_le_bytes());
        buf.extend_from_slice(&16u16.to_le_bytes());
        buf.extend_from_slice(b"data");
        buf.extend_from_slice(&(data.len() as u32).to_le_bytes());
        buf.extend_from_slice(&data);
        std::fs::write(path, buf).unwrap();
    }
}
