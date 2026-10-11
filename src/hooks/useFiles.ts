import { useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { AUDIO_EXTENSIONS, type AudioFile } from "../types";
import { afterManualAdd, EMPTY_SOURCE, type SessionSource } from "../lib/sessionTabs";

export interface NotifyOpts {
  /** Structured data to keep alongside the log line — shown expanded in the
   * Logs page and included when it's copied, without cluttering the toast. */
  details?: unknown;
  /** Records the entry in the Logs page but skips the on-screen toast — for
   * events too frequent or minor to pop up (e.g. a single match-row click),
   * that should still show up when troubleshooting a session. */
  silent?: boolean;
}

export type Notify = (message: string, kind?: "success" | "error" | "info", opts?: NotifyOpts) => void;

export function useFiles(
  recursive: boolean,
  notify: Notify,
  onFolderPicked: (path: string) => void,
  defaultFolder: string,
) {
  const [files, setFiles] = useState<AudioFile[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scanning, setScanning] = useState(false);
  // How the batch was built — decides whether a library-genre click may swap
  // it silently (empty / genre) or has to respect work done by hand (manual).
  const [source, setSource] = useState<SessionSource>(EMPTY_SOURCE);
  // Async callers (refresh/refreshPaths) run long after the render that created
  // them, so read the live list here instead of a captured `files` snapshot.
  const filesRef = useRef(files);
  filesRef.current = files;

  const merge = (incoming: AudioFile[]) => {
    setFiles((prev) => {
      const byPath = new Map(prev.map((f) => [f.path, f]));
      for (const f of incoming) byPath.set(f.path, f);
      return [...byPath.values()];
    });
    setSelected((prev) => {
      const next = new Set(prev);
      for (const f of incoming) next.add(f.path);
      return next;
    });
  };

  const selectFolder = async () => {
    try {
      const dir = await open({
        directory: true,
        title: "Select music folder",
        defaultPath: defaultFolder || undefined,
      });
      if (typeof dir !== "string") return;
      setScanning(true);
      const found = await invoke<AudioFile[]>("scan_folder", { path: dir, recursive });
      merge(found);
      if (found.length) setSource(afterManualAdd);
      onFolderPicked(dir);
      notify(
        found.length
          ? `Found ${found.length} audio file${found.length === 1 ? "" : "s"}`
          : "No audio files found in that folder",
        found.length ? "success" : "info",
      );
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setScanning(false);
    }
  };

  const addFiles = async () => {
    try {
      const picked = await open({
        multiple: true,
        title: "Add audio files",
        filters: [{ name: "Audio files", extensions: [...AUDIO_EXTENSIONS] }],
      });
      if (!picked) return;
      const paths = Array.isArray(picked) ? picked : [picked];
      const found = await invoke<AudioFile[]>("list_files", { paths });
      merge(found);
      if (found.length) setSource(afterManualAdd);
      notify(`Added ${found.length} file${found.length === 1 ? "" : "s"}`, "success");
    } catch (e) {
      notify(String(e), "error");
    }
  };

  // App.tsx wires this up from two places — the OS drag-and-drop listener and
  // the "opened with this app" drain — and both can legitimately fire for the
  // very same drop: React StrictMode's mount→unmount→mount in dev re-runs an
  // effect before its async listener registration has settled, and a
  // multi-file "Open with" launches a short burst of OS processes that each
  // report the same paths. Either way the symptom is identical: "Added N
  // files" logged twice for one drop. Rather than chase which path fired
  // twice, de-duplicate here — the one place both funnels converge — by
  // ignoring a call with the exact same paths as the one just handled.
  const lastImportRef = useRef<{ key: string; at: number } | null>(null);

  /** Imports dropped paths (files and/or folders). */
  const importPaths = async (paths: string[]) => {
    if (!paths.length) return;
    const key = paths.join("\u0001");
    const last = lastImportRef.current;
    if (last && last.key === key && Date.now() - last.at < 2000) return;
    lastImportRef.current = { key, at: Date.now() };
    try {
      setScanning(true);
      const found = await invoke<AudioFile[]>("import_paths", { paths, recursive });
      merge(found);
      if (found.length) setSource(afterManualAdd);
      notify(
        found.length
          ? `Added ${found.length} file${found.length === 1 ? "" : "s"}`
          : "No audio files in the dropped items",
        found.length ? "success" : "info",
      );
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setScanning(false);
    }
  };

  const toggle = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const setAll = (checked: boolean) => {
    setSelected(checked ? new Set(files.map((f) => f.path)) : new Set());
  };

  const setManySelected = (paths: string[], checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const p of paths) {
        if (checked) next.add(p);
        else next.delete(p);
      }
      return next;
    });
  };

  const clearList = () => {
    setFiles([]);
    setSelected(new Set());
    setSource(EMPTY_SOURCE);
  };

  /**
   * Swaps the whole batch for `next` (a library-genre load). Nothing is
   * ticked afterwards, unlike `merge`: a batch action must not be able to hit
   * a whole genre by accident — tick or highlight what you mean.
   */
  const replaceWith = (next: AudioFile[], nextSource: SessionSource) => {
    setFiles(next);
    setSelected(new Set());
    setSource(nextSource);
  };

  /**
   * Adds tracks picked from the library search to the batch, ticking them like
   * any other add. The batch is hand-built from here on, so a later genre
   * click asks instead of silently replacing it.
   */
  const addIndexed = (incoming: AudioFile[]) => {
    if (!incoming.length) return;
    merge(incoming);
    setSource(afterManualAdd);
  };

  /** The batch as a session tab keeps it while that tab is in the background. */
  const snapshot = () => ({ files, selected: [...selected], source });

  const restore = (s: { files: AudioFile[]; selected: string[]; source: SessionSource }) => {
    setFiles(s.files);
    setSelected(new Set(s.selected));
    setSource(s.source);
  };

  /** Re-reads file info (size, hasBackup, duration) for every loaded file. */
  const refresh = async () => {
    if (!filesRef.current.length) return;
    try {
      const updated = await invoke<AudioFile[]>("list_files", {
        paths: filesRef.current.map((f) => f.path),
      });
      // Merged in place rather than replacing the list: a big re-read takes
      // seconds, and files added (or removed) meanwhile must survive it.
      const byPath = new Map(updated.map((f) => [f.path, f]));
      setFiles((prev) => prev.map((f) => byPath.get(f.path) ?? f));
    } catch (e) {
      console.error("Failed to refresh file list:", e);
    }
  };

  /**
   * Re-reads only `paths`, merging the results in place. Each entry costs a
   * full tag parse on the Rust side, so a whole-library `refresh()` after
   * touching one file is O(library) disk I/O — use this when the set of
   * affected files is known.
   */
  const refreshPaths = async (paths: string[]) => {
    const known = new Set(filesRef.current.map((f) => f.path));
    const wanted = [...new Set(paths)].filter((p) => known.has(p));
    if (!wanted.length) return;
    try {
      const updated = await invoke<AudioFile[]>("list_files", { paths: wanted });
      const byPath = new Map(updated.map((f) => [f.path, f]));
      setFiles((prev) => prev.map((f) => byPath.get(f.path) ?? f));
    } catch (e) {
      console.error("Failed to refresh files:", e);
    }
  };

  /** Drops files from the list (e.g. after they were deleted from disk). */
  const removeFiles = (paths: string[]) => {
    const gone = new Set(paths);
    setFiles((prev) => prev.filter((f) => !gone.has(f.path)));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const p of paths) next.delete(p);
      return next;
    });
  };

  /** Applies path changes after a rename, preserving order and selection. */
  const remap = (mapping: Record<string, AudioFile>) => {
    setFiles((prev) => prev.map((f) => mapping[f.path] ?? f));
    setSelected((prev) => {
      const next = new Set<string>();
      for (const p of prev) next.add(mapping[p]?.path ?? p);
      return next;
    });
  };

  const selectedPaths = useMemo(
    () => files.filter((f) => selected.has(f.path)).map((f) => f.path),
    [files, selected],
  );
  const totalSize = useMemo(() => files.reduce((sum, f) => sum + f.size, 0), [files]);

  return {
    files,
    selected,
    selectedPaths,
    totalSize,
    scanning,
    source,
    merge,
    selectFolder,
    addFiles,
    importPaths,
    toggle,
    setAll,
    setManySelected,
    clearList,
    replaceWith,
    addIndexed,
    snapshot,
    restore,
    refresh,
    refreshPaths,
    remap,
    removeFiles,
  };
}
