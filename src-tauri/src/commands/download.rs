//! Streams an HTTP download to disk for the optional-component installers
//! (yt-dlp, FFmpeg, the Ollama setup program).

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// An HTTP client for component downloads. Besides the connect timeout, a
/// read timeout: a connection that goes quiet mid-download (Wi-Fi drop,
/// captive portal) otherwise waits forever with the progress bar frozen.
pub(crate) fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(concat!("music-tag-cleaner/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())
}

/// Reads at most `cap` bytes of a response body; the flag says whether there
/// was more. A plain `bytes()` buffers whatever the server sends before any
/// size check can run - a runaway or hostile response could fill the memory.
pub(crate) async fn read_body_capped(mut resp: reqwest::Response, cap: usize) -> Result<(Vec<u8>, bool), String> {
    let mut out: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("Download failed: {e}"))? {
        let room = cap - out.len();
        if chunk.len() > room {
            out.extend_from_slice(&chunk[..room]);
            return Ok((out, true));
        }
        out.extend_from_slice(&chunk);
    }
    Ok((out, false))
}

fn part_path(dest: &Path) -> PathBuf {
    let mut name = dest.file_name().unwrap_or_default().to_os_string();
    name.push(".part");
    dest.with_file_name(name)
}

/// Downloads `url` to `dest`, calling `on_progress(downloaded, total)` about
/// every 512 KB (`total` is 0 when the server doesn't say). Returns the byte
/// count.
///
/// The body goes to a sibling `.part` file that is renamed over `dest` only
/// once it has fully arrived. Writing straight to `dest` left a truncated
/// executable behind whenever a download dropped half-way — and since a
/// component counts as installed when its file exists, the app then reported
/// it installed and every later use failed with an unhelpful OS error.
pub(crate) async fn download_to_file(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    mut on_progress: impl FnMut(u64, u64),
) -> Result<u64, String> {
    let mut resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Download failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Download failed: HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    let part = part_path(dest);
    let mut file = std::io::BufWriter::new(
        std::fs::File::create(&part).map_err(|e| format!("Could not write {}: {e}", part.display()))?,
    );

    let mut downloaded: u64 = 0;
    let mut last_emitted: u64 = 0;
    let body: Result<(), String> = async {
        while let Some(chunk) = resp.chunk().await.map_err(|e| format!("Download failed: {e}"))? {
            file.write_all(&chunk).map_err(|e| e.to_string())?;
            downloaded += chunk.len() as u64;
            if downloaded - last_emitted >= 512 * 1024 {
                last_emitted = downloaded;
                on_progress(downloaded, total);
            }
        }
        file.flush().map_err(|e| e.to_string())?;
        if total > 0 && downloaded != total {
            return Err(format!(
                "Download was cut short ({downloaded} of {total} bytes) — try again"
            ));
        }
        Ok(())
    }
    .await;
    drop(file);

    if let Err(e) = body {
        let _ = std::fs::remove_file(&part);
        return Err(e);
    }
    // `fs::rename` replaces an existing file on every platform, so an update
    // over a previous install is one atomic step.
    std::fs::rename(&part, dest).map_err(|e| {
        let _ = std::fs::remove_file(&part);
        format!("Could not install {}: {e}", dest.display())
    })?;
    on_progress(downloaded, total.max(downloaded));
    Ok(downloaded)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_part_file_sits_beside_the_destination() {
        let dest = Path::new("C:/data/bin/yt-dlp.exe");
        assert_eq!(part_path(dest), Path::new("C:/data/bin/yt-dlp.exe.part"));
    }
}
