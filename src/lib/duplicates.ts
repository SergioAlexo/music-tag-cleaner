import type { AudioFile, TagData } from "../types";

export const LOSSLESS = new Set(["flac", "wav", "aiff", "aif"]);
export const COMPLETENESS_FIELDS: (keyof TagData)[] = [
  "title",
  "artist",
  "album",
  "albumArtist",
  "year",
  "genre",
  "trackNumber",
];

export function tagCompleteness(t?: TagData): number {
  if (!t) return 0;
  const filled = COMPLETENESS_FIELDS.filter((k) => {
    const v = t[k];
    return typeof v === "string" && v.trim().length > 0;
  }).length;
  return filled + (t.hasCoverArt ? 1 : 0);
}

/** Highest quality → most complete tags → shortest/first path as a
 * deterministic tie-break (a true "oldest file" tie-break would need file
 * mtime surfaced to the frontend, which isn't wired up here). */
export function suggestKeeper(paths: string[], files: Record<string, AudioFile>, tags: Record<string, TagData>): string {
  return [...paths].sort((a, b) => {
    const fa = files[a];
    const fb = files[b];
    const rankA = fa && LOSSLESS.has(fa.format.toLowerCase()) ? 1 : 0;
    const rankB = fb && LOSSLESS.has(fb.format.toLowerCase()) ? 1 : 0;
    if (rankA !== rankB) return rankB - rankA;
    const brA = fa?.bitrateKbps ?? 0;
    const brB = fb?.bitrateKbps ?? 0;
    if (brA !== brB) return brB - brA;
    const tagA = tagCompleteness(tags[a]);
    const tagB = tagCompleteness(tags[b]);
    if (tagA !== tagB) return tagB - tagA;
    // Byte-identical copies tie on everything above; keep the original name,
    // not "Song (1).mp3" / "Song - Copy.mp3" (alphabetical order put the copy
    // first, since "(" sorts before ".").
    const copyA = looksLikeCopy(a) ? 1 : 0;
    const copyB = looksLikeCopy(b) ? 1 : 0;
    if (copyA !== copyB) return copyA - copyB;
    return a.localeCompare(b);
  })[0];
}

/** "Song (1).mp3", "Song (2).mp3", "Song - Copy.mp3", "Song copy 2.mp3": what Windows/macOS name a duplicated file. */
export function looksLikeCopy(path: string): boolean {
  const stem = (path.split(/[\\/]/).pop() ?? path).replace(/\.[^.]+$/, "");
  // Windows writes " - Copy", macOS a lowercase " copy"; a capitalised bare
  // "Copy" is a title ("Carbon Copy").
  return (
    /\s\(\d{1,3}\)$/.test(stem) || /\s-\s[Cc]opy(\s\(\d{1,3}\))?$/.test(stem) || /\scopy(\s\d{1,3})?$/.test(stem)
  );
}

/** Why `keeper` outranks `other`: walks the same comparison order as
 * `suggestKeeper` (lossless, bitrate, tag completeness, path) and names the
 * first criterion that differs. Keep the two in sync; this only explains the
 * ranking, it never changes it. */
export function suggestReason(
  keeper: string,
  other: string,
  files: Record<string, AudioFile>,
  tags: Record<string, TagData>,
): string {
  const fk = files[keeper];
  const fo = files[other];
  const kLossless = !!fk && LOSSLESS.has(fk.format.toLowerCase());
  const oLossless = !!fo && LOSSLESS.has(fo.format.toLowerCase());
  if (kLossless !== oLossless) return `lossless ${fk!.format.toUpperCase()}`;
  const kb = fk?.bitrateKbps ?? 0;
  const ob = fo?.bitrateKbps ?? 0;
  if (kb !== ob) return `higher bitrate (${kb} vs ${ob} kbps)`;
  if (tagCompleteness(tags[keeper]) !== tagCompleteness(tags[other])) return "more complete tags";
  if (looksLikeCopy(other) && !looksLikeCopy(keeper)) return "the original file name (the other looks like a copy)";
  return "first by file path (files otherwise tie)";
}

/** How a group was found (`DuplicateGroup.reason` from `scan_duplicates`):
 * "audio" = fingerprints matched; "tags+audio" = same artist + title and the
 * audio partly overlaps; "tags" = same artist + title only (e.g. a radio edit
 * and an extended mix whose analysed opening differs). Older builds send no
 * reason, which reads as audio. */
export function groupReasonLabel(reason?: string): string {
  switch (reason) {
    case "tags":
      return "same artist and title (audio not confirmed)";
    case "tags+audio":
      return "same artist and title, audio partly matches";
    default:
      return "audio match";
  }
}

// ------------------------------------------------------------ skipped groups

/**
 * A stable name for "this exact set of files", used to remember groups the
 * owner skipped. The scan's own `id` is a per-run cluster number, so it can't
 * be used across scans. Case- and slash-insensitive (Windows paths), order-
 * independent. A group that later gains or loses a file gets a new key and
 * shows up again, which is what you want: the question has changed.
 */
export function duplicateGroupKey(paths: string[]): string {
  const joined = paths
    .map((p) => p.replace(/\\/g, "/").toLowerCase())
    .sort()
    .join("\n");
  // cyrb53: a 53-bit string hash, plenty for a few thousand groups.
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < joined.length; i++) {
    const ch = joined.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${paths.length}-${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}`;
}

/** Remembered skips are capped so the settings file can't grow without bound. */
export const MAX_SKIPPED_GROUPS = 5000;

/** `skipped` with `keys` added (newest last, oldest dropped past the cap). */
export function addSkipped(skipped: string[], keys: string[]): string[] {
  const next = [...skipped.filter((k) => !keys.includes(k)), ...keys];
  return next.slice(Math.max(0, next.length - MAX_SKIPPED_GROUPS));
}

// --------------------------------------------------------- alternate versions

export type VersionKind =
  /** Extended / club / 12-inch: the long DJ-friendly cut. */
  | "extended"
  /** Radio edit / short edit / single version: the short cut. */
  | "radio"
  /** No version tag, or "Original Mix" / "Album Version". */
  | "plain"
  /** Instrumental, acapella, intro edit, live… a different thing, never auto-suggested. */
  | "special";

export interface VersionInfo {
  kind: VersionKind;
  /** What to show next to the file: "Extended Mix", "Radio Edit · Clean"; "" when untagged. */
  label: string;
  /** "clean" / "dirty" when the name says so. */
  explicit: "clean" | "dirty" | null;
  /** Normalised remixer credit ("joe smith"), "" for the original. */
  remix: string;
}

const SPECIAL =
  /\b(instrumental|inst|acapella|acappella|a ?cappella|dub|live|acoustic|intro|outro|transition|quick ?hit|hype|mashup|bootleg|rework|flip|vip|tool|segue|snip(pet)?|preview|demo|karaoke|slowed|sped ?up|nightcore)\b/;
const EXTENDED = /\b(extended|ext|club (mix|version)|12 ?inch|long (mix|version)|full length)\b/;
const RADIO = /\b(radio|short|single (edit|version|mix)|video (edit|version)|7 ?inch|edit)\b/;
const PLAIN = /^(original( mix| version)?|orig( mix)?|main( mix)?|album( version)?|full( version)?|explicit|clean|dirty|single)$/;
const ANY_VERSION = /\b(mix|remix|version|remaster(ed)?)\b/;
const LENGTH_WORDS =
  /\b(extended|ext|radio|short|club|original|orig|main|clean|dirty|explicit|single|video|full|long|version|remix|mix|edit|12|7|inch)\b/g;

/** Lowercase, punctuation to spaces, single-spaced. */
const plainText = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Bracket contents and " - suffix" parts of a title or file name. */
function versionTags(name: string): string[] {
  const stem = name.replace(/\.(mp3|flac|wav|aiff?|m4a|aac|ogg|opus|alac)$/i, "");
  const tags: string[] = [];
  for (const m of stem.matchAll(/[([]([^)\]]*)[)\]]/g)) tags.push(m[1]);
  const outside = stem.replace(/[([][^)\]]*[)\]]/g, " ");
  const parts = outside.split(/\s+-\s+/);
  // The last dash-separated part is a version only when it reads like one
  // ("Artist - Title - Radio Edit"); otherwise it is the title itself.
  if (parts.length > 2) {
    const tail = plainText(parts[parts.length - 1]);
    if (EXTENDED.test(tail) || RADIO.test(tail) || SPECIAL.test(tail)) tags.push(tail);
  }
  return tags.map((t) => t.trim()).filter(Boolean);
}

const titleCase = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

/**
 * Reads the edit a file is from its title tag or file name. Only brackets
 * and dash suffixes are considered, so a song *called* "Radio" or "Intro" is
 * not mistaken for a version.
 */
export function versionInfo(name: string): VersionInfo {
  let kind: VersionKind = "plain";
  let explicit: VersionInfo["explicit"] = null;
  let remix = "";
  const labels: string[] = [];
  for (const raw of versionTags(name)) {
    const t = plainText(raw);
    if (!t || /^(feat|ft|featuring|prod|with)\b/.test(t) || /^\d+$/.test(t)) continue;
    if (/\b(clean|radio safe|censored)\b/.test(t)) explicit = "clean";
    if (/\b(dirty|explicit|uncensored)\b/.test(t)) explicit = "dirty";
    const isVersion = SPECIAL.test(t) || EXTENDED.test(t) || RADIO.test(t) || PLAIN.test(t) || ANY_VERSION.test(t);
    if (!isVersion) continue;
    labels.push(titleCase(t));
    if (SPECIAL.test(t)) kind = "special";
    else if (EXTENDED.test(t) && kind !== "special") kind = "extended";
    else if (RADIO.test(t) && kind === "plain") kind = "radio";
    // "Joe Smith Remix" / "Joe Smith Extended Remix": who remixed it, with the
    // length words taken out so the radio and extended cut of one remix agree.
    if (/\b(remix|mix|rework)\b/.test(t)) {
      const who = t.replace(LENGTH_WORDS, " ").replace(/\s+/g, " ").trim();
      if (who) remix = who;
    }
  }
  return { kind, label: labels.join(" · "), explicit, remix };
}

const mmss = (secs: number) => `${Math.floor(secs / 60)}:${String(Math.round(secs % 60)).padStart(2, "0")}`;

/** A shorter cut has to be this much shorter before it is called a radio edit of the keeper. */
const SHORTER_BY_SECS = 20;

export interface AlternateSuggestion {
  /** Per-path suggestion; files the rule has no opinion on are absent. */
  states: Record<string, "keep" | "remove">;
  /** Why, per path (tooltip text). */
  reasons: Record<string, string>;
}

/** The version a file is: its title tag when that carries one, else its file name. */
export function fileVersion(path: string, files: Record<string, AudioFile>, tags: Record<string, TagData>): VersionInfo {
  const fromTitle = versionInfo(tags[path]?.title ?? "");
  // The file name often still carries the version after the title tag was cleaned.
  return fromTitle.label ? fromTitle : versionInfo(files[path]?.filename ?? path.split(/[\\/]/).pop() ?? path);
}

/**
 * "Keep the extended version" for an alternate-versions group: within each
 * set of files that are the same mix (same remixer, same clean/dirty), the
 * longest extended-or-untagged cut is kept and clearly shorter radio edits
 * are suggested for removal. Instrumentals, acapellas, intro edits and other
 * remixes are never touched, and nothing is suggested when lengths are
 * unknown. This only ever proposes; the owner still clicks.
 */
export function suggestAlternates(
  paths: string[],
  files: Record<string, AudioFile>,
  tags: Record<string, TagData>,
): AlternateSuggestion {
  const out: AlternateSuggestion = { states: {}, reasons: {} };
  const info = (p: string) => fileVersion(p, files, tags);
  const secs = (p: string) => files[p]?.durationSecs ?? 0;
  const buckets = new Map<string, string[]>();
  for (const p of paths) {
    const v = info(p);
    if (v.kind === "special" || !secs(p)) continue;
    const key = `${v.remix}|${v.explicit ?? ""}`;
    buckets.set(key, [...(buckets.get(key) ?? []), p]);
  }
  for (const members of buckets.values()) {
    if (members.length < 2) continue;
    const longest = Math.max(...members.map(secs));
    // Several copies of the long cut: keep the best file among them.
    const longCuts = members.filter((p) => longest - secs(p) < 2 && info(p).kind !== "radio");
    if (!longCuts.length) continue;
    const keeper = suggestKeeper(longCuts, files, tags);
    const keeperKind = info(keeper).kind;
    const removable = members.filter((p) => {
      if (p === keeper || longest - secs(p) < SHORTER_BY_SECS) return false;
      const k = info(p).kind;
      // An untagged shorter file is only called the radio cut when the keeper
      // says "extended" outright; two untagged files of different lengths
      // could be anything.
      return k === "radio" || (k === "plain" && keeperKind === "extended");
    });
    if (!removable.length) continue;
    const keeperLabel = info(keeper).label;
    out.states[keeper] = "keep";
    out.reasons[keeper] = `longest version (${mmss(secs(keeper))})${keeperLabel ? `, ${keeperLabel}` : ""}`;
    for (const p of removable) {
      out.states[p] = "remove";
      out.reasons[p] = `shorter edit (${mmss(secs(p))}) of the kept ${mmss(secs(keeper))} version`;
    }
  }
  return out;
}
