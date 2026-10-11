#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;
mod commands;
mod models;

use std::path::Path;
use std::sync::Mutex;

use tauri::{Emitter, Manager};

/// Audio files / folders named on the command line — from a Windows
/// "Open with MusicTagCleaner", a macOS "Open With", or a shell invocation.
/// The first instance stashes these here until the UI asks for them with
/// `take_opened_files`; later invocations arrive via the single-instance hook.
#[derive(Default)]
struct PendingOpen(Mutex<Vec<String>>);

/// Keeps only the arguments that look like an audio file or a folder, so a
/// stray flag or the exe path itself is never treated as something to import.
fn openable_paths<I: IntoIterator<Item = String>>(args: I) -> Vec<String> {
    args.into_iter()
        .filter(|a| !a.starts_with('-'))
        .filter(|a| {
            let p = Path::new(a);
            p.is_dir()
                || p.extension()
                    .and_then(|e| e.to_str())
                    .map(|e| {
                        commands::files::AUDIO_EXTENSIONS
                            .contains(&e.to_ascii_lowercase().as_str())
                    })
                    .unwrap_or(false)
        })
        .collect()
}

/// The UI calls this once on startup to pick up any files the app was opened
/// with; it drains the list so a later reload doesn't re-import them.
#[tauri::command]
fn take_opened_files(state: tauri::State<PendingOpen>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().unwrap_or_else(|e| e.into_inner()))
}

/// Taskbar identity. Must equal `identifier` in tauri.conf.json — that is the
/// AUMID the pinned / Start-menu shortcut carries, so a window with any other
/// AUMID gets its own icon-less taskbar button instead of grouping with it.
#[cfg(windows)]
const APP_USER_MODEL_ID: &str = "com.sopas.musictagcleaner";

/// A launch from the Explorer shell extension inherits the sparse package's
/// identity, and with it the package's AUMID (`...ShellExtension_<hash>!...`).
/// Forcing the process AUMID makes every launch path present as the same app.
#[cfg(windows)]
fn set_process_app_user_model_id() {
    use windows::core::HSTRING;
    let _ = unsafe {
        windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(
            APP_USER_MODEL_ID,
        ))
    };
}

/// Window-level AUMID. A property on the window wins over process/package
/// identity for taskbar grouping, so this covers a packaged launch that
/// ignores the process-level call above.
#[cfg(windows)]
fn set_window_app_user_model_id(win: &tauri::WebviewWindow) {
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Storage::EnhancedStorage::PKEY_AppUserModel_ID;
    use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
    use windows::Win32::System::Variant::VT_LPWSTR;
    use windows::Win32::UI::Shell::PropertiesSystem::{IPropertyStore, SHGetPropertyStoreForWindow};
    use windows::Win32::UI::Shell::SHStrDupW;

    let Ok(hwnd) = win.hwnd() else { return };
    let hwnd = HWND(hwnd.0);
    unsafe {
        let Ok(store) = SHGetPropertyStoreForWindow::<IPropertyStore>(hwnd) else { return };
        let wide: Vec<u16> = APP_USER_MODEL_ID.encode_utf16().chain(Some(0)).collect();
        let Ok(dup): Result<PWSTR, _> = SHStrDupW(PCWSTR(wide.as_ptr())) else { return };
        // VT_LPWSTR (not the BSTR that `PROPVARIANT::from(&str)` builds): the
        // shell only accepts a plain wide string for this key. The PROPVARIANT
        // owns `dup` and frees it with CoTaskMemFree on drop.
        let mut pv = PROPVARIANT::default();
        let inner = &mut *pv.Anonymous.Anonymous;
        inner.vt = VT_LPWSTR;
        inner.Anonymous.pwszVal = dup;
        if store.SetValue(&PKEY_AppUserModel_ID, &pv).is_ok() {
            let _ = store.Commit();
        }
    }
}

fn main() {
    #[cfg(windows)]
    set_process_app_user_model_id();

    // Elevated helper mode: a second copy of this exe, launched with `runas`,
    // formats one drive and exits. Handled before anything else so the
    // single-instance plugin never sees it — that plugin forwards arguments to
    // the already-running UI and exits, which would silently format nothing.
    if let Some(code) = commands::usb::run_format_helper_if_requested() {
        std::process::exit(code);
    }

    let initial = openable_paths(std::env::args().skip(1));

    tauri::Builder::default()
        // Must be registered first: a second launch (e.g. "Open with" on more
        // files while the app is already open) forwards its arguments here and
        // exits. Paths go onto the shared queue and the UI is nudged to drain
        // it with `take_opened_files` — selecting N files spawns N processes in
        // a burst, some before the webview has a listener, so the queue (not
        // the event payload) is the source of truth.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let paths = openable_paths(argv.into_iter().skip(1));
            if !paths.is_empty() {
                if let Some(state) = app.try_state::<PendingOpen>() {
                    state.0.lock().unwrap_or_else(|e| e.into_inner()).extend(paths);
                }
                let _ = app.emit("open-files", ());
            }
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .on_window_event(|window, event| {
            // B4 "snapshot on exit": best effort, VACUUM INTO of a small file.
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if window.label() == "main" {
                    commands::organize::snapshot_on_exit(window.app_handle());
                    bridge::shutdown(window.app_handle());
                }
            }
        })
        .setup(|_app| {
            #[cfg(windows)]
            if let Some(win) = _app.get_webview_window("main") {
                set_window_app_user_model_id(&win);
            }
            Ok(())
        })
        .manage(PendingOpen(Mutex::new(initial)))
        .manage(commands::ytmusic::EnrichCancelFlag::default())
        .manage(bridge::BridgeState::default())
        .invoke_handler(tauri::generate_handler![
            take_opened_files,
            bridge::bridge_set_enabled,
            bridge::bridge_status,
            bridge::bridge_respond,
            commands::files::scan_folder,
            commands::files::list_files,
            commands::files::import_paths,
            commands::files::read_tags,
            commands::files::read_tags_batch,
            commands::files::write_tags,
            commands::files::standardize_tag_containers,
            commands::usb::list_removable_drives,
            commands::usb::format_drive_fat32,
            commands::files::write_tags_batch,
            commands::files::write_raw_field,
            commands::files::write_raw_fields_batch,
            commands::files::read_cover_art,
            commands::files::read_cover_thumbnail,
            commands::files::read_cover_thumbnails,
            commands::files::image_info,
            commands::files::image_info_batch,
            commands::files::set_cover_art,
            commands::files::remove_cover_art,
            commands::files::restore_cover_art,
            commands::files::standardize_artwork,
            commands::files::rename_file,
            commands::files::delete_file,
            commands::files::open_with,
            commands::files::write_text_file,
            commands::files::read_text_file,
            commands::files::path_exists,
            commands::files::file_mtime_secs,
            commands::files::backup_file,
            commands::files::backup_files_batch,
            commands::backup::restore_from_backup,
            commands::backup::restore_from_backup_batch,
            commands::ai::check_ollama,
            commands::ai::ai_clean_batch,
            commands::ai::ai_preview_prompt,
            commands::ai::ai_clean_prompt,
            commands::ai::ai_parse_clean_response,
            commands::ai_playlist::ai_playlist_batch,
            commands::ai_playlist::ai_playlist_prompt,
            commands::ai_playlist::ai_parse_playlist_response,
            commands::claude_cli::claude_playlist_batch,
            commands::components::ollama_info,
            commands::components::install_ollama,
            commands::components::start_ollama,
            commands::components::pull_model,
            commands::components::delete_model,
            commands::duplicates::scan_duplicates,
            commands::duplicates::get_waveform,
            commands::ffmpeg::ffmpeg_info,
            commands::ffmpeg::install_ffmpeg,
            commands::convert::convert_files,
            commands::backup_archive::create_backup_archive,
            commands::backup_archive::read_backup_manifest,
            commands::rekordbox_import::import_rekordbox_cues,
            commands::rekordbox_import::get_cues_for_path,
            commands::rekordbox_import::read_rekordbox_playlists,
            commands::rekordbox_import::export_rekordbox_playlists_for_mixxx,
            commands::rekordbox_import::import_rekordbox_library_tags,
            commands::rekordbox_import::rekordbox_lookup,
            commands::ytmusic::ytdlp_info,
            commands::ytmusic::install_ytdlp,
            commands::ytmusic::fetch_ytmusic_playlist,
            commands::ytmusic::enrich_ytmusic_entries,
            commands::ytmusic::cached_ytmusic_meta,
            commands::ytmusic::cancel_ytmusic_enrich,
            commands::ytmusic::save_import_session,
            commands::ytmusic::load_import_session,
            commands::ytmusic::list_import_sessions,
            commands::ytmusic::delete_import_session,
            commands::library_index::library_roots,
            commands::library_index::set_library_roots,
            commands::library_index::index_library,
            commands::library_index::clear_library_index,
            commands::library_index::library_tracks,
            commands::library_index::library_stats,
            commands::library_index::library_genres,
            commands::library_index::library_paths_with_genre,
            commands::library_index::library_facets,
            commands::library_index::library_paths_with_facet,
            commands::library_index::retag_field,
            commands::library_index::reindex_library_paths,
            commands::artwork::artwork_search_musicbrainz,
            commands::artwork::artwork_search_itunes,
            commands::artwork::artwork_search_deezer,
            commands::artwork::artwork_apply,
            commands::artwork::artwork_scan,
            commands::artwork::artwork_clusters,
            commands::artwork::artwork_blocklist_set,
            commands::artwork::artwork_flagged,
            commands::organize::organize_preview,
            commands::organize::organize_move,
            commands::organize::organize_undo,
            commands::organize::library_db_info,
            commands::organize::set_library_db_path,
            commands::organize::export_library_snapshot,
            commands::organize::restore_library_snapshot,
            commands::organize::set_snapshot_config,
            commands::demucs::demucs_info,
            commands::demucs::install_demucs,
            commands::demucs::separate_stems,
            commands::claude_cli::claude_cli_info,
            commands::claude_cli::install_claude_cli,
            commands::claude_cli::open_claude_login,
            commands::claude_cli::claude_clean_batch,
        ])
        .run(tauri::generate_context!())
        .expect("error while running MusicTagCleaner");
}
