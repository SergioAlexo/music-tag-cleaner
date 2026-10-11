/** Shapes returned by `src-tauri/src/commands/lyrics.rs`. */

export type LyricsStatus = "synced" | "plain" | "instrumental" | "notFound" | "have" | "error";

export interface LyricsResult {
  path: string;
  status: LyricsStatus;
  detail: string | null;
  sidecar: string | null;
  embedded: boolean;
}

export interface LyricsData {
  synced: string | null;
  plain: string | null;
  source: "sidecar" | "embedded" | "cache";
  instrumental: boolean;
}

export interface LyricsTally {
  synced: number;
  plain: number;
  instrumental: number;
  notFound: number;
  have: number;
  error: number;
}

export function tallyLyrics(results: LyricsResult[]): LyricsTally {
  const t: LyricsTally = { synced: 0, plain: 0, instrumental: 0, notFound: 0, have: 0, error: 0 };
  for (const r of results) t[r.status]++;
  return t;
}

/** "12 synced, 3 plain, 2 instrumental, 5 not found, 1 already had lyrics, 1 failed" - zero parts omitted. */
export function describeLyricsTally(t: LyricsTally): string {
  const parts: [number, string][] = [
    [t.synced, "synced"],
    [t.plain, "plain"],
    [t.instrumental, "instrumental"],
    [t.notFound, "not found"],
    [t.have, "already had lyrics"],
    [t.error, "failed"],
  ];
  const text = parts.filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`).join(", ");
  return text || "Nothing to fetch";
}
