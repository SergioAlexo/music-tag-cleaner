use lofty::config::{ParseOptions, WriteOptions};
use lofty::file::TaggedFile;
use lofty::prelude::*;
use lofty::tag::{ItemKey, ItemValue, Tag, TagItem, TagType};
use serde::{Deserialize, Serialize};

pub const BACKUP_PREFIX: &str = "TAGBACKUP_v1::";
/// Stored as TXXX:TAGBACKUP in ID3v2, TAGBACKUP= in Vorbis comments,
/// and a freeform atom in MP4.
pub const BACKUP_KEY: &str = "TAGBACKUP";

#[derive(Serialize, Deserialize)]
struct BackupData {
    tag_type: String,
    items: Vec<BackupItem>,
}

#[derive(Serialize, Deserialize)]
struct BackupItem {
    key: String,
    value: String,
}

pub fn find_backup_in_file(tagged: &TaggedFile) -> Option<String> {
    for tag in tagged.tags() {
        for item in tag.items() {
            if let ItemValue::Text(s) = item.value() {
                if s.starts_with(BACKUP_PREFIX) {
                    return Some(s.clone());
                }
            }
        }
    }
    None
}

/// Serializes every text field of `tag` using the tag-format's native key
/// names (TIT2, ARTIST, ...) so `ItemKey::from_key` can round-trip them
/// exactly on restore. Binary frames other than cover art are not included.
pub fn make_backup_string(tag: Option<&Tag>, tag_type: TagType) -> String {
    let mut items = Vec::new();
    if let Some(tag) = tag {
        for item in tag.items() {
            let text = match item.value() {
                ItemValue::Text(s) | ItemValue::Locator(s) => s.clone(),
                ItemValue::Binary(_) => continue,
            };
            if text.starts_with(BACKUP_PREFIX) {
                continue;
            }
            let key = item
                .key()
                .map_key(tag_type, true)
                .map(str::to_string)
                .unwrap_or_else(|| crate::commands::files::key_name(item.key()));
            items.push(BackupItem { key, value: text });
        }
    }
    let data = BackupData {
        tag_type: format!("{tag_type:?}"),
        items,
    };
    format!(
        "{BACKUP_PREFIX}{}",
        serde_json::to_string(&data).unwrap_or_else(|_| "{}".into())
    )
}

#[tauri::command]
pub async fn restore_from_backup(path: String) -> Result<(), String> {
    crate::commands::files::run_blocking(move || restore_from_backup_blocking(&path)).await
}

/// `restore_from_backup` for a chunk of files at once — see
/// `backup_files_batch` for why this takes chunks rather than the whole run.
#[tauri::command]
pub async fn restore_from_backup_batch(paths: Vec<String>) -> Vec<crate::models::WriteResult> {
    let fallback = paths.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::commands::files::par_map(
            &paths,
            |p| crate::models::WriteResult {
                path: p.clone(),
                error: restore_from_backup_blocking(p).err(),
            },
            |p| crate::models::WriteResult {
                path: p.clone(),
                error: Some(crate::commands::files::CRASHED.to_string()),
            },
        )
    })
    .await
    .unwrap_or_else(|_| {
        fallback
            .into_iter()
            .map(|path| crate::models::WriteResult {
                path,
                error: Some("Restoring failed unexpectedly".to_string()),
            })
            .collect()
    })
}

pub(crate) fn restore_from_backup_blocking(path: &str) -> Result<(), String> {
    crate::commands::safe_save::edit_file(path, |work| restore_into(work, path))
}

fn restore_into(work: &mut crate::commands::safe_save::WorkingCopy, path: &str) -> Result<(), String> {
    let mut tagged = work.parse(path, ParseOptions::default())?;
    let backup =
        find_backup_in_file(&tagged).ok_or_else(|| "No backup found in this file".to_string())?;
    let json = &backup[BACKUP_PREFIX.len()..];
    let data: BackupData =
        serde_json::from_str(json).map_err(|e| format!("Backup is corrupted: {e}"))?;

    // The snapshot's keys are native names for the format's canonical tag
    // (`make_backup_string` is always called with it), so they must be read
    // back against that same type.
    let tag_type = tagged.file_type().primary_tag_type();

    // Rebuilt on the file's current tag rather than a blank one: that keeps
    // the cover art, any binary items, and the format-specific frames lofty
    // holds outside the generic API (Serato's GEOB cue/beatgrid data,
    // Traktor's PRIV block, POPM ratings) — none of which the snapshot holds,
    // and all of which a blank tag silently dropped. Only the text fields are
    // replaced by the snapshot's.
    let mut restored = tagged.remove(tag_type).unwrap_or_else(|| Tag::new(tag_type));
    drop(tagged);
    restored.retain(|item| matches!(item.value(), ItemValue::Binary(_)));
    for item in data.items {
        // Unchecked: a checked push drops every `ItemKey::Unknown`, which lost
        // each custom field in the snapshot — the private Track ID included.
        restored.push_unchecked(TagItem::new(
            ItemKey::from_key(tag_type, &item.key),
            ItemValue::Text(item.value),
        ));
    }
    // Keep the snapshot itself, so a restore is repeatable and never leaves
    // the file without its original state on record.
    restored.insert_unchecked(TagItem::new(
        ItemKey::Unknown(BACKUP_KEY.to_string()),
        ItemValue::Text(backup),
    ));
    work.rewind_to_start()?;
    restored.save_to(work, WriteOptions::default()).map_err(|e| e.to_string())
}
