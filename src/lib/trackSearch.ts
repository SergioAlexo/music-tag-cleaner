import type { AudioFile, TagData } from "../types";
import { parseSearchableBackup } from "./ytMatch";
import { parseKey, toCamelot, toOpenKey } from "./keys";

/**
 * One search implementation for every place the app looks a track up: the
 * track table's find bar, the YouTube-import search panel, and (later) the
 * library index.
 *
 * The rule it exists to enforce: **searching always looks at the tags, not
 * just at whatever columns happen to be visible.** The table's old find bar
 * scanned rendered cells, so hiding the Artist column silently stopped
 * artist search from working — which reads as "search is broken" rather
 * than "search is scoped", because nothing on screen says so.
 */

/** Fields a `field:value` term can target, mapped to their `TagData` keys. */
const FIELD_ALIASES: Record<string, keyof TagData | "filename" | "path"> = {
  artist: "artist",
  a: "artist",
  title: "title",
  t: "title",
  album: "album",
  albumartist: "albumArtist",
  genre: "genre",
  g: "genre",
  year: "year",
  y: "year",
  comment: "comment",
  composer: "composer",
  originalartist: "originalArtist",
  bpm: "bpm",
  key: "key",
  track: "trackNumber",
  id: "trackId",
  file: "filename",
  filename: "filename",
  f: "filename",
  path: "path",
};

/** Lowercased, diacritic-folded — so "Bjork" finds "Björk". */
export function fold(value: string): string {
  return value.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/**
 * What a BPM tag is searchable as: the text as stored ("127.99") and, when it
 * is a number, its rounded integer, so typing `128` finds a 127.99 file the
 * way a DJ reads it.
 */
function bpmText(bpm: string | undefined): string {
  const raw = (bpm ?? "").trim();
  if (!raw) return "";
  const n = Number(raw.replace(",", "."));
  return Number.isFinite(n) && n > 0 ? `${raw} ${Math.round(n)}` : raw;
}

/**
 * Every spelling of a key tag, so `8A`, `Am` and `1m` all find the same file
 * whatever notation the tag is stored in and whatever notation the Key column
 * is displaying (a search must not depend on a display preference).
 */
function keyText(key: string | undefined): string {
  const raw = (key ?? "").trim();
  if (!raw) return "";
  const parsed = parseKey(raw);
  return parsed ? `${raw} ${toCamelot(parsed)} ${toOpenKey(parsed)}` : raw;
}

function stemOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.[^.]+$/, "");
}

/**
 * Every piece of text a track can be found by, as one folded blob: tags,
 * filename, and the pre-clean identity stored in the searchable backup. The
 * backup matters more than it looks — after a Standardize/AI Clean pass it
 * is often the only place the track's *original* spelling still exists, so
 * searching for the name you remember still finds the file.
 */
export function trackSearchText(file: AudioFile, tag: TagData | undefined): string {
  const parts: string[] = [stemOf(file.path), file.path];
  if (tag) {
    for (const key of [
      "title",
      "artist",
      "album",
      "albumArtist",
      "genre",
      "year",
      "comment",
      "composer",
      "originalArtist",
      "trackNumber",
      "trackId",
    ] as const) {
      const v = tag[key];
      if (typeof v === "string" && v.trim()) parts.push(v);
    }
    const bpm = bpmText(tag.bpm);
    if (bpm) parts.push(bpm);
    const key = keyText(tag.key);
    if (key) parts.push(key);
    // A backup value is already included verbatim above, but its " | | "
    // separators would otherwise glue words together for substring search.
    for (const key of ["originalArtist", "comment", "composer", "album", "albumArtist"] as const) {
      const parsed = parseSearchableBackup(tag[key]);
      if (parsed) parts.push(parsed.stem, parsed.artist, parsed.title, parsed.year);
    }
  }
  return fold(parts.filter(Boolean).join(" \u0001 "));
}

/**
 * Caches each file's searchable haystack, keyed by path with the `TagData`
 * object identity as the invalidation check.
 *
 * `trackSearchText` folds/normalizes every tag field on a file, which is
 * cheap once but not 4000+ times per keystroke — searching the library
 * search dock used to rebuild every haystack from scratch on every
 * character typed, which is what made the first letter of a query visibly
 * stall the UI. Tags only change when the user edits or re-tags a file, so
 * a stale cache entry is caught the moment `tags[path]` becomes a new
 * object (edits always replace, never mutate, `TagData`).
 */
const haystackCache = new Map<string, { tag: TagData | undefined; text: string }>();

export function cachedTrackSearchText(file: AudioFile, tag: TagData | undefined): string {
  const cached = haystackCache.get(file.path);
  if (cached && cached.tag === tag) return cached.text;
  const text = trackSearchText(file, tag);
  haystackCache.set(file.path, { tag, text });
  return text;
}

interface Term {
  /** A specific field to look in, or null for "anywhere". */
  field: (keyof TagData | "filename" | "path") | null;
  text: string;
  negated: boolean;
}

/**
 * Parses a query into terms. Supports `artist:brejcha` field scoping,
 * `-word` to exclude, and `"two words"` to keep a phrase together. Plain
 * words search everywhere. Every term must match (AND), which is what
 * people expect when they type two words.
 */
export function parseQuery(query: string): Term[] {
  const terms: Term[] = [];
  const re = /(-)?(?:(\w+):)?(?:"([^"]*)"|(\S+))/g;
  for (const m of query.matchAll(re)) {
    const [, neg, rawField, quoted, bare] = m;
    const text = fold((quoted ?? bare ?? "").trim());
    if (!text) continue;
    const field = rawField ? (FIELD_ALIASES[rawField.toLowerCase()] ?? null) : null;
    // An unknown prefix ("foo:bar") is not a field — search it literally.
    const literal = rawField && !field ? fold(`${rawField}:${text}`) : text;
    terms.push({ field, text: literal, negated: !!neg });
  }
  return terms;
}

function fieldText(file: AudioFile, tag: TagData | undefined, field: Term["field"]): string {
  if (field === "filename") return fold(stemOf(file.path));
  if (field === "path") return fold(file.path);
  if (field === "bpm") return fold(bpmText(tag?.bpm));
  if (field === "key") return fold(keyText(tag?.key));
  const v = field && tag ? tag[field] : undefined;
  return typeof v === "string" ? fold(v) : "";
}

/** Whether a track satisfies every term of an already-parsed query. */
export function matchesTerms(
  file: AudioFile,
  tag: TagData | undefined,
  terms: Term[],
  haystack?: string,
): boolean {
  if (!terms.length) return true;
  const all = haystack ?? trackSearchText(file, tag);
  for (const term of terms) {
    const target = term.field ? fieldText(file, tag, term.field) : all;
    let hit = target.includes(term.text);
    // `key:8A` is a musical question, not a substring one: "am" must not find
    // "Bm", and "1m" must find an A minor stored as "Am". Anything that is not
    // a key at all (a half-typed "key:8") still falls back to text.
    if (term.field === "key") {
      const wanted = parseKey(term.text);
      const have = parseKey(tag?.key);
      if (wanted && have) hit = wanted.num === have.num && wanted.mode === have.mode;
      else if (wanted) hit = false;
    }
    if (hit === term.negated) return false;
  }
  return true;
}

export interface SearchHit {
  file: AudioFile;
  /** Higher is better — a title/artist hit outranks a buried comment hit. */
  score: number;
}

/**
 * Ranked search over a collection. Ranking is deliberately simple and
 * explainable: an exact or prefix hit on artist/title beats a hit anywhere
 * else, so typing "gravity" puts the track *called* Gravity above one that
 * merely mentions it in a comment.
 */
export function searchTracks(
  files: AudioFile[],
  tags: Record<string, TagData>,
  query: string,
  limit = 200,
): SearchHit[] {
  const terms = parseQuery(query);
  if (!terms.length) return [];
  const needle = terms.find((t) => !t.negated && !t.field)?.text ?? "";
  const hits: SearchHit[] = [];

  for (const file of files) {
    const tag = tags[file.path];
    const haystack = cachedTrackSearchText(file, tag);
    if (!matchesTerms(file, tag, terms, haystack)) continue;

    let score = 1;
    if (needle) {
      const title = fold(tag?.title ?? "");
      const artist = fold(tag?.artist ?? "");
      const stem = fold(stemOf(file.path));
      if (title === needle || artist === needle) score += 4;
      else if (title.startsWith(needle) || artist.startsWith(needle)) score += 3;
      else if (title.includes(needle) || artist.includes(needle)) score += 2;
      else if (stem.includes(needle)) score += 1;
    }
    hits.push({ file, score });
  }

  return hits
    .sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path))
    .slice(0, limit);
}
