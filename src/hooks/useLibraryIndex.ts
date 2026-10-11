import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Notify } from "./useFiles";
import type { Facet, FacetCount } from "../lib/facets";
import {
  indexedToFile,
  indexedToTags,
  type AudioFile,
  type GenreCount,
  type IndexProgress,
  type IndexSummary,
  type IndexedTrack,
  type LibraryStats,
  type RekordboxTagSummary,
  type TagData,
} from "../types";

/**
 * The whole-library index, as the UI sees it.
 *
 * The index answers questions about tracks nobody opened today — which
 * genres the collection actually uses, whether a playlist entry is something
 * already owned, where a half-remembered track lives. The rows are held in
 * memory once loaded: everything that consumes them (matching, the search
 * dock, the genre picker) needs the whole set anyway, and a query per
 * keystroke over IPC is slower than a filter over an array.
 *
 * `files`/`tags` are exposed in the app's usual `AudioFile` + `TagData`
 * shapes so `matchPlaylist` and `searchTracks` take indexed and loaded
 * tracks identically, with no second code path.
 */
export function useLibraryIndex(notify: Notify) {
  const [tracks, setTracks] = useState<IndexedTrack[]>([]);
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const [facets, setFacets] = useState<Record<Facet, FacetCount[]>>({ genre: [], album: [] });
  const [indexing, setIndexing] = useState(false);
  const [progress, setProgress] = useState<IndexProgress | null>(null);
  const [loaded, setLoaded] = useState(false);
  /** Guards against two refreshes racing and the slower one winning. */
  const refreshSeq = useRef(0);

  const refreshStats = useCallback(async () => {
    try {
      // Independent queries — issued together rather than one after the other.
      const [nextStats, genre, album] = await Promise.all([
        invoke<LibraryStats>("library_stats"),
        invoke<FacetCount[]>("library_facets", { facet: "genre" }),
        invoke<FacetCount[]>("library_facets", { facet: "album" }),
      ]);
      setStats(nextStats);
      setFacets({ genre, album });
    } catch {
      // A missing/locked database is not worth a toast on every poll — the
      // Settings card shows "not indexed yet", which is the honest state.
    }
  }, []);

  const refreshTracks = useCallback(async () => {
    const seq = ++refreshSeq.current;
    try {
      const rows = await invoke<IndexedTrack[]>("library_tracks");
      if (seq === refreshSeq.current) setTracks(rows);
    } catch (e) {
      if (seq === refreshSeq.current) {
        setTracks([]);
        // Silent — a fresh install with no index yet hits this too, which
        // isn't an error worth a toast. It still goes to the Logs page,
        // since a real failure here (a locked/corrupt db) used to vanish
        // completely, showing up only as an inexplicably empty collection.
        notify(`Could not load the library index: ${e}`, "error", { silent: true });
      }
    } finally {
      if (seq === refreshSeq.current) setLoaded(true);
    }
  }, [notify]);

  const refresh = useCallback(async () => {
    await Promise.all([refreshStats(), refreshTracks()]);
  }, [refreshStats, refreshTracks]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const unlisten = listen<IndexProgress>("library-index-progress", (e) => setProgress(e.payload));
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  const getRoots = useCallback(() => invoke<string[]>("library_roots"), []);

  const setRoots = useCallback(
    async (roots: string[]) => {
      await invoke("set_library_roots", { roots });
      await refresh();
    },
    [refresh],
  );

  /** True while any scan (startup, Settings, Refresh) is running. */
  const scanning = useRef(false);

  const runIndex = useCallback(
    async (rescanAll = false): Promise<IndexSummary> => {
      scanning.current = true;
      setIndexing(true);
      setProgress(null);
      try {
        const summary = await invoke<IndexSummary>("index_library", { rescanAll });
        await refresh();
        return summary;
      } finally {
        scanning.current = false;
        setIndexing(false);
        setProgress(null);
      }
    },
    [refresh],
  );

  /**
   * The sidebar's Refresh: the same incremental scan (mtime + size, so
   * unchanged files are skipped unopened), but a no-op when a scan is already
   * running, so a button press, the focus-triggered refresh and the startup
   * index can never stack two walks of the same folder. Null = skipped.
   */
  const refreshFromDisk = useCallback(
    async (): Promise<IndexSummary | null> => (scanning.current ? null : runIndex(false)),
    [runIndex],
  );

  const clear = useCallback(async () => {
    await invoke("clear_library_index");
    await refresh();
  }, [refresh]);

  const pathsWithGenre = useCallback(
    (genre: string) => invoke<string[]>("library_paths_with_genre", { genre }),
    [],
  );

  /** Indexed paths in one facet bucket; an empty `name` is the "none" bucket. */
  const pathsWithFacet = useCallback(
    (facet: Facet, name: string, artist = "") =>
      invoke<string[]>("library_paths_with_facet", { facet, name, artist }),
    [],
  );

  /** Re-reads specific paths into the index right after a write, so a tag
   * edit on a Library track shows up in genres/search without waiting for
   * the next full re-index. Silent — this rides along every write, and a
   * failure here just means the next full index catches up instead. */
  const reindexPaths = useCallback(
    async (paths: string[]) => {
      if (!paths.length) return;
      try {
        await invoke("reindex_library_paths", { paths });
        await refreshStats();
      } catch {
        // Best-effort.
      }
    },
    [refreshStats],
  );

  /** Imports BPM/key from a Rekordbox XML export into the Library index
   * (D0), then refreshes so the new columns/stats show up immediately. */
  const importRekordboxTags = useCallback(
    async (xmlPath: string) => {
      const summary = await invoke<RekordboxTagSummary>("import_rekordbox_library_tags", { xmlPath });
      await refresh();
      return summary;
    },
    [refresh],
  );

  // The genre list other screens use (Settings, the playlist matcher, the
  // genre picker): real genres only. The "none" bucket is a sidebar concept.
  const genres = useMemo<GenreCount[]>(
    () => facets.genre.filter((g) => g.name).map((g) => ({ name: g.name, count: g.count })),
    [facets.genre],
  );

  const files = useMemo<AudioFile[]>(() => tracks.map(indexedToFile), [tracks]);
  const tags = useMemo<Record<string, TagData>>(() => {
    const out: Record<string, TagData> = {};
    for (const t of tracks) out[t.path] = indexedToTags(t);
    return out;
  }, [tracks]);

  return {
    tracks,
    files,
    tags,
    stats,
    genres,
    facets,
    indexing,
    progress,
    loaded,
    refresh,
    refreshStats,
    getRoots,
    setRoots,
    runIndex,
    refreshFromDisk,
    clear,
    pathsWithGenre,
    pathsWithFacet,
    reindexPaths,
    importRekordboxTags,
  };
}

export type LibraryIndexApi = ReturnType<typeof useLibraryIndex>;

/**
 * Merges the indexed collection with the files loaded in this session,
 * letting the session win on any path they share.
 *
 * Both halves matter and for different reasons: the index is the only thing
 * that knows about unopened tracks, and the session is the only thing that
 * knows about edits made in the last minute but not yet re-indexed. Taking
 * the session's copy on a collision means a just-retagged track matches on
 * its new tags, not the stale row.
 */
export function mergeWithSession(
  indexFiles: AudioFile[],
  indexTags: Record<string, TagData>,
  sessionFiles: AudioFile[],
  sessionTags: Record<string, TagData>,
): { files: AudioFile[]; tags: Record<string, TagData> } {
  const byPath = new Map<string, AudioFile>();
  for (const f of indexFiles) byPath.set(f.path, f);
  for (const f of sessionFiles) byPath.set(f.path, f);
  const tags: Record<string, TagData> = { ...indexTags };
  for (const [path, t] of Object.entries(sessionTags)) tags[path] = t;
  return { files: [...byPath.values()], tags };
}
