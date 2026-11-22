import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AudioFile } from "../types";

export interface ArtGroup {
  /** Same value for every loaded track carrying one picture. */
  group: string;
  /** How many loaded tracks carry it (1 = unique cover). */
  size: number;
}

/** Waits for the file list to settle (a folder load arrives in batches). */
const DEBOUNCE_MS = 600;

/**
 * Groups the loaded tracks by the look of their embedded cover, for the
 * track table's "Same art" column. Runs only while `enabled` (the column is
 * shown). The backend hashes covers incrementally, so after the first run a
 * regroup only reads files whose art changed; `refresh` forces one after an
 * artwork edit, since an edit keeps the file list's identity.
 */
export function useArtGroups(files: AudioFile[], enabled: boolean) {
  const [groups, setGroups] = useState<Record<string, ArtGroup>>({});
  const [loading, setLoading] = useState(false);
  const [token, setToken] = useState(0);

  useEffect(() => {
    if (!enabled || files.length === 0) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const entries = await invoke<{ path: string; group: string; size: number }[]>("artwork_groups", {
          paths: files.map((f) => f.path),
        });
        if (cancelled) return;
        const next: Record<string, ArtGroup> = {};
        for (const e of entries) next[e.path] = { group: e.group, size: e.size };
        setGroups(next);
      } catch {
        // Leave the previous grouping; the column just stays as it was.
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [files, enabled, token]);

  const refresh = useCallback(() => setToken((t) => t + 1), []);
  return { groups, loading, refresh };
}

/**
 * Sort key that keeps one picture's tracks together, biggest groups first
 * (ascending), unique covers next and tracks without art last.
 */
export function artGroupSortKey(g: ArtGroup | undefined): string {
  if (!g) return "3";
  if (g.size < 2) return `2|${g.group}`;
  return `1|${String(1_000_000 - g.size).padStart(7, "0")}|${g.group}`;
}
