# Spike: CDJ USB export via rbxport crates

Date: 2026-10-19. Branch `spike/rbxport-usb-export` (off origin/master 95b019d, v0.19.1).
Upstream: chrisle/rbxport @ `7fb4dad3f88a2cc0cecec0e718b4dde408fd7448` (v1.9.0, GPL-2.0-or-later → used under GPL-3).

## What was done
- `src-tauri/Cargo.toml`: `rbl-export`, `rbl-anlz`, `rbl-audio`, `rbl-analysis`, `rbl-pdb` as git deps pinned by rev.
- `src-tauri/examples/rbxport_spike.rs`: reads one playlist from a `rekordbox.xml`, remaps
  Locations by file name onto a local music folder, analyses each track with `rbl-analysis`
  (beat grid, key fallback, PWAV overview), exports with `rbl_export::export`, then
  `rbl_export::verify` + reads `export.pdb` back with `rbl-pdb`.

Run (needs the MSVC env + Strawberry Perl first on PATH, see "Build"):

    cargo run --release --example rbxport_spike -- <rekordbox.xml> <playlist> <music dir> <dest dir>

## Results
- **Windows/MSVC build with SQLCipher: works.** `openssl-src` 3.6.3, `libsqlite3-sys`
  (bundled-sqlcipher-vendored-openssl), `mp3lame-sys` and all `rbl-*` crates compiled with
  VS 2022 Build Tools 14.44 + Strawberry Perl 5. Requirements: a native Perl (MSYS/Git-Bash
  Perl is rejected by OpenSSL's MSVC Configure) and the MSVC env (vcvars64).
- **Export of "Mainstream" (owner's rekordbox.xml): 9/9 tracks, 1 playlist, 9 ANLZ
  files, 245 MB copied, export 1.7 s, analysis 23 s total (1.4–6.8 s/track, FLAC).**
  `verify`: ok, 9 tracks / 9 entries / 9 audio / 9 analysis / 9 grids / 9 previews, no errors.
  Layout: `PIONEER/rekordbox/{export.pdb, exportExt.pdb, exportLibrary.db}`, `PIONEER/USBANLZ/…`,
  `Contents/<Artist>/…`, plus rbxport's own `PIONEER/rbxport/manifest.json` (sync state).
- rbxport's analyser BPM vs the Rekordbox XML: 8/9 within 0.01 BPM; Waka Waka 127.44 vs 126.99.
- "isr" (the playlist originally picked) could not be exported: that rekordbox.xml is partial
  (`COLLECTION Entries="2725"` but only 164 TRACK rows), and none of isr's 15 keys are in it.
  Only "Mainstream" resolves (9/20).

## Not verified
- Playback on a real CDJ/XDJ (copy the spike output folder to a FAT32 stick).
- macOS / Linux release runners (should have Perl; not built).
- Cues: the spike writes an empty cue list; the XML's POSITION_MARKs are not carried yet.

## Costs found
1. SQLCipher is unified into MTC's own `rusqlite` (every MTC sqlite DB is now SQLCipher-capable
   SQLite; plain DBs still open fine). Builds need Perl + OpenSSL from source (~1–2 min extra clean).
2. Duplicate symphonia (0.5 for rbl-audio, 0.6 for MTC) and a C LAME encoder (`mp3lame-sys`).
3. rbxport's full analysis authoring (detail/colour waveforms PWV3/PWV5/PWV4…, `grid.rs`) lives in
   its *app* (`src-tauri/`), not the crates — MTC gets PWAV + beat grid only unless that is ported.
4. Upstream is ~3.5 weeks old with no releases; expect API churn on every rev bump.
5. rbxport writes `.rbxport-write.lock` + `PIONEER/rbxport/manifest.json` on the stick.

## Next if adopted
- Command `export_usb(playlist, drive)` reusing `usb.rs`'s removable-drive re-check before writing.
- Feed cues/grids from `rekordbox_import.rs` (already parses TEMPO/POSITION_MARK) as `ExportCue`s
  instead of re-analysing tracks Rekordbox already analysed.
- CI: windows-latest has Strawberry Perl; confirm macOS/ubuntu jobs before a tag.
