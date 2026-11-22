import type { AudioFile, PlaylistEntry, TagData } from "../types";

/**
 * Matches a fetched YouTube Music playlist (see `fetch_ytmusic_playlist`)
 * against the collection. yt-dlp's flat-playlist fetch only reliably gives a
 * title, a duration and a video id — not separate artist/track/album fields,
 * even for videos on an artist's own channel (confirmed empirically against
 * real playlists before writing this) — so matching works from the title
 * text and duration alone, the same way a person would eyeball it.
 *
 * Three things make this better than a plain "best fuzzy score wins":
 *
 * 1. **Every identity a file has is compared, not just its tags.** A track
 *    whose tags were never cleaned still has a filename, and one that *was*
 *    cleaned still carries its pre-clean "stem | | artist | | title | | year"
 *    searchable backup (see `build_searchable_backup` in files.rs) — often
 *    the only place the original YouTube-ish spelling survives.
 * 2. **Mix/version awareness.** "Song (Artist Remix)" and "Song" are
 *    different recordings; edit distance barely notices, so the distinctive
 *    part of a version qualifier is scored separately and can veto a match.
 * 3. **Global one-to-one assignment.** Each library file can back at most one
 *    playlist entry, so two near-identical entries can't both claim it — the
 *    stronger pairing wins and the weaker one falls through to its own next
 *    best candidate.
 */

/** Common video-title clutter that has nothing to do with the track's real
 * name — stripped before splitting/comparing so it doesn't drag the score
 * down. Deliberately conservative: only well-known suffixes, not a general
 * "guess what's noise" heuristic. */
const NOISE_PATTERNS: RegExp[] = [
  /\(\s*official\s*(music\s*)?video\s*\)/gi,
  /\(\s*official\s*(lyric[s]?\s*)?(video|audio)\s*\)/gi,
  /\(\s*lyric[s]?\s*(video)?\s*\)/gi,
  /\(\s*audio\s*\)/gi,
  /\(\s*visualizer\s*\)/gi,
  /\(\s*4k\s*remaster(ed)?\s*\)/gi,
  /\[\s*official\s*(music\s*)?video\s*\]/gi,
  /\[\s*lyric[s]?\s*(video)?\s*\]/gi,
  /\[\s*hd\s*\]/gi,
  /\[\s*4k\s*\]/gi,
];

/**
 * Drops featured-artist credits from a title — "(feat. Ciscaux & Wassup
 * Rocker)", "[ft. X]", a trailing "feat. X" — for the *title* comparison
 * only. YouTube puts every guest in the title while a library file is
 * usually tagged just "Dance", so the guests' names alone dragged a correct
 * match (1nonly "DANCE! (feat. Ciscaux & Wassup Rocker)" vs "Dance") down to
 * 81%, under the auto-accept bar. Guests are an artist-side fact anyway.
 */
export function stripFeaturing(title: string): string {
  return title
    .replace(/[([]\s*(?:feat|ft|featuring|with)\b\.?[^)\]]*[)\]]/gi, " ")
    .replace(/\s(?:feat|ft|featuring)\b\.?\s.*$/i, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripTitleNoise(title: string): string {
  let cleaned = title;
  for (const re of NOISE_PATTERNS) cleaned = cleaned.replace(re, " ");
  return cleaned.replace(/\s+/g, " ").trim();
}

/** Folds a string down for comparison: diacritics stripped (the same NFKD
 * approach the filename sanitizers use), lowercased, punctuation collapsed
 * to spaces, whitespace normalized. */
export function normalizeForMatch(value: string): string {
  const folded = value.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  return folded
    .replace(/\bfeat\.?\b|\bft\.?\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokens(value: string): string[] {
  const n = normalizeForMatch(value);
  return n ? n.split(" ") : [];
}

/** Splits a video title on an "Artist - Title"-style separator, for the
 * *matcher's* internal scoring only — never for display or artist
 * resolution (see `buildWanted`). Requires whitespace around the dash so
 * hyphenated names survive: "Jay-Z", "A-ha - Take On Me", "T-Pain",
 * "Ne-Yo" are never split on the hyphen inside the name. Colon is no longer
 * treated as a separator — it produced too many false splits ("Low (feat.
 * T-Pain)" style titles have no colon, but plenty of real titles do, e.g.
 * "Chapter 1: Intro"). */
export function splitArtistTitle(rawTitle: string): { artist: string | null; title: string } {
  const cleaned = stripTitleNoise(rawTitle);
  const m = cleaned.match(/^(.{1,80}?)\s+[-–—]\s+(.{1,120})$/);
  if (m && m[1].trim() && m[2].trim()) {
    return { artist: m[1].trim(), title: m[2].trim() };
  }
  return { artist: null, title: cleaned };
}

/**
 * Levenshtein distance, but giving up as soon as it provably exceeds `max`.
 *
 * Only cells within `max` of the diagonal can still lead to a distance of
 * `max` or less, so the inner loop walks that band instead of the whole row,
 * and the whole thing bails the moment an entire row is over budget. For the
 * overwhelmingly common case — a playlist entry against a track that has
 * nothing to do with it — this returns after a couple of rows rather than
 * filling a 30x30 table.
 *
 * Returns the exact distance when it is <= `max`, otherwise any value > `max`.
 */
function levenshteinWithin(a: string, b: string, max: number): number {
  const la = a.length;
  const lb = b.length;
  const over = max + 1;
  if (la - lb > max || lb - la > max) return over;
  if (max <= 0) return a === b ? 0 : over;

  let prev = new Array<number>(lb + 1);
  let curr = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j > max ? over : j;

  for (let i = 1; i <= la; i++) {
    const from = i - max > 1 ? i - max : 1;
    const to = i + max < lb ? i + max : lb;
    curr[0] = i > max ? over : i;
    // Everything left of the band is unreachable within budget; the insert
    // term reads curr[j-1], so the cell just before the band must say so.
    if (from > 1) curr[from - 1] = over;
    let rowMin = over;
    const ca = a.charCodeAt(i - 1);
    for (let j = from; j <= to; j++) {
      const sub = prev[j - 1] + (ca === b.charCodeAt(j - 1) ? 0 : 1);
      const del = prev[j] + 1;
      const ins = curr[j - 1] + 1;
      let v = sub < del ? sub : del;
      if (ins < v) v = ins;
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    // Same for everything right of the band, which the next row reads as
    // prev[j] and prev[j-1].
    for (let j = to + 1; j <= lb; j++) curr[j] = over;
    if (rowMin > max) return over;
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[lb];
}

/** Levenshtein edit distance, iterative two-row DP — fine for track-title-length strings. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/**
 * A string reduced, once, to everything the comparators need.
 *
 * Matching a playlist is inherently quadratic — every entry against every
 * track — so the per-pair cost is what decides whether the screen stalls.
 * A 70-entry playlist against a 4,149-track library is ~290k pairs and
 * several comparisons each; re-normalizing and re-tokenizing both strings
 * inside every one of those took ~16 seconds. Each string is now prepared
 * once and the pair comparison works on the result.
 */
export interface Prepared {
  norm: string;
  len: number;
  tokens: string[];
  /** token -> occurrences, for the order-insensitive overlap. */
  counts: Map<string, number>;
  /** Sum of token weights, the denominator of that overlap. */
  weight: number;
  /** Character histogram over `ALPHABET`, for the edit-distance lower bound. */
  chars: Int32Array;
}

/** `normalizeForMatch` output is only ever a-z, 0-9 and single spaces. */
const ALPHABET = 37;

function charBucket(code: number): number {
  if (code >= 97 && code <= 122) return code - 97; // a-z
  if (code >= 48 && code <= 57) return 26 + code - 48; // 0-9
  return 36; // space
}

export function prepare(value: string): Prepared {
  const norm = normalizeForMatch(value);
  const toks = norm ? norm.split(" ") : [];
  const counts = new Map<string, number>();
  let weight = 0;
  for (const t of toks) {
    counts.set(t, (counts.get(t) ?? 0) + 1);
    weight += t.length > 1 ? t.length : 1;
  }
  const chars = new Int32Array(ALPHABET);
  for (let i = 0; i < norm.length; i++) chars[charBucket(norm.charCodeAt(i))]++;
  return { norm, len: norm.length, tokens: toks, counts, weight, chars };
}

/** 0-1 similarity ratio from edit distance, normalized by the longer string's length. */
export function stringSimilarity(a: string, b: string): number {
  const na = normalizeForMatch(a);
  const nb = normalizeForMatch(b);
  if (!na && !nb) return 1;
  if (!na || !nb) return 0;
  const maxLen = Math.max(na.length, nb.length);
  return 1 - levenshtein(na, nb) / maxLen;
}

function preparedTokenSimilarity(a: Prepared, b: Prepared): number {
  if (!a.tokens.length && !b.tokens.length) return 1;
  if (!a.tokens.length || !b.tokens.length) return 0;
  // Walk the smaller token set; the intersection is symmetric either way.
  const small = a.counts.size <= b.counts.size ? a : b;
  const large = small === a ? b : a;
  let inter = 0;
  for (const [t, c] of small.counts) {
    const other = large.counts.get(t);
    if (other !== undefined) inter += (c < other ? c : other) * (t.length > 1 ? t.length : 1);
  }
  if (!inter) return 0;
  const coverA = inter / a.weight;
  const coverB = inter / b.weight;
  return (2 * coverA * coverB) / (coverA + coverB);
}

/**
 * A lower bound on the edit distance, from the character histograms: every
 * character present in one string and not the other costs at least one edit,
 * and a single edit fixes at most one of them.
 */
function levLowerBound(a: Prepared, b: Prepared): number {
  let da = 0;
  let db = 0;
  for (let i = 0; i < ALPHABET; i++) {
    const d = a.chars[i] - b.chars[i];
    if (d > 0) da += d;
    else db -= d;
  }
  return da > db ? da : db;
}

/**
 * Order-insensitive, length-weighted token overlap (an F1 of how much of
 * each side the other covers). Longer tokens count for more, so "Rihanna"
 * agreeing matters far more than "the" agreeing — which is exactly what
 * edit distance gets wrong on "Artist - Title" vs "Title - Artist" and on
 * titles carrying an extra featured artist.
 */
export function tokenSimilarity(a: string, b: string): number {
  return preparedTokenSimilarity(prepare(a), prepare(b));
}

/**
 * Best of edit-distance and token-overlap similarity — they fail on
 * opposite kinds of difference, so taking the better of the two is more
 * stable than either alone or than averaging them.
 *
 * The edit-distance half is the expensive one (an O(n·m) DP), so it is
 * skipped whenever the histogram bound proves it cannot beat the token
 * score that is already in hand. That is a pruning bound, not an
 * approximation: the returned value is identical either way, which
 * `equivalent_to_the_unpruned_definition` checks against a naive
 * implementation.
 */
export function preparedTextSimilarity(a: Prepared, b: Prepared, minUseful = 0): number {
  if (!a.len && !b.len) return 1;
  if (!a.len || !b.len) return 0;
  const tok = preparedTokenSimilarity(a, b);
  const maxLen = a.len > b.len ? a.len : b.len;

  // The histogram bound alone often settles it without touching the DP.
  if (1 - levLowerBound(a, b) / maxLen <= tok) return tok;

  // Two independent reasons the exact distance can stop being interesting:
  // it can no longer beat the token score, or it can no longer reach a score
  // the caller would do anything with. Either one caps how far the DP needs
  // to go, so take the tighter.
  const byToken = Math.ceil((1 - tok) * maxLen);
  const byFloor = Math.floor((1 - minUseful) * maxLen);
  const cutoff = byToken < byFloor ? byToken : byFloor;

  const d = levenshteinWithin(a.norm, b.norm, cutoff);
  if (d > cutoff) return tok; // provably <= tok, or provably below minUseful
  const lev = 1 - d / maxLen;
  return lev > tok ? lev : tok;
}

export function textSimilarity(a: string, b: string): number {
  return preparedTextSimilarity(prepare(a), prepare(b));
}

/** Words that mark a parenthetical as a *version* qualifier rather than part
 * of the track name ("(Tale Of Us Remix)", "(Extended Mix)"). */
const VERSION_WORDS = new Set([
  "remix", "mix", "edit", "extended", "radio", "club", "dub", "instrumental",
  "vip", "bootleg", "live", "acoustic", "remaster", "remastered", "version",
  "original", "rework", "flip", "mashup", "reprise", "cover", "demo", "rmx",
  "cut", "bonus", "unplugged", "intro", "outro",
]);

/** Version words so common they say nothing about *which* version this is —
 * "(Original Mix)" and a bare title are the same recording, so these never
 * make two titles look like different mixes on their own. */
const GENERIC_VERSION_WORDS = new Set([
  "original", "mix", "version", "audio", "edit", "radio", "single", "album",
  "master", "remaster", "remastered", "hd", "hq", "full", "official",
]);

/**
 * The distinctive part of a title's version qualifier — the remixer's name
 * out of "(Tale Of Us Remix)", "extended" out of "(Extended Mix)" — with
 * generic filler dropped. An empty set means "no particular version stated",
 * which is compatible with anything.
 */
export function versionSignature(text: string): Set<string> {
  const out = new Set<string>();
  const groups: string[] = [];
  for (const m of text.matchAll(/[([]([^)\]]{1,60})[)\]]/g)) groups.push(m[1]);
  // "Artist - Title - Someone Remix" states the version after a second dash.
  const tail = text.match(/\s[-–—]\s([^-–—]{1,60})$/);
  if (tail) groups.push(tail[1]);
  for (const g of groups) {
    const words = tokens(g);
    if (!words.some((w) => VERSION_WORDS.has(w))) continue;
    for (const w of words) if (!GENERIC_VERSION_WORDS.has(w)) out.add(w);
  }
  return out;
}

/**
 * Multiplier applied to a text score once both sides' version qualifiers are
 * taken into account. Two different remixes of the same song score ~1.0 on
 * text alone, so this is what actually keeps them apart.
 */
function versionFactor(want: Set<string>, have: Set<string>): number {
  if (!want.size && !have.size) return 1;
  if (!want.size || !have.size) return 0.82; // one names a remix, the other doesn't
  let shared = 0;
  for (const w of want) if (have.has(w)) shared++;
  if (shared === want.size && shared === have.size) return 1;
  if (!shared) return 0.6; // two *different* named versions — almost certainly not the same file
  return 0.6 + 0.4 * (shared / Math.max(want.size, have.size));
}

/** How a candidate's text was obtained — surfaced in the match log so a bad
 * auto-match can be traced back to the field that caused it. */
export type MatchVia = "tags" | "filename" | "backup";

/**
 * Parses the searchable backup string the app writes before its first
 * change — "stem | | artist | | title | | year" (see
 * `build_searchable_backup` in files.rs). Returns null for anything that
 * isn't in that shape, so a real Composer/Comment value is never mistaken
 * for a backup.
 */
export function parseSearchableBackup(
  value: string | undefined | null,
): { stem: string; artist: string; title: string; year: string } | null {
  if (!value || !value.includes(" | | ")) return null;
  const parts = value.split(" | | ").map((s) => s.trim());
  if (parts.length < 2) return null;
  const [stem = "", artist = "", title = "", year = ""] = parts;
  if (!stem && !artist && !title) return null;
  return { stem, artist, title, year };
}

/** Every field the searchable backup could have been written into (the
 * `BackupField` union) — scanned regardless of the current setting, because
 * a file may have been backed up under an earlier choice. */
const BACKUP_FIELDS: (keyof TagData)[] = [
  "originalArtist",
  "comment",
  "composer",
  "album",
  "albumArtist",
  "genre",
];

function fileStem(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.[^.]+$/, "").replace(/_+/g, " ").trim();
}

/** One library file reduced to everything worth comparing a playlist entry against. */
export interface TrackIdentity {
  path: string;
  artist: string;
  title: string;
  durationSecs?: number;
  /** Whole "artist title" strings to compare against, best signal first. */
  texts: { text: Prepared; via: MatchVia }[];
  /** The tag title and artist on their own, for the structured comparison. */
  titleP: Prepared;
  artistP: Prepared;
  version: Set<string>;
}

export function buildIdentity(file: AudioFile, tag: TagData | undefined): TrackIdentity {
  const artist = tag?.artist?.trim() ?? "";
  const title = tag?.title?.trim() ?? "";
  const stem = fileStem(file.path);
  const texts: { text: Prepared; via: MatchVia }[] = [];
  const seen = new Set<string>();
  const push = (text: string, via: MatchVia) => {
    const p = prepare(text);
    if (!p.norm || seen.has(p.norm)) return;
    seen.add(p.norm);
    texts.push({ text: p, via });
  };

  if (artist || title) push(`${artist} ${title}`.trim(), "tags");
  push(stem, "filename");

  const versionSources = [title, stem];
  for (const field of BACKUP_FIELDS) {
    const parsed = parseSearchableBackup(tag?.[field] as string | undefined);
    if (!parsed) continue;
    if (parsed.artist || parsed.title) push(`${parsed.artist} ${parsed.title}`.trim(), "backup");
    if (parsed.stem) push(parsed.stem.replace(/_+/g, " "), "backup");
    versionSources.push(parsed.title, parsed.stem);
  }

  const version = new Set<string>();
  for (const src of versionSources) {
    if (!src) continue;
    for (const v of versionSignature(src)) version.add(v);
  }

  return {
    path: file.path,
    artist,
    title,
    durationSecs: file.durationSecs,
    texts,
    titleP: prepare(stripFeaturing(title) || title),
    artistP: prepare(artist),
    version,
  };
}

/** A playlist entry reduced to the same shape, so both sides are comparable.
 *
 * `artist` only ever comes from real YouTube Music metadata — never derived
 * by splitting the title or guessed from the uploading channel (the owner's
 * "no guessing" rule for this whole feature). `title` is the untouched
 * YouTube title, for display; the split/noise-stripped forms below exist
 * only to help the *matcher* recognize a library track, never to relabel
 * anything on screen. */
export interface WantedEntry {
  /** `entry.artists[0]`, else the legacy structured `entry.artist` field,
   * else null. Never the channel name, never split out of the title. */
  artist: string | null;
  /** The YouTube title exactly as given — what the UI shows. */
  title: string;
  /** The title with common video-title clutter stripped, for matching only. */
  raw: string;
  durationSecs?: number | null;
  version: Set<string>;
  /** Prepared forms, built once per entry rather than per candidate. */
  combinedP: Prepared;
  rawP: Prepared;
  titleP: Prepared;
  artistP: Prepared;
}

export function buildWanted(entry: PlaylistEntry): WantedEntry {
  // Real metadata only — a title with several artists already names the
  // features in its own text, so only the credited (first) artist is used
  // here; comparing against every feature would just as often mismatch a
  // library file's own guest artist.
  const metaArtist = entry.artists?.[0]?.trim() || entry.artist?.trim() || null;
  const artist = metaArtist || null;

  const title = entry.title;
  const raw = stripTitleNoise(entry.title);
  const rawP = prepare(raw);
  // The title/artist split still helps the matcher recognize a library track
  // tagged the plain "Artist / Title" way, even though the split result is
  // never shown or treated as a confirmed artist — see the module doc.
  const split = splitArtistTitle(entry.title);
  const matchTitle = stripFeaturing(split.title) || split.title;
  return {
    artist,
    title,
    raw,
    durationSecs: entry.durationSecs,
    version: versionSignature(entry.title),
    // With no artist the combined string *is* the raw title; sharing the
    // object lets the scorer skip a whole duplicate comparison per candidate.
    combinedP: artist ? prepare(`${artist} ${matchTitle}`) : rawP,
    rawP,
    titleP: prepare(matchTitle),
    artistP: prepare(artist ?? ""),
  };
}

export interface MatchCandidate {
  path: string;
  score: number;
  titleScore: number;
  artistScore: number;
  /** Seconds between the video and the file, or null when either is unknown. */
  durationDelta: number | null;
  /** Which of the file's identities produced the winning score. */
  via: MatchVia;
}

export type MatchStatus = "matched" | "ambiguous" | "missing";

export interface EntryMatch {
  entry: PlaylistEntry;
  status: MatchStatus;
  /** Best candidates, best first — [0] is what "matched"/"ambiguous" point at. */
  candidates: MatchCandidate[];
}

/** A confident match auto-accepts; an ambiguous one is surfaced for the user
 * to confirm or override — the roadmap's "an 80% match asks, it never
 * silently accepts" (see ROADMAP.md's F4 section). */
export const CONFIDENT_THRESHOLD = 0.87;
export const AMBIGUOUS_THRESHOLD = 0.52;
/** Below this a candidate isn't worth offering even as a manual choice. */
const FLOOR_THRESHOLD = 0.3;
/** Enough alternates to step through when several mixes of a track exist. */
const MAX_CANDIDATES = 8;

/**
 * Duration agreement. A YouTube upload commonly carries a second or two of
 * extra silence, so small gaps are free; a gap bigger than a verse means
 * it's a different edit no matter how well the titles read.
 */
/** The most a perfect duration agreement can add to a text score. */
const DURATION_BONUS = 0.05;

function applyDuration(score: number, delta: number | null): number {
  if (delta === null) return score; // unknown — stay neutral rather than punish
  if (delta <= 3) return Math.min(1, score + DURATION_BONUS);
  if (delta <= 10) return score;
  if (delta <= 25) return score * 0.93;
  // A big gap used to cap every candidate at 0.45 — below the "worth asking"
  // bar — however exactly the title and artist agreed. In a DJ library the
  // copy you own is routinely a different length from the video: a radio
  // edit (I Gotta Feeling, 4:07 vs the 4:50 video), a 2-minute quick-hitter
  // remix. Those must still be offered to confirm; they just can never
  // auto-accept (1.0 x 0.8 stays under CONFIDENT_THRESHOLD).
  if (delta <= 60) return score * 0.8;
  return score * 0.7;
}

/** Applied to a candidate whose artist tag contradicts the credited artist. */
const ARTIST_MISMATCH_FACTOR = 0.7;

/**
 * How well two artist strings agree. Takes the better of plain similarity
 * and *containment* (how much of the shorter side's words the longer side
 * has), so a collaboration credit — "Lady Gaga" vs "Lady Gaga feat. Colby
 * O'Donis", "Skrillex" vs "Fred again.. & Skrillex" — counts as agreement
 * rather than a mismatch. Never pruned: artist strings are short, and an
 * underestimate here would wrongly trigger the mismatch penalty.
 */
function artistAgreement(a: Prepared, b: Prepared): number {
  const sim = preparedTextSimilarity(a, b);
  if (!a.weight || !b.weight) return sim;
  const small = a.counts.size <= b.counts.size ? a : b;
  const large = small === a ? b : a;
  let inter = 0;
  for (const [t, c] of small.counts) {
    const other = large.counts.get(t);
    if (other !== undefined) inter += (c < other ? c : other) * (t.length > 1 ? t.length : 1);
  }
  const contained = inter / Math.min(a.weight, b.weight);
  return contained > sim ? contained : sim;
}

/**
 * `minScore` is the lowest final score the caller would still keep. Every
 * text comparison can be capped by it, because the only things that lift a
 * text score on its way to the final score are the duration bonus (at most
 * +0.05) and the version factor (at most x1) — so a text score below
 * `minScore - 0.05` cannot produce a candidate worth keeping. Pruned
 * comparisons return a lower bound rather than the exact value, which is
 * why `matchPlaylist` re-scores the handful of survivors exactly.
 */
function scoreIdentity(want: WantedEntry, id: TrackIdentity, minScore = 0): MatchCandidate {
  const sameCombined = want.combinedP === want.rawP;
  const floor = minScore > DURATION_BONUS ? minScore - DURATION_BONUS : 0;

  let best = 0;
  let bestVia: MatchVia = "tags";
  for (const { text, via } of id.texts) {
    // Compare both the reassembled "artist title" and the untouched video
    // title: whichever fits better decides, so a title that had no
    // separator to split on isn't penalised for the split having failed.
    // When the entry had no artist the two are the same string, so one
    // comparison answers both.
    let s = preparedTextSimilarity(want.combinedP, text, floor);
    if (!sameCombined) {
      const raw = preparedTextSimilarity(want.rawP, text, floor);
      if (raw > s) s = raw;
    }
    if (s > best) {
      best = s;
      bestVia = via;
    }
  }

  // When both sides actually have structured artist/title, score those
  // fields against each other too — far more precise than one flat string.
  const titleScore = id.title ? preparedTextSimilarity(want.titleP, id.titleP, floor) : 0;
  const artistScore =
    want.artist && id.artist ? preparedTextSimilarity(want.artistP, id.artistP, floor) : 0;
  if (want.artist && id.artist && id.title) {
    const structured = titleScore * 0.62 + artistScore * 0.38;
    if (structured > best) {
      best = structured;
      bestVia = "tags";
    }
  }

  // A playlist entry with *no* artist at all — a bare track title, which is
  // what a YouTube Music playlist usually gives ("Disturbia", not "Rihanna -
  // Disturbia") — must also be compared against the library track's title on
  // its own. Otherwise it is scored against "artist title" and the artist
  // tokens it could never have supplied drag it down: "Disturbia" against
  // "Rihanna Disturbia" scored 0.59, far below the confident threshold,
  // despite being exactly right. Observed on a real 70-track playlist where
  // every correct match landed in the 59-86% band and nothing auto-accepted.
  //
  // Slightly discounted, because a title alone is genuinely weaker evidence
  // than a title plus a confirmed artist: where both fit, the one that also
  // agrees on the artist should still win the greedy assignment.
  if (!want.artist && id.title) {
    let titleOnly = preparedTextSimilarity(want.rawP, id.titleP, floor);
    if (want.titleP !== want.rawP) {
      // The featuring-stripped form, so guests in the video title don't count against it.
      const t = preparedTextSimilarity(want.titleP, id.titleP, floor);
      if (t > titleOnly) titleOnly = t;
    }
    titleOnly *= 0.98;
    if (titleOnly > best) {
      best = titleOnly;
      bestVia = "tags";
    }
  }

  // A credited artist that plainly disagrees with the file's artist tag is
  // strong evidence against the match, however well the strings read
  // otherwise. Without this, edit distance happily scored "Just Dance"
  // (Lady Gaga) against "Justice Dance" at 0.77 — "Just" + "ice" is only
  // three inserts — and that beat the real Lady Gaga file, which had lost
  // points for being a remix and 21 s longer. `want.artist` is real YouTube
  // Music metadata only (never a channel guess), so it is safe to trust.
  // A penalty rather than a veto: mis-tagged artist fields exist, and those
  // should still show up as a candidate to confirm.
  if (want.artist && id.artist && artistAgreement(want.artistP, id.artistP) < 0.5) {
    best *= ARTIST_MISMATCH_FACTOR;
  }

  // The mirror image: same artist, different song. In the flat "artist
  // title" comparison a long shared artist name carries most of the weight,
  // so "The Black Eyed Peas The Time" read 61% like "The Black Eyed Peas I
  // Gotta Feeling" and took that row. When both titles are known and plainly
  // disagree, the structured artist/title score — where the title counts
  // for most — is the ceiling. Exact (unpruned) title score, for the same
  // reason as `artistAgreement`.
  if (want.artist && id.artist && id.title) {
    const titleAgree = artistAgreement(want.titleP, id.titleP);
    if (titleAgree < 0.5) {
      const ceiling = titleAgree * 0.62 + artistAgreement(want.artistP, id.artistP) * 0.38;
      if (best > ceiling) best = ceiling;
    }
  }

  const delta =
    want.durationSecs && id.durationSecs && want.durationSecs > 0 && id.durationSecs > 0
      ? Math.abs(want.durationSecs - id.durationSecs)
      : null;

  const score = applyDuration(best * versionFactor(want.version, id.version), delta);

  return {
    path: id.path,
    score: Math.max(0, Math.min(1, score)),
    titleScore,
    artistScore,
    durationDelta: delta,
    via: bestVia,
  };
}

/**
 * An inverted index over the collection, built once per run.
 *
 * Scoring is exact but not free, and scanning every track for every entry is
 * what actually costs the seconds: a 70-entry playlist against 4,149 tracks
 * is 290k full comparisons. Almost all of those are between a playlist entry
 * and a track with no word in common, which can never score anywhere near a
 * match. This narrows each entry to the tracks that share something with it.
 *
 * Two kinds of key, because exact-token overlap alone would miss misspellings:
 *
 * - the **whole token** ("brejcha"), which catches everything that agrees on
 *   any word;
 * - the token's **first three characters** ("bre"), which catches a
 *   misspelling of that word, since typos very rarely land in the opening
 *   letters ("disturbia" / "disturbya" both bucket under "dis").
 *
 * **What this guarantees.** Measured against the exhaustive scan over a
 * 4,149-track corpus, the shortlist never changes a status, an assignment,
 * or any candidate at or above `AMBIGUOUS_THRESHOLD` — i.e. nothing that
 * decides a match. What it can drop are alternates scraping the
 * `FLOOR_THRESHOLD` bottom (the worst observed loss scored 0.31), which
 * exist only to pad the carousel and are noise by construction: a track
 * sharing neither a whole word nor a word-opening with the entry is not a
 * plausible match. `ytMatchIndex.test.ts` asserts that contract, typos
 * included, rather than the stronger equality it does not hold.
 */
interface CollectionIndex {
  identities: TrackIdentity[];
  postings: Map<string, number[]>;
}

const PREFIX_LEN = 3;

function keysOf(p: Prepared, into: Set<string>): void {
  for (const t of p.tokens) {
    into.add(t);
    if (t.length > PREFIX_LEN) into.add(t.slice(0, PREFIX_LEN));
  }
}

function buildCollectionIndex(identities: TrackIdentity[]): CollectionIndex {
  const postings = new Map<string, number[]>();
  const keys = new Set<string>();
  identities.forEach((id, i) => {
    keys.clear();
    for (const { text } of id.texts) keysOf(text, keys);
    keysOf(id.titleP, keys);
    keysOf(id.artistP, keys);
    for (const k of keys) {
      const list = postings.get(k);
      if (list) list.push(i);
      else postings.set(k, [i]);
    }
  });
  return { identities, postings };
}

/** Indices of the tracks worth scoring against this entry. */
function shortlistFor(index: CollectionIndex, want: WantedEntry): number[] {
  const keys = new Set<string>();
  keysOf(want.combinedP, keys);
  keysOf(want.rawP, keys);
  keysOf(want.titleP, keys);
  keysOf(want.artistP, keys);

  const hit = new Set<number>();
  for (const k of keys) {
    const list = index.postings.get(k);
    if (!list) continue;
    for (const i of list) hit.add(i);
  }
  // Collection order, not posting-list order. Equal-scoring candidates are
  // common (a library holds many tracks with the same title), and the
  // top-N cut then depends on which one was seen first — so the shortlist
  // has to visit tracks in the same order the exhaustive scan would, or the
  // two disagree on ties for no meaningful reason.
  return [...hit].sort((a, b) => a - b);
}

/**
 * Matches every entry in a fetched playlist against the collection.
 *
 * Scoring is per-pair, but *acceptance* is global: every (entry, file) pair
 * above the ambiguous floor is considered in descending score order and the
 * strongest ones claim their file first, so no file backs two entries. An
 * entry whose best candidate was already claimed falls through to its own
 * next best rather than silently duplicating a match.
 */
export function matchPlaylist(
  entries: PlaylistEntry[],
  files: AudioFile[],
  tags: Record<string, TagData>,
  /** Escape hatch for the tests that check the shortlist changes nothing. */
  options?: { exhaustive?: boolean },
): EntryMatch[] {
  const identities = files.map((f) => buildIdentity(f, tags[f.path]));

  const byPath = new Map(identities.map((id) => [id.path, id]));
  const index = buildCollectionIndex(identities);

  const perEntry = entries.map((entry) => {
    const want = buildWanted(entry);
    const shortlist = options?.exhaustive
      ? identities.map((_, i) => i)
      : shortlistFor(index, want);

    // Keep only the best MAX_CANDIDATES, and let the worst of them raise the
    // bar for everything still to come. On a big library the bar climbs
    // within the first handful of tracks, after which almost every remaining
    // comparison is settled by a bound instead of an edit-distance table.
    // This is pruning, not sampling: a candidate is only ever skipped once
    // it provably cannot displace the current worst survivor.
    const top: MatchCandidate[] = [];
    let bar = FLOOR_THRESHOLD;
    for (const idx of shortlist) {
      const c = scoreIdentity(want, index.identities[idx], bar);
      if (c.score < bar) continue;
      // Insert after equals, so ties keep collection order as the old
      // score-everything-then-sort did.
      let i = 0;
      while (i < top.length && top[i].score >= c.score) i++;
      top.splice(i, 0, c);
      if (top.length > MAX_CANDIDATES) top.pop();
      if (top.length === MAX_CANDIDATES) {
        const worst = top[MAX_CANDIDATES - 1].score;
        if (worst > bar) bar = worst;
      }
    }

    // Survivors may carry lower-bound sub-scores from pruned comparisons,
    // so re-score them exactly. There are at most MAX_CANDIDATES of them.
    const candidates = top
      .map((c) => scoreIdentity(want, byPath.get(c.path)!, 0))
      .sort((a, b) => b.score - a.score);

    return { entry, candidates };
  });

  // Greedy global assignment — one file backs at most one entry.
  const pairs: { e: number; c: MatchCandidate }[] = [];
  perEntry.forEach((p, e) => {
    for (const c of p.candidates) if (c.score >= AMBIGUOUS_THRESHOLD) pairs.push({ e, c });
  });
  pairs.sort((a, b) => b.c.score - a.c.score);

  const assigned = new Map<number, MatchCandidate>();
  const claimed = new Set<string>();
  for (const { e, c } of pairs) {
    if (assigned.has(e) || claimed.has(c.path)) continue;
    assigned.set(e, c);
    claimed.add(c.path);
  }

  return perEntry.map(({ entry, candidates }, e) => {
    const winner = assigned.get(e);
    // Show the assigned candidate first, then the rest as alternates to
    // step through — the user's "different mixes" case.
    const ordered = winner
      ? [winner, ...candidates.filter((c) => c.path !== winner.path)]
      : candidates;
    const status: MatchStatus = !winner
      ? "missing"
      : winner.score >= CONFIDENT_THRESHOLD
        ? "matched"
        : "ambiguous";
    return { entry, status, candidates: ordered };
  });
}
