# C0 findings: reading/writing Rekordbox and Mixxx playlists

Spike, read-only. All DB experiments ran on **copies** in a scratch dir (never the live files).
Rekordbox was not running (no process) when the copy was taken. Sources: pyrekordbox 0.4.4
(MIT; `db6/database.py`, `db6/smartlist.py`, `db6/registry.py`, installed in a temp venv),
Mixxx 2.5.6 source checkout (`src/library/dao/playlistdao.h`, `trackset/crate/cratestorage.cpp`).

## Rekordbox

**1. Location / version.** `%APPDATA%\Pioneer\rekordbox\master.db` (50 MB, 4405 tracks, 252
playlist rows). Rekordbox 7.2.19 (`djmdProperty`/`agentRegistry` LangPath, `masterPlaylists6.xml`
PRODUCT). Siblings: `master.backup.YYYYMMDD.db` (Rekordbox's own daily backups, 5 present),
`masterPlaylists6.xml`, `smartlist.xml` (empty `<PLAYLISTS/>`), `share/` (analysis files).
DB is `journal_mode=wal`; no `-wal`/`-shm` existed (Rekordbox closed). pyrekordbox "tested"
list is 5.8.6/6.7.7/7.0.9, so 7.2.19 is beyond its tested range (it nonetheless read fine).

**2. SQLCipher.** Opens with the public pyrekordbox key (64 hex chars, starts `402fd`; derived by
`pyrekordbox.db6.database.deobfuscate(BLOB)`, i.e. a constant in the MIT-licensed package, the
same value every Rekordbox 6/7 install uses). Verified with Python `sqlcipher3` (SQLCipher
4.12.0 community) via `PRAGMA key='<key>'`: default SQLCipher 4 settings (page size 4096, no
custom `cipher_*` pragmas needed), 382 schema objects, all tables readable.
**NOT verified through Rust**: `rusqlite` + `bundled-sqlcipher-vendored-openssl` failed to build
on this machine (no usable Perl for OpenSSL's Configure; Git-for-Windows MSYS perl is rejected).
Plain `bundled-sqlcipher` needs OpenSSL libs (none installed). Since the file uses stock
SQLCipher 4 defaults, expect it to work with rusqlite once OpenSSL builds (GitHub Actions
Windows runners ship Strawberry Perl and OpenSSL; macOS/Linux fine). C1 must prove this in CI
first. Gotcha: enabling `bundled-sqlcipher*` swaps the app's SQLite for SQLCipher in the same
`libsqlite3-sys`; plain unencrypted DBs (Mixxx, library index) still open normally with no key.

**3. Playlist tables.**
- `djmdPlaylist`: ID (text, ~28-bit random int as string), Seq, Name, ImagePath, **Attribute**
  (0 = playlist 161 rows, 1 = folder 33, 4 = smart playlist 58), ParentID (`root` or a folder
  ID), SmartList (XML or NULL), UUID, rb_data_status, rb_local_data_status, rb_local_deleted,
  rb_local_synced, usn, rb_local_usn, created_at, updated_at.
- `djmdSongPlaylist`: ID (uuid), PlaylistID, ContentID, TrackNo (1-based), UUID, rb_* cols,
  rb_local_usn, created_at, updated_at. 3531 rows, 2228 distinct tracks. **Smart playlists have
  zero rows here** (evaluated at runtime by Rekordbox), so reading a smart list's members means
  evaluating the rule ourselves.
- Smart list XML, real rows (all from this DB):
  - genre is: `<NODE Id="1345573694" LogicalOperator="1" AutomaticUpdate="0"><CONDITION PropertyName="genre" Operator="1" ValueUnit="" ValueLeft="House Deep" ValueRight=""/></NODE>`
  - two conditions: `<NODE Id="-534637076" LogicalOperator="1" AutomaticUpdate="0"><CONDITION PropertyName="genre" Operator="8" ValueUnit="" ValueLeft="RU" ValueRight=""/><CONDITION PropertyName="genre" Operator="9" ValueUnit="" ValueLeft="Drum And Bass" ValueRight=""/></NODE>` (contains RU AND not-contains Drum And Bass; playlist "Russian")
  - myTag: `<CONDITION PropertyName="myTag" Operator="8" ValueUnit="" ValueLeft="-160068167" ValueRight=""/>` (ValueLeft = a `djmdMyTag` ID, here negative = signed int32 form)
  - `Id` attr on NODE = the playlist ID wrapped to **signed int32** (3168177216 -> -1126790080).
  - Only genre (is / contains / not contains) and myTag appear in this library. LogicalOperator
    1 = ALL, 2 = ANY. AutomaticUpdate 0/1.
  - Full vocabulary from pyrekordbox `smartlist.py` (not seen in this DB, **unverified on 7.2.19**):
    Operator 1 =, 2 !=, 3 >, 4 <, 5 in-range, 6 in-last, 7 not-in-last, 8 contains, 9 not contains,
    10 starts, 11 ends. PropertyName: artist, album, albumArtist, originalArtist, bpm, grouping,
    comments, producer, stockDate, dateCreated, counter, fileName, genre, key, label, mixName,
    myTag, rating, dateReleased, remixedBy, duration, name, year. Value encodings for bpm /
    rating / key / date (units, ValueRight for in-range) were NOT observed; to document them,
    the owner would create one of each in Rekordbox and we re-read `SmartList`. Do this before
    C1 writes numeric smart rules.

**4. `djmdContent` fields.** `ID` (text; equals XML `TrackID`), `FolderPath` (full path, forward
slashes, `C:/Users/...`, no `file://`), `FileNameL`, `Title`, `ArtistID`/`AlbumID`/`GenreID`/
`KeyID`/`OrgArtistID`/`ColorID` (FKs into `djmdArtist`/`djmdAlbum`/`djmdGenre`/`djmdKey`/...;
names via join), `BPM` **x100 as int** (12500 = 125.00; 0 for unanalysed), `Rating` **0-5 stars**
in the DB (distribution 0:4145, 1:9, 2:17, 3:63, 4:74, 5:97) whereas XML uses 0/51/102/153/204/255,
`Length` seconds, `ReleaseYear`, `Commnt`, `DJPlayCount`, `StockDate`. `djmdKey.ScaleName`
holds musical names (`Bbm`, `Am`, ...; 24 rows). `djmdGenre.Name`, `djmdAlbum.Name` plain text.
`rb_local_deleted` is 0 for all rows (soft delete flag; filter on it).

**5. Write safety.** pyrekordbox's write procedure (`create_playlist`, `add_to_playlist`,
`commit`, `registry.autoincrement_local_update_count`):
1. Refuses to commit if a Rekordbox process is found (`get_rekordbox_pid()`); only warns on open.
2. New row: random unused 28-bit ID string, `uuid4` UUID, Seq (= count in parent + 1, bumping
   later siblings if inserted mid-list), Attribute, ParentID (`root`/folder), SmartList XML
   with `Id` = signed-int32 playlist ID, created_at/updated_at = now. Song rows: uuid ID, TrackNo.
3. On commit, every added/changed row gets `rb_local_usn` = next value of the global counter
   in `agentRegistry` row `localUpdateCount` (`int_1`; currently 746653; max row usn in
   playlist 746650), incremented once per change. This is the cloud-sync change journal; if we
   skip it Rekordbox may not treat the rows as changed/synced.
4. **Also edits `masterPlaylists6.xml`** (adds `<NODE Id=... ParentId=... Attribute=... Timestamp=...>`
   per playlist and syncs timestamps with `updated_at`). Rekordbox expects both to agree.
5. `djmdProperty` is only a db-id/version row (untouched by playlist writes).
Risk: all of this is reverse engineered, only tested up to 7.0.9, and a wrong write can leave
Rekordbox warning about a corrupt library (a `Corrupt/` folder exists in the profile). No tool
here can prove Rekordbox's reaction while it is *running*: SQLite WAL + SQLCipher with an
open Rekordbox process would conflict, so **never write while it runs**.
**Verdict:** writing `master.db` is acceptable only as an **opt-in advanced mode**: Rekordbox
closed (check the process), copy `master.db` + `masterPlaylists6.xml` to a timestamped backup
first (Rekordbox keeps its own daily backups too), single transaction, follow steps 2-4, verify
by re-reading, and offer one-click restore. The safe default write path is **rekordbox.xml
import** (user imports via Rekordbox's "rekordbox xml" view). **XML cannot create smart
playlists**: the `DJ_PLAYLISTS` format has only folder (`Type="0"`) and playlist (`Type="1"`,
`KeyType`, `Entries`, `<TRACK Key=.../>`) nodes, with no rule/condition element (checked against
this machine's export and the pyrekordbox XML docs). So smart lists can only be written via
master.db. XML import also adds an "Imported Library"-style tree rather than editing in place.

**6. Does XML export include smart playlists?** **Not confirmable here.** The owner's
`rekordbox.xml` is truncated (34 `TrackID` tracks, `Entries="4405"`, one playlist node,
`ROOT Count="9"`), with no smart-list data. By format, a smart playlist can only appear as a
static `Type="1"` list of track keys, if at all; treat as unverified and have the owner
re-export fully (File > Export Collection in xml format) to check.

## Mixxx (2.5.6 x64 installed; source checkout also 2.5.6)

**7. Schema.** `%LOCALAPPDATA%\Mixxx\mixxxdb.sqlite` (plain SQLite, 4.5 MB, schema version 39).
Counts: library 5480, track_locations 5480, Playlists 16, PlaylistTracks 31, crates 0,
crate_tracks 0, cues 181.
- `track_locations(id, location, filename, directory, filesize, fs_deleted, needs_verification)`;
  `location` = full path, **forward slashes** (`C:/Users/sopas/Music/Collection/x.mp3`).
- `library(id, artist, title, album, year, genre, tracknumber, location INTEGER -> track_locations.id,
  comment, duration, bpm FLOAT (real BPM), rating INTEGER, key TEXT (e.g. `Dbm`), key_id, grouping,
  album_artist, composer, color, datetime_added, mixxx_deleted, timesplayed, ...)`.
- `Playlists(id, name, position, hidden, date_created, date_modified, locked)`.
  **`hidden`: 0 = normal playlist, 1 = Auto DJ, 2 = set log (history).** This DB has 0 normal
  playlists, 1 Auto DJ, 15 history lists, so a plain playlist is `hidden=0`.
- `PlaylistTracks(id, playlist_id, track_id -> library.id, position, pl_datetime_added)`
  (sample: `(1, 3, 1, 1, '2025-12-24 17:54:40')`; position 1-based).
- `crates(id AUTOINCREMENT, name UNIQUE, count, show, locked, autodj_source)`;
  `crate_tracks(crate_id, track_id, UNIQUE(crate_id, track_id))`. The `crates.count` column is
  legacy; `cratestorage.cpp` computes counts by join, so don't rely on maintaining it (setting
  it is harmless). Crates have no ordering and no folders; playlists are ordered, no folders.
- Note FK clauses reference a stale `"library_old"` table (migration artefact); harmless unless
  `PRAGMA foreign_keys=ON` (do not turn it on).

**8. Smart crates/playlists.** None in 2.5.6 (grep of `src/` finds "smart crate/playlist" only
in the Serato importer text and an iTunes test). Emulate: keep a rule in our own store, evaluate
it against Mixxx's `library` table (genre/bpm/rating/key all there) or our own index, and
**regenerate a static crate** (delete + reinsert `crate_tracks` rows) on each sync. Prefer
crates over playlists for emulated smart lists (unordered, cheap to rebuild, doesn't touch
history). Prefix names, e.g. `[smart] House Deep`, so we only ever rebuild our own.

**9. Writing while Mixxx is closed.** Safe in principle: stock SQLite, we only INSERT/DELETE
rows in `Playlists`/`PlaylistTracks`/`crates`/`crate_tracks`, no schema change, no
caches on disk (Mixxx reads the tables at startup; the in-memory track cache and models are
rebuilt on launch). Do not write while Mixxx is open (it holds the DB, and its in-memory
model would overwrite/ignore us). Steps: check `mixxx.exe` process, copy `mixxxdb.sqlite`
to a timestamped backup, one transaction, `date_modified` on touched playlists, verify.
I did not test a live Mixxx launch against a modified DB (read-only spike).

## Mapping

**10. Track identity.**
- Both DBs store plain paths with forward slashes and no URL encoding: Rekordbox
  `djmdContent.FolderPath`, Mixxx `track_locations.location`. Of 4405 Rekordbox tracks,
  **3562 match Mixxx byte-for-byte** (5480 Mixxx tracks), and 3562 after NFC + lowercase,
  so no extra loss from case/Unicode normalisation here (the remaining 843 are files Mixxx
  hasn't imported or renamed, e.g. `.../Sheck Wes - Mo Bamba - 002832.mp3`).
- Rekordbox XML `Location` is `file://localhost/C:/Users/.../Avicii%20-%20Levels.mp3`, so strip
  the prefix and percent-decode (existing `location_to_path` in `rekordbox_import.rs` does this).
  Normalisation function for the match key: replace `\` with `/`, strip `file://localhost/`,
  percent-decode, NFC, lower-case drive letter (compare case-insensitively on Windows/macOS).
- Rekordbox `djmdContent.ID` == XML `TrackID` (verified: 212774448 both). Our `TXXX:TRACKID` tag
  is the app's own stable key; I did not find evidence it equals Rekordbox's ID, so treat
  **normalised path as the primary join** and TRACKID as an optional tie-breaker for moved or
  renamed files (index it from the library index). Mixxx has no external ID; `library.id` is local.

## Recommendation

- **Read approach (Rekordbox):** read `master.db` copy-on-read (copy `master.db` + any `-wal`/`-shm`
  to temp, open the copy read-only with SQLCipher and the public key). Fall back to
  `rekordbox.xml` (existing parser) if the key fails or the file is missing. Playlists from
  `djmdPlaylist` + `djmdSongPlaylist` (tree by ParentID); smart lists parse `SmartList`, then
  evaluate against `djmdContent`+joins ourselves (static members are not stored).
- **Read approach (Mixxx):** open `mixxxdb.sqlite` read-only (plain rusqlite; copy first if
  Mixxx is running, since a live writer may hold locks).
- **Write, Mixxx:** direct SQLite write with Mixxx closed + backup, `hidden=0` playlists and/or
  crates; smart rules emulated as regenerated `[smart]` crates.
- **Write, Rekordbox:** default = generate `rekordbox.xml` for import (static playlists only);
  advanced opt-in = direct `master.db` write following pyrekordbox steps (USN + masterPlaylists6.xml),
  Rekordbox closed, mandatory backup, smart playlists only via this path. Ship it labelled
  experimental until the owner confirms Rekordbox 7.2.19 opens a written test playlist cleanly.
- **Risks:** (a) Rust SQLCipher unproven here, because OpenSSL/Perl build failed locally; check in CI first
  and watch the build-time and binary-size hit; (b) 7.2.19 is untested upstream; (c) numeric/key
  smart-rule value encodings unobserved; (d) Rekordbox cloud-sync fields (`usn`, `rb_data_status`)
  semantics partially unknown; (e) the XML in `~/Music` is truncated, so don't use it as ground
  truth; (f) path mismatches (843 of 4405 not in Mixxx) must surface as "not found", never be
  silently dropped.
- **Crates to add:** `rusqlite` with feature `bundled-sqlcipher-vendored-openssl` (replaces the
  `bundled` feature on `rusqlite` 0.40.2; need Perl + a C toolchain on Windows CI) or
  `bundled-sqlcipher` plus system OpenSSL; `uuid` (v4) for Rekordbox row IDs; `sysinfo`
  (process check for `rekordbox.exe`/`mixxx.exe`); `percent-encoding` (or keep the in-house
  decoder); `unicode-normalization` (NFC path key). `quick-xml` already present for
  `masterPlaylists6.xml` edits.
