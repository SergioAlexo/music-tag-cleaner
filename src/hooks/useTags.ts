import { useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  basename,
  KEPT_FIELD_KEYS,
  type AudioFile,
  type PendingChange,
  type Settings,
  type TagData,
  type TagReadResult,
} from "../types";
import { buildRenameStem, formatTrackId, isUid } from "../lib/standardize";

/** Backup-field argument for write_tags (null disables the searchable backup). */
function backupArg(s: Settings): string | null {
  return s.searchableBackup ? s.backupField : null;
}

/** One file's worth of work for `write_tags_batch`. */
export interface WriteItem {
  path: string;
  tags: TagData;
  keepExtra: string[];
}

/** Per-file outcome of a batch write; `error` is null on success. */
interface WriteResult {
  path: string;
  error: string | null;
}

/**
 * Writes every item in one `write_tags_batch` call.
 *
 * Doing this file-by-file from here meant an IPC round trip *and* a React
 * re-render per file, which on a big selection cost far more than the writes
 * themselves — applying a preview to ~850 tracks took over ten minutes, of
 * which only about a minute was actual disk work. One call, parallelised on
 * the Rust side, with progress arriving as throttled events instead.
 *
 * Callers must pass at most one item per path: two writes to the same file
 * would run on different threads and one would overwrite the other.
 *
 * The keys below must match `write_tags_batch`'s Rust parameter names exactly:
 * a mismatched optional key (e.g. `backupField`) deserializes to None rather
 * than erroring, which would silently disable the searchable backup.
 */
async function writeBatch(items: WriteItem[], settings: Settings): Promise<ApplyResult> {
  if (!items.length) return { written: 0, errors: [], failedPaths: [] };
  const results = await invoke<WriteResult[]>("write_tags_batch", {
    items,
    backup: settings.backupBeforeChanges,
    preserveArt: settings.preserveCoverArt,
    backupField: backupArg(settings),
  });
  const failed = results.filter((r) => r.error);
  return {
    written: results.length - failed.length,
    errors: failed.map((r) => `${basename(r.path)}: ${r.error}`),
    failedPaths: failed.map((r) => r.path),
  };
}

/** Subscribes to the batch writers' progress events for the duration of `run`. */
async function withWriteProgress<T>(
  onProgress: Progress | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (!onProgress) return run();
  const unlisten = await listen<{ done: number; total: number }>("write-progress", (e) =>
    onProgress(e.payload.done, e.payload.total),
  );
  try {
    return await run();
  } finally {
    unlisten();
  }
}

export interface ApplyResult {
  written: number;
  errors: string[];
  /** Paths whose write failed — so history can leave out changes that never happened. */
  failedPaths?: string[];
  /** True if a backup/restore run was stopped early by the user. */
  stopped?: boolean;
}

export type Progress = (done: number, total: number) => void;

/**
 * The entries of `attempted` whose file `result` actually wrote — what the
 * table and the undo history may record. A failed write (a file locked by a
 * DJ app, read-only) changed nothing on disk.
 */
export function writtenOnly<T extends { path: string }>(attempted: T[], result: ApplyResult): T[] {
  const failed = new Set(result.failedPaths ?? []);
  return failed.size ? attempted.filter((c) => !failed.has(c.path)) : attempted;
}

/**
 * Files per chunk for the stoppable batch writers (Backup / Restore). Small
 * enough that Stop feels immediate and the progress bar keeps moving, large
 * enough that the per-call overhead disappears.
 */
const WRITE_CHUNK = 32;

/** Fields the Standardize action transforms. */
export const STANDARDIZE_FIELDS = ["title", "artist", "album", "albumArtist"] as const;

function groupByPath(rows: PendingChange[]): Map<string, PendingChange[]> {
  const map = new Map<string, PendingChange[]>();
  for (const row of rows) {
    const list = map.get(row.path);
    if (list) list.push(row);
    else map.set(row.path, [row]);
  }
  return map;
}

/** keepExtra for a merge write: preserve every non-common field untouched. */
function preserveExtras(tags: TagData): string[] {
  return Object.keys(tags.allFields).filter((k) => !KEPT_FIELD_KEYS.has(k));
}

/** One field edit of one file, as the bulk edit paths produce them. */
export interface FieldEdit {
  path: string;
  current: TagData;
  field: keyof TagData & string;
  value: string | number;
}

/**
 * One write per file for a list of field edits. Several edits of one file
 * become a single item carrying all of them: sent as separate items, each
 * would carry the others' fields at their *old* values, so whichever was
 * written last undid the rest.
 */
export function foldEditsByPath(edits: FieldEdit[]): WriteItem[] {
  const byPath = new Map<string, WriteItem>();
  for (const { path, current, field, value } of edits) {
    const item = byPath.get(path);
    if (item) (item.tags as unknown as Record<string, string | number>)[field] = value;
    else
      byPath.set(path, {
        path,
        tags: { ...current, [field]: value } as TagData,
        keepExtra: preserveExtras(current),
      });
  }
  return [...byPath.values()];
}

export function useTags() {
  const stopRef = useRef(false);

  /**
   * Runs `write` over `paths` a chunk at a time. Each chunk is written in
   * parallel on the Rust side; the chunking exists so the Stop button stays
   * responsive (checked between chunks) and so progress still moves — a
   * single call over the whole selection would do neither.
   */
  const runInChunks = async (
    paths: string[],
    onProgress: Progress | undefined,
    write: (chunk: string[]) => Promise<WriteResult[]>,
  ): Promise<ApplyResult> => {
    stopRef.current = false;
    let written = 0;
    const errors: string[] = [];
    onProgress?.(0, paths.length);
    for (let i = 0; i < paths.length; i += WRITE_CHUNK) {
      if (stopRef.current) return { written, errors, stopped: true };
      const chunk = paths.slice(i, i + WRITE_CHUNK);
      try {
        for (const r of await write(chunk)) {
          if (r.error) errors.push(`${basename(r.path)}: ${r.error}`);
          else written++;
        }
      } catch (e) {
        errors.push(String(e));
      }
      onProgress?.(Math.min(i + chunk.length, paths.length), paths.length);
    }
    return { written, errors };
  };

  const read = async (paths: string[]) => {
    const results = await invoke<TagReadResult[]>("read_tags_batch", { paths });
    const map: Record<string, TagData> = {};
    const errors: string[] = [];
    for (const r of results) {
      if (r.tags) map[r.path] = r.tags;
      else errors.push(`${basename(r.path)}: ${r.error ?? "could not read tags"}`);
    }
    return { map, errors };
  };

  /** Rows for the Clear Fields preview: empties each chosen field. */
  const buildClearPreview = (
    paths: string[],
    map: Record<string, TagData>,
    fields: string[],
  ): PendingChange[] => {
    const rows: PendingChange[] = [];
    for (const path of paths) {
      const tags = map[path];
      if (!tags) continue;
      const filename = basename(path);
      for (const field of fields) {
        const isRaw = field.startsWith("raw:");
        const key = isRaw ? field.slice(4) : field;
        const before = String(
          isRaw
            ? (tags.allFields?.[key] ?? "")
            : ((tags as unknown as Record<string, string | undefined>)[key] ?? ""),
        ).trim();
        const changed = before.length > 0;
        rows.push({
          id: `${path}::clear::${field}`,
          path,
          filename,
          field: key,
          before,
          after: "",
          include: changed,
          changed,
          // Every cleared field reads as a removal in the preview, curated or
          // raw — the value is struck through and gone.
          kind: "remove",
          raw: isRaw,
        });
      }
    }
    return rows;
  };

  /**
   * Rows for the standardize preview: applies `transform` to each editable
   * field. Rows whose value actually changes are included by default.
   */
  const buildStandardizePreview = (
    paths: string[],
    map: Record<string, TagData>,
    transform: (value: string, field: string) => string,
    fields: readonly string[] = STANDARDIZE_FIELDS,
  ): PendingChange[] => {
    const rows: PendingChange[] = [];
    for (const path of paths) {
      const tags = map[path];
      if (!tags) continue;
      const filename = basename(path);
      for (const field of fields) {
        const before = ((tags as unknown as Record<string, string | undefined>)[field] ?? "").trim();
        if (!before) continue;
        const after = transform(before, field);
        const changed = after !== before;
        rows.push({
          id: `${path}::std::${field}`,
          path,
          filename,
          field,
          before,
          after,
          include: changed,
          changed,
          kind: "update",
        });
      }
    }
    return rows;
  };

  /**
   * Writes included field updates (AI / standardize / clear) merged over the
   * current tags. Non-common fields are always carried over untouched — the
   * only thing that removes a field is the user ticking it in Clear Fields,
   * which arrives here as a `raw` row.
   */
  const applyUpdates = async (
    rows: PendingChange[],
    map: Record<string, TagData>,
    settings: Settings,
    onProgress?: Progress,
  ): Promise<ApplyResult> => {
    const items: WriteItem[] = [];
    for (const [path, fileRows] of groupByPath(rows)) {
      const current = map[path];
      if (!current) continue;
      const included = fileRows.filter((r) => r.changed && r.include);
      if (!included.length) continue;
      const tags: TagData = { ...current };
      const clearedRaw = new Set<string>();
      for (const r of included) {
        if (r.raw) clearedRaw.add(r.field);
        // Rating is a number on the wire (u8); every other field is text.
        else if (r.field === "rating") tags.rating = Number(r.after) || 0;
        else (tags as unknown as Record<string, string>)[r.field] = r.after;
      }
      // Carry every non-common field over, minus the raw frames the user
      // asked to clear — an extra frame is cleared by not preserving it.
      const keepExtra = preserveExtras(current).filter((k) => !clearedRaw.has(k));
      items.push({ path, tags, keepExtra });
    }
    return withWriteProgress(onProgress, () => writeBatch(items, settings));
  };

  /** Inline edit of a single field; preserves all other tags untouched. */
  const updateField = async (
    path: string,
    current: TagData,
    field: keyof TagData & string,
    value: string | number,
    settings: Settings,
  ): Promise<void> => {
    const result = await updateFieldMany([{ path, current, field, value }], settings);
    if (result.errors.length) throw new Error(result.errors[0]);
  };

  /**
   * The same edit applied to many files in one batch write — used by every
   * bulk path (multi-select cell edit, ratings, undo/redo replay), which
   * would otherwise be one round trip per file. Edits of one file are folded
   * into one write (`foldEditsByPath`).
   */
  const updateFieldMany = async (edits: FieldEdit[], settings: Settings): Promise<ApplyResult> =>
    writeBatch(foldEditsByPath(edits), settings);

  /**
   * Writes pre-built tag objects, one per file. Use this when several fields
   * of the same file change together — passing that file twice through
   * `updateFieldMany` would queue two parallel writes to one path.
   */
  const updateFieldsMany = async (
    writes: { path: string; tags: TagData }[],
    settings: Settings,
  ): Promise<ApplyResult> =>
    writeBatch(
      writes.map(({ path, tags }) => ({ path, tags, keepExtra: preserveExtras(tags) })),
      settings,
    );

  /** Bulk edit (or, with an empty value, removal) of a raw "All Tags" field. */
  const updateRawFieldMany = async (
    edits: { path: string; fieldKey: string; value: string }[],
  ): Promise<ApplyResult> => {
    if (!edits.length) return { written: 0, errors: [], failedPaths: [] };
    const results = await invoke<WriteResult[]>("write_raw_fields_batch", { items: edits });
    const failed = results.filter((r) => r.error);
    return {
      written: results.length - failed.length,
      errors: failed.map((r) => `${basename(r.path)}: ${r.error}`),
      failedPaths: failed.map((r) => r.path),
    };
  };

  /**
   * Assigns sequential zero-padded 6-digit ids to the Track ID of each
   * selected file (a private TXXX:TRACKID frame — never Track Number, which
   * players use for album/playlist order), starting from `settings.nextTrackId`
   * and overwriting any existing value. Returns the next unused counter so it
   * can be persisted; reset it in Settings to regenerate from a chosen number.
   */
  const generateIds = async (
    paths: string[],
    map: Record<string, TagData>,
    settings: Settings,
    onProgress?: Progress,
  ): Promise<ApplyResult & { assigned: number; nextId: number }> => {
    let counter = settings.nextTrackId;
    // One id per file: a path listed twice would otherwise burn two ids and
    // keep only the second.
    const edits = [...new Set(paths)]
      .filter((path) => map[path])
      .map((path) => ({
        path,
        current: map[path],
        field: "trackId" as keyof TagData & string,
        value: formatTrackId(counter++, settings.trackIdDigits),
      }));
    const result = await withWriteProgress(onProgress, () => updateFieldMany(edits, settings));
    // The counter advances past every id handed out, including any whose write
    // failed — an id is never reused, so a retry can't collide with a file that
    // did get written.
    return { ...result, assigned: result.written, nextId: counter };
  };

  /**
   * Renames files to "artist - title - uid" (sanitized), or the fully
   * lowercase dash-only "artist-title-uid" when `strict` is set. Returns a
   * mapping of old path -> new AudioFile so the caller can update its list.
   */
  const renameFiles = async (
    files: AudioFile[],
    map: Record<string, TagData>,
    trackIdDigits = 6,
    strict = false,
  ): Promise<ApplyResult & { mapping: Record<string, AudioFile> }> => {
    let written = 0;
    const errors: string[] = [];
    const mapping: Record<string, AudioFile> = {};
    /** [old path, new path] for each successful rename, resolved in one go below. */
    const renamed: [string, string][] = [];
    for (const file of files) {
      const tags = map[file.path];
      if (!tags) continue;
      const uid = isUid(tags.trackId, trackIdDigits) ? tags.trackId : undefined;
      const stem = buildRenameStem(tags.artist, tags.title, uid, strict);
      if (!stem) {
        errors.push(`${file.filename}: no usable characters to build a name from`);
        continue;
      }
      try {
        // Renames stay sequential: the backend resolves collisions by
        // appending " (2)", which only works if it sees one rename at a time.
        renamed.push([file.path, await invoke<string>("rename_file", { path: file.path, newStem: stem })]);
        written++;
      } catch (e) {
        errors.push(`${file.filename}: ${e}`);
      }
    }
    // One list_files call for every renamed file rather than one per file.
    if (renamed.length) {
      const updated = await invoke<AudioFile[]>("list_files", {
        paths: renamed.map(([, newPath]) => newPath),
      });
      const byPath = new Map(updated.map((f) => [f.path, f]));
      for (const [oldPath, newPath] of renamed) {
        const info = byPath.get(newPath);
        if (info) mapping[oldPath] = info;
      }
    }
    return { written, errors, mapping };
  };

  /**
   * Explicit backup of the selected files: writes the full JSON snapshot and
   * the searchable backup field, preserving everything else. Runs regardless
   * of the auto-backup toggles and works on untagged (filename-only) files.
   * Each file gets a server-side timeout, so one locked/cloud-only file
   * reports an error instead of hanging the whole run.
   */
  const backupSelected = async (
    paths: string[],
    settings: Settings,
    onProgress?: Progress,
  ): Promise<ApplyResult> => {
    return runInChunks(paths, onProgress, (chunk) =>
      invoke<WriteResult[]>("backup_files_batch", {
        paths: chunk,
        backupField: settings.backupField,
      }),
    );
  };

  const restore = async (paths: string[], onProgress?: Progress): Promise<ApplyResult> =>
    runInChunks(paths, onProgress, (chunk) =>
      invoke<WriteResult[]>("restore_from_backup_batch", { paths: chunk }),
    );

  /** Requests the in-progress backup/restore run to stop after the current file. */
  const stopBackup = () => {
    stopRef.current = true;
  };

  return {
    read,
    buildStandardizePreview,
    buildClearPreview,
    applyUpdates,
    updateField,
    updateFieldMany,
    updateFieldsMany,
    updateRawFieldMany,
    generateIds,
    renameFiles,
    backupSelected,
    restore,
    stopBackup,
  };
}
