# Music Tag Cleaner — AI working notes

Read this first; it exists so you don't have to explore the repo to get oriented.
The owner is a DJ (Rekordbox / Serato / Traktor) and often calls this app
"Media Fetch" — that is a *different* repo; tag/table/AI-Clean/YouTube-import
requests mean this one.

## Stack & commands
- Tauri 2 desktop app: React + TypeScript + Tailwind (`src/`), Rust (`src-tauri/`).
- `npm test` — vitest (TS). `cargo test` in `src-tauri/` — Rust tests.
- `npm run build` — `tsc && vite build` (type-check gate).
- `npm run tauri dev` — the only way to see the UI. **The app does not run in a
  plain browser** (every Tauri `invoke` throws), so don't try `npm run dev` + a
  browser to verify UI.
- Release: push a `v*` tag → `.github/workflows/release.yml` builds + signs all
  three platforms into a **draft** release (~14 min) that is published by hand.
  Bump version in `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`.

## Where things live
| Area | Files |
|---|---|
| App shell, toasts/logs (`notify`), routing | `src/App.tsx`, `src/pages/LogsPage.tsx` |
| Track table (virtualized >60 rows) | `src/components/TrackTable.tsx`, `src/hooks/useVirtualRows.ts` |
| Settings + migrations (`CURRENT_SETTINGS_VERSION`) | `src/hooks/useSettings.ts` — bump + add a migration step for any settings shape change; every save also lands in `settings.backup.json` (`commands/settings_backup.rs`), restored when the store comes back empty |
| Search (one implementation everywhere; reads tags, not visible columns) | `src/lib/trackSearch.ts` |
| Synth presets (Preset Translator: dialog, commands, engine) | `src/components/PresetsDialog.tsx`, `src/lib/presets.ts`, `src-tauri/src/commands/presets.rs` + `engines.rs`, `presetforge/` (Python engine), example plugin `plugins-examples/preset-translator/` |
| YouTube Music import page | `src/pages/YtMusicImportPage.tsx`, `src/components/LibrarySearchPanel.tsx` |
| Playlist matcher / match log | `src/lib/ytMatch.ts` (+ tests), `src/lib/ytMatchLog.ts` |
| yt-dlp fetch + import sessions (sqlite) | `src-tauri/src/commands/ytmusic.rs` |
| Prelisten player (single global player via `takeOverPlayback`) | `src/components/AudioPreview.tsx` |
| AI backends: Ollama / API / Claude CLI | `src-tauri/src/commands/ai.rs`, `claude_cli.rs`, `src/hooks/useAI.ts` |
| Library index (own sqlite, incremental on mtime+size) | `src-tauri/src/commands/library_index.rs`, `src/hooks/useLibraryIndex.ts` |
| Tag read/write, cover art, rename, open-with | `src-tauri/src/commands/files.rs` (writes via `safe_save.rs`) |
| Optional external tools (yt-dlp, FFmpeg, Demucs, Ollama, Claude CLI) | `src/pages/ComponentsPage.tsx` + matching `commands/*.rs` |
| Duplicates, convert, stems, USB, Rekordbox cues, backup | `commands/duplicates.rs`, `convert.rs`, `demucs.rs`, `usb.rs`, `rekordbox_import.rs`, `backup*.rs` |
| v1.0 accounts/payments (not built; waiting on owner's Phase 0) | `supabase/migrations/0001_init.sql`, ROADMAP "Roadmap — v1.0" |

## ROADMAP.md — don't read it whole (~2000 lines)
It is the changelog + plan. Numbered `### N.` sections, newest last. To orient:
`grep -n "^##\|^### " ROADMAP.md`, then read only the section you need. When you
ship something, append a new numbered section in the same style (what/why/how
verified) — that's the project's convention.

## Hard-won rules (don't relearn these)
- **No drag gestures in the YouTube-import search dock.** The webview starts a
  native content drag that runs a modal loop and freezes the renderer.
  `draggable={false}` is not enough; you'd need `-webkit-user-drag: none` on the
  row *and every descendant*. Use buttons.
- Column reordering is pointer-event based, not HTML5 drag, for the same reason.
- DJ tag semantics: Rekordbox reads **Original Artist**; Serato/Traktor need
  **Comment**. Track ID lives in `TXXX:TRACKID` (`TagData.trackId`), never in
  Track Number (TRCK = playlist order in Rekordbox/Serato).
- "Raw fields" = `TagData.allFields` (lofty's full frame dump); `raw:` prefix in
  `settings.clearFields`.
- Claude CLI: the copy bundled with the Claude desktop app is usually **not
  signed in** for standalone use; errors come back as `is_error: true` in the
  JSON body, not via exit code. The native installer (`irm .../install.ps1`)
  puts `claude.exe` under `%USERPROFILE%\.local\bin` (not on `PATH` by
  default; `find_claude()` checks it). Prompts over ~8K chars go via stdin —
  Windows caps a command line at 32,767 chars.
- **Tag writes must start from the file's own parsed tag, never `Tag::new`.**
  lofty keeps frames it can't map (GEOB = Serato cues/beatgrid, PRIV =
  Traktor, POPM ratings, RVA2, UFID) as a hidden companion of the parsed
  `Tag`; a fresh tag silently deletes them. `write_tags_blocking` is a diff:
  only changed curated fields are rewritten. Custom keys need
  `insert_unchecked`/`push_unchecked` — the checked variants drop
  `ItemKey::Unknown`. ID3v2 POPM is only reachable via `Id3v2Tag::from(tag)`.
- **Never call lofty's `save_to_path` / `remove_from_path` on a user's file.**
  They truncate the file and rewrite it in place, so a crash or closing the app
  mid-batch left zero-length tracks. Every edit goes through
  `safe_save::edit_file(path, |work| { work.parse(path, ..)?; ...; save_to(work) })`:
  working copy, temp file, one rename; edits of one file serialize. Call
  `work.rewind_to_start()` before each lofty `save_to`/`remove_from`.
- lofty is pinned to 0.22: 0.24 removed `ItemKey::Unknown` (see ROADMAP backlog).
- `files::par_map(items, f, on_panic)` isolates a panicking file to one
  result; batch commands must return exactly one result per input path.
- Demucs runs as `python -m demucs` in the user's own Python; never pass `-j` on CUDA.
- Large collections (4000+ files) are normal. Anything that renders one element
  per library track, or runs per-keystroke work over the whole library, must be
  virtualized / memoized / deferred.
- Heavy per-row components (e.g. `<audio>` elements) must not be mounted for
  hundreds of rows at once.

## Style
- Comments explain *why* (often the bug that forced the design); keep that
  density when editing nearby code.
- Tailwind utility classes + shared `src/components/ui.tsx` (`Button`, `Card`,
  `CardHeader`, `cn`). Icons from `lucide-react`.
- Rust commands return `Result<T, String>` with user-readable messages; TS side
  surfaces them via `notify(String(e), "error")`.
- Validate against the owner's real library/playlists when possible, not only fixtures.
