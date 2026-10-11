import type { TagData } from "../types";

/**
 * A "facet" is a tag the Library sidebar can browse by: list every value in
 * the index with counts, click one to load its tracks, rename it everywhere.
 * Genres were the first; albums reuse the exact same code path.
 *
 * Adding one (B3's language) is: an entry in `FACETS`, a column + an arm in
 * `Facet` (library_index.rs), and nothing in the sidebar, the load hook or the
 * rename flow.
 */
export type Facet = "genre" | "album";

export interface FacetMeta {
  /** Plural, for the tab and empty states. */
  label: string;
  singular: string;
  /** What the empty bucket is called ("No genre"). */
  noneLabel: string;
  /** The `TagData` key this facet reads. */
  tagKey: "genre" | "album";
  /** The `retag_field` field name that rewrites it. */
  retagField: "genre" | "album";
  /** Whether values are told apart by album artist (two "Greatest Hits"). */
  byAlbumArtist: boolean;
}

export const FACETS: Record<Facet, FacetMeta> = {
  genre: {
    label: "Genres",
    singular: "genre",
    noneLabel: "No genre",
    tagKey: "genre",
    retagField: "genre",
    byAlbumArtist: false,
  },
  album: {
    label: "Albums",
    singular: "album",
    noneLabel: "No album",
    tagKey: "album",
    retagField: "album",
    byAlbumArtist: true,
  },
};

/** One entry of a facet list, as `library_facets` returns it. `name === ""` is the "none" bucket. */
export interface FacetCount {
  name: string;
  /** Album artist for albums, else "". */
  artist: string;
  count: number;
}

/** A chosen facet value, which is what a click loads. */
export interface FacetPick {
  facet: Facet;
  name: string;
  artist: string;
}

export type FacetSort = "count" | "name";

/** Stable identity of an entry within its facet. */
export function facetKey(name: string, artist: string): string {
  return `${name}\u0001${artist}`;
}

/** What to show for a pick: its name (and album artist when it has one), or the "none" label. */
export function facetLabel(pick: FacetPick): string {
  if (!pick.name) return FACETS[pick.facet].noneLabel;
  return pick.artist ? `${pick.name} — ${pick.artist}` : pick.name;
}

export function samePick(a: FacetPick | null, b: FacetPick | null): boolean {
  return !!a && !!b && a.facet === b.facet && a.name === b.name && a.artist === b.artist;
}

/**
 * The list as the sidebar shows it: the "none" bucket always first (it is the
 * to-do list, not a value), then the rest by track count or A-Z, then narrowed
 * by the search box. Pure so the ordering rules are testable.
 */
export function arrangeFacet(
  list: FacetCount[],
  sort: FacetSort,
  query: string,
  noneLabel: string,
): FacetCount[] {
  const q = query.trim().toLowerCase();
  const none = list.filter((f) => !f.name);
  const named = list.filter((f) => f.name);
  const byName = (a: FacetCount, b: FacetCount) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }) ||
    a.artist.localeCompare(b.artist, undefined, { sensitivity: "base", numeric: true });
  named.sort(sort === "name" ? byName : (a, b) => b.count - a.count || byName(a, b));
  const matches = (f: FacetCount) =>
    !q || f.name.toLowerCase().includes(q) || f.artist.toLowerCase().includes(q);
  // The none bucket matches its own label too, so "no g" finds "No genre".
  const noneShown = !q || noneLabel.toLowerCase().includes(q) ? none : [];
  return [...noneShown, ...named.filter(matches)];
}

/** Tallies loaded files into facet entries (the fallback when there is no index yet). */
export function tallyFacet(
  facet: Facet,
  tags: (TagData | undefined)[],
): FacetCount[] {
  const meta = FACETS[facet];
  const counts = new Map<string, FacetCount>();
  for (const t of tags) {
    const name = (t?.[meta.tagKey] ?? "").trim();
    const artist = meta.byAlbumArtist && name ? (t?.albumArtist ?? "").trim() : "";
    const key = facetKey(name, artist);
    const hit = counts.get(key);
    if (hit) hit.count++;
    else counts.set(key, { name, artist, count: 1 });
  }
  return [...counts.values()];
}

/** Whether a track's tags fall in `pick`'s bucket: the in-memory twin of the SQL in `facet_paths`. */
export function matchesFacet(tag: TagData | undefined, pick: FacetPick): boolean {
  const meta = FACETS[pick.facet];
  const name = (tag?.[meta.tagKey] ?? "").trim();
  if (!pick.name) return name === "";
  if ((tag?.[meta.tagKey] ?? "") !== pick.name) return false;
  return !meta.byAlbumArtist || (tag?.albumArtist ?? "").trim() === pick.artist;
}
