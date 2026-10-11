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
    return a.localeCompare(b);
  })[0];
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