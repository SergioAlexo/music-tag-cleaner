import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { Notify } from "../hooks/useFiles";
import { listen } from "@tauri-apps/api/event";
import { AlertTriangle, Copy, EyeOff, FolderSearch, Loader2, Music, Play, RotateCcw, Square, Trash2, Wand2 } from "lucide-react";
import { TrackContextMenu, trackMenuItems, useTrackContextMenu } from "../components/TrackContextMenu";
import type { MenuEntry } from "../components/TrackContextMenu";
import type { AudioFile, DuplicateGroup, TagData } from "../types";
import { formatBytes } from "../types";
import { Button, Card, cn, selectClass } from "../components/ui";
import {
  COMPLETENESS_FIELDS,
  addSkipped,
  duplicateGroupKey,
  fileVersion,
  groupReasonLabel,
  suggestAlternates,
  suggestKeeper,
  suggestReason,
  tagCompleteness,
} from "../lib/duplicates";
import { Waveform } from "../components/Waveform";
import { formatDuration, releasePlayback, takeOverPlayback } from "../components/AudioPreview";

/** Undecided rows have no entry at all, so nothing is removed until the user chooses. */
type RowState = "keep" | "remove";

/** Thumbnails by path; null = loaded, no art. Module-level so re-scans and
 * remounts don't refetch. */
const thumbCache = new Map<string, string | null>();

/**
 * Small cover thumbnail that only loads once scrolled into view, so a scan
 * with hundreds of rows doesn't fire hundreds of `read_cover_thumbnail` calls.
 */
function RowCover({ path }: { path: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [src, setSrc] = useState<string | null | undefined>(thumbCache.get(path));

  useEffect(() => {
    if (thumbCache.has(path)) {
      setSrc(thumbCache.get(path));
      return;
    }
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        invoke<string | null>("read_cover_thumbnail", { path, size: 72 })
          .catch(() => null)
          .then((url) => {
            thumbCache.set(path, url);
            if (!cancelled) setSrc(url);
          });
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => {
      cancelled = true;
      io.disconnect();
    };
  }, [path]);

  return (
    <div
      ref={ref}
      className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded bg-secondary text-muted-foreground"
    >
      {src ? (
        <img src={src} alt="" className="h-full w-full object-cover" draggable={false} />
      ) : (
        <Music className="h-4 w-4 opacity-50" />
      )}
    </div>
  );
}

function fileFacts(f: AudioFile | undefined, t: TagData | undefined): string {
  if (!f) return "file no longer loaded";
  const parts = [
    f.format.toUpperCase(),
    f.bitrateKbps ? `${f.bitrateKbps}kbps` : null,
    f.sampleRateHz ? `${(f.sampleRateHz / 1000).toFixed(1)}kHz` : null,
    f.durationSecs ? formatDuration(f.durationSecs) : null,
    formatBytes(f.size),
    t?.hasCoverArt ? "has artwork" : "no artwork",
    `${tagCompleteness(t)}/${COMPLETENESS_FIELDS.length + 1} tags filled`,
  ].filter(Boolean);
  return parts.join(" · ");
}

export function DuplicatesPage({
  files,
  tags,
  notify,
  onDelete,
  onInspect,
  onShowInLibrary,
  skipped,
  onSkippedChange,
  alternatePolicy,
  onAlternatePolicyChange,
}: {
  files: AudioFile[];
  tags: Record<string, TagData>;
  notify: Notify;
  /** Resolves to the paths that were actually removed. */
  onDelete: (paths: string[]) => Promise<string[]>;
  onInspect: (path: string) => void;
  onShowInLibrary: (path: string) => void;
  /** Remembered skipped groups (`duplicateGroupKey` values), newest last. */
  skipped: string[];
  onSkippedChange: (next: (prev: string[]) => string[]) => void;
  /** What to suggest for "alternate version" groups. */
  alternatePolicy: "none" | "keepExtended";
  onAlternatePolicyChange: (policy: "none" | "keepExtended") => void;
}) {
  const { menu, openMenu, closeMenu } = useTrackContextMenu();
  const [menuPath, setMenuPath] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; phase: string } | null>(null);
  const [groups, setGroups] = useState<DuplicateGroup[] | null>(null);
  const [rowStates, setRowStates] = useState<Record<string, RowState>>({});
  /** Skipped groups are hidden unless the owner asks to see them again. */
  const [showSkipped, setShowSkipped] = useState(false);

  const fileByPath = useMemo(() => Object.fromEntries(files.map((f) => [f.path, f])), [files]);

  // What the app would pick, shown as a ghost tint and never applied until the
  // user clicks a button or "Apply suggestion". Derived, so it follows a
  // delete (the old keeper may be the file that just went) and the alternate-
  // versions policy without any bookkeeping. Duplicate groups: best file kept.
  // Alternate groups: nothing, unless the owner opted into "keep the extended
  // version", and then only the clear radio-edit-of-the-same-mix cases.
  const { suggestions, altReasons } = useMemo(() => {
    const sugg: Record<string, "keep" | "remove"> = {};
    const reasons: Record<string, string> = {};
    for (const g of groups ?? []) {
      if (g.kind === "alternate") {
        if (alternatePolicy !== "keepExtended") continue;
        const alt = suggestAlternates(g.paths, fileByPath, tags);
        Object.assign(sugg, alt.states);
        Object.assign(reasons, alt.reasons);
      } else {
        const keeper = suggestKeeper(g.paths, fileByPath, tags);
        for (const p of g.paths) sugg[p] = p === keeper ? "keep" : "remove";
      }
    }
    return { suggestions: sugg, altReasons: reasons };
  }, [groups, alternatePolicy, fileByPath, tags]);

  const skippedSet = useMemo(() => new Set(skipped), [skipped]);
  const keyOf = useMemo(
    () => Object.fromEntries((groups ?? []).map((g) => [g.id, duplicateGroupKey(g.paths)])),
    [groups],
  );
  const isSkipped = (g: DuplicateGroup) => skippedSet.has(keyOf[g.id]);
  const hiddenCount = (groups ?? []).filter(isSkipped).length;
  const visibleGroups = (groups ?? []).filter((g) => showSkipped || !isSkipped(g));

  // One shared <audio> for the whole page: groups can hold hundreds of rows, so
  // an element per row (what <AudioPreview> does) is off the table.
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playingPath, setPlayingPath] = useState<string | null>(null);
  const [lastPath, setLastPath] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(0);

  // Stable identity on purpose: takeOverPlayback() compares stop functions by
  // reference to decide whether the "active" player is someone else.
  const stopPlayback = useCallback(() => {
    const el = audioRef.current;
    if (el) {
      el.pause();
      el.currentTime = 0;
    }
    setPlayingPath(null);
    setTime(0);
  }, []);

  /** Release the webview's handle on the file (a playing/loaded file can't be
   * recycled cleanly on Windows). Same reason App.tsx does it for Genre Mode. */
  const unloadAudio = useCallback(() => {
    stopPlayback();
    const el = audioRef.current;
    if (el) {
      el.removeAttribute("src");
      el.load();
    }
  }, [stopPlayback]);

  useEffect(() => {
    const el = audioRef.current;
    return () => {
      if (el) {
        el.pause();
        el.removeAttribute("src");
      }
      releasePlayback(stopPlayback);
    };
  }, [stopPlayback]);

  const playAt = (path: string, fraction?: number) => {
    const el = audioRef.current;
    if (!el) return;
    const url = convertFileSrc(path);
    if (el.src !== url) {
      el.src = url;
      setTime(0);
      setDur(fileByPath[path]?.durationSecs ?? 0);
    }
    // Prefer the already-known duration so the seek needs no metadata wait;
    // a currentTime set before metadata loads is queued by the webview.
    const d = fileByPath[path]?.durationSecs || (Number.isFinite(el.duration) ? el.duration : 0);
    if (fraction != null && d) {
      el.currentTime = fraction * d;
      setTime(fraction * d);
    }
    takeOverPlayback(stopPlayback);
    el.play().catch(() => {});
    setPlayingPath(path);
    setLastPath(path);
  };

  // Space toggles the row that last played (not while typing / on a button).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" || !lastPath) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("input, textarea, select, button, [contenteditable]") || t.isContentEditable)) return;
      e.preventDefault();
      if (playingPath) stopPlayback();
      else playAt(lastPath);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /** Tooltip for a ghost-tinted button: why the app picked this. */
  const suggestionTitle = (g: DuplicateGroup, p: string): string | undefined => {
    if (g.kind === "alternate") return altReasons[p] ? `Suggested: ${altReasons[p]}` : undefined;
    const keeper = g.paths.find((q) => suggestions[q] === "keep");
    if (!keeper) return undefined;
    if (p === keeper) {
      const runnerUp = suggestKeeper(g.paths.filter((q) => q !== keeper), fileByPath, tags);
      return `Suggested: ${suggestReason(keeper, runnerUp, fileByPath, tags)}`;
    }
    return `Suggested: remove (kept file has ${suggestReason(keeper, p, fileByPath, tags)})`;
  };

  const applySuggestions = (toApply: DuplicateGroup[]) =>
    setRowStates((prev) => {
      const next = { ...prev };
      for (const g of toApply) for (const p of g.paths) if (suggestions[p]) next[p] = suggestions[p];
      return next;
    });

  const scan = async () => {
    if (!files.length) return notify("No files loaded — select a folder in Library first", "info");
    setScanning(true);
    setProgress({ done: 0, total: files.length, phase: "fingerprinting" });
    const unlisten = await listen<{ done: number; total: number; phase: string }>(
      "duplicate-scan-progress",
      (e) => setProgress(e.payload),
    );
    try {
      const result = await invoke<DuplicateGroup[]>("scan_duplicates", {
        paths: files.map((f) => f.path),
      });
      unloadAudio();
      setGroups(result);
      // Every row starts undecided (no entry) so nothing is marked for removal
      // until the user clicks; the suggestions (see the memo above) are only a
      // faint hint.
      setRowStates({});
      setShowSkipped(false);
      if (!result.length) notify("No duplicates found", "success");
      else {
        const known = new Set(skipped);
        const hidden = result.filter((g) => known.has(duplicateGroupKey(g.paths))).length;
        if (hidden === result.length)
          notify(`Nothing new: all ${hidden} group${hidden === 1 ? "" : "s"} found were skipped before`, "success");
      }
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setScanning(false);
      setProgress(null);
      unlisten();
    }
  };

  const copyTrackId = (id: string) => {
    navigator.clipboard.writeText(id).then(
      () => notify("Copied Track ID", "success"),
      (e) => notify(String(e), "error"),
    );
  };

  const menuItems = (p: string): MenuEntry[] => {
    const id = tags[p]?.trackId;
    const base = trackMenuItems({ paths: [p], onInspect });
    // Library jump first; Open / Reveal / Copy path / Inspect come from the shared list.
    const items: MenuEntry[] = [
      { icon: FolderSearch, label: "Show in Library", run: () => onShowInLibrary(p) },
      null,
      ...base,
    ];
    if (id) items.push({ icon: Copy, label: "Copy Track ID", run: () => copyTrackId(id) });
    return items;
  };

  const playDur = dur || (playingPath ? fileByPath[playingPath]?.durationSecs ?? 0 : 0);

  // A Remove left on a group that was then skipped (and is hidden) must not
  // be carried out out of sight: only groups on screen count.
  const onScreen = new Set(visibleGroups.flatMap((g) => g.paths));
  const toRemove = Object.entries(rowStates)
    .filter(([p, s]) => s === "remove" && onScreen.has(p))
    .map(([p]) => p);

  const skipGroups = (toSkip: DuplicateGroup[]) => {
    if (!toSkip.length) return;
    // A skipped group's file must not keep playing from a card that is gone.
    if (playingPath && toSkip.some((g) => g.paths.includes(playingPath))) stopPlayback();
    const keys = toSkip.map((g) => keyOf[g.id]);
    onSkippedChange((prev) => addSkipped(prev, keys));
    setRowStates((prev) => {
      const next = { ...prev };
      for (const g of toSkip) for (const p of g.paths) delete next[p];
      return next;
    });
  };
  const unskipGroup = (g: DuplicateGroup) => onSkippedChange((prev) => prev.filter((k) => k !== keyOf[g.id]));
  /** Groups on screen with no Keep/Remove decision at all. */
  const undecided = visibleGroups.filter((g) => !isSkipped(g) && !g.paths.some((p) => rowStates[p]));
  const removeBytes = toRemove.reduce((sum, p) => sum + (fileByPath[p]?.size ?? 0), 0);

  const runDelete = async () => {
    if (playingPath && toRemove.includes(playingPath)) unloadAudio();
    // Only rows whose file really went to the Recycle Bin disappear; one that
    // couldn't be deleted (locked, permissions) stays, still marked Remove.
    const gone = new Set(await onDelete(toRemove));
    if (gone.size) {
      const remaining =
        groups
          ?.map((g) => ({ ...g, paths: g.paths.filter((p) => !gone.has(p)) }))
          .filter((g) => g.paths.length > 1) ?? null;
      setGroups(remaining);
      setRowStates((prev) => {
        const next = { ...prev };
        for (const p of gone) delete next[p];
        return next;
      });
    }
  };

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <audio
        ref={audioRef}
        preload="none"
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDur(e.currentTarget.duration)}
        onEnded={stopPlayback}
      />
      {menu && menuPath && (
        <TrackContextMenu
          menu={menu}
          items={menuItems(menuPath)}
          onRun={(fn) => {
            closeMenu();
            Promise.resolve(fn()).catch((e) => notify(String(e), "error"));
          }}
        />
      )}
      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-bold">Duplicates</h1>
          <p className="text-sm text-muted-foreground">
            Compares the audio itself (acoustic fingerprint), then artist and title for different edits of one
            song — {files.length} loaded track
            {files.length === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex shrink-0 items-end gap-3">
          <label className="text-xs text-muted-foreground">
            <span className="mb-1 block">For alternate versions (radio vs extended)</span>
            <select
              className={cn(selectClass, "w-64")}
              value={alternatePolicy}
              onChange={(e) => onAlternatePolicyChange(e.target.value as "none" | "keepExtended")}
              title="Only ever a suggestion: nothing is removed until you click Remove. Instrumentals, acapellas, intro edits and other remixes are never suggested."
            >
              <option value="none">Suggest nothing</option>
              <option value="keepExtended">Suggest keeping the extended, removing radio edits</option>
            </select>
          </label>
          <Button variant="secondary" onClick={scan} disabled={scanning || !files.length}>
            {scanning ? <Loader2 className="animate-spin" /> : <Copy />}
            {scanning ? "Scanning…" : "Scan for Duplicates"}
          </Button>
        </div>
      </div>

      {scanning && progress && (
        <div className="flex items-center gap-3 rounded-lg border bg-card px-4 py-3 text-sm">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
          <span className="flex-1">
            {progress.phase === "fingerprinting" ? "Fingerprinting" : "Comparing"} {progress.done} of{" "}
            {progress.total}
          </span>
          <div className="h-1.5 w-40 overflow-hidden rounded-full bg-secondary">
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }}
            />
          </div>
        </div>
      )}

      {groups === null ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Scan the loaded collection to find duplicate and alternate-version tracks.
        </div>
      ) : groups.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          No duplicates found in the loaded collection.
        </div>
      ) : (
        <>
          {hiddenCount > 0 && (
            <div className="flex items-center gap-3 rounded-lg border bg-card px-4 py-2 text-sm">
              <EyeOff className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="flex-1 text-muted-foreground">
                {showSkipped
                  ? `Showing ${hiddenCount} group${hiddenCount === 1 ? "" : "s"} you skipped before`
                  : `${hiddenCount} group${hiddenCount === 1 ? "" : "s"} you skipped before ${hiddenCount === 1 ? "is" : "are"} hidden`}
              </span>
              <Button variant="ghost" size="sm" onClick={() => setShowSkipped((v) => !v)}>
                {showSkipped ? "Hide skipped" : "Show skipped"}
              </Button>
            </div>
          )}
          {visibleGroups.length === 0 && (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              Nothing left to review — every group found was skipped before.
            </div>
          )}
          <div className={cn("flex-1 space-y-4 overflow-y-auto pr-1", visibleGroups.length === 0 && "hidden")}>
            {visibleGroups.map((g) => (
              <Card key={g.id} className={cn("p-4", isSkipped(g) && "opacity-70")}>
                <div className="mb-2 flex items-center gap-2">
                  {g.kind === "alternate" ? (
                    <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
                  ) : (
                    <Copy className="h-4 w-4 shrink-0 text-primary" />
                  )}
                  <span className="text-sm font-semibold">
                    {g.kind === "alternate" ? "Alternate versions" : "Duplicate"} — {g.paths.length} files
                  </span>
                  <span className="min-w-0 truncate text-xs text-muted-foreground">
                    {groupReasonLabel(g.reason)}
                    {g.kind === "alternate"
                      ? g.paths.some((p) => suggestions[p])
                        ? " · different edits — shorter radio edit suggested for removal"
                        : " · different edits — nothing suggested"
                      : ` · match score ${g.score.toFixed(1)}`}
                  </span>
                  {isSkipped(g) && (
                    <span className="shrink-0 rounded border border-input px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                      skipped
                    </span>
                  )}
                  <div className="ml-auto flex shrink-0 gap-1">
                    {g.paths.some((p) => suggestions[p]) && (
                      <Button variant="ghost" size="sm" onClick={() => applySuggestions([g])}>
                        <Wand2 />
                        Apply suggestion
                      </Button>
                    )}
                    {isSkipped(g) ? (
                      <Button variant="ghost" size="sm" onClick={() => unskipGroup(g)} title="Show this group in future scans again">
                        <RotateCcw />
                        Un-skip
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => skipGroups([g])}
                        title="Leave these files as they are and hide this group from now on (Show skipped brings it back)"
                      >
                        <EyeOff />
                        Skip
                      </Button>
                    )}
                  </div>
                </div>
                <div className="space-y-1.5">
                  {g.paths.map((p) => {
                    const f = fileByPath[p];
                    const state = rowStates[p];
                    const trackId = tags[p]?.trackId;
                    const version = fileVersion(p, fileByPath, tags);
                    return (
                      <div
                        key={p}
                        className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-accent/40"
                        onContextMenu={(e) => {
                          setMenuPath(p);
                          openMenu(e, [p]);
                        }}
                      >
                        <RowCover path={p} />
                        <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <button
                            className="min-w-0 flex-1 truncate text-left text-sm"
                            onClick={() => onInspect(p)}
                            title={p}
                          >
                            {f?.filename ?? p}
                            <span className="ml-2 text-xs text-muted-foreground">{fileFacts(f, tags[p])}</span>
                          </button>
                          {/* Which edit this is, so radio vs extended reads at a glance. */}
                          {g.kind === "alternate" && version.kind !== "plain" && (
                            <span
                              className={cn(
                                "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
                                version.kind === "extended"
                                  ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                                  : version.kind === "radio"
                                    ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                                    : "bg-secondary text-muted-foreground",
                              )}
                              title={version.label}
                            >
                              {version.kind === "extended"
                                ? "Extended"
                                : version.kind === "radio"
                                  ? "Radio / short edit"
                                  : version.label.slice(0, 28)}
                            </span>
                          )}
                          {trackId && (
                            <button
                              className="shrink-0 rounded border border-input bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-accent"
                              title="Copy Track ID"
                              onClick={() => copyTrackId(trackId)}
                            >
                              {trackId}
                            </button>
                          )}
                          <div className="flex shrink-0 gap-1">
                            {(["keep", "remove"] as const).map((s) => (
                              <button
                                key={s}
                                // Clicking the active button again un-sets it (undecided).
                                onClick={() =>
                                  setRowStates((prev) => {
                                    const next = { ...prev };
                                    if (next[p] === s) delete next[p];
                                    else next[p] = s;
                                    return next;
                                  })
                                }
                                className={cn(
                                  "rounded-md border px-2 py-1 text-xs font-medium capitalize",
                                  state === s
                                    ? s === "remove"
                                      ? "border-destructive bg-destructive text-destructive-foreground"
                                      : "border-emerald-600 bg-emerald-600 text-white"
                                    : suggestions[p] === s
                                      ? s === "keep"
                                        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600/70 dark:text-emerald-400/70"
                                        : "border-destructive/40 bg-destructive/10 text-destructive/70"
                                      : "border-input bg-background text-muted-foreground hover:bg-accent",
                                )}
                                title={state !== s && suggestions[p] === s ? suggestionTitle(g, p) : undefined}
                              >
                                {s}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div className="mt-1 flex items-center gap-2">
                          <button
                            onClick={() => (playingPath === p ? stopPlayback() : playAt(p, undefined))}
                            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-input bg-background text-muted-foreground hover:bg-accent"
                            title={playingPath === p ? "Stop" : "Play"}
                          >
                            {playingPath === p ? <Square className="h-3 w-3" /> : <Play className="h-3 w-3" />}
                          </button>
                          <Waveform
                            path={p}
                            height={32}
                            className="min-w-0 flex-1"
                            onSeek={(fr) => playAt(p, fr)}
                            progress={playingPath === p && playDur ? time / playDur : undefined}
                          />
                          {/* Fixed-width slot, always rendered, so the waveform never
                              resizes when playback starts or stops. */}
                          <span className="w-[13ch] shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
                            {playingPath === p
                              ? `${formatDuration(time)} / ${formatDuration(playDur)}`
                              : `0:00 / ${formatDuration(f?.durationSecs ?? 0)}`}
                          </span>
                        </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Card>
            ))}
          </div>

          <div className="flex items-center justify-between rounded-lg border bg-card px-4 py-3">
            <span className="text-sm text-muted-foreground">
              {toRemove.length} file{toRemove.length === 1 ? "" : "s"} marked for removal
              {toRemove.length > 0 && ` (${formatBytes(removeBytes)})`}
            </span>
            <div className="mr-auto ml-3 flex gap-1">
              {visibleGroups.some((g) => !isSkipped(g) && g.paths.some((p) => suggestions[p])) && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => applySuggestions(visibleGroups.filter((g) => !isSkipped(g)))}
                >
                  <Wand2 />
                  Apply all suggestions
                </Button>
              )}
              {undecided.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => skipGroups(undecided)}
                  title="Hide every group with nothing marked in it, now and in future scans"
                >
                  <EyeOff />
                  Skip the {undecided.length} undecided
                </Button>
              )}
            </div>
            <Button variant="destructive" onClick={runDelete} disabled={toRemove.length === 0}>
              <Trash2 />
              Remove {toRemove.length || ""} to Recycle Bin
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
