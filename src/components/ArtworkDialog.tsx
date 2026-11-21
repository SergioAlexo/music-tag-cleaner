import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ArrowLeft, Image as ImageIcon, Loader2, ScanSearch, Search, Sparkles, Trash2, X } from "lucide-react";

import type { TagReadResult } from "../types";
import type { HistoryChange } from "../hooks/useHistory";
import {
  baseTitle,
  goodEnough,
  pickBest,
  queryFromFilename,
  rankCandidates,
  type ArtworkCandidate,
  type RankedCandidate,
  type TrackQuery,
} from "../lib/artworkMatch";
import { confirm } from "@tauri-apps/plugin-dialog";
import { isLikelyJunkCluster, junkReason, poolNameIn } from "../lib/junkArt";
import { Button, Card, cn, selectClass } from "./ui";

interface ArtworkChange {
  beforeDataUrl: string;
  afterDataUrl: string;
}

const SOURCE_LABEL = { musicbrainz: "MusicBrainz", itunes: "iTunes", deezer: "Deezer" } as const;
const basename = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** One pass over the three sources for a single query. */
async function searchSources(q: TrackQuery, all: boolean): Promise<ArtworkCandidate[]> {
  let pool: ArtworkCandidate[] = [];
  const steps: Array<() => Promise<ArtworkCandidate[]>> = [
    () =>
      invoke("artwork_search_musicbrainz", {
        artist: q.artist,
        title: q.title,
        durationSecs: q.durationSecs ?? null,
      }),
    () => invoke("artwork_search_itunes", { artist: q.artist, title: q.title }),
    () => invoke("artwork_search_deezer", { artist: q.artist, title: q.title }),
  ];
  let firstError: unknown = null;
  for (const step of steps) {
    try {
      pool = pool.concat(await step());
    } catch (e) {
      firstError ??= e; // one source being down shouldn't hide the others
    }
    if (!all && goodEnough(rankCandidates(q, pool))) break;
  }
  if (!pool.length && firstError) throw firstError;
  return pool;
}

/**
 * Looks a track up source by source — MusicBrainz/Cover Art Archive first,
 * then iTunes, then Deezer — and stops as soon as a source produced a result
 * good enough to trust. `all` keeps going regardless (the "try other sources"
 * button).
 *
 * A title carrying a version tag ("(Extended Mix)", " - Radio Edit") gets a
 * second pass under the plain song name when the first found nothing good:
 * the stores list the single, not the DJ edit, and a search for the tagged
 * title often returns nothing at all. That pass drops the duration, because
 * a different edit is a different length and MusicBrainz results are
 * filtered by it.
 */
export async function findArtworkCandidates(q: TrackQuery, all = false, limit = 6): Promise<RankedCandidate[]> {
  let pool: ArtworkCandidate[] = [];
  let error: unknown = null;
  try {
    pool = await searchSources(q, all);
  } catch (e) {
    error = e;
  }
  const plain = baseTitle(q.title);
  if (plain !== q.title.trim() && (all || !goodEnough(rankCandidates(q, pool)))) {
    try {
      pool = pool.concat(await searchSources({ ...q, title: plain, durationSecs: undefined }, all));
      error = null;
    } catch (e) {
      error ??= e;
    }
  }
  if (!pool.length && error) throw error;
  return rankCandidates(q, pool).slice(0, limit);
}

/** The search for one file: its tags, or its file name when it has no title tag. */
function queryFor(path: string, r: TagReadResult | undefined, durationSecs?: number): TrackQuery | null {
  const t = r?.tags;
  if (!t?.title?.trim()) {
    const fromName = queryFromFilename(path);
    return fromName ? { ...fromName, artist: fromName.artist || (t?.artist ?? "").trim(), durationSecs } : null;
  }
  return {
    artist: (t.artist || t.albumArtist || "").trim(),
    title: t.title.trim(),
    album: t.album?.trim() || undefined,
    durationSecs,
  };
}

interface FindProps {
  paths: string[];
  /** Duration per path, when the table knows it. */
  durations: Record<string, number | undefined>;
  artworkMaxDim: number;
  artworkJpegQuality: number;
  /**
   * Start with "skip tracks that already have artwork" ticked (bulk only).
   * Off when the caller explicitly wants covers replaced (the junk-art dialog).
   */
  onlyMissing?: boolean;
  /** Records the writes in undo history and refreshes thumbnails. */
  onApplied: (changes: HistoryChange[], label: string) => void;
  onClose: () => void;
}

type RowState = {
  status: "pending" | "searching" | "applied" | "low" | "none" | "error";
  note?: string;
};

/**
 * "Find artwork": one track shows candidates to choose from; several run an
 * auto-pick over the tracks that need a cover (none yet, or a known junk
 * logo), and anything the auto-pick wasn't sure about can be reviewed by hand
 * from the same list.
 */
export function ArtworkDialog({
  paths,
  durations,
  artworkMaxDim,
  artworkJpegQuality,
  onlyMissing: onlyMissingInitial = true,
  onApplied,
  onClose,
}: FindProps) {
  const many = paths.length > 1;
  /** A row of the bulk list opened in the single-track picker. */
  const [reviewPath, setReviewPath] = useState<string | null>(null);
  const bulk = many && !reviewPath;
  const single = reviewPath ?? paths[0];

  const [queries, setQueries] = useState<Record<string, TrackQuery | null> | null>(null);
  const [hasArt, setHasArt] = useState<Record<string, boolean>>({});
  /** Files whose cover is on the junk blocklist (from an earlier Junk Art scan). */
  const [junk, setJunk] = useState<Set<string>>(new Set());
  const [onlyMissing, setOnlyMissing] = useState(onlyMissingInitial);
  const [replaceJunk, setReplaceJunk] = useState(true);
  const [current, setCurrent] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<RankedCandidate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [threshold, setThreshold] = useState(0.85);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const cancel = useRef(false);
  const live = useRef(true);

  const apply = async (path: string, c: ArtworkCandidate): Promise<HistoryChange> => {
    const res = await invoke<ArtworkChange>("artwork_apply", {
      path,
      fullUrls: c.fullUrls,
      maxDim: artworkMaxDim,
      quality: artworkJpegQuality,
    });
    return { path, field: "__coverArt", before: res.beforeDataUrl, after: res.afterDataUrl };
  };

  useEffect(() => {
    live.current = true;
    (async () => {
      const [tags, flagged] = await Promise.all([
        invoke<TagReadResult[]>("read_tags_batch", { paths }),
        // Best-effort: no scan yet (or no store) just means nothing is known junk.
        many
          ? invoke<{ path: string; blocked: boolean }[]>("artwork_flagged").catch(() => [])
          : Promise.resolve([]),
      ]);
      if (!live.current) return;
      const byPath = Object.fromEntries(tags.map((t) => [t.path, t]));
      setQueries(Object.fromEntries(paths.map((p) => [p, queryFor(p, byPath[p], durations[p])])));
      setHasArt(Object.fromEntries(paths.map((p) => [p, !!byPath[p]?.tags?.hasCoverArt])));
      const wanted = new Set(paths);
      setJunk(new Set(flagged.filter((f) => f.blocked && wanted.has(f.path)).map((f) => f.path)));
    })().catch((e) => live.current && setError(String(e)));
    return () => {
      live.current = false;
      cancel.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const q = queries?.[single] ?? null;

  /** The editable search boxes in the single-track view, pre-filled from the
   * tags. Tags are often wrong or carry DJ-pool junk, so the owner can type
   * their own artist / title (or an album name) and search again. */
  const [manualArtist, setManualArtist] = useState("");
  const [manualTitle, setManualTitle] = useState("");
  useEffect(() => {
    setManualArtist(q?.artist ?? "");
    setManualTitle(q?.title ?? "");
  }, [single, q]);

  /** The tracks a bulk run will look up. */
  const targets = useMemo(
    () => paths.filter((p) => !onlyMissing || !hasArt[p] || (replaceJunk && junk.has(p))),
    [paths, onlyMissing, replaceJunk, hasArt, junk],
  );
  const junkCount = paths.filter((p) => junk.has(p)).length;
  const missingCount = paths.filter((p) => !hasArt[p]).length;

  // Read by an in-flight search to see whether its row is still the one on screen.
  const singleRef = useRef(single);
  singleRef.current = single;

  const search = async (all = false, override?: TrackQuery) => {
    const query = override ?? q;
    if (!query) return;
    const forPath = single;
    setBusy(true);
    setError(null);
    try {
      // A hand-typed search shows more results: the owner is browsing, not
      // trusting the top pick.
      const found = await findArtworkCandidates(query, all, override ? 12 : 6);
      // The user may have gone back to the list (or on to another row) meanwhile.
      if (live.current && forPath === singleRef.current) setCandidates(found);
    } catch (e) {
      if (live.current) setError(String(e));
    } finally {
      if (live.current) setBusy(false);
    }
  };

  // Single-track view (also a reviewed bulk row): load its current cover and search.
  useEffect(() => {
    if (bulk || !queries) return;
    let on = true;
    setCandidates(null);
    setCurrent(null);
    invoke<string | null>("read_cover_art", { path: single })
      .catch(() => null)
      .then((art) => on && setCurrent(art));
    if (q) void search();
    return () => {
      on = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [single, bulk, !!queries]);

  const manualSearch = () => {
    const title = manualTitle.trim();
    const artist = manualArtist.trim();
    if (!title && !artist) return;
    // The duration only narrows MusicBrainz to this exact edit; a typed search
    // is usually for a different release, so it's dropped.
    void search(true, { artist, title: title || artist, album: undefined });
  };

  const choose = async (c: ArtworkCandidate) => {
    setBusy(true);
    setError(null);
    try {
      const change = await apply(single, c);
      onApplied([change], "Find artwork");
      if (reviewPath) {
        setRows((r) => ({
          ...r,
          [reviewPath]: { status: "applied", note: `${SOURCE_LABEL[c.source]} · ${c.release} (picked by hand)` },
        }));
        setHasArt((h) => ({ ...h, [reviewPath]: true }));
        setReviewPath(null);
        setBusy(false);
      } else {
        onClose();
      }
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const autoPick = async () => {
    cancel.current = false;
    setBusy(true);
    const changes: HistoryChange[] = [];
    const set = (p: string, s: RowState) => live.current && setRows((r) => ({ ...r, [p]: s }));
    // Tracks already done in an earlier pass of this dialog are not looked up again.
    const todo = targets.filter((p) => rows[p]?.status !== "applied");
    try {
      for (const p of todo) {
        if (cancel.current) break;
        const pq = queries?.[p];
        if (!pq) {
          set(p, { status: "none", note: "no title tag and nothing usable in the file name" });
          continue;
        }
        set(p, { status: "searching" });
        try {
          const ranked = await findArtworkCandidates(pq);
          const best = pickBest(ranked, threshold);
          if (!best) {
            set(
              p,
              ranked.length
                ? { status: "low", note: `best match ${Math.round(ranked[0].confidence * 100)}%` }
                : { status: "none" },
            );
            continue;
          }
          if (cancel.current) break; // Stop pressed during the lookup: don't write.
          changes.push(await apply(p, best));
          set(p, { status: "applied", note: `${SOURCE_LABEL[best.source]} · ${best.release}` });
        } catch (e) {
          set(p, { status: "error", note: String(e) });
        }
      }
    } finally {
      // Covers written before a Stop / close still belong in undo history.
      if (changes.length) onApplied(changes, `Find artwork (${changes.length})`);
      if (live.current) {
        setHasArt((h) => ({ ...h, ...Object.fromEntries(changes.map((c) => [c.path, true])) }));
        setBusy(false);
      }
    }
  };

  const counts = useMemo(() => {
    const c = { applied: 0, low: 0, none: 0, error: 0 };
    for (const r of Object.values(rows)) if (r.status in c) c[r.status as keyof typeof c]++;
    return c;
  }, [rows]);
  const ran = Object.keys(rows).length > 0;
  const targetSet = useMemo(() => new Set(targets), [targets]);

  const statusText = (p: string): string => {
    const s = rows[p];
    if (s) {
      const word = {
        pending: "",
        searching: "searching…",
        applied: "applied",
        low: "not sure",
        none: "nothing found",
        error: "error",
      }[s.status];
      return s.note && s.status !== "searching" ? `${word} · ${s.note.slice(0, 44)}` : word;
    }
    if (!targetSet.has(p)) return "has artwork — skipped";
    if (junk.has(p)) return "junk logo — will be replaced";
    return hasArt[p] ? "will be replaced" : "no artwork";
  };

  return (
    // z-[60]: "Find real artwork" opens this from the Junk Art dialog (z-50,
    // later in the DOM), which would otherwise sit on top and hide it.
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6">
      <Card className="flex max-h-full w-[720px] flex-col overflow-hidden">
        <div className="flex items-start justify-between gap-4 border-b px-5 py-3.5">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <ImageIcon className="h-4 w-4" /> Find artwork
            </h2>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {bulk
                ? !queries
                  ? `${paths.length} tracks · reading tags…`
                  : `${paths.length} tracks · ${missingCount} without artwork${junkCount ? ` · ${junkCount} with a junk logo` : ""} · MusicBrainz, then iTunes, then Deezer`
                : q
                  ? `${q.artist ? q.artist + " — " : ""}${q.title}`
                  : basename(single)}
            </p>
          </div>
          <button onClick={onClose} className="rounded p-1 hover:bg-accent" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {error && <p className="mb-3 rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs">{error}</p>}

          {!bulk && (
            <div className="flex gap-4">
              <div className="w-32 shrink-0">
                <p className="mb-1 text-xs text-muted-foreground">Current</p>
                {current ? (
                  <img src={current} className="aspect-square w-32 rounded border object-cover" />
                ) : (
                  <div className="flex aspect-square w-32 items-center justify-center rounded border text-xs text-muted-foreground">
                    No artwork
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <form
                  className="mb-3 flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    manualSearch();
                  }}
                >
                  <input
                    className="h-8 min-w-0 flex-1 rounded border border-input bg-background px-2 text-sm"
                    placeholder="Artist"
                    value={manualArtist}
                    disabled={!queries}
                    onChange={(e) => setManualArtist(e.target.value)}
                  />
                  <input
                    className="h-8 min-w-0 flex-[1.4] rounded border border-input bg-background px-2 text-sm"
                    placeholder="Title or album"
                    value={manualTitle}
                    disabled={!queries}
                    onChange={(e) => setManualTitle(e.target.value)}
                  />
                  <Button
                    type="submit"
                    size="sm"
                    disabled={busy || !queries || (!manualArtist.trim() && !manualTitle.trim())}
                    title="Search MusicBrainz, iTunes and Deezer for what you typed"
                  >
                    <Search /> Search
                  </Button>
                </form>
                <p className="mb-1 text-xs text-muted-foreground">
                  {busy && !candidates ? "Searching…" : candidates?.length ? "Pick one to embed" : "Candidates"}
                </p>
                {queries && !q && !candidates && (
                  <p className="text-sm">This file has no title tag and no usable file name — type an artist and title above to search.</p>
                )}
                {candidates && candidates.length === 0 && !busy && (
                  <p className="text-sm text-muted-foreground">Nothing found. Try all sources, or change the artist / title above and search again.</p>
                )}
                <div className="grid grid-cols-3 gap-3">
                  {candidates?.map((c) => (
                    <button
                      key={`${c.source}:${c.id}`}
                      disabled={busy}
                      onClick={() => choose(c)}
                      className="group rounded border p-1.5 text-left hover:border-primary disabled:opacity-60"
                    >
                      <img src={c.previewDataUrl} className="aspect-square w-full rounded object-cover" />
                      <p className="mt-1 truncate text-xs font-medium" title={c.release}>
                        {c.release || "(untitled)"}
                      </p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {SOURCE_LABEL[c.source]} · {c.nominalSize}px
                        {c.kind ? ` · ${c.kind}` : ""}
                      </p>
                      <p className={cn("text-[11px]", c.isCompilation ? "text-amber-500" : "text-muted-foreground")}>
                        {c.isCompilation ? "Compilation · " : ""}
                        {Math.round(c.confidence * 100)}% match
                      </p>
                    </button>
                  ))}
                </div>
                {busy && <Loader2 className="mt-3 h-4 w-4 animate-spin" />}
              </div>
            </div>
          )}

          {bulk && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    className="accent-[var(--primary)]"
                    checked={onlyMissing}
                    disabled={busy}
                    onChange={(e) => setOnlyMissing(e.target.checked)}
                  />
                  Only tracks without artwork
                </label>
                {onlyMissing && junkCount > 0 && (
                  <label
                    className="flex items-center gap-2 text-xs"
                    title="Covers you marked as junk in Junk Art (DJ-pool logos) count as missing"
                  >
                    <input
                      type="checkbox"
                      className="accent-[var(--primary)]"
                      checked={replaceJunk}
                      disabled={busy}
                      onChange={(e) => setReplaceJunk(e.target.checked)}
                    />
                    Also replace junk logos ({junkCount})
                  </label>
                )}
                <span className="flex items-center gap-2">
                  <label className="text-xs text-muted-foreground">Write when the match is at least</label>
                  <select
                    className={cn(selectClass, "w-24")}
                    value={threshold}
                    disabled={busy}
                    onChange={(e) => setThreshold(Number(e.target.value))}
                  >
                    <option value={0.75}>75%</option>
                    <option value={0.85}>85%</option>
                    <option value={0.95}>95%</option>
                  </select>
                </span>
              </div>
              {ran && !busy && (
                <p className="text-xs text-muted-foreground">
                  {counts.applied} applied
                  {counts.low ? ` · ${counts.low} not sure (use Pick… to choose by hand)` : ""}
                  {counts.none ? ` · ${counts.none} not found` : ""}
                  {counts.error ? ` · ${counts.error} failed` : ""}
                </p>
              )}
              <div className="max-h-72 overflow-y-auto rounded border text-xs">
                {paths.map((p) => {
                  const s = rows[p];
                  const reviewable = !busy && !!queries?.[p] && s && s.status !== "applied" && s.status !== "searching";
                  return (
                    <div
                      key={p}
                      className={cn(
                        "flex items-center gap-2 border-b px-3 py-1.5 last:border-b-0",
                        !s && !targetSet.has(p) && "opacity-50",
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate" title={p}>
                        {basename(p)}
                      </span>
                      <span
                        className={cn(
                          "shrink-0 text-muted-foreground",
                          s?.status === "applied" && "text-green-500",
                          s?.status === "low" && "text-amber-500",
                          s?.status === "error" && "text-destructive",
                        )}
                        title={s?.note}
                      >
                        {statusText(p)}
                      </span>
                      {reviewable && (
                        <button
                          className="shrink-0 rounded border border-input px-1.5 py-0.5 hover:bg-accent"
                          onClick={() => setReviewPath(p)}
                          title="See the candidates and choose one yourself"
                        >
                          Pick…
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-5 py-3">
          {reviewPath && (
            <Button variant="secondary" size="sm" className="mr-auto" disabled={busy} onClick={() => setReviewPath(null)}>
              <ArrowLeft /> Back to list
            </Button>
          )}
          {!bulk && (
            <Button
              variant="secondary"
              size="sm"
              disabled={busy || (!q && !manualArtist.trim() && !manualTitle.trim())}
              onClick={() =>
                // Once the boxes were edited, "all sources" means for what's typed there.
                q && manualArtist.trim() === q.artist && manualTitle.trim() === q.title ? search(true) : manualSearch()
              }
            >
              <Search /> Try all sources
            </Button>
          )}
          {bulk && (
            <Button size="sm" disabled={busy || !queries || targets.length === 0} onClick={autoPick}>
              <Search />{" "}
              {!queries
                ? "Reading tags…"
                : targets.length === 0
                  ? "Every track has artwork"
                  : ran
                    ? "Auto-pick again"
                    : `Auto-pick for ${targets.length} track${targets.length === 1 ? "" : "s"}`}
            </Button>
          )}
          {busy && bulk ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                cancel.current = true;
              }}
            >
              Stop
            </Button>
          ) : (
            <Button variant="secondary" size="sm" onClick={onClose}>
              Close
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}

// -------------------------------------------------------------- junk art

interface SampleTrack {
  path: string;
  artist: string;
  title: string;
  album: string;
}
interface Cluster {
  /** Unique per cluster (different pictures can share a hash). */
  id: string;
  hash: string;
  count: number;
  artists: number;
  albums: number;
  emptyAlbums?: number;
  leadArtists?: number;
  blocked: boolean;
  label: string;
  thumbnail: string | null;
  samples: SampleTrack[];
  paths: string[];
}
interface Flagged {
  path: string;
  artist: string;
  title: string;
  album: string;
  width: number;
  height: number;
  reason: string;
  blocked: boolean;
}

interface JunkProps {
  /** Removes the embedded art from these files (undoable). */
  onRemoveArt: (paths: string[]) => Promise<void>;
  /**
   * Opens the Find artwork dialog for these files. `replace` = they still
   * carry a (junk) cover that the lookup should overwrite.
   */
  onFindArt: (paths: string[], replace: boolean) => void;
  notify: (msg: string, kind?: "success" | "error" | "info") => void;
  onClose: () => void;
}

/** Scans the library's embedded covers, shows pictures repeated across unrelated artists, and manages the junk blocklist. */
export function JunkArtDialog({ onRemoveArt, onFindArt, notify, onClose }: JunkProps) {
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [flagged, setFlagged] = useState<Flagged[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanned, setScanned] = useState(false);
  // Reading an earlier scan builds a thumbnail per cluster and takes a while
  // on a big library; without this the dialog just looked empty.
  const [loading, setLoading] = useState(true);
  /** Clusters the owner said are real covers, left out of the bulk actions (this session). */
  const [kept, setKept] = useState<Set<string>>(new Set());

  const load = async () => {
    const [c, f] = await Promise.all([invoke<Cluster[]>("artwork_clusters"), invoke<Flagged[]>("artwork_flagged")]);
    setClusters(c);
    setFlagged(f);
  };

  const scan = async () => {
    setBusy(true);
    const un = await listen<{ done: number; total: number }>("artwork-scan-progress", (e) => setProgress(e.payload));
    try {
      const s = await invoke<{ hashed: number; unchanged: number; failed: number }>("artwork_scan", { paths: null });
      await load();
      setScanned(true);
      notify(`Scanned artwork: ${s.hashed} new, ${s.unchanged} unchanged${s.failed ? `, ${s.failed} unreadable` : ""}`, "info");
    } catch (e) {
      notify(String(e), "error");
    } finally {
      un();
      setProgress(null);
      setBusy(false);
    }
  };

  // Show whatever an earlier scan left behind straight away.
  useEffect(() => {
    load()
      .then(() => setScanned(true))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const toggle = async (c: Cluster) => {
    try {
      await invoke("artwork_blocklist_set", {
        hash: c.hash,
        label: c.samples[0]?.album || c.samples[0]?.artist || "",
        blocked: !c.blocked,
        // The picture itself is remembered, not just its hash, which
        // unrelated covers share.
        path: c.paths[0] ?? null,
      });
      await load();
    } catch (e) {
      notify(String(e), "error");
    }
  };

  const remove = async (paths: string[]) => {
    setBusy(true);
    try {
      await onRemoveArt(paths);
      await invoke("artwork_scan", { paths }); // rows for these files are stale now
      await load();
    } finally {
      setBusy(false);
    }
  };

  const flaggedPaths = flagged.map((f) => f.path);

  // Pictures the app is confident are wrong for most of their tracks (see
  // lib/junkArt.ts), not yet dealt with and not set aside as real covers.
  const likely = clusters.filter((c) => isLikelyJunkCluster(c) && !kept.has(c.id));
  const likelyPaths = [...new Set(likely.flatMap((c) => c.paths))];

  /**
   * Strips every likely-wrong picture and remembers it as junk, so the same
   * picture is flagged on tracks added later. One undoable history entry.
   * Deliberately the *second* choice in the banner: such a picture is usually
   * a real cover that is right for one of its tracks, and "replace with real
   * artwork" fixes the wrong ones without taking anything away first.
   */
  const removeLikely = async () => {
    const ok = await confirm(
      `Remove the embedded artwork from ${likelyPaths.length} track${likelyPaths.length === 1 ? "" : "s"} (${likely.length} repeated picture${likely.length === 1 ? "" : "s"})?\n\nTracks the picture was right for lose it too. You can undo this from History.`,
      { title: "Remove junk artwork", kind: "warning" },
    );
    if (!ok) return;
    setBusy(true);
    try {
      for (const c of likely) {
        await invoke("artwork_blocklist_set", {
          hash: c.hash,
          label: c.samples.map(poolNameIn).find(Boolean) ?? c.samples[0]?.album ?? "",
          blocked: true,
          path: c.paths[0] ?? null,
        });
      }
      await onRemoveArt(likelyPaths);
      await invoke("artwork_scan", { paths: likelyPaths });
      await load();
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <Card className="flex max-h-full w-[780px] flex-col overflow-hidden">
        <div className="flex items-start justify-between gap-4 border-b px-5 py-3.5">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <ScanSearch className="h-4 w-4" /> Junk artwork
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              The same picture on many unrelated artists is a DJ-pool logo, a placeholder, or a cover that got stuck on the wrong tracks. Mark it as junk to flag it in every future scan.
            </p>
          </div>
          <button onClick={onClose} className="rounded p-1 hover:bg-accent" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          <div className="flex items-center gap-3">
            <Button size="sm" onClick={scan} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : <ScanSearch />}
              {scanned ? "Rescan library" : "Scan library covers"}
            </Button>
            {progress && (
              <span className="text-xs text-muted-foreground">
                {progress.done} / {progress.total}
              </span>
            )}
            <span className="text-xs text-muted-foreground">
              {loading ? "Loading the last scan…" : "Uses the library index; unchanged files are skipped."}
            </span>
            {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          </div>

          {likely.length > 0 && (
            <div className="rounded border border-violet/40 bg-violet/5 p-3">
              <p className="flex items-center gap-2 text-sm font-medium">
                <Sparkles className="h-4 w-4 text-violet" />
                {likely.length} picture{likely.length === 1 ? "" : "s"} likely wrong for most of {likelyPaths.length} track
                {likelyPaths.length === 1 ? "" : "s"}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Identified automatically: one picture on five or more different artists, or tags that name a record
                pool. They are tagged “likely junk” below — use “Real cover” on any that should be left alone.
                Replacing looks each track up and only overwrites when it finds a confident match; removing strips
                the picture from every one of them.
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Button size="sm" disabled={busy} onClick={() => onFindArt(likelyPaths, true)}>
                  <Sparkles /> Replace with real artwork
                </Button>
                <Button variant="secondary" size="sm" disabled={busy} onClick={removeLikely}>
                  <Trash2 /> Remove art from all {likelyPaths.length}
                </Button>
              </div>
            </div>
          )}

          {scanned && clusters.length === 0 && (
            <p className="text-sm text-muted-foreground">No repeated pictures found across different artists.</p>
          )}

          <div className="space-y-2">
            {clusters.map((c) => (
              <div key={c.id} className={cn("flex gap-3 rounded border p-2.5", c.blocked && "border-destructive/50 bg-destructive/5")}>
                {c.thumbnail ? (
                  <img src={c.thumbnail} className="h-20 w-20 shrink-0 rounded object-cover" />
                ) : (
                  <div className="h-20 w-20 shrink-0 rounded border" />
                )}
                <div className="min-w-0 flex-1 text-xs">
                  <p className="font-medium">
                    {c.count} tracks · {c.artists} artists
                    {/* "albums" counts a blank tag as an album, so one album only
                        means "a real compilation?" when that album has a name. */}
                    {c.albums <= 1 && (c.emptyAlbums ?? 0) === 0 && !junkReason(c) && (
                      <span className="ml-2 font-normal text-amber-500">same album tag, may be a real compilation</span>
                    )}
                    {!c.blocked && junkReason(c) && !kept.has(c.id) && (
                      <span className="ml-2 font-normal text-violet" title={junkReason(c) ?? undefined}>
                        likely junk — {junkReason(c)}
                      </span>
                    )}
                    {kept.has(c.id) && <span className="ml-2 font-normal text-muted-foreground">left alone</span>}
                    {c.blocked && <span className="ml-2 font-normal text-destructive">marked junk</span>}
                  </p>
                  <p className="mt-0.5 truncate text-muted-foreground">
                    {c.samples.map((s) => `${s.artist || "?"} – ${s.title || basename(s.path)}`).join("  ·  ")}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <Button variant="secondary" size="sm" disabled={busy} onClick={() => toggle(c)}>
                      {c.blocked ? "Not junk" : "Mark as junk"}
                    </Button>
                    {!c.blocked && junkReason(c) && (
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy}
                        title="Leave this picture out of the bulk actions above"
                        onClick={() =>
                          setKept((k) => {
                            const next = new Set(k);
                            if (next.has(c.id)) next.delete(c.id);
                            else next.add(c.id);
                            return next;
                          })
                        }
                      >
                        {kept.has(c.id) ? "Include again" : "Real cover"}
                      </Button>
                    )}
                    <Button variant="secondary" size="sm" disabled={busy} onClick={() => remove(c.paths)}>
                      <Trash2 /> Remove art
                    </Button>
                    <Button variant="secondary" size="sm" disabled={busy} onClick={() => onFindArt(c.paths, true)}>
                      <Search /> Find real artwork
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {scanned && (
            <div>
              <div className="mb-2 flex items-center gap-2">
                <h3 className="text-xs font-semibold">
                  Flagged tracks ({flagged.length})
                </h3>
                {flagged.length > 0 && (
                  <>
                    <Button variant="secondary" size="sm" disabled={busy} onClick={() => remove(flaggedPaths)}>
                      <Trash2 /> Remove art from all
                    </Button>
                    <Button variant="secondary" size="sm" disabled={busy} onClick={() => onFindArt(flaggedPaths, true)}>
                      <Search /> Find real artwork for all
                    </Button>
                  </>
                )}
              </div>
              <div className="max-h-56 overflow-y-auto rounded border text-xs">
                {flagged.length === 0 && <p className="px-3 py-2 text-muted-foreground">Nothing flagged yet.</p>}
                {flagged.slice(0, 300).map((f) => (
                  <div key={f.path} className="flex gap-2 border-b px-3 py-1.5 last:border-b-0">
                    <span className="min-w-0 flex-1 truncate" title={f.path}>
                      {f.artist || "?"} – {f.title || basename(f.path)}
                    </span>
                    <span className="shrink-0 text-muted-foreground" title={f.reason}>
                      {f.width}×{f.height} · {f.reason.slice(0, 48)}
                    </span>
                  </div>
                ))}
                {flagged.length > 300 && <p className="px-3 py-1.5 text-muted-foreground">…and {flagged.length - 300} more (bulk actions include all).</p>}
              </div>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
