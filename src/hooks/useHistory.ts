import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { basename, type PendingChange, type Settings } from "../types";
import type { Notify } from "./useFiles";
import type { useTags } from "./useTags";

/** One field's before/after on one file. */
export interface HistoryChange {
  path: string;
  field: string;
  before: string | number;
  after: string | number;
}

/** One user-visible action ("Apply ai", "Set rating", …) and everything it wrote. */
export interface HistoryEntry {
  label: string;
  changes: HistoryChange[];
}

const HISTORY_LIMIT = 50;

/** One session tab's undo/redo stacks, parked while another tab is active. */
export interface HistorySnapshot {
  history: HistoryEntry[];
  redoStack: HistoryEntry[];
}

export const EMPTY_HISTORY: HistorySnapshot = { history: [], redoStack: [] };

/** Synthetic `field` prefixes used for changes that aren't plain tag fields. */
const COVER_ART_FIELD = "__coverArt";
const RAW_FIELD_PREFIX = "__raw:";

interface Deps {
  tagsApi: ReturnType<typeof useTags>;
  settings: Settings;
  notify: Notify;
  /** True while another long-running action holds the app's busy flag. */
  busy: boolean;
  setBusy: (busy: boolean) => void;
  /** Drops cached cover art for paths whose artwork was rewritten. */
  invalidateCovers: (paths: string[]) => void;
  /** Drops cached tags for `paths` so the table re-reads just those files. */
  dropLibraryTags: (paths: string[]) => void;
  /** Drops the whole tag cache (used by the jump, which can touch anything). */
  resetLibraryTags: () => void;
  refreshPaths: (paths: string[]) => Promise<void>;
  refreshAll: () => Promise<void>;
  /** Re-reads changed paths into the Library index, for whichever ones sit
   * inside the Library folder — see Workstream A4 in PLAN-v0.15-library.md. */
  reindexLibraryPaths: (paths: string[]) => Promise<void>;
}

/**
 * The session's undo/redo stack.
 *
 * Every action that writes tags reports what it changed through `push`; the
 * hook can then replay any entry in either direction by writing the recorded
 * `before` or `after` value back to disk. There is no in-memory snapshot of a
 * file — undo is a real write, which is why it goes through the same
 * `tagsApi.updateField` path as the original edit.
 *
 * Three kinds of change need different write paths, distinguished by `field`:
 * embedded artwork (`__coverArt`), a raw tag frame (`__raw:KEY`), and an
 * ordinary typed tag field.
 */
export function useHistory({
  tagsApi,
  settings,
  notify,
  busy,
  setBusy,
  invalidateCovers,
  dropLibraryTags,
  resetLibraryTags,
  refreshPaths,
  refreshAll,
  reindexLibraryPaths,
}: Deps) {
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [redoStack, setRedoStack] = useState<HistoryEntry[]>([]);

  const push = (entry: HistoryEntry) => {
    if (!entry.changes.length) return;
    setHistory((h) => [...h.slice(-(HISTORY_LIMIT - 1)), entry]);
    setRedoStack([]);
    void reindexLibraryPaths([...new Set(entry.changes.map((c) => c.path))]);
  };

  /** Writes `before` (undo) or `after` (redo) for every change in `changes`. */
  const applyChanges = async (changes: HistoryChange[], useAfter: boolean) => {
    const artChanges = changes.filter((c) => c.field === COVER_ART_FIELD);
    const rawChanges = changes.filter((c) => c.field.startsWith(RAW_FIELD_PREFIX));
    const tagChanges = changes.filter(
      (c) => c.field !== COVER_ART_FIELD && !c.field.startsWith(RAW_FIELD_PREFIX),
    );

    for (const c of artChanges) {
      const value = String(useAfter ? c.after : c.before);
      await invoke("restore_cover_art", { path: c.path, dataUrl: value || null });
    }
    if (artChanges.length) invalidateCovers(artChanges.map((c) => c.path));

    const raw = await tagsApi.updateRawFieldMany(
      rawChanges.map((c) => ({
        path: c.path,
        fieldKey: c.field.slice(RAW_FIELD_PREFIX.length),
        value: String(useAfter ? c.after : c.before),
      })),
    );
    // Same as the tag writes below: a failed write must not let the entry
    // move to the other stack as if it had been undone (or redone).
    if (raw.errors.length) throw new Error(raw.errors[0]);

    const paths = [...new Set(tagChanges.map((c) => c.path))];
    const { map } = await tagsApi.read(paths);
    // Replaying change-by-change made undo as slow as the action it undid, so
    // this goes out as one batch write. Every change for a file is folded into
    // that file's single tag object first — one entry can touch several fields
    // of the same file, and two writes racing on one path would lose one of them.
    const touched = new Set<string>();
    for (const c of tagChanges) {
      const current = map[c.path];
      if (!current) continue;
      const value = useAfter ? c.after : c.before;
      (current as unknown as Record<string, string | number>)[c.field] =
        c.field === "rating" ? Number(value) : value;
      touched.add(c.path);
    }
    const result = await tagsApi.updateFieldsMany(
      [...touched].map((path) => ({ path, tags: map[path] })),
      settings,
    );
    if (result.errors.length) throw new Error(result.errors[0]);
  };

  /** Shared body of undo/redo: replay one entry, then move it between the stacks. */
  const step = async (entry: HistoryEntry | undefined, useAfter: boolean, verb: string) => {
    if (!entry || busy) return;
    setBusy(true);
    try {
      await applyChanges(entry.changes, useAfter);
      if (useAfter) {
        setRedoStack((r) => r.slice(0, -1));
        setHistory((h) => [...h, entry]);
      } else {
        setHistory((h) => h.slice(0, -1));
        setRedoStack((r) => [...r, entry]);
      }
      const paths = [...new Set(entry.changes.map((c) => c.path))];
      dropLibraryTags(paths);
      await refreshPaths(paths);
      // Undo/redo is a real write like the action itself, so the Library
      // index has to hear about it too — `push` reindexes the original edit,
      // and without this an undone genre change lingered in the sidebar and
      // search until the next full re-index.
      void reindexLibraryPaths(paths);
      notify(`${verb}: ${entry.label}`, "success");
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const snapshot = (): HistorySnapshot => ({ history, redoStack });
  const restore = (s: HistorySnapshot) => {
    setHistory(s.history);
    setRedoStack(s.redoStack);
  };

  const undo = () => step(history[history.length - 1], false, "Undid");
  const redo = () => step(redoStack[redoStack.length - 1], true, "Redid");

  /** Full session timeline in chronological order: applied entries followed by undone-but-redoable ones. */
  const timeline = [...history, ...[...redoStack].reverse()];
  /** Index (into `timeline`) of the last applied entry — -1 means nothing applied. */
  const index = history.length - 1;

  /** Moves the undo/redo boundary directly to `targetIndex`, applying/reverting every entry in between in one go. */
  const jumpTo = async (targetIndex: number) => {
    if (busy || targetIndex === index) return;
    setBusy(true);
    try {
      if (targetIndex < index) {
        const toUndo = timeline.slice(targetIndex + 1, index + 1).reverse();
        for (const entry of toUndo) await applyChanges(entry.changes, false);
      } else {
        const toRedo = timeline.slice(index + 1, targetIndex + 1);
        for (const entry of toRedo) await applyChanges(entry.changes, true);
      }
      setHistory(timeline.slice(0, targetIndex + 1));
      setRedoStack([...timeline.slice(targetIndex + 1)].reverse());
      resetLibraryTags();
      await refreshAll();
      const replayed =
        targetIndex < index
          ? timeline.slice(targetIndex + 1, index + 1)
          : timeline.slice(index + 1, targetIndex + 1);
      void reindexLibraryPaths([...new Set(replayed.flatMap((e) => e.changes.map((c) => c.path)))]);
      notify(
        targetIndex < 0 ? "Jumped to session start" : `Jumped to: ${timeline[targetIndex].label}`,
        "success",
      );
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  /** Read-only diff of every change applied so far this session, shaped for the preview table. */
  const compareRows = (): PendingChange[] =>
    history.flatMap((entry, i) =>
      entry.changes.map((c, j) => ({
        id: `hist::${i}::${j}`,
        path: c.path,
        filename: basename(c.path),
        field: c.field,
        before: String(c.before),
        after: String(c.after),
        include: true,
        changed: true,
        kind: "update" as const,
      })),
    );

  return {
    push,
    snapshot,
    restore,
    undo,
    redo,
    jumpTo,
    compareRows,
    /** Chronological list of every entry, applied or undone, for the history menu. */
    timeline,
    index,
    canUndo: history.length > 0,
    canRedo: redoStack.length > 0,
  };
}
