import type { AudioFile, PendingChange, TagData } from "../types";
import { basename } from "../types";

/**
 * The Language field: ID3 `TLAN` / Vorbis `LANGUAGE`, holding an ISO 639-2
 * code. Codes are the 639-2/T spelling (`fra`, `deu`, `spa`), which is also
 * what the offline detector (whatlang) returns, so a detected value and a
 * hand-picked one are the same string. The bibliographic spellings other
 * taggers write (`fre`, `ger`) and two-letter codes (`es`) are understood on
 * the way in and shown as names.
 */

export interface Language {
  /** ISO 639-2/T (= 639-3 for these). */
  code: string;
  /** ISO 639-1, when there is one. */
  iso1?: string;
  name: string;
}

/** No linguistic content: an instrumental. Kept out of "which language" lists on purpose. */
export const INSTRUMENTAL = "zxx";

/** Common languages first (a DJ's usual pool), then the rest alphabetically. */
export const LANGUAGES: Language[] = [
  { code: "eng", iso1: "en", name: "English" },
  { code: "spa", iso1: "es", name: "Spanish" },
  { code: "fra", iso1: "fr", name: "French" },
  { code: "por", iso1: "pt", name: "Portuguese" },
  { code: "ita", iso1: "it", name: "Italian" },
  { code: "deu", iso1: "de", name: "German" },
  { code: "rus", iso1: "ru", name: "Russian" },
  { code: "ukr", iso1: "uk", name: "Ukrainian" },
  { code: "nld", iso1: "nl", name: "Dutch" },
  { code: "pol", iso1: "pl", name: "Polish" },
  { code: "jpn", iso1: "ja", name: "Japanese" },
  { code: "kor", iso1: "ko", name: "Korean" },
  { code: "zho", iso1: "zh", name: "Chinese" },
  { code: "ara", iso1: "ar", name: "Arabic" },
  { code: "hin", iso1: "hi", name: "Hindi" },
  { code: "tur", iso1: "tr", name: "Turkish" },
  { code: INSTRUMENTAL, name: "Instrumental (no vocals)" },
  { code: "mul", name: "Multiple languages" },
  { code: "afr", iso1: "af", name: "Afrikaans" },
  { code: "sqi", iso1: "sq", name: "Albanian" },
  { code: "hye", iso1: "hy", name: "Armenian" },
  { code: "aze", iso1: "az", name: "Azerbaijani" },
  { code: "eus", iso1: "eu", name: "Basque" },
  { code: "bel", iso1: "be", name: "Belarusian" },
  { code: "ben", iso1: "bn", name: "Bengali" },
  { code: "bul", iso1: "bg", name: "Bulgarian" },
  { code: "cat", iso1: "ca", name: "Catalan" },
  { code: "hrv", iso1: "hr", name: "Croatian" },
  { code: "ces", iso1: "cs", name: "Czech" },
  { code: "dan", iso1: "da", name: "Danish" },
  { code: "est", iso1: "et", name: "Estonian" },
  { code: "fin", iso1: "fi", name: "Finnish" },
  { code: "kat", iso1: "ka", name: "Georgian" },
  { code: "ell", iso1: "el", name: "Greek" },
  { code: "hat", iso1: "ht", name: "Haitian Creole" },
  { code: "heb", iso1: "he", name: "Hebrew" },
  { code: "hun", iso1: "hu", name: "Hungarian" },
  { code: "isl", iso1: "is", name: "Icelandic" },
  { code: "ind", iso1: "id", name: "Indonesian" },
  { code: "gle", iso1: "ga", name: "Irish" },
  { code: "lat", iso1: "la", name: "Latin" },
  { code: "lav", iso1: "lv", name: "Latvian" },
  { code: "lit", iso1: "lt", name: "Lithuanian" },
  { code: "mkd", iso1: "mk", name: "Macedonian" },
  { code: "msa", iso1: "ms", name: "Malay" },
  { code: "nor", iso1: "no", name: "Norwegian" },
  { code: "fas", iso1: "fa", name: "Persian" },
  { code: "pan", iso1: "pa", name: "Punjabi" },
  { code: "ron", iso1: "ro", name: "Romanian" },
  { code: "srp", iso1: "sr", name: "Serbian" },
  { code: "slk", iso1: "sk", name: "Slovak" },
  { code: "slv", iso1: "sl", name: "Slovenian" },
  { code: "swa", iso1: "sw", name: "Swahili" },
  { code: "swe", iso1: "sv", name: "Swedish" },
  { code: "tgl", iso1: "tl", name: "Tagalog" },
  { code: "tam", iso1: "ta", name: "Tamil" },
  { code: "tha", iso1: "th", name: "Thai" },
  { code: "urd", iso1: "ur", name: "Urdu" },
  { code: "vie", iso1: "vi", name: "Vietnamese" },
  { code: "cym", iso1: "cy", name: "Welsh" },
  { code: "yor", iso1: "yo", name: "Yoruba" },
  { code: "zul", iso1: "zu", name: "Zulu" },
  { code: "und", name: "Undetermined" },
];

/** ISO 639-2/B spellings (what ID3 tools often write) -> the /T code used here. */
const BIBLIOGRAPHIC: Record<string, string> = {
  fre: "fra",
  ger: "deu",
  dut: "nld",
  chi: "zho",
  gre: "ell",
  cze: "ces",
  rum: "ron",
  slo: "slk",
  per: "fas",
  may: "msa",
  ice: "isl",
  wel: "cym",
  alb: "sqi",
  arm: "hye",
  baq: "eus",
  geo: "kat",
  mac: "mkd",
};

const BY_CODE = new Map(LANGUAGES.map((l) => [l.code, l]));
const BY_ISO1 = new Map(LANGUAGES.filter((l) => l.iso1).map((l) => [l.iso1!, l]));
const BY_NAME = new Map(LANGUAGES.map((l) => [l.name.toLowerCase(), l]));
// Extra spellings people type.
BY_NAME.set("mandarin", BY_CODE.get("zho")!);
BY_NAME.set("castilian", BY_CODE.get("spa")!);
BY_NAME.set("instrumental", BY_CODE.get(INSTRUMENTAL)!);
BY_NAME.set("no linguistic content", BY_CODE.get(INSTRUMENTAL)!);

/**
 * The language a tag value means, or null when it is not recognisable. Accepts
 * a 639-2 code of either spelling, a 639-1 code (with or without a region,
 * `es-MX`), or an English name, in any case.
 */
export function findLanguage(raw: string | undefined | null): Language | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v) return null;
  if (BY_NAME.has(v)) return BY_NAME.get(v)!;
  const base = v.split(/[-_]/)[0];
  if (base.length === 2) return BY_ISO1.get(base) ?? null;
  if (base.length === 3) return BY_CODE.get(BIBLIOGRAPHIC[base] ?? base) ?? null;
  return null;
}

/** The code to store for a typed/stored value; null if it is not a known language. */
export function normalizeLanguageCode(raw: string | undefined | null): string | null {
  return findLanguage(raw)?.code ?? null;
}

/** "Spanish" for `spa`/`es`/`Spanish`; an unrecognised value is shown as written. */
export function languageName(raw: string | undefined | null): string {
  const l = findLanguage(raw);
  return l ? l.name : (raw ?? "").trim();
}

/** Same language, whatever the spelling. Two unknowns compare as text. */
export function sameLanguage(a: string | undefined | null, b: string | undefined | null): boolean {
  const la = findLanguage(a);
  const lb = findLanguage(b);
  if (la && lb) return la.code === lb.code;
  return (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
}

/** Combobox entries: "Spanish (spa, es)", so typing the name, the code or the two-letter code all narrow the list. */
export const LANGUAGE_OPTIONS: string[] = LANGUAGES.map(
  (l) => `${l.name} (${l.code}${l.iso1 ? `, ${l.iso1}` : ""})`,
);

/** The value to store for a Combobox pick or a typed entry (blank clears the field). */
export function languageFromOption(entry: string): string {
  const v = entry.trim();
  if (!v) return "";
  const m = /\(([a-z]{3})(?:,[^)]*)?\)\s*$/.exec(v);
  return m ? m[1] : (normalizeLanguageCode(v) ?? v);
}

/** Languages matching a type-ahead query: name or code prefix first, then substring. */
export function searchLanguages(query: string, limit = 12): Language[] {
  const q = query.trim().toLowerCase();
  if (!q) return LANGUAGES.slice(0, limit);
  const starts: Language[] = [];
  const contains: Language[] = [];
  for (const l of LANGUAGES) {
    const name = l.name.toLowerCase();
    if (name.startsWith(q) || l.code.startsWith(q) || l.iso1 === q) starts.push(l);
    else if (name.includes(q)) contains.push(l);
  }
  return [...starts, ...contains].slice(0, limit);
}

// --- Rekordbox-visible copy --------------------------------------------------

/** `#lang-es`: the searchable form for programs that cannot see TLAN. */
export function langHashtag(code: string): string | null {
  const l = findLanguage(code);
  return l ? `#lang-${l.iso1 ?? l.code}` : null;
}

const LANG_TAG = /(^|\s)#lang-[a-z]{2,3}(?=\s|$)/gi;

/**
 * Puts the language hashtag into a comment: appended after a space, replacing
 * an earlier `#lang-xx` rather than stacking a second one. The rest of the
 * comment is untouched.
 */
export function withLangHashtag(comment: string | undefined | null, code: string): string {
  const tag = langHashtag(code);
  const base = (comment ?? "").trim();
  if (!tag) return base;
  const stripped = base.replace(LANG_TAG, "$1").replace(/\s{2,}/g, " ").trim();
  return stripped ? `${stripped} ${tag}` : tag;
}

// --- Suggestions --------------------------------------------------------------

/** One entry of `detect_languages` (src-tauri/src/commands/lyrics.rs). */
export interface LangSuggestion {
  path: string;
  code: string | null;
  confidence: number;
  level: "high" | "low" | null;
  source: "lyrics" | "instrumental" | "title";
  error: string | null;
}

export const SOURCE_NOTE: Record<LangSuggestion["source"], string> = {
  lyrics: "detected from the lyrics",
  instrumental: "LRCLIB says it is instrumental",
  title: "guessed from the title and artist (low confidence)",
};

/**
 * Preview rows for the detected languages. Never written silently: the user
 * applies them from the usual preview table.
 *
 * - A high-confidence suggestion for a track with no language is ticked.
 * - Low-confidence guesses, and suggestions that would replace a language
 *   already in the file, are listed but unticked.
 * - With `appendComment`, a matching `#lang-xx` Comment row follows each
 *   language row (same tick state), because Rekordbox cannot show TLAN.
 */
export function buildLanguagePreview(
  files: AudioFile[],
  tags: Record<string, TagData>,
  suggestions: LangSuggestion[],
  opts: { appendComment: boolean },
): PendingChange[] {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const rows: PendingChange[] = [];
  for (const s of suggestions) {
    if (!s.code) continue;
    const f = byPath.get(s.path);
    const t = tags[s.path];
    if (!f || !t) continue;
    const before = (t.language ?? "").trim();
    const hasOther = !!before && !sameLanguage(before, s.code);
    const include = s.level === "high" && !hasOther;
    const filename = f.filename || basename(f.path);
    const note = `${SOURCE_NOTE[s.source]}${hasOther ? `; replaces "${before}"` : ""}`;
    // A same-language value in another spelling (`es`, `fre`) is rewritten as the canonical code.
    if (before.toLowerCase() !== s.code) {
      rows.push({
        id: `${s.path}::lang::language`,
        path: s.path,
        filename,
        field: "language",
        before,
        after: s.code,
        include,
        changed: true,
        kind: "update",
        note,
      });
    }
    if (opts.appendComment) {
      const after = withLangHashtag(t.comment, s.code);
      if (after !== (t.comment ?? "").trim()) {
        rows.push({
          id: `${s.path}::lang::comment`,
          path: s.path,
          filename,
          field: "comment",
          before: t.comment ?? "",
          after,
          include,
          changed: true,
          kind: "update",
          note: "language hashtag for Rekordbox / Serato / Traktor search",
        });
      }
    }
  }
  return rows;
}
