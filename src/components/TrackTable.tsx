import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { onFocusPathRequest, takeFocusPath } from "../lib/focusPath";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { TrackContextMenu, trackMenuItems, useTrackContextMenu, type MenuEntry } from "./TrackContextMenu";
import {
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ExternalLink,
  Filter,
  Headphones,
  ImageOff,
  ImagePlus,
  Languages,
  Layers,
  Puzzle,
  Link2,
  Loader2,
  Mic2,
  Music,
  FolderInput,
  Pause,
  Play,
  Repeat,
  Search,
  SlidersHorizontal,
  Trash2,
  X,
  ZoomIn,
} from "lucide-react";
import type { AudioFile, CueData, KeyNotation, PendingChange, PreviewMode, RowHeight, TagData } from "../types";
import { withRekordbox, type RekordboxInfo } from "../hooks/useRekordbox";
import { formatKey } from "../lib/keys";
import { bpmCell, keyCell, ratingCell } from "../lib/rekordboxSync";
import { basename, FIELD_LABELS, formatBytes, KEPT_FIELD_KEYS } from "../types";
import type { ImageInfo as ImgInfo } from "../hooks/useImageInfo";
import type { Notify } from "../hooks/useFiles";
import { hasWeirdChars, markWeird } from "../lib/standardize";
import { internalDrag } from "../lib/internalDrag";
import { matchesTerms, parseQuery } from "../lib/trackSearch";
import { matchesShortcut, shortcutFor } from "../lib/shortcuts";
import { useVirtualRows } from "../hooks/useVirtualRows";
import { usePluginUi, pluginColumnValue } from "../plugins/pluginUi";
import type { UiColumn } from "../plugins/host";

/**
 * One collator for every table sort: `localeCompare` builds its comparison
 * state on each call, which dominated sorting a few thousand rows. `numeric`
 * also puts "Track 2" before "Track 10".
 */
const SORT_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
import { AudioPreview, formatDuration, releasePlayback, takeOverPlayback } from "./AudioPreview";
import { Waveform } from "./Waveform";
import { dominantFamily, fieldHeaderLabel, rawNameTooltip } from "../lib/rawFieldNames";
import { Combobox } from "./Combobox";
import { LANGUAGE_OPTIONS, languageFromOption, languageName } from "../lib/language";
import { Stars } from "./Stars";
import { Button, cn } from "./ui";

export interface ColumnDef {
  id: string;
  label: string;
  width: number;
  field?: keyof TagData & string;
  value: (file: AudioFile, tags?: TagData) => string;
  align?: "right" | "center";
  /** Rendered with a custom cell (not text/editable). */
  custom?: "preview" | "rating" | "imageInfo";
  /** Ad-hoc raw-tag column from the "All Tags" view — not draggable/resizable/persisted. */
  dynamic?: boolean;
  /** The raw allFields/key_name() key this dynamic column edits — unset for curated columns. */
  rawKey?: string;
}

export const ALL_COLUMNS: ColumnDef[] = [
  { id: "preview", label: "Preview", width: 150, value: () => "", custom: "preview" },
  { id: "filename", label: "File Name", width: 230, value: (f) => f.filename },
  { id: "title", label: "Title", width: 200, field: "title", value: (_f, t) => t?.title ?? "" },
  { id: "artist", label: "Artist", width: 170, field: "artist", value: (_f, t) => t?.artist ?? "" },
  { id: "album", label: "Album", width: 160, field: "album", value: (_f, t) => t?.album ?? "" },
  {
    id: "albumArtist",
    label: "Album Artist",
    width: 150,
    field: "albumArtist",
    value: (_f, t) => t?.albumArtist ?? "",
  },
  { id: "year", label: "Year", width: 66, field: "year", value: (_f, t) => t?.year ?? "" },
  { id: "genre", label: "Genre", width: 130, field: "genre", value: (_f, t) => t?.genre ?? "" },
  { id: "rating", label: "Rating", width: 100, value: () => "", custom: "rating" },
  {
    id: "trackNumber",
    label: "Track #",
    width: 80,
    field: "trackNumber",
    value: (_f, t) => t?.trackNumber ?? "",
  },
  {
    id: "trackId",
    label: "Track ID",
    width: 96,
    field: "trackId",
    value: (_f, t) => t?.trackId ?? "",
  },
  {
    id: "discNumber",
    label: "Disc #",
    width: 66,
    field: "discNumber",
    value: (_f, t) => t?.discNumber ?? "",
  },
  { id: "composer", label: "Composer", width: 170, field: "composer", value: (_f, t) => t?.composer ?? "" },
  {
    id: "originalArtist",
    label: "Original Artist",
    width: 180,
    field: "originalArtist",
    value: (_f, t) => t?.originalArtist ?? "",
  },
  { id: "comment", label: "Comment", width: 200, field: "comment", value: (_f, t) => t?.comment ?? "" },
  // BPM / Key: the file's own tag first, Rekordbox's analysis when the tag is
  // empty (marked "RB" in the cell). Editable like any other curated field.
  {
    id: "bpm",
    label: "BPM",
    width: 78,
    field: "bpm",
    value: (f, t) => bpmCell(f, t).text,
    align: "right",
  },
  { id: "key", label: "Key", width: 70, field: "key", value: (f, t) => keyCell(f, t).text },
  // Language: stored as an ISO 639-2 code, shown as its name; the editor is a type-ahead of languages.
  {
    id: "language",
    label: "Language",
    width: 110,
    field: "language",
    value: (_f, t) => (t?.language ? languageName(t.language) : ""),
  },
  { id: "format", label: "Format", width: 72, value: (f) => f.format.toUpperCase() },
  { id: "size", label: "Size", width: 84, value: (f) => formatBytes(f.size), align: "right" },
  { id: "imageInfo", label: "Artwork", width: 150, value: () => "", custom: "imageInfo" },
];

/**
 * D2: plugin columns live in the same array (ids `plugin.<plugin>.<column>`) so
 * the Columns menu, saved visibility and the `table.setColumns` action all see
 * them like any other column. Values come from the plugin's sandbox, computed
 * ahead of time by `usePlugins` and read here synchronously.
 */
export function syncPluginColumns(cols: UiColumn[]) {
  for (let k = ALL_COLUMNS.length - 1; k >= 0; k--) if (ALL_COLUMNS[k].id.startsWith("plugin.")) ALL_COLUMNS.splice(k, 1);
  for (const c of cols) {
    ALL_COLUMNS.push({ id: c.id, label: c.label, width: c.width, value: (f) => pluginColumnValue(c.id, f.path) });
  }
}

/** Small marker for a value that comes from (or disagrees with) Rekordbox. */
function RekordboxMark() {
  return (
    <span className="shrink-0 rounded bg-primary/15 px-1 text-[9px] font-semibold leading-4 text-primary">RB</span>
  );
}

export function formatImageInfo(info: { mime: string; sizeBytes: number; width: number; height: number } | null | undefined): string {
  if (info === null) return "no art";
  if (!info) return "…";
  const format = (info.mime.split("/")[1] || info.mime).toUpperCase();
  return `${info.width}×${info.height} · ${format} · ${formatBytes(info.sizeBytes)}`;
}

const HIGHLIGHT_FIELDS = new Set(["title", "artist"]);
/**
 * True when a Space press belongs to the track table rather than to whatever
 * currently has focus. Clicking a row leaves focus on `document.body` (a <td>
 * isn't focusable), so that's the usual case; a press that lands inside the
 * table's own scroller while some other non-typing element holds focus counts
 * too. Anything that wants Space for itself — a text field, a button, a link —
 * keeps it.
 */
function ownsSpace(target: HTMLElement | null, scroller: HTMLElement | null): boolean {
  if (!target) return false;
  if (target.closest("input,textarea,select,button,a,[contenteditable='true']")) return false;
  return target === document.body || !!scroller?.contains(target);
}

const MIN_WIDTH = 50;
/** How close to the table's edge a column drag has to get before the table
 * pans, and how far it pans per mousemove. */
const EDGE_PAN_ZONE = 48;
const EDGE_PAN_STEP = 18;

function stemOf(filename: string): string {
  const idx = filename.lastIndexOf(".");
  return idx > 0 ? filename.slice(0, idx) : filename;
}

/** Splits `value` into segments, wrapping every case-insensitive match of `query`. */
function highlightSearch(value: string, query: string) {
  if (!query) return value;
  const lower = value.toLowerCase();
  const q = query.toLowerCase();
  if (!lower.includes(q)) return value;
  const segs: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (true) {
    const found = lower.indexOf(q, i);
    if (found === -1) {
      segs.push(<span key={key++}>{value.slice(i)}</span>);
      break;
    }
    if (found > i) segs.push(<span key={key++}>{value.slice(i, found)}</span>);
    segs.push(
      <mark key={key++} className="rounded-sm bg-yellow-400/70 text-black">
        {value.slice(found, found + query.length)}
      </mark>,
    );
    i = found + query.length;
  }
  return segs;
}

const ROW_STYLE: Record<RowHeight, { py: string; img: string; art: number }> = {
  compact: { py: "py-0.5", img: "h-7 w-7", art: 40 },
  normal: { py: "py-1.5", img: "h-10 w-10", art: 52 },
  tall: { py: "py-2.5", img: "h-14 w-14", art: 68 },
};

const ROW_HEIGHTS: RowHeight[] = ["compact", "normal", "tall"];

interface Props {
  files: AudioFile[];
  /** Rekordbox BPM/key/rating by path, merged onto `files` for the BPM, Key and Rating columns. */
  rekordbox?: Record<string, RekordboxInfo>;
  /** How the Key column is displayed. */
  keyNotation?: KeyNotation;
  tags: Record<string, TagData>;
  covers: Record<string, string | null>;
  imageInfo: Record<string, ImgInfo | null>;
  onFetchImageInfo: (path: string) => void;
  onSetCoverArt: (file: AudioFile) => void;
  onRemoveCoverArt: (file: AudioFile) => void;
  unresolved: Set<string>;
  selected: Set<string>;
  visibleColumns: string[];
  columnWidths: Record<string, number>;
  highlightSymbols: boolean;
  /** Extra characters to flag, on top of the built-in rule. */
  flagExtraChars: string;
  fieldNaming: "friendly" | "raw" | "both";
  rowHeight: RowHeight;
  genreOptions: string[];
  onToggle: (path: string) => void;
  onSetAll: (checked: boolean) => void;
  onSetMany: (paths: string[], checked: boolean) => void;
  onVisibleColumnsChange: (columns: string[]) => void;
  onColumnWidthsChange: (widths: Record<string, number>) => void;
  onRowHeightChange: (height: RowHeight) => void;
  onEditField: (paths: string[], field: keyof TagData & string, value: string) => void;
  onEditRawField: (paths: string[], rawKey: string, value: string) => void;
  onEditRating: (paths: string[], stars: number) => void;
  onInspect: (file: AudioFile) => void;
  onAddGenre: (genre: string) => void;
  onRenameGenre: (oldName: string, newName: string) => void;
  /** Confirms with the user, then moves the file to the Recycle Bin.
   * `onConfirmed` fires after the user says yes and before the file moves —
   * Genre Mode uses it to advance playback off the track being deleted. */
  onDeleteFile: (file: AudioFile, opts?: { onConfirmed?: () => void }) => void | Promise<void>;
  onRenameFile: (path: string, newStem: string) => void;
  /** Open the Convert dialog for one right-clicked file. */
  onConvertFile?: (file: AudioFile) => void;
  onFindArtwork?: (paths: string[]) => void;
  /** B4: opens the Move-to-collection preview for these paths. */
  onMoveToCollection?: (paths: string[]) => void;
  onFetchLyrics?: (paths: string[]) => void;
  onDetectLanguage?: (paths: string[]) => void;
  /** Track ID → distinct loaded formats, for the "also loaded as" link badge. */
  trackIdFormats?: Map<string, string[]>;
  /** Column id of the field currently holding the searchable backup, if enabled. */
  backupFieldId: string | null;
  shortcuts: Record<string, string>;
  onTrack: (name: string) => void;
  /** Non-strip pending changes (AI/Standardize/Genre/Clear) shown inline as before → after diffs. */
  pending: PendingChange[] | null;
  onPendingChange: (rows: PendingChange[]) => void;
  /** Which action the current `pending` belongs to — drives the Clear Fields add-a-column boxes. */
  previewMode: PreviewMode;
  notify: Notify;
  /** D2 diagnostic switch for the horizontal-wheel bug (ROADMAP item 42) —
   * logs every wheel event's raw fields to the Logs page when on. */
  logWheelEvents: boolean;
}

/**
 * Include/exclude every proposed change in one column. Shown in the header
 * only while a preview is on screen and that column actually has suggestions.
 */
function ColumnIncludeToggle({
  state,
  label,
  onChange,
}: {
  state?: { ids: Set<string>; included: number; total: number };
  label: string;
  onChange: (include: boolean) => void;
}) {
  if (!state) return null;
  const all = state.included === state.total;
  return (
    <input
      type="checkbox"
      className="accent-[var(--primary)]"
      checked={all}
      ref={(el) => {
        // Partially included reads as a dash rather than a misleading tick.
        if (el) el.indeterminate = state.included > 0 && !all;
      }}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onChange(e.target.checked)}
      title={`${all ? "Exclude" : "Include"} all ${state.total} proposed ${label} change${
        state.total === 1 ? "" : "s"
      }`}
    />
  );
}

/**
 * Full-screen embedded-artwork viewer. Fetches the original, full-resolution
 * picture on demand (`read_cover_art` — unlike the table's `covers` map,
 * which only ever holds small re-encoded thumbnails) so the image shown here
 * is byte-for-byte what's in the file, not a downscaled JPEG copy.
 */
function ArtworkLightbox({
  file,
  info,
  onFetchInfo,
  onClose,
  onPrev,
  onNext,
}: {
  file: AudioFile;
  info: ImgInfo | null | undefined;
  onFetchInfo: (path: string) => void;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
}) {
  const [src, setSrc] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setSrc(undefined);
    onFetchInfo(file.path);
    invoke<string | null>("read_cover_art", { path: file.path })
      .then((data) => {
        if (!cancelled) setSrc(data);
      })
      .catch(() => {
        if (!cancelled) setSrc(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") onPrev();
      else if (e.key === "ArrowRight") onNext();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onPrev, onNext]);

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex flex-col items-center justify-center bg-black/85 p-6"
      onClick={onClose}
    >
      <button
        className="absolute right-4 top-4 rounded-full bg-black/40 p-2 text-white/80 hover:bg-black/60 hover:text-white"
        onClick={onClose}
        title="Close (Esc)"
      >
        <X className="h-5 w-5" />
      </button>
      <button
        className="absolute left-4 top-1/2 -translate-y-1/2 rounded-full bg-black/40 p-2 text-white/80 hover:bg-black/60 hover:text-white"
        onClick={(e) => {
          e.stopPropagation();
          onPrev();
        }}
        title="Previous (←)"
      >
        <ChevronLeft className="h-6 w-6" />
      </button>
      <button
        className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full bg-black/40 p-2 text-white/80 hover:bg-black/60 hover:text-white"
        onClick={(e) => {
          e.stopPropagation();
          onNext();
        }}
        title="Next (→)"
      >
        <ChevronRight className="h-6 w-6" />
      </button>

      <div className="flex max-h-[85vh] max-w-[85vw] items-center justify-center" onClick={(e) => e.stopPropagation()}>
        {src === undefined ? (
          <Loader2 className="h-8 w-8 animate-spin text-white/70" />
        ) : src ? (
          <img src={src} alt="" className="max-h-[85vh] max-w-[85vw] rounded object-contain shadow-2xl" />
        ) : (
          <div className="flex flex-col items-center gap-2 text-white/70">
            <ImageOff className="h-8 w-8" />
            <span className="text-sm">No embedded artwork</span>
          </div>
        )}
      </div>

      <div className="mt-4 text-center text-sm text-white/80" onClick={(e) => e.stopPropagation()}>
        <div className="font-medium">{file.filename}</div>
        {info && <div className="text-xs text-white/50">{formatImageInfo(info)}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function TrackTable({
  files: filesProp,
  rekordbox,
  keyNotation = "stored",
  tags,
  covers,
  imageInfo,
  onFetchImageInfo,
  onSetCoverArt,
  onRemoveCoverArt,
  unresolved,
  selected,
  visibleColumns,
  columnWidths,
  highlightSymbols,
  flagExtraChars,
  fieldNaming,
  rowHeight,
  genreOptions,
  onToggle,
  onSetAll,
  onSetMany,
  onVisibleColumnsChange,
  onColumnWidthsChange,
  onRowHeightChange,
  onEditField,
  onEditRawField,
  onEditRating,
  onInspect,
  onAddGenre,
  onRenameGenre,
  onDeleteFile,
  onRenameFile,
  onConvertFile,
  onFindArtwork,
  onMoveToCollection,
  onFetchLyrics,
  onDetectLanguage,
  trackIdFormats,
  backupFieldId,
  shortcuts,
  onTrack,
  pending,
  onPendingChange,
  previewMode,
  notify,
  logWheelEvents,
}: Props) {
  // Rekordbox's BPM / key / rating layered onto the loaded files.
  const files = useMemo(() => withRekordbox(filesProp, rekordbox ?? {}), [filesProp, rekordbox]);
  // Local mirror of the persisted widths so a drag can update at pointer speed
  // without a settings write per frame; re-synced when the prop changes from
  // the outside (settings import/restore, defaults reset).
  const [widths, setWidths] = useState<Record<string, number>>(columnWidths);
  const widthsRef = useRef(widths);
  widthsRef.current = widths;
  const draggingWidthRef = useRef(false);
  useEffect(() => {
    if (!draggingWidthRef.current) setWidths(columnWidths);
  }, [columnWidths]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const [onlyUnresolved, setOnlyUnresolved] = useState(false);
  /**
   * Highlight selection — the rows the user has picked out by clicking. This
   * is deliberately NOT the checkbox state (`selected`): actions run on the
   * ticked rows, while this drives bulk ticking and multi-row edits.
   */
  const [rowSel, setRowSel] = useState<Set<string>>(new Set());
  const rowSelRef = useRef(rowSel);
  rowSelRef.current = rowSel;
  /** Last row clicked — anchor for Shift ranges and target for the Space key. */
  const [anchorPath, setAnchorPath] = useState<string | null>(null);
  const anchorRef = useRef(anchorPath);
  anchorRef.current = anchorPath;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [editing, setEditing] = useState<{ path: string; field: string } | null>(null);
  const [draft, setDraft] = useState("");
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const [showAllTags, setShowAllTags] = useState(false);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // --- Genre Mode: fast keyboard-driven genre assignment --------------------
  // Up/Down move the "current" row (reusing rowSel/anchorPath as a single-row
  // highlight) without touching playback. Enter plays the current row, or —
  // if it's already playing — expands the inline genre picker. Saving from
  // the picker (see the Combobox onChange below) advances to the next row and
  // switches playback to it, resuming from wherever that row was left. Left/
  // Right seek the currently playing track; 1-9 quick-tag from the active
  // preset without opening the picker at all.
  const GM_SEEK_SECONDS = 10;
  const [genreMode, setGenreMode] = useState(false);
  const genreModeRef = useRef(genreMode);
  genreModeRef.current = genreMode;
  const gmAudioRef = useRef<HTMLAudioElement | null>(null);
  const [gmPlayingPath, setGmPlayingPath] = useState<string | null>(null);
  const gmPlayingRef = useRef<string | null>(null);
  gmPlayingRef.current = gmPlayingPath;
  // Per-track resume position, kept only for the current session.
  const gmPositions = useRef<Record<string, number>>({});
  const [gmTime, setGmTime] = useState(0);
  const [gmDuration, setGmDuration] = useState(0);
  // Rekordbox cues (see `get_cues_for_path`) for whichever track is showing
  // in the Genre Mode strip, drawn as an overlay on its Waveform. `null`
  // means "checked, none imported"; `undefined` means "not fetched yet".
  const [gmCues, setGmCues] = useState<CueData | null | undefined>(undefined);
  const gmCuesCache = useRef<Record<string, CueData | null>>({});
  // True while the Genre Mode delete confirmation is up, so holding Del (or
  // hitting it again behind the dialog) can't stack a second one.
  const gmDeletingRef = useRef(false);

  const gmSavePosition = useCallback(() => {
    const el = gmAudioRef.current;
    const p = gmPlayingRef.current;
    if (el && p && Number.isFinite(el.currentTime)) gmPositions.current[p] = el.currentTime;
  }, []);

  const gmPauseKeepPosition = useCallback(() => {
    gmSavePosition();
    gmAudioRef.current?.pause();
    setGmPlayingPath(null);
  }, [gmSavePosition]);

  const gmPlay = useCallback(
    (path: string) => {
      const el = gmAudioRef.current;
      if (!el) return;
      gmSavePosition();
      // Pre-empts a row's own prelisten button too — only one thing plays.
      takeOverPlayback(gmPauseKeepPosition);
      const url = convertFileSrc(path);
      if (el.src !== url) {
        // A different track — load it and seek to its saved resume point
        // once metadata is available.
        el.src = url;
        const resume = gmPositions.current[path] ?? 0;
        const onReady = () => {
          el.currentTime = resume;
          el.removeEventListener("loadedmetadata", onReady);
        };
        el.addEventListener("loadedmetadata", onReady);
      }
      // Same track (e.g. Space to pause then resume) — just resume in place,
      // no reload/reseek, so it's instant.
      void el
        .play()
        .then(() => setGmPlayingPath(path))
        .catch(() => setGmPlayingPath(null));
    },
    [gmSavePosition, gmPauseKeepPosition],
  );

  const gmStop = useCallback(() => {
    gmSavePosition();
    gmAudioRef.current?.pause();
    releasePlayback(gmPauseKeepPosition);
    setGmPlayingPath(null);
  }, [gmSavePosition, gmPauseKeepPosition]);

  const gmSeek = useCallback((delta: number) => {
    const el = gmAudioRef.current;
    if (!el || !gmPlayingRef.current) return;
    const max = Number.isFinite(el.duration) ? el.duration : el.currentTime + Math.abs(delta);
    el.currentTime = Math.max(0, Math.min(max, el.currentTime + delta));
  }, []);

  /**
   * Needle drop: jump `path` to `fraction` (0-1) of its length and play from
   * there. Driven by pressing/dragging on the Genre Mode waveform.
   *
   * When the track isn't the one loaded in the <audio> element yet, the
   * position goes into `gmPositions` instead — `gmPlay` seeks there itself on
   * `loadedmetadata`, once a duration actually exists to seek within.
   */
  const gmSeekTo = useCallback(
    (path: string, fraction: number) => {
      const el = gmAudioRef.current;
      if (!el) return;
      const clamped = Math.max(0, Math.min(1, fraction));
      const known = rowsRef.current.find((f) => f.path === path)?.durationSecs ?? 0;
      if (el.src === convertFileSrc(path)) {
        const dur = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : known;
        if (dur > 0) el.currentTime = dur * clamped;
        gmPositions.current[path] = el.currentTime;
        setGmTime(el.currentTime);
      } else {
        gmPositions.current[path] = known * clamped;
        setGmTime(gmPositions.current[path]);
      }
      gmPlay(path);
    },
    [gmPlay],
  );

  /** After a genre is saved, moves to the next row and starts it playing from
   * its own resume point — or stops if that was the last row. */
  const gmAdvance = useCallback(
    (fromPath: string) => {
      const list = rowsRef.current;
      const idx = list.findIndex((f) => f.path === fromPath);
      const next = idx >= 0 ? list[idx + 1] : undefined;
      if (next) {
        setAnchorPath(next.path);
        setRowSel(new Set([next.path]));
        gmPlay(next.path);
        gmActionsRef.current.virtual.scrollToIndex(idx + 1);
      } else {
        gmStop();
      }
    },
    [gmPlay, gmStop],
  );

  const toggleGenreMode = () => {
    setGenreMode((on) => {
      const next = !on;
      onTrack(next ? "genreMode:on" : "genreMode:off");
      if (next) {
        if (!anchorRef.current && rowsRef.current[0]) {
          setAnchorPath(rowsRef.current[0].path);
          setRowSel(new Set([rowsRef.current[0].path]));
        }
      } else {
        gmStop();
      }
      return next;
    });
  };

  useEffect(() => {
    // Release the shared playback slot if the table unmounts mid-playback.
    return () => {
      if (gmPlayingRef.current) releasePlayback(gmPauseKeepPosition);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!pickerOpen) return;
    const close = (e: MouseEvent) => {
      if (!pickerRef.current?.contains(e.target as Node)) setPickerOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [pickerOpen]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (matchesShortcut(e, "find", shortcuts)) {
        e.preventDefault();
        setSearchOpen(true);
        requestAnimationFrame(() => searchInputRef.current?.focus());
        return;
      }
      // Genre Mode captures its own keys while nothing else has focus — the
      // same guard the rest of this handler uses, which also means it
      // naturally steps aside while the genre picker's own input is focused
      // (that Combobox handles its own Enter/Arrows/Escape).
      if (genreModeRef.current && e.target === document.body) {
        if (e.key === "Escape") {
          e.preventDefault();
          gmStop();
          setGenreMode(false);
          gmActionsRef.current.onTrack("genreMode:off");
          return;
        }
        const currentPath = anchorRef.current ?? rowsRef.current[0]?.path ?? null;
        if (currentPath) {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const list = rowsRef.current;
            const idx = list.findIndex((f) => f.path === currentPath);
            const nextIdx =
              e.key === "ArrowDown" ? Math.min(list.length - 1, idx + 1) : Math.max(0, idx - 1);
            const nextPath = list[nextIdx]?.path;
            if (nextPath) {
              setAnchorPath(nextPath);
              setRowSel(new Set([nextPath]));
              gmActionsRef.current.virtual.scrollToIndex(nextIdx);
            }
            return;
          }
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            if (gmPlayingRef.current) {
              e.preventDefault();
              gmSeek(e.key === "ArrowRight" ? GM_SEEK_SECONDS : -GM_SEEK_SECONDS);
            }
            return;
          }
          if (e.key === " ") {
            e.preventDefault();
            if (gmPlayingRef.current === currentPath) gmPauseKeepPosition();
            else gmPlay(currentPath);
            return;
          }
          if (e.key === "Enter") {
            e.preventDefault();
            if (gmPlayingRef.current === currentPath) {
              const { tags: liveTags, beginEdit: beginEditFn } = gmActionsRef.current;
              beginEditFn(currentPath, "genre", liveTags[currentPath]?.genre ?? "");
            } else {
              gmPlay(currentPath);
            }
            return;
          }
          if (e.key === "Delete") {
            e.preventDefault();
            if (gmDeletingRef.current) return;
            const file = rowsRef.current.find((f) => f.path === currentPath);
            if (!file) return;
            gmDeletingRef.current = true;
            // `onDeleteFile` asks first and only calls back on a yes, so a
            // cancelled delete leaves this track playing where it was. On a
            // yes, playback moves off this track *before* the file goes to the
            // Recycle Bin — both because a deleted track shouldn't keep
            // playing, and because the <audio> element should let go of the
            // file first. Not `gmAdvance`: deleting the last row has to fall
            // back to the row above rather than leave the anchor on a path
            // that's about to stop existing.
            void Promise.resolve(
              gmActionsRef.current.onDeleteFile(file, {
                onConfirmed: () => {
                  const list = rowsRef.current;
                  const idx = list.findIndex((f) => f.path === currentPath);
                  const next = list[idx + 1] ?? list[idx - 1];
                  if (next) {
                    setAnchorPath(next.path);
                    setRowSel(new Set([next.path]));
                    gmPlay(next.path);
                  } else {
                    gmStop();
                    setAnchorPath(null);
                    setRowSel(new Set());
                  }
                },
              }),
            ).finally(() => {
              gmDeletingRef.current = false;
            });
            return;
          }
          if (/^[1-9]$/.test(e.key)) {
            e.preventDefault();
            const { genreOptions: liveOptions, onEditField: liveOnEditField } = gmActionsRef.current;
            const genre = liveOptions[Number(e.key) - 1];
            if (genre) {
              liveOnEditField([currentPath], "genre", genre);
              gmAdvance(currentPath);
            }
            return;
          }
        }
      }
      // Ctrl/Cmd+A highlights every visible row (it does NOT tick them) so the
      // user can then Space / click a box to tick the whole selection.
      if (matchesShortcut(e, "selectAll", shortcuts)) {
        const t = e.target as HTMLElement | null;
        if (t?.tagName === "INPUT" || t?.tagName === "TEXTAREA" || t?.isContentEditable) return;
        e.preventDefault();
        const paths = rowsRef.current.map((f) => f.path);
        setRowSel(new Set(paths));
        setAnchorPath(paths[paths.length - 1] ?? null);
        return;
      }
      // Space ticks the whole highlight selection (or just the anchor row when
      // nothing is selected). The guard keeps it away from anything that wants
      // Space for itself — a text field, a button, an open dialog — but is
      // otherwise deliberately wide, and preventDefault runs even when there's
      // nothing to tick: whenever Space belongs to the table, it must not fall
      // through to the browser, which would page the table down instead.
      if (e.key === " " && ownsSpace(e.target as HTMLElement | null, scrollRef.current)) {
        e.preventDefault();
        const sel = rowSelRef.current;
        const targets = sel.size ? [...sel] : anchorRef.current ? [anchorRef.current] : [];
        if (!targets.length) return;
        onSetMany(targets, !selectedRef.current.has(targets[0]));
      }
      // Escape clears the row highlight. Guarded to the body so it never
      // fights the inline editor or a dialog for the key.
      if (e.key === "Escape" && e.target === document.body && rowSelRef.current.size > 0) {
        setRowSel(new Set());
        setAnchorPath(null);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [shortcuts, onSetMany, gmPlay, gmPauseKeepPosition, gmSeek, gmAdvance, gmStop]);

  const rh = ROW_STYLE[rowHeight];
  // Order follows visibleColumns (drag-and-drop reorders that array), not
  // ALL_COLUMNS' fixed definition order.
  const pluginUi = usePluginUi();
  const curatedColumns = useMemo(() => {
    const byId = new Map(ALL_COLUMNS.map((c) => [c.id, c]));
    return visibleColumns.map((id) => byId.get(id)).filter((c): c is ColumnDef => !!c);
    // pluginUi.version: plugin columns come and go with their plugins.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleColumns, pluginUi.version]);

  const flagged = useMemo(() => {
    const set = new Set<string>();
    for (const f of files) {
      const t = tags[f.path];
      if (
        t &&
        (hasWeirdChars(t.title ?? "", flagExtraChars) ||
          hasWeirdChars(t.artist ?? "", flagExtraChars))
      )
        set.add(f.path);
    }
    return set;
  }, [files, tags, flagExtraChars]);

  const filteredRows = useMemo(() => {
    let out = files;
    if (onlyFlagged) out = out.filter((f) => flagged.has(f.path));
    if (onlyUnresolved) out = out.filter((f) => unresolved.has(f.path));
    return out;
  }, [files, onlyFlagged, onlyUnresolved, flagged, unresolved]);

  /**
   * Curated tag columns the user has switched off, brought back while "All
   * Tags" is on so the toggle really does show every tag in the file.
   *
   * Without this, hiding a column made its tag invisible even under All Tags:
   * the curated column was gone, and `extraColumns` skips that field's raw
   * frame as a KEPT_FIELD_KEY to avoid showing it twice — so e.g. hiding
   * "Track #" hid TrackNumber outright. Restoring the *curated* column (rather
   * than a raw `TrackNumber` one) keeps the friendly label, the right editor
   * and the numeric sort.
   *
   * Only columns some visible row actually has a value for, matching how the
   * raw columns below come and go — All Tags shouldn't add a wall of empty
   * columns. File properties (Preview, File Name, Format, Size, Artwork) are
   * not tags and are left to the Columns menu.
   */
  const restoredColumns = useMemo<ColumnDef[]>(() => {
    if (!showAllTags) return [];
    const shown = new Set(visibleColumns);
    const candidates = ALL_COLUMNS.filter(
      (c) => !shown.has(c.id) && (c.field || c.custom === "rating"),
    );
    return candidates
      .filter((c) =>
        filteredRows.some((f) => {
          const t = tags[f.path];
          if (!t) return false;
          return c.custom === "rating" ? ratingCell(f, t).stars > 0 : !!c.value(f, t);
        }),
      )
      .map((c) => ({ ...c, dynamic: true }));
  }, [showAllTags, visibleColumns, filteredRows, tags]);

  /**
   * Raw tag keys (from TagData.allFields) with no curated column of their own,
   * one dynamic column per key found on any currently visible row, auto-hidden
   * the moment no visible row has a value for that key anymore.
   *
   * Keys in KEPT_FIELD_KEYS (TrackTitle, TrackArtist, Year, …) are the raw
   * frames the curated Title/Artist/Year columns show, so they're skipped here
   * — otherwise every common field would appear twice. `restoredColumns` above
   * is what makes that safe when the curated column is currently hidden.
   */
  const extraColumns: ColumnDef[] = useMemo(() => {
    if (!showAllTags) return [];
    const keys = new Set<string>();
    for (const f of filteredRows) {
      const extra = tags[f.path]?.allFields;
      if (!extra) continue;
      for (const [k, v] of Object.entries(extra)) if (v && !KEPT_FIELD_KEYS.has(k)) keys.add(k);
    }
    return [...keys].sort().map((key) => ({
      id: `extra:${key}`,
      label: key,
      width: 140,
      dynamic: true,
      rawKey: key,
      value: (_f: AudioFile, t?: TagData) => t?.allFields?.[key] ?? "",
    }));
  }, [showAllTags, filteredRows, tags]);

  /**
   * Temporary columns for a preview (Clear Fields, AI Clean, …) that touches a
   * field with no column on screen — a hidden curated field like Comment, or a
   * raw frame like Publisher. Without this you'd get a preview with a Cancel
   * bar but nothing to see or uncheck. Gone the moment the preview closes.
   */
  const previewColumns = useMemo<ColumnDef[]>(() => {
    if (!pending) return [];
    const shown = new Set<string>();
    for (const c of [...curatedColumns, ...restoredColumns]) shown.add(c.field ?? c.id);
    for (const c of extraColumns) shown.add(c.rawKey ?? c.id);
    const byId = new Map(ALL_COLUMNS.map((c) => [c.id, c]));
    const seen = new Set<string>();
    const out: ColumnDef[] = [];
    for (const r of pending) {
      if (!r.changed || shown.has(r.field) || seen.has(r.field)) continue;
      seen.add(r.field);
      out.push(
        byId.get(r.field) ?? {
          id: r.field,
          label: FIELD_LABELS[r.field] ?? r.field,
          width: 150,
          dynamic: true,
          rawKey: r.field,
          value: (_f: AudioFile, t?: TagData) => t?.allFields?.[r.field] ?? "",
        },
      );
    }
    return out;
  }, [pending, curatedColumns, restoredColumns, extraColumns]);

  /** How many columns All Tags is adding — restored curated ones plus raw frames. */
  const addedColumnCount = restoredColumns.length + extraColumns.length;

  const columns = useMemo(
    () => [...curatedColumns, ...previewColumns, ...restoredColumns, ...extraColumns],
    [curatedColumns, previewColumns, restoredColumns, extraColumns],
  );
  const columnById = useMemo(() => new Map(columns.map((c) => [c.id, c])), [columns]);
  const widthOf = (c: ColumnDef) => widths[c.id] ?? c.width;
  const totalWidth = 36 + rh.art + 32 + columns.reduce((sum, c) => sum + widthOf(c), 0);
  // Picks one tag family's raw name per column header when fieldNaming isn't
  // "friendly" — a mixed-format collection can't show a different header per
  // row, so this uses whichever family is most common; rawNameTooltip covers
  // the rest on hover.
  const headerFamily = useMemo(() => dominantFamily(files), [files]);

  /**
   * Display order. Sorting is memoized because it is O(n log n) over the whole
   * library with a per-comparison map lookup — re-running it on every render
   * (including every keystroke in the search box) is very visible on big lists.
   */
  const rows = useMemo(() => {
    if (!sortCol) return filteredRows;
    const col = columnById.get(sortCol);
    if (!col) return filteredRows;

    /** Comparable primitive for a cell — numeric where that makes sense, else lowercased text. */
    const sortValue = (f: AudioFile): string | number => {
      const t = tags[f.path];
      if (col.id === "rating") return ratingCell(f, t).stars;
      if (col.id === "bpm") {
        const n = parseFloat(col.value(f, t));
        return Number.isNaN(n) ? -Infinity : n;
      }
      if (col.id === "size") return f.size;
      if (col.id === "preview") return f.durationSecs ?? -1;
      if (col.id === "imageInfo") return imageInfo[f.path]?.sizeBytes ?? 0;
      if (col.id === "year" || col.id === "trackNumber" || col.id === "discNumber") {
        const n = parseInt(col.value(f, t), 10);
        return Number.isNaN(n) ? -Infinity : n;
      }
      return col.value(f, t).toLowerCase();
    };

    // Decorate-sort-undecorate: sortValue re-parses tags per comparison
    // otherwise, which is the expensive part for large libraries.
    const keyed = filteredRows.map((f) => ({ f, k: sortValue(f) }));
    keyed.sort((a, b) => {
      // Numbers compare by `<`, not subtraction: two blank years are both
      // -Infinity, and -Infinity - -Infinity is NaN, which made the order of
      // every untagged row undefined.
      const cmp =
        typeof a.k === "number" && typeof b.k === "number"
          ? a.k === b.k
            ? 0
            : a.k < b.k
              ? -1
              : 1
          : SORT_COLLATOR.compare(String(a.k), String(b.k));
      return sortDir === "asc" ? cmp : -cmp;
    });
    return keyed.map((x) => x.f);
  }, [filteredRows, sortCol, sortDir, columnById, tags, imageInfo]);

  // Current display rows, for the window keydown handler (which is bound once).
  const rowsRef = useRef<AudioFile[]>(rows);
  rowsRef.current = rows;

  // Only render the rows near the viewport once the list gets long — below
  // that the spacer rows aren't worth the (tiny) layout risk.
  const virtual = useVirtualRows(scrollRef, rows.length, {
    estimateRowHeight: rh.art + 8,
    enabled: rows.length > 60,
  });
  const visibleRows = rows.slice(virtual.start, virtual.end);
  const bodyColSpan = 3 + columns.length;

  const toggleSort = (colId: string) => {
    onTrack(`sortColumn:${colId}`);
    if (sortCol === colId) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortCol(colId);
      setSortDir("asc");
    }
  };

  // Full-screen artwork viewer — index into `rows` so Left/Right can step
  // through the whole (sorted/filtered) list, not just the virtualized window.
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);

  // Right-click row menu ("Open with…", Reveal, Convert, …) — state and
  // closing behavior live in the shared hook; this table adds its own
  // extra items (Open with…, Convert, Delete) on top of the common ones.
  const { menu, openMenu, closeMenu } = useTrackContextMenu();

  const runMenuAction = (fn: () => unknown) => {
    closeMenu();
    void Promise.resolve(fn()).catch((e) => console.error("row action failed:", e));
  };

  // Guards against a single click (open the lightbox) firing on the first
  // half of a double-click (open Inspect) — see the artwork cell below.
  const artClickTimer = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (artClickTimer.current) window.clearTimeout(artClickTimer.current);
    };
  }, []);

  /** The rows between the anchor and `path`, in display order. */
  const rangeTo = (path: string): string[] => {
    const idxA = rows.findIndex((r) => r.path === anchorPath);
    const idxB = rows.findIndex((r) => r.path === path);
    if (idxA === -1 || idxB === -1) return [path];
    const [lo, hi] = idxA < idxB ? [idxA, idxB] : [idxB, idxA];
    return rows.slice(lo, hi + 1).map((r) => r.path);
  };

  /**
   * Clicking a row selects it — Shift extends a range, Ctrl adds/removes one.
   * Selecting never ticks anything: the checkbox is a separate state, so
   * editing or inspecting a field cannot change what an action will run on.
   *
   * A plain click on a row that is already part of a multi-row selection
   * keeps that selection intact (only the anchor moves), so a follow-up
   * double-click to edit a field lands on every selected row. To drop a
   * single row from the selection, Ctrl+click it.
   */
  const handleRowClick = (e: React.MouseEvent, path: string) => {
    if (e.shiftKey && anchorPath) {
      setRowSel(new Set(rangeTo(path)));
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      setRowSel((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
      setAnchorPath(path);
      return;
    }
    if (rowSel.has(path) && rowSel.size > 1) {
      setAnchorPath(path);
      return;
    }
    setRowSel(new Set([path]));
    setAnchorPath(path);
  };

  /**
   * Checkbox cell. Ticking a row that is part of the highlight selection
   * applies to the whole selection; ticking a row outside it affects only that
   * row and drops the selection, so the tick always matches what you can see.
   */
  const handleCheckClick = (path: string) => {
    const next = !selected.has(path);
    if (rowSel.has(path)) {
      onSetMany([...rowSel], next);
      return;
    }
    onToggle(path);
    setRowSel(new Set());
    setAnchorPath(path);
  };

  /**
   * Rows (in display order) that match the search query.
   *
   * This searches the **tags**, not the rendered cells. It used to scan
   * visible columns only, which meant hiding the Artist column silently
   * turned off artist search — indistinguishable, from the outside, from
   * search being broken. `searchTracks` also covers the filename and the
   * pre-clean searchable backup, and understands `artist:x`, `-exclude` and
   * "quoted phrases" (see lib/trackSearch.ts).
   */
  const searchMatches = useMemo(() => {
    const terms = parseQuery(searchQuery);
    if (!terms.length) return [] as string[];
    const out: string[] = [];
    for (const f of rows) {
      if (matchesTerms(f, tags[f.path], terms)) out.push(f.path);
    }
    return out;
  }, [rows, tags, searchQuery]);

  useEffect(() => {
    setMatchIndex(0);
  }, [searchQuery]);

  const goToMatch = (delta: number) => {
    if (!searchMatches.length) return;
    const next = (matchIndex + delta + searchMatches.length) % searchMatches.length;
    setMatchIndex(next);
    const idx = rows.findIndex((r) => r.path === searchMatches[next]);
    if (idx >= 0) virtual.scrollToIndex(idx);
  };

  // "Show in Library" from another page: highlight + scroll to the requested
  // file. Re-runs every render so a request that arrived before the table had
  // its rows is still honoured; a file hidden by the current filters isn't
  // found and the request is dropped.
  useEffect(() => {
    const apply = () => {
      const p = takeFocusPath();
      if (!p) return;
      const idx = rows.findIndex((r) => r.path === p);
      if (idx < 0) return;
      setAnchorPath(p);
      setRowSel(new Set([p]));
      virtual.scrollToIndex(idx);
    };
    apply();
    return onFocusPathRequest(apply);
  });

  /** Pending AI/Standardize/Genre/Clear changes, keyed by "path::field" for O(1) cell lookup. */
  const pendingByKey = useMemo(() => {
    const m = new Map<string, PendingChange>();
    if (pending) for (const r of pending) if (r.changed) m.set(`${r.path}::${r.field}`, r);
    return m;
  }, [pending]);

  // Horizontal panning of the table: a tilt wheel / trackpad swipe (deltaX),
  // and Shift+wheel for mice that have neither.
  //
  // Registered natively rather than as React's `onWheel`, because React
  // attaches wheel at the root as a *passive* listener, where preventDefault
  // is ignored — and without preventDefault a Shift+wheel gets applied twice,
  // once here and once by Chromium's own shift-to-horizontal mapping.
  //
  // Bound on `window` in the capture phase, not on the scroller itself, and it
  // reads `scrollRef.current` when the event fires rather than when the
  // listener was installed. Both matter: capture-on-window can't be missed
  // because something between the cursor and the scroller stopped propagation
  // or retargeted the event, and reading the ref late can't go stale if the
  // table remounts under a listener installed once at mount.
  // D2 diagnostic: logs every wheel event's raw fields plus which guard (if
  // any) made this handler give up on it, so a real repro from the owner's
  // hardware can be compared against the guesses three prior fixes made
  // blind. Throttled to ~20/s — a fast tilt-wheel burst is much faster than
  // that, and the Logs page would otherwise drown in near-duplicate entries.
  const lastWheelLogRef = useRef(0);
  const logWheel = useCallback(
    (e: WheelEvent, el: HTMLDivElement | null, guard: string, extra?: Record<string, unknown>) => {
      if (!logWheelEvents) return;
      const now = performance.now();
      if (now - lastWheelLogRef.current < 50) return;
      lastWheelLogRef.current = now;
      const target = e.target as HTMLElement | null;
      notify(`wheel: ${guard}`, "info", {
        silent: true,
        details: {
          guard,
          deltaX: e.deltaX,
          deltaY: e.deltaY,
          deltaMode: e.deltaMode,
          shiftKey: e.shiftKey,
          wheelDeltaX: (e as unknown as { wheelDeltaX?: number }).wheelDeltaX,
          targetTag: target?.tagName ?? null,
          targetClass: target?.className ?? null,
          hasFocus: document.hasFocus(),
          scrollLeftBefore: el?.scrollLeft ?? null,
          scrollWidth: el?.scrollWidth ?? null,
          clientWidth: el?.clientWidth ?? null,
          ...extra,
        },
      });
    },
    [logWheelEvents, notify],
  );

  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      const el = scrollRef.current;
      if (!el) return logWheel(e, el, "no scrollRef");
      const target = e.target;
      if (!(target instanceof Node) || !el.contains(target)) return logWheel(e, el, "target outside scroller");
      // deltaMode 1 is lines, 2 is pages; both need scaling to pixels.
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientWidth : 1;
      const raw = e.deltaX !== 0 ? e.deltaX : e.shiftKey ? e.deltaY : 0;
      if (raw === 0) return logWheel(e, el, "raw delta is 0");
      const max = el.scrollWidth - el.clientWidth;
      if (max <= 0) return logWheel(e, el, "nothing to scroll (scrollWidth <= clientWidth)");

      // Claim the gesture *before* deciding whether it actually moves
      // anything. Letting even one event of a burst fall through to the
      // browser is enough to start Chromium's own smooth-scroll animation
      // on the same element, which then fights the position set here — the
      // scroll appears to move and is immediately dragged back. That is
      // invisible with a plain tilt wheel, which sends one event at a time,
      // and very visible with anything that sends a burst: a trackpad, or a
      // mouse driver doing smooth/emulated horizontal scrolling.
      e.preventDefault();

      const next = Math.max(0, Math.min(max, el.scrollLeft + raw * unit));
      if (next === el.scrollLeft) return logWheel(e, el, "already at the edge");
      const before = el.scrollLeft;
      el.scrollLeft = next;
      logWheel(e, el, "applied", { scrollLeftAfter: el.scrollLeft, scrollLeftBefore: before });
    };
    window.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () => window.removeEventListener("wheel", onWheel, true);
  }, [logWheel]);

  // Resizing ends in a mouseup on the header, which would otherwise also fire a
  // click there and toggle sort right after — this flag suppresses that one click.
  const resizingRef = useRef(false);

  const startResize = (e: React.MouseEvent, colId: string, startWidth: number) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    draggingWidthRef.current = true;
    const onMove = (ev: MouseEvent) => {
      resizingRef.current = true;
      const next = Math.max(MIN_WIDTH, startWidth + ev.clientX - startX);
      setWidths((w) => ({ ...w, [colId]: next }));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      draggingWidthRef.current = false;
      const dragged = resizingRef.current;
      if (dragged) onColumnWidthsChange(widthsRef.current);
      // The click that follows this mouseup is swallowed by the header handler
      // to avoid sorting; clear the flag afterwards so a later plain click on
      // the same header still sorts. Without this a drag that ends off-header
      // leaves the flag set and eats the next legitimate click.
      setTimeout(() => {
        resizingRef.current = false;
      }, 0);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp, { once: true });
  };

  const toggleColumn = (id: string) => {
    const next = visibleColumns.includes(id)
      ? visibleColumns.filter((c) => c !== id)
      : [...visibleColumns, id];
    if (next.length === 0) return;
    onVisibleColumnsChange(next);
  };

  // Column reordering, on plain mouse events rather than HTML5 drag-and-drop.
  // On Windows the app needs Tauri's own OS drop target on the window (that's
  // what delivers dropped file *paths* for import), and while that is
  // installed WebView2 never delivers `drop` to the page — so a `draggable`
  // <th> could be picked up but never let go, whatever `dragstart` /
  // `dragover` replied. Mouse events don't go through the OS drag machinery
  // at all, so they work either way.
  const [dragCol, setDragCol] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ id: string; side: "left" | "right" } | null>(null);
  const headerElsRef = useRef<Record<string, HTMLTableCellElement | null>>({});
  // Set on the mouseup that ends a real drag so the click right after it
  // doesn't also sort the column — same trick as `resizingRef`.
  const columnDraggedRef = useRef(false);

  const moveColumn = (fromId: string, toId: string, side: "left" | "right") => {
    if (fromId === toId) return;
    const order = visibleColumns.slice();
    const fromIdx = order.indexOf(fromId);
    if (fromIdx === -1) return;
    order.splice(fromIdx, 1);
    let toIdx = order.indexOf(toId);
    if (toIdx === -1) return;
    if (side === "right") toIdx += 1;
    order.splice(toIdx, 0, fromId);
    onVisibleColumnsChange(order);
  };

  /** Nearest reorderable header to `clientX`, and which of its edges to drop on. */
  const dropTargetAt = (clientX: number): { id: string; side: "left" | "right" } | null => {
    let best: { id: string; side: "left" | "right"; dist: number } | null = null;
    for (const id of visibleColumns) {
      const el = headerElsRef.current[id];
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      // Distance to the header box, so a pointer dragged past the last column
      // still resolves to that column's outer edge instead of nothing.
      const dist = clientX < r.left ? r.left - clientX : clientX > r.right ? clientX - r.right : 0;
      const side: "left" | "right" = clientX < r.left + r.width / 2 ? "left" : "right";
      if (!best || dist < best.dist) best = { id, side, dist };
    }
    return best ? { id: best.id, side: best.side } : null;
  };

  const startColumnDrag = (e: React.MouseEvent, colId: string) => {
    // Left button only, and never when the press landed on one of the header's
    // own controls (the include/clear checkboxes) or the resize grip.
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("input,button")) return;
    // Stops the press selecting the header text mid-drag.
    e.preventDefault();
    const startX = e.clientX;
    let moved = false;
    let target: { id: string; side: "left" | "right" } | null = null;
    const onMove = (ev: MouseEvent) => {
      if (!moved) {
        // A few pixels of slop, so a plain click still sorts.
        if (Math.abs(ev.clientX - startX) < 4) return;
        moved = true;
        internalDrag.active = true;
        setDragCol(colId);
      }
      // Pan the table when the pointer nears an edge, so a column can be
      // dragged to a position that's currently scrolled off-screen.
      const sc = scrollRef.current;
      if (sc) {
        const r = sc.getBoundingClientRect();
        if (ev.clientX < r.left + EDGE_PAN_ZONE) sc.scrollLeft -= EDGE_PAN_STEP;
        else if (ev.clientX > r.right - EDGE_PAN_ZONE) sc.scrollLeft += EDGE_PAN_STEP;
      }
      target = dropTargetAt(ev.clientX);
      setDropAt(target);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      internalDrag.active = false;
      setDragCol(null);
      setDropAt(null);
      if (!moved) return;
      columnDraggedRef.current = true;
      // Cleared after the click this mouseup generates has been swallowed, so
      // a later plain click on the same header still sorts.
      setTimeout(() => {
        columnDraggedRef.current = false;
      }, 0);
      if (target) moveColumn(colId, target.id, target.side);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  /** Proposed changes grouped by column — drives the header include/exclude box. */
  const pendingByColumn = useMemo(() => {
    const map = new Map<string, { ids: Set<string>; included: number; total: number }>();
    for (const r of pending ?? []) {
      if (!r.changed) continue;
      const entry = map.get(r.field) ?? { ids: new Set<string>(), included: 0, total: 0 };
      entry.ids.add(r.id);
      entry.total++;
      if (r.include) entry.included++;
      map.set(r.field, entry);
    }
    return map;
  }, [pending]);

  const beginEdit = (path: string, field: string, value: string) => {
    setEditing({ path, field });
    setDraft(value);
  };

  // Mirrors the latest values/callbacks Genre Mode's keydown handler needs
  // (declared above, before these exist) into a ref, so that handler's
  // effect can stay subscribed with a stable dependency list instead of
  // re-registering the window listener on every tags/props change.
  const gmActionsRef = useRef({
    tags,
    genreOptions,
    onEditField,
    onTrack,
    beginEdit,
    virtual,
    onDeleteFile,
  });
  gmActionsRef.current = {
    tags,
    genreOptions,
    onEditField,
    onTrack,
    beginEdit,
    virtual,
    onDeleteFile,
  };

  // Fetches Rekordbox cues (see `get_cues_for_path`) for whichever track is
  // showing in the Genre Mode strip, so its Waveform can draw them.
  const gmCuesPath = genreMode ? anchorPath ?? rows[0]?.path ?? null : null;
  useEffect(() => {
    if (!gmCuesPath) {
      setGmCues(undefined);
      return;
    }
    const cached = gmCuesCache.current[gmCuesPath];
    if (cached !== undefined) {
      setGmCues(cached);
      return;
    }
    let cancelled = false;
    setGmCues(undefined);
    invoke<CueData | null>("get_cues_for_path", { path: gmCuesPath })
      .then((cues) => {
        gmCuesCache.current[gmCuesPath] = cues;
        if (!cancelled) setGmCues(cues);
      })
      .catch(() => {
        gmCuesCache.current[gmCuesPath] = null;
        if (!cancelled) setGmCues(null);
      });
    return () => {
      cancelled = true;
    };
  }, [gmCuesPath]);

  /**
   * Clear Fields preview: tick a column that isn't being cleared yet to add it,
   * building removal rows for the same files the preview already covers. Raw
   * ("All Tags") columns are pulled from `allFields`, curated ones from the
   * typed tag.
   */
  const addClearColumn = (c: ColumnDef) => {
    const key = c.field ?? c.rawKey;
    if (!key || !pending) return;
    const isRaw = !c.field && !!c.rawKey;
    const paths = [...new Set(pending.map((r) => r.path))];
    const rows: PendingChange[] = [];
    for (const path of paths) {
      const t = tags[path];
      if (!t) continue;
      const before = String(
        isRaw
          ? (t.allFields?.[key] ?? "")
          : ((t as unknown as Record<string, string | undefined>)[key] ?? ""),
      ).trim();
      rows.push({
        id: `${path}::clear::${isRaw ? "raw:" : ""}${key}`,
        path,
        filename: basename(path),
        field: key,
        before,
        after: "",
        include: before.length > 0,
        changed: before.length > 0,
        kind: "remove",
        raw: isRaw,
      });
    }
    onPendingChange([...pending, ...rows]);
  };

  /** An edit on a highlighted row applies to the whole selection, not just it. */
  const targetPaths = (path: string): string[] =>
    rowSel.has(path) && rowSel.size > 1 ? [...rowSel] : [path];

  /** Sets `include` on the given pending-change ids in one pass. */
  const setIncludeForIds = (ids: Set<string>, include: boolean) => {
    if (!pending || !ids.size) return;
    onPendingChange(pending.map((r) => (ids.has(r.id) ? { ...r, include } : r)));
  };

  /**
   * A proposed change's checkbox. With rows highlighted, it toggles that one
   * column across the whole selection — so you can knock out, say, every Year
   * suggestion for a block of tracks without touching their other fields.
   */
  const togglePendingCell = (path: string, field: string, id: string, include: boolean) => {
    const next = !include;
    if (rowSel.has(path)) {
      const ids = new Set(
        (pending ?? [])
          .filter((r) => r.changed && r.field === field && rowSel.has(r.path))
          .map((r) => r.id),
      );
      setIncludeForIds(ids, next);
      return;
    }
    setIncludeForIds(new Set([id]), next);
    setRowSel(new Set());
  };

  /** Edits the proposed "after" value of a pending change instead of writing to disk. */
  const editPendingAfter = (id: string, after: string) => {
    if (!pending) return;
    onPendingChange(
      pending.map((r) => (r.id === id ? { ...r, after, changed: after !== r.before, include: after !== r.before } : r)),
    );
  };

  const commitEdit = (override?: string, scope: "all" | "single" = "all") => {
    if (!editing) return;
    const value = override ?? draft;
    if (editing.field === "filename") {
      const file = files.find((x) => x.path === editing.path);
      const newStem = value.trim();
      if (file && newStem && newStem !== stemOf(file.filename)) {
        onRenameFile(editing.path, newStem);
      }
      setEditing(null);
      return;
    }
    const editingCol = columnById.get(editing.field);
    if (editingCol?.dynamic && editingCol.rawKey) {
      // The row can disappear mid-edit (delete, filter change, rename), so
      // bail out rather than dereferencing a missing file.
      const editingFile = files.find((x) => x.path === editing.path);
      if (!editingFile) {
        setEditing(null);
        return;
      }
      const original = editingCol.value(editingFile, tags[editing.path]);
      if (value !== original) {
        const paths = scope === "single" ? [editing.path] : targetPaths(editing.path);
        onEditRawField(paths, editingCol.rawKey, value);
      }
      setEditing(null);
      return;
    }
    const pend = pendingByKey.get(`${editing.path}::${editing.field}`);
    if (pend) {
      editPendingAfter(pend.id, value);
      setEditing(null);
      return;
    }
    const current = tags[editing.path];
    const original = current
      ? ((current as unknown as Record<string, string | undefined>)[editing.field] ?? "")
      : "";
    if (value !== original) {
      const paths = scope === "single" ? [editing.path] : targetPaths(editing.path);
      onEditField(paths, editing.field as keyof TagData & string, value);
    }
    setEditing(null);
  };

  const allChecked = files.length > 0 && files.every((f) => selected.has(f.path));
  const someChecked = files.some((f) => selected.has(f.path));

  const renderCellValue = (col: ColumnDef, value: string) => {
    if (searchQuery.trim() && value) {
      return highlightSearch(value, searchQuery.trim());
    }
    if (highlightSymbols && col.field && HIGHLIGHT_FIELDS.has(col.field) && value) {
      return markWeird(value, flagExtraChars).map((seg, i) =>
        seg.weird ? (
          // amber-300 is near-white: legible on the dark theme, invisible on
          // the light one. Each theme gets a text colour with real contrast
          // against its own background.
          <mark
            key={i}
            className="rounded-sm bg-amber-500/30 text-amber-800 dark:text-amber-300"
          >
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      );
    }
    return value;
  };

  const headerSep = "border-r border-border/70";

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border bg-card">
      <audio
        ref={gmAudioRef}
        onTimeUpdate={(e) => setGmTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setGmDuration(e.currentTarget.duration || 0)}
        onEnded={() => {
          const p = gmPlayingRef.current;
          if (p) gmPositions.current[p] = 0;
          releasePlayback(gmPauseKeepPosition);
          setGmPlayingPath(null);
        }}
        className="hidden"
      />
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-xs text-muted-foreground">
          {rows.length} track{rows.length === 1 ? "" : "s"}
          {onlyFlagged ? " flagged" : ""} ·{" "}
          {files.filter((f) => selected.has(f.path)).length} selected
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant={genreMode ? "default" : "ghost"}
            size="sm"
            onClick={toggleGenreMode}
            title="Genre Mode — keyboard-driven genre assignment: ↑↓ move, Enter play/tag, ←→ seek, 1-9 quick-tag, Esc exit"
          >
            <Headphones />
            Genre Mode
          </Button>
          <Button
            variant={searchOpen ? "secondary" : "ghost"}
            size="sm"
            onClick={() => {
              onTrack("search");
              setSearchOpen((o) => !o);
              requestAnimationFrame(() => searchInputRef.current?.focus());
            }}
            title={`Find in table (${shortcutFor("find", shortcuts)})`}
          >
            <Search />
          </Button>
          <div className="flex items-center gap-1.5 px-1.5" title={`Zoom: ${rowHeight} row height — drag to change`}>
            <ZoomIn className="h-3.5 w-3.5 text-muted-foreground" />
            <input
              type="range"
              min={0}
              max={ROW_HEIGHTS.length - 1}
              step={1}
              value={ROW_HEIGHTS.indexOf(rowHeight)}
              onChange={(e) => onRowHeightChange(ROW_HEIGHTS[Number(e.target.value)])}
              className="h-1 w-16 cursor-pointer accent-[var(--primary)]"
            />
          </div>
          {unresolved.size > 0 && (
            <Button
              variant={onlyUnresolved ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setOnlyUnresolved((v) => !v)}
              className="text-amber-500"
              title="Tracks the AI couldn't identify from tags or filename — edit them manually"
            >
              <AlertTriangle />
              Needs edit ({unresolved.size})
            </Button>
          )}
          <Button
            variant={onlyFlagged ? "default" : "ghost"}
            size="sm"
            onClick={() => setOnlyFlagged((v) => !v)}
            title="Show only tracks with unusual symbols in Title/Artist"
          >
            <Filter />
            Flagged{flagged.size > 0 ? ` (${flagged.size})` : ""}
          </Button>
          {pluginUi.buttons.map((b) => (
            <Button
              key={`${b.pluginId}:${b.id}`}
              variant="ghost"
              size="sm"
              onClick={() => pluginUi.run("button", b.pluginId, b.id, pluginUi.getSelection())}
              title={b.title ?? `${b.label} (plugin: ${b.pluginName})`}
            >
              <Puzzle />
              {b.label}
            </Button>
          ))}
          <Button
            variant={showAllTags ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setShowAllTags((v) => !v)}
            title="Show every tag field found on these tracks as extra columns, including ones hidden from the Columns menu — a column hides itself once none of the visible tracks have a value for it"
          >
            <Layers />
            All Tags{addedColumnCount > 0 ? ` (${addedColumnCount})` : ""}
          </Button>
          <div className="relative" ref={pickerRef}>
            <Button variant="ghost" size="sm" onClick={() => setPickerOpen((o) => !o)}>
              <SlidersHorizontal />
              Columns
            </Button>
            {pickerOpen && (
              <div className="absolute right-0 top-9 z-30 max-h-80 w-44 overflow-y-auto rounded-lg border bg-popover p-2 shadow-lg">
                {ALL_COLUMNS.map((c) => (
                  <label
                    key={c.id}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
                  >
                    <input
                      type="checkbox"
                      className="accent-[var(--primary)]"
                      checked={visibleColumns.includes(c.id)}
                      onChange={() => toggleColumn(c.id)}
                    />
                    {c.label}
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {searchOpen && (
        <div className="flex items-center gap-2 border-b bg-secondary/30 px-3 py-1.5">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setSearchOpen(false);
                setSearchQuery("");
              } else if (e.key === "Enter") {
                goToMatch(e.shiftKey ? -1 : 1);
              }
            }}
            placeholder="Find in table…"
            className="h-6 flex-1 max-w-xs border-none bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          />
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {searchQuery.trim()
              ? searchMatches.length
                ? `${matchIndex + 1}/${searchMatches.length}`
                : "0/0"
              : ""}
          </span>
          <button
            onClick={() => goToMatch(-1)}
            disabled={!searchMatches.length}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent disabled:opacity-30"
            title="Previous match (Shift+Enter)"
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => goToMatch(1)}
            disabled={!searchMatches.length}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent disabled:opacity-30"
            title="Next match (Enter)"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => {
              setSearchOpen(false);
              setSearchQuery("");
            }}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent"
            title="Close (Esc)"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        {rows.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 py-16 text-muted-foreground">
            <p className="text-sm">
              {files.length === 0
                ? "No tracks loaded"
                : onlyUnresolved
                  ? "No unidentified tracks"
                  : "No flagged tracks"}
            </p>
            <p className="text-xs">
              {files.length === 0
                ? "Use Select Folder, Add Files, or drag tracks in"
                : "Every loaded track looks clean"}
            </p>
          </div>
        ) : (
          <table
            className="border-collapse text-left text-xs"
            style={{ width: totalWidth, tableLayout: "fixed" }}
          >
            <colgroup>
              <col style={{ width: 36 }} />
              <col style={{ width: rh.art }} />
              <col style={{ width: 32 }} />
              {columns.map((c) => (
                <col key={c.id} style={{ width: widthOf(c) }} />
              ))}
            </colgroup>
            <thead className="sticky top-0 z-20 bg-card">
              <tr className="border-b">
                <th className={cn("sticky left-0 z-30 bg-card px-2 py-2", headerSep)}>
                  <input
                    type="checkbox"
                    className="accent-[var(--primary)]"
                    checked={allChecked}
                    ref={(el) => {
                      // Partly ticked reads as a dash, and one click there
                      // clears everything rather than ticking the rest.
                      if (el) el.indeterminate = someChecked && !allChecked;
                    }}
                    title={someChecked ? "Untick all" : "Tick all"}
                    onChange={() => onSetAll(!someChecked)}
                  />
                </th>
                <th className={cn("px-1 py-2 text-center text-[10px] font-medium text-muted-foreground", headerSep)}>
                  Art
                </th>
                <th className={cn("px-1 py-2", headerSep)} />
                {columns.map((c) => {
                  const headerLabel = c.field
                    ? fieldHeaderLabel(c.label, c.field, fieldNaming, headerFamily)
                    : c.label;
                  const headerTooltip = c.field ? rawNameTooltip(c.label, c.field) : undefined;
                  return (
                  <th
                    key={c.id}
                    ref={(el) => {
                      headerElsRef.current[c.id] = el;
                    }}
                    onMouseDown={c.dynamic ? undefined : (e) => startColumnDrag(e, c.id)}
                    onClick={() => {
                      // Swallow the synthetic click that follows a resize or a
                      // reorder drag (both flags clear on the next tick).
                      if (resizingRef.current || columnDraggedRef.current) return;
                      toggleSort(c.id);
                    }}
                    className={cn(
                      "relative cursor-pointer select-none px-3 py-2 font-medium text-muted-foreground",
                      !c.dynamic && (dragCol ? "cursor-grabbing" : "cursor-grab"),
                      headerSep,
                      c.align === "right" && "text-right",
                      c.align === "center" && "text-center",
                      dragCol === c.id && "opacity-40",
                      c.dynamic && "italic",
                    )}
                    title={
                      c.id === "preview"
                        ? "Click to sort by track length — drag to reorder"
                        : c.dynamic
                          ? `${c.label} — raw tag field, click to sort, drag edge to resize`
                          : headerTooltip
                            ? `${headerTooltip} — click to sort, drag to reorder`
                            : "Click to sort — drag to reorder"
                    }
                  >
                    <span className="flex items-center gap-1 overflow-hidden">
                      <ColumnIncludeToggle
                        state={pendingByColumn.get(c.field ?? c.rawKey ?? c.id)}
                        label={c.label}
                        onChange={(include) =>
                          setIncludeForIds(
                            pendingByColumn.get(c.field ?? c.rawKey ?? c.id)?.ids ?? new Set(),
                            include,
                          )
                        }
                      />
                      {pending &&
                        previewMode === "clear" &&
                        (c.field || c.rawKey) &&
                        !pendingByColumn.get(c.field ?? c.rawKey ?? c.id) && (
                          <input
                            type="checkbox"
                            className="shrink-0 accent-[var(--primary)] opacity-40 hover:opacity-100"
                            checked={false}
                            title={`Also clear ${c.label} on these tracks`}
                            onClick={(e) => e.stopPropagation()}
                            onChange={() => addClearColumn(c)}
                          />
                        )}
                      <span className="min-w-0 flex-1 truncate">{headerLabel}</span>
                      {c.id === backupFieldId && (
                        <span className="shrink-0 text-[9px] font-normal text-amber-500">(Backup)</span>
                      )}
                      {sortCol === c.id &&
                        (sortDir === "asc" ? (
                          <ChevronUp className="h-3 w-3 shrink-0" />
                        ) : (
                          <ChevronDown className="h-3 w-3 shrink-0" />
                        ))}
                    </span>
                    <span
                      className="group absolute -right-px top-0 z-20 flex h-full w-2 cursor-col-resize items-center justify-center"
                      onMouseDown={(e) => startResize(e, c.id, widthOf(c))}
                      title="Drag to resize"
                    >
                      <span className="h-3.5 w-px bg-border group-hover:h-full group-hover:w-0.5 group-hover:bg-primary" />
                    </span>
                    {dragCol && dropAt?.id === c.id && (
                      <span
                        className={cn(
                          "pointer-events-none absolute top-0 z-40 h-full w-0.5 bg-primary",
                          dropAt.side === "left" ? "left-0" : "right-0",
                        )}
                      />
                    )}
                  </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {virtual.padTop > 0 && (
                <tr aria-hidden>
                  <td colSpan={bodyColSpan} style={{ height: virtual.padTop, padding: 0, border: 0 }} />
                </tr>
              )}
              {visibleRows.map((f) => {
                const t = tags[f.path];
                const cover = covers[f.path];
                const isUnresolved = unresolved.has(f.path);
                // The highlight selection reads first; whether a row is ticked
                // stays legible in its checkbox rather than competing for colour.
                const shared = rowSel.has(f.path)
                  ? "bg-primary/20 hover:bg-primary/25"
                  : selected.has(f.path)
                    ? "bg-accent/60"
                    : isUnresolved
                      ? "bg-amber-500/10 hover:bg-amber-500/20"
                      : null;
                const rowBg = shared ?? "hover:bg-accent/20";
                // The sticky checkbox cell needs an always-opaque resting
                // background so columns scrolling under it don't show through.
                const stickyBg = shared ?? "bg-card hover:bg-accent/20";
                return (
                  <tr
                    key={f.path}
                    data-path={f.path}
                    className={cn("border-b border-border/50 transition-colors", rowBg)}
                    onClick={(e) => handleRowClick(e, f.path)}
                    onContextMenu={(e) =>
                      openMenu(e, rowSel.has(f.path) && rowSel.size > 1 ? [...rowSel] : [f.path])
                    }
                  >
                    <td
                      className={cn("sticky left-0 z-10 cursor-pointer px-2", rh.py, stickyBg)}
                      title={
                        rowSel.has(f.path) && rowSel.size > 1
                          ? `Tick or untick all ${rowSel.size} selected tracks`
                          : "Tick to include this track in the toolbar actions (Space toggles the selection)"
                      }
                      onClick={(e) => {
                        e.stopPropagation();
                        handleCheckClick(f.path);
                      }}
                    >
                      <input
                        type="checkbox"
                        // The cell owns the click so the hit area covers the whole
                        // cell and Shift+click ranges go through one code path.
                        className="pointer-events-none accent-[var(--primary)]"
                        checked={selected.has(f.path)}
                        readOnly
                      />
                    </td>
                    <td
                      className={cn("px-1", rh.py)}
                      onMouseEnter={() => onFetchImageInfo(f.path)}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        if (artClickTimer.current) {
                          window.clearTimeout(artClickTimer.current);
                          artClickTimer.current = null;
                        }
                        onInspect(f);
                      }}
                      title="Double-click for all tag fields"
                    >
                      <div className="group relative mx-auto w-fit">
                        <div
                          className={cn(
                            "flex cursor-pointer items-center justify-center overflow-hidden rounded bg-secondary",
                            rh.img,
                          )}
                          title={
                            cover
                              ? `${formatImageInfo(imageInfo[f.path])} — click for full screen`
                              : "No embedded artwork"
                          }
                          onClick={(e) => {
                            if (!cover) return;
                            e.stopPropagation();
                            // Wait a beat in case this is the first click of a
                            // double-click (which opens Inspect instead).
                            artClickTimer.current = window.setTimeout(() => {
                              artClickTimer.current = null;
                              const idx = rows.indexOf(f);
                              setLightboxIdx(idx >= 0 ? idx : null);
                            }, 220);
                          }}
                        >
                          {cover ? (
                            <img src={cover} alt="" className="h-full w-full object-cover" />
                          ) : (
                            <Music className="h-4 w-4 text-muted-foreground" />
                          )}
                        </div>
                        {isUnresolved && (
                          <AlertTriangle
                            className="absolute -right-1.5 -top-1.5 h-3.5 w-3.5 rounded-full bg-card text-amber-500"
                            aria-label="Couldn't identify — edit manually"
                          />
                        )}
                        <div
                          className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-0.5 bg-black/60 opacity-0 transition-opacity group-hover:opacity-100"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            onClick={() => onSetCoverArt(f)}
                            title={cover ? "Replace artwork" : "Add artwork"}
                            className="flex h-4 w-4 items-center justify-center text-white hover:text-primary"
                          >
                            <ImagePlus className="h-3 w-3" />
                          </button>
                          {cover && (
                            <button
                              onClick={() => onRemoveCoverArt(f)}
                              title="Remove artwork"
                              className="flex h-4 w-4 items-center justify-center text-white hover:text-destructive"
                            >
                              <ImageOff className="h-3 w-3" />
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="mt-0.5 text-center text-[9px] uppercase text-muted-foreground">
                        {f.format}
                      </div>
                    </td>
                    <td className={cn("px-1", rh.py)} onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => onDeleteFile(f)}
                        className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
                        title="Delete this file (moves it to the Recycle Bin)"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                    {columns.map((c) => {
                      if (c.custom === "preview") {
                        return (
                          <td key={c.id} className={cn("overflow-hidden px-2", rh.py)}>
                            <AudioPreview path={f.path} />
                          </td>
                        );
                      }
                      if (c.custom === "imageInfo") {
                        return (
                          <td
                            key={c.id}
                            className={cn("truncate px-3 text-muted-foreground", rh.py)}
                            onMouseEnter={() => onFetchImageInfo(f.path)}
                            title={formatImageInfo(imageInfo[f.path])}
                          >
                            {formatImageInfo(imageInfo[f.path])}
                          </td>
                        );
                      }
                      if (c.custom === "rating") {
                        return (
                          <td
                            key={c.id}
                            className={cn("px-3", rh.py)}
                            onClick={(e) => e.stopPropagation()}
                          >
                            {(() => {
                              const r = ratingCell(f, t);
                              return (
                                <span
                                  className="flex items-center gap-1"
                                  title={r.fromRekordbox ? "Rating from Rekordbox; click a star to write it into the file" : undefined}
                                >
                                  <Stars
                                    value={r.stars}
                                    readOnly={!t}
                                    onChange={(n) => onEditRating(targetPaths(f.path), n)}
                                  />
                                  {r.fromRekordbox && <RekordboxMark />}
                                </span>
                              );
                            })()}
                          </td>
                        );
                      }
                      const isEditing =
                        editing?.path === f.path &&
                        editing.field === c.id &&
                        (c.field || c.id === "filename" || c.dynamic);
                      const value = c.value(f, t);
                      const rbCell = c.id === "bpm" ? bpmCell(f, t) : c.id === "key" ? keyCell(f, t) : null;
                      const shown = c.id === "key" ? formatKey(value, keyNotation) : value;
                      const pendField = c.field ?? c.rawKey;
                      const pend = pendField
                        ? pendingByKey.get(`${f.path}::${pendField}`)
                        : undefined;
                      return (
                        <td
                          key={c.id}
                          className={cn(
                            "truncate px-3",
                            rh.py,
                            c.id === "filename" ? "text-foreground" : "text-muted-foreground",
                            c.align === "right" && "text-right",
                            c.align === "center" && "text-center",
                            (c.field || c.id === "filename" || c.dynamic) && "cursor-text",
                            pend && "bg-primary/5",
                          )}
                          title={
                            pend
                              ? `${pend.before || "(empty)"} → ${pend.after || "(empty)"} — click to ${pend.include ? "exclude" : "include"}, double-click to edit`
                              : c.rawKey
                                ? `${value} — double-click to edit, clear it to delete this field entirely`
                                : c.id === "filename"
                                  ? `${f.path} — double-click to rename`
                                  : rbCell?.fromRekordbox
                                    ? `${shown} — ${rbCell.note}`
                                    : shown
                          }
                          onClick={(e) => {
                            if (isEditing) e.stopPropagation();
                          }}
                          onDoubleClick={(e) => {
                            if (!c.field && c.id !== "filename" && !c.dynamic) return;
                            e.stopPropagation();
                            beginEdit(f.path, c.id, c.id === "filename" ? stemOf(f.filename) : pend ? pend.after : value);
                          }}
                        >
                          {isEditing && c.field === "language" ? (
                            <Combobox
                              value={draft}
                              options={LANGUAGE_OPTIONS}
                              allowCustom
                              autoFocus
                              placeholder="Type a language…"
                              onChange={(v) => commitEdit(languageFromOption(v))}
                              onClose={() => setEditing(null)}
                            />
                          ) : isEditing && c.field === "genre" ? (
                            <Combobox
                              value={draft}
                              options={genreOptions}
                              allowCustom
                              autoFocus
                              onChange={(v) => {
                                commitEdit(v);
                                // Genre Mode: saving here is the cue to move
                                // on — advance to the next row and switch
                                // playback to it.
                                if (genreModeRef.current) gmAdvance(f.path);
                              }}
                              onClose={() => setEditing(null)}
                              onCreate={onAddGenre}
                              onEditOption={onRenameGenre}
                            />
                          ) : isEditing ? (
                            <div className="flex items-center gap-1">
                              <input
                                autoFocus
                                value={draft}
                                onChange={(e) => setDraft(e.target.value)}
                                onBlur={() => commitEdit()}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") commitEdit(undefined, e.altKey ? "single" : "all");
                                  else if (e.key === "Escape") setEditing(null);
                                }}
                                title={
                                  editing.field !== "filename" &&
                                  rowSel.has(f.path) &&
                                  rowSel.size > 1
                                    ? `Enter applies to all ${rowSel.size} selected — Alt+Enter applies to just this row`
                                    : undefined
                                }
                                className="w-full min-w-0 flex-1 rounded border border-primary bg-background px-1 py-0.5 text-xs outline-none"
                              />
                              {editing.field !== "filename" && rowSel.has(f.path) && rowSel.size > 1 && (
                                <button
                                  onMouseDown={(e) => e.preventDefault()}
                                  onClick={() => commitEdit(undefined, "single")}
                                  title={`Apply to just this row instead of all ${rowSel.size} selected (or press Alt+Enter)`}
                                  className="shrink-0 whitespace-nowrap rounded bg-secondary px-1.5 py-0.5 text-[10px] text-secondary-foreground hover:bg-accent"
                                >
                                  just this
                                </button>
                              )}
                            </div>
                          ) : pend ? (
                            <span
                              className="flex cursor-pointer items-center gap-1"
                              onClick={(e) => {
                                e.stopPropagation();
                                togglePendingCell(f.path, c.field ?? c.rawKey ?? c.id, pend.id, pend.include);
                              }}
                            >
                              <input
                                type="checkbox"
                                // The cell owns the click so one code path covers
                                // both the single row and the whole selection.
                                className="pointer-events-none shrink-0 accent-[var(--primary)]"
                                checked={pend.include}
                                readOnly
                              />
                              <span className={cn("truncate", !pend.include && "opacity-50")}>
                                {pend.kind === "remove" ? (
                                  <span className="text-destructive line-through">{pend.before}</span>
                                ) : (
                                  <>
                                    {pend.before && (
                                      <span className="text-muted-foreground line-through">
                                        {pend.before}
                                      </span>
                                    )}
                                    <span className="mx-1 text-muted-foreground">→</span>
                                    <span className="font-medium text-primary">{pend.after}</span>
                                  </>
                                )}
                              </span>
                            </span>
                          ) : t || !c.field ? (
                            (() => {
                              const sib =
                                c.id === "trackId" && value
                                  ? (trackIdFormats?.get(value) ?? [])
                                  : [];
                              return sib.length > 1 ? (
                                <span
                                  className="flex items-center gap-1"
                                  title={`Grouped track — also loaded as ${sib
                                    .filter((fmt) => fmt !== (f.format || "?").toUpperCase())
                                    .join(", ")}`}
                                >
                                  <span className="truncate">{renderCellValue(c, value)}</span>
                                  <Link2 className="h-3 w-3 shrink-0 text-primary" />
                                </span>
                              ) : rbCell?.fromRekordbox ? (
                                <span className="inline-flex items-center gap-1">
                                  {renderCellValue(c, shown)}
                                  <RekordboxMark />
                                </span>
                              ) : (
                                renderCellValue(c, shown)
                              );
                            })()
                          ) : (
                            <span className="italic opacity-50">…</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
              {virtual.padBottom > 0 && (
                <tr aria-hidden>
                  <td
                    colSpan={bodyColSpan}
                    style={{ height: virtual.padBottom, padding: 0, border: 0 }}
                  />
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {genreMode && (
        <div className="border-t bg-secondary/40 px-3 py-2 text-xs">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Headphones className="h-3.5 w-3.5 shrink-0 text-primary" />
            {(() => {
              const currentPath = anchorPath ?? rows[0]?.path ?? null;
              const currentFile = currentPath ? rows.find((f) => f.path === currentPath) : undefined;
              if (!currentFile) return <span className="text-muted-foreground">No track selected.</span>;
              const playingHere = gmPlayingPath === currentFile.path;
              return (
                <>
                  <button
                    onClick={() => (playingHere ? gmPauseKeepPosition() : gmPlay(currentFile.path))}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"
                    title={playingHere ? "Pause (Space)" : "Play (Enter / Space)"}
                  >
                    {playingHere ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
                  </button>
                  <span className="min-w-0 max-w-[28ch] truncate font-medium" title={currentFile.filename}>
                    {currentFile.filename}
                  </span>
                  <span className="shrink-0 font-mono text-muted-foreground">
                    {formatDuration(playingHere ? gmTime : gmPositions.current[currentFile.path] ?? 0)} /{" "}
                    {formatDuration((playingHere && gmDuration) || currentFile.durationSecs || 0)}
                  </span>
                  <span className="shrink-0 text-muted-foreground">
                    Genre: <span className="font-medium text-foreground">{tags[currentFile.path]?.genre || "—"}</span>
                  </span>
                </>
              );
            })()}
            <span className="ml-auto shrink-0 text-muted-foreground">
              ↑↓ move · Enter play / tag · ←→ seek {GM_SEEK_SECONDS}s · click waveform to drop the needle · 1–9
              quick-tag · Space play/pause · Del delete · Esc exit
            </span>
            <Button variant="ghost" size="sm" onClick={toggleGenreMode}>
              Exit
            </Button>
          </div>
          {(() => {
            const currentPath = anchorPath ?? rows[0]?.path ?? null;
            if (!currentPath) return null;
            const playingHere = gmPlayingPath === currentPath;
            const currentFile = rows.find((f) => f.path === currentPath);
            // Keep the playhead drawn while paused too, so a needle drop that
            // lands on a stopped track still shows where it landed. The tag's
            // own duration stands in until the <audio> element reports one.
            const dur = (playingHere && gmDuration) || currentFile?.durationSecs || 0;
            const pos = playingHere ? gmTime : gmPositions.current[currentPath] ?? 0;
            const progress = dur > 0 ? Math.min(1, pos / dur) : undefined;
            return (
              <Waveform
                path={currentPath}
                height={28}
                progress={progress}
                className="mt-1.5"
                cues={gmCues}
                durationSecs={currentFile?.durationSecs}
                onSeek={(f) => gmSeekTo(currentPath, f)}
              />
            );
          })()}
        </div>
      )}

      {lightboxIdx !== null && rows[lightboxIdx] && (
        <ArtworkLightbox
          file={rows[lightboxIdx]}
          info={imageInfo[rows[lightboxIdx].path]}
          onFetchInfo={onFetchImageInfo}
          onClose={() => setLightboxIdx(null)}
          onPrev={() => setLightboxIdx((i) => (i === null ? i : Math.max(0, i - 1)))}
          onNext={() =>
            setLightboxIdx((i) => (i === null ? i : Math.min(rows.length - 1, i + 1)))
          }
        />
      )}

      {menu &&
        (() => {
          const byPath = new Map(files.map((f) => [f.path, f]));
          const first = byPath.get(menu.paths[0]);
          const n = menu.paths.length;
          const items: MenuEntry[] = [
            ...trackMenuItems({
              paths: menu.paths,
              onInspect: first && n === 1 ? () => onInspect(first) : undefined,
            }),
          ];
          // Single-file-only extras: a right-click inside a multi-selection
          // only offers actions every shared menu item already supports.
          if (first && n === 1) {
            items.splice(1, 0, {
              icon: ExternalLink,
              label: "Open with…",
              run: () => invoke("open_with", { path: first.path }),
            });
            if (onConvertFile) {
              items.push(null, { icon: Repeat, label: "Convert…", run: () => onConvertFile(first) });
            }
          }
          if (onFindArtwork) {
            items.push(null, {
              icon: ImagePlus,
              label: n > 1 ? `Find artwork for ${n}…` : "Find artwork…",
              run: () => onFindArtwork(menu.paths),
            });
          }
          if (onFetchLyrics || onDetectLanguage) {
            items.push(null);
            if (onFetchLyrics)
              items.push({
                icon: Mic2,
                label: n > 1 ? `Fetch lyrics for ${n}` : "Fetch lyrics",
                run: () => onFetchLyrics(menu.paths),
              });
            if (onDetectLanguage)
              items.push({
                icon: Languages,
                label: n > 1 ? `Detect language for ${n}…` : "Detect language…",
                run: () => onDetectLanguage(menu.paths),
              });
          }
          if (onMoveToCollection) {
            items.push(null, {
              icon: FolderInput,
              label: n > 1 ? `Move ${n} to collection…` : "Move to collection…",
              run: () => onMoveToCollection(menu.paths),
            });
          }
          if (pluginUi.menuItems.length) {
            items.push(null);
            for (const it of pluginUi.menuItems)
              items.push({
                icon: Puzzle,
                label: it.label,
                run: () => pluginUi.run("menu", it.pluginId, it.id, menu.paths),
              });
          }
          items.push(null, {
            icon: Trash2,
            label: n > 1 ? `Delete ${n} (Recycle Bin)` : "Delete (Recycle Bin)",
            run: () =>
              n > 1
                ? Promise.all(menu.paths.map((p) => byPath.get(p)).filter((f): f is AudioFile => !!f).map((f) => onDeleteFile(f)))
                : first && onDeleteFile(first),
            danger: true,
          });
          return <TrackContextMenu menu={menu} items={items} onRun={runMenuAction} />;
        })()}
    </div>
  );
}
