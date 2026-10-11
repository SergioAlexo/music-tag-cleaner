/**
 * Smart-playlist rules: one model for every source, evaluated locally.
 *
 * A rule set is `match: all|any` over `{field, op, value}` rules. It is
 * evaluated over plain track rows (`RuleTrack`), which `dj_load` produces for
 * Rekordbox, Mixxx and the Music Tag Cleaner index alike, so one
 * implementation answers "what is in this smart playlist" everywhere.
 *
 * Rekordbox smart lists (`djmdPlaylist.SmartList` XML) convert to and from
 * this model; anything we can't express (e.g. `myTag`) is carried as an
 * `unsupported` rule so the UI can say so instead of silently dropping it.
 */
import { parseKey, sameKey } from "./keys";
import { normalizeLanguageCode } from "./language";

export type RuleField =
  | "genre"
  | "album"
  | "artist"
  | "title"
  | "bpm"
  | "key"
  | "rating"
  | "year"
  | "language"
  | "dateAdded"
  | "comment";

export type RuleOp =
  | "is"
  | "isNot"
  | "contains"
  | "notContains"
  | "startsWith"
  | "endsWith"
  | "gt"
  | "lt"
  | "between"
  | "inLast" // dateAdded: within the last N days
  | "compatible" // key: harmonically compatible (Camelot)
  | "empty"
  | "notEmpty";

export interface Rule {
  field: RuleField;
  op: RuleOp;
  value: string;
  /** Upper bound for `between`. */
  value2?: string;
}

/** A rule we read but can't evaluate; kept so it round-trips and is shown. */
export interface UnsupportedRule {
  unsupported: true;
  /** Human text, e.g. `myTag contains -160068167`. */
  label: string;
  raw?: string;
}

export interface RuleSet {
  match: "all" | "any";
  rules: Rule[];
  unsupported?: UnsupportedRule[];
}

export interface RuleTrack {
  title: string;
  artist: string;
  album: string;
  genre: string;
  key: string;
  bpm: number;
  rating: number;
  year: string;
  comment: string;
  dateAdded: string;
  language: string;
}

export type FieldKind = "text" | "number" | "key" | "date" | "language";

export const FIELDS: { field: RuleField; label: string; kind: FieldKind }[] = [
  { field: "genre", label: "Genre", kind: "text" },
  { field: "artist", label: "Artist", kind: "text" },
  { field: "album", label: "Album", kind: "text" },
  { field: "title", label: "Title", kind: "text" },
  { field: "bpm", label: "BPM", kind: "number" },
  { field: "key", label: "Key", kind: "key" },
  { field: "rating", label: "Rating (stars)", kind: "number" },
  { field: "year", label: "Year", kind: "number" },
  { field: "language", label: "Language", kind: "language" },
  { field: "dateAdded", label: "Date added", kind: "date" },
  { field: "comment", label: "Comment", kind: "text" },
];

export function fieldKind(field: RuleField): FieldKind {
  return FIELDS.find((f) => f.field === field)?.kind ?? "text";
}

export const OP_LABELS: Record<RuleOp, string> = {
  is: "is",
  isNot: "is not",
  contains: "contains",
  notContains: "doesn't contain",
  startsWith: "starts with",
  endsWith: "ends with",
  gt: "is more than",
  lt: "is less than",
  between: "is between",
  inLast: "in the last (days)",
  compatible: "is compatible with",
  empty: "is empty",
  notEmpty: "is not empty",
};

export function opsFor(kind: FieldKind): RuleOp[] {
  switch (kind) {
    case "number":
      return ["is", "isNot", "gt", "lt", "between"];
    case "key":
      return ["is", "isNot", "compatible", "empty", "notEmpty"];
    case "date":
      return ["inLast", "gt", "lt"];
    case "language":
      return ["is", "isNot", "empty", "notEmpty"];
    default:
      return ["is", "isNot", "contains", "notContains", "startsWith", "endsWith", "empty", "notEmpty"];
  }
}

// --- evaluation -----------------------------------------------------------

/** Case- and accent-insensitive text, so "Café" matches "cafe". */
function fold(s: string): string {
  return (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * Keys that mix cleanly with `key` on the Camelot wheel: the same key, one
 * step either way around the wheel, and the relative major/minor (same number,
 * other letter). Returned as Camelot strings ("8A").
 */
export function compatibleKeys(key: string): string[] {
  const k = parseKey(key);
  if (!k) return [];
  const wrap = (n: number) => ((n - 1 + 12) % 12) + 1;
  const other = k.mode === "A" ? "B" : "A";
  return [`${k.num}${k.mode}`, `${wrap(k.num + 1)}${k.mode}`, `${wrap(k.num - 1)}${k.mode}`, `${k.num}${other}`];
}

function num(s: string | undefined): number | null {
  if (s === undefined || s.trim() === "") return null;
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function dateValue(s: string): number | null {
  if (!s) return null;
  const t = Date.parse(s.length === 10 ? `${s}T00:00:00` : s.replace(" ", "T"));
  return Number.isFinite(t) ? t : null;
}

function textValue(t: RuleTrack, field: RuleField): string {
  switch (field) {
    case "genre": return t.genre;
    case "artist": return t.artist;
    case "album": return t.album;
    case "title": return t.title;
    case "comment": return t.comment;
    case "key": return t.key;
    case "year": return t.year;
    case "language": return t.language;
    case "dateAdded": return t.dateAdded;
    default: return "";
  }
}

export function ruleMatches(rule: Rule, t: RuleTrack, now = Date.now()): boolean {
  const kind = fieldKind(rule.field);
  const raw = textValue(t, rule.field);

  const present = rule.field === "bpm" ? t.bpm > 0 : rule.field === "rating" ? t.rating > 0 : fold(raw) !== "";
  if (rule.op === "empty") return !present;
  if (rule.op === "notEmpty") return present;

  if (kind === "number") {
    const v = rule.field === "bpm" ? t.bpm : rule.field === "rating" ? t.rating : num(t.year);
    const a = num(rule.value);
    if (v === null || a === null) return false;
    // BPM is analysed to fractions; "is 128" must find 127.99 and 128.2.
    const tol = rule.field === "bpm" ? 0.5 : 0;
    switch (rule.op) {
      case "is": return Math.abs(v - a) <= tol;
      case "isNot": return Math.abs(v - a) > tol;
      case "gt": return v > a;
      case "lt": return v < a;
      case "between": {
        const b = num(rule.value2);
        if (b === null) return false;
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        return v >= lo - tol && v <= hi + tol;
      }
      default: return false;
    }
  }

  if (kind === "key") {
    if (rule.op === "compatible") {
      const set = compatibleKeys(rule.value);
      const k = parseKey(raw);
      return !!k && set.includes(`${k.num}${k.mode}`);
    }
    if (rule.op === "is") return !!raw && sameKey(raw, rule.value);
    if (rule.op === "isNot") return !sameKey(raw, rule.value);
    return false;
  }

  if (kind === "date") {
    const d = dateValue(raw);
    if (d === null) return false;
    if (rule.op === "inLast") {
      const days = num(rule.value);
      return days !== null && d >= now - days * 86_400_000;
    }
    const cmp = dateValue(rule.value);
    if (cmp === null) return false;
    return rule.op === "gt" ? d > cmp : rule.op === "lt" ? d < cmp : false;
  }

  if (kind === "language") {
    // "es", "spa" and "Spanish" are the same language.
    const a = normalizeLanguageCode(raw) ?? fold(raw);
    const b = normalizeLanguageCode(rule.value) ?? fold(rule.value);
    if (rule.op === "is") return !!a && a === b;
    if (rule.op === "isNot") return a !== b;
    return false;
  }

  const hay = fold(raw);
  const needle = fold(rule.value);
  switch (rule.op) {
    case "is": return hay === needle;
    case "isNot": return hay !== needle;
    case "contains": return needle !== "" && hay.includes(needle);
    case "notContains": return !hay.includes(needle);
    case "startsWith": return hay.startsWith(needle);
    case "endsWith": return hay.endsWith(needle);
    default: return false;
  }
}

export function matchesRuleSet(set: RuleSet, t: RuleTrack, now = Date.now()): boolean {
  if (set.rules.length === 0) return false;
  return set.match === "all" ? set.rules.every((r) => ruleMatches(r, t, now)) : set.rules.some((r) => ruleMatches(r, t, now));
}

/** Every matching track, in library order. */
export function evaluateRuleSet<T extends RuleTrack>(set: RuleSet, tracks: T[], now = Date.now()): T[] {
  // A set whose only content is unsupported rules can't be evaluated honestly.
  if (set.rules.length === 0) return [];
  return tracks.filter((t) => matchesRuleSet(set, t, now));
}

export function emptyRuleSet(): RuleSet {
  return { match: "all", rules: [{ field: "genre", op: "is", value: "" }] };
}

export function describeRule(r: Rule): string {
  const f = FIELDS.find((x) => x.field === r.field)?.label ?? r.field;
  if (r.op === "empty" || r.op === "notEmpty") return `${f} ${OP_LABELS[r.op]}`;
  if (r.op === "between") return `${f} ${OP_LABELS.between} ${r.value} and ${r.value2 ?? ""}`;
  return `${f} ${OP_LABELS[r.op]} ${r.value}`;
}

export function describeRuleSet(s: RuleSet): string {
  const parts = [...s.rules.map(describeRule), ...(s.unsupported ?? []).map((u) => `[unsupported: ${u.label}]`)];
  return parts.join(s.match === "all" ? " AND " : " OR ");
}

export function parseRuleSet(json: string | null | undefined): RuleSet | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as RuleSet;
    if (v && (v.match === "all" || v.match === "any") && Array.isArray(v.rules)) return v;
  } catch {
    /* fall through */
  }
  return null;
}

// --- Rekordbox smart list XML --------------------------------------------

// Operator numbers per pyrekordbox's smartlist.py. Only the text operators
// (1, 2, 8, 9) were seen in the owner's real master.db; the rest is from the
// library and is UNVERIFIED on Rekordbox 7.2.19.
const RB_TEXT_OPS: Record<number, RuleOp> = { 1: "is", 2: "isNot", 8: "contains", 9: "notContains", 10: "startsWith", 11: "endsWith" };
const RB_NUM_OPS: Record<number, RuleOp> = { 1: "is", 2: "isNot", 3: "gt", 4: "lt", 5: "between" };
const RB_PROPS: Record<string, RuleField> = {
  genre: "genre",
  artist: "artist",
  album: "album",
  name: "title",
  bpm: "bpm",
  key: "key",
  rating: "rating",
  year: "year",
  comments: "comment",
  stockDate: "dateAdded",
};

function xmlAttr(s: string, name: string): string {
  // Attribute values are XML-escaped; the names are ours so a regex is safe.
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(s);
  return m ? unescapeXml(m[1]) : "";
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&");
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Rekordbox smart-list XML -> rule set. `null` when the XML has no NODE. */
export function parseRekordboxSmartList(xml: string | null | undefined): RuleSet | null {
  if (!xml) return null;
  const node = /<NODE\b([^>]*)>/.exec(xml);
  if (!node) return null;
  const logical = xmlAttr(node[1], "LogicalOperator");
  const set: RuleSet = { match: logical === "2" ? "any" : "all", rules: [], unsupported: [] };
  const re = /<CONDITION\b([^>]*?)\/?>/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const prop = xmlAttr(m[1], "PropertyName");
    const op = Number(xmlAttr(m[1], "Operator"));
    const left = xmlAttr(m[1], "ValueLeft");
    const right = xmlAttr(m[1], "ValueRight");
    const field = RB_PROPS[prop];
    if (!field) {
      set.unsupported!.push({ unsupported: true, label: `${prop} (operator ${op}) ${left}`.trim(), raw: m[0] });
      continue;
    }
    const kind = fieldKind(field);
    if (kind === "date") {
      if (op === 6) set.rules.push({ field, op: "inLast", value: left });
      else if (op === 3 || op === 4) set.rules.push({ field, op: op === 3 ? "gt" : "lt", value: left });
      else set.unsupported!.push({ unsupported: true, label: `${prop} (operator ${op}) ${left}`, raw: m[0] });
    } else if (kind === "number") {
      const o = RB_NUM_OPS[op];
      if (!o) set.unsupported!.push({ unsupported: true, label: `${prop} (operator ${op}) ${left}`, raw: m[0] });
      else set.rules.push({ field, op: o, value: left, ...(o === "between" ? { value2: right } : {}) });
    } else {
      const o = RB_TEXT_OPS[op];
      if (!o) set.unsupported!.push({ unsupported: true, label: `${prop} (operator ${op}) ${left}`, raw: m[0] });
      else set.rules.push({ field, op: o, value: left });
    }
  }
  if (!set.unsupported!.length) delete set.unsupported;
  return set;
}

const FIELD_TO_RB: Partial<Record<RuleField, string>> = {
  genre: "genre",
  artist: "artist",
  album: "album",
  title: "name",
  bpm: "bpm",
  key: "key",
  rating: "rating",
  year: "year",
  comment: "comments",
  dateAdded: "stockDate",
};

const OP_TO_RB: Partial<Record<RuleOp, number>> = {
  is: 1, isNot: 2, contains: 8, notContains: 9, startsWith: 10, endsWith: 11, gt: 3, lt: 4, between: 5, inLast: 6,
};

/**
 * Rule set -> Rekordbox smart-list XML, or `null` if some rule has no
 * Rekordbox equivalent (language, compatible-key, empty). `playlistId` is the
 * Rekordbox playlist ID; the NODE `Id` is that number wrapped to signed
 * int32 (C0 finding). NOT written anywhere today: direct master.db writing
 * is out of scope (see plans/v0.19/notes/C1.md); this exists so the format is
 * round-trip tested and a future writer only has to store the string.
 */
export function buildRekordboxSmartList(set: RuleSet, playlistId: number): string | null {
  const conds: string[] = [];
  for (const r of set.rules) {
    const prop = FIELD_TO_RB[r.field];
    const op = OP_TO_RB[r.op];
    if (!prop || !op) return null;
    conds.push(
      `<CONDITION PropertyName="${prop}" Operator="${op}" ValueUnit="" ValueLeft="${escapeXml(r.value)}" ValueRight="${escapeXml(r.value2 ?? "")}"/>`,
    );
  }
  for (const u of set.unsupported ?? []) {
    if (!u.raw) return null;
    conds.push(u.raw);
  }
  if (!conds.length) return null;
  const id = playlistId | 0; // wrap to signed int32
  return `<NODE Id="${id}" LogicalOperator="${set.match === "any" ? 2 : 1}" AutomaticUpdate="0">${conds.join("")}</NODE>`;
}
