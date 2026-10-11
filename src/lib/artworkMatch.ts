// Ranking for artwork candidates from MusicBrainz / iTunes / Deezer.
//
// The Rust side returns what each source *says* a hit is (its track title,
// artist, release, release type); this file decides how well that matches the
// track we are looking for, and which hit to prefer. Kept pure for testing.

export type ArtworkSource = "musicbrainz" | "itunes" | "deezer";

export interface ArtworkCandidate {
  source: ArtworkSource;
  id: string;
  release: string;
  releaseArtist: string;
  trackTitle: string;
  trackArtist: string;
  /** "Album" | "Single" | "EP" | "Compilation" | "" (unknown). */
  kind: string;
  date: string;
  trackCount: number | null;
  durationMs: number | null;
  sourceScore: number | null;
  nominalSize: number;
  previewDataUrl: string;
  fullUrls: string[];
}

export interface TrackQuery {
  artist: string;
  title: string;
  album?: string;
  durationSecs?: number;
}

export interface RankedCandidate extends ArtworkCandidate {
  /** 0..1 — how sure we are this is the right *track* (drives auto-pick). */
  confidence: number;
  /** Ordering key: confidence plus release-type preferences. */
  rank: number;
  isCompilation: boolean;
}

const SOURCE_PREF: Record<ArtworkSource, number> = { musicbrainz: 0.03, itunes: 0.02, deezer: 0 };

/** Lowercase, accent-free, no "(feat. …)", punctuation collapsed. */
export function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[([]\s*(feat\.?|ft\.?|featuring)[^)\]]*[)\]]/g, " ")
    .replace(/\b(feat\.?|ft\.?|featuring)\b.*$/, " ")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Dice coefficient over word tokens; 1 for equal, 0 for disjoint. */
export function similarity(a: string, b: string): number {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const ta = new Set(x.split(" "));
  const tb = new Set(y.split(" "));
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  return (2 * common) / (ta.size + tb.size);
}

const COMPILATION_NAME =
  /\b(now that'?s what i call|vol(ume)?\.?\s*\d+|greatest hits|best of|hits of|the (very )?best|compilation|dj mix|mixed by|club hits|top \d+)/i;

export function isCompilation(c: Pick<ArtworkCandidate, "kind" | "release" | "releaseArtist">): boolean {
  return (
    /compilation/i.test(c.kind) ||
    /^various( artists)?$/i.test(c.releaseArtist.trim()) ||
    COMPILATION_NAME.test(c.release)
  );
}

/** Whether the file's own album tag says it is a single/EP (or has no album). */
export function looksLikeSingle(q: TrackQuery): boolean {
  const album = (q.album ?? "").trim();
  if (!album) return true;
  return similarity(album, q.title) >= 0.9 || /\b(single|ep)\b/i.test(album);
}

function kindIsSingle(c: ArtworkCandidate): boolean {
  return /^(single|ep)$/i.test(c.kind) || (c.trackCount != null && c.trackCount <= 3);
}

export function scoreCandidate(q: TrackQuery, c: ArtworkCandidate): RankedCandidate {
  const t = similarity(q.title, c.trackTitle);
  const a = Math.max(similarity(q.artist, c.trackArtist), similarity(q.artist, c.releaseArtist));
  let confidence = 0.5 * t + 0.5 * a;
  if (q.durationSecs && c.durationMs) {
    const diff = Math.abs(q.durationSecs - c.durationMs / 1000);
    if (diff <= 2) confidence += 0.05;
    else if (diff > 5) confidence -= 0.3;
  }
  if (c.sourceScore != null) confidence += (c.sourceScore / 100 - 0.9) * 0.1;
  confidence = Math.max(0, Math.min(1, confidence));

  const comp = isCompilation(c);
  const queryIsCompilation = !!q.album && COMPILATION_NAME.test(q.album);
  let rank = confidence + SOURCE_PREF[c.source];
  // The exact release the file already claims is the best possible match.
  if (q.album && similarity(q.album, c.release) >= 0.85) rank += 0.15;
  else if (looksLikeSingle(q) === kindIsSingle(c)) rank += 0.06;
  if (comp && !queryIsCompilation) rank -= 0.25;
  return { ...c, confidence, rank, isCompilation: comp };
}

/** Candidates best-first, with exact duplicates (same source and id) removed. */
export function rankCandidates(q: TrackQuery, candidates: ArtworkCandidate[]): RankedCandidate[] {
  const seen = new Set<string>();
  return candidates
    .filter((c) => {
      const k = `${c.source}:${c.id}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((c) => scoreCandidate(q, c))
    .sort((x, y) => y.rank - x.rank);
}

/** The best candidate that clears `threshold` and is not a compilation, else null (bulk auto-pick). */
export function pickBest(ranked: RankedCandidate[], threshold: number): RankedCandidate | null {
  return ranked.find((c) => c.confidence >= threshold && !c.isCompilation) ?? null;
}

/** True once the ranked list holds a result good enough to stop searching further sources. */
export function goodEnough(ranked: RankedCandidate[], threshold = 0.75): boolean {
  return ranked.some((c) => c.confidence >= threshold && !c.isCompilation);
}
