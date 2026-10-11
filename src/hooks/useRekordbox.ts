import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AudioFile } from "../types";

/** Rekordbox's BPM / key / rating for one file (`RekordboxEntry` in rekordbox_import.rs). */
export interface RekordboxInfo {
  bpm?: number | null;
  key?: string | null;
  /** Stars 0-5. */
  rating?: number | null;
}

interface Entry extends RekordboxInfo {
  path: string;
}

const CHUNK = 1500;

/**
 * Looks up the last imported rekordbox.xml for whichever files are loaded.
 *
 * Asks only about paths it has not asked about yet (a 4000-track folder is
 * three calls once, not one per render), and forgets everything when the
 * export is re-imported (`xmlMtime` changes) because the answers may differ.
 */
export function useRekordboxLookup(paths: string[], xmlPath: string, xmlMtime: number) {
  const [info, setInfo] = useState<Record<string, RekordboxInfo>>({});
  const asked = useRef<Set<string>>(new Set());
  const generation = useRef(`${xmlPath}|${xmlMtime}`);

  useEffect(() => {
    const gen = `${xmlPath}|${xmlMtime}`;
    if (generation.current !== gen) {
      generation.current = gen;
      asked.current = new Set();
      setInfo({});
    }
    if (!xmlPath) return;
    const todo = paths.filter((p) => !asked.current.has(p));
    if (!todo.length) return;
    for (const p of todo) asked.current.add(p);
    (async () => {
      const found: Record<string, RekordboxInfo> = {};
      for (let i = 0; i < todo.length; i += CHUNK) {
        try {
          const rows = await invoke<Entry[]>("rekordbox_lookup", { paths: todo.slice(i, i + CHUNK) });
          for (const r of rows) found[r.path] = { bpm: r.bpm, key: r.key, rating: r.rating };
        } catch (e) {
          // Not fatal: the columns simply show the file tags only. Forget the
          // paths so a later render retries.
          console.error("Rekordbox lookup failed:", e);
          for (const p of todo.slice(i, i + CHUNK)) asked.current.delete(p);
        }
      }
      if (generation.current === gen && Object.keys(found).length) {
        setInfo((prev) => ({ ...prev, ...found }));
      }
    })();
  }, [paths, xmlPath, xmlMtime]);

  return info;
}

/** `files` with Rekordbox's BPM / key / rating layered on (same objects when there is nothing to add). */
export function withRekordbox(files: AudioFile[], info: Record<string, RekordboxInfo>): AudioFile[] {
  if (!Object.keys(info).length) return files;
  return files.map((f) => {
    const rb = info[f.path];
    if (!rb) return f;
    return {
      ...f,
      bpm: rb.bpm ?? f.bpm,
      key: rb.key ?? f.key,
      rbRating: rb.rating ?? undefined,
    };
  });
}
