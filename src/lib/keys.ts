import type { KeyNotation } from "../types";

/**
 * Musical key conversion for the Key column.
 *
 * Three spellings of the same 24 keys are in the wild:
 *  - Camelot (Mixed In Key, Rekordbox's default): "8A" = A minor, "8B" = C major
 *  - Open Key (Traktor): "1m" = A minor, "1d" = C major
 *  - Musical names: "Am", "F#m", "Bb", "C", also "A minor" / "C maj"
 *
 * Everything is parsed to a Camelot number (1-12) + letter (A minor, B major).
 * Open Key's number is the Camelot number rotated by 7: Camelot 8 = Open Key 1.
 */

export interface ParsedKey {
  /** Camelot wheel position, 1-12. */
  num: number;
  /** "A" = minor, "B" = major. */
  mode: "A" | "B";
}

// Pitch class (0 = C) of each tonic, flats and sharps.
const PITCH: Record<string, number> = {
  C: 0, "B#": 0,
  "C#": 1, Db: 1,
  D: 2,
  "D#": 3, Eb: 3,
  E: 4, Fb: 4,
  F: 5, "E#": 5,
  "F#": 6, Gb: 6,
  G: 7,
  "G#": 8, Ab: 8,
  A: 9,
  "A#": 10, Bb: 10,
  B: 11, Cb: 11,
};

// Camelot number of each major tonic's pitch class (the B ring).
const MAJOR_CAMELOT = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];

function normalizeAccidentals(s: string): string {
  return s.replace(/♯/g, "#").replace(/♭/g, "b");
}

export function parseKey(raw: string | undefined | null): ParsedKey | null {
  if (!raw) return null;
  const s = normalizeAccidentals(raw.trim());
  if (!s) return null;

  const camelot = /^0?(\d{1,2})\s*([ABab])$/.exec(s);
  if (camelot) {
    const num = Number(camelot[1]);
    if (num < 1 || num > 12) return null;
    return { num, mode: camelot[2].toUpperCase() as "A" | "B" };
  }

  // Open Key: 1d-12d (major) / 1m-12m (minor). Distinguished from Camelot by
  // the letter, so "8d" can never be mistaken for anything else.
  const open = /^0?(\d{1,2})\s*([dDmM])$/.exec(s);
  if (open) {
    const n = Number(open[1]);
    if (n < 1 || n > 12) return null;
    return { num: ((n + 6) % 12) + 1, mode: open[2].toLowerCase() === "m" ? "A" : "B" };
  }

  const musical = /^([A-Ga-g])([#b]?)\s*(m|min|minor|maj|major|M)?$/.exec(s);
  if (!musical) return null;
  const tonic = musical[1].toUpperCase() + musical[2];
  const pitch = PITCH[tonic];
  if (pitch === undefined) return null;
  const suffix = musical[3] ?? "";
  // A bare "m"/"min"/"minor" is minor; a capital "M", "maj", "major" or no
  // suffix is major. Case matters for the single letter ("Am" vs "AM").
  const minor = suffix === "m" || suffix === "min" || suffix === "minor";
  if (!minor) return { num: MAJOR_CAMELOT[pitch], mode: "B" };
  // A minor shares its Camelot number with its relative major (3 semitones up).
  return { num: MAJOR_CAMELOT[(pitch + 3) % 12], mode: "A" };
}

export function toCamelot(k: ParsedKey): string {
  return `${k.num}${k.mode}`;
}

export function toOpenKey(k: ParsedKey): string {
  const n = ((k.num + 4) % 12) + 1; // Camelot 8 -> Open Key 1
  return `${n}${k.mode === "A" ? "m" : "d"}`;
}

/**
 * The key as the Key column should show it. "stored" (and anything that does
 * not parse as a key) is returned untouched, so a value in a notation we
 * don't know is never mangled or hidden.
 */
export function formatKey(raw: string | undefined | null, notation: KeyNotation): string {
  if (!raw) return "";
  if (notation === "stored") return raw;
  const parsed = parseKey(raw);
  if (!parsed) return raw;
  return notation === "camelot" ? toCamelot(parsed) : toOpenKey(parsed);
}

/** True when two spellings name the same key; unparseable values compare as text. */
export function sameKey(a: string | undefined | null, b: string | undefined | null): boolean {
  const pa = parseKey(a);
  const pb = parseKey(b);
  if (pa && pb) return pa.num === pb.num && pa.mode === pb.mode;
  return (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
}
