# MusicTagCleaner — fix roadmap

Running list of known issues and their status. Add new items under **Backlog**.

## Done

### 1. Standardize capitalization mangled titles
`Capitalization → Aa` used English/Chicago "title case" rules: small words
(`in`, `of`, `the`, `and`, …) were forced lowercase mid‑title, so
`Rivers Flow In You` became `Rivers Flow in You`. The same function also
flattened acronyms (`DJ Snake` → `Dj Snake`), broke hyphenated words
(`Rock-N-Roll` → `Rock-n-roll`), and lower‑cased roman numerals
(`Part III` → `Part Iii`).

**Fix** (`src/lib/standardize.ts`): the `Aa` mode now simply **capitalizes the
first letter of every word** — no small‑word rule. Also:

- letter runs split on spaces, `-` and `/` (`ac/dc` → `Ac/Dc`, `rock-n-roll` → `Rock-N-Roll`)
- an already-uppercase roman numeral I–XX is preserved (`Part III` stays `Part III`,
  not `Part Iii`)
- mixed‑case initialisms are kept (`DJ Snake` stays `DJ Snake`)
- an all‑caps run reading as an initialism is kept (`MGMT Kids` → `MGMT Kids`),
  but a shouted ordinary word is normalized (`LOVE` → `Love`)
- a fully‑shouting value is fully recased (`RIVERS FLOW IN YOU` → `Rivers Flow In You`)

The Settings tooltip for `Aa` is now "Capitalize Each Word".

**Known limitations** — lowercase initialisms can't be detected
(`dj snake` → `Dj Snake`), Irish/Scots names lose their internal capital
(`O'Brien` → `O'brien`, `McFly` → `Mcfly`), a value that is *only* `AC/DC`
or `MGMT` is treated as shouting (→ `Ac/Dc`, `Mgmt`), and `feat.`/`ft.` are
capitalized like any other word. The backlog's "casing exceptions" setting
(item 52 area, done 2026-09-26 — see its entry further down) is the fix:
add the exact spelling once in Settings and it always renders that way.

### 2. Editing a field cleared the row selection
Double‑clicking a cell to edit fired the row's `click` handler first, which
collapsed a multi‑row selection to just that row — so the edit only applied to
one track even though `targetPaths()` is built to fan an edit out across the
selection.

**Fix** (`src/components/TrackTable.tsx`, `handleRowClick`): a plain click on a
row that is already part of a multi‑row selection now leaves the selection
intact (only the anchor moves). To drop one row from the selection, Ctrl+click
it. Clicking a row outside the selection still collapses to that row.

### 3. "All Tags" view duplicated Title / Artist / Year etc.
The `All Tags` toggle added one column per raw tag frame in the file, but did
not skip the raw frames that the curated columns already show — so `TrackTitle`
appeared next to `Title`, `TrackArtist` next to `Artist`, `Year`/`RecordingDate`
next to `Year`, and so on, all with identical values.

**Fix** (`src/components/TrackTable.tsx`, `extraColumns`): raw keys in
`KEPT_FIELD_KEYS` are now skipped, matching what the strip preview already does.
`All Tags` now shows only the *extra* frames (Publisher, ISRC, encoder info,
MusicBrainz IDs, `TXXX:*`, …).

### 4. Clear Fields — pick fields per run, remember the choice, allow raw fields
The Clear Fields target list used to be editable only in Settings
(`settings.clearFields`, curated fields only).

**Fix:**
- The toolbar **Clear Fields** button is now a split button
  ([ClearFieldsMenu.tsx](src/components/ClearFieldsMenu.tsx)): the left half
  runs immediately with the remembered set; the caret opens a checklist.
- The checklist offers the curated `CLEARABLE_FIELDS` **and** the raw frame
  keys present on the current selection (`allFields` minus `KEPT_FIELD_KEYS`,
  the backup blob is already excluded from `allFields` by the reader).
- Running it persists the chosen set to `settings.clearFields` — that becomes
  the default for next time. Raw entries are stored with a `raw:` prefix.
- `buildClearPreview` resolves a `raw:` entry against `allFields[key]`;
  `applyUpdates` clears a raw frame by dropping it from the `keepExtra`
  carry-over list (`PendingChange.raw` marks those rows).

Touched: `types.ts`, `hooks/useTags.ts`, `App.tsx` (`runClearFields`),
`pages/LibraryPage.tsx`, new `components/ClearFieldsMenu.tsx`.

### 5. Raw ("All Tags") columns: header text spilled over, couldn't resize
Dynamic columns had a fixed 140px width that `widthOf()` refused to override,
so their resize handle wasn't even rendered; and the header `<th>` used
`whitespace-nowrap` with no clipping, so long raw key names
(`MusicBrainzReleaseGroupId`, …) painted over the next column.

**Fix** (`src/components/TrackTable.tsx`):
- `widthOf()` now reads `columnWidths[c.id]` for every column, dynamic
  included (dynamic ids are `extra:<key>`, so a resized width persists).
- The resize handle renders on dynamic headers too.
- Header label sits in a `min-w-0 flex-1 truncate` span inside an
  `overflow-hidden` flex row, so it ellipsises within the column instead of
  overflowing; the toggle, `(Backup)` badge and sort caret are `shrink-0`.

### 6. Row checkboxes painted over the sticky header when scrolling
The `<thead>` and the sticky first-column `<td>` cells both had `z-10`, so on
scroll the later-in-DOM body checkboxes drew on top of the header's
"check all" box.

**Fix** (`src/components/TrackTable.tsx`): `<thead>` is now `z-20` and its
sticky corner `<th>` `z-30`; body sticky cells stay `z-10`.

### 7. "Rename to Standard" appended " (2)" to files with no duplicate
`rename_file_blocking` guarded only against a byte-identical target path, then
looped `while target.exists()` appending " (2)", " (3)", …. On Windows/macOS
(case-insensitive volumes) a tag casing that differed from the on-disk name —
`bonobo - kerala.mp3` on disk, `Bonobo - Kerala` from the tags — made
`target.exists()` true against the file *itself*, so it renamed to
`Bonobo - Kerala (2).mp3`.

**Fix** (`src-tauri/src/commands/files.rs`): the collision loop now skips a
candidate that `canonicalize()`s to the source file, so a case-only /
normalization-only rename applies cleanly with no suffix.

### 8. Ctrl+A ticked every checkbox instead of just selecting
`Ctrl+A` called `filesApi.setAll(true)`, ticking every row. It now highlights
every visible row (the `rowSel` selection) without ticking; `Space` then ticks
the highlighted rows. Handled in `TrackTable`'s key handler; removed from
`App.tsx`. Shortcut relabelled "Highlight all tracks".

### 9. Track ID moved out of Track Number
"Generate IDs" wrote a 6-digit sequential id into **Track Number** (`TRCK`),
which Rekordbox/Serato use for album & playlist track position — so the id
clobbered real metadata.

**Fix:** the id now lives in its own field, `TagData.trackId`, stored in a
private `TXXX:TRACKID` frame (`ItemKey::Unknown("TRACKID")` — TXXX on
ID3, `TRACKID` in Vorbis, freeform atom on MP4), and shows as its own
**Track ID** column. Track Number is left untouched. `isUid` /
`buildRenameStem` (rename-to-standard) and Clear Fields now target `trackId`.
Settings migration v4 inserts the new column after Track Number.

**Existing libraries:** ids already written into Track Number by older builds
stay there — clear that column with **Clear Fields → Track #**, or re-run
**Generate IDs** (which now fills Track ID) and clear Track Number after.

Touched: `models.rs`, `commands/files.rs` (read/write + `TRACK_ID_FIELD`),
`types.ts` (`TagData`, `FIELD_LABELS`, `CLEARABLE_FIELDS`, `KEPT_FIELD_KEYS`),
`hooks/useTags.ts`, `hooks/useSettings.ts` (defaults + v4 migration),
`components/TrackTable.tsx` (`ALL_COLUMNS`), `pages/SettingsPage.tsx` (hint).
Rust tests added for the rename `(2)` fix (`commands/files.rs`).

### 10. Standardize / compress embedded cover art
New **Standardize Art** toolbar button: for every selected file it re-encodes
the embedded cover to **JPEG** and scales the longest side down to a target
(default **1000 px**, never upscaled) at a set **JPEG quality** (default 85).
Both configurable under Settings → "Standardize Art — max size / JPEG quality".

- Skips files with no art, and JPEGs already within bounds that a re-encode
  wouldn't shrink by >10% (no needless generation loss).
- Non-JPEG covers (PNG/…) are always converted.
- Each change goes through the existing `__coverArt` undo/redo history with the
  original bytes stored, so **Undo restores the exact original losslessly**.
- Uses the `image` crate (already a dependency). Pixel pipeline is
  `recompress_cover()` in `commands/files.rs`, covered by `cargo test`.

Touched: `models.rs` (`ArtworkChange`), `commands/files.rs` +
`main.rs` (`standardize_artwork` command), `types.ts` / `useSettings.ts`
(2 settings), `App.tsx` (`standardizeArtwork`), `LibraryPage.tsx` (button),
`SettingsPage.tsx` (2 rows).

### 11. "Open with MusicTagCleaner" from Windows Explorer
The installer now registers the app for `.mp3 .flac .ogg .aac .m4a .wav .aiff
.aif` (`bundle.fileAssociations` in `tauri.conf.json`) so it shows up under
Explorer's **Open with**. The app handles being launched with file/folder
arguments:

- `tauri-plugin-single-instance` (registered first) — selecting N files spawns
  N processes; the first opens the app, the rest push their paths onto a shared
  queue and nudge the running window, then exit.
- `openable_paths()` in `main.rs` keeps only audio files / folders from argv.
- `take_opened_files` command drains the queue; the UI calls it on mount, on
  the `open-files` event, and twice more (800 ms / 2.5 s) to catch the launch
  burst, then feeds the paths through the normal `importPaths`.

Does **not** make the app the default handler — just adds it to "Open with".

### 12. Opening ~400 files froze the app
Two causes:

1. `useCovers` fetched the **full-resolution** embedded art for *every* file and
   `setCovers`'d once per file — for 400 files that's hundreds of MB of base64
   held in one state object cloned 400× and 400 whole-table re-renders.
   **Fix:** new `read_cover_thumbnail` command returns a ~128 px JPEG
   (~3 KB); `useCovers` uses it and flushes state in batches of 20.
2. `scan_folder` / `list_files` / `import_paths` / `read_tags_batch` each did
   one sequential `lofty` parse per file. **Fix:** `par_map()` in `files.rs`
   spreads the parses across up to 8 threads for inputs > 16.

### 13. Track table row virtualization
The table now renders only the rows near the viewport, with spacer `<tr>`s
standing in for the rest (`src/hooks/useVirtualRows.ts`). Fixed-height
windowing: row height is measured from a real rendered row (so it tracks the
row-height setting and zoom), `overscan` 8. Kicks in above 60 rows; at or
below that everything renders as before. Search jump (`goToMatch`) scrolls by
computed index so it can reach rows that aren't currently mounted. The
spacer-row technique keeps `<colgroup>` widths, `table-layout: fixed`, the
sticky header and sticky first column all working; verified in Chromium that
an empty `<td colSpan height>` takes the requested height.

### 14. No way to clear the selection (0.5.1)
After `Ctrl+A` highlighted every row there was no gesture to clear the
highlight, and the header checkbox ticked-all on the first click even when
some rows were already ticked.

**Fix** (`src/components/TrackTable.tsx`): `Escape` (with the table focused)
clears the row highlight; the header checkbox shows an indeterminate dash
when partly ticked and one click there clears every tick.

### 15. Clear Fields preview couldn't show fields with no column (0.5.2)
The inline preview only rendered the per-column checkbox + per-cell "spare
this one" checkbox for fields that had a visible column. Clearing a hidden
curated field (Comment, Composer, …) or a raw frame (Publisher, ISRC)
previewed as an empty table with just a Cancel bar.

**Fix** (`src/components/TrackTable.tsx`):
- A `previewColumns` memo adds a temporary column for any pending field with
  no column on screen — the hidden curated column from `ALL_COLUMNS`, or a
  synthesized one for a raw key. Cell and header pending lookups fall back to
  `c.rawKey`, so dynamic columns light up too.
- Every cleared field reads as a struck-through removal (`buildClearPreview`
  uses `kind: "remove"` for curated fields as well). `applyPending`'s history
  filter was widened to keep curated clears undoable despite the kind change;
  cleared raw frames stay out of history (Restore Backup reverts those).
- During a Clear Fields preview every tag column (visible ones without a
  pending change) shows a faint checkbox — ticking it adds that field to the
  clear for the previewed files.
- The temporary columns and add-boxes vanish when the preview closes.

Plus: the toolbar selection hint now mentions `Esc` clears the highlight.

### 16. "Working…" indicator so writes don't look like a freeze (0.5.2)
Only AI / artwork / backup ran a status-bar progress bar; every other write
(Apply for strip / standardize / genre / clear, Generate IDs, Rename, inline
edits, preview builds) just disabled the toolbar with no visible sign the app
was doing anything.

**Fix:** the status bar shows a spinning `Loader2` + "Working…" whenever
`busy` (or scanning / backup / AI) is set and there's no detailed progress.
`applyStrip` / `applyUpdates` now take an `onProgress` callback so **Apply**
shows "Writing N of M" with the bar; `renameSingleFile` sets `busy`.

### 17. Generate IDs (and the searchable backup, and raw-field edits) wrote nothing — v0.6
Three separate call sites wrote a private/unmapped tag key through lofty's
**checked** `Tag::insert`/`insert_text`, which internally calls
`ItemKey::re_map(tag_type)` with `allow_unknown: false` — so any
`ItemKey::Unknown` key without an entry in the format's own key map (private
frames like our `TRACKID`/`TAGBACKUP`, or an arbitrary raw "All Tags" field)
was **silently dropped before the item was even added to the tag**, with no
error anywhere. This wasn't a selection or UI problem — the write itself
never happened.

**Fix** (`src-tauri/src/commands/files.rs`): switched all three sites to
`insert_unchecked` — lofty's documented way to write `ItemKey::Unknown`
values; the format-specific writer still validates the key at actual save
time (confirmed via lofty source: ID3v2 writes it as a `TXXX` frame keyed by
description, Vorbis passes it through `verify_key`), so this doesn't bypass
real validation, only a redundant pre-check that has no entry for private
keys anyway:
- `set_text()` — fixes **Generate IDs** (Track ID silently never wrote).
- The backup-blob insert in `write_tags_blocking` and in
  `backup_file_blocking` — fixes the **searchable-backup JSON snapshot**,
  meaning **Restore Backup had nothing to restore from** for any ID3v2 file
  since this shipped. This was a real data-safety bug, not just a display one.
- `write_raw_field_blocking()` — fixes editing any raw **"All Tags"** field
  whose key isn't in lofty's built-in map.

Three Rust round-trip tests added (`track_id_round_trips_through_id3v2`,
`backup_blob_round_trips_through_id3v2`, `raw_field_edit_round_trips_through_id3v2`)
against a minimal synthesized MP3, each reproduced the bug before the fix and
passes after.

Separately, `afterWrite()` in `App.tsx` was clearing the **entire**
`libraryTags` cache on every single-track write (Generate IDs, an inline
edit, undo/redo), instead of just the touched paths — the "eagerly read
tags" effect then re-parsed the *whole library* from disk on every edit,
which on a large collection is slow enough to look like the edit did
nothing. Now only the affected paths are dropped from the cache
(`dropLibraryTags()`); `renameToStandard` remaps cached tags to the new
paths instead of wiping them, since a rename doesn't change the tags.

### 18. Column drag-reorder opened the file-drop overlay — v0.6
On Windows, Tauri's window-level `onDragDropEvent` ([App.tsx:328](src/App.tsx:328))
fires for **any** drag over the webview — not just an external OS file
drag — because it hooks WebView2's drag events at the host level. Dragging a
`<th>` to reorder a column ([TrackTable.tsx](src/components/TrackTable.tsx))
therefore also flipped `dropActive`, painting the "Drop audio files or
folders to add them" overlay mid-drag.

**Fix:** a plain module-level flag, [`src/lib/internalDrag.ts`](src/lib/internalDrag.ts),
set on the column header's `dragstart` and cleared on `dragend`; App.tsx's
listener bails out early while it's set. Reordering itself already worked
and already persisted via `settings.visibleColumns` (order *is* visibility
order) — the bug was purely the misleading overlay.

### 19. Editing a genre name didn't do what it looked like — v0.6
Two distinct paths, both fixed:
- **Settings → Genre Presets:** each genre `<input>` called `onSave` (which
  persists to the store) on every keystroke — no local draft — so editing
  felt unresponsive. Now a small `GenreRow` component
  ([SettingsPage.tsx](src/pages/SettingsPage.tsx)) holds its own draft,
  committed on blur/Enter (`Esc` reverts).
- **The inline genre dropdown's pencil-rename** (`Combobox`'s `onEditOption`,
  wired at [TrackTable.tsx:1308](src/components/TrackTable.tsx:1308)) renamed
  the *preset option* but never touched the value of the field actually being
  edited — so renaming "House Tech" to "Tech House" while editing a track's
  genre left that track showing the old name. **Fix**
  ([Combobox.tsx](src/components/Combobox.tsx)): renaming the option that
  matches the field's current value now also commits it as the new value.

### 20. Renaming a genre now offers to retag the collection — v0.6
Both rename paths above funnel through `renameGenreInPreset()` in
[App.tsx](src/App.tsx), which now — after updating the preset — counts
tracks in the loaded collection with the old genre and, if any exist, prompts
*"N tracks in the collection use 'House Tech'. Rename them to 'Tech
House'?"* via the native confirm dialog. Accepting runs the retag through the
existing `editField()` bulk-edit path, so it's a normal undoable history
entry. Scans only the loaded collection.

### 21. Version string was hardcoded — v0.6
[Sidebar.tsx](src/components/Sidebar.tsx) printed a literal `v0.1.0` while
the manifests were at 0.5.2. **Fix:** reads the real version via
`getVersion()` from `@tauri-apps/api/app` (same API `ComponentsPage.tsx`
already used for update checks).

### 22. Removed the Ollama attention dot — v0.6
The amber dot on the Components nav item appeared whenever Ollama wasn't
running, which is most of the time and isn't an error. Removed; Ollama
status stays on the Components page itself. (`Sidebar` no longer takes an
`ollamaRunning` prop.)

### 23. Artwork full screen — v0.6
Single-clicking the cover thumbnail opens a full-screen lightbox
(`ArtworkLightbox` in [TrackTable.tsx](src/components/TrackTable.tsx)):
fetches the true full-resolution embedded picture on demand via the
(already-existing but unused) `read_cover_art` command rather than the
table's small re-encoded thumbnails, fits to the window, `Esc`/click-outside
to close, Left/Right arrows step through the current sorted/filtered list,
and a caption shows the filename plus dimensions/format/size via the
existing `useImageInfo` data. A short click/dblclick timer keeps this from
firing on the first half of a double-click, which still opens the existing
"all tag fields" Inspect dialog.

### 24. Genre Mode — fast keyboard-driven genre assignment — v0.7
Toolbar toggle (`Headphones` button, [TrackTable.tsx](src/components/TrackTable.tsx))
that turns the table's own row-highlight (`rowSel`/`anchorPath`) and a single
shared `<audio>` element into a keyboard-only genre-tagging loop:

| Key | State | Action |
|---|---|---|
| `↑` / `↓` | any | Move the current row; playback keeps going |
| `Enter` | not playing | Play the current row **from its last position** |
| `Enter` | playing this row | Expand the genre picker inline, focused |
| `←` / `→` | playing, picker closed | Seek −10 s / +10 s |
| (type + `Enter`, or click an option) | picker open | Save genre → advance → old track stops, new one plays from its own resume point |
| `Esc` | picker open | Close without saving (existing `Combobox` behaviour, untouched) |
| `Space` | picker closed | Play / pause the current row |
| `1`–`9` | picker closed | Quick-tag the Nth preset genre directly, no picker, then advance |
| `Esc` | picker closed | Exit Genre Mode |

Implementation notes:
- One shared `<HTMLAudioElement>` (not a per-row player) with a
  `gmPositions` map of per-track resume seconds, kept for the session.
  Resuming the *same* track (Space pause/resume) skips the reload entirely —
  only switching tracks reloads `src` and seeks to the saved position.
- Registers with the same `takeOverPlayback`/`releasePlayback` module-level
  singleton a row's own prelisten button already used
  ([AudioPreview.tsx](src/components/AudioPreview.tsx), refactored out of
  its previous private `stopOthers` variable), so only one thing ever plays
  across the whole table.
- The keydown handling is merged into the table's existing window-level key
  handler rather than a second listener, gated the same way the rest of that
  handler already is (`e.target === document.body`) — which is also what
  makes it step aside automatically while the genre picker's own `<input>`
  has focus, letting `Combobox`'s existing Enter/Arrow/Escape handling run
  untouched with no event-propagation hacks needed.
- Saving from the picker reuses the existing `beginEdit`/`commitEdit`/
  `onEditField` pipeline — a genre-mode save is a completely normal
  undoable history entry.
- Up/Down and advance both call the existing virtualizer's `scrollToIndex`
  so the current row stays in view on a long list.
- A bottom strip shows the current filename, play/pause, elapsed/total time,
  the track's current genre, and the key legend.

**Simplified vs. the original plan, left as backlog:** the seek amount is a
hardcoded 10 s constant rather than a setting; `Tab`-to-accept-without-
advancing isn't implemented (only Enter/click advance); fuzzy filtering and
arrow-navigation *within* the open picker's own option list were already
present in `Combobox` before this feature and needed no changes.

### 25. Strict filename charset — v0.7
Settings → Track IDs → **Strict file names** (default **on**): Rename to
Standard now builds the stem with only `a-z`, `0-9` and `-`.

- `sanitizeForFilenameStrict()` ([standardize.ts](src/lib/standardize.ts)):
  Unicode NFKD-decomposes the value and strips the combining diacritical
  marks that split off (`Beyoncé` → `beyonce`, `Motörhead` → `motorhead`,
  `Ñoño & Zürich` → `nono-zurich`), lowercases, then maps every remaining
  non-`[a-z0-9]` character to `-`, collapsing runs and trimming both ends.
  `buildRenameStem()` takes a `strict` flag and joins parts with `-` instead
  of `" - "` when set.
- **Limitation, as scoped:** this ASCII-folds accented Latin script well but
  cannot romanize a genuinely different script (Cyrillic, CJK, Arabic, …) —
  those characters have no accent to strip, so they become dashes like any
  other unsupported character, same as the roadmap's "where possible" caveat.
- Falling back to the track id when artist/title sanitize to nothing, and
  refusing (reporting an error) a file with no usable characters at all, both
  fall out of the existing `[artist, title, uid].filter(nonEmpty).join()`
  structure — no special-case code needed, since `uid` was already one of
  the three parts.
- `renameToStandard()` in [App.tsx](src/App.tsx) now pre-counts stem
  collisions across the batch and warns (native confirm, not blocking) before
  writing anything; the existing rename-collision suffix (" (2)", " (3)", …)
  still guarantees nothing is overwritten either way.
- **Not built:** a dedicated before/after rename preview screen — there
  wasn't one before this change either, so this stayed scoped to the
  character-set enforcement itself rather than adding new UI.

### 26. Auto-detect genres from the collection — v0.7
Settings → Genre Presets → **Detect genres from collection**
([SettingsPage.tsx](src/pages/SettingsPage.tsx), `DetectGenresPanel`):

- `detectGenreGroups()` ([genres.ts](src/lib/genres.ts)) tallies every
  distinct `TagData.genre` across the loaded collection (`libraryTags` in
  App.tsx, kept live via a `useMemo`), grouping near-duplicate spellings by a
  normalized key (case, `&`/`and`, `-`/space all folded together — `Hip Hop`
  / `Hip-Hop` / `hip hop` collapse into one group). The most common raw
  spelling in a group becomes its suggested `canonical` name.
- The panel lists groups **not already in the active preset**, pre-ticked,
  sorted by track count, with the other spellings shown under each ("also
  seen as: …"). **Add N genres** appends the ticked canonical names to the
  preset via `addGenresToPreset()`.
- For any ticked group with more than one variant, adding it also calls the
  existing retag machinery (`mergeGenreVariants()`, built on the same
  confirm-then-`editField()` pattern as item 20's single-genre rename) —
  offering to retag every track using a non-canonical spelling to the
  canonical one, in a single native confirm covering the whole group.

Found and fixed one grouping bug while testing this: normalizing `&` to
`and` without surrounding spaces turned `R&B` into `rand b` instead of
`r and b`, so it never matched the `R and B` spelling it was supposed to
group with.

### 27. Raw field names as labels — v0.7
Settings → Standardization → **Field naming**: `Title` / `TIT2` / `Title
(TIT2)`. New [rawFieldNames.ts](src/lib/rawFieldNames.ts):

- A static table of each curated field's raw name in the three tag families
  this app writes — ID3v2 (`TIT2`, `TPE1`, …), Vorbis Comments (`TITLE`,
  `ARTIST`, …), MP4/iTunes atoms (`©nam`, `©ART`, …) — including the app's
  own private `Unknown(TRACKID)` field's real name per family.
- `familyForFormat()` maps a file extension to its tag family (mp3/wav/aiff
  → ID3v2, flac/ogg → Vorbis, m4a/aac → MP4); `dominantFamily()` picks the
  most common family across the loaded collection.

**Simplified vs. the original plan:** a table header is one label shared by
every row, so it can't literally "follow the format of the selected file"
per-row — it uses the collection's dominant family instead, with
`rawNameTooltip()` listing every family's name on hover so a mixed
collection is never misleading. Only table headers were wired up; the Clear
Fields checklist and the strip preview still show the friendly name
regardless of this setting — left as a follow-up rather than done partway.

### 28. Primary / secondary DJ app — v0.7
Settings → **DJ Software**: Primary and Secondary pickers (Rekordbox,
Serato DJ, Traktor, Engine DJ, VirtualDJ, djay, Mixxx, Other/none) — stored
now, for the recommended backup field below and as the app's own record of
the user's setup ahead of the v0.9 export targets.

- `recommendedBackupField(app)` in [types.ts](src/types.ts): Rekordbox
  reads Original Artist for the searchable backup; every other app here
  relies on Comment. When the current `backupField` doesn't match the
  primary app's recommendation, a note explains the mismatch with a one-click
  **Use it** button — it never silently changes the setting itself.
- Traktor's 0–255 internal rating scale is noted next to the picker (it's
  still shown/edited as 0–5 stars here either way — this is informational,
  not a scale-conversion feature).

**Simplified vs. the original plan:** the secondary app is stored but
nothing is written to a second field yet — "the secondary app's field
written too when the two differ" needs `write_tags_blocking` and
`backup_file_blocking` to accept and write a *second* backup field
(currently one `Option<String>` each), which is real Rust surface area
without a second real-world backup target to test against yet. Left for
whichever v0.9 export item first needs it, rather than built speculatively
now.

### 29. Split Standardize into separate Capitalization / Characters tools — v0.7
The old **Standardize** button ran `applyReplacements()` (character/separator
rules) and `applyCapitalization()` back to back with no way to run just one.
It turned out **Remove Chars** was already its own button (a *different*,
narrower thing — stripping a fixed literal character set from Settings, not
the feat./bracket/dash/junk-suffix rules) — so the real gap was pulling
capitalization and the character rules apart from each other, not from
Remove Chars.

- New [CapitalizationMenu.tsx](src/components/CapitalizationMenu.tsx) — the
  same split-button pattern as `ClearFieldsMenu`: the left half re-runs the
  remembered mode, the caret opens a one-click list of every mode. Picking
  one runs it immediately and becomes the new remembered default
  (`settings.capitalization`).
- Added the missing **Sentence case** mode to `applyCapitalization()`
  ([standardize.ts](src/lib/standardize.ts)) and the `Capitalization` type —
  the roadmap listed it but it didn't exist yet.
- New **Characters** button runs just `applyReplacements()` — the feat./
  bracket/dash/junk-suffix/whitespace rules from Settings, with no recasing.
- **Standardize** is unchanged: still runs both together in one pass, for
  the original one-click behaviour.
- `CAP_OPTIONS` moved from SettingsPage.tsx into types.ts (next to the
  `Capitalization` type) so the new toolbar component isn't importing
  constants out of a page module.

All three still build the same before/after pending-change preview as
before — no changes were needed there.

### 30. Library browser sidebar — v0.7 (v0.7 complete)
New [LibrarySidebar.tsx](src/components/LibrarySidebar.tsx): a collapsible,
resizable pane (drag the right edge, 160–420px, width and collapsed state
persisted to `settings.sidebarWidth`/`sidebarCollapsed`) to the left of the
track table, with a Folders / Genres / Artists mode switcher and its own
search box that filters the tree/list itself.

- **Folders** — a real nested tree built from every loaded file's path
  (`buildFolderTree()`), not just a flat list of parent directories; each
  folder shows its track count (including subfolders) and expands/collapses
  independently. Clicking a folder filters the table to that folder and
  everything under it.
- **Genres** / **Artists** — flat, count-sorted lists tallied directly from
  `TagData.genre`/`artist` with **no** near-duplicate merging — this is for
  exact-match browsing, not the fuzzy grouping Detect Genres (item 26) does,
  so what you click is exactly what you'll see. Clicking one filters to an
  exact match.
- Clicking the active filter again clears it; a banner shows the current
  filter with its own clear button. The filter narrows the `files` array
  passed into `TrackTable`, so it composes with — sits underneath — the
  table's own existing search/flagged filters rather than replacing them,
  and never triggers a disk rescan.

**Simplified vs. the original plan:**
- **Playlists** mode isn't included — there's no playlist import feature
  yet (that's v0.9 F4/F5), so it would have nothing to show.
- **Artists** is a flat list, not "expandable to that artist's tracks" —
  clicking an artist already filters the whole table to their tracks, which
  covers the same need without a second, nested tree UI.
- **Ctrl-click for unions** (selecting multiple folders/genres/artists at
  once) isn't implemented — one active filter at a time, click again to
  clear. Left as a follow-up if single-selection turns out to be limiting
  in practice.

### 31. Find duplicates by audio content — v0.8 F1
New Rust module [duplicates.rs](src-tauri/src/commands/duplicates.rs), three
stages as planned:

1. **Exact** — a blake3 hash of the file bytes.
2. **Fingerprint** — `rusty-chromaprint` (confirmed pure Rust: pulls in only
   `rustfft`/`realfft`/`rubato`, no C library or external binary) computes
   the fingerprint from PCM decoded by `symphonia` (also pure Rust). Both are
   cached in a local sqlite database (`rusqlite`, `bundled` feature — SQLite
   compiles from source, no external DLL needed) at
   `app_data_dir()/fingerprint-cache.sqlite`, keyed by path + mtime + size,
   so re-scanning an unchanged library only touches the exact-hash step.
   Only the first ~2 minutes of audio is decoded per file — plenty for a
   fingerprint match, far cheaper than decoding a whole DJ mix start to end.
3. **Match** — `rusty_chromaprint::match_fingerprints` returns alignment-
   tolerant segments; the *largest* segment's `.score` (chromaprint's own
   0–32 similarity measure, lower = more similar) and **coverage** (that
   segment's duration versus each file's own duration) drive classification.

**Radio edit vs. extended mix**, built exactly as planned: high similarity
**and** high coverage on **both** sides → `"duplicate"`; high similarity but
coverage only high on the *shorter* file → `"alternate"` (never suggested
for deletion). Verified with a dedicated test
(`radio_edit_inside_extended_mix_classifies_as_alternate_not_duplicate`)
using a synthetic melody embedded inside a longer one with a different
intro/outro — confirmed it classifies as Alternate, not Duplicate. Two more
tests confirm identical audio scores as a strong match and two different
melodies don't; a further two exercise the real file-decode path (a
synthesized WAV written to disk) and the sqlite cache actually being reused
on a second call. All 5 pass.

Transitively-related files (A matches B, B matches C) are merged into one
group via union-find rather than emitting overlapping pairs; a cluster is
only labeled `"duplicate"` if *every* compared pair inside it was a
duplicate match — one alternate-version pair downgrades the whole cluster,
so a radio edit + its extended mix + a byte-identical copy of the radio
edit doesn't get mislabeled as all being the same file. Progress is reported
via a `duplicate-scan-progress` event (the same `AppHandle::emit` pattern
`components.rs` already uses for download progress).

**Caveat, stated plainly:** the similarity/coverage thresholds
(`DUPLICATE_SCORE_MAX`, `DUPLICATE_MIN_COVERAGE`, etc.) are a reasoned
starting point, not a scientifically calibrated cutoff — they were validated
against synthetic sine-wave/melody fixtures (the only audio available in
this environment), not real music. They may need tuning against an actual
library; the constants are isolated at the top of the file specifically so
that's easy to do without touching the algorithm itself.

### 32. Duplicate review UI — v0.8 F2
New [DuplicatesPage.tsx](src/pages/DuplicatesPage.tsx), reachable from a new
**Duplicates** sidebar nav item:

- **Scan for Duplicates** runs the v0.8 F1 engine over every loaded file,
  with a live progress bar driven by the `duplicate-scan-progress` event.
- Results as groups, each row showing format, bitrate, sample rate,
  duration, file size, artwork presence and a tag-completeness count — the
  facts item 32 asked for, computed from the existing `AudioFile`/`TagData`
  the app already loads (extended `AudioFile` with `bitrateKbps`/
  `sampleRateHz` from lofty's `FileProperties`, which weren't surfaced to
  the frontend before this).
- An auto-suggested keeper (lossless format → highest bitrate → most
  complete tags → path as a deterministic last resort) is pre-selected as
  **Keep**, every other file in a `"duplicate"` group defaults to
  **Remove**; every file in an `"alternate"` group defaults to **Skip**
  (never auto-suggested for removal). Every row is a three-way
  Keep/Remove/Skip toggle, always overridable.
- Nothing is deleted until **Remove N to Recycle Bin**, which shows the
  exact count and total size and reuses the existing `delete_file` command
  — already Recycle-Bin-based, not a hard delete, so no new Rust command was
  needed for removal itself.

**Simplified vs. the original plan:**
- No **keeper rule bar** ("prefer FLAC", "prefer highest bitrate" applied
  across every group at once) — each group is reviewed individually. The
  per-group auto-suggestion already applies a sensible default rule; a bulk
  override bar is a reasonable follow-up if reviewing many groups by hand
  turns out to be tedious.
- **"Oldest path" tie-break** isn't really oldest-by-date — `AudioFile`
  doesn't carry file mtime to the frontend, so the tie-break after
  format/bitrate/tags is alphabetical path order instead. Surfacing mtime
  would be a small, isolated follow-up.
- **No undo manifest** and **no tag/artwork merge into the keeper** before
  removal — deletion goes to the Recycle Bin (itself a form of undo via the
  OS), but the specific "written alongside" manifest and the merge step
  weren't built.
- **No quarantine-folder option**, only the Recycle Bin.

### 33. Waveform preview — v0.8 F3 (completes v0.8)
`decode_to_pcm_capped()` in [duplicates.rs](src-tauri/src/commands/duplicates.rs)
was generalized to take an optional sample cap: fingerprinting still decodes
only the first ~2 minutes (`decode_to_pcm`), while a new `decode_full()`
decodes the whole file for a waveform's true shape — needed because a
fingerprint-only decode would truncate any track over 2 minutes to a
misleadingly short waveform. `compute_waveform_peaks()` downsamples the
decoded PCM (channels averaged to mono first) to 400 peak buckets; a new
`get_waveform` command caches them in the *same* `file_cache` sqlite table
the fingerprint cache uses, in a `waveform_peaks` column, keyed the same
way (path + mtime + size).

**A real bug found and fixed while building this:** the fingerprint cache
and the waveform cache are populated independently (whichever is requested
first), so the table's schema had to become "every non-identity column is
nullable, both sides upsert by path." A naive upsert — write your own
columns, leave the other side's alone — turns out to be unsafe: if a file
changes between the two writes, whichever write happens *after* the change
stamps the row with the new mtime/size while the *other* side's still-old
cached value is left in place, silently marking stale data (fingerprint or
waveform, whichever wasn't just recomputed) as valid for the new file
content. Fixed with a `CASE WHEN file_cache.mtime = excluded.mtime AND
file_cache.size = excluded.size THEN <old value> ELSE NULL END` guard in
both upserts, so the other side's cached value survives only when the file
genuinely hasn't changed. Caught by a dedicated test
(`waveform_and_fingerprint_caches_survive_each_other`) that writes a
fingerprint, then a waveform, and checks the fingerprint is still intact —
this would have been a real, silent duplicate-detection correctness bug
against a real library where files get edited between scans.

New [Waveform.tsx](src/components/Waveform.tsx): fetches and in-memory
caches peaks per path, renders as an SVG bar chart, with an optional
`progress` prop that draws a playhead line. Wired into:
- **Genre Mode's bottom strip** ([TrackTable.tsx](src/components/TrackTable.tsx)) —
  the current track's waveform with a live playhead synced to `gmTime`/`gmDuration`.
- **Duplicate review** ([DuplicatesPage.tsx](src/pages/DuplicatesPage.tsx)) —
  every file in a group shows its own waveform stacked under the next,
  making "same master, different length" (or a genuinely different
  recording) visible at a glance, exactly as planned.

**Not built:** using the waveform to expose song structure (intro/
breakdown/drop) for genre passes — the peaks are shown, but no structural
analysis (energy-based section detection) was added on top of them; and the
per-row `AudioPreview` prelisten scrub bar (used throughout the main track
table, outside Genre Mode) still uses a plain range input rather than this
waveform, to avoid restructuring an already-stable, widely-used component
in this pass.

This completes v0.8 (items 31–33: duplicate detection, review, waveform).

### 34. Real-library validation of duplicate detection — v0.8.2
Item 31 shipped calibrated only against synthetic sine-wave/melody fixtures
(the only audio available in that environment) — this item is running it
for real, against the user's own collection, and fixing what that turned up.

**Method:** `scan_duplicates_blocking` was split into a Tauri-independent
`scan_duplicates_core(conn, paths, on_progress)` — same production logic,
takes a plain `Connection` and a progress closure instead of an `AppHandle`
— so it can run from a `#[ignore]`d test outside a running app. Pointed at
`C:\Users\sopas\Music\backup` (484 real MP3s of varied bitrate/source):
~106s end to end (~0.22s/file), 9 groups on the first pass.

**Result — genuinely valuable, not clean on the first try:**
- 7 of 9 groups were correct real duplicates on the very first run, several
  non-trivial: an app-generated-Track-ID naming variant, a featured-artist
  retag ("Sao Paulo" / "The Weeknd- Anitta - Sao Paulo"), and straight
  re-downloads — all scoring 0.00–0.66 out of a 0–32 scale.
- **One real false positive**: three completely unrelated songs (Brutalismus
  3000 / Michael Sembello / The Police) clustered as "alternate version"
  (score 9.55). Diagnosed with a new `diagnose_pair` test that prints exact
  matched-segment timestamps rather than just the summary classification —
  it showed a genuine 46.6s audio match, but positioned at 0:00–0:47 in one
  file and 0:57–1:43 in the other: the signature of a shared promotional
  jingle/station-drop prepended by whatever tool the files were downloaded
  through, not the same recording.
- **One real under-classification**: a genuine duplicate pair ("Pitbull -
  Hotel Room Service") landed as "alternate" (score 2.34) instead of
  "duplicate", because the two re-encoded copies matched across 5 separate
  segments with small gaps between them (re-encoding artifacts), and
  `classify_pair` only measured coverage from the single largest segment —
  36.6s out of 120s, well under the 85% duplicate threshold.

**What was tried and reverted — worth recording so it isn't tried again the
same way:** to fix the under-classification, coverage was changed to span
every matching segment (first segment's start to last segment's end) instead
of just the biggest one, and score to a length-weighted average across all
segments. Re-run against the same 484 files: **14 groups, most of them
wrong** — unrelated songs merged as "duplicate" (score 8.87, 9.64, 9.57),
and one 14-file cluster combining completely unrelated tracks. Root cause:
several scattered, individually brief coincidental matches (shared drum
patterns/timbral similarity, common across unrelated electronic/pop
production) spread a first-to-last "span" across nearly a whole file, which
reads as high coverage despite almost none of the content actually
matching — span conflates "matched over a wide range" with "matched
densely," and real files apparently produce enough scattered noise for that
distinction to matter. **Reverted to single-largest-segment coverage** —
the under-classification bug stayed (recorded above, now backlog), rather
than trade it for something worse.

**What actually shipped, verified against the real false positive AND a
clean re-run of all 8 remaining groups:** `ALTERNATE_SCORE_MAX` tightened
from 14.0 to 6.0. Diagnostic data showed score was the reliable separator
all along — the shared-jingle false positive scored 9.55, while the
synthetic radio-edit/extended-mix fixture (item 31's own test) scored 0.03
— a wide, dependable gap that coverage-tuning alone couldn't replicate
(the false positive's coverage, 0.39, and the genuine synthetic case's,
0.44, were too close together to separate on that axis). Also added
silence removal to the shared fingerprint config (`with_removed_silence`)
on the hypothesis that quiet intros/outros were the cause — measurement
showed identical scores with or without it, so it did *not* explain this
particular false positive, but is a real, independently-justified
improvement (near-silent audio genuinely carries little discriminating
chroma information) kept regardless.

Re-run after the fix: **8 of 8 groups correct** — the false positive is
gone, all 7 duplicate pairs and the one under-classified-but-real alternate
pair are intact, no new false positives. Two new permanent test fixtures:
`diagnose_pair` (point it at any two real files, prints exact segment
timestamps/scores) and `real_library_scan_smoke_test` (point it at a real
folder, runs the actual production pipeline). Both `#[ignore]`d — opt-in via
env vars, not part of the normal suite — since they need real audio files
this repo doesn't ship.

**Left as backlog, not fixed:** the Hotel Room Service-style
under-classification (a genuine duplicate fragmenting into several segments
lands as "alternate" rather than "duplicate") is still present — it's a
real limitation, not a regression, and safer to leave than to re-attempt
with the span-based approach that made things worse. A cache schema/
algorithm-version stamp is also still missing (see Backlog) — this session
hand-cleared the sqlite cache directory before each re-test since
`fingerprint_config()` changed; without a version stamp, a *future* config
change could silently compare fingerprints computed under two different
configs against each other.

**Round two — a second, larger, more diverse real folder (v0.8.3):**
`C:\Users\sopas\Music\Collection`, 3726 files, mostly dance/EDM — a genuinely
different test of the same fix. First pass at `ALTERNATE_SCORE_MAX = 6.0`
found 41 groups, but **6 more shared-jingle false positives** slipped
through — clusters of unrelated artists across trance, indie pop and
techno, scoring 4.84–5.93, all clustered right under that ceiling. One
confirmed with `diagnose_pair`: two completely unrelated tracks (Angelo
Ferreri, Armin Van Buuren) both matching from 0.0s/1.2s — the same
"matches from the very start of the file" signature as the first false
positive. Meanwhile every *genuine* alternate found in this run — same-song
variants, edits, even a legitimate mashup that samples another track —
scored 3.14 or lower. That gap (genuine: 0.03–3.14, shared-jingle false
positives: 4.84–9.55) is now consistent across two independent real
libraries, so `ALTERNATE_SCORE_MAX` was tightened again, 6.0 → 4.0.
Re-verified against the same 3726 files (fast this time — the fingerprint
cache was already warm from the first pass, so this only re-ran the
comparison stage, ~278s instead of ~1170s): **35 groups, exactly the 6 false
positives gone, every remaining score ≤3.14** — no new omissions or false
positives introduced.

### 35. Simple backup archive — v0.9 F6
New **Backup Archive** button in the Library toolbar (distinct from the
existing tag-level "Backup"/"Restore" — this one archives whole *files*,
not tag snapshots): picks the ticked selection, or the whole loaded
collection if nothing's ticked, and writes a single **store-only ZIP**
(`CompressionMethod::Stored` — audio doesn't compress, and storing keeps it
fast and byte-exact) via the new [backup_archive.rs](src-tauri/src/commands/backup_archive.rs).

- A size estimate (from the already-loaded `AudioFile.size` values, no new
  Rust command needed) is shown in the confirm dialog before anything runs.
- The generated filename follows the planned pattern exactly:
  `MusicTagCleaner-backup-2026-09-02-1432-412-tracks.zip`; the user still
  picks the destination folder via the native save dialog.
- Progress reported via a `backup-archive-progress` event (the same
  `AppHandle::emit` pattern used elsewhere), shown in the existing status
  bar progress UI rather than new UI.
- Each entry is stored at a collision-proof path derived from the file's
  original absolute path (`C:\Users\x\Music\a.mp3` → `C/Users/x/Music/a.mp3`
  inside the zip) rather than flattened by filename, so two same-named files
  from different folders never collide and the original layout is
  recoverable.
- A `manifest.json` is written as the last entry, listing every file's
  original path, its path inside the archive, size, and a blake3 hash (the
  same hashing already used for exact-duplicate detection) — enough to
  verify or restore the archive later without opening every audio file. A
  `read_backup_manifest` command can read it back out of an existing zip
  without extracting anything else, though no frontend UI calls it yet
  (see below).
- On success, `revealItemInDir` (the frontend `@tauri-apps/plugin-opener`
  API — not previously used, only `openUrl` was) highlights the finished
  file in Explorer.
- Three Rust tests: the path-to-entry-name conversion (both backslash and
  forward-slash inputs), and a full round trip that writes a real archive,
  reads it back, and checks the stored bytes are byte-identical, the
  compression method is genuinely `Stored`, and the manifest parses with
  the right track count.

**Not built:** no UI to browse/verify an existing backup's manifest (the
`read_backup_manifest` command exists but nothing calls it yet) — left for
if it turns out to be needed, rather than built speculatively now.

### 36. Rekordbox cue import — v0.9 F5
New **Import Rekordbox Cues** button on the Settings page: picks a
`rekordbox.xml` export via a file dialog and reads every track's memory
cues, hot cues, loops, and beat grid/BPM out of it, via the new
[rekordbox_import.rs](src-tauri/src/commands/rekordbox_import.rs). Read-only
— nothing is ever written back to Rekordbox.

- Cues are stored keyed by **audio fingerprint, not file path** — reusing
  the exact same Chromaprint pipeline and sqlite cache `duplicates.rs`
  already built for duplicate detection (`get_or_compute`, `open_db` were
  made `pub(crate)` for this reuse). This means a cue survives a rename or a
  move; only a genuine re-encode changes the fingerprint.
- `rekordbox.xml`'s `TRACK` entries are parsed with a streaming `quick-xml`
  reader: `POSITION_MARK` elements with `Type="0"` and both a `Start` and
  `End` attribute become loops; the rest become hot cues (`Num >= 0`, giving
  the pad 0–7) or memory cues (`Num` negative/absent). `TEMPO` elements
  build the beat grid. Locations are `file://localhost/`-prefixed,
  percent-encoded paths (`%20`, multibyte UTF-8 escapes included) —
  `location_to_path()` strips the prefix, percent-decodes, and flips
  slashes for Windows.
- Progress reported via a `rekordbox-import-progress` event, shown next to
  the button; the result notification reports tracks matched vs. total,
  how many source entries weren't found on disk, and any per-track errors.
- The [Waveform](src/components/Waveform.tsx) component now accepts
  optional `cues`/`durationSecs` props and draws memory cues, hot cues (with
  Rekordbox's default pad colors when the XML has none), and loop regions
  as an overlay, positioned by `positionSecs / durationSecs`. Genre Mode's
  waveform strip in [TrackTable.tsx](src/components/TrackTable.tsx) fetches
  `get_cues_for_path` for whichever track is showing (cached per path,
  keyed off the same `anchorPath` the strip already tracks) and passes the
  result straight through.
- 5 Rust tests (4 passing, 1 `#[ignore]`d real-data test): percent-decoding
  (plain and multibyte UTF-8), a full parse of a real trimmed XML excerpt
  with cues/hot cues/a loop, and a SQL round trip confirming cues survive a
  path change under the same fingerprint but don't match a different one.

**Validated against the user's real `rekordbox.xml`** (145 KB, 89 `TRACK`
entries): parsed all 89 entries; 88/89 found on disk (one file — `Kye
Gibbon - Saving My Life.flac` — correctly reported missing); of the 88
found, 85 had memory cues, 86 had hot cues, 46 had loops, and all 89 had
tempo/beat-grid data.

**Not built:** ANLZ `.DAT`/`.EXT` sidecar parsing (mentioned as a maybe in
the original roadmap item) — `rekordbox.xml` already carries every cue type
tested against real data, so the extra analysis-file format wasn't needed.
Writing cues back out to Rekordbox/Serato/Traktor remains explicitly
out of scope, as planned.

### 37. YouTube Music playlist → Rekordbox — v0.9 F4
New **YT Music Import** page: paste a YouTube Music (or plain YouTube)
playlist URL, fetch its track list via `yt-dlp` (metadata only — nothing is
ever downloaded), match it against the loaded collection, and export a
Rekordbox playlist. Via the new
[ytmusic.rs](src-tauri/src/commands/ytmusic.rs),
[ytMatch.ts](src/lib/ytMatch.ts) and
[rekordboxExport.ts](src/lib/rekordboxExport.ts).

- **yt-dlp is treated as an optional external tool**, the same pattern
  `components.rs` already uses for Ollama: `ytdlp_info` detects it (a
  bundled copy in the app's own data dir first, then anywhere on `PATH`,
  so a system-wide install via pip/a package manager is picked up too),
  `install_ytdlp` downloads the standalone GitHub-release binary straight
  into the app's data dir if it's missing — no installer, no PATH changes.
- **One request per playlist, not one per track:** `fetch_ytmusic_playlist`
  runs a single `yt-dlp -J --flat-playlist` call. This was a real design
  decision, not an assumption — empirical testing against real playlists
  during development (see below) found that per-video fields like
  `track`/`artist`/`album` come back empty even for videos on an artist's
  own official channel in this yt-dlp version, so a slower per-video fetch
  wouldn't have reliably bought more accuracy anyway. The flat call reliably
  returns `id`, `title` and `duration` for every entry, which is what the
  matching step is actually built around.
- **Matching works from title text and duration, not structured fields**
  (`ytMatch.ts`): each entry's title is split on an "Artist - Title"-style
  separator (falling back to the uploading channel, minus a trailing
  " - Topic", as an artist signal when there's no separator to split on),
  then scored against every loaded track's tags via a normalized Levenshtein
  similarity — diacritic-folded the same way `sanitizeForFilenameStrict`
  does, with common clutter like "(Official Video)"/"(Lyrics)"/"[HD]"
  stripped first. A second scoring pass compares the *whole* cleaned title
  against the tag's combined "artist title" text, so a video title with no
  separator at all (surprisingly common — see below) isn't unfairly
  penalized for being compared only against the tag's title field; the
  better of the two scores wins. Duration closeness (within 2s counts full
  weight, tapering to zero past 15s) contributes a smaller share.
- **Three-tier result, matching the roadmap's "an 80% match asks, it never
  silently accepts":** ≥90% auto-matches, 55–90% is flagged "Confirm" with
  its best candidate shown (one click to accept, or pick a different track
  from the whole collection via the existing `Combobox`), below 55% is
  "Missing". Any resolved row (matched or confirmed) can be marked missing
  instead, and any decision can be reset back to automatic.
- Each entry links back to its YouTube Music page (`openUrl`); missing
  entries can be copied to the clipboard as a plain title list for a
  hand-off to Media Fetch, satisfying the roadmap's third list without a
  separate tab — the single results table already shows the full source
  playlist in its original order.
- **Export, not a new Rust surface:** both `.m3u8` and Rekordbox-XML export
  are built as plain strings in `rekordboxExport.ts` from data already in
  memory (loaded tags/files) and written via the existing generic
  `write_text_file` command — no new file-writing Rust code needed. The XML
  follows the same TRACK-attribute/NODE-Type schema `rekordbox_import.rs`
  (item 36) already reads back correctly, and `Location` is built as the
  exact inverse of that module's `location_to_path()`.
- 6 Rust unit tests for the flat-playlist JSON parsing (entries-wrapper and
  single-video shapes, `null` entries for removed/private videos, entries
  missing an `id`, an empty playlist, the `uploader`/`channel` fallback)
  plus one `#[ignore]`d real-network test.

**Validated against real YouTube data before writing the matching logic**,
not just fixtures: fetched a real channel's uploads playlist through both
`youtube.com` and `music.youtube.com` URLs for the same list ID (confirming
both domains route through yt-dlp's same extractor) and inspected several
real "official" video/track pages directly. This is what showed
`track`/`artist`/`album` aren't reliably populated even for legitimate
official-channel uploads — including Rick Astley's and The Weeknd's own
"Official Video" uploads — which is why the matching step leans on the
title/duration heuristic above rather than assuming those fields exist. The
real-network Rust test (`real_playlist_fetch_smoke_test`) was also run for
real (not left unverified) against a live playlist and confirmed the exact
JSON shape `parse_playlist_json` expects.

**Not built / unverified:** the Rekordbox-XML export path matches the
documented schema and what this app's own importer (item 36) reads back
correctly, but — unlike that importer — it hasn't been round-tripped
through a real Rekordbox install (none available in the dev environment);
treat a first import as unverified until it's been tried once. Fingerprint
confirmation for near-miss matches (mentioned as an option in the original
roadmap item) wasn't built — title+duration scoring already resolves
real playlists cleanly enough in testing that the extra fingerprinting
pass didn't look worth the cost.

### 38. FFmpeg component + format conversion + cross-format track grouping — v0.10

Three linked features. The trigger was the user (who conflates this app with
the sibling Media Fetch, where FFmpeg already lives) asking to "show ffmpeg in
components" and build conversion on top of it.

**F1 — FFmpeg as an optional managed component**
([ffmpeg.rs](src-tauri/src/commands/ffmpeg.rs), new). Same pattern as `yt-dlp`
in `ytmusic.rs` and Ollama in `components.rs`: `resolve_ffmpeg()` prefers a
copy we downloaded into `app_data_dir()/bin`, then anything on `PATH` (plus the
Homebrew dirs on macOS). `install_ffmpeg` (Windows only) pulls the latest
`ffmpeg-master-latest-win64-gpl.zip` from `BtbN/FFmpeg-Builds`, streams it with
`ffmpeg-install-progress` events, and extracts just `ffmpeg.exe` + `ffprobe.exe`
(the `wanted_zip_entry` matcher, unit-tested); macOS/Linux get a "install it
with brew/apt" message and PATH detection. The `zip` dep gained
`features = ["deflate-flate2"]` (it was `Stored`-only for the backup archive;
BtbN's zip is DEFLATE). New **FFmpeg** card on the Components page between
Ollama and Models — status (Installed / On PATH / Not installed), version +
path tiles, an Install button with a progress bar.

**F2 — Convert to different formats**
([convert.rs](src-tauri/src/commands/convert.rs), new;
[ConvertDialog.tsx](src/components/ConvertDialog.tsx), new). Nine presets
(`mp3-320`, `mp3-v0`, `flac`, `alac`, `aac-256`, `wav`, `aiff`, `ogg-q8`,
`opus-192`) in one unit-tested `ffmpeg_args` builder — `-map_metadata 0`,
audio-stream map, and `-c:v copy` art passthrough for the containers that can
hold it. **After the encode, the source's tags are re-applied to the output
with `write_tags_blocking`** (made `pub(crate)`), including the private
`TXXX:TRACKID` frame — so a converted copy lands already carrying the Track ID
that groups it with its original (F3), no matter how faithfully the container's
own metadata survived. Toolbar **Convert** button + right-click menu entry;
`convert-progress` events drive the status bar; results are merged into the
library, with an optional "move originals to Recycle Bin" and "converted/"
subfolder option. Preset/location defaults persist to
`settings.convertPreset`/`convertOutput` (settings v5). If FFmpeg is missing
the dialog shows a "required — go to Components" panel instead.

**F3 — Group the same recording across formats under one Track ID**
(frontend only — reuses `scan_duplicates` unchanged). New toolbar **Unify IDs**
action: runs the existing chromaprint duplicate scan over the loaded files,
takes the `kind: "duplicate"` clusters (same recording, includes re-encodes
across formats; `"alternate"` edits/remixes are counted but left alone), and
for each cluster picks a canonical Track ID — an existing app-assigned id on
one of the members, or a freshly generated one — then previews the change in
[UnifyDialog.tsx](src/components/UnifyDialog.tsx) before writing it to every
member via the normal undoable `updateField` path. The library sidebar gains a
**Tracks** mode ([LibrarySidebar.tsx](src/components/LibrarySidebar.tsx))
listing multi-format groups with format badges; clicking one filters the table
to that group (`SidebarFilter` gained a `"group"` variant keyed by Track ID).
The Track ID cell in [TrackTable.tsx](src/components/TrackTable.tsx) shows a
small link glyph when other loaded files share the id. Grouping is built on
`buildTrackGroups`/`trackIdFormats` in
[trackGroups.ts](src/lib/trackGroups.ts).

**Also — right-click row menu** ([TrackTable.tsx](src/components/TrackTable.tsx),
requested mid-build): Open, **Open with…** (Windows `shell32` "OpenAs_RunDLL"
chooser via the new `files::open_with` command, so a track can be handed
straight to a converter or player), Reveal in File Explorer, Copy path,
Convert…, Inspect tags, Delete.

**Simplified / not built:** no collapsible group rows inside the virtualized
track table (sidebar + badge only, as scoped with the user); no
loudness/sample-rate/bit-depth conversion UI beyond the fixed preset list; no
separate "release group" id — grouping is strictly same-recording; no
auto-unify on import (kept an explicit, previewed action); macOS "Open with…"
falls back to Finder reveal (no CLI chooser exists). FFmpeg auto-install is
Windows-only, same as Media Fetch's.

**Verification:** `ffmpeg_args`/preset/zip-matcher unit tests pass; an
`#[ignore]` `convert_roundtrip_carries_tags` test (synth WAV → MP3) confirms
title + Track ID carry over when run with ffmpeg on PATH. [App-level end-to-end
verification against the real library is the remaining step — see the plan's
verification section.]

### 39. Load/write performance, Clean Tags retired — v0.11

**Problem.** Applying a preview to a real selection (848 tracks) took over ten
minutes. Benchmarking the write itself on copies of 40 real tracks (1.1 GB)
showed only **62 ms/file** — about 53 s for the whole run. The rest was
overhead: `applyStrip`/`applyUpdates` did one `invoke` **and** one React
re-render per file, so 848 files meant ~1,700 IPC round trips and 848 full
re-renders of an 848-row table.

**Batched writes.** New commands `files::write_tags_batch`,
`files::write_raw_fields_batch`, `files::backup_files_batch` and
`backup::restore_from_backup_batch` write across `par_map`'s threads and report
progress through a throttled `write-progress` event (~50 per run, not one per
file). Every bulk path now goes through them — Apply, multi-select cell edits,
ratings, Generate IDs, Unify IDs, undo/redo replay, Backup, Restore. Backup and
Restore go in chunks of 32 so their Stop button stays responsive; the others
send the whole run in one call. Measured in the UI on 848 files: **2 IPC calls
instead of ~1,700**, and the parallel write is 22 ms/file — roughly
**10 min → ~20 s**, nearly all of it now real disk work.

`writeBatch` requires **at most one item per path**: two writes to one file
would land on different threads and one would be lost. `useHistory` folds every
change for a file into a single write for exactly this reason (an entry of
"4,240 changes across 848 files" issues 848 writes, verified).

**Load speed.** `read_cover_thumbnails` / `image_info_batch` replace the
one-file-at-a-time thumbnail loaders (96 files: 1.18 s → 366 ms of compute, 96
round trips → 2). `file_info` now parses with `ParseOptions::read_cover_art(false)`
— it only ever wanted duration/bitrate/backup presence, and was pulling every
track's embedded JPEG into memory (300 files: 287 ms → 126 ms; verified
byte-identical properties and text tags across 391 real files). The table's tag
read is chunked at 200 files so a big folder paints its first rows immediately.
Non-Library pages and the three dialogs are `React.lazy` chunks prefetched on
idle (launch bundle 405 kB → 181 kB app + 142 kB React), and the startup
`ffmpeg_info` probe moved to that same idle window.

**Clean Tags removed** (user request — Clear Fields does the same job, visibly).
Gone: the toolbar button, `runCleanTags`, `buildStripPreview`, `applyStrip`, the
`"strip"` preview mode and its branch of the dedicated preview table. The
**"Strip to common tags only"** setting went with it (settings **v6**): it also
silently dropped every non-common frame on each AI Clean / Standardize / Genre
apply, which is the same bulk removal, just invisible. Nothing removes a tag
field now except an explicit Clear Fields run. Clear Fields' dropdown gained an
**All / None** shortcut for the raw-frame group, so the old one-click behaviour
is still one click — but previewed and unpickable per field.

Verified that "All Tags" really does surface everything: on 590 files from the
real library, `all_fields` contained every text item of every tag — no file had
a second tag hiding fields and no field was binary-only.

**Also:** `artworkMaxDim` default 1000 → **600 px**; the v6 migration moves
existing settings to 600 only if they were still on the old default. Undo/redo
extracted from `App.tsx` (1,922 lines) into
[useHistory.ts](src/hooks/useHistory.ts).

**Verification.** `tsc`, `cargo clippy` and all 41 Rust tests clean. The UI was
driven end-to-end against a mocked Tauri IPC with 848 files: load, all five lazy
pages, Clear Fields → Apply → Undo → Redo (call counts and toasts as above),
"All Tags" columns, and the Settings changes. The packaged app was not launched —
worth a Clear Fields run on a small folder before a large one.

### 40. v0.11 follow-ups: the post-write freeze, All Tags, drag, flagging — v0.11.1

All six reported against v0.11.0.

**The app froze after an apply** (AI Clean, Capitalization — any Apply). Measured
before touching anything: React was never the problem (worst commit 46 ms,
via a temporary `<Profiler>`). The cost was `afterWrite` dropping the cover-art
cache for *every* affected file after *every* tag write, so applying to 848
tracks regenerated 848 thumbnails — decode, resize, re-encode, base64. At the
3.8 ms/file benchmarked in item 39 that is **~3.2 s with every core pegged**,
immediately after the write.

None of it was needed: `write_tags` carries the existing pictures over while
"Preserve embedded cover art" is on, so the cached thumbnails were still valid.
The cache is now dropped only when the write could actually have changed the
art (`!preserveCoverArt`); `restore_from_backup` re-pushes the current pictures
too, so it is safe there as well. Verified: applying to 848 files now
regenerates **0** thumbnails.

The user's other clue — "my cursor changes like it is text everywhere" — was the
same fault: with every core busy the WebView renderer is starved and Windows
keeps showing the last cursor set, which over the table is the I-beam from the
editable cells. Two follow-ons: `par_map` now leaves one core free
(`available_parallelism() - 1`, clamped 1–8) instead of always spawning eight
and oversubscribing anything smaller, and the post-write refresh shows
"Refreshing library…" rather than going silent.

**"All Tags" hid columns switched off in the Columns menu.** `extraColumns`
skipped every `KEPT_FIELD_KEYS` raw frame to avoid duplicating a curated column
— but that set is fixed while a column's visibility is not, so hiding "Track #"
lost `TrackNumber` entirely (same for Album Artist, Disc #, Composer, Comment,
Original Artist). All Tags now also restores hidden *curated* columns that have
data, keeping the friendly label, editor and numeric sort (Track # shows
"1/12", not the raw "1"). The button's count covers what it adds, and a
restored column no longer carries the raw frame's "clear it to delete this
field entirely" tooltip.

**Column drag-and-drop showed the "no drop" cursor.** Three compounding HTML5
bugs in the header: `dragstart` never called `setData`, so Chromium treated the
drag as carrying nothing and refused every target regardless of what `dragover`
replied; `dragenter` never called `preventDefault()`; and `dragover` never set
`dropEffect`. The reorder logic itself was fine.

**Generate IDs** was already parallel (it goes through `write_tags_batch`) but
reported no progress — now wired to the same `write-progress` events, verified
showing "Assigning ID 30 of 60" mid-run.

**Flagged characters are now visible and editable** (`settings.flagExtraChars`,
default `"()"`): Settings spells out the built-in rule via `ALLOWED_DESCRIPTION`
and adds an "Also flag these characters" box with a Reset link. Brackets are
flagged out of the box, as asked.

**Light-theme highlight was invisible.** The flagged-symbol `<mark>` used
`text-amber-300` — near-white, fine on dark, unreadable on light. Now
`text-amber-800 dark:text-amber-300`, checked in both themes.

**Verification.** `tsc`, `cargo clippy` and 41 Rust tests clean. Driven
end-to-end against a mocked Tauri IPC at 848 files. Two harness gotchas worth
remembering for next time: with the browser pane hidden, `requestAnimationFrame`
and `longtask` never fire and `setTimeout` is throttled to ~1/s (a mock with a
per-file delay looks exactly like a hang), and Tauri v2 delivers events through
`__TAURI_INTERNALS__.runCallback(id, …)`, not `window[_id]`.

### 41. Readable strict file names, Cyrillic kept — v0.11.2

Strict mode forced everything down to `a-z0-9-`, so "Beyoncé - Halo (Radio
Edit)" became `beyonce-halo-radio-edit` and any Cyrillic title was erased
outright. It now keeps letters, numbers and spaces, folds accented Latin to
ASCII, turns punctuation into spaces, and upper-cases the first letter. Both
modes lay out as `Artist - Title - id`; strict differs only in folding accents
and dropping punctuation. The tag's own casing is preserved rather than
title-cased, so "The Weeknd" stays as written and the user's Standardize
capitalization choice still applies.

Cyrillic (Russian and Ukrainian) passes through unchanged. The subtlety worth
remembering: the accent folding is NFKD decomposition, which splits **й** into
`и` + a combining breve and **ё** into `е` + a diaeresis — folding the whole
string would have silently rewritten those letters, corrupting names rather
than dropping them. So each character is classified first (`\p{Script=Cyrillic}`,
which also covers Ukrainian і ї є ґ and Belarusian ў) and only non-Cyrillic
characters are folded. Other non-Latin scripts still come out empty; there is
no transliteration to fall back on.

Settings' hint and the Rename to Standard confirmation both described the old
`beyonce-halo-000123` shape and were updated.

**Verification:** the real `sanitizeForFilenameStrict`/`buildRenameStem` run
over accented Latin, punctuation, lowercase tags, `AC/DC`, Russian (Ляпис,
Ёлка, Май, Соловей, Йогурт), Ukrainian (Океан Ельзи, Їжак і Ґудзик Є, Воплі
Відоплясова), Japanese and empty input — with an explicit check that й and ё
survive as themselves.

### 42. Column reordering off HTML5 drag; horizontal wheel, Space, needle drop, Del — v0.11.3

**Column drag-reorder never worked in the packaged app.** Item 40 fixed the
three HTML5 drag bugs in the header (`setData`, `dragenter`'s
`preventDefault()`, `dropEffect`) and reordering still did nothing, because the
remaining obstacle was not in the page at all: `dragDropEnabled` defaults on,
so Tauri installs its own OS drop target on the window — which is what delivers
dropped file *paths* for import — and while that is installed WebView2 never
delivers `drop` to the page. The `<th>` could be picked up and never let go, no
matter what `dragstart`/`dragover` replied. The two features are mutually
exclusive as long as reordering goes through HTML5 drag-and-drop.

**Fix:** reordering now runs on plain mouse events (`mousedown` on the header,
`mousemove`/`mouseup` on `window`), which never touch the OS drag machinery, so
Tauri keeps its file-drop target. A 4px threshold before the drag counts keeps
a plain click sorting; `columnDraggedRef` swallows the click that follows a real
drag the same way `resizingRef` does for a resize. The drop position is an
*edge*, not a column — `dropTargetAt` picks the nearest header and which half
the pointer is on — so a column can be placed after the last one, and a blue
line shows exactly where it will land. Dragging within 48px of either edge pans
the table, so a column can be moved somewhere currently scrolled off-screen.
`internalDrag` is kept and still set during the drag: harmless now, and the
flag is what stops the file-drop overlay if the OS drag path is ever back.

**Horizontal wheel did nothing.** The old handler was React's `onWheel` and only
looked at `shiftKey` + `deltaY` — a tilt wheel or trackpad swipe (`deltaX`) was
ignored entirely. It is now a native listener registered with
`{ passive: false }`: React attaches `wheel` at the root as passive, where
`preventDefault` is silently dropped, and without `preventDefault` a Shift+wheel
scrolls twice — once from the handler, once from Chromium's own
shift-to-horizontal mapping. `deltaMode` is scaled to pixels (some mice report
lines, not pixels).

Worth remembering if a tilt wheel ever looks dead again, because it cost three
diagnostic rounds: a tilt over an *unfocused* webview still fires `wheel` in
the page, but with `deltaX`, `deltaY`, `deltaZ` **and** the legacy
`wheelDeltaX/Y` all exactly 0 — a real, `isTrusted` event carrying no
direction at all, which looks identical to a broken handler. Windows delivers
`WM_MOUSEHWHEEL` to the focused window, and Chromium synthesises the
directionless event when that isn't the webview. Click into the page first and
the same tilt arrives as `deltaX: ±100` (`wheelDeltaX: ∓120`). The Rust-side
fix this seemed to call for — subclassing the window to read the delta out of
`wParam`, or reading it from raw input — turned out not to be needed.

**Space scrolled the table instead of ticking rows.** Two holes in one guard.
`e.target === document.body` was too narrow — anything focused inside the table
lost the key — and the handler returned *before* `preventDefault()` when there
was nothing to tick, so with no row highlighted Space fell through to the
browser and paged the table down. `ownsSpace()` now claims the key for the
table whenever the target is the body or inside the table's own scroller and is
not an input/textarea/select/button/link/contenteditable, and `preventDefault()`
runs first, so Space never reaches the browser's scroll.

**Genre Mode: needle drop.** Pressing anywhere on the Genre Mode waveform now
jumps playback there and plays from that point, and holding scrubs — pointer
*capture* rather than window listeners, since the cursor leaves the 28px strip
almost immediately on any real drag. Cue markers are part of the same surface,
so pressing a hot cue starts there. `gmSeekTo` handles the track that isn't
loaded yet by writing the position into `gmPositions` and letting `gmPlay`'s
existing `loadedmetadata` seek apply it, once there is a duration to seek
within. The playhead is drawn while paused too (falling back to the tag's own
duration before `<audio>` reports one), so a needle drop on a stopped track
still shows where it landed, and it grew a small head so it reads as a needle
rather than another cue line.

**Genre Mode: Del deletes.** `Del` on the Genre Mode strip offers to move the
current track to the Recycle Bin and, on a yes, moves playback to the next one
before the file goes. Ordering is the whole point: a deleted track must not
keep playing, and the `<audio>` element has to let go of the file first. So
`onDeleteFile` grew an `onConfirmed` callback that fires between the user
saying yes and the file actually moving — a cancelled delete leaves the track
playing exactly where it was. It deliberately isn't `gmAdvance`: deleting the
*last* row has to fall back to the row above, since `gmAdvance` would stop and
leave the anchor pointing at a path about to stop existing, which the strip
then renders as "No track selected". A `gmDeletingRef` guard stops a held key
stacking confirmations behind the dialog.

**Verification:** `moveColumn` run over first→end, last→start, both neighbour
swaps, onto-itself and drop-on-own-adjacent-edge (the classic off-by-one, which
must be a no-op) — all correct. `tsc --noEmit` and `npm run build` clean.

All five then confirmed by hand in the running Tauri app (`tauri dev`), which
is the only place the WebView2-specific half of this is real: column
drag-reorder, horizontal tilt-wheel panning, Space with nothing highlighted,
Genre Mode needle drop, and `Del`. Note the frontend alone can't be smoke-
tested in a plain browser at `localhost:1420` — the app needs the Tauri IPC
bridge and dies at the first `invoke`, so every check has to go through the
real window.

### 43. Wheel rebound to window capture; auto-update; tag-format sweep — v0.11.4

**The horizontal wheel fix from item 42 shipped in v0.11.3 and still didn't
work.** The handler was in the tag and `dist` is gitignored, so the release
genuinely built it — the binding was the problem. It was attached to
`scrollRef.current` once at mount and relied on the wheel event bubbling up to
that element, so it could be missed both by anything between the cursor and the
scroller that stopped propagation, and by the element going stale if the table
ever remounted under a listener installed once. It is now bound on `window` in
the *capture* phase and reads `scrollRef.current` when the event fires rather
than when the listener was installed, so neither can happen.

Diagnosing it needed instrumentation on the real scroller, and the first
reading was a trap worth recording: with no tracks loaded the table isn't
rendered at all, only the empty-state div, so `scrollWidth === clientWidth` and
`max=0` — "nothing to scroll" looks exactly like "the handler is broken". Any
future wheel diagnostic has to state its row count before its geometry means
anything. Note the layout itself is fine: TrackTable's wrapper is
`overflow-hidden`, which zeroes the `min-width: auto` a flex item would
otherwise take from its content, so the classic flexbox "no overflow ever
appears" trap does not apply here.

**Auto-update on launch.** `settings.autoUpdate` (default on, toggle in
Settings) checks for a new release a few seconds after start and installs it
without asking, then relaunches. The gate is the interesting part: it only
installs while the library is still empty and nothing is pending. On Windows
the updater hands off to the NSIS/MSI installer and the running app exits, so
installing mid-session would take the app out from under work in progress —
launch is the one moment there is nothing to lose. If files have been loaded by
the time the check returns it stands down and points at the Components page
instead. A failed check is swallowed to the console: offline, GitHub down and a
signature mismatch all land there, and none of them should be in the way on
launch.

**Standardize Tag Format.** A bulk sweep that moves every selected track's
tags into the one container its format calls canonical — ID3v2 for
mp3/wav/aiff, Vorbis Comments for flac/ogg, MP4 atoms for m4a/aac — and drops
the others a file has collected (ID3v1, APE). Values are moved, never edited.
`write_tags` has always done this as a side effect of any edit; this makes it
something you can run across a library without editing anything.

The part that matters is that it is *not* "delete the secondaries". A secondary
container can hold a field the primary lacks — an APE tag that is the only
place an album title lives — so the primary is copied into the new tag first
and anything the secondaries hold for keys the primary doesn't have is folded
in behind it. Pictures come from the primary, or from a secondary when the
primary has none. Items move with `insert_unchecked`, so keys the target format
has no standard mapping for (the app's own backup JSON among them) survive
rather than being silently dropped — the same trap item 40 hit.

It deliberately skips the pending/preview flow: values don't change, so there
is no before/after to show per field, and for the same reason it isn't undoable
from history. The confirmation says so. Files already carrying only their
canonical container are left untouched and counted separately, so running it
twice is a no-op.

**Verification:** a Rust test builds an mp3 carrying ID3v2 + APE + ID3v1 where
only the APE tag knows the album, sweeps it, and asserts ID3v2 is the sole
survivor with title, artist *and* that album still on it — then sweeps again
and asserts it reports no change. Full suite 42 passed.

### 44. FAT32 USB formatter for CDJs — v0.12.0

Components page: pick a removable drive, type its label back, and it is
rewritten as FAT32 at any size — including sticks over 32 GB, which Windows'
own `format.com` and `Format-Volume` refuse outright ("volume too big"). That
refusal is the whole reason this exists: a DJ's 64 GB stick cannot be prepared
for CDJs with the tools Windows ships.

**Why not shell out to fat32format.** It is what guiformat and every DJ guide
uses, and it was the first choice — until it turned out Ridgecrop serves no
HTTPS at all. Downloading it means fetching an unsigned executable over plain
HTTP and then handing it raw disk devices; anyone able to intercept that
request chooses what code formats the user's drives. The `fatfs` crate does the
same job with its integrity pinned by `Cargo.lock` and compiled into the
already-signed binary, so that is what this uses.

**Safety.** Only `DriveType == Removable` volumes are ever enumerated, the
system drive is dropped even if it claims to be removable, and the chosen drive
is re-resolved against a *fresh* enumeration at format time — a letter is not
identity, since pulling one stick and pushing in another reuses it.
Confirmation is by typing the drive's current label rather than clicking OK,
so the user has to read what is actually on the thing they are erasing. Raw
volume writes need Administrator, so a second copy of the exe runs via `runas`
and exits; that is handled at the very top of `main`, before the
single-instance plugin exists, because that plugin forwards arguments to the
running UI and exits — which would have silently formatted nothing.

**Three bugs, none of which the image tests could have caught.** Worth
recording, because the lesson generalises: a `Cursor<Vec<u8>>` is a far more
forgiving device than a real volume.

1. The device path must be `\\.\D:` and shipped one backslash short, as
   `\.\D:`. Windows reports that
   as ERROR_INVALID_NAME — "volume label syntax is incorrect" — which reads
   like a bad *drive*, not a bad string. `device_path` is now a tested function.
2. A raw volume handle **rejects `SeekFrom::End`** with ERROR_INVALID_PARAMETER.
   The aligner learned the device size by seeking to the end, which a file
   answers happily. Size now comes from `IOCTL_DISK_GET_LENGTH_INFO`, and
   `seek(End)` is answered from that — it matters because `fatfs` seeks to the
   end itself to decide how many sectors to lay out.
3. Formatting appeared to hang. `fatfs::write_zeros` clears the FAT with a
   **512-byte** buffer in a loop — ~14 MB of FAT on a 57 GB volume, so ~28,000
   iterations — and each went to the device as its own seek plus a 512-byte
   unbuffered USB write. Writes now coalesce into 1 MiB, turning ~28,000 device
   round-trips into about fourteen. Reads flush the pending buffer first,
   because fatfs writes the FAT then reads it back to allocate the root
   cluster; without that it would read stale bytes and build a subtly broken
   filesystem.

Windows raw-volume I/O is only legal on whole sectors, so `SectorAligned` sits
between fatfs and the device doing read-modify-write for anything partial —
without it every format fails on the first unaligned write.

**Verification:** 12 tests. Formatting runs end to end against a file-backed
image — format, mount, assert FAT32 rather than FAT16, check the label, create
a file in the root — plus a write straddling a sector boundary, label
sanitising, the `with_len` path, and a counting device proving 8,192 separate
512-byte writes reach it in 8 or fewer with the bytes still exact. The guards
are covered for junk input, the raw device path form, the system drive by
letter and with a colon, and a fixed disk that lies and reports `Removable`.
Then confirmed by formatting a real USB stick.

### 45. YouTube Music import overhaul — v0.13.0

The import screen matched well enough to demo and badly enough to be annoying
in real use. Seven separate problems, one pass.

**Matching** (`src/lib/ytMatch.ts`, rewritten). The old scorer compared a
video title against each file's tags, took the best score per entry
independently, and stopped there. Now:

- **Every identity a file has is compared**, not just its tags: the tag pair,
  the filename stem, *and* the pre-clean identity in the searchable backup
  (`stem | | artist | | title | | year`, see `build_searchable_backup`). After
  an AI Clean the backup is frequently the only place the original
  YouTube-ish spelling still exists, so this is what makes a cleaned library
  match at all. The winning source is reported as `via: tags | filename |
  backup`.
- **Mix/version awareness.** `versionSignature()` pulls the distinctive part
  of a version qualifier out of a title — the remixer's name from
  "(Tale Of Us Remix)" — and drops generic filler, so "(Original Mix)" reads
  as "no version stated". Two *different* named versions multiply the score
  by 0.6, which is what actually keeps separate mixes of one track apart;
  edit distance alone scores them ~1.0.
- **Token similarity alongside edit distance.** `tokenSimilarity()` is a
  length-weighted, order-insensitive overlap; the final text score is the
  better of the two. Edit distance collapses on a swapped "Title - Artist"
  or an extra featured artist, which token overlap handles, and vice versa.
- **Global one-to-one assignment.** Pairs are considered in descending score
  order and each file can back at most one entry, so two near-identical
  entries can't both claim the same file — the stronger pairing wins and the
  weaker falls through to its own next best candidate.
- **A title-only entry is compared against the title alone.** Found by running
  a real 70-track playlist against a 4,149-track indexed library: YouTube
  Music playlists commonly give bare titles with no uploader, so every entry
  had no artist. Scored against the library's "artist title" the *correct*
  matches landed at 59-86% and only 2 of 70 auto-accepted — the artist tokens
  the entry could never have supplied were being counted against it. Adding a
  title-only comparison (discounted 2%, so a match that also agrees on the
  artist still wins the assignment) took the same playlist to 26 auto-matched
  with no false positives.
- Duration is a proportionate gate, not a flat weight: ≤3s is a small bonus,
  >25s caps the score at 0.5 no matter how well the titles read.

**UI** (`src/pages/YtMusicImportPage.tsx`, rewritten):

- The video's **artist** is shown on its own line under the title (parsed via
  `buildWanted`, falling back to the uploader minus " - Topic").
- **Deny button** (the thing that was missing): rejects the suggestion on
  screen and promotes the next candidate; denying the last one leaves the
  entry Missing. Separate ⊘ marks an entry missing outright.
- **Candidate carousel** `‹ 2/5 ›` steps through the alternates, for when a
  track exists as several mixes. Stepping is a choice, so it still needs
  confirming.
- **Prelisten** on any matched or candidate library track — `AudioPreview`
  gained a `compact` mode (button only, no scrub bar, no duration readout).
- Both sides of the row are now equal-width two-line blocks, so a long
  "Artist - Title" is readable instead of clipped into a 14rem column.
- The per-row duration readout is gone.
- **"Still to get"** card lists every unmatched entry with its link, plus
  **Copy All Links** and Copy Titles.
- **Library search dock** at the bottom (`LibrarySearchPanel`): search the
  collection and drag a result onto a playlist row to match it by hand.
  The drag runs on plain mouse events, not HTML5 drag-and-drop — same reason
  as column reordering (see `lib/internalDrag.ts`): Tauri's OS drop target
  swallows `drop` on Windows, so an HTML5 drag looks like it works and
  quietly does nothing. The drag ghost is `pointer-events-none` because the
  drop target is found with `elementFromPoint`.

**Match log** (`src/lib/ytMatchLog.ts`). Copy or save a full record of a run —
what the matcher proposed, what the human did, every losing candidate with
its score, and a `disagreementRate` — as JSON to feed back into an AI, or as
Markdown to read. It deliberately logs the *losing* candidates too: an
accepted match and one the user had to correct look identical if you only
record the final answer.

**Search** (`src/lib/trackSearch.ts`, new). One implementation for every
lookup in the app. The rule it enforces: searching looks at the **tags**, not
at whichever columns happen to be visible — the table's old find bar scanned
rendered cells, so hiding the Artist column silently stopped artist search
from working, which reads as "search is broken". Supports `artist:brejcha`
field scoping, `-word` exclusion, `"quoted phrases"`, diacritic folding
(`bjork` finds `Björk`) and searches the searchable backup, so the name you
remember finds the file even after a clean.

**Also in this release:**

- **Standardize button removed.** It ran `applyCapitalization(applyReplacements(…))`
  — exactly Characters followed by Capitalization, both of which are their own
  buttons. One less thing on a crowded toolbar.
- **Theme follows the OS.** The sidebar's light/dark toggle is gone;
  `settings.theme` gains `"system"` (the new default, settings v7) and App
  subscribes to `prefers-color-scheme` so flipping Windows retints the app
  live.
- **Sergio Alexo wordmark** in the sidebar, linking to sergioalexo.com — same
  treatment as Media Fetch (black/white SVG swapped on `dark:`).

**Verification:** Vitest added (`npm test`). 26 tests — 16 for the matcher
(remix separation, one-to-one assignment, backup-only and filename-only
matches, a true negative staying missing) and 10 for search (field scoping,
negation, diacritic folding, ranking a title hit above a comment hit).


### 46. Whole-library index; genres derived from the collection — v0.13.0

Everything before this worked only on the files loaded into the current
session. That is right for editing a folder and wrong for every question
about the *collection*: which genres do I actually use, do I already own this
playlist track, where is that track I remember but haven't opened.

**The index** (`src-tauri/src/commands/library_index.rs`). A sqlite index of
one or more root folders holding the curated tag fields plus `mtime` + `size`
for identity. Its own database (`library-index.sqlite`), not the
fingerprint/waveform cache: that one is a derived-computation cache that can
be deleted to reclaim space, this one is user-facing state whose loss means
re-walking the collection.

- **Incremental.** A file whose size and modified time both match its row is
  skipped without being opened, so re-indexing after adding a few tracks
  costs seconds. "Re-read Everything" exists for when that assumption breaks
  (a restore from backup keeps the old mtime).
- **A cache of the files, never a source of truth.** Tags on disk always win,
  a changed file is re-read, a deleted one is dropped, and nothing is ever
  written to a file because of what the index says.
- **An offline drive doesn't erase its half of the index.** Stale rows are
  only removed when the path genuinely no longer exists — an unplugged
  external drive is indistinguishable from a deletion by absence alone.
- Tag parsing runs in parallel (`par_map`) and the database write happens
  afterwards in one transaction: sqlite is single-writer, and interleaving
  would serialise the parses too.
- Settings gains a **Library Index** card — roots, progress, and what it
  found.

**Genres are now the collection's own** (`src/lib/genres.ts`,
`settings.genrePresets` retired at settings v8). The stored preset list is
gone. A remembered list is wrong in both directions: it offers genres no
track carries, and misses ones typed straight into a track. The picker is now
`libraryGenreNames()` — the indexed genre tally plus the genres on loaded
tracks, ordered by use — so it cannot drift from the files.

**Renaming a genre renames it everywhere.** That is the point of deriving the
list: the name in the picker and the name in the files are the same thing, so
editing one has to rewrite the other. `retag_field` rewrites the genre tag on
every indexed track carrying the old name (preserving every other frame via
the file's own `all_fields` minus the typed ones, exactly as an inline edit
does) and refreshes their index rows; loaded tracks go through the normal
edit path so undo still covers them. It confirms first, with the real count.

Detect Genres now only offers **merges** of near-duplicate spellings — a
genre already on a track is in the vocabulary by definition, so there is
nothing left to "add".

**Playlist matching sees the whole collection.** `mergeWithSession()` layers
this session's loaded files over the index (session wins on a shared path, so
a just-retagged track matches on its new tags). The import screen's search
dock searches the same merged set.

**Resumable import sessions** (`import_session` table + `save/load/list/
delete_import_session`). Matching a playlist is rarely one sitting: you match
what you own, buy the rest, come back and re-fetch. Without this the second
pass starts from nothing — every confirmation and, worse, every *denial* is
lost, so the matcher re-proposes exactly the matches already rejected.
Decisions autosave (debounced) keyed by video id, never by position, so they
survive the playlist being reordered and the library growing. Re-fetching
restores them, a banner says so, and **Re-match** re-runs scoring against the
collection as it is now while every decision stands — the "I went and bought
the missing ones" button.

**Table search fixed.** The find bar scanned rendered cells, so hiding the
Artist column silently stopped artist search from working, which from the
outside is indistinguishable from search being broken. It now goes through
`searchTracks`/`matchesTerms`, which read the tags regardless of which
columns are visible.

**Verification:** 33 TypeScript tests (7 new for the genre vocabulary and
spelling groups) and 64 Rust tests, 5 new — including
`kept_field_keys_match_the_frontend`, which parses `src/types.ts` and fails if
the Rust and TypeScript kept-field lists ever drift. They have to agree: a key
in one but not the other is either dropped on write or duplicated as a raw
frame, and neither shows up until someone's tags are already damaged.


### 47. Demucs stem separation — v0.13.0

Splits a track into drums / bass / vocals / other — the acapella and
instrumental a DJ actually wants for edits and mashups.

**Why it is installed differently from every other component.** FFmpeg and
yt-dlp are single binaries we can fetch and drop in `app_data_dir()/bin`.
Demucs is a Python package that pulls in PyTorch: multi-gigabyte, and
platform- and CUDA-specific. Shipping our own Python runtime to hide that is
a large amount of machinery that breaks in a new way on every machine, so
this follows the same *shape* as the others instead — detect, then offer to
install into the Python you already have:

- find an interpreter (`python`, `python3`, and `py -3` on Windows, which is
  the only reliable way to reach a store/installer Python that never made it
  onto `PATH`),
- ask it, in one short-lived process, whether `demucs` imports and what torch
  says about CUDA — four separate launches would each pay interpreter
  startup, and a torch import is not cheap,
- prefer an interpreter that *already* has demucs: a machine can easily have
  three Pythons, and installing into the first one found when a later one is
  set up would be both slow and baffling,
- one-click `pip install -U demucs`, streaming pip's output live.

Every invocation is `python -m demucs`, never a `demucs` console script: the
script is only on `PATH` if the install put it there (frequently not on
Windows, never for `--user`), while `-m` works whenever the package imports
at all.

**Parameters** (`StemsDialog`): model (htdemucs, htdemucs_ft, htdemucs_6s,
hdemucs_mmi, mdx_extra, mdx_extra_q), all-stems vs a two-stem split
(acapella + instrumental, or drums/bass/other), output format (WAV / FLAC /
MP3 with bitrate), quality passes (`--shifts`), window overlap, CPU/GPU, and
parallel jobs. Defaults match demucs' own, so an untouched dialog behaves
exactly like a bare `demucs file.mp3`. Last-used settings persist
(`settings.stemOptions`, settings v9).

Details that matter:

- **`-j` never reaches a CUDA run.** Parallel jobs multiply VRAM use and
  reliably OOM consumer cards, so the flag is dropped on GPU whatever the
  dialog says. Covered by a test.
- **Output is streamed, not buffered.** Separation takes minutes per track on
  CPU; buffering until exit would leave the UI frozen with no output, which
  for a long run is indistinguishable from a hang. demucs redraws its
  progress bar with carriage returns, so only the last `\r` chunk is kept for
  the status line.
- **A failure doesn't stop the batch.** One corrupt track in thirty shouldn't
  cost the other twenty-nine. Files are separated sequentially on purpose:
  demucs already saturates the GPU (or every core with `-j`), so two at once
  makes both slower and tends to exhaust VRAM.
- The dialog gives a deliberately rough time estimate — enough to stop
  someone queueing 200 tracks at `shifts=10` on a CPU and expecting it by
  lunch.
- The error surfaced on failure is the last meaningful stderr line, not the
  exit code, which on its own tells the user nothing.

**Verification:** 7 Rust tests over argument construction and the output-path
layout, plus a real end-to-end run: `python -m demucs -n htdemucs -o ./out
--two-stems=vocals --mp3 --mp3-bitrate 320 -d cpu clip.wav` on a generated
5-second clip produced `out/htdemucs/clip/vocals.mp3` and
`out/htdemucs/clip/no_vocals.mp3` — exactly the path
`expected_output_dir()` predicts. Every flag the dialog can emit was also
checked against the real CLI's argument parser.


### 48. The Claude CLI as a third AI backend — v0.13.0

AI Clean had two backends: Ollama (local, free, weaker) and manual (paste the
prompt into whatever you like, paste the answer back). This adds a third that
is neither — drive the `claude` CLI already installed and already signed in
on the machine, so cleaning a few hundred tracks needs no copy/paste *and* no
API key or separate bill. It runs on the Claude subscription that is already
there.

The whole integration is `claude --print` with `--output-format json`, its
documented non-interactive mode. Both commands reuse the existing prompt
builders and response parsers verbatim (`ai::build_clean_prompt`,
`ai::parse_cleaned`, `ai::build_genre_prompt`, `ai::parse_genres`, made
`pub(crate)` for this) — a second copy of the rules would drift, and "the AI
answers differently depending on which backend you picked" is a miserable bug
to chase. Batching, progress and Stop are shared too: `useAI` picks the
command and nothing else changes.

Two findings from testing against the real CLI that the code is shaped
around:

1. **Installed is not the same as usable.** The copy bundled inside the
   Claude desktop app (`%APPDATA%\Claude\claude-code\<version>\claude.exe`)
   authenticates through the app's session, so invoking it standalone returns
   a perfectly valid envelope saying `Not logged in · Please run /login`. So
   detection probes *login*, not presence, and a real CLI install on `PATH`
   is always preferred over the bundled one. The Settings panel distinguishes
   "Not found" (install it) from "Not signed in" (run `claude` once).
2. **Failure is reported in the body, not the exit code.** A refusal, a rate
   limit and a login problem all come back as valid JSON with
   `is_error: true`, and the only useful message is in `result`. The parser
   reads the body first and treats the exit code as a fallback.

The CLI is invoked with `--allowedTools ""`: tag work is pure text
transformation, so denying the tools outright means a prompt built from
someone's tag data can never talk the CLI into touching the disk. Token usage
is emitted on the same `ai-usage` event as Ollama, so the usage dashboard
counts every backend instead of quietly under-reporting this one.

**Verification:** 6 Rust tests over envelope interpretation — including the
real not-logged-in envelope captured from an actual run, because guessing
that shape is how you ship a backend that reports "unexpected output" for the
one failure every new user hits first — plus a test that the shared parser
accepts the fenced JSON a chat-tuned model tends to return. The CLI's flags
(`--print`, `--output-format`, `--model`, `--append-system-prompt`) and the
envelope shape were checked against the real binary (2.1.280). The
signed-in path could not be exercised on the development machine, which has
only the desktop app's bundled copy.


### 49. Playlist matching: 15.7s → 0.35s — v0.13.0

Matching the user's real 70-track playlist against their 4,149-track indexed
library took **15.7 seconds**, blocking the UI thread the whole time. Restoring
a saved session or pressing Re-match froze the app.

Measured first, because the obvious culprit was wrong twice. A benchmark at
the real size (`ytMatch.bench.test.ts`) plus a phase breakdown showed the cost
was not where it looked: building 4,149 identities is 190ms one-off, but each
*entry* then cost 46ms to scan the collection — 3.2s of pure comparison, and
that was already after a 3x win. Three changes, in order of how much they
mattered:

1. **An inverted index over the collection** (the big one, ~10x). Scanning
   every track for every entry is 290k full comparisons, almost all between
   things with no word in common. Each entry now only meets tracks sharing a
   whole token ("brejcha") or a token's first three characters ("bre" — typos
   rarely land in the opening letters, so "disturbia"/"disturbya" still find
   each other). The shortlist is walked in *collection* order, not posting-list
   order: equal scores are common in a real library, and the top-N cut would
   otherwise depend on which tie was seen first.

2. **Prepared strings** (~3x). Every comparison was re-normalizing and
   re-tokenizing both sides. Each string is now reduced once to its normalized
   form, token multiset, weight and character histogram.

3. **Pruning the edit-distance DP.** A character histogram gives a lower bound
   on the distance, which often settles a comparison outright; when it doesn't,
   the DP runs banded (Ukkonen) with a row-minimum bail-out, capped by both the
   token score it must beat and the floor the caller still cares about.
   `matchPlaylist` keeps a running top-N whose worst member raises that floor
   as it goes.

**What was actually verified**, since a faster matcher that matches differently
is worthless:

- `textSimilarity` is checked against a naive `max(levenshtein, tokens)`
  implementation over 2,000 random strings plus adversarial cases — anagrams
  (identical histograms, so the bound proves nothing and the DP must run),
  single-character typos, disjoint strings — and separately that a caller's
  pruning floor never changes a result that clears it.
- The shortlist is checked against the exhaustive scan it replaced, over a
  4,149-track corpus, for exact titles, "Artist - Title", remixes, absent
  tracks, " - Topic" uploaders, deliberate typos, entries made only of very
  common words, and a collection with no tags at all. `matchPlaylist` keeps an
  `{ exhaustive: true }` escape hatch purely so those tests can compare.
- The contract asserted is **decision equivalence, not identity**: statuses,
  assignments and every candidate at or above `AMBIGUOUS_THRESHOLD` are
  identical. Below that the shortlist may drop an alternate scraping the
  `FLOOR_THRESHOLD` bottom — measured worst case 0.31, against entries that are
  missing either way. Claiming full equality would have been claiming something
  untrue.
- Confirmed against the real thing: the same playlist and the same library
  produce the same 26 matched · 44 missing · 70 total, with every individual
  score unchanged.


### 50. Index durations, and keeping stem output out of the library — v0.13.0

Two defects found by actually using the features, not by reading the code.

**The index stored no durations.** `index_library` wrote a literal `None` into
`duration_secs` (and `0` into `has_backup`), so `0 of 4,149` indexed tracks had
one. Nothing broke loudly — `applyDuration` treats an unknown duration as
neutral — but the duration gate documented as keeping different edits of a
track apart was simply not running for any track that wasn't open in the
session, which is most of them. `read_for_index()` now answers tags, duration
and backup presence from a **single** parse; reading the file once per field
would have tripled the cost of indexing a collection.

**A stale index needs to know it is stale.** Indexing is incremental: a file
whose size and modified time still match is skipped without being opened. That
is exactly wrong when it is *our* idea of a row that changed rather than the
file, so those empty durations would have survived every future re-index.
`INDEX_VERSION` is now stamped in an `index_meta` table and a mismatch forces
one full re-read. Verified by pressing plain **Index Library** — not "Re-read
Everything" — on an existing v1 index and watching it re-read all 4,149 files
and come back with `4149 / 4149` durations and `index_version = 2`.

**Stem output no longer pollutes the library.** Separate Stems writes into a
`stems` folder beside each track by default, which is normally *inside* a
library root — so the next index would have pulled in four files per separated
track as if they were part of the collection, making them playlist-match
candidates and search results. The walk now prunes any directory named
`stems`, except at depth 0, so a folder someone deliberately adds as a root is
still indexed. Checked both ways: a unit test over a temp tree, and for real by
planting `Collection/stems/htdemucs/<track>/{vocals,drums}.mp3` in the user's
actual library and confirming the count stayed at 4,149 with zero rows under a
stems path.

**Also verified in this pass:** stem separation end to end. Rihanna –
Disturbia (3:21) separated in 139s on CPU via `python -m demucs -n htdemucs`,
with demucs' own progress streaming into the dialog. The output is a real
separation, not four copies: spectral centroids land where they should (bass
386 Hz, other 2,138 Hz, vocals 3,870 Hz, drums 6,028 Hz) and every
cross-correlation between stems is near zero (+0.01 to +0.11).


### 51. Drag-to-match replaced by a Match button - v0.13.1

The search dock's drag-to-match gesture is gone. It was rewritten twice -
HTML5 drag-and-drop never fires `drop` because Tauri's own OS drop target
swallows it on Windows, then window-level mouse events started the gesture
but lost the release, then captured pointer events fixed the drop - and it
still wedged the app shortly after a drag, because the webview starts its
*own* native content drag from a row full of text and that drag runs a modal
loop in the browser process which blocks the renderer.

A `-webkit-user-drag: none` hook on the row and every descendant is the
correct fix for that last failure (committed, then reverted here), but three
rewrites for one affordance is enough. Each result row now carries a
**Match** button that assigns it to the highlighted playlist row, with
double-click as the shortcut; the ghost, the drop outline, the pointer
capture, the `dragstart`/`selectstart` refusals and the `[data-selfdrag]`
stylesheet rule all went with it. 170 lines removed, no gesture left that
can hand the mouse to the OS.

Worth revisiting only if drag turns out to be genuinely missed.

### 52. YT-import matcher polish: playback, arrow drift, artist fallback, YouTube prelisten, richer logs — v0.13.2

A batch of usability fixes from a real session's feedback:

- **AudioPreview didn't reload on candidate switch.** The `<audio>` element
  is reused across candidates (cycling arrows, switching matches), and the
  old effect only ever set `src` once (`if (el && !el.src)`), so switching
  to another candidate kept playing — or silently failed to play — the
  previous file. It now rebuilds the element on every `path` change.
- **Confirm/deny shifted the candidate-cycle arrows.** The action buttons
  were conditionally rendered inline, so confirming or denying a match
  (which changes which buttons show) moved the arrows sideways mid-click.
  Every control now sits in a fixed-width slot, empty or not.
- **Removed the per-row "Pick…" combobox** — redundant with the search dock
  below, and it carried every track's label into every row for nothing.
- **Search dock lag after the first keystroke.** The library search dock
  rebuilt every file's searchable text from scratch on every character
  typed, over 4000+ tracks. Fixed with a 150ms debounce, a cache keyed on
  `TagData` object identity (`cachedTrackSearchText` in `trackSearch.ts`),
  a tighter result cap for short queries, and `AudioPreview` no longer
  eagerly preloading metadata in `compact` mode (nothing shows it there).
- **"Unknown artist" fallback.** `ytmusic.rs` now also reads yt-dlp's
  `artist`/`creator` fields when present (real per-track metadata, stronger
  than the uploading channel). `buildWanted()` prioritizes metadata > title
  split > channel, and tags which one won (`artistSource`) so the UI can
  show a channel-derived guess (marked "(channel)") instead of collapsing
  straight to "Unknown artist".
- **Claude CLI native-installer path.** `find_claude()` now also checks
  `~/.local/bin` (`%USERPROFILE%\.local\bin` on Windows) — where
  `irm https://claude.ai/install.ps1 | iex` puts `claude`, and which isn't
  on PATH by default.
- **Richer, structured session logs.** `notify()` takes an optional
  `{details, silent}`: `details` is structured data (a fetched URL, a
  match's score and runner-ups, an export's file list, …) shown expanded
  and copyable in the Logs page without cluttering the toast; `silent`
  records the entry without popping a toast, for high-frequency events
  (every confirm/deny/cycle/skip/reset click) that still belong in a
  session's paper trail. Copy All now includes each entry's details.
- **Duplicate "Added N files" log.** `useFiles.importPaths` now de-dupes an
  identical paths call arriving within 2s of the last one (React
  StrictMode's dev-mode double-effect-invoke and a multi-file "Open with"'s
  process burst both funnel through here and could double-fire it).
- **YouTube prelisten.** New `YouTubePreview` component (YouTube IFrame
  Player API) adds a play button on the YouTube side of each matcher row,
  matching `AudioPreview`'s play/scrub UI and joining the same
  single-thing-plays-at-a-time system. The player is created lazily on
  first press (never for all rows up front — same lesson as the
  `preload="metadata"` fix above). A video that refuses to embed falls
  back to opening it in the browser.

Type-checked, `npm test` (50 TS) and `cargo test` (76 Rust) all pass.
**Not yet verified against the real app** — this app cannot run in a plain
browser (every Tauri `invoke` throws on mount), so the UI changes above are
unverified beyond code review + automated tests until exercised in
`npm run tauri dev`.

### 53. YT-import matcher: always-on scrub bar, library-style search dock, auto-indexing, sticker artist fix — v0.13.3

A second round of feedback from real use of the matcher:

- **The scrub bar is always visible now**, on both sides of a row (local
  file and YouTube), instead of only appearing after Play is pressed
  (YouTube) or not existing at all (`compact` local-file rows). `AudioPreview`
  and `YouTubePreview` both take an optional `durationSecs` hint — the
  library index, a loaded file's tags, and yt-dlp's playlist fetch all
  already know a track's length, so the bar sizes itself immediately and
  nothing is read from disk (or requested from YouTube) until Play or a
  scrub is actually pressed. This is what keeps rendering hundreds of rows
  cheap; only the *always-visible bar* changed, not the lazy-load rule that
  fixed the original freeze.
- **The search dock now looks and works like the Library table** —
  title/artist, album, genre, year and format columns, using the shared
  `AudioPreview` player — instead of a plain two-line result. Same debounced
  search, same result cap.
- **Removed the cycling arrows.** Alternate mixes/candidates the matcher
  found now show up automatically in the search dock, under "Other versions
  for row N", each with its own player and a one-click Match — picking one
  is logged as `corrected`, same as before. Denying a specific alternate
  there removes it from the running without touching the row's current pick.
- **Confirm / Deny / "I don't have it" now auto-advance** to the next row
  that still needs a decision, so working through a playlist is "keep
  clicking" without hunting for the next unresolved row. Reset doesn't
  advance (it's undoing, not deciding).
- **"I don't have it" actually clears the row now.** It used to only set an
  override, but the shown candidate stayed on screen because it was still
  the un-rejected top pick — `skipEntry` now denies every remaining
  candidate too, so the row reads "Not found" with nothing shown, exactly
  like a real deny-everything.
- **Every row button is always rendered** (disabled + dimmed when it doesn't
  apply) instead of appearing/disappearing — closes the last case of a
  control shifting or popping under the mouse.
- **"Unknown artist" for restored sessions.** A session saved before channel
  names were read (or a fetch that happened not to include one for some
  entries) never had anything to re-check it against, so it showed "Unknown
  artist" forever. Restoring/resuming a playlist now quietly re-fetches it
  once in the background if any entries are missing both artist and channel,
  and fills in whatever the fresh fetch has — decisions already made are
  untouched. The row itself now shows the channel name directly under the
  title rather than folding it into an "artist" label.
- **Matching no longer needs the whole library loaded first.** Opening a
  folder now registers it as an indexed root and kicks off a quiet
  incremental re-index in the background (`App.tsx`'s `addLibraryRoot`), and
  the app does one incremental index pass on startup if any roots are
  configured — indexing is mtime+size incremental, so a library that hasn't
  changed costs almost nothing. The import page shows when the index was
  last updated and an Index/Re-index button, so a track indexed in a past
  session is there without reopening its folder.

Type-checked, `npm test` (114 TS) and `npm run build` all pass. Rust is
untouched this round, so `cargo test` wasn't re-run. **Not yet verified
against the real app** — same `npm run tauri dev` caveat as always.

### 54. Fix Claude CLI backend on Windows npm installs; Install/Sign-In buttons — v0.13.4

`npm i -g @anthropic-ai/claude-code` on Windows installs `claude.cmd`, a
batch-file shim — the only thing `find_claude()`'s npm-bin check found.
Spawning it from Rust failed every time with `Could not run the Claude CLI:
batch file arguments are invalid`: `std::process::Command` hardens
batch-file argument handling (the CVE-2024-24576 fix) and rejects certain
arguments outright, including the empty string `run_prompt` passes for
`--allowedTools` to lock the CLI down to zero tools. `find_claude()` now
resolves straight past the shim to the real binary it wraps
(`node_modules\@anthropic-ai\claude-code\bin\claude.exe`), which the shim
itself was already calling — a plain EXE spawn, no batch file, no `cmd.exe`
re-parsing of prompt text (which matters here: the prompt embeds arbitrary
track/artist tag data). Verified against the real install: direct spawn of
the resolved `claude.exe` with the exact args `run_prompt` sends returns
`is_error: false`, and the Settings page's Claude backend probe goes from
the error above to a green "Ready" badge in `npm run tauri dev`.

Alongside this, Settings gained **Install** and **Sign In** buttons for the
Claude backend, wiring up two commands that existed but weren't reachable
from the UI: `install_claude_cli` (runs the official installer,
non-interactively) and `open_claude_login` (opens a real terminal running
`claude` so the user can complete the browser-based `/login`, which can't be
driven headlessly). Both were already implemented and tested; only the
`main.rs` command registration and the SettingsPage buttons were missing.

`cargo test` (78), `npm test` (114 TS), `npm run build` all pass.

### 55. Real YouTube Music metadata, library-track labels, list import, wheel diagnostics — v0.14.0

Four workstreams, plus five already-shipped backlog fixes (below) that had
never made it into a numbered release entry.

**No more guessed artists.** The owner's "(Dance) Wedding Music" playlist
had every entry with `uploader`/`artist` null — `yt-dlp -J --flat-playlist`
doesn't return per-track artist/album for a `music.youtube.com` playlist —
so the matcher fell back to splitting the video title on its first dash,
which mangled `Low (feat. T-Pain)` into artist `Low (feat. T` / title
`Pain)`. New `enrich_ytmusic_entries` (`ytmusic.rs`) runs a *full*
(non-flat) `yt-dlp -j` extraction per video, 4 at a time, cached in a new
`yt_entry_meta` sqlite table so a restored session paints instantly with no
network; `cached_ytmusic_meta` serves the cache directly and
`cancel_ytmusic_enrich` stops a run superseded by a new fetch. The artist
shown is now only ever `entry.artists[0]` (or the legacy structured `artist`
field) — the title-split and channel-name guesses are gone entirely from
`buildWanted`, and `splitArtistTitle` (kept only as an internal matching
signal) now requires whitespace around the dash so `Jay-Z`, `A-ha`,
`T-Pain`, `Ne-Yo` survive. "Still to get" / Copy Links use the real artist
when known. `ytdlp_info` also flags a yt-dlp release more than ~6 months
old (`version_is_stale`), surfaced on the import page and a new yt-dlp card
on the Components page. `npm test` (150 total) and `cargo test` (85, 5
ignored) both green.

**Matched library tracks show `Artist - Title`, not a path.** A matched
row's right side was rendering the *full file path* and an em dash for
artist for some rows in the owner's real library, and clicking an
indexed-only match showed a dead "open its folder" toast. Root-cause note:
this environment couldn't drive `npm run tauri dev` interactively against
the owner's real library/session to confirm it live, so the cause is a
static-analysis finding, not a confirmed one — worth a quick check on the
owner's machine. The most likely explanation is a byte-level path mismatch:
`trackLabel` looked up `tags[p]`/`fileByPath[p]` by exact string, so a path
saved in a session's `overrides` (or matched against a file opened in an
earlier session, outside any indexed root) that differs from the index by
case, `/` vs `\`, falls through both lookups straight to the raw path. Fixed
regardless of the exact cause: a case/slash-folded fallback lookup, then an
on-demand `read_tags_batch` for a path outside the collection entirely, then
the bare filename — never the full path, which is now tooltip-only. A path
confirmed gone from disk shows "File missing" and is treated as unmatched
for export. `useLibraryIndex.refreshTracks` now logs a real load failure
instead of silently emptying the collection. Opening an indexed-only track
now reads its tags directly instead of the "not loaded" toast — the
inspector was already read-only, so there was no edit path to wire up.

**Horizontal wheel: diagnostics, not a fourth guess.** Three prior fixes
(item 42, v0.11.4, `dba4b93`) guessed at the cause of the sideways-scroll
bug and were never confirmed against a real repro. Asked the owner first,
per this batch's plan: the actual symptom — "scrolls for a second, then
breaks, only fixed by relaunching the app," with Logitech Options+ installed
— doesn't cleanly match any of the three failure modes anticipated (all-zero
deltas, snap-back, or a dead header zone), so a fix now would be a fourth
guess. Shipped a "Log wheel events" toggle instead (Logs page, in-memory
only, off by default): while on, `TrackTable`'s wheel handler logs every
event's `deltaX`/`deltaY`/`deltaMode`/`shiftKey`/legacy `wheelDeltaX`, target
tag/class, `document.hasFocus()`, `scrollLeft` before/after,
`scrollWidth`/`clientWidth`, and which guard (if any) gave up on it —
throttled to ~20/s. **Not fixed yet** — needs the owner to reproduce the
break with logging on and share the Logs page output before the real fix
(native `WM_MOUSEHWHEEL` handling, a refocus-on-hover, or whatever the log
turns up) can be chosen from evidence.

**Import from a list, not just a playlist link.** The single-URL box is now
a multi-line paste area that also takes individual video links and plain
typed song names, one per line (`src/lib/ytListInput.ts`'s
`parseImportInput`, pure + Vitest-tested), plus a "Load .txt / .csv" button
and CSV `artist,title` header mapping. Per the owner's steer, typed song
names are for building a playlist against the local collection only — no
"Find on YouTube" search integration for them, so that part of the original
plan (C4) was dropped rather than built and left unused. A pasted video link
still gets real per-video metadata through the same enrichment pipeline
above, so it matches and displays exactly like a playlist track. Session
keying: a lone playlist or video link keeps the exact key `sessionKeyFor`
always produced, so a session saved before this shipped still restores
unchanged; anything else (a mix, several links, or typed text) hashes the
whole pasted input, which is now itself part of the saved payload so the box
refills and Re-match/re-fetch keep working.

**Also folded into this release** — five fixes already on `master` as
individual "(backlog item)" commits since v0.13.2, each already logged with
full detail in the Backlog section below, but never bundled into a numbered
release entry until now: capitalization casing exceptions
(`applyCasingExceptions`), the "move Track Number IDs into Track ID"
migration, an `algo_version` stamp on the fingerprint/waveform cache, a
150ms hover-dwell debounce on the row cover-info fetch, and 51 new Vitest
cases for `standardize.ts`.

**Verification.** `npm test` and `cargo test` pass (counts above); `npm run
build` (`tsc` + `vite build`) passes. This environment cannot drive
`npm run tauri dev` interactively, so A/B's UI acceptance criteria and D's
fix are **not** independently confirmed against the real app — the owner
should click through the wedding playlist (real artist/album/year, no path
strings, indexed-only tracks open) and, for D, turn on wheel logging and
reproduce the break.

### 56. Export Rekordbox playlists as .m3u8 for Mixxx — v0.14.0

The owner wanted to move a library from Rekordbox to Mixxx without
connecting a USB/SD device — Mixxx's own Rekordbox importer requires a real
device export (`PIONEER`/`Contents` folders), it can't read a bare
`rekordbox.xml`. `rekordbox_import.rs` already parsed `rekordbox.xml` for
cue import but explicitly skipped `<PLAYLISTS>` as out of scope.

**Fix** (`rekordbox_import.rs`): added `parse_playlist_tree` — a recursive
descent over `<PLAYLISTS>`'s `<NODE>` tree (`Type="0"` folder / `Type="1"`
playlist), returning a `PlaylistNode` tree for the UI plus a flat
`playlist id -> (folder path, name, track ids)` map for export. Also found
and fixed a real gap while testing this: `parse_rekordbox_xml` only matched
`Start`/`End` TRACK pairs, silently dropping any self-closed `<TRACK .../>`
(no cue children) — now handled via a shared `track_from_attrs` helper.
`export_rekordbox_playlists_for_mixxx` writes one `.m3u8` per selected
playlist (same `#EXTINF`/`-1` convention as `rekordboxExport.ts`'s
`buildM3u8`), mirroring Rekordbox folders as output subfolders, filenames
sanitized against Windows-reserved characters. `playlist_ids: None` exports
everything.

**UI**: new `RekordboxMixxxExportDialog.tsx` — a checkbox tree (all
playlists checked by default, so exporting everything is one click; folder
checkboxes are tri-state and toggle their whole subtree) fed by the new
`read_rekordbox_playlists` command, plus an output-folder picker. Wired into
Settings next to the existing Rekordbox Cue Import card.

**Verification.** 4 new `cargo test` cases (playlist tree parsing incl.
nested folders, m3u8 export incl. folder mirroring and artist-less tracks,
scoped export, filename sanitizing) plus all 8 existing rekordbox_import
tests still green; `cargo check` clean across the crate; `npm test` (131)
and `npm run build` (`tsc` + `vite build`) both pass. Not independently
confirmed against a real `npm run tauri dev` window or a real Mixxx import —
the owner should try it against their actual rekordbox.xml and confirm the
generated .m3u8s import cleanly via Mixxx's right-click "Import Playlist".

### 57. A permanent Library, AI playlists from it, right-click open, Settings crash safety-net — v0.15.0

The owner's library index got wiped (`library_root`, `library_track`,
`index_meta` all empty on 2026-09-30) because nothing distinguished the
**Library** (the fixed, permanent collection) from a **working batch** (songs
opened right now to clean). `addLibraryRoot` added every opened batch folder
as a library root, and `set_library_roots([])` deleted every track row when
called with no roots — both made emptying the index one click away, with no
confirmation either way. Full hand-off plan: `PLAN-v0.15-library.md`.

**Workstream E — Settings black screen.** Added a top-level `ErrorBoundary`
(`main.tsx`) plus a per-page one keyed by page in `App.tsx`, with "Copy
details" and "Back to tracks". A crash on any one page can no longer black
out the whole window. Static analysis of `SettingsPage.tsx`/
`useLibraryIndex.ts` found every empty-index field already null-guarded, so
the exact 09-30 trigger is unconfirmed — this is the safety net regardless of
cause.

**Workstream A — the Library is one permanent folder.** New single
`libraryFolder` setting (bumped `CURRENT_SETTINGS_VERSION`, migrated from the
first existing `library_root` row), defaulting to
`C:\Users\sopas\Music\Collection`. Deleted `addLibraryRoot` and the
`lastFolder` root-seeding — roots are now always exactly
`[settings.libraryFolder]`. `set_library_roots([])` rejects with an error
instead of wiping the index (the exact 09-30 bug, now impossible). "Clear
Index" moved under an Advanced fold requiring the user to type `CLEAR`. An
unplugged/offline Library folder keeps its rows ("showing last known
library") instead of pruning them as deleted — fixed a related bug found
while verifying this. Sidebar now reads "Library (N)" vs "Working batch (N)"
distinctly. Deferred: a filesystem watcher for external file changes, and a
"new" badge for batch-only genres in the picker (disproportionate re-plumbing
for a cosmetic marker).

**Workstream B — removed the "Genre" toolbar button**, the owner didn't use
it. Deleted `runGenre`/`onGenre`, the genre mode of `ManualAIDialog`, and the
whole Rust side (`ai_genre_prompt`, `ai_map_genre_batch`,
`claude_genre_batch`) after confirming nothing else called them. Settings →
Genres card (detect/merge near-duplicate spellings) is untouched — different
feature.

**Workstream C — right-click open everywhere.** Pulled the track table's
inline context menu into a shared `TrackContextMenu` (`useTrackContextMenu`
hook + `trackMenuItems()` helper), wired into the track table, the Library
search dock, and YT-import matched rows. Items: Open, **Add to working
batch** (routes through `filesApi.importPaths`, fixing the "in the index but
not loaded" gap), Reveal in Explorer, Copy path, Inspect tags. Multi-select
wording ("Open N songs") only applies within the track table's own
selection — the search dock and YT-import rows have no multi-select state to
hang it off yet.

**Workstream F — per-task Claude CLI model + effort.** Replaced the single
`claudeModel` setting with `claudeTasks: { clean, playlist }`, each a
model+effort pair (bumped `CURRENT_SETTINGS_VERSION`). Defaults: Clean =
sonnet/low (factual recall, fast), Playlist = sonnet/medium (judgment over
hundreds of tracks). `run_prompt` gained `--effort`. Found and fixed a real
bug while wiring usage reporting: the Claude-backend `emit_usage` sent
`promptTokens`/`completionTokens`/`songs`, but the frontend's `ai-usage`
listener (shared with the Ollama path) expected
`promptEvalCount`/`evalCount`/`tracks` — so Claude-backend AI usage was
silently never recorded until now. Also fixed `emit_usage` to pick the
`modelUsage` entry with the most output tokens instead of the first key.

**Workstream D0 — Rekordbox BPM/key into the Library.** New
`rekordbox_track` table in `library-index.sqlite` (path, bpm, key,
imported_at), LEFT JOINed onto `library_track` by case-insensitive path.
Settings → Library card: "Rekordbox XML: `<path>` [Choose…] [Re-import]",
auto re-imports at launch if the XML's mtime changed. BPM and Key now show as
optional columns in the track table and search dock. Verified via unit tests
only — no live Rekordbox XML export was available in this environment.

**Workstream D — AI playlists from the Library.** New "AI Playlists" tab on
the YT Music Import page (not a separate page, per the owner's decision):
filter the Library pool by genre/year/BPM/key/artist/rating, free-text
instructions, split into named sets (presets or custom), one compact prompt
line per track sent to whichever AI backend is configured (Ollama/Claude
CLI/Manual), strict-JSON response parsed to keep **only** track ids that were
actually in the pool — any id the AI didn't have is dropped and reported,
never guessed. Results are editable per set (reorder, remove, add from
search) with the shared `TrackContextMenu`, exported via the existing
`.m3u8`/Rekordbox XML builders. Simplified/deferred: no per-set target-count
sizing (presets just name the sets), "suggested to add" is copy-to-clipboard
text rather than a one-click import button, and playlist sessions aren't
saved/reopenable yet (would need a new sqlite session shape).

**Verification.** `npm test` 132/132, `cargo test` 101 passed, `npm run
build` clean, across every workstream. No live `npm run tauri dev` GUI
session or live AI-backend round trip was run in this environment — the
owner should click through Settings, open a batch outside the Library,
re-index, and run an AI playlist against the real Collection with at least
one real backend before relying on this release.

### 58. Settings crash from null usage counters — v0.15.1

**What/why.** Settings page threw `Cannot read properties of null (reading
'toLocaleString')`. A missing token count in an `ai-usage` event made a
running total `NaN`, which JSON-persists as `null`; the shallow
`{ ...DEFAULT_SETTINGS, ...saved }` merge then kept it.

**How.** `App.tsx` accumulates with `?? 0`; `useSettings.ts` sanitizes saved
`usage`/`plan` numbers on load (non-finite -> default), so already-corrupted
settings files heal on next launch.

**Verification.** `tsc --noEmit` clean. Not clicked through in the GUI yet.

### 59. "Open with MusicTagCleaner" in Explorer's right-click menu — v0.15.2

**What/why.** Right-clicking audio files in Explorer never offered the app.
`bundle.fileAssociations` only registers a ProgID, which Explorer ignores
once another player (AIMP here) owns the extension's UserChoice; and Windows
11's compact menu only lists `IExplorerCommand` handlers from packaged apps,
never plain registry verbs.

**How.**
- `src-tauri/windows/hooks.nsh` (NSIS installer hooks): adds the ProgID to
  each audio extension's `OpenWithProgids`, plus a classic
  `SystemFileAssociations\<ext>\shell\MusicTagCleaner` verb (shows under
  "Show more options"). Skipped when the main-menu DLL below is installed,
  since that entry already appears there too. Uninstall removes all of it.
- `src-tauri/shell-ext/`: standalone Rust cdylib implementing
  `IExplorerCommand` + class factory (CLSID `18a527bb-…`). Invoke launches
  the exe with every selected path (batched under the command-line limit;
  single-instance merges launches).
- `src-tauri/windows/sparse/`: sparse MSIX manifest (`desktop4/5`
  `FileExplorerContextMenus` + `com:SurrogateServer`) with
  `AllowExternalContent`, registered against the install folder.
  `build.ps1 -Install` builds the DLL, packs, signs, copies the DLL next to
  the exe and registers.

**Limit.** The sparse package must be signed by a cert the machine trusts.
It is currently signed with a self-signed dev cert, so the main-menu entry
is owner-machine only; everyone else gets the "Show more options" verb.
Shipping it needs a real code-signing cert (e.g. Azure Trusted Signing)
wired into `release.yml`.

**Verification.** `cargo test` in `shell-ext` (CLSID matches manifest);
package registered (`Status Ok`), COM class activates, and the owner
confirmed the entry shows in the Windows 11 main menu and opens files.
### 60. Explorer launch identity, Claude CLI offline, status bar — v0.15.3

**What/why.** Three issues after v0.15.2.
1. Opening a song via the right-click entry showed a second, icon-less
   taskbar button next to the pinned one. The shell-ext's child process
   inherited the sparse package's identity, so its window got the package
   AUMID instead of `com.sopas.musictagcleaner` (the pinned shortcut's).
2. Offline, AI Clean with the Claude CLI backend spun forever, and
   Settings -> AI stayed on "Checking the Claude CLI..." (the check ran a
   real prompt with no timeout, and the re-check button was disabled while
   it "ran").
3. The bottom-right Ollama dot in the status bar was noise.

**How.**
- `src-tauri/src/main.rs`: `SetCurrentProcessExplicitAppUserModelID` first
  thing in `main()`, plus the window-level AUMID (`SHGetPropertyStoreForWindow`
  + `PKEY_AppUserModel_ID`) in `setup`. `shell-ext/src/lib.rs` now starts the
  app with `CreateProcessW` + the desktop-app breakaway attribute so it
  runs outside the package (falls back to a plain spawn). `build.ps1`
  generates real Square44x44 (scale / targetsize / unplated), Square150x150
  and StoreLogo assets instead of one 128 px copy.
- `claude_cli.rs`: `run_with_timeout` (pipes drained on threads, process
  tree killed via `taskkill /T /F`), timeouts 10 s version / 30 s ping /
  60 s + 5 s per track capped at 5 min, a 3 s TCP pre-check of
  `api.anthropic.com:443`, and network phrases in stderr/`result` mapped to
  one "No internet connection" message. `ClaudeCliInfo.errorKind`
  (`offline | timeout | not_logged_in | other`) lets Settings say "Offline"
  instead of "Not signed in"; it has a 40 s client-side guard and re-checks
  on the window `online` event. AI Clean / AI playlists fail at once when
  `navigator.onLine` is false.
- `StatusBar.tsx` / `App.tsx`: Ollama indicator and prop removed
  (`ai.status` is still used elsewhere).

**Verification.** `cargo test` (new tests for envelope/stderr message
mapping and timeout scaling), `cargo build` in `shell-ext`, `tsc --noEmit`,
`npm test`, `npm run build`. **Not verified (needs the GUI / a real
machine):** that the shell-ext child really drops package identity (Task
Manager -> Details -> "Package name" blank), taskbar grouping/icon after
`build.ps1 -Install`, and the offline flows with the network adapter off.

### 61. Duplicates page: click-to-play waveforms, Skip by default, suggestion as a hint

**What/why.** Two problems on the Duplicates page. (1) There was no way to
audition the files in a group, so deciding which copy to keep meant leaving
the page. (2) A scan pre-selected Keep/Remove, so "Remove N to Recycle Bin"
right after a scan deleted files nobody had reviewed.

**How.** UI-only; `scan_duplicates`, `duplicates.rs` and `suggestKeeper()`'s
ranking are untouched.
- `src/pages/DuplicatesPage.tsx`: one shared `<audio>` for the page (groups
  can hold hundreds of rows). Clicking/dragging a row's waveform
  (`Waveform`'s existing `onSeek`) plays that file from there; a per-row
  Play/Stop button, a playhead and elapsed/total time on the playing row;
  clicking another row switches file at the clicked position (A/B). Joins
  the app-wide single-player contract (`takeOverPlayback`/`releasePlayback`).
  The audio is unloaded before a delete that includes the playing file and on
  re-scan so the webview doesn't hold a handle on a file being recycled.
  Space toggles the last-played row (not while focus is in an input/button).
- Every row now starts at Skip. The suggestion (duplicate groups only; none
  for "alternate") is shown as a faint green Keep / red Remove tint with a
  "Suggested: ..." tooltip. A selected Keep is solid green. New per-group
  "Apply suggestion" and a footer "Apply all suggestions". After a delete the
  suggestion is recomputed for any group that shrank.
- `src/lib/duplicates.ts` (new): `suggestKeeper`, `tagCompleteness` moved
  out of the page unchanged, plus `suggestReason()` which explains the
  ranking without altering it.

**Verification.** `tsc --noEmit`, `npm test` (new `duplicates.test.ts`:
FLAC beats MP3, bitrate, tag-completeness tie-break, reason strings),
`npm run build`. **Not click-tested** (needs `npm run tauri dev`): playback,
seeking, A/B switching, ghost tints, Apply suggestion, delete while playing.
Shipped in v0.16.0.

### 62. Library sidebar: browse every genre, load it as the batch, session tabs — v0.17.0

**Released as v0.17.0** (merged from the `genre-sessions` branch). The five
"(backlog item)" fixes since v0.13.2 were already covered by an earlier
release entry; nothing else on `master` was waiting on this release.

**What/why.** The sidebar's Genres list only tallied the files already loaded,
so you had to load a folder before you could see which genres exist, and a
click only filtered what was there. Now Genres lists every genre in the library
index, and a click loads that genre's tracks as the batch, so you can flick
through genres. A batch you built by hand (folder, files, drop, "Open with",
YouTube "Add to batch") is never thrown away by a click.

**How.** UI-only; no Rust changes (`library_genres` and
`library_paths_with_genre` already existed).
- `useFiles` records a `source` (`empty` | `genre` | `manual`); adding files
  by hand always makes it `manual`. `replaceWith()` swaps the batch and ticks
  nothing.
- `useGenreLoad`: paints the rows at once from the index, then re-reads real
  tags in chunks. A generation counter drops anything from a superseded click,
  so fast toggling can't mix rows. Rows the index lists but the disk no longer
  has are dropped (only after `path_exists` confirms) with one toast.
- Session tabs are snapshot-and-swap (`useSessionTabs`): only the active tab
  is live in `useFiles`/`useHistory`; the others park files, selection,
  source and undo stacks. The tag cache stays global (it is keyed by path).
  Closing a tab with undo steps asks first; switching is locked while a long
  action runs. Tabs are not persisted across restarts.
- A genre click in a manual session opens `GenreSessionDialog` (new tab /
  replace / filter, "Remember my choice"). The remembered answer is
  `settings.genreClickInManualSession` (settings v14), changeable in Settings
  → Library. An unapplied preview is confirmed before any swap discards it.
- Pure rules live in `src/lib/sessionTabs.ts` (+ Vitest): the click decision
  tree, tab titles, the manual-add flip, tab closing.
- The Genres list can be sorted by track count (default) or A–Z, via a toggle
  next to the genre search box. It's a UI preference kept in localStorage
  (`librarySidebar.genreSort`), not a setting.

**Verification.** `tsc --noEmit`, `npm test`, `npm run build` and
`cargo test` pass. The owner tried it in `npm run tauri dev` before release
(genre list and loading looked right). Not systematically click-tested (needs `npm run tauri dev`): the
instant paint and background refresh, fast genre toggling, the dialog and each
of its options, per-tab undo history, dropping files onto a genre tab, the
missing-files toast, and the Settings control.

### 63. Code review: DJ-data preservation, ratings, parallel scans, dependency refresh — v0.18.0

**Released as v0.18.0** (merged from the `code-review-fixes` branch). A
whole-codebase review: bugs fixed, slow paths made parallel, every
dependency brought up to date.

**What/why — data-loss bugs (the important ones).**
- **Every tag write wiped Serato/Traktor data and ratings.** lofty keeps the
  ID3v2 frames it has no generic key for (GEOB, PRIV, POPM, RVA2, UFID, …) as
  a hidden "companion" of the parsed tag. `write_tags_blocking` built each
  write on a fresh `Tag::new`, so fixing one typo in a title deleted Serato's
  hot cues/beatgrid/overview (GEOB), Traktor's PRIV block and the POPM rating.
  Proven with a probe test before the fix (`TIT2 GEOB PRIV POPM` → `TIT2`).
  The writer is now a diff on the file's own tag: unchanged fields are left
  exactly as stored (multi-value artists, comment descriptions, date format),
  changed ones are rewritten, unshown frames survive. Same fix in Restore
  Backup and Standardize Containers.
- **Custom TXXX / Vorbis fields were dropped on every edit** (checked
  `Tag::push` drops `ItemKey::Unknown`) — including Serato's FLAC data
  (`SERATO_MARKERS_V2`), and Restore Backup lost the Track ID.
- **MP3 ratings were never read** (POPM lives in the companion), FLAC/OGG
  4★ read back as 2★ (0–100 written, 0–255 read), and setting a rating on
  M4A wrote nothing and wiped the old one. POPM is now read/written through
  `Id3v2Tag`, keeping each frame's email and play count; bytes map to stars by
  bands that fit both Rekordbox (51/102/…) and WMP (1/64/128/…) scales.
- Clearing/editing the searchable-backup field was silently reverted; an
  existing backup snapshot was deleted by any write with backups off;
  undoing a raw "All Tags" clear did nothing (the field can now be recreated
  by name, `item_key_from_name`); Convert stripped BPM/key/label from its output.
- The displayed Comment is the plain one, not iTunes' `iTunNORM` hex.

**Other bugs.** One panicking file dropped a whole thread's chunk of batch
results (`par_map` now isolates panics per item); Rekordbox `percent_decode`
panicked on `%` before a multi-byte char, and `location_to_path` broke every
macOS import; BPM/key never joined for paths with non-ASCII capitals (SQLite
`LOWER()` is ASCII-only — settings v15 forces one re-import); the index's
offline-root guard used a string prefix (`C:\Music` swallowed `C:\Music2`);
no SQLite busy timeout; enrichment cancel was undone by the next run (now a
generation counter); yt-dlp had no socket timeout; a dropped download left a
truncated `yt-dlp.exe`/ffmpeg as "installed" (shared `download.rs`, `.part` +
rename); Claude CLI playlist prompts over ~32K chars failed on Windows (now
piped through stdin above 8K); rename now refuses separators/device names;
settings writes from stale render snapshots reverted concurrent changes
(functional `update`/patch saves everywhere); `useFiles.refresh` dropped files
added mid-refresh; undo/redo didn't reindex the Library; table sort with blank
years was undefined (NaN comparator); `._` AppleDouble files listed as tracks;
`.opus` (a Convert output) wasn't a recognised extension; first-launch Library
prompt suggested a hard-coded `C:\Users\sopas\...` path; Rekordbox playlist
XML broke on control characters in tags and doubled the slash in macOS
`Location`s; history recorded changes whose write had failed, and left raw
Clear Fields un-undoable (both fixed — raw clears now undo); renames, deletes
and convert-and-delete never told the Library index, leaving ghost tracks
(`reindex_paths` now drops rows for vanished files); the Library-root check
assumed `\` separators; Ollama pulls garbled UTF-8 split across chunks and
could hang forever on a stalled stream; one failed AI Clean batch discarded
every finished batch, and an answer could overwrite another batch's track with
an out-of-range index (`resultsForBatch`); the Stems dialog showed no progress
during a separation (tqdm redraws with `\r`, the reader only split on `\n`).

**Performance.** Duplicate fingerprinting and the O(n²) comparison run in
parallel (were single-core); decode streams straight into the fingerprinter
(bit-identical — tested, cue keys stay valid) and waveforms are computed while
decoding (no 100 MB PCM buffers); Rekordbox cue import batches fingerprints
and writes one transaction; `par_map` hands out work dynamically; Artwork
column reads image headers only; thumbnails use a fast downscale; the track
table re-renders per row scrolled, not per scroll event; sidebar resize saves
on release (was a settings write per mousemove); `Intl.Collator` for sorts.

**Dependencies.** React 19.3, Vite 8 (Rolldown — chunking moved to
`codeSplitting.groups`), Vitest 5, TypeScript 7, Tauri 2.12 + plugins,
lucide, Tailwind 4.3.3; Rust: reqwest 0.13 (rustls/ring shared with the
updater — one HTTP stack instead of two, no aws-lc C build), base64 0.23,
windows 0.62 (app + shell-ext, one copy with Tauri), lofty **0.22** (see
backlog for why not 0.25). CI: Node 22 (20 is EOL), actions v5, Rust + npm
caching in `release.yml`, new `ci.yml` (build + tests on every push).

**Verification.** `npm run build`, `npm test` (160), `cargo test` (130) pass;
`cargo check` is warning-free. The new writer was also run over **all 4,735
real mp3s in the owner's Music folder** (temp copies only — the ignored test
`real_library_write_preserves_every_frame`, `MTC_TEST_DIR=...`): every frame
preserved, artist/comment/rating unchanged. It surfaced one real regression,
fixed before shipping: a recorder file's COMM frame with language `[0,0,0]`,
which lofty refuses to write once unchanged frames are kept verbatim —
`repair_item_languages` resets invalid languages to `XXX`. None of those files
carried GEOB/PRIV/POPM frames, so those paths are covered by synthetic tests.
New regression tests cover each data bug on real MP3/FLAC files. Not
click-tested in `npm run tauri dev` yet.

### 64. Library, artwork, lyrics, DJ playlists + sync, AI control, plugins — v0.19.0

**Released as v0.19.0.** A 12-part batch built by parallel agents from the
briefs in `plans/v0.19/` (uncommitted); each part's what/why/how-verified and
click-through list is in `plans/v0.19/notes/<id>.md` (committed). Summary:

- **A1 Duplicates page.** Fixed-width time slot so the waveform never shrinks
  on play; cover thumbnails (lazy, `read_cover_thumbnail`); **Skip removed**
  — rows are Keep / Remove / undecided, nothing pre-marked after a scan;
  empty waveform is a flat, still-seekable bar with a regenerate button;
  one-click Track ID chip; right-click menu incl. **Show in Library**
  (`src/lib/focusPath.ts` → table selects + scrolls).
- **A2 Waveforms + duplicate recall.** All 4289 Collection MP3s decode fine;
  missing waveforms came from the cache write failing (`?`) while a scan held
  the sqlite lock, and unbounded parallel decodes. Cache I/O is best-effort,
  max 4 decodes at once, partial decodes kept, FFmpeg fallback, and a readable
  error instead of an empty `Ok`. Duplicates gained a **tag stage**
  (normalized artist+title, filename fallback, DJ-pool/version tags
  stripped) and real header lengths, so radio vs extended is found as
  `alternate`: 0 → 226 groups on the owner's Collection, scan 274s → 140s.
  `DuplicateGroup.reason` = audio | tags | tags+audio.
- **A3 Tag audit + Rekordbox fields.** Cross-format round-trip matrix
  (MP3 v2.3/v2.4, FLAC, M4A, OGG, AIFF, WAV). Fixed: Original Artist lost on
  FLAC/OGG/M4A, Track ID lost on M4A, session rows losing Rekordbox BPM/key.
  BPM + Key columns (tag first, Rekordbox fallback, "RB" marker), key notation
  setting (`src/lib/keys.ts`), Rekordbox XML `Rating` → stars, and a
  **Rekordbox → tags** bulk write (previewed, undoable).
- **B1 Library sidebar.** Genres/Albums/Languages share one facet system
  (`src/lib/facets.ts`); "No genre/album" rows; album rename retags the index;
  library **Search** tab with Add / Add N (no drag); **Refresh** button +
  optional refresh-on-focus. Index stores the file's own BPM/key
  (`INDEX_VERSION` 4) and search understands `bpm:` / `key:`.
- **B2 Artwork.** MusicBrainz → Cover Art Archive → iTunes → Deezer lookup
  (1 req/s to MB, 30-day sqlite cache), candidate picker + bulk auto-pick
  with a confidence threshold. **Junk Art**: dHash of every embedded cover,
  clusters spread across many artists = DJ-pool logos (61 clusters, biggest
  82 tracks/74 artists on the owner's library); blocklist in `artwork.sqlite`.
- **B3 Lyrics + Language.** LRCLIB lookup (get → search, duration-checked,
  retries, cached); sidecar `.lrc` by default, embedded optional; Lyrics
  panel follows prelisten. 63/100 hit rate on a library sample. `language`
  field ↔ TLAN/LANGUAGE (ISO 639-2), offline `whatlang` detection as
  previewed suggestions, optional `#lang-xx` in Comment, `lang:` search.
  `INDEX_VERSION` 5.
- **B4 Organize + library file.** "Move to collection…" with a pattern,
  preview, never-overwrite, cross-volume copy+verify, undo, old→new path CSV
  in `move-maps/`. Library db location is choosable (`VACUUM INTO` +
  integrity check); snapshots (`.sqlite` + `library.json`), keep-N,
  snapshot-on-exit, restore.
- **C0 → C1 DJ playlists.** Rekordbox 7 `master.db` is read via a
  **pure-Rust SQLCipher 4 decrypt** of a temp copy (`sqlcipher.rs`; the
  rusqlite sqlcipher feature needs Perl/OpenSSL and would replace `bundled`).
  Playlists page with Rekordbox / Mixxx / MTC tabs, copy/duplicate/rename/
  delete, smart-rule model + editor (`src/lib/smartRules.ts`), genre/album/
  language → smart playlists (idempotent). Mixxx written directly (app closed,
  backup, one transaction, `foreign_keys` off — Mixxx's FKs point at a stale
  `library_old`); Rekordbox only via generated rekordbox.xml.
- **C2 Rekordbox ⇄ Mixxx sync.** Snapshot diff per side (`djSync.ts`,
  state in `dj_sync_state`), preview → apply, conflicts surfaced, first sync
  never deletes, B4 move-maps applied. Metadata: BPM (never over a Mixxx
  beatgrid), key (incl. Mixxx `KeyMap` blob), rating, play count, comment,
  colour. Dry run on db copies: 217 lists + 3530 track updates to Mixxx, 221
  updates to the Rekordbox XML, second run a no-op.
- **D1 AI control.** Action registry (`src/lib/actions.ts`, ~60 actions
  wrapping existing handlers, JSON-Schema params, `script.run` batches with
  dry-run); localhost-only `tiny_http` bridge with a random bearer token in
  `bridge.json`, off by default, dangerous actions confirm in-app, every call
  logged; separate `mcp/` crate (`rmcp`, stdio) that builds MCP tools from
  the registry at runtime.
- **D2 Plugins + themes.** Plugin SDK (`plugins/sdk.d.ts`), code runs in a
  Worker inside a sandboxed iframe (CSP `default-src 'none'`), deny-by-default
  permissions, nothing runs until its exact bytes are approved; toolbar
  buttons, context items, columns. 5 bundled themes over the shadcn tokens
  ("Follow OS" stays default). AI "New button" (generic text-gen command on
  Ollama/Claude CLI/manual) → same review prompt. Store tab: `index.json`,
  sha256-verified zip, staged until approved. Guide: `PLUGINS.md`.
- **Startup fix.** reqwest uses `rustls-no-provider`; `main()` now installs
  the ring provider (tests had each installed it themselves, so every HTTPS
  call panicked only in the real app).

Settings v16 → v24. Tests at release: 349 TS, 230 Rust, 9 mcp. Smoke-run in
`tauri dev` by the owner; per-feature click-throughs in the notes files.

### 65. v0.19 follow-ups: bundled MCP server, lyrics output window, SQLCipher encrypt — v0.19.1

**Released as v0.19.1.** Three follow-ups from item 64's backlog, built by
parallel agents; details + click-throughs in `plans/v0.19/notes/F1.md`,
`F2a.md`, `F3.md`.

- **F1 `mtc-mcp` ships with the app.** `scripts/build-sidecar.mjs` builds the
  `mcp/` crate for the target triple and copies it to
  `src-tauri/binaries/mtc-mcp-<triple>`; it runs from `beforeBuildCommand`
  (release) and `beforeDevCommand` (debug), so `release.yml` needed no new
  step (only `mcp -> target` in rust-cache). `bundle.externalBin` +
  a `build.rs` placeholder so a bare `cargo test` / `ci.yml` still builds on a
  fresh clone (tauri-build fails on a missing externalBin); the script
  overwrites the placeholder before any real bundle. Settings → AI control now
  points at the bundled binary. Verified with a local `tauri build`: MSI and
  NSIS both include `mtc-mcp.exe`.
- **F3 Lyrics for live visuals.** Click a synced line to seek the prelisten
  player (seek channel in `nowPlaying.ts`, single-player contract kept).
  **Lyrics output window** (`lyrics_output.rs`, label `lyrics-out`, capability
  `lyrics-output.json` = events only): big current/next line, Clean /
  Karaoke-fill / Neon / Lower-third styles, black / transparent / chroma-green
  background, font size + sync offset, fullscreen + move-to-monitor, and a
  manual stepping mode for playing from Rekordbox. Main window broadcasts over
  events; the output window keeps its own clock. Settings v26. Mixxx-follow
  mode designed in the notes, not built.
- **F2a SQLCipher 4 encrypt (library + tests only).** `encrypt_database` in
  `sqlcipher.rs` mirrors the decrypt (fresh per-page IVs, HMAC-SHA512,
  page-1 salt). Real-copy round trip: 12259 pages, plaintext byte-identical,
  4405 tracks, integrity ok. **No write path** — nothing calls it and nothing
  writes under `%APPDATA%\Pioneer`; direct `master.db` writes need a
  separately approved step (see `F2a.md` "Write path — NOT built").

Tests at release: 369 TS, 236 Rust, 9 mcp.

### 66. Reliability pass: crash-safe tag writes, faster duplicate scans, fixes — v0.19.2

**Released as v0.19.2.** A review of everything since v0.18's (most of it the
v0.19 batch): data-safety fixes first, then speed, then smaller bugs and a
dependency refresh.

**Crash-safe writes (the important one).** lofty saves in place — it reads
the rest of the file, truncates it to zero and writes it back — so closing the
app during a batch write (exit doesn't wait for the worker threads, and a
batch keeps several inside that window), a crash, a full disk or a dropped USB
stick/network share left zero-length or truncated tracks. Every tag write now
goes through `commands/safe_save.rs`: lofty parses and edits a working copy
(in memory, or a temporary copy on disk above 256 MB), the result goes to a
`.mtc-<pid>-<n>.tmp` file beside the track and replaces it in one rename —
the file is always the old version or the new one. Also:
- one parse per write instead of two (the edit reads its own working copy);
- an edit that changes nothing leaves the file and its modified time alone
  (e.g. Remove Cover Art on a file with none);
- edits of one file serialize (per-path lock): two raw-field writes of the
  same file in one batch used to race and lose one;
- secondary-tag removal and the main save land in the same replace, so a
  failed save no longer leaves ID3v1/APE already deleted;
- creation date and permissions survive; read-only files are refused; a
  symlinked track is edited at its target; the rename retries briefly over
  a virus scanner's sharing violation; a folder that refuses the temporary
  file (a NAS share vetoing dot-files, create-denied ACLs) falls back to the
  old in-place write rather than failing — but a full disk never does.
- No fsync before the rename, on purpose: measured on the owner's SSD it made
  each save 5-15x slower (17-50 ms vs ~3 ms per 10 MB file) and the failure
  modes above don't need it; power loss is no worse than lofty's own write.
- Frontend: `updateFieldMany` folds several edits of one file into one write
  (`foldEditsByPath`) — as separate items the later write undid the earlier.

**Faster duplicate scans.** The all-pairs stage ran `match_fingerprints` —
a fresh concatenate + sort of ~2,000 items — for every pair. `could_match`
now answers a *necessary* condition first: the matcher's own offset histogram
(one pass over a per-row hash bucket table, peak tracked while counting) gives
the alignment it would choose, and if no run of bit differences at that
alignment is long and close enough to pass the classification thresholds,
the pair cannot match. Only the rest go to the real matcher, so results are
unchanged (`prefilter_never_changes_a_result` checks alignments and outcomes
over identical/noisy/shifted/truncated/unrelated fingerprints). Bench: 26.7 µs
→ 4.1 µs per pair (6.4x) on fingerprint-sized inputs; a rescan with cached
fingerprints is mostly this stage.

**Convert.** FFmpeg writes to `<name>.mtc-part` (format passed with `-f`,
`ipod` for m4a) that is renamed into place when done: a failure no longer
leaves a truncated track under a real name, and a failed overwrite no longer
deletes the earlier good output. Files convert up to four at a time (every
encoder used is single-threaded); two sources mapping to one output name in a
batch are refused instead of racing.

**Settings can't be lost to a cut-short save.** The store plugin writes
`settings.json` in place and ignores a file it can't parse, so a save cut
short reset every setting on the next launch — and the first save after
that made it permanent. Every save now also goes to `settings.backup.json`
(`settings_backup.rs`: temp file, flushed, renamed; stale out-of-order writes
dropped by a sequence number), written on every launch too; an empty or
unreadable store is restored from it and `settings.json` repaired. Checked in
the app: an emptied `settings.json` came back byte-identical.

**Failed writes no longer look done.** A cell edit, bulk edit, rating, "All
Tags" edit or Unify Track IDs whose write failed (a file locked by a DJ app)
used to update the table and enter undo history anyway (`writtenOnly`); a
failed undo of a raw field moved the entry as if undone; Remove Duplicates
dropped every chosen row and file from view, deleted or not (it now gets the
paths that really went to the Recycle Bin; `duplicates.delete` reports
`removed`).

**Fixes.**
- Generate IDs, Back Up, Restore Backup and Standardize Tag Format never
  refreshed the Library index, so genres and search kept the old values until
  a full re-index; renaming a genre/album everywhere released the busy lock
  before its off-session retag had finished.
- Lyrics output window: its commands created/moved a window from synchronous
  commands, which Tauri documents as a WebView2 deadlock on Windows — now
  async. It also closes with the main window (it kept the app running alone).
- Mixxx backups missed changes still in `mixxxdb.sqlite-wal` (the doc said it
  copied the -wal; the code didn't) — now `VACUUM INTO`, file copy as fallback.
- Artwork: full-size covers from Apply were cached in `artwork.sqlite`
  forever (hundreds of KB per track — GBs after a library-wide auto-pick); now
  fetched uncached, and expired cache rows are pruned once per session.
- Library index: changing the root kept `C:\Music2` rows for a `C:\Music`
  root; `reindex_paths` (retag, Move to collection) indexed paths outside
  every root — rows no index run would ever refresh; root checks are
  case-insensitive on Windows/macOS like the filesystem; retag progress ended
  one step short.
- Rekordbox BPM/key import: one transaction (was a cleared table + one commit
  per row, non-atomic and slow); `Location`s on a network share (`//nas/...`)
  keep their UNC prefix.
- Move to collection across drives flushes the copy before deleting the
  original.
- YouTube import: " - Topic" stripping sliced names wrong (or could panic)
  when lowercasing changed a character's length ("İ"); a playlist yt-dlp
  partly failed on (exit ≠ 0 with `--ignore-errors`) is now shown instead of
  discarded.
- Plugin `fetch` and the plugin store read at most their size cap instead of
  buffering a whole response first.
- USB formatter: the label is reduced to FAT32's charset before it goes on
  the elevated helper's command line (a trailing `\` broke the quoting); a
  failed volume lock says to close Explorer/apps using the drive.
- Language detection reads each file once instead of twice.

**Dependencies.** Semver-compatible refresh: Tauri 2.12.5 (+ dialog 2.8.3,
opener 2.7.2, updater 2.14.0 on both sides), React 19.3.1, Vite 8.3.5, Vitest
5.0.5, lucide 1.61, tokio 1.54, rmcp 3.7 (mcp). Not taken: zip 9, getrandom
0.4 and the RustCrypto 0.11/0.13 family (API migrations, no functional gain),
lofty 0.25 (backlog).

**Verification.** `cargo test` 252 (+16, plus 2 new opt-in), `npm test` 375 (+6), mcp 9. New
ignored test `real_files_of_every_format_survive_an_edit` run on copies of
real tracks (9 FLAC/MP3 from the CDJ spike stick + a 576 MB MP3 for the
on-disk working-copy path): every field kept, decoded audio bit-identical,
JSON backup restores. Real-FFmpeg conversion test over all nine presets.

### 67. FLAC/OGG comment names kept on save; Convert keeps repeated fields — v0.19.3

**Released as v0.19.3.** Two tag-data bugs found while click-testing v0.19.2,
both older than it.

**Vorbis comment names (FLAC, OGG, Opus).** Every save went through lofty's
generic `Tag`, which reads each comment name into an `ItemKey` and writes it
back under that key's first spelling. Any edit — a title, a rating, a backup —
renamed MIXARTIST → REMIXER (Traktor reads MIXARTIST), KEY → INITIALKEY
(VirtualDJ / Engine DJ read KEY), TOTALTRACKS → TRACKTOTAL, WRITER → AUTHOR
and others, turned ORGANIZATION into a second LABEL ("X;X" in apps that join
values), and wrote the vendor string (shown by lofty as `EncoderSoftware`) out
as a new ENCODER comment. `commands/vorbis_save.rs` now saves a Vorbis tag as
a patch of the comments the file holds: it re-reads them from the working
copy, keeps every (name, value) the edit left alone exactly as stored and in
place, puts a changed value in the place and under the name of the comment it
replaces, and only a field the file never had gets lofty's name. The vendor
stays the vendor; an untouched picture keeps its stored size/colour info. Every
generic-tag save goes through `files::save_generic_tag` (tag edits, raw-field
edits, backup, restore, cover art, Standardize Tag Format). Files edited by
earlier versions keep the names they were given then.

**Convert: repeated fields.** `TagData` holds a field's first value, and the
tag copy after FFmpeg wrote it over the full list FFmpeg had carried as
"A;B;C": a FLAC with five COMPOSER comments converted with one (the same for
repeated ARTIST / ALBUMARTIST / GENRE). `files::read_tags_for_copy` gives such
a field every distinct value joined with ";" — FFmpeg's form for every other
field — so the copy matches what FFmpeg wrote and leaves it alone.

**Verification.** `cargo test` 259 (+7): unit tests of the patch, a FLAC taken
through edit → raw-field edit → restore with every name kept, the copy's join.
`flac_comment_names_survive_every_kind_of_save` fails on the old save with
exactly the damage seen on real files. Opt-in: real FFmpeg FLAC → MP3 keeps
three composers and FLAC → Opus keeps MIXARTIST/KEY through the copy and a
later edit; `real_files_of_every_format_survive_an_edit` now also compares the
stored Vorbis comments (vendor, names, order) after an edit and after a
restore — all 9 real FLAC/MP3 pass. `npm test` 375.

## Roadmap — v1.0

v0.6 through v0.9 are complete (items 1–37). Everything below is v1.0 —
accounts, pricing and payments.

**2026-09-03 — architecture decided.** Four forks in P1–P3 were resolved:

- **Backend: Path A**, the managed stack — Supabase Auth + Postgres, a thin
  Edge Function layer for entitlements/usage/webhooks, no custom-built auth
  server. Full plan and the rejected Path B (custom Rust/Node backend) are
  in the [Accounts & Pricing Plan](https://claude.ai/code/artifact/123d03a8-c826-41c8-b91e-92c6d2ae44fa) artifact.
- **Payments: Paddle**, as merchant of record, over Lemon Squeezy or Stripe.
- **Scope: Music Tag Cleaner first.** The Forgexus account ships here; the
  API is designed so Media Fetch can plug into the same backend later
  without a rework, but it doesn't have to launch alongside this.
- **Timing: starting now**, beginning with Phase 0 below.

The schema this implies is already in the repo:
[supabase/migrations/0001_init.sql](supabase/migrations/0001_init.sql)
(`entitlements`, `usage_counters`, `devices`, RLS policies restricting the
desktop app's own client to reading its own rows — every write goes through
a service-role Edge Function).

### Phase 0 — setup (you, not code)
Nothing below needs Claude; these are accounts and settings only Sergio can
create. Once they exist, Phase 1 (the Edge Functions) and Phase 2 (the
Rust `commands/account.rs` + Settings UI) get built and *validated against
the real endpoints*, the same way F4/F5 this session were validated against
a real playlist and a real `rekordbox.xml` rather than shipped on fixtures
alone.

1. Create a Supabase project (suggest naming the org **Forgexus**). Note
   the project URL and anon public key once it exists — both are meant to
   be embedded in the app, safe to share here.
2. Authentication → Providers: enable email/password and magic-link at
   minimum; add Google OAuth if wanted.
3. Authentication → URL Configuration → Redirect URLs: add
   `musictagcleaner://auth-callback`. Confirm that custom URL scheme
   doesn't collide with anything Media Fetch already registers.
4. Run `supabase/migrations/0001_init.sql` against the new project (SQL
   editor, or `supabase db push` via the CLI) once it exists.
5. Create a Paddle account, Paddle Billing (not Classic). Set up the
   subscription products from P2 below — Pro ($8/mo, $60/yr) and Studio
   ($18/mo, $150/yr) — and the one-time Lifetime product ($180) if it's
   launching in this same window rather than as a later promo.
6. Confirm the P2 tier names/prices and the P2 feature-to-tier table stand
   as written, or flag what should change before checkout UI gets built
   around specific numbers.

Paddle's webhook endpoint (step 5's missing piece — pointed at the
`paddle-webhook` Edge Function) gets wired up in Phase 1, once that
function exists to point it at.

---

# v1.0 — Accounts, pricing, payments

Built by **Sergio Alexo**, founder of **Forgexus**.

### P1. Forgexus account login
Sign in with a **Forgexus account** — the unified identity across the Forgexus
group's technology and manufacturing divisions, so one account covers
MusicTagCleaner, Media Fetch and everything that follows.

- OAuth 2.0 + PKCE in the system browser, tokens in the OS keychain
  (Windows Credential Manager / `tauri-plugin-stronghold`), background refresh,
  never a password typed into the app
- entitlements (tier, quota, device count) cached locally and signed, so the app
  works offline for a 7-day grace period before requiring a re-check
- **the app stays fully usable signed-out for everything local** — sign-in gates
  cloud AI and quota, not tag editing
- device management: 3 activations per account, self-service deactivation

### P2. Pricing structure — recommendation
The natural axis is *who does the thinking*, which is also what actually costs
money. Three AI modes, cheapest to dearest, exactly as the compute cost runs:

| Mode | What it is | Cost to you | Positioning |
|---|---|---|---|
| **Manual** | You edit; the app standardizes and validates | zero | Free |
| **Local (Ollama)** | The user's own machine runs the model | zero marginal, plus support | Mid |
| **Cloud (Claude API)** | Best quality, no setup, works anywhere | real per-track cost | Top |

Recommended shape — **subscription for the app, credits for cloud AI**:

- **Free** — full manual editing, standardize, rename, clear fields, backup ZIP,
  library browser. No time limit. This is the funnel; don't cripple it.
- **Pro — ~$8/mo or $60/yr** — local Ollama AI, auto genre detection, duplicate
  detection, playlist matching, waveform + cue import, preset sync across
  devices.
- **Studio — ~$18/mo or $150/yr** — everything in Pro plus cloud (Claude) AI
  with a monthly track allowance, priority processing, batches above 1000.
- **Cloud credit packs** — for anyone over their allowance, and for Pro users
  who want an occasional cloud run without upgrading. Price around 3–4× raw API
  cost to cover payment fees, retries and support.
- **Lifetime — ~$180, manual + local only, no cloud AI.** Worth offering once,
  early, as a founder's edition. Never bundle a recurring cost into a one-off
  price.

Per-feature placement, cheapest to dearest, as asked:

- *free:* manual editing, **auto genre detection** (it's a local tally, not AI),
  capitalization + character tools, filename rules, backup ZIP
- *Pro:* duplicate detection + fingerprinting, waveform, cue import, playlist
  matching, Ollama AI cleanup
- *Studio / credits:* Claude-powered auto-clean, genre *inference* for tracks
  with no usable tags, artwork lookup, bulk cross-library unification

**Free AI allowance:** first **3000 tracks free**, then **10 tracks/day free**
across all AI features. Counted server-side against the Forgexus account (a
local counter is trivially reset), shown as a remaining-count in the status bar,
and decremented **only on a successful write** — never charge for a failed or
rejected suggestion. Local Ollama should *not* consume the allowance: it costs
nothing to run, and letting it run free is the strongest argument for Pro.

### P3. Payments — recommendation
**Don't go crypto-only.** Plainly:

- The buyers are DJs, not crypto users. Crypto-only cuts off the large majority
  at checkout — the most expensive decision on this list.
- Subscriptions are the whole model, and crypto has no native recurring billing.
  Every renewal becomes a manual action the user must remember, which wrecks
  retention.
- Refunds, chargebacks and EU/UK **VAT on digital goods** are legal obligations
  a wallet doesn't handle for you.

**Recommended:** cards + PayPal + Apple/Google Pay through a **merchant of
record** — **Paddle** or **Lemon Squeezy** (Paddle if EU VAT and invoicing
matter most, which for a one-person company they do). They become the seller of
record, so global sales tax, invoicing and fraud are their problem, not yours:
roughly 5 % + fixed fee versus Stripe's ~2.9 % + 30¢ *plus* doing tax compliance
yourself. For a solo founder that difference is cheap.

**Add crypto as a secondary option**, not the only one: BTC / ETH / USDC via
Coinbase Commerce or BTCPay Server, offered for **one-time purchases only** —
lifetime licences and credit top-ups, where there's no recurring-billing problem
to solve. Cheap to add, appeals to part of the audience, takes nothing from
anyone else.

Practical notes: price in USD with local display currency; discount annual plans
~35 % to smooth cash flow; state a 14-day refund policy plainly (cheaper than
disputes); and make licence checks **fail open** — a payment-provider outage
must never lock someone out of editing their own files.

---

## Open questions

- ~~Does a local database become the source of truth~~ — **decided**: yes.
  F1 (item 31) added a local sqlite database at
  `app_data_dir()/fingerprint-cache.sqlite`, keyed by path + mtime + size.
  F3's waveform peaks are a natural fit for the same database/cache
  (same cache-invalidation story); F5's cues should use it too, keyed by
  fingerprint rather than path per the original plan, so cues survive a
  rename or move.
- YouTube Music has no official third-party playlist API. Confirm which access
  path is workable and acceptable before committing F4 to a release.
- Cross-library cue unification (F5's stated goal) is a large project in its own
  right — probably v1.1+, not a rider on v0.9.

---

## Backlog (unscheduled)

- **lofty 0.24+ migration.** 0.24 removed `ItemKey::Unknown`, so the
  generic `Tag` can no longer carry custom keys — the private TXXX:TRACKID,
  the TAGBACKUP snapshot and every `Unknown(...)` raw field. Upgrading means
  porting the tag layer to each format's own API (`Id3v2Tag` TXXX,
  `VorbisComments`, MP4 freeform atoms, APE), keeping the `key_name` strings
  stored in settings (`raw:` clear-field picks, column widths) stable. Pinned
  to 0.22 in `Cargo.toml` until then (2026-10-07).
- ~~Optional one-click "move Track Number ids into Track ID" for pre-v4
  libraries~~ — done 2026-09-26: `buildTrackIdMigrationPreview()`
  (`standardize.ts`) scans every loaded file for a Track Number that
  `isUid()` says looks like a generated id and has no real Track ID yet,
  and offers to move it over (clearing Track Number) through the same
  Preview/Apply flow as Standardize — nothing writes until reviewed.
  "Move IDs from Track Number" button on the Settings → Track IDs card.
- ~~`useImageInfo.fetchOne` fires on every row `onMouseEnter`~~ — done
  2026-09-25: a 150ms hover-dwell debounce (`HOVER_DWELL_MS`/`dwellRef` in
  `useImageInfo.ts`) now keeps only the most recently hovered row's request,
  so a fast sweep across the table no longer queues an `image_info` call
  per row passed over.
- `file_info` does a full tag parse just for `hasBackup` + `duration`; making
  those lazy would make import near-instant (`fs::metadata` only).
- ~~No automated tests for `standardize.ts`~~ — done 2026-09-25
  (`src/lib/standardize.test.ts`, 51 tests: replacements, capitalization
  modes incl. Roman numerals/initialisms/shouting, weird-char flagging,
  both filename sanitizers incl. Cyrillic, rename-stem building, track-id
  helpers). Table selection logic still has no automated tests.
- ~~Capitalization "casing exceptions"~~ — done 2026-09-26:
  `applyCasingExceptions()` (`standardize.ts`) re-stamps each user-defined
  token over whatever a capitalization mode produced, matched case-
  insensitively at a word boundary as a whole phrase (handles a punctuated
  exception like `AC/DC` or `feat.` the same as a bare word like `McFly` —
  `toTitleCase`'s own per-letter-run word matching would otherwise split
  `AC/DC` into separate `AC`/`DC` tokens around the slash). New
  `settings.casingExceptions: string[]` (settings v10), editable as a chip
  list on Settings → Standardize under "Casing exceptions".
- `settings.columnWidths` accumulates an `extra:<key>` entry for every raw
  field ever resized and never prunes them — harmless but untidy.
- ~~The `file_cache` sqlite table has no algorithm-version stamp~~ — done
  2026-09-26: `algo_version INTEGER` column (`duplicates.rs`), an
  `ALGO_VERSION` constant to bump whenever `fingerprint_config()` or
  `WAVEFORM_BUCKETS` changes, `open_db` migrates an existing database via
  `ALTER TABLE` (ignoring the "already has this column" error), and a row
  whose `algo_version` doesn't match is treated as a cache miss for both
  the fingerprint and the waveform.
- A genuine duplicate that fragments into several matching segments (re-
  encoding artifacts, minor structural drift) under-classifies as
  "alternate version" rather than "duplicate", because `classify_pair` only
  measures coverage from the single largest segment (see item 34's real
  false-positive-vs-worse-regression story before changing this) — real,
  reproducible (`Pitbull - Hotel Room Service` in the user's own library),
  left alone because the two fixes tried for it both made a different case
  much worse. Needs a coverage measure that distinguishes "matched fairly
  densely across a wide range" from "a handful of scattered short matches
  spread over a wide range" — simple span or simple sum both fail one real
  case or the other.
- v0.19 follow-ups (bundled MCP + lyrics seek/output window + SQLCipher
  encrypt done in v0.19.1): still open — direct Rekordbox `master.db` writes
  (needs separate approval, see `plans/v0.19/notes/F2a.md`); verify Rekordbox
  XML import updates existing tracks' metadata; observe numeric Rekordbox
  smart-rule encodings (BPM/rating/key/date); Mixxx-follow mode for the lyrics
  output window (design in `F3.md`).
- (add items here)
