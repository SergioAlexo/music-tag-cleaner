import type { AudioFile } from "../types";

/** The three tag systems this app writes to, keyed by their lofty container family. */
export type TagFamily = "id3" | "vorbis" | "mp4";

/** File extensions that use each tag family (approximate — enough to pick a sensible default header). */
const FAMILY_BY_EXT: Record<string, TagFamily> = {
  mp3: "id3",
  wav: "id3",
  aiff: "id3",
  aif: "id3",
  flac: "vorbis",
  ogg: "vorbis",
  m4a: "mp4",
  aac: "mp4",
};

export function familyForFormat(format: string): TagFamily {
  return FAMILY_BY_EXT[format.toLowerCase()] ?? "id3";
}

export const TAG_FAMILY_LABELS: Record<TagFamily, string> = {
  id3: "ID3v2",
  vorbis: "Vorbis Comments",
  mp4: "MP4 / iTunes atoms",
};

/**
 * Raw frame/field name per tag family for each curated column. "—" marks a
 * field with no standard equivalent in that family (e.g. the star rating
 * has no Vorbis or MP4 convention, so nothing is displayed as read/written
 * there — only ID3's POPM byte is used).
 */
export const RAW_FIELD_NAMES: Record<string, Record<TagFamily, string>> = {
  title: { id3: "TIT2", vorbis: "TITLE", mp4: "©nam" },
  artist: { id3: "TPE1", vorbis: "ARTIST", mp4: "©ART" },
  album: { id3: "TALB", vorbis: "ALBUM", mp4: "©alb" },
  albumArtist: { id3: "TPE2", vorbis: "ALBUMARTIST", mp4: "aART" },
  trackNumber: { id3: "TRCK", vorbis: "TRACKNUMBER", mp4: "trkn" },
  discNumber: { id3: "TPOS", vorbis: "DISCNUMBER", mp4: "disk" },
  year: { id3: "TDRC", vorbis: "DATE", mp4: "©day" },
  genre: { id3: "TCON", vorbis: "GENRE", mp4: "©gen" },
  comment: { id3: "COMM", vorbis: "COMMENT", mp4: "©cmt" },
  composer: { id3: "TCOM", vorbis: "COMPOSER", mp4: "©wrt" },
  originalArtist: { id3: "TOPE", vorbis: "—", mp4: "—" },
  trackId: { id3: "TXXX:TRACKID", vorbis: "TRACKID", mp4: "----:com.apple.iTunes:TRACKID" },
  rating: { id3: "POPM", vorbis: "—", mp4: "—" },
  language: { id3: "TLAN", vorbis: "LANGUAGE", mp4: "----:com.apple.iTunes:LANGUAGE" },
};

/** Most common tag family among the loaded files — used to pick one raw name per column header. */
export function dominantFamily(files: AudioFile[]): TagFamily {
  const counts: Record<TagFamily, number> = { id3: 0, vorbis: 0, mp4: 0 };
  for (const f of files) counts[familyForFormat(f.format)]++;
  return (Object.keys(counts) as TagFamily[]).reduce(
    (best, fam) => (counts[fam] > counts[best] ? fam : best),
    "id3" as TagFamily,
  );
}

/**
 * A header label for a curated column under the given naming mode.
 * `raw`/`both` use the collection's dominant tag family — the caller should
 * pair this with `rawNameTooltip` so a mixed collection still shows every
 * family's name somewhere.
 */
export function fieldHeaderLabel(
  friendlyLabel: string,
  fieldKey: string,
  mode: "friendly" | "raw" | "both",
  family: TagFamily,
): string {
  if (mode === "friendly") return friendlyLabel;
  const raw = RAW_FIELD_NAMES[fieldKey]?.[family];
  if (!raw || raw === "—") return friendlyLabel;
  return mode === "raw" ? raw : `${friendlyLabel} (${raw})`;
}

/** Tooltip text listing every tag family's raw name for a curated field. */
export function rawNameTooltip(friendlyLabel: string, fieldKey: string): string | undefined {
  const names = RAW_FIELD_NAMES[fieldKey];
  if (!names) return undefined;
  const parts = (Object.keys(TAG_FAMILY_LABELS) as TagFamily[])
    .filter((fam) => names[fam] !== "—")
    .map((fam) => `${TAG_FAMILY_LABELS[fam]}: ${names[fam]}`);
  if (!parts.length) return undefined;
  return `${friendlyLabel} — ${parts.join(" · ")}`;
}
