// Which repeated-cover clusters are DJ-pool logos rather than real artwork.
//
// The Rust scan (`commands/artwork.rs`) finds pictures repeated across several
// artists; this decides which of those are safe to call junk *without asking*,
// so the Junk Art dialog can offer a one-click clean-up. Kept pure for testing.

export interface JunkClusterInfo {
  count: number;
  /** Distinct artist tags among the tracks sharing the picture. */
  artists: number;
  /**
   * Distinct lead artists ("A feat. B" counts as A). Absent from older
   * builds, in which case `artists` is all there is to go on.
   */
  leadArtists?: number;
  /** Distinct album tags, an empty tag counting as one. */
  albums: number;
  /** Tracks whose album tag is blank (absent from older builds' scans). */
  emptyAlbums?: number;
  blocked: boolean;
  samples: { path: string; artist: string; title: string; album: string }[];
}

/**
 * Record-pool / promo-service names as they turn up in album tags and folder
 * names. Deliberately not matched against artist or title: "DMS" or "HMC" can
 * be part of a real name there.
 */
const POOL_NAME =
  /\b(dj ?city|bpm ?supreme|bpm ?latino|club ?killers|heavy ?hits|crooklyn ?clan|direct ?music ?service|digital ?dj ?pool|zip ?dj|late ?night ?record ?pool|my ?mp3 ?pool|franchise ?record ?pool|promo ?only|select ?mix|ultimix|funkymix|crate ?connect|remix ?planet|bar ?bangerz|8th ?wonder|beat ?junkies|record ?pool|dj ?pool|mixshow ?tools|cicana|redrum)\b/i;

/** The pool name found in a track's album tag or path, if any. */
export function poolNameIn(sample: { path: string; album: string }): string | null {
  const m = POOL_NAME.exec(sample.album) ?? POOL_NAME.exec(sample.path.replace(/[_.-]+/g, " "));
  return m ? m[0] : null;
}

/** Enough unrelated artists that one shared picture can't be a release's own cover. */
const MANY_ARTISTS = 5;

/**
 * Why this picture is almost certainly wrong for most of its tracks, or null
 * when it needs a human look. "Wrong" covers more than pool logos: on a real
 * library the commonest case is a genuine cover that got stuck on a batch of
 * unrelated tracks, so it is right for one artist and wrong for the rest.
 *
 * Artists are counted by lead artist, so one act's own cover across its
 * "feat." collaborations is not mistaken for a shared picture. A single real
 * album tag shared by every track is treated as a possible compilation (one
 * cover, many artists is exactly what a "Now 100" looks like) unless that
 * tag itself names a pool.
 */
export function junkReason(c: JunkClusterInfo): string | null {
  for (const s of c.samples) {
    const pool = poolNameIn(s);
    if (pool) return `tags mention “${pool}”`;
  }
  const artists = c.leadArtists ?? c.artists;
  const oneRealAlbum = c.albums === 1 && (c.emptyAlbums ?? 0) === 0;
  if (artists >= MANY_ARTISTS && !oneRealAlbum) return `same picture on ${artists} different artists`;
  return null;
}

/** True for a cluster not yet marked junk that `junkReason` is confident about. */
export function isLikelyJunkCluster(c: JunkClusterInfo): boolean {
  return !c.blocked && junkReason(c) !== null;
}
