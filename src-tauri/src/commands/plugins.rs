//! Plugin storage (D2): `<appData>/plugins/<id>/{manifest.json, <entry>}`.
//!
//! Rust only stores, lists and removes plugin files. Parsing the manifest,
//! the permission model and running the code all happen in the frontend
//! (`src/plugins/`), where plugin code runs in a sandboxed iframe + Worker.
//! The one rule enforced here as well is path safety: a plugin id and entry
//! name come from untrusted JSON (a store package or an AI), so they are
//! checked before they ever become a path component.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// Largest manifest / plugin script we will read or write. A button plugin is
/// a few hundred bytes; anything near this limit is not a button.
const MAX_FILE_BYTES: u64 = 512 * 1024;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPlugin {
    pub id: String,
    /// Raw manifest.json text (validated by the frontend).
    pub manifest: String,
    /// Contents of the entry script, if the manifest names one and it exists.
    pub code: Option<String>,
}

/// Lowercase letters, digits and single hyphens; 2-40 chars; starts with a
/// letter. Becomes a folder name and an action-id segment, so keep it strict.
pub fn valid_id(id: &str) -> bool {
    let b = id.as_bytes();
    if b.len() < 2 || b.len() > 40 || !b[0].is_ascii_lowercase() {
        return false;
    }
    if id.ends_with('-') || id.contains("--") {
        return false;
    }
    b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// A bare `*.js` file name: no separators, no dots-only, no drive letters.
pub fn valid_entry(name: &str) -> bool {
    if name.is_empty() || name.len() > 64 || !name.ends_with(".js") {
        return false;
    }
    name.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
        && !name.starts_with('.')
        && !name.contains("..")
}

fn plugins_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("plugins");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn read_capped(path: &Path) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_FILE_BYTES {
        return Err(format!("{} is larger than {} KB", path.display(), MAX_FILE_BYTES / 1024));
    }
    std::fs::read_to_string(path).map_err(|e| e.to_string())
}

/// Entry file named by the manifest JSON (`entry`), or none for declarative plugins.
fn entry_of(manifest: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(manifest).ok()?;
    v.get("entry")?.as_str().map(|s| s.to_string())
}

pub fn list_in(root: &Path) -> Vec<InstalledPlugin> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(root) else { return out };
    for entry in rd.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let Some(id) = dir.file_name().and_then(|n| n.to_str()).map(|s| s.to_string()) else { continue };
        if !valid_id(&id) {
            continue;
        }
        let Ok(manifest) = read_capped(&dir.join("manifest.json")) else { continue };
        let code = entry_of(&manifest)
            .filter(|e| valid_entry(e))
            .and_then(|e| read_capped(&dir.join(e)).ok());
        out.push(InstalledPlugin { id, manifest, code });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

pub fn write_in(root: &Path, id: &str, manifest: &str, code: Option<&str>) -> Result<(), String> {
    if !valid_id(id) {
        return Err(format!("Bad plugin id \"{id}\" (lowercase letters, digits and hyphens)"));
    }
    if manifest.len() as u64 > MAX_FILE_BYTES || code.map_or(0, |c| c.len() as u64) > MAX_FILE_BYTES {
        return Err("Plugin files are limited to 512 KB".into());
    }
    let declared = entry_of(manifest);
    if let Some(e) = &declared {
        if !valid_entry(e) {
            return Err(format!("Bad entry file name \"{e}\""));
        }
    }
    let dir = root.join(id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // Drop scripts of a previous version so the folder holds exactly what was approved.
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for f in rd.flatten() {
            let name = f.file_name().to_string_lossy().to_string();
            if name.ends_with(".js") && declared.as_deref() != Some(name.as_str()) {
                let _ = std::fs::remove_file(f.path());
            }
        }
    }
    std::fs::write(dir.join("manifest.json"), manifest).map_err(|e| e.to_string())?;
    if let (Some(e), Some(c)) = (declared, code) {
        std::fs::write(dir.join(e), c).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn remove_in(root: &Path, id: &str) -> Result<(), String> {
    if !valid_id(id) {
        return Err(format!("Bad plugin id \"{id}\""));
    }
    let dir = root.join(id);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn plugins_dir(app: AppHandle) -> Result<String, String> {
    Ok(plugins_root(&app)?.to_string_lossy().to_string())
}

#[tauri::command]
pub fn plugins_list(app: AppHandle) -> Result<Vec<InstalledPlugin>, String> {
    Ok(list_in(&plugins_root(&app)?))
}

#[tauri::command]
pub fn plugins_write(app: AppHandle, id: String, manifest: String, code: Option<String>) -> Result<(), String> {
    write_in(&plugins_root(&app)?, &id, &manifest, code.as_deref())
}

#[tauri::command]
pub fn plugins_remove(app: AppHandle, id: String) -> Result<(), String> {
    remove_in(&plugins_root(&app)?, &id)
}

#[derive(Serialize)]
pub struct HttpReply {
    pub status: u16,
    pub ok: bool,
    pub body: String,
}

/// HTTP for a plugin's `mtc.fetch`. The frontend has already checked the URL
/// against the plugin's `network:<host>` grants; this only refuses anything that
/// is not plain http(s), bounds time and size, and does not follow redirects
/// (a redirect could leave the granted host).
#[tauri::command]
pub async fn plugins_http(
    url: String,
    method: Option<String>,
    headers: Option<std::collections::HashMap<String, String>>,
    body: Option<String>,
) -> Result<HttpReply, String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Only http(s) addresses are allowed".into());
    }
    let client = reqwest::Client::builder()
        .user_agent(concat!("music-tag-cleaner-plugin/", env!("CARGO_PKG_VERSION")))
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = match method.as_deref().unwrap_or("GET").to_ascii_uppercase().as_str() {
        "GET" => client.get(&url),
        "POST" => client.post(&url),
        other => return Err(format!("Method {other} is not allowed")),
    };
    for (k, v) in headers.unwrap_or_default().into_iter().take(20) {
        req = req.header(k, v);
    }
    if let Some(b) = body {
        req = req.body(b);
    }
    let resp = req.send().await.map_err(|e| format!("Request failed: {e}"))?;
    let status = resp.status();
    let bytes = resp.bytes().await.map_err(|e| format!("Request failed: {e}"))?;
    let slice = &bytes[..bytes.len().min(1_000_000)];
    Ok(HttpReply { status: status.as_u16(), ok: status.is_success(), body: String::from_utf8_lossy(slice).to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("mtc-plugins-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn ids_and_entries_are_path_safe() {
        assert!(valid_id("hide-genre"));
        assert!(valid_id("a1"));
        for bad in ["", "a", "../x", "A-b", "a/b", "a\\b", "a--b", "a-", "1abc", "a b", &"a".repeat(41)] {
            assert!(!valid_id(bad), "{bad}");
        }
        assert!(valid_entry("index.js"));
        assert!(valid_entry("main-2.js"));
        for bad in ["", "index", "../index.js", "a/b.js", "..js", ".hidden.js", "a..b.js", "c:index.js", "x.ts"] {
            assert!(!valid_entry(bad), "{bad}");
        }
    }

    #[test]
    fn write_list_remove_roundtrip() {
        let root = tmp("rt");
        let m = r#"{"id":"demo-one","entry":"index.js"}"#;
        write_in(&root, "demo-one", m, Some("// code")).unwrap();
        let l = list_in(&root);
        assert_eq!(l.len(), 1);
        assert_eq!(l[0].id, "demo-one");
        assert_eq!(l[0].code.as_deref(), Some("// code"));
        // A declarative plugin has no script.
        write_in(&root, "decl", r#"{"id":"decl"}"#, None).unwrap();
        assert_eq!(list_in(&root).iter().find(|p| p.id == "decl").unwrap().code, None);
        remove_in(&root, "demo-one").unwrap();
        assert_eq!(list_in(&root).len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn update_drops_the_old_script() {
        let root = tmp("upd");
        write_in(&root, "demo-two", r#"{"entry":"a.js"}"#, Some("1")).unwrap();
        write_in(&root, "demo-two", r#"{"entry":"b.js"}"#, Some("2")).unwrap();
        assert!(!root.join("demo-two").join("a.js").exists());
        assert!(root.join("demo-two").join("b.js").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn hostile_input_is_refused() {
        let root = tmp("bad");
        assert!(write_in(&root, "../evil", "{}", None).is_err());
        assert!(write_in(&root, "okay", r#"{"entry":"../../x.js"}"#, Some("x")).is_err());
        assert!(remove_in(&root, "..").is_err());
        let big = "x".repeat(600 * 1024);
        assert!(write_in(&root, "okay", "{}", Some(&big)).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}
