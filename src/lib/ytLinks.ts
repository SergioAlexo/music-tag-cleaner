/**
 * YouTube Music links for typed songs. A search always returns *something*,
 * so every result is checked against what was typed and marked "check" when
 * it doesn't look like the same song — the link is never passed off as sure.
 */
import { normalizeForMatch, splitArtistTitle, stripFeaturing } from "./ytMatch";

/** Mirrors the Rust `FoundLink` struct (camelCase). */
export interface FoundLink {
  videoId: string;
  url: string;
  title: string;
  artists: string[];
}

function words(text: string): string[] {
  const n = normalizeForMatch(text);
  return n ? n.split(" ") : [];
}

/** Whether a search result looks like the typed song. */
export function linkLooksRight(typed: string, found: FoundLink): boolean {
  const typedWords = new Set(words(typed));
  const title = words(stripFeaturing(found.title) || found.title);
  if (!title.length) return false;
  const cover = title.filter((w) => typedWords.has(w)).length / title.length;
  if (cover < 0.6) return false;
  // A bare typed title names no artist to disagree with.
  if (!splitArtistTitle(typed).artist || !found.artists.length) return true;
  return found.artists.some((a) => words(a).some((w) => typedWords.has(w)));
}

/** Runs `work` over `items`, `limit` at a time, until `cancelled()`. */
export async function runLimited<T>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<void>,
  cancelled: () => boolean,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !cancelled()) await work(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
