import { useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { TagData } from "../types";
import type { FacetPick } from "../lib/facets";
import type { Notify, useFiles } from "./useFiles";
import type { LibraryIndexApi } from "./useLibraryIndex";
import type { useTags } from "./useTags";

/** Files per `read_tags_batch` call during the background refresh. */
const TAG_READ_CHUNK = 200;

interface Deps {
  libraryIndex: LibraryIndexApi;
  filesApi: ReturnType<typeof useFiles>;
  tagsApi: ReturnType<typeof useTags>;
  libraryTags: Record<string, TagData>;
  setLibraryTags: React.Dispatch<React.SetStateAction<Record<string, TagData>>>;
  notify: Notify;
}

/**
 * Loads a library genre or album (a "facet" value, see lib/facets.ts) into the
 * batch, or adds searched tracks to it: paints the table at once from the
 * index, then re-reads the real tags in the background.
 *
 * The index only keeps the curated fields, so the instant paint has no
 * `allFields` or cover data; the refresh below fills those in. Every click
 * bumps a generation counter and each await re-checks it, so flicking
 * House → Techno → House quickly can never leave rows or tags from the
 * superseded load behind.
 */
export function useGenreLoad({
  libraryIndex,
  filesApi,
  tagsApi,
  libraryTags,
  setLibraryTags,
  notify,
}: Deps) {
  const generation = useRef(0);

  /** Invalidates any in-flight load (e.g. when the batch is replaced some other way). */
  const cancel = () => {
    generation.current++;
  };

  /**
   * Re-reads the real tags of `rows` in chunks. `gen` is the load's generation
   * (null for an add, which nothing supersedes); a stale one stops quietly.
   */
  const hydrate = async (rows: { path: string }[], gen: number | null) => {
    const toRead = rows.map((f) => f.path).filter((p) => !libraryTags[p]);
    const gone: string[] = [];
    for (let i = 0; i < toRead.length; i += TAG_READ_CHUNK) {
      const chunk = toRead.slice(i, i + TAG_READ_CHUNK);
      try {
        const { map } = await tagsApi.read(chunk);
        if (gen !== null && gen !== generation.current) return;
        setLibraryTags((prev) => ({ ...prev, ...map }));
        // The index can outlive a file that was moved or deleted outside the
        // app. An unreadable row is only dropped once it's confirmed missing —
        // a corrupt file that still exists stays visible rather than vanishing.
        const unread = chunk.filter((p) => !map[p]);
        const missing: string[] = [];
        for (const p of unread) if (!(await invoke<boolean>("path_exists", { path: p }))) missing.push(p);
        if (gen !== null && gen !== generation.current) return;
        if (missing.length) {
          filesApi.removeFiles(missing);
          gone.push(...missing);
        }
      } catch (e) {
        console.error("Failed to read tags for library rows:", e);
        return;
      }
    }
    if (gone.length) {
      // Re-indexing a path whose file is gone drops its row, so the counts
      // and search stop offering it — no full re-index needed.
      // The refresh after it updates the in-memory rows too (rare, so cheap enough).
      void libraryIndex.reindexPaths(gone).then(() => libraryIndex.refresh());
      const n = gone.length;
      notify(`${n} file${n === 1 ? "" : "s"} no longer exist${n === 1 ? "s" : ""} — removed from the Library`, "info");
    }
  };

  /** Index rows for `paths`, in order, skipping any the in-memory index no longer lists. */
  const indexedRows = (paths: string[]) => {
    const indexed = new Map(libraryIndex.files.map((f) => [f.path, f]));
    return paths.flatMap((p) => indexed.get(p) ?? []);
  };

  /** Tags the session already holds are fuller (and newer after an edit) than the index's curated copy, so they win. */
  const seedFromIndex = (rows: { path: string }[]) => {
    const seed: Record<string, TagData> = {};
    for (const f of rows) if (libraryIndex.tags[f.path]) seed[f.path] = libraryIndex.tags[f.path];
    setLibraryTags((prev) => ({ ...seed, ...prev }));
  };

  const loadFacet = async (pick: FacetPick) => {
    const gen = ++generation.current;
    let paths: string[];
    try {
      paths = await libraryIndex.pathsWithFacet(pick.facet, pick.name, pick.artist);
    } catch (e) {
      notify(String(e), "error");
      return;
    }
    if (gen !== generation.current) return;

    const rows = indexedRows(paths);
    // Instant paint, then the background refresh.
    seedFromIndex(rows);
    filesApi.replaceWith(rows, { kind: "facet", ...pick });
    await hydrate(rows, gen);
  };

  /**
   * Adds searched library tracks to the current session without replacing it
   * (and without touching undo history: nothing was edited). Paths already in
   * the session are skipped, so a double click can't duplicate rows.
   */
  const addTracks = async (paths: string[]) => {
    const have = new Set(filesApi.files.map((f) => f.path));
    const rows = indexedRows(paths).filter((f) => !have.has(f.path));
    if (!rows.length) {
      notify("Those tracks are already in this session", "info");
      return;
    }
    seedFromIndex(rows);
    filesApi.addIndexed(rows);
    notify(`Added ${rows.length} track${rows.length === 1 ? "" : "s"} to this session`, "success");
    await hydrate(rows, null);
  };

  return { loadFacet, addTracks, cancel };
}
