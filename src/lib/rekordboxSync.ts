import type { AudioFile, PendingChange, TagData } from "../types";
import { basename } from "../types";
import { sameKey } from "./keys";

/**
 * BPM / Key / Rating shown in the table and written back into tags from a
 * Rekordbox collection export.
 *
 * Source priority per field: the file's own tag first, Rekordbox when the tag
 * is empty. Rekordbox's value is flagged (an "RB" marker in the cell) when it
 * is the one being shown, or when it is shown alongside a different tag value.
 */

/** Containers whose tempo tag takes a decimal (Vorbis `BPM`); the rest hold an integer (ID3v2 TBPM, MP4 tmpo). */
const DECIMAL_BPM_FORMATS = new Set(["flac", "ogg", "opus"]);

/** A BPM as it should be written into a file of `format`. */
export function bpmForFormat(bpm: number, format: string): string {
  if (DECIMAL_BPM_FORMATS.has(format.toLowerCase())) return String(Math.round(bpm * 100) / 100);
  return String(Math.round(bpm));
}

function sameBpm(tag: string | undefined, rb: number, format: string): boolean {
  const t = parseFloat(tag ?? "");
  if (Number.isNaN(t)) return false;
  return DECIMAL_BPM_FORMATS.has(format.toLowerCase())
    ? Math.abs(t - rb) < 0.01
    : Math.round(t) === Math.round(rb);
}

export interface RekordboxCell {
  /** What the cell shows. */
  text: string;
  /** True when the value (or a differing alternative) comes from Rekordbox. */
  fromRekordbox: boolean;
  /** Tooltip detail for the marker. */
  note: string;
}

export function bpmCell(f: AudioFile, t?: TagData): RekordboxCell {
  const tag = t?.bpm?.trim() ?? "";
  const rb = f.bpm;
  if (!tag) {
    return rb != null
      ? { text: String(Math.round(rb)), fromRekordbox: true, note: `From Rekordbox (${rb}); the file has no BPM tag` }
      : { text: "", fromRekordbox: false, note: "" };
  }
  if (rb != null && !sameBpm(tag, rb, f.format)) {
    return { text: tag, fromRekordbox: true, note: `Rekordbox has ${rb}; the file tag says ${tag}` };
  }
  return { text: tag, fromRekordbox: false, note: "" };
}

export function keyCell(f: AudioFile, t?: TagData): RekordboxCell {
  const tag = t?.key?.trim() ?? "";
  const rb = f.key;
  if (!tag) {
    return rb
      ? { text: rb, fromRekordbox: true, note: `From Rekordbox (${rb}); the file has no key tag` }
      : { text: "", fromRekordbox: false, note: "" };
  }
  if (rb && !sameKey(tag, rb)) {
    return { text: tag, fromRekordbox: true, note: `Rekordbox has ${rb}; the file tag says ${tag}` };
  }
  return { text: tag, fromRekordbox: false, note: "" };
}

/** Stars to show: the tag's rating, else Rekordbox's. */
export function ratingCell(f: AudioFile, t?: TagData): { stars: number; fromRekordbox: boolean } {
  const tag = t?.rating ?? 0;
  if (tag > 0) return { stars: tag, fromRekordbox: false };
  const rb = f.rbRating ?? 0;
  return { stars: rb, fromRekordbox: rb > 0 };
}

/**
 * Preview rows for "Write Rekordbox BPM/Key/Rating into tags": one row per
 * field whose Rekordbox value is missing from, or different to, the file's
 * tag. Files Rekordbox knows nothing about produce no rows.
 */
export function buildRekordboxSyncPreview(
  files: AudioFile[],
  tags: Record<string, TagData>,
): PendingChange[] {
  const rows: PendingChange[] = [];
  const push = (f: AudioFile, field: string, before: string, after: string) =>
    rows.push({
      id: `${f.path}::rb-sync::${field}`,
      path: f.path,
      filename: f.filename || basename(f.path),
      field,
      before,
      after,
      include: true,
      changed: true,
      kind: "update",
    });

  for (const f of files) {
    const t = tags[f.path];
    if (!t) continue;
    if (f.bpm != null && f.bpm > 0 && !sameBpm(t.bpm, f.bpm, f.format)) {
      push(f, "bpm", t.bpm ?? "", bpmForFormat(f.bpm, f.format));
    }
    if (f.key && !(t.key && sameKey(t.key, f.key))) {
      push(f, "key", t.key ?? "", f.key);
    }
    const stars = f.rbRating ?? 0;
    if (stars > 0 && stars !== (t.rating ?? 0)) {
      push(f, "rating", String(t.rating ?? 0), String(stars));
    }
  }
  return rows;
}
