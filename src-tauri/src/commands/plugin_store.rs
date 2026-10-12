//! Plugin store (D2): fetch the store's `index.json`, download a plugin zip,
//! verify its SHA-256 and unpack it in memory.
//!
//! Nothing is written to the plugins folder here. The package is returned to
//! the frontend as `{id, manifest, code}`, which stages it for the person's
//! review (`PluginManager.propose(..., "store")`); only an approval writes it
//! to disk. A store package that never gets approved leaves no trace.
//!
//! Untrusted input handling: the zip is read with hard size caps (a zip bomb
//! cannot expand past `MAX_FILE_BYTES`), entry names are never used as paths,
//! and only `manifest.json` plus the one script it names are read. Plain http
//! is accepted for loopback hosts only (local testing); everything else must
//! be https.

use std::io::{Read, Seek};
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest, Sha256};

use super::plugins::{valid_entry, valid_id};

/// Same limit as `plugins.rs`: a button plugin is a few hundred bytes.
const MAX_FILE_BYTES: u64 = 512 * 1024;
const MAX_INDEX_BYTES: usize = 1024 * 1024;
const MAX_ZIP_BYTES: usize = 2 * 1024 * 1024;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StorePackage {
    pub id: String,
    pub manifest: String,
    pub code: Option<String>,
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// https always; http only for loopback.
pub fn url_allowed(url: &str) -> bool {
    if url.starts_with("https://") {
        return true;
    }
    let Some(rest) = url.strip_prefix("http://") else { return false };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = host.rsplit('@').next().unwrap_or("");
    let host = if let Some(h) = host.strip_prefix('[') {
        h.split(']').next().unwrap_or("")
    } else {
        host.split(':').next().unwrap_or("")
    };
    matches!(host, "localhost" | "127.0.0.1" | "::1")
}

async fn download(url: &str, cap: usize) -> Result<Vec<u8>, String> {
    if !url_allowed(url) {
        return Err("The store address must start with https:// (http:// is only allowed for localhost)".into());
    }
    let client = reqwest::Client::builder()
        .user_agent(concat!("music-tag-cleaner/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(url).send().await.map_err(|e| format!("Could not reach the store: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("The store returned HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("Download failed: {e}"))?;
    if bytes.len() > cap {
        return Err(format!("The download is larger than {} KB", cap / 1024));
    }
    Ok(bytes.to_vec())
}

fn read_zip_text<R: Read + Seek>(zip: &mut zip::ZipArchive<R>, name: &str) -> Result<Option<String>, String> {
    let f = match zip.by_name(name) {
        Ok(f) => f,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let mut buf = String::new();
    // `take` bounds the *decompressed* size, so a bomb stops at the cap.
    f.take(MAX_FILE_BYTES + 1).read_to_string(&mut buf).map_err(|e| format!("Bad file in package: {e}"))?;
    if buf.len() as u64 > MAX_FILE_BYTES {
        return Err(format!("{name} is larger than {} KB", MAX_FILE_BYTES / 1024));
    }
    Ok(Some(buf))
}

/// Unpacks a verified zip. The files may sit at the root or under one folder
/// (what "zip the plugin folder" produces); only `manifest.json` and the
/// entry script it names are read.
pub fn extract_package(bytes: &[u8]) -> Result<StorePackage, String> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| format!("Not a valid zip: {e}"))?;
    if zip.len() > 200 {
        return Err("The package has too many files".into());
    }
    // Locate manifest.json: at the root, or inside exactly one top-level folder.
    let mut prefix = String::new();
    let mut found = false;
    for i in 0..zip.len() {
        let name = zip.by_index(i).map_err(|e| e.to_string())?.name().replace('\\', "/");
        if name.split('/').any(|p| p == "..") || name.starts_with('/') {
            return Err(format!("The package contains an unsafe path: {name}"));
        }
        if name == "manifest.json" {
            prefix.clear();
            found = true;
            break;
        }
        if let Some(dir) = name.strip_suffix("/manifest.json") {
            if !dir.contains('/') && !found {
                prefix = format!("{dir}/");
                found = true;
            }
        }
    }
    if !found {
        return Err("The package has no manifest.json".into());
    }
    let manifest = read_zip_text(&mut zip, &format!("{prefix}manifest.json"))?
        .ok_or_else(|| "The package has no manifest.json".to_string())?;
    let v: serde_json::Value = serde_json::from_str(&manifest).map_err(|e| format!("manifest.json is not valid JSON: {e}"))?;
    let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
    if !valid_id(&id) {
        return Err(format!("Bad plugin id \"{id}\" in the package"));
    }
    let code = match v.get("entry").and_then(|x| x.as_str()) {
        None => None,
        Some(e) if valid_entry(e) => Some(
            read_zip_text(&mut zip, &format!("{prefix}{e}"))?
                .ok_or_else(|| format!("The package is missing its entry file {e}"))?,
        ),
        Some(e) => return Err(format!("Bad entry file name \"{e}\"")),
    };
    Ok(StorePackage { id, manifest, code })
}

pub fn verify_and_extract(bytes: &[u8], expected_sha256: &str) -> Result<StorePackage, String> {
    let got = sha256_hex(bytes);
    if !got.eq_ignore_ascii_case(expected_sha256.trim()) {
        return Err(format!(
            "Checksum mismatch: the download does not match the store index (expected {}, got {}). Not installed.",
            expected_sha256.trim(),
            got
        ));
    }
    extract_package(bytes)
}

/// The store's index.json as text; the frontend validates and parses it.
#[tauri::command]
pub async fn plugin_store_index(url: String) -> Result<String, String> {
    let bytes = download(url.trim(), MAX_INDEX_BYTES).await?;
    String::from_utf8(bytes).map_err(|_| "The store index is not valid text".to_string())
}

/// Downloads a plugin zip, checks it against the index's SHA-256 and unpacks
/// it in memory. Nothing is installed; the caller stages it for review.
#[tauri::command]
pub async fn plugin_store_package(url: String, sha256: String) -> Result<StorePackage, String> {
    let bytes = download(url.trim(), MAX_ZIP_BYTES).await?;
    tauri::async_runtime::spawn_blocking(move || verify_and_extract(&bytes, &sha256))
        .await
        .map_err(|_| "Unpacking the package failed unexpectedly".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::{SimpleFileOptions, ZipWriter};

    fn make_zip(files: &[(&str, &str)]) -> Vec<u8> {
        let mut w = ZipWriter::new(std::io::Cursor::new(Vec::new()));
        for (name, body) in files {
            w.start_file(*name, SimpleFileOptions::default()).unwrap();
            w.write_all(body.as_bytes()).unwrap();
        }
        w.finish().unwrap().into_inner()
    }

    const MANIFEST: &str = r#"{"id":"demo-store","name":"Demo","entry":"index.js"}"#;

    #[test]
    fn sha256_matches_known_vector() {
        assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn verifies_and_extracts_root_and_folder_layouts() {
        for z in [
            make_zip(&[("manifest.json", MANIFEST), ("index.js", "// hi")]),
            make_zip(&[("demo-store/manifest.json", MANIFEST), ("demo-store/index.js", "// hi")]),
        ] {
            let sha = sha256_hex(&z);
            let p = verify_and_extract(&z, &sha.to_uppercase()).unwrap();
            assert_eq!(p.id, "demo-store");
            assert_eq!(p.code.as_deref(), Some("// hi"));
        }
    }

    #[test]
    fn wrong_checksum_is_refused_before_unpacking() {
        let z = make_zip(&[("manifest.json", MANIFEST), ("index.js", "x")]);
        let err = verify_and_extract(&z, &"0".repeat(64)).unwrap_err();
        assert!(err.contains("Checksum mismatch"), "{err}");
        // A tampered archive no longer matches the index's hash.
        let sha = sha256_hex(&z);
        let mut t = z.clone();
        let n = t.len() / 2;
        t[n] ^= 0xff;
        assert!(verify_and_extract(&t, &sha).is_err());
    }

    #[test]
    fn declarative_package_needs_no_script() {
        let z = make_zip(&[("manifest.json", r#"{"id":"theme-one"}"#)]);
        let p = extract_package(&z).unwrap();
        assert_eq!(p.code, None);
    }

    #[test]
    fn hostile_packages_are_refused() {
        assert!(extract_package(b"not a zip").is_err());
        assert!(extract_package(&make_zip(&[("readme.txt", "x")])).unwrap_err().contains("no manifest"));
        assert!(extract_package(&make_zip(&[("manifest.json", r#"{"id":"../evil"}"#)])).is_err());
        assert!(extract_package(&make_zip(&[("manifest.json", r#"{"id":"okay","entry":"../x.js"}"#)])).is_err());
        assert!(extract_package(&make_zip(&[("manifest.json", r#"{"id":"okay","entry":"index.js"}"#)]))
            .unwrap_err()
            .contains("missing its entry"));
        assert!(extract_package(&make_zip(&[("manifest.json", MANIFEST), ("../x", "y")])).is_err());
        let big = "x".repeat(600 * 1024);
        assert!(extract_package(&make_zip(&[("manifest.json", MANIFEST), ("index.js", &big)])).is_err());
    }

    #[test]
    fn only_https_or_loopback_http_urls() {
        assert!(url_allowed("https://example.com/index.json"));
        assert!(url_allowed("http://127.0.0.1:8080/index.json"));
        assert!(url_allowed("http://localhost/x"));
        assert!(!url_allowed("http://example.com/index.json"));
        assert!(!url_allowed("http://localhost.evil.com/x"));
        assert!(!url_allowed("http://evil.com@127.0.0.1.evil.com/"));
        assert!(!url_allowed("file:///c:/x.zip"));
        assert!(!url_allowed("ftp://example.com/x"));
    }

    /// End to end against a loopback server (no real network): index, a good
    /// package, a package whose bytes differ from the advertised hash.
    #[test]
    fn download_install_flow_against_a_local_fixture_store() {
        // reqwest is built with `rustls-no-provider`; main() installs ring, tests must too.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let good = make_zip(&[("manifest.json", MANIFEST), ("index.js", "// hi")]);
        let good_sha = sha256_hex(&good);
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let index = format!(
            r#"{{"plugins":[{{"id":"demo-store","sha256":"{good_sha}","url":"http://127.0.0.1:{port}/demo.zip"}}]}}"#
        );
        let zip_for_thread = good.clone();
        let handle = std::thread::spawn(move || {
            for _ in 0..3 {
                let Ok(req) = server.recv() else { return };
                let body = match req.url() {
                    "/index.json" => index.clone().into_bytes(),
                    "/demo.zip" => zip_for_thread.clone(),
                    _ => b"nope".to_vec(),
                };
                let _ = req.respond(tiny_http::Response::from_data(body));
            }
        });
        let base = format!("http://127.0.0.1:{port}");
        let idx = tauri::async_runtime::block_on(plugin_store_index(format!("{base}/index.json"))).unwrap();
        assert!(idx.contains("demo-store"));
        let pkg = tauri::async_runtime::block_on(plugin_store_package(format!("{base}/demo.zip"), good_sha)).unwrap();
        assert_eq!(pkg.id, "demo-store");
        let bad = tauri::async_runtime::block_on(plugin_store_package(format!("{base}/demo.zip"), "ab".repeat(32)));
        assert!(bad.unwrap_err().contains("Checksum mismatch"));
        handle.join().unwrap();
    }
}
