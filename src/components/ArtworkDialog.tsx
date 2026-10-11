import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Image as ImageIcon, Loader2, ScanSearch, Search, Trash2, X } from "lucide-react";

import type { TagReadResult } from "../types";
import type { HistoryChange } from "../hooks/useHistory";
import {
  goodEnough,
  pickBest,
  rankCandidates,
  type ArtworkCandidate,
  type RankedCandidate,
  type TrackQuery,
} from "../lib/artworkMatch";
import { Button, Card, cn, selectClass } from "./ui";

interface ArtworkChange {
  beforeDataUrl: string;
  afterDataUrl: string;
}

const SOURCE_LABEL = { musicbrainz: "MusicBrainz", itunes: "iTunes", deezer: "Deezer" } as const;
const basename = (p: string) => p.split(/[\\/]/).pop() ?? p;

/**
 * Looks a track up source by source — MusicBrainz/Cover Art Archive first,
 * then iTunes, then Deezer — and stops as soon as a source produced a result
 * good enough to trust. `all` keeps going regardless (the "try other sources"
 * button).
 */
export async function findArtworkCandidates(q: TrackQuery, all = false): Promise<RankedCandidate[]> {
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
  return rankCandidates(q, pool).slice(0, 6);
}

function queryFor(r: TagReadResult | undefined, durationSecs?: number): TrackQuery | null {
  const t = r?.tags;
  if (!t?.title) return null;
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
  /** Records the writes in undo history and refreshes thumbnails. */
  onApplied: (changes: HistoryChange[], label: string) => void;
  onClose: () => void;
}

type RowState = { status: "pending" | "searching" | "applied" | "low" | "none" | "error"; note?: string };

/** "Find artwork": one track shows candidates to choose from; several run an auto-pick. */
export function ArtworkDialog({ paths, durations, artworkMaxDim, artworkJpegQuality, onApplied, onClose }: FindProps) {
  const bulk = paths.length > 1;
  const [queries, setQueries] = useState<Record<string, TrackQuery | null>>({});
  const [current, setCurrent] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<RankedCandidate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [threshold, setThreshold] = useState(0.85);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const cancel = useRef(false);

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
    let live = true;
    (async () => {
      const tags = await invoke<TagReadResult[]>("read_tags_batch", { paths });
      if (!live) return;
      const byPath = Object.fromEntries(tags.map((t) => [t.path, t]));
      setQueries(Object.fromEntries(paths.map((p) => [p, queryFor(byPath[p], durations[p])])));
      if (!bulk) {
        const art = await invoke<string | null>("read_cover_art", { path: paths[0] }).catch(() => null);
        if (live) setCurrent(art);
      }
    })().catch((e) => live && setError(String(e)));
    return () => {
      live = false;
      cancel.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const single = paths[0];
  const q = queries[single];

  const search = async (all = false) => {
    if (!q) return;
    setBusy(true);
    setError(null);
    try {
      setCandidates(await findArtworkCandidates(q, all));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!bulk && q) void search();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q?.title, q?.artist]);

  const choose = async (c: ArtworkCandidate) => {
    setBusy(true);
    setError(null);
    try {
      const change = await apply(single, c);
      onApplied([change], "Find artwork");
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const autoPick = async () => {
    cancel.current = false;
    setBusy(true);
    const changes: HistoryChange[] = [];
    const set = (p: string, s: RowState) => setRows((r) => ({ ...r, [p]: s }));
    for (const p of paths) {
      if (cancel.current) break;
      const pq = queries[p];
      if (!pq) {
        set(p, { status: "none", note: "no title tag" });
        continue;
      }
      set(p, { status: "searching" });
      try {
        const ranked = await findArtworkCandidates(pq);
        const best = pickBest(ranked, threshold);
        if (!best) {
          set(p, ranked.length ? { status: "low", note: `best match ${Math.round(ranked[0].confidence * 100)}%` } : { status: "none" });
          continue;
        }
        changes.push(await apply(p, best));
        set(p, { status: "applied", note: `${SOURCE_LABEL[best.source]} · ${best.release}` });
      } catch (e) {
        set(p, { status: "error", note: String(e) });
      }
    }
    if (changes.length) onApplied(changes, `Find artwork (${changes.length})`);
    setBusy(false);
  };

  const done = Object.values(rows).filter((r) => r.status === "applied").length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <Card className="flex max-h-full w-[720px] flex-col overflow-hidden">
        <div className="flex items-start justify-between gap-4 border-b px-5 py-3.5">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <ImageIcon className="h-4 w-4" /> Find artwork
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {bulk
                ? `${paths.length} tracks · MusicBrainz, then iTunes, then Deezer`
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
                <p className="mb-1 text-xs text-muted-foreground">
                  {busy && !candidates ? "Searching…" : candidates?.length ? "Pick one to embed" : "Candidates"}
                </p>
                {!q && <p className="text-sm">This file has no title tag, so there is nothing to search for.</p>}
                {candidates && candidates.length === 0 && !busy && (
                  <p className="text-sm text-muted-foreground">Nothing found. Try the other sources, or check the artist and title tags.</p>
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
              <div className="flex items-center gap-3 text-sm">
                <label className="text-xs text-muted-foreground">Only write when the match is at least</label>
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
              </div>
              <div className="max-h-72 overflow-y-auto rounded border text-xs">
                {paths.map((p) => {
                  const s = rows[p];
                  return (
                    <div key={p} className="flex items-center gap-2 border-b px-3 py-1.5 last:border-b-0">
                      <span className="min-w-0 flex-1 truncate" title={p}>
                        {basename(p)}
                      </span>
                      <span
                        className={cn(
                          "shrink-0 text-muted-foreground",
                          s?.status === "applied" && "text-green-500",
                          s?.status === "error" && "text-destructive",
                        )}
                        title={s?.note}
                      >
                        {s ? { pending: "", searching: "searching…", applied: "applied", low: "skipped (low confidence)", none: "nothing found", error: "error" }[s.status] : ""}
                        {s?.note && s.status !== "searching" ? ` · ${s.note.slice(0, 40)}` : ""}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-5 py-3">
          {!bulk && (
            <Button variant="secondary" size="sm" disabled={busy || !q} onClick={() => search(true)}>
              <Search /> Try all sources
            </Button>
          )}
          {bulk && (
            <Button size="sm" disabled={busy} onClick={autoPick}>
              <Search /> {done ? `Auto-pick again` : "Auto-pick best"}
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={onClose}>
            {busy && bulk ? "Stop" : "Close"}
          </Button>
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
  hash: string;
  count: number;
  artists: number;
  albums: number;
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
  /** Opens the Find artwork dialog for these files. */
  onFindArt: (paths: string[]) => void;
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
    load().then(() => setScanned(true)).catch(() => {});
  }, []);

  const toggle = async (c: Cluster) => {
    try {
      await invoke("artwork_blocklist_set", {
        hash: c.hash,
        label: c.samples[0]?.album || c.samples[0]?.artist || "",
        blocked: !c.blocked,
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <Card className="flex max-h-full w-[780px] flex-col overflow-hidden">
        <div className="flex items-start justify-between gap-4 border-b px-5 py-3.5">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <ScanSearch className="h-4 w-4" /> Junk artwork
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              The same picture on many unrelated artists is almost always a DJ-pool logo. Mark it as junk to flag it in every future scan.
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
            <span className="text-xs text-muted-foreground">Uses the library index; unchanged files are skipped.</span>
          </div>

          {scanned && clusters.length === 0 && (
            <p className="text-sm text-muted-foreground">No repeated pictures found across different artists.</p>
          )}

          <div className="space-y-2">
            {clusters.map((c) => (
              <div key={c.hash} className={cn("flex gap-3 rounded border p-2.5", c.blocked && "border-destructive/50 bg-destructive/5")}>
                {c.thumbnail ? (
                  <img src={c.thumbnail} className="h-20 w-20 shrink-0 rounded object-cover" />
                ) : (
                  <div className="h-20 w-20 shrink-0 rounded border" />
                )}
                <div className="min-w-0 flex-1 text-xs">
                  <p className="font-medium">
                    {c.count} tracks · {c.artists} artists
                    {c.albums <= 1 && <span className="ml-2 font-normal text-amber-500">same album tag, may be a real compilation</span>}
                    {c.blocked && <span className="ml-2 font-normal text-destructive">marked junk</span>}
                  </p>
                  <p className="mt-0.5 truncate text-muted-foreground">
                    {c.samples.map((s) => `${s.artist || "?"} – ${s.title || basename(s.path)}`).join("  ·  ")}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <Button variant="secondary" size="sm" disabled={busy} onClick={() => toggle(c)}>
                      {c.blocked ? "Not junk" : "Mark as junk"}
                    </Button>
                    <Button variant="secondary" size="sm" disabled={busy} onClick={() => remove(c.paths)}>
                      <Trash2 /> Remove art
                    </Button>
                    <Button variant="secondary" size="sm" disabled={busy} onClick={() => onFindArt(c.paths)}>
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
                    <Button variant="secondary" size="sm" disabled={busy} onClick={() => onFindArt(flaggedPaths)}>
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
