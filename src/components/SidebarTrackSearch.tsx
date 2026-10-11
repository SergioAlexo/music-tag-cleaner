import { useDeferredValue, useMemo, useState } from "react";
import { Check, Plus } from "lucide-react";
import type { AudioFile, TagData } from "../types";
import { searchTracks } from "../lib/trackSearch";
import { cn } from "./ui";
import { VirtualList } from "./VirtualList";

/** More than anyone scrolls, small enough that sorting hits stays instant. */
const RESULT_LIMIT = 2000;
const ROW_HEIGHT = 46;

/**
 * Search the whole library index and add tracks to the current session.
 *
 * Uses `searchTracks` (the one search implementation) over the indexed tracks,
 * not just the loaded ones. Results are windowed because a broad query on a
 * 4000+ track collection matches thousands of rows. Buttons only, never drag
 * (see CLAUDE.md: a content drag freezes the renderer).
 */
export function SidebarTrackSearch({
  query,
  files,
  tags,
  sessionPaths,
  hasIndex,
  onAdd,
}: {
  query: string;
  /** Every indexed track. */
  files: AudioFile[];
  tags: Record<string, TagData>;
  /** Paths already in the current session, so they read "In session". */
  sessionPaths: Set<string>;
  hasIndex: boolean;
  onAdd: (paths: string[]) => void;
}) {
  // The haystacks are cached per track, but ranking 4000 hits still takes a
  // beat; deferring keeps typing responsive while results catch up.
  const deferred = useDeferredValue(query);
  const hits = useMemo(
    () => (deferred.trim() ? searchTracks(files, tags, deferred, RESULT_LIMIT) : []),
    [files, tags, deferred],
  );
  const [picked, setPicked] = useState<Set<string>>(new Set());

  if (!hasIndex) {
    return (
      <p className="px-3 py-3 text-xs text-muted-foreground">
        Add a library folder in Settings to search the whole library.
      </p>
    );
  }
  if (!deferred.trim()) {
    return (
      <p className="px-3 py-3 text-xs text-muted-foreground">
        Search the whole library: title, artist, album, BPM or key. Try <code>bpm:128</code> or <code>key:8A</code>.
      </p>
    );
  }
  if (hits.length === 0) {
    return <p className="px-3 py-3 text-xs text-muted-foreground">No tracks match.</p>;
  }

  const addable = hits.filter((h) => !sessionPaths.has(h.file.path));
  const chosen = [...picked].filter((p) => !sessionPaths.has(p));
  const toggle = (path: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  const add = (paths: string[]) => {
    onAdd(paths);
    setPicked(new Set());
  };

  return (
    <>
      <div className="flex items-center gap-1.5 border-b px-2 py-1 text-[11px] text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">
          {hits.length >= RESULT_LIMIT ? `First ${RESULT_LIMIT.toLocaleString()}` : hits.length.toLocaleString()}{" "}
          result{hits.length === 1 ? "" : "s"}
        </span>
        <button
          className="shrink-0 rounded px-1 hover:bg-accent hover:text-foreground disabled:opacity-40"
          disabled={addable.length === 0}
          onClick={() => setPicked(new Set(addable.map((h) => h.file.path)))}
        >
          Select all
        </button>
        <button
          className="shrink-0 rounded bg-primary px-1.5 py-0.5 font-medium text-primary-foreground disabled:opacity-40"
          disabled={chosen.length === 0}
          onClick={() => add(chosen)}
          title="Add the ticked tracks to this session"
        >
          Add {chosen.length}
        </button>
      </div>
      <VirtualList
        count={hits.length}
        rowHeight={ROW_HEIGHT}
        resetKey={deferred}
        className="p-1"
        renderRow={(i) => {
          const { file } = hits[i];
          const t = tags[file.path];
          const inSession = sessionPaths.has(file.path);
          const title = t?.title || file.filename;
          const sub = [t?.artist, t?.album].filter(Boolean).join(" · ");
          const meta = [t?.bpm && `${Math.round(Number(t.bpm)) || t.bpm} BPM`, t?.key].filter(Boolean).join(" · ");
          return (
            <div
              key={file.path}
              style={{ height: ROW_HEIGHT }}
              className="flex items-center gap-1.5 rounded-md px-1 hover:bg-accent/60"
              title={file.path}
            >
              <input
                type="checkbox"
                className="shrink-0"
                disabled={inSession}
                checked={picked.has(file.path) && !inSession}
                onChange={() => toggle(file.path)}
              />
              <span className="flex min-w-0 flex-1 flex-col leading-tight">
                <span className="truncate text-xs font-medium">{title}</span>
                <span className="truncate text-[10px] text-muted-foreground">{sub || "—"}</span>
                {meta && <span className="truncate text-[10px] text-muted-foreground">{meta}</span>}
              </span>
              {inSession ? (
                <span className="flex shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground">
                  <Check className="h-3 w-3" /> In session
                </span>
              ) : (
                <button
                  className={cn(
                    "flex shrink-0 items-center gap-0.5 rounded border px-1.5 py-0.5 text-[11px] font-medium",
                    "hover:bg-accent",
                  )}
                  onClick={() => add([file.path])}
                  title="Add this track to the current session"
                >
                  <Plus className="h-3 w-3" /> Add
                </button>
              )}
            </div>
          );
        }}
      />
    </>
  );
}
