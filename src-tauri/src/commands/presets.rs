//! Preset Translator host side: runs the presetforge engine
//! (`commands/engines.rs`) and enforces the write rules.
//!
//! Conversions are staged in `<app data>/presets-staging/<batchId>/`; nothing
//! reaches the person's output folder until `presets_apply`, which only copies
//! files from that batch's staging folder, never overwrites, and never writes
//! outside the chosen folder. These rules live here, not in the caller.

use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use super::engines::{app_data, presetforge_exe, run_engine};

const REPORT_FILE: &str = "_report.json";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ScanItem {
    pub path: String,
    pub synth: String,
    pub name: String,
    pub supported: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Note {
    pub field: String,
    #[serde(default)]
    pub note: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Report {
    #[serde(default)]
    pub exact: u64,
    #[serde(default)]
    pub approximated: Vec<Note>,
    #[serde(default)]
    pub dropped: Vec<Note>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ConvertItem {
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default)]
    pub report: Report,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VerifyItem {
    pub file: String,
    pub loaded: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub peak_db: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rms_db: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub silent: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clips: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nan: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BatchReport {
    pub batch_id: String,
    pub items: Vec<ConvertItem>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Skipped {
    pub source: String,
    pub reason: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ApplyResult {
    pub written: Vec<String>,
    pub skipped: Vec<Skipped>,
}

// ---------------------------------------------------------------------------
// Batch ids and folders

/// `YYYYMMDDHHMMSS-xxxxxxxx` (UTC timestamp plus 4 random bytes as hex).
fn format_batch_id(timestamp: &str, rand: [u8; 4]) -> String {
    format!(
        "{timestamp}-{:02x}{:02x}{:02x}{:02x}",
        rand[0], rand[1], rand[2], rand[3]
    )
}

fn new_batch_id() -> Result<String, String> {
    let mut r = [0u8; 4];
    getrandom::fill(&mut r).map_err(|e| format!("No random source: {e}"))?;
    let ts = chrono::Utc::now().format("%Y%m%d%H%M%S").to_string();
    Ok(format_batch_id(&ts, r))
}

fn valid_batch_id(id: &str) -> bool {
    let parts: Vec<&str> = id.split('-').collect();
    if parts.len() != 2 {
        return false;
    }
    parts[0].len() == 14
        && parts[0].chars().all(|c| c.is_ascii_digit())
        && parts[1].len() == 8
        && parts[1]
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
}

fn staging_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data(app)?.join("presets-staging"))
}

fn batch_dir(app: &AppHandle, batch_id: &str) -> Result<PathBuf, String> {
    if !valid_batch_id(batch_id) {
        return Err("Bad batch id".to_string());
    }
    Ok(staging_root(app)?.join(batch_id))
}

fn existing_batch_dir(app: &AppHandle, batch_id: &str) -> Result<PathBuf, String> {
    let dir = batch_dir(app, batch_id)?;
    if !dir.is_dir() {
        return Err("This batch no longer exists".to_string());
    }
    Ok(dir)
}

/// Paths reach the engine as arguments, so none may look like an option.
fn check_paths(paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Err("No files were given".to_string());
    }
    for p in paths {
        if p.trim().is_empty() || p.starts_with('-') {
            return Err(format!("Not a usable path: {p}"));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Engine output parsing

fn items_from<T: serde::de::DeserializeOwned>(data: &Value) -> Result<Vec<T>, String> {
    let items = data
        .get("items")
        .cloned()
        .unwrap_or(Value::Array(Vec::new()));
    serde_json::from_value(items).map_err(|e| format!("Unexpected answer from the engine: {e}"))
}

/// Marks items whose output is missing or outside `staging` as failed, so a
/// misbehaving engine can never point `apply` at some other file.
fn sanitize_outputs(items: &mut [ConvertItem], staging: &Path) {
    let canon = match staging.canonicalize() {
        Ok(c) => c,
        Err(_) => return,
    };
    for it in items.iter_mut() {
        if it.status == "failed" {
            continue;
        }
        let ok = match &it.output {
            Some(o) => match Path::new(o).canonicalize() {
                Ok(c) => c.starts_with(&canon) && c.is_file(),
                Err(_) => false,
            },
            None => false,
        };
        if !ok {
            it.status = "failed".to_string();
            it.output = None;
            if it.error.is_none() {
                it.error = Some("The engine did not produce a file".to_string());
            }
        }
    }
}

fn write_report(dir: &Path, batch_id: &str, items: &[ConvertItem]) -> Result<(), String> {
    let report = BatchReport {
        batch_id: batch_id.to_string(),
        items: items.to_vec(),
    };
    let text = serde_json::to_string(&report).map_err(|e| e.to_string())?;
    fs::write(dir.join(REPORT_FILE), text).map_err(|e| e.to_string())
}

fn read_report(dir: &Path) -> Result<BatchReport, String> {
    let text = fs::read_to_string(dir.join(REPORT_FILE))
        .map_err(|e| format!("Could not read the batch report: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("The batch report is damaged: {e}"))
}

fn emit_batch_progress(app: &AppHandle, batch_id: &str, done: u64, total: u64, file: &str) {
    let _ = app.emit(
        "presets-progress",
        json!({ "batchId": batch_id, "done": done, "total": total, "file": file }),
    );
}

// ---------------------------------------------------------------------------
// Commands

#[tauri::command]
pub async fn presets_scan(app: AppHandle, paths: Vec<String>) -> Result<Vec<ScanItem>, String> {
    check_paths(&paths)?;
    tauri::async_runtime::spawn_blocking(move || {
        let exe = presetforge_exe(&app)?;
        let mut args: Vec<String> = vec!["scan".to_string(), "--json".to_string()];
        args.extend(paths);
        let data = run_engine(&exe, &args, |_, _, _| {})?;
        items_from::<ScanItem>(&data)
    })
    .await
    .map_err(|_| "Scanning failed unexpectedly".to_string())?
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConvertResult {
    pub batch_id: String,
    pub items: Vec<ConvertItem>,
}

fn convert_blocking(
    app: &AppHandle,
    batch_id: &str,
    dir: &Path,
    paths: Vec<String>,
    serum_root: Option<String>,
    max_frames: Option<u32>,
) -> Result<Vec<ConvertItem>, String> {
    let exe = presetforge_exe(app)?;
    fs::create_dir_all(dir).map_err(|e| format!("Could not create the staging folder: {e}"))?;
    let mut args: Vec<String> = vec![
        "convert".to_string(),
        "--json".to_string(),
        "--out-dir".to_string(),
        dir.to_string_lossy().to_string(),
    ];
    if let Some(r) = serum_root {
        args.push("--serum-root".to_string());
        args.push(r);
    }
    if let Some(n) = max_frames {
        args.push("--max-frames".to_string());
        args.push(n.to_string());
    }
    args.extend(paths);
    let data = run_engine(&exe, &args, |done, total, file| {
        emit_batch_progress(app, batch_id, done, total, file);
    })?;
    let mut items = items_from::<ConvertItem>(&data)?;
    sanitize_outputs(&mut items, dir);
    write_report(dir, batch_id, &items)?;
    Ok(items)
}

#[tauri::command]
pub async fn presets_convert(
    app: AppHandle,
    paths: Vec<String>,
    serum_root: Option<String>,
    max_frames: Option<u32>,
) -> Result<ConvertResult, String> {
    check_paths(&paths)?;
    if let Some(r) = &serum_root {
        check_paths(std::slice::from_ref(r))?;
    }
    let batch_id = new_batch_id()?;
    let dir = batch_dir(&app, &batch_id)?;
    let id2 = batch_id.clone();
    let dir2 = dir.clone();
    let joined = tauri::async_runtime::spawn_blocking(move || {
        convert_blocking(&app, &id2, &dir2, paths, serum_root, max_frames)
    })
    .await;
    let outcome = joined.map_err(|_| "Converting failed unexpectedly".to_string())?;
    match outcome {
        Ok(items) => Ok(ConvertResult { batch_id, items }),
        Err(e) => {
            let _ = fs::remove_dir_all(&dir);
            Err(e)
        }
    }
}

/// The staged file of an item, if it has a usable one.
fn staged_file(staging: &Path, item: &ConvertItem) -> Option<PathBuf> {
    if item.status != "ok" && item.status != "approx" {
        return None;
    }
    let name = Path::new(item.output.as_deref()?)
        .file_name()?
        .to_os_string();
    let p = staging.join(name);
    if p.is_file() {
        Some(p)
    } else {
        None
    }
}

#[tauri::command]
pub async fn presets_verify(app: AppHandle, batch_id: String) -> Result<Vec<VerifyItem>, String> {
    let dir = existing_batch_dir(&app, &batch_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let exe = presetforge_exe(&app)?;
        let report = read_report(&dir)?;
        let files: Vec<String> = report
            .items
            .iter()
            .filter_map(|it| staged_file(&dir, it))
            .map(|p| p.to_string_lossy().to_string())
            .collect();
        if files.is_empty() {
            return Ok(Vec::new());
        }
        let mut args: Vec<String> = vec!["verify".to_string(), "--json".to_string()];
        args.extend(files);
        let data = run_engine(&exe, &args, |done, total, file| {
            emit_batch_progress(&app, &batch_id, done, total, file);
        })?;
        items_from::<VerifyItem>(&data)
    })
    .await
    .map_err(|_| "Verifying failed unexpectedly".to_string())?
}

#[tauri::command]
pub async fn presets_report(app: AppHandle, batch_id: String) -> Result<BatchReport, String> {
    let dir = existing_batch_dir(&app, &batch_id)?;
    tauri::async_runtime::spawn_blocking(move || read_report(&dir))
        .await
        .map_err(|_| "Reading the report failed unexpectedly".to_string())?
}

#[tauri::command]
pub async fn presets_discard(app: AppHandle, batch_id: String) -> Result<(), String> {
    let dir = batch_dir(&app, &batch_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        if dir.is_dir() {
            fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|_| "Discarding failed unexpectedly".to_string())?
}

/// Copies one staged file into `out_dir` under a name that does not exist
/// yet (`name.vital`, then `name (2).vital`, ...). `create_new` makes the
/// check-and-create atomic, so an existing file is never overwritten.
fn copy_without_overwrite(src: &Path, out_dir: &Path, file_name: &str) -> Result<PathBuf, String> {
    let (stem, ext) = match file_name.rfind('.') {
        Some(i) if i > 0 => (&file_name[..i], &file_name[i..]),
        _ => (file_name, ""),
    };
    let mut n: u32 = 1;
    loop {
        let name = if n == 1 {
            format!("{stem}{ext}")
        } else {
            format!("{stem} ({n}){ext}")
        };
        let target = out_dir.join(&name);
        let opened = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target);
        match opened {
            Ok(mut f) => {
                let mut input = fs::File::open(src).map_err(|e| e.to_string())?;
                let copied = std::io::copy(&mut input, &mut f).map_err(|e| e.to_string());
                if let Err(e) = copied.and_then(|_| f.flush().map_err(|e| e.to_string())) {
                    drop(f);
                    let _ = fs::remove_file(&target);
                    return Err(e);
                }
                return Ok(target);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                n += 1;
                if n > 9999 {
                    return Err("Too many files with the same name".to_string());
                }
            }
            Err(e) => return Err(format!("Could not write {}: {e}", target.display())),
        }
    }
}

/// Applies a staged batch. `include` (sources) limits which items are copied.
fn apply_batch(
    staging: &Path,
    items: &[ConvertItem],
    out_dir: &Path,
    include: Option<&[String]>,
) -> Result<ApplyResult, String> {
    if !out_dir.is_dir() {
        return Err("The output folder does not exist".to_string());
    }
    let canon_out = out_dir.canonicalize().map_err(|e| e.to_string())?;
    let canon_stage = staging.canonicalize().map_err(|e| e.to_string())?;
    if canon_out.starts_with(&canon_stage) {
        return Err("The output folder cannot be inside the staging folder".to_string());
    }
    let mut written: Vec<String> = Vec::new();
    let mut skipped: Vec<Skipped> = Vec::new();
    for it in items {
        if let Some(list) = include {
            if !list.iter().any(|s| s == &it.source) {
                continue;
            }
        }
        let Some(staged) = staged_file(&canon_stage, it) else {
            skipped.push(Skipped {
                source: it.source.clone(),
                reason: "Not converted".to_string(),
            });
            continue;
        };
        // Only files that really live in this batch's staging folder.
        let inside = staged
            .canonicalize()
            .map(|c| c.starts_with(&canon_stage))
            .unwrap_or(false);
        let name = staged
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if !inside || name.is_empty() || !name.to_lowercase().ends_with(".vital") {
            skipped.push(Skipped {
                source: it.source.clone(),
                reason: "Not a staged preset file".to_string(),
            });
            continue;
        }
        match copy_without_overwrite(&staged, &canon_out, &name) {
            Ok(target) => {
                // Belt and braces: the new file must sit directly in out_dir.
                let ok = target
                    .parent()
                    .map(|p| p == canon_out.as_path())
                    .unwrap_or(false);
                if !ok {
                    let _ = fs::remove_file(&target);
                    skipped.push(Skipped {
                        source: it.source.clone(),
                        reason: "Refused to write outside the output folder".to_string(),
                    });
                } else {
                    written.push(target.to_string_lossy().to_string());
                }
            }
            Err(e) => skipped.push(Skipped {
                source: it.source.clone(),
                reason: e,
            }),
        }
    }
    Ok(ApplyResult { written, skipped })
}

#[tauri::command]
pub async fn presets_apply(
    app: AppHandle,
    batch_id: String,
    output_dir: String,
    include: Option<Vec<String>>,
) -> Result<ApplyResult, String> {
    let dir = existing_batch_dir(&app, &batch_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let report = read_report(&dir)?;
        apply_batch(
            &dir,
            &report.items,
            Path::new(&output_dir),
            include.as_deref(),
        )
    })
    .await
    .map_err(|_| "Applying failed unexpectedly".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let mut b = [0u8; 4];
        getrandom::fill(&mut b).unwrap();
        let p = std::env::temp_dir().join(format!(
            "mtc-presets-{tag}-{:02x}{:02x}{:02x}{:02x}",
            b[0], b[1], b[2], b[3]
        ));
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn item(source: &str, output: Option<&str>, status: &str) -> ConvertItem {
        ConvertItem {
            source: source.to_string(),
            output: output.map(|s| s.to_string()),
            status: status.to_string(),
            error: None,
            report: Report::default(),
        }
    }

    #[test]
    fn batch_id_has_the_documented_shape() {
        let id = format_batch_id("20261019123000", [0xa1, 0xb2, 0x03, 0xff]);
        assert_eq!(id, "20261019123000-a1b203ff");
        assert!(valid_batch_id(&id));
        assert!(valid_batch_id(&new_batch_id().unwrap()));
        for bad in [
            "",
            "..",
            "../x",
            "20261019123000",
            "20261019123000-ZZZZZZZZ",
            "2026-a1b203ff",
            "20261019123000-a1b203ff-1",
        ] {
            assert!(!valid_batch_id(bad), "{bad}");
        }
    }

    #[test]
    fn convert_items_parse_from_engine_json() {
        let data = json!({"items": [
            {"source": "a.fxp", "output": "C:/s/a.vital", "status": "approx",
             "report": {"exact": 12, "approximated": [{"field": "osc1", "note": "close"}], "dropped": []}},
            {"source": "b.fxp", "status": "failed", "error": "bad"}
        ]});
        let items = items_from::<ConvertItem>(&data).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].report.exact, 12);
        assert_eq!(items[1].output, None);
        assert_eq!(items[1].report, Report::default());
        let v = items_from::<VerifyItem>(
            &json!({"items": [{"file": "a", "loaded": true, "peakDb": -3.5}]}),
        )
        .unwrap();
        assert_eq!(v[0].peak_db, Some(-3.5));
        assert!(items_from::<ScanItem>(&json!({"items": "nope"})).is_err());
    }

    #[test]
    fn rejects_option_like_paths() {
        assert!(check_paths(&["--out-dir".to_string()]).is_err());
        assert!(check_paths(&[]).is_err());
        assert!(check_paths(&["C:/x/a.fxp".to_string()]).is_ok());
    }

    #[test]
    fn apply_copies_and_deduplicates_names() {
        let root = temp_dir("apply");
        let stage = root.join("stage");
        let out = root.join("out");
        fs::create_dir_all(&stage).unwrap();
        fs::create_dir_all(&out).unwrap();
        fs::write(stage.join("Lead.vital"), b"new").unwrap();
        fs::write(stage.join("Pad.vital"), b"pad").unwrap();
        fs::write(out.join("Lead.vital"), b"mine").unwrap();
        let items = vec![
            item(
                "a.fxp",
                Some(stage.join("Lead.vital").to_str().unwrap()),
                "ok",
            ),
            item(
                "b.fxp",
                Some(stage.join("Pad.vital").to_str().unwrap()),
                "approx",
            ),
            item("c.fxp", None, "failed"),
        ];
        let r = apply_batch(&stage, &items, &out, None).unwrap();
        assert_eq!(r.written.len(), 2);
        assert_eq!(fs::read(out.join("Lead.vital")).unwrap(), b"mine");
        assert_eq!(fs::read(out.join("Lead (2).vital")).unwrap(), b"new");
        assert_eq!(fs::read(out.join("Pad.vital")).unwrap(), b"pad");
        assert_eq!(r.skipped.len(), 1);
        assert_eq!(r.skipped[0].source, "c.fxp");

        // Applying again never overwrites: the names move on to (2)/(3).
        let r2 = apply_batch(&stage, &items, &out, Some(&["a.fxp".to_string()])).unwrap();
        assert_eq!(r2.written.len(), 1);
        assert_eq!(fs::read(out.join("Lead (3).vital")).unwrap(), b"new");
        assert_eq!(fs::read(out.join("Lead.vital")).unwrap(), b"mine");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn apply_refuses_files_outside_staging_and_bad_output_dirs() {
        let root = temp_dir("outside");
        let stage = root.join("stage");
        let out = root.join("out");
        let elsewhere = root.join("elsewhere");
        fs::create_dir_all(&stage).unwrap();
        fs::create_dir_all(&out).unwrap();
        fs::create_dir_all(&elsewhere).unwrap();
        fs::write(elsewhere.join("Secret.vital"), b"x").unwrap();
        fs::write(stage.join("notes.txt"), b"x").unwrap();
        // An output path that only shares a file name with something outside
        // staging resolves inside staging, where it does not exist.
        let items = vec![
            item(
                "a",
                Some(elsewhere.join("Secret.vital").to_str().unwrap()),
                "ok",
            ),
            item("b", Some(stage.join("notes.txt").to_str().unwrap()), "ok"),
        ];
        let r = apply_batch(&stage, &items, &out, None).unwrap();
        assert!(r.written.is_empty());
        assert_eq!(r.skipped.len(), 2);
        assert_eq!(fs::read_dir(&out).unwrap().count(), 0);

        assert!(apply_batch(&stage, &items, &root.join("missing"), None).is_err());
        assert!(apply_batch(&stage, &items, &stage, None).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn sanitize_marks_foreign_outputs_failed() {
        let root = temp_dir("sanitize");
        let stage = root.join("stage");
        fs::create_dir_all(&stage).unwrap();
        fs::write(stage.join("ok.vital"), b"x").unwrap();
        fs::write(root.join("foreign.vital"), b"x").unwrap();
        let mut items = vec![
            item("a", Some(stage.join("ok.vital").to_str().unwrap()), "ok"),
            item(
                "b",
                Some(root.join("foreign.vital").to_str().unwrap()),
                "ok",
            ),
            item("c", None, "approx"),
        ];
        sanitize_outputs(&mut items, &stage);
        assert_eq!(items[0].status, "ok");
        assert_eq!(items[1].status, "failed");
        assert_eq!(items[1].output, None);
        assert_eq!(items[2].status, "failed");
        let _ = fs::remove_dir_all(&root);
    }
}
