import type { GenreClickChoice } from "./lib/sessionTabs";

export interface AudioFile {
  path: string;
  filename: string;
  format: string;
  size: number;
  hasBackup: boolean;
  durationSecs?: number;
  bitrateKbps?: number;
  sampleRateHz?: number;
  /** From a Rekordbox XML import (D0) — not file-tag data, so undefined
   * until that's been run, and only ever present on a Library track. */
  bpm?: number;
  key?: string;
  /** Rekordbox's star rating (0-5) for this file, same source as bpm/key. */
  rbRating?: number;
}

export interface TagData {
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  trackNumber?: string;
  discNumber?: string;
  year?: string;
  genre?: string;
  comment?: string;
  composer?: string;
  originalArtist?: string;
  /** App-assigned unique id (from "Generate IDs"), kept in a private TXXX:TRACKID frame. */
  trackId?: string;
  /** Rating in stars, 0-5. */
  rating?: number;
  /** Tempo as written in the file (TBPM / tmpo / BPM), text so "127.99" stays exact. */
  bpm?: string;
  /** Musical key as written in the file (TKEY / INITIALKEY), in the writer's notation. */
  key?: string;
  hasCoverArt: boolean;
  /** Full dump of every text field, keyed by canonical lofty key name. */
  allFields: Record<string, string>;
}

export interface TagReadResult {
  path: string;
  tags: TagData | null;
  error: string | null;
}

export interface CleanedTrack {
  index: number;
  artist?: string;
  title?: string;
  year?: string;
  genre?: string;
}

export interface OllamaStatus {
  running: boolean;
  models: string[];
  error?: string;
}

export interface OllamaInfo {
  running: boolean;
  serverVersion: string | null;
  installed: boolean;
  installPath: string | null;
}

export interface ComponentProgress {
  component: "ollama" | "model";
  phase: string;
  downloaded: number;
  total: number;
}

/** FFmpeg — an optional managed component (v0.10), used by Convert. */
export interface FfmpegInfo {
  installed: boolean;
  /** The copy found is the one downloaded into the app's data dir (vs. on PATH). */
  managed: boolean;
  ffmpegPath?: string | null;
  ffprobePath?: string | null;
  version?: string | null;
}

export interface FfmpegInstallProgress {
  phase: "downloading" | "extracting" | "done";
  downloaded: number;
  total: number;
}

/** Target formats for Convert. `value` must match `preset()` in convert.rs. */
export type ConvertPreset =
  | "mp3-320"
  | "mp3-v0"
  | "flac"
  | "alac"
  | "aac-256"
  | "wav"
  | "aiff"
  | "ogg-q8"
  | "opus-192";

export const CONVERT_PRESETS: { value: ConvertPreset; label: string; ext: string; hint: string }[] = [
  { value: "mp3-320", label: "MP3 · 320 kbps CBR", ext: "mp3", hint: "Universally compatible, DJ-safe" },
  { value: "mp3-v0", label: "MP3 · V0 VBR", ext: "mp3", hint: "Transparent, slightly smaller than 320" },
  { value: "flac", label: "FLAC · lossless", ext: "flac", hint: "Lossless, larger files" },
  { value: "alac", label: "ALAC · lossless (.m4a)", ext: "m4a", hint: "Lossless, Apple ecosystem" },
  { value: "aac-256", label: "AAC · 256 kbps (.m4a)", ext: "m4a", hint: "Efficient lossy, good for Serato/Rekordbox" },
  { value: "wav", label: "WAV · 16-bit PCM", ext: "wav", hint: "Uncompressed, no embedded art" },
  { value: "aiff", label: "AIFF · 16-bit PCM", ext: "aiff", hint: "Uncompressed, Rekordbox-friendly" },
  { value: "ogg-q8", label: "Ogg Vorbis · q8", ext: "ogg", hint: "Open lossy format" },
  { value: "opus-192", label: "Opus · 192 kbps", ext: "opus", hint: "Best-in-class lossy; limited DJ support" },
];

/** One file's result from `convert_files`. */
export interface ConvertOutcome {
  source: string;
  output?: string | null;
  ok: boolean;
  /** Error on failure, or a "converted, but …" warning when tag copy failed. */
  error?: string | null;
}

/** A cluster from `scan_duplicates` (matches the Rust `DuplicateGroup`). */
export interface DuplicateGroup {
  id: string;
  kind: "duplicate" | "alternate";
  paths: string[];
  score: number;
}

/**
 * A set of loaded files that are the same recording — grouped by a shared
 * Track ID (assigned by "Generate IDs", "Unify Track IDs", or carried over by
 * Convert). Used by the library sidebar's "Tracks" mode.
 */
export interface TrackGroup {
  /** The shared Track ID value. */
  trackId: string;
  /** "Artist — Title" from the first member, for display. */
  name: string;
  /** Distinct uppercased formats present, e.g. ["FLAC", "MP3"]. */
  formats: string[];
  paths: string[];
}

export interface CharReplacement {
  from: string;
  to: string;
  enabled: boolean;
  /** Defaults to true (preserves prior literal-match behavior) when unset. */
  caseSensitive?: boolean;
}

export type Capitalization = "asis" | "upper" | "title" | "lower" | "sentence";

export const CAP_OPTIONS: { value: Capitalization; label: string }[] = [
  { value: "asis", label: "Leave as is" },
  { value: "upper", label: "AA" },
  { value: "title", label: "Aa" },
  { value: "lower", label: "aa" },
  { value: "sentence", label: "Sentence case" },
];

export type BackupField = "Composer" | "OriginalArtist" | "Comment" | "Album" | "AlbumArtist" | "Genre";

export type DjApp =
  | "rekordbox"
  | "serato"
  | "traktor"
  | "enginedj"
  | "virtualdj"
  | "djay"
  | "mixxx"
  | "other";

export const DJ_APP_LABELS: Record<DjApp, string> = {
  rekordbox: "Rekordbox",
  serato: "Serato DJ",
  traktor: "Traktor",
  enginedj: "Engine DJ",
  virtualdj: "VirtualDJ",
  djay: "djay",
  mixxx: "Mixxx",
  other: "Other / none",
};

/** 0-5 stars everywhere except Traktor, which stores 0-255 internally. */
export const DJ_APP_RATING_SCALE: Record<DjApp, string> = {
  rekordbox: "0–5 stars",
  serato: "0–5 stars",
  traktor: "0–255 (shown as 0–5 stars here)",
  enginedj: "0–5 stars",
  virtualdj: "0–5 stars",
  djay: "0–5 stars",
  mixxx: "0–5 stars",
  other: "0–5 stars",
};

/**
 * Which field a DJ app reads for the searchable backup ("file name | |
 * artist | | title | | year"): Rekordbox reads Original Artist (TOPE);
 * Serato, Traktor and everything else here rely on Comment instead.
 */
export function recommendedBackupField(app: DjApp): BackupField {
  return app === "rekordbox" ? "OriginalArtist" : "Comment";
}

export type RowHeight = "compact" | "normal" | "tall";

/** Cumulative local Ollama usage — tracked for the usage dashboard, not billed. */
export interface UsageStats {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCalls: number;
  songsProcessed: number;
}

/**
 * Scaffolding for a possible future paid/cloud tier. Ollama itself is local
 * and free — "credits" here are a placeholder unit (1 credit ≈ 1000 tokens)
 * so the usage UI has something concrete to show, not a real balance.
 */
export interface PlanInfo {
  tier: "free" | "pro";
  creditsTotal: number;
}

/** Empty string for either field omits that CLI flag ("CLI default"). */
export interface ClaudeTaskSettings {
  model: string;
  effort: string;
}

export interface Settings {
  /**
   * "ollama" runs the local model; "claude" drives the Claude Code CLI that
   * is already installed and signed in on this machine (no API key, no
   * separate bill); "manual" hands you the prompt to paste into any AI and
   * takes its answer back by paste.
   */
  aiBackend: "ollama" | "manual" | "claude";
  /** Per-task Claude CLI model + effort. Empty model/effort omits the
   * corresponding flag, which means "whatever the CLI defaults to". */
  claudeTasks: {
    clean: ClaudeTaskSettings;
    playlist: ClaudeTaskSettings;
  };
  ollamaUrl: string;
  ollamaModel: string;
  batchSize: number;
  backupBeforeChanges: boolean;
  preserveCoverArt: boolean;
  /** Check for a new release on launch and install it without asking. The
   * check only ever installs while the library is still empty — see App's
   * startup effect — so an update can't interrupt work in progress. */
  autoUpdate: boolean;
  /** "Standardize Art" downscales the longest side of embedded cover art to this many px. */
  artworkMaxDim: number;
  /** JPEG quality (1-100) "Standardize Art" re-encodes cover art at. */
  artworkJpegQuality: number;
  recursive: boolean;
  /** When true, write "file name | | artist | | title | | year" into the backup field. */
  searchableBackup: boolean;
  /** Tag field the searchable backup is written into. */
  backupField: BackupField;
  /** DJ software used, for a recommended backup field and (future) export targets. */
  djApp: { primary: DjApp; secondary: DjApp };
  lastFolder: string;
  /**
   * The one permanent Library folder — the finished collection, indexed and
   * remembered across launches. Distinct from `lastFolder` (the batch you
   * last opened to work on), which may or may not be inside it.
   */
  libraryFolder: string;
  /** B4: destination folder for "Move to collection" (empty = feature unconfigured). */
  collectionRoot: string;
  /** B4: tokens {genre} {album} {albumartist} {artist} {title} {year} {bpm} {key} {trackid} {ext}. */
  organizePattern: string;
  /** B4: after a tag write, move saved files that sit outside collectionRoot into it. */
  autoMoveOnSave: boolean;
  /** B4: folder for library snapshots (sqlite + library.json). The live db path lives in the backend. */
  snapshotFolder: string;
  snapshotOnExit: boolean;
  /** B4: how many library-*.sqlite snapshots to keep in snapshotFolder. */
  snapshotKeep: number;
  /** Path to a `rekordbox.xml` collection export, read for BPM/key (D0). */
  rekordboxXmlPath: string;
  /** The XML file's mtime (Unix seconds) as of the last successful import,
   * so launch can re-import only when the export actually changed. */
  rekordboxXmlMtime: number;
  /** How the Key column is shown: as stored in the file/Rekordbox, Camelot (8A) or Open Key (3m). */
  keyNotation: KeyNotation;
  /** Re-run the incremental library scan whenever the window regains focus (at most once a minute). Off by default. */
  libraryAutoRefresh: boolean;
  /**
   * "system" follows the OS light/dark setting and is the default —
   * there is no in-app theme switcher any more. The explicit values are
   * kept so a pinned choice can still be honoured if one was saved.
   */
  theme: "dark" | "light" | "system";
  visibleColumns: string[];
  columnWidths: Record<string, number>;
  rowHeight: RowHeight;
  /** Library browser sidebar (Folders/Genres/Artists) width and collapsed state. */
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  /** Character replacement rules for the Standardize action. */
  replacements: CharReplacement[];
  capitalization: Capitalization;
  /** Tokens ("AC/DC", "feat.", "McFly", …) that Capitalize/Title Case always
   * renders exactly as stored here, overriding its default recasing. */
  casingExceptions: string[];
  /** Highlight non-standard symbols in Title/Artist cells in the table. */
  highlightSymbols: boolean;
  /** Characters always flagged in Title/Artist, on top of the built-in rule. */
  flagExtraChars: string;
  /** How curated field names are labeled: the friendly name, the raw tag frame name, or both. */
  fieldNaming: "friendly" | "raw" | "both";
  /** Characters removed by the "Remove characters" action. */
  removeChars: string;
  /** Next sequential track ID to assign (zero-padded to trackIdDigits). */
  nextTrackId: number;
  /** Digit count for generated track IDs (also the required length to count as a UID). */
  trackIdDigits: number;
  /** Rename to Standard uses only a-z, 0-9 and "-" in the file stem when true. */
  strictFilenames: boolean;
  /** Fields the "Clear Fields" action empties. */
  clearFields: string[];
  /**
   * Non-Latin scripts (from TRANSLITERATE_SCRIPTS) that AI Clean should
   * romanize to Latin letters instead of preserving as-is.
   */
  transliterateScripts: string[];
  /** Bumped when defaults change so saved settings can be migrated. */
  settingsVersion: number;
  /** Custom key-combo overrides, keyed by shortcut action id (see lib/shortcuts.ts). */
  shortcuts: Record<string, string>;
  usage: UsageStats;
  plan: PlanInfo;
  /** Tag fields the Standardize/Remove-Chars actions touch. */
  standardizeFields: string[];
  /** When true, Standardize also renames the file using the same rules. */
  standardizeFilename: boolean;
  /** Tracks per copy/paste batch in manual AI mode. */
  manualChunkSize: number;
  /** Default target format/quality for Convert. */
  convertPreset: ConvertPreset;
  /** Where Convert writes output: next to each source, or a `converted/` subfolder. */
  convertOutput: "alongside" | "subfolder";
  /** Last-used Demucs settings, so a repeat run needs no re-picking. */
  stemOptions: StemOptions;
  /**
   * What clicking a library genre does when the batch was built by hand:
   * "ask" shows the session dialog; the others are its remembered answers.
   */
  genreClickInManualSession: GenreClickChoice;
}

/** Non-Latin scripts AI Clean can optionally transliterate — must match SCRIPTS in ai.rs. */
export const TRANSLITERATE_SCRIPTS = [
  { id: "Cyrillic", label: "Cyrillic", hint: "Russian, Ukrainian, Bulgarian, Serbian…" },
  { id: "Hebrew", label: "Hebrew", hint: "" },
  { id: "Arabic", label: "Arabic", hint: "" },
  { id: "Greek", label: "Greek", hint: "" },
  { id: "Chinese/Japanese/Korean", label: "Chinese / Japanese / Korean", hint: "" },
] as const;

export type PreviewMode =
  | "ai"
  | "standardize"
  | "clear"
  | "history"
  | "trackIdMigration"
  | "rekordboxSync";

export type KeyNotation = "stored" | "camelot" | "openkey";

/** Fields the Clear Fields action can target. */
export const CLEARABLE_FIELDS = [
  "album",
  "albumArtist",
  "comment",
  "genre",
  "year",
  "discNumber",
  "trackNumber",
  "trackId",
  "composer",
  "originalArtist",
] as const;

export interface PendingChange {
  id: string;
  path: string;
  filename: string;
  /** A TagData field name for updates, or a canonical tag key for removals. */
  field: string;
  before: string;
  after: string;
  include: boolean;
  changed: boolean;
  kind: "update" | "remove";
  /**
   * When true, `field` is a raw tag-frame key (see `TagData.allFields`), not a
   * `TagData` field — the write path clears it by dropping the frame rather
   * than by setting a value.
   */
  raw?: boolean;
}

/** Mirrors `AUDIO_EXTENSIONS` in `src-tauri/src/commands/files.rs`. */
export const AUDIO_EXTENSIONS = ["mp3", "flac", "ogg", "opus", "aac", "m4a", "wav", "aiff", "aif"];

/** Canonical lofty key names that survive a strip (must match key_name() in Rust). */
export const KEPT_FIELD_KEYS = new Set([
  "TrackTitle",
  "TrackArtist",
  "AlbumTitle",
  "AlbumArtist",
  "TrackNumber",
  "TrackTotal",
  "DiscNumber",
  "DiscTotal",
  "Year",
  "RecordingDate",
  "Genre",
  "Comment",
  // Backup slots / extra editable fields that must survive a strip.
  "OriginalArtist",
  "Composer",
  "Popularimeter",
  // Private app-assigned track id — surfaced as its own "Track ID" column,
  // so it must not also appear as a raw "All Tags" column or a strip removal.
  "Unknown(TRACKID)",
  // BPM / Key have their own curated columns (and survive a strip).
  "Bpm",
  "IntegerBpm",
  "InitialKey",
  // Format-specific spellings of Track ID / Original Artist (see KEPT_FIELD_KEYS in library_index.rs).
  "Unknown(ORIGINALARTIST)",
  "Unknown(----:com.apple.iTunes:TRACKID)",
  "Unknown(----:com.apple.iTunes:ORIGINALARTIST)",
]);

export const FIELD_LABELS: Record<string, string> = {
  title: "Title",
  artist: "Artist",
  album: "Album",
  albumArtist: "Album Artist",
  trackNumber: "Track #",
  trackId: "Track ID",
  discNumber: "Disc #",
  year: "Year",
  genre: "Genre",
  comment: "Comment",
  composer: "Composer",
  originalArtist: "Original Artist",
  rating: "Rating",
  bpm: "BPM",
  key: "Key",
};

// v0.9 F5 — Rekordbox cue import. Field names are camelCase to match the
// `#[serde(rename_all = "camelCase")]` structs in
// `src-tauri/src/commands/rekordbox_import.rs`.
export interface TempoPoint {
  positionSecs: number;
  bpm: number;
  meter: string;
}

export interface CuePoint {
  positionSecs: number;
  /** `undefined`/`null` for a memory cue; 0-7 for a hot cue pad. */
  pad?: number | null;
  name: string;
  color?: [number, number, number] | null;
}

export interface LoopPoint {
  startSecs: number;
  endSecs: number;
  pad?: number | null;
  name: string;
  color?: [number, number, number] | null;
}

export interface CueData {
  averageBpm?: number | null;
  tempo: TempoPoint[];
  memoryCues: CuePoint[];
  hotCues: CuePoint[];
  loops: LoopPoint[];
}

export interface ImportResult {
  totalEntries: number;
  matched: number;
  notFoundOnDisk: number;
  errors: string[];
}

// v0.14 — Rekordbox playlists -> Mixxx .m3u8 export.
export interface PlaylistNode {
  id: string;
  name: string;
  isFolder: boolean;
  trackCount: number;
  children: PlaylistNode[];
}

export interface PlaylistExportEntry {
  playlistId: string;
  playlistName: string;
  filePath: string;
  trackCount: number;
  matched: number;
}

export interface PlaylistExportResult {
  exported: PlaylistExportEntry[];
}

// v0.9 F4 — YouTube Music playlist import. Matches the camelCase structs in
// `src-tauri/src/commands/ytmusic.rs`.
export interface YtDlpInfo {
  installed: boolean;
  path?: string | null;
  version?: string | null;
  /** True when `version` is a `YYYY.MM.DD` release more than ~6 months old. */
  stale?: boolean;
}

export interface PlaylistEntry {
  index: number;
  videoId: string;
  url: string;
  title: string;
  durationSecs?: number | null;
  /** The uploading channel — display-only context, never used as the
   * artist. See `artists`/`EntryMeta` for the real per-track metadata. */
  uploader?: string | null;
  /** Structured artist metadata, when yt-dlp's flat-playlist extractor
   * includes it for this entry (rare — usually filled in by `EntryMeta`). */
  artist?: string | null;
  /** Real per-video metadata (artists/album/year), filled in by
   * `enrich_ytmusic_entries` / `cached_ytmusic_meta`. Only source of truth
   * for the displayed artist — never guessed from the title or channel. */
  artists?: string[];
  album?: string | null;
  year?: number | null;
  metaStatus?: "pending" | "done" | "failed";
  /** How this entry entered the list — a fetched YouTube link/playlist, or a
   * typed song name with no link yet. */
  source?: "youtube" | "text";
}

/** Mirrors the Rust `EntryMeta` struct (camelCase). One video's real
 * YouTube Music metadata, from a full (non-flat) per-video extraction. */
export interface EntryMeta {
  videoId: string;
  title?: string | null;
  artists: string[];
  album?: string | null;
  year?: number | null;
  channel?: string | null;
  durationSecs?: number | null;
  error?: string | null;
}

export interface PlaylistFetchResult {
  title: string;
  entries: PlaylistEntry[];
}

// v0.13 — whole-library index. Matches the camelCase structs in
// `src-tauri/src/commands/library_index.rs`.

/** One track as the persistent index has it (one database row, flattened). */
export interface IndexedTrack {
  path: string;
  filename: string;
  format: string;
  size: number;
  durationSecs?: number | null;
  hasBackup: boolean;
  hasCoverArt: boolean;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  albumArtist?: string | null;
  genre?: string | null;
  year?: string | null;
  comment?: string | null;
  composer?: string | null;
  originalArtist?: string | null;
  trackId?: string | null;
  rating?: number | null;
  /** The file's own BPM / key tags (index v4). `bpm`/`key` below are Rekordbox's. */
  tagBpm?: string | null;
  tagKey?: string | null;
  bpm?: number | null;
  key?: string | null;
}

export interface IndexSummary {
  scanned: number;
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  errors: string[];
}

export interface LibraryStats {
  trackCount: number;
  roots: string[];
  lastIndexedAt?: number | null;
  genreCount: number;
  artistCount: number;
  /** Library tracks with a matching Rekordbox BPM/key row (D0). */
  rekordboxMatched: number;
}

/** From `import_rekordbox_library_tags` (D0). */
export interface RekordboxTagSummary {
  matched: number;
  libraryTrackCount: number;
  xmlEntries: number;
}

export interface GenreCount {
  name: string;
  count: number;
}

export interface IndexProgress {
  phase: "walking" | "reading" | "retagging" | "done";
  done: number;
  total: number;
  current: string;
}

/** One Library track as the AI playlist prompt sees it (D5). `id` is a
 * pool-local, 1-based position — not a database id. */
export interface PlaylistTrackInput {
  id: number;
  artist: string;
  title: string;
  genre: string;
  year: string;
  bpm: string;
}

/** One requested set (D4). `targetCount` of `undefined` lets the AI decide. */
export interface PlaylistSetSpec {
  name: string;
  targetCount?: number;
}

export interface PlaylistSet {
  name: string;
  trackIds: number[];
}

export interface PlaylistAiResult {
  sets: PlaylistSet[];
  suggestions: string[];
}

/** A saved YouTube-import session (see `ImportSession` in ytmusic.rs). */
export interface ImportSession {
  key: string;
  title: string;
  url: string;
  savedAt: number;
  /** JSON owned by the import page — see `SessionPayload` there. */
  payload: string;
}

export interface ImportSessionSummary {
  key: string;
  title: string;
  url: string;
  savedAt: number;
}

/** Splits an indexed row back into the `AudioFile` + `TagData` pair the rest
 * of the app works with, so matching and search take one shape of input
 * whether a track is loaded in the session or only indexed. `allFields` is
 * empty: the index stores the curated fields only, which is everything those
 * two consumers read. */
export function indexedToFile(t: IndexedTrack): AudioFile {
  return {
    path: t.path,
    filename: t.filename,
    format: t.format,
    size: t.size,
    hasBackup: t.hasBackup,
    durationSecs: t.durationSecs ?? undefined,
    bpm: t.bpm ?? undefined,
    key: t.key ?? undefined,
  };
}

export function indexedToTags(t: IndexedTrack): TagData {
  return {
    title: t.title ?? undefined,
    artist: t.artist ?? undefined,
    album: t.album ?? undefined,
    albumArtist: t.albumArtist ?? undefined,
    genre: t.genre ?? undefined,
    year: t.year ?? undefined,
    comment: t.comment ?? undefined,
    composer: t.composer ?? undefined,
    originalArtist: t.originalArtist ?? undefined,
    trackId: t.trackId ?? undefined,
    rating: t.rating ?? undefined,
    bpm: t.tagBpm ?? undefined,
    key: t.tagKey ?? undefined,
    hasCoverArt: t.hasCoverArt,
    allFields: {},
  };
}

// v0.13 — Demucs stem separation. Matches `src-tauri/src/commands/demucs.rs`.

export interface DemucsInfo {
  pythonFound: boolean;
  pythonPath?: string | null;
  pythonVersion?: string | null;
  installed: boolean;
  demucsVersion?: string | null;
  torchVersion?: string | null;
  /** "cuda" when torch reports a working GPU, else "cpu". */
  device?: string | null;
  gpuName?: string | null;
}

/** Pretrained models worth offering. Verified against `demucs --list-models`. */
export const DEMUCS_MODELS: { value: string; label: string; hint: string }[] = [
  { value: "htdemucs", label: "htdemucs", hint: "Default — best all-round quality/speed" },
  { value: "htdemucs_ft", label: "htdemucs_ft", hint: "Fine-tuned: better, ~4x slower" },
  { value: "htdemucs_6s", label: "htdemucs_6s", hint: "6 stems — adds piano and guitar" },
  { value: "hdemucs_mmi", label: "hdemucs_mmi", hint: "Hybrid v3, trained on more data" },
  { value: "mdx_extra", label: "mdx_extra", hint: "MDX challenge winner; strong on vocals" },
  { value: "mdx_extra_q", label: "mdx_extra_q", hint: "Quantized mdx_extra — smaller, slightly worse" },
];

/** Two-stem targets. Empty string means "all stems". */
export const DEMUCS_TWO_STEMS: { value: string; label: string }[] = [
  { value: "", label: "All stems (drums / bass / vocals / other)" },
  { value: "vocals", label: "Acapella + instrumental (vocals / no vocals)" },
  { value: "drums", label: "Drums / no drums" },
  { value: "bass", label: "Bass / no bass" },
  { value: "other", label: "Other / no other" },
];

export interface StemOptions {
  model: string;
  /** null or "" for all stems. */
  twoStems: string | null;
  format: "wav" | "mp3" | "flac";
  mp3Bitrate: number;
  shifts: number;
  overlap: number;
  device: string;
  jobs: number;
  /** Empty means a `stems` folder beside each source file. */
  outputDir: string;
}

export interface StemOutcome {
  source: string;
  ok: boolean;
  outputDir?: string | null;
  error?: string | null;
}

export interface StemProgress {
  done: number;
  total: number;
  file?: string | null;
  phase: "separating" | "done";
  /** A line of demucs/pip output, when the event carries one. */
  line?: string;
}

export const DEFAULT_STEM_OPTIONS: StemOptions = {
  model: "htdemucs",
  twoStems: "",
  format: "wav",
  mp3Bitrate: 320,
  shifts: 0,
  overlap: 0.25,
  device: "cpu",
  jobs: 1,
  outputDir: "",
};

// v0.13 — the Claude Code CLI as an AI backend.
// Matches `ClaudeCliInfo` in `src-tauri/src/commands/claude_cli.rs`.
export interface ClaudeCliInfo {
  found: boolean;
  path?: string | null;
  version?: string | null;
  /** Answered a real prompt. `found && !loggedIn` means it needs `/login`. */
  loggedIn: boolean;
  error?: string | null;
  /** Why `error` happened, so "offline" isn't reported as "not signed in". */
  errorKind?: "offline" | "timeout" | "not_logged_in" | "other" | null;
}

export function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}
