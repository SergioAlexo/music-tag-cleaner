//! Downloadable engines (heavy helper programs the host manages, such as the
//! presetforge preset converter). The compiled-in index (`engines.json`) is the
//! only place a download URL can come from; callers pass an engine id, never a
//! URL. Binaries live in `<app data>/engines/<id>/<version>/`.
//!
//! This module also owns the engine process plumbing (`engine_command`,
//! `run_engine`) shared with `presets.rs`: JSON lines on stdout, free text on
//! stderr.

use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

use super::download::{client, download_to_file};
use super::plugin_store::url_allowed;

const INDEX_JSON: &str = include_str!("../../engines.json");

/// Env override for development: an executable or a `.cmd`/`.bat` path.
const OVERRIDE_ENV: &str = "MTC_PRESETFORGE";

const MAX_ENTRIES: usize = 20_000;
const MAX_TOTAL_BYTES: u64 = 3 * 1024 * 1024 * 1024;

#[derive(Deserialize, Clone, Debug)]
pub struct IndexEntry {
    pub id: String,
    pub version: String,
    pub url: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Available {
    pub version: String,
    pub size: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub dev_override: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub available: Option<Available>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub id: String,
    pub version: String,
    pub path: String,
}

fn index() -> Vec<IndexEntry> {
    serde_json::from_str(INDEX_JSON).unwrap_or_default()
}

pub(crate) fn app_data(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

fn engines_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data(app)?.join("engines"))
}

fn valid_engine_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 48
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// "1.2.10" -> [1, 2, 10]. Anything non-numeric in a part counts as 0.
pub(crate) fn parse_version(v: &str) -> Vec<u64> {
    v.split('.')
        .map(|p| p.trim().parse::<u64>().unwrap_or(0))
        .collect()
}

fn exe_name(id: &str) -> String {
    if cfg!(windows) {
        format!("{id}.exe")
    } else {
        id.to_string()
    }
}

/// The highest installed version of `id` under `root/<id>/`, with its exe.
fn find_installed(root: &Path, id: &str) -> Option<(String, PathBuf)> {
    let dir = root.join(id);
    let mut best: Option<(Vec<u64>, String, PathBuf)> = None;
    for entry in fs::read_dir(&dir).ok()?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name.ends_with(".tmp") {
            continue;
        }
        let exe = entry.path().join(exe_name(id));
        if !exe.is_file() {
            continue;
        }
        let ver = parse_version(&name);
        let better = match &best {
            Some((b, _, _)) => ver > *b,
            None => true,
        };
        if better {
            best = Some((ver, name, exe));
        }
    }
    best.map(|(_, name, exe)| (name, exe))
}

fn override_path() -> Option<PathBuf> {
    let v = std::env::var(OVERRIDE_ENV).ok()?;
    let v = v.trim();
    if v.is_empty() {
        return None;
    }
    Some(PathBuf::from(v))
}

/// Resolves the presetforge executable (dev override first, then the newest
/// installed version).
pub(crate) fn presetforge_exe(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(p) = override_path() {
        return Ok(p);
    }
    let root = engines_root(app)?;
    match find_installed(&root, "presetforge") {
        Some((_, exe)) => Ok(exe),
        None => Err("The presetforge engine is not installed".to_string()),
    }
}

fn status_for(root: &Path, id: &str, idx: &[IndexEntry]) -> EngineStatus {
    let dev = if id == "presetforge" {
        override_path()
    } else {
        None
    };
    let installed = find_installed(root, id);
    let available = idx
        .iter()
        .filter(|e| e.id == id)
        .max_by_key(|e| parse_version(&e.version))
        .map(|e| Available {
            version: e.version.clone(),
            size: e.size,
        });
    let path = match (&dev, &installed) {
        (Some(p), _) => Some(p.to_string_lossy().to_string()),
        (None, Some((_, p))) => Some(p.to_string_lossy().to_string()),
        _ => None,
    };
    EngineStatus {
        id: id.to_string(),
        installed_version: installed.as_ref().map(|(v, _)| v.clone()),
        path,
        dev_override: dev.is_some(),
        available,
    }
}

#[tauri::command]
pub async fn engines_status(app: AppHandle) -> Result<Vec<EngineStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = engines_root(&app)?;
        let idx = index();
        let mut ids: Vec<String> = vec!["presetforge".to_string()];
        for e in &idx {
            if !ids.contains(&e.id) {
                ids.push(e.id.clone());
            }
        }
        if let Ok(rd) = fs::read_dir(&root) {
            for d in rd.flatten() {
                let name = d.file_name().to_string_lossy().to_string();
                if valid_engine_id(&name) && !ids.contains(&name) {
                    ids.push(name);
                }
            }
        }
        let out: Vec<EngineStatus> = ids.iter().map(|id| status_for(&root, id, &idx)).collect();
        Ok::<Vec<EngineStatus>, String>(out)
    })
    .await
    .map_err(|_| "Reading engine status failed unexpectedly".to_string())?
}

fn emit_progress(app: &AppHandle, id: &str, phase: &str, downloaded: u64, total: u64) {
    let _ = app.emit(
        "engine-progress",
        json!({ "id": id, "phase": phase, "downloaded": downloaded, "total": total }),
    );
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut f = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// True for an entry name that must never be extracted.
fn unsafe_entry_name(name: &str) -> bool {
    let n = name.replace('\\', "/");
    if n.is_empty() || n.starts_with('/') || n.contains(':') {
        return true;
    }
    n.split('/').any(|p| p == "..")
}

/// Unpacks an engine zip into `dest`. Unlike the plugin extractor this allows
/// binaries and large files, but it refuses `..`, absolute paths, drive
/// letters and symlinks, and caps the entry count and total size.
pub(crate) fn extract_engine_zip(zip_path: &Path, dest: &Path) -> Result<(), String> {
    let file = fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("Not a valid zip: {e}"))?;
    if zip.len() > MAX_ENTRIES {
        return Err("The engine package has too many files".to_string());
    }
    // Check every entry before writing anything.
    for i in 0..zip.len() {
        let entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();
        if unsafe_entry_name(&name) {
            return Err(format!(
                "The engine package contains an unsafe path: {name}"
            ));
        }
        if let Some(mode) = entry.unix_mode() {
            if mode & 0o170000 == 0o120000 {
                return Err(format!("The engine package contains a symlink: {name}"));
            }
        }
    }
    fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let mut total: u64 = 0;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let rel = entry.name().replace('\\', "/");
        let is_dir = entry.is_dir() || rel.ends_with('/');
        let out = dest.join(rel.trim_end_matches('/'));
        if is_dir {
            fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let remaining = MAX_TOTAL_BYTES.saturating_sub(total);
        let mut w = fs::File::create(&out)
            .map_err(|e| format!("Could not write {}: {e}", out.display()))?;
        // `take` bounds the decompressed size, so a bomb stops at the cap.
        let mut limited = entry.by_ref().take(remaining + 1);
        let copied = std::io::copy(&mut limited, &mut w).map_err(|e| e.to_string())?;
        total += copied;
        if total > MAX_TOTAL_BYTES {
            return Err("The engine package is larger than expected".to_string());
        }
    }
    Ok(())
}

fn install_blocking(
    app: &AppHandle,
    zip_path: &Path,
    entry: &IndexEntry,
    root: &Path,
) -> Result<InstallResult, String> {
    emit_progress(app, &entry.id, "verifying", 0, 0);
    let size = fs::metadata(zip_path).map_err(|e| e.to_string())?.len();
    if entry.size > 0 && size != entry.size {
        return Err(format!(
            "The download has the wrong size ({size} bytes, expected {}). Not installed.",
            entry.size
        ));
    }
    let got = sha256_file(zip_path)?;
    if !got.eq_ignore_ascii_case(entry.sha256.trim()) {
        return Err(
            "Checksum mismatch: the download does not match the engine index. Not installed."
                .to_string(),
        );
    }
    emit_progress(app, &entry.id, "unpacking", 0, 0);
    let engine_dir = root.join(&entry.id);
    let tmp = engine_dir.join(format!("{}.tmp", entry.version));
    let fin = engine_dir.join(&entry.version);
    let _ = fs::remove_dir_all(&tmp);
    if let Err(e) = extract_engine_zip(zip_path, &tmp) {
        let _ = fs::remove_dir_all(&tmp);
        return Err(e);
    }
    if !tmp.join(exe_name(&entry.id)).is_file() {
        let _ = fs::remove_dir_all(&tmp);
        return Err(format!(
            "The package does not contain {}",
            exe_name(&entry.id)
        ));
    }
    let _ = fs::remove_dir_all(&fin);
    fs::rename(&tmp, &fin).map_err(|e| format!("Could not install the engine: {e}"))?;
    Ok(InstallResult {
        id: entry.id.clone(),
        version: entry.version.clone(),
        path: fin.join(exe_name(&entry.id)).to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub async fn engine_install(app: AppHandle, id: String) -> Result<InstallResult, String> {
    if !valid_engine_id(&id) {
        return Err("Bad engine id".to_string());
    }
    let entry = index()
        .into_iter()
        .filter(|e| e.id == id)
        .max_by_key(|e| parse_version(&e.version))
        .ok_or_else(|| format!("No download is available for the {id} engine yet"))?;
    if !url_allowed(&entry.url) {
        return Err("The engine address must start with https://".to_string());
    }
    if !valid_engine_id(&entry.version.replace('.', "-")) {
        return Err("Bad engine version in the index".to_string());
    }
    let root = engines_root(&app)?;
    let engine_dir = root.join(&entry.id);
    fs::create_dir_all(&engine_dir).map_err(|e| e.to_string())?;
    let zip_path = engine_dir.join(format!("download-{}.zip", entry.version));

    emit_progress(&app, &id, "downloading", 0, entry.size);
    let http = client()?;
    let app2 = app.clone();
    let id2 = id.clone();
    let dl = download_to_file(&http, &entry.url, &zip_path, move |d, t| {
        emit_progress(&app2, &id2, "downloading", d, t);
    })
    .await;
    if let Err(e) = dl {
        let _ = fs::remove_file(&zip_path);
        return Err(e);
    }

    let app3 = app.clone();
    let zip2 = zip_path.clone();
    let joined =
        tauri::async_runtime::spawn_blocking(move || install_blocking(&app3, &zip2, &entry, &root))
            .await;
    let _ = fs::remove_file(&zip_path);
    let result = joined.map_err(|_| "Installing the engine failed unexpectedly".to_string())??;
    emit_progress(&app, &id, "done", 0, 0);
    Ok(result)
}

// ---------------------------------------------------------------------------
// Running an engine: JSON lines on stdout.

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum EngineLine {
    Progress { done: u64, total: u64, file: String },
    Warning(String),
    Result(Value),
    Error(String),
    Ignored,
}

/// Parses one stdout line. Anything that is not a known JSON event (blank
/// lines, stray prints, malformed JSON) is `Ignored`.
pub(crate) fn parse_line(line: &str) -> EngineLine {
    let line = line.trim();
    if !line.starts_with('{') {
        return EngineLine::Ignored;
    }
    let v: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return EngineLine::Ignored,
    };
    match v.get("event").and_then(|e| e.as_str()) {
        Some("progress") => EngineLine::Progress {
            done: v.get("done").and_then(|x| x.as_u64()).unwrap_or(0),
            total: v.get("total").and_then(|x| x.as_u64()).unwrap_or(0),
            file: v
                .get("file")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
        },
        Some("warning") => EngineLine::Warning(
            v.get("message")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
        ),
        Some("result") => EngineLine::Result(v.get("data").cloned().unwrap_or(Value::Null)),
        Some("error") => EngineLine::Error(
            v.get("message")
                .and_then(|x| x.as_str())
                .unwrap_or("Engine error")
                .to_string(),
        ),
        _ => EngineLine::Ignored,
    }
}

/// Builds the process for an engine. `.cmd`/`.bat` files (the dev override)
/// go through `cmd /C`. No console window on Windows.
pub(crate) fn engine_command(exe: &Path) -> Command {
    let is_script = exe
        .extension()
        .map(|e| {
            let e = e.to_string_lossy().to_lowercase();
            e == "cmd" || e == "bat"
        })
        .unwrap_or(false);
    let mut cmd = if is_script {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(exe);
        c
    } else {
        Command::new(exe)
    };
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.env("PYTHONUNBUFFERED", "1")
        .env("PYTHONIOENCODING", "utf-8");
    cmd
}

/// Runs an engine command, calling `on_progress(done, total, file)` for each
/// progress line, and returns the `data` of the `result` line.
/// Blocking: call it from `spawn_blocking`.
pub(crate) fn run_engine(
    exe: &Path,
    args: &[String],
    mut on_progress: impl FnMut(u64, u64, &str),
) -> Result<Value, String> {
    let mut cmd = engine_command(exe);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Could not start the presetforge engine: {e}"))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // Drain stderr on its own thread so a chatty engine can't fill the pipe.
    let err_thread = std::thread::spawn(move || {
        let mut tail: Vec<String> = Vec::new();
        if let Some(e) = stderr {
            for line in BufReader::new(e).split(b'\n').map_while(Result::ok) {
                let text = String::from_utf8_lossy(&line).trim().to_string();
                if text.is_empty() {
                    continue;
                }
                tail.push(text);
                if tail.len() > 20 {
                    tail.remove(0);
                }
            }
        }
        tail
    });

    let mut result: Option<Value> = None;
    let mut error: Option<String> = None;
    if let Some(out) = stdout {
        for line in BufReader::new(out).split(b'\n').map_while(Result::ok) {
            let text = String::from_utf8_lossy(&line).to_string();
            match parse_line(&text) {
                EngineLine::Progress { done, total, file } => on_progress(done, total, &file),
                EngineLine::Result(v) => result = Some(v),
                EngineLine::Error(m) => error = Some(m),
                EngineLine::Warning(_) | EngineLine::Ignored => {}
            }
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    let tail = err_thread.join().unwrap_or_default();

    if let Some(m) = error {
        return Err(m);
    }
    match result {
        Some(v) => Ok(v),
        None => {
            let detail = tail
                .last()
                .cloned()
                .unwrap_or_else(|| format!("exited with {status}"));
            Err(format!("The presetforge engine failed: {detail}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::{SimpleFileOptions, ZipWriter};

    pub(crate) fn temp_dir(tag: &str) -> PathBuf {
        let mut b = [0u8; 4];
        getrandom::fill(&mut b).unwrap();
        let p = std::env::temp_dir().join(format!(
            "mtc-engines-{tag}-{:02x}{:02x}{:02x}{:02x}",
            b[0], b[1], b[2], b[3]
        ));
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn write_zip(path: &Path, files: &[(&str, &[u8])]) {
        let mut w = ZipWriter::new(fs::File::create(path).unwrap());
        for (name, body) in files {
            w.start_file(*name, SimpleFileOptions::default()).unwrap();
            w.write_all(body).unwrap();
        }
        w.finish().unwrap();
    }

    #[test]
    fn parses_progress_result_error_and_garbage() {
        assert_eq!(
            parse_line(r#"{"event":"progress","done":3,"total":10,"file":"a.fxp"}"#),
            EngineLine::Progress {
                done: 3,
                total: 10,
                file: "a.fxp".into()
            }
        );
        assert_eq!(
            parse_line(r#"{"event":"warning","message":"hm"}"#),
            EngineLine::Warning("hm".into())
        );
        assert_eq!(
            parse_line(r#"{"event":"result","data":{"items":[]}}"#),
            EngineLine::Result(json!({"items": []}))
        );
        assert_eq!(
            parse_line(r#"{"event":"error","message":"boom"}"#),
            EngineLine::Error("boom".into())
        );
        assert_eq!(parse_line("hello world"), EngineLine::Ignored);
        assert_eq!(parse_line(""), EngineLine::Ignored);
        assert_eq!(parse_line("{not json"), EngineLine::Ignored);
        assert_eq!(parse_line(r#"{"event":"mystery"}"#), EngineLine::Ignored);
    }

    #[test]
    fn versions_compare_numerically() {
        assert!(parse_version("0.10.0") > parse_version("0.9.5"));
        assert!(parse_version("1.0") < parse_version("1.0.1"));
    }

    #[test]
    fn the_compiled_in_index_parses() {
        assert!(serde_json::from_str::<Vec<IndexEntry>>(INDEX_JSON).is_ok());
    }

    #[test]
    fn extractor_unpacks_normal_files() {
        let dir = temp_dir("ok");
        let z = dir.join("e.zip");
        write_zip(&z, &[("presetforge.exe", b"MZ"), ("lib/data.bin", b"1234")]);
        let out = dir.join("out");
        extract_engine_zip(&z, &out).unwrap();
        assert_eq!(fs::read(out.join("lib").join("data.bin")).unwrap(), b"1234");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn extractor_refuses_parent_absolute_and_drive_paths() {
        for bad in [
            "../evil.txt",
            "a/../../evil.txt",
            "/etc/evil",
            "C:/evil.txt",
            "..\\evil.txt",
        ] {
            let dir = temp_dir("bad");
            let z = dir.join("e.zip");
            write_zip(&z, &[("ok.txt", b"x"), (bad, b"x")]);
            let out = dir.join("out");
            assert!(
                extract_engine_zip(&z, &out).is_err(),
                "{bad} should be refused"
            );
            // Nothing is written when any entry is unsafe.
            assert!(!out.join("ok.txt").exists());
            let _ = fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn extractor_refuses_symlinks() {
        let dir = temp_dir("sym");
        let z = dir.join("e.zip");
        let mut w = ZipWriter::new(fs::File::create(&z).unwrap());
        w.add_symlink("link", "/etc/passwd", SimpleFileOptions::default())
            .unwrap();
        w.finish().unwrap();
        assert!(extract_engine_zip(&z, &dir.join("out")).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn finds_the_highest_installed_version() {
        let root = temp_dir("ver");
        for v in ["0.9.0", "0.10.0"] {
            let d = root.join("presetforge").join(v);
            fs::create_dir_all(&d).unwrap();
            fs::write(d.join(exe_name("presetforge")), b"x").unwrap();
        }
        fs::create_dir_all(root.join("presetforge").join("0.11.0.tmp")).unwrap();
        let (v, _) = find_installed(&root, "presetforge").unwrap();
        assert_eq!(v, "0.10.0");
        let _ = fs::remove_dir_all(&root);
    }
}
