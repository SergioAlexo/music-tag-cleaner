import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { AlertTriangle, FolderInput, Undo2, X } from "lucide-react";

import type { Settings, TagData } from "../types";
import { Button, Card, cn } from "./ui";

export interface PlanEntry {
  from: string;
  to: string;
  status: "move" | "inPlace" | "renamed" | "error";
  note?: string | null;
}

export interface MoveResult {
  from: string;
  to: string;
  ok: boolean;
  error?: string | null;
}

export interface MoveOutcome {
  results: MoveResult[];
  csvPath?: string | null;
}

/** Looks a value up in lofty's raw field dump regardless of key casing. */
function rawField(tags: TagData, ...names: string[]): string | undefined {
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  for (const [k, v] of Object.entries(tags.allFields ?? {})) {
    if (wanted.has(k.toLowerCase()) && v) return v;
  }
  return undefined;
}

/** Tag values the backend needs to render the pattern for one track. */
export function toOrganizeItem(path: string, t: TagData | undefined) {
  return {
    path,
    genre: t?.genre,
    album: t?.album,
    albumArtist: t?.albumArtist,
    artist: t?.artist,
    title: t?.title,
    year: t?.year,
    bpm: t ? rawField(t, "bpm", "integerbpm") : undefined,
    key: t ? rawField(t, "initialkey", "key") : undefined,
    trackId: t?.trackId,
  };
}

const basename = (p: string) => p.split(/[\\/]/).pop() ?? p;

interface Props {
  paths: string[];
  settings: Settings;
  /** Reads current tags for the paths (App already has this plumbing). */
  readTags: (paths: string[]) => Promise<Record<string, TagData>>;
  onClose: () => void;
  /** Called with every successful move (also for undo) so the App can remap rows. */
  onMoved: (moves: { from: string; to: string }[]) => void | Promise<void>;
  notify: (message: string, kind?: "success" | "error" | "info") => void;
}

/**
 * "Move to collection": preview (from -> to, conflicts), then move. After the
 * move it stays open to show the result and offer Undo, because the project's
 * tag history is keyed by path and has no notion of a file changing path.
 */
export function OrganizeDialog({ paths, settings, readTags, onClose, onMoved, notify }: Props) {
  const [plan, setPlan] = useState<PlanEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<MoveOutcome | null>(null);
  const [undone, setUndone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const tags = await readTags(paths);
        const items = paths.map((p) => toOrganizeItem(p, tags[p]));
        const res = await invoke<PlanEntry[]>("organize_preview", {
          items,
          root: settings.collectionRoot,
          pattern: settings.organizePattern,
        });
        if (!cancelled) setPlan(res);
      } catch (e) {
        if (!cancelled) {
          notify(String(e), "error");
          onClose();
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const counts = useMemo(() => {
    const c = { move: 0, renamed: 0, inPlace: 0, error: 0 };
    for (const e of plan ?? []) c[e.status] += 1;
    return c;
  }, [plan]);

  const movable = (plan ?? []).filter((e) => e.status === "move" || e.status === "renamed");

  const run = async (undo: boolean) => {
    setBusy(true);
    try {
      const moves = undo
        ? (outcome?.results ?? []).filter((r) => r.ok && r.from !== r.to).map((r) => ({ from: r.from, to: r.to }))
        : movable.map((e) => ({ from: e.from, to: e.to }));
      const res = await invoke<MoveOutcome>(undo ? "organize_undo" : "organize_move", { moves });
      const okMoves = res.results.filter((r) => r.ok && r.from !== r.to).map((r) => ({ from: r.from, to: r.to }));
      await onMoved(okMoves);
      res.results.filter((r) => !r.ok).forEach((r) => notify(`${basename(r.from)}: ${r.error}`, "error"));
      if (undo) {
        setUndone(true);
        notify(`Moved ${okMoves.length} file${okMoves.length === 1 ? "" : "s"} back`, "success");
      } else {
        setOutcome(res);
        notify(`Moved ${okMoves.length} file${okMoves.length === 1 ? "" : "s"} to the collection`, "success");
      }
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const failed = outcome?.results.filter((r) => !r.ok).length ?? 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <Card className="flex max-h-[85vh] w-full max-w-4xl flex-col" >
        <div className="flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between border-b px-5 py-3.5">
            <div>
              <h2 className="text-sm font-semibold">Move to collection</h2>
              <p className="font-mono text-xs text-muted-foreground">
                {settings.collectionRoot || "(no collection folder set)"} / {settings.organizePattern}
              </p>
            </div>
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
              <X />
            </Button>
          </div>

          {!outcome && (
            <div className="flex items-start gap-2 border-b bg-amber-500/10 px-5 py-2.5 text-xs">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
              <p>
                Moving files breaks the paths stored in Rekordbox, Mixxx and other DJ software. Afterwards use
                Rekordbox's <b>Relocate</b> (or the upcoming sync). An old-path to new-path CSV is saved for that.
              </p>
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-auto">
            {plan === null ? (
              <p className="p-6 text-sm text-muted-foreground">Planning…</p>
            ) : (
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-card text-left text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">From</th>
                    <th className="px-3 py-2 font-medium">To</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.map((e) => {
                    const done = outcome?.results.find((r) => r.from === e.from);
                    return (
                      <tr key={e.from} className="border-t align-top">
                        <td className="max-w-[22rem] break-all px-3 py-1.5 font-mono" title={e.from}>
                          {e.from}
                        </td>
                        <td className="max-w-[22rem] break-all px-3 py-1.5 font-mono" title={e.to}>
                          {e.status === "error" ? "" : e.to}
                        </td>
                        <td
                          className={cn(
                            "px-3 py-1.5",
                            (e.status === "error" || done?.ok === false) && "text-destructive",
                            e.status === "renamed" && "text-amber-500",
                          )}
                        >
                          {done
                            ? done.ok
                              ? undone
                                ? "Moved back"
                                : "Moved"
                              : `Failed: ${done.error}`
                            : e.status === "move"
                              ? "Move"
                              : e.status === "inPlace"
                                ? "Already there"
                                : e.status === "renamed"
                                  ? "Name taken: adds (n)"
                                  : (e.note ?? "Error")}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t px-5 py-3">
            <span className="text-xs text-muted-foreground">
              {outcome
                ? `${outcome.results.length - failed} moved${failed ? `, ${failed} failed` : ""}`
                : plan
                  ? `${counts.move + counts.renamed} to move, ${counts.inPlace} already in place, ${counts.error} skipped`
                  : ""}
            </span>
            <div className="flex gap-2">
              {outcome?.csvPath && (
                <Button variant="outline" size="sm" onClick={() => void revealItemInDir(outcome.csvPath!)}>
                  Show path map (CSV)
                </Button>
              )}
              {outcome && !undone && (
                <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(true)}>
                  <Undo2 /> Undo move
                </Button>
              )}
              {!outcome ? (
                <>
                  <Button variant="outline" size="sm" onClick={onClose}>
                    Cancel
                  </Button>
                  <Button size="sm" disabled={busy || movable.length === 0} onClick={() => void run(false)}>
                    <FolderInput /> Move {movable.length} file{movable.length === 1 ? "" : "s"}
                  </Button>
                </>
              ) : (
                <Button size="sm" onClick={onClose}>
                  Done
                </Button>
              )}
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
