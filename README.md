# 🎵 Vatra Wave

> **Formerly Music Tag Cleaner.** The app outgrew its name — it is now a full
> DJ library workstation — so it is being renamed to Vatra Wave. Settings,
> library, plugins and auto-updates carry over untouched; on Windows the
> install folder and Start-menu entry still say "MusicTagCleaner" for now.

Cross-platform desktop app (Tauri 2 + React/TypeScript + Rust) that strips audio
file metadata down to the common essentials, backs up the original tags inside
the file itself, and uses a local AI (Ollama) to clean up messy artist names,
titles, years, and genres — or, if you would rather not run a local model,
hands you the same prompt to paste into any AI you already use.

## Features

- **Select Folder / Add Files** — native pickers; supports `.mp3`, `.flac`,
  `.ogg`, `.aac`, `.m4a`, `.wav`, `.aiff`
- **Clear Fields** — erases exactly the fields you tick. The dropdown lists the
  common fields plus every extra frame actually present on the selection (TXXX,
  PRIV, MusicBrainz IDs, replaygain, encoder info, …), with an **All** shortcut
  to tick every extra at once. Before/after preview with per-cell checkboxes;
  nothing is written until you confirm, and nothing is ever removed that you
  did not pick.
- **AI Clean** — sends the tags to a local Ollama model that removes featured
  artists / legal names from the artist field, strips `(Radio Edit)`-style
  title suffixes, corrects the year to the original release, and normalizes
  the genre. Same confirm-before-write preview.
- **Manual AI (any AI, no Ollama)** — pick *Manual* under Settings → AI Backend
  and **AI Clean** / **Genre** open a copy/paste window instead of calling
  Ollama: copy the prompt, paste it into ChatGPT, Claude, Gemini or anything
  else, then paste the reply back. The prompt is byte-for-byte the one the
  local model receives and the reply goes through the same parser, so the
  preview, diffs, and Undo behave identically. Long selections are split into
  batches (10–250 tracks) that each fit in one chat message; track numbering is
  global, so batches can be pasted in any order and partial answers are fine.
- **Backup / Restore** — before the first write, all original text tags are
  serialized to JSON and stored inside the file as `TAGBACKUP_v1::{json}`
  (a `TXXX:TAGBACKUP` frame in ID3v2, `TAGBACKUP=` in Vorbis comments, a
  freeform atom in MP4). An existing backup is never overwritten, so the
  oldest state is always recoverable via **Restore Backup**.
- Settings (AI backend, Ollama URL/model, batch size, processing toggles,
  last-used folder) persist via `tauri-plugin-store`.
- **Selecting and ticking are separate** — clicking a row *selects* it
  (Shift+click for a range, Ctrl+click to add/remove), which never changes a
  checkbox, so editing or inspecting a field cannot alter what an action will
  run on. The checkbox chooses the targets: ticking a row that is part of the
  selection ticks **the whole selection**, ticking one outside it affects only
  that row and drops the selection. `Space` ticks the selection. Inline field
  edits also follow the selection (`Alt+Enter` to hit just one row).
- **Bulk include/exclude in previews** — every column header carries a box that
  includes or excludes that entire column of proposed changes (dash = partly
  included). With rows selected, clicking one proposed change toggles *that
  column* across the selection, so you can drop every Year suggestion for a
  block of tracks without touching their other fields.
- Keyboard shortcuts: `Ctrl+O` open folder, `Ctrl+A` highlight every row
  (does not tick — press `Space` after to tick the highlighted rows),
  `Space` tick the selection / focused row, `Escape` clear the highlight /
  close modal / cancel preview. The header checkbox ticks all, or — when only
  some rows are ticked — clears them.

## Prerequisites

- **Node.js** ≥ 20 and **Rust** (stable) — <https://tauri.app/start/prerequisites/>
- On Windows: WebView2 runtime (preinstalled on Win 10/11) and the
  Visual Studio C++ Build Tools
- **Ollama** for the local AI Clean backend — <https://ollama.com>, then e.g.
  `ollama pull llama3.1` or `ollama pull deepseek-r1:14b`. Not needed if you
  use the Manual backend.

## Development

```sh
npm install
npm run tauri dev
```

## Release build

```sh
npm run tauri build
```

The bundled icons are auto-generated placeholders. To use a real icon, drop a
1024×1024 PNG somewhere and run `npm run tauri icon path/to/icon.png`.

## Architecture notes

- **Rust backend** ([src-tauri/src](src-tauri/src)) uses the
  [`lofty`](https://crates.io/crates/lofty) crate so MP3/ID3v2, FLAC/Vorbis,
  MP4/iTunes atoms, OGG, WAV, and AIFF are handled uniformly.
  - [files.rs](src-tauri/src/commands/files.rs) — scanning, tag read/write.
    `write_tags` performs read → backup → write in one operation and also
    removes secondary tag formats (ID3v1, APE) so stripped fields cannot
    linger there.
  - [backup.rs](src-tauri/src/commands/backup.rs) — backup serialization
    uses each format's *native* key names (`TIT2`, `ARTIST`, …) so
    `ItemKey::from_key` restores fields exactly.
  - [ai.rs](src-tauri/src/commands/ai.rs) — Ollama `/api/generate` calls with
    `format: "json"`, defensive response parsing (handles `<think>` blocks
    from reasoning models, markdown fences, and object-wrapped arrays).
    `build_clean_prompt` / `build_genre_prompt` and the parsers are shared by
    the Ollama path and manual mode — `ai_clean_prompt`, `ai_genre_prompt`,
    `ai_parse_clean_response` and `ai_parse_genre_response` exist so the manual
    window can never drift from what the local model is asked. Covered by
    [ai_tests.rs](src-tauri/src/commands/ai_tests.rs) (`cargo test`).
- **AI responses are never auto-applied** — every change goes through the
  preview table, and malformed/missing fields fall back to the original value.
- Two AI backends only: local Ollama, or Manual copy/paste. Both build their
  request from the same Rust helpers, so the rules only ever live in one place.

### Known limitations

- Binary tag frames other than cover art (e.g. SYLT lyrics blobs) are not
  included in the JSON backup — they are stripped and not restorable.
- Cover art is preserved through strip/clean/restore only while
  "Preserve embedded cover art" is enabled in Settings.

## Manual test checklist

- [ ] MP3 with ID3v2 (incl. TXXX/PRIV frames): strip, verify backup, restore
- [ ] FLAC with Vorbis comments (incl. MusicBrainz keys): strip + restore
- [ ] M4A with iTunes atoms: strip + restore
- [ ] AI Clean with Ollama running (messy artist/title/year fixtures)
- [ ] AI Clean with Ollama stopped → friendly error message
- [ ] Manual backend: copy prompt → paste a real ChatGPT/Claude reply back →
      preview matches, including a reply wrapped in prose or code fences
- [ ] Manual backend with >1 batch: answer batch 2 first, then batch 1
- [ ] Clicking a row's fields never changes its checkbox
- [ ] Tick a checkbox inside a multi-row selection → all selected rows follow;
      tick one outside it → only that row, selection clears
- [ ] Preview: a column header box toggles that whole column; with rows
      selected, one cell click toggles that column across the selection
- [ ] Preview: uncheck one removal row → field survives the strip

## License

Vatra Wave is free software, licensed under the **GNU General Public
License, version 3 or later** — see [LICENSE](LICENSE) for the full text.

    Copyright (C) 2026 Sergio Alexo

    This program is free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by the
    Free Software Foundation, either version 3 of the License, or (at your
    option) any later version.

    This program is distributed in the hope that it will be useful, but
    WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General
    Public License for more details.

    You should have received a copy of the GNU General Public License along
    with this program. If not, see <https://www.gnu.org/licenses/>.

The optional external tools the app can drive are separate programs with their
own licences, and are neither bundled nor modified here: **yt-dlp**
(Unlicense), **FFmpeg** (LGPL/GPL depending on build), **Ollama** (MIT),
**Demucs** (MIT) and the **Claude Code CLI** (proprietary, Anthropic). The app
detects or downloads them at the user's request and runs them as ordinary
child processes.
