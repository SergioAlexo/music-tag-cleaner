//! FFmpeg as an optional managed component (v0.10 F1).
//!
//! FFmpeg powers format conversion (`convert.rs`). It is treated exactly like
//! `yt-dlp` in `ytmusic.rs` and Ollama in `components.rs`: detected on `PATH`
//! or in a per-app bundled location (`app_data_dir()/bin`), with a one-click
//! download on Windows if it's missing. The Windows download/unzip logic is
//! adapted from the sibling MediaFetch app's `binaries.rs`, which fetches the
//! static GPL builds published by `BtbN/FFmpeg-Builds`.
//!
//! On macOS/Linux there is no auto-install — those platforms get FFmpeg from a
//! package manager (`brew install ffmpeg`, `apt install ffmpeg`, …) and it's
//! picked up off `PATH` automatically.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

#[cfg(target_os = "windows")]
const FFMPEG_EXE: &str = "ffmpeg.exe";
#[cfg(not(target_os = "windows"))]
const FFMPEG_EXE: &str = "ffmpeg";

#[cfg(target_os = "windows")]
const FFPROBE_EXE: &str = "ffprobe.exe";
#[cfg(not(target_os = "windows"))]
const FFPROBE_EXE: &str = "ffprobe";

/// GitHub repo publishing the static Windows GPL builds.
const FFMPEG_REPO: &str = "BtbN/FFmpeg-Builds";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegInfo {
    pub installed: bool,
    /// True when the copy we found is the one we downloaded into the app's
    /// own data dir (vs. one already on the user's `PATH`).
    pub managed: bool,
    pub ffmpeg_path: Option<String>,
    pub ffprobe_path: Option<String>,
    pub version: Option<String>,
}

#[cfg(target_os = "windows")]
pub(crate) fn hide_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}
#[cfg(not(target_os = "windows"))]
pub(crate) fn hide_console(_cmd: &mut Command) {}

fn bin_dir(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_data_dir().ok()?.join("bin"))
}

fn managed_path(app: &AppHandle, exe: &str) -> Option<PathBuf> {
    let p = bin_dir(app)?.join(exe);
    p.is_file().then_some(p)
}

/// `exe` on `PATH` — or, on macOS, in Homebrew's prefixes, which a GUI app
/// launched from Finder/Dock doesn't have on its `PATH`.
pub(crate) fn on_path(exe: &str) -> Option<PathBuf> {
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let p = dir.join(exe);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    // GUI apps launched from Finder/Dock don't inherit a shell PATH.
    #[cfg(target_os = "macos")]
    for dir in ["/opt/homebrew/bin", "/usr/local/bin"] {
        let p = PathBuf::from(dir).join(exe);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// Resolve ffmpeg: the managed copy first (we know its version), then `PATH`.
/// Returns `(path, managed)`.
pub(crate) fn resolve_ffmpeg(app: &AppHandle) -> Option<(PathBuf, bool)> {
    if let Some(p) = managed_path(app, FFMPEG_EXE) {
        return Some((p, true));
    }
    on_path(FFMPEG_EXE).map(|p| (p, false))
}

pub(crate) fn find_ffmpeg(app: &AppHandle) -> Option<PathBuf> {
    resolve_ffmpeg(app).map(|(p, _)| p)
}

pub(crate) fn find_ffprobe(app: &AppHandle) -> Option<PathBuf> {
    managed_path(app, FFPROBE_EXE).or_else(|| on_path(FFPROBE_EXE))
}

fn ffmpeg_version(exe: &Path) -> Option<String> {
    let mut cmd = Command::new(exe);
    cmd.arg("-version");
    hide_console(&mut cmd);
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    // "ffmpeg version N-118000-g1234abc-20260601 Copyright ..." -> the version token
    let line = String::from_utf8_lossy(&out.stdout);
    let first = line.lines().next()?;
    first
        .split_whitespace()
        .nth(2)
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
}

#[tauri::command]
pub async fn ffmpeg_info(app: AppHandle) -> FfmpegInfo {
    tauri::async_runtime::spawn_blocking(move || {
        let ffprobe = find_ffprobe(&app);
        match resolve_ffmpeg(&app) {
            Some((exe, managed)) => FfmpegInfo {
                installed: true,
                managed,
                version: ffmpeg_version(&exe),
                ffmpeg_path: Some(exe.to_string_lossy().to_string()),
                ffprobe_path: ffprobe.map(|p| p.to_string_lossy().to_string()),
            },
            None => FfmpegInfo {
                installed: false,
                managed: false,
                version: None,
                ffmpeg_path: None,
                ffprobe_path: None,
            },
        }
    })
    .await
    .unwrap_or(FfmpegInfo {
        installed: false,
        managed: false,
        version: None,
        ffmpeg_path: None,
        ffprobe_path: None,
    })
}

fn emit_install_progress(app: &AppHandle, phase: &str, downloaded: u64, total: u64) {
    let _ = app.emit(
        "ffmpeg-install-progress",
        serde_json::json!({ "phase": phase, "downloaded": downloaded, "total": total }),
    );
}

#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
    assets: Vec<GhAsset>,
}

#[derive(Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
}

/// Downloads the latest static win64-gpl FFmpeg build from `BtbN/FFmpeg-Builds`
/// into `app_data_dir()/bin` (no installer, no PATH changes, and a system-wide
/// ffmpeg the user may already have is still preferred by `resolve_ffmpeg`
/// only if it's actually on `PATH`).
#[tauri::command]
pub async fn install_ffmpeg(app: AppHandle) -> Result<(), String> {
    if !cfg!(target_os = "windows") {
        return Err("Install FFmpeg with your package manager (`brew install ffmpeg`, \
                    `apt install ffmpeg`, …) — Vatra Wave picks it up off PATH \
                    automatically."
            .to_string());
    }

    let dir = bin_dir(&app).ok_or_else(|| "Could not resolve the app data directory".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    // Carries the User-Agent the GitHub API requires, plus connect and read
    // timeouts so a stalled download can't hang the install forever.
    let client = crate::commands::download::client()?;

    let release: GhRelease = client
        .get(format!("https://api.github.com/repos/{FFMPEG_REPO}/releases/latest"))
        .send()
        .await
        .map_err(|e| format!("GitHub API request failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("GitHub API returned an error: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Bad GitHub API response: {e}"))?;

    let asset = release
        .assets
        .iter()
        .find(|a| a.name == "ffmpeg-master-latest-win64-gpl.zip")
        .or_else(|| {
            release
                .assets
                .iter()
                .find(|a| a.name.contains("master") && a.name.ends_with("win64-gpl.zip"))
        })
        .or_else(|| release.assets.iter().find(|a| a.name.ends_with("win64-gpl.zip")))
        .ok_or("No win64-gpl FFmpeg build found in the latest release")?;

    let zip_path = dir.join("ffmpeg-download.zip");
    let downloaded = crate::commands::download::download_to_file(
        &client,
        &asset.browser_download_url,
        &zip_path,
        |done, total| emit_install_progress(&app, "downloading", done, total),
    )
    .await?;

    emit_install_progress(&app, "extracting", downloaded, downloaded);
    let dir2 = dir.clone();
    let zip2 = zip_path.clone();
    tauri::async_runtime::spawn_blocking(move || extract_ffmpeg(&zip2, &dir2))
        .await
        .map_err(|_| "extract task panicked".to_string())??;
    let _ = std::fs::remove_file(&zip_path);
    std::fs::write(dir.join("ffmpeg.tag"), &release.tag_name).map_err(|e| e.to_string())?;

    emit_install_progress(&app, "done", downloaded, downloaded);
    Ok(())
}

/// True when a zip entry is the ffmpeg or ffprobe executable inside a BtbN
/// build (they sit under `<root>/bin/`). Kept as a free function so it can be
/// unit-tested without a real archive.
fn wanted_zip_entry(entry_name: &str) -> Option<&'static str> {
    let normalized = entry_name.replace('\\', "/");
    for (needle, out) in [("bin/ffmpeg.exe", FFMPEG_EXE), ("bin/ffprobe.exe", FFPROBE_EXE)] {
        if normalized.ends_with(needle) {
            return Some(out);
        }
    }
    None
}

fn extract_ffmpeg(zip_path: &Path, dest_dir: &Path) -> Result<(), String> {
    let file = std::fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let mut extracted = 0;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let Some(out_name) = wanted_zip_entry(entry.name()) else {
            continue;
        };
        // Extracted beside the target and renamed into place, so a failed or
        // interrupted extraction never leaves a half-written ffmpeg.exe that
        // `find_ffmpeg` would then report as installed.
        let out_path = dest_dir.join(out_name);
        let tmp_path = dest_dir.join(format!("{out_name}.part"));
        let mut out = std::fs::File::create(&tmp_path).map_err(|e| e.to_string())?;
        if let Err(e) = std::io::copy(&mut entry, &mut out) {
            drop(out);
            let _ = std::fs::remove_file(&tmp_path);
            return Err(e.to_string());
        }
        drop(out);
        std::fs::rename(&tmp_path, &out_path).map_err(|e| e.to_string())?;
        extracted += 1;
    }
    if extracted == 0 {
        return Err("ffmpeg.exe was not found inside the downloaded archive".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wanted_zip_entry_matches_only_the_bin_executables() {
        assert_eq!(
            wanted_zip_entry("ffmpeg-master-latest-win64-gpl/bin/ffmpeg.exe"),
            Some(FFMPEG_EXE)
        );
        assert_eq!(
            wanted_zip_entry("ffmpeg-master-latest-win64-gpl\\bin\\ffprobe.exe"),
            Some(FFPROBE_EXE)
        );
        assert_eq!(wanted_zip_entry("ffmpeg-master-latest-win64-gpl/doc/ffmpeg.html"), None);
        assert_eq!(wanted_zip_entry("ffmpeg-master-latest-win64-gpl/LICENSE"), None);
        // A stray file merely named ffmpeg.exe but not under bin/ is ignored.
        assert_eq!(wanted_zip_entry("something/else/ffmpeg.exe.txt"), None);
    }
}
