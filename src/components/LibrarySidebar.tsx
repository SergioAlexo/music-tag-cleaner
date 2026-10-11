import { useMemo, useState } from "react";
import {
  ArrowDownAZ,
  ArrowDownWideNarrow,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Disc3,
  Folder,
  Link2,
  Music2,
  RefreshCw,
  Search,
  User,
  X,
} from "lucide-react";
import type { AudioFile, IndexProgress, TagData, TrackGroup } from "../types";
import {
  arrangeFacet,
  FACETS,
  facetLabel,
  matchesFacet,
  tallyFacet,
  type Facet,
  type FacetCount,
  type FacetPick,
  type FacetSort,
} from "../lib/facets";
import { describeProgress } from "../lib/libraryRefresh";
import { cn } from "./ui";
import { SidebarFacetList } from "./SidebarFacetList";
import { SidebarTrackSearch } from "./SidebarTrackSearch";

export type SidebarMode = "folders" | "genres" | "albums" | "artists" | "tracks" | "search";

/** What the sidebar currently narrows the track table down to, if anything. */
export type SidebarFilter =
  | { mode: "folder"; value: string }
  | { mode: "artist"; value: string }
  | { mode: "facet"; pick: FacetPick }
  | { mode: "group"; value: string };

interface FolderNode {
  name: string;
  fullPath: string;
  count: number;
  children: Map<string, FolderNode>;
}

const SEP = /[/\\]/;
/** Per-facet A-Z / count preference. "genre" keeps the key the genre-only sidebar used. */
const sortKey = (facet: Facet) => `librarySidebar.${facet}Sort`;

function buildFolderTree(files: AudioFile[]): FolderNode {
  const root: FolderNode = { name: "", fullPath: "", count: 0, children: new Map() };
  for (const f of files) {
    const parts = f.path.split(SEP).filter(Boolean);
    parts.pop(); // drop the filename itself
    let node = root;
    let acc = "";
    root.count++;
    for (const part of parts) {
      acc = acc ? `${acc}${f.path.includes("\\") ? "\\" : "/"}${part}` : part;
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, fullPath: acc, count: 0, children: new Map() };
        node.children.set(part, child);
      }
      child.count++;
      node = child;
    }
  }
  return root;
}

/** Tallies raw string values (e.g. every track's genre or artist), unmerged — this is for exact-match browsing, not the fuzzy grouping Detect Genres does. */
function tally(values: (string | undefined | null)[]): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const v of values) {
    const t = v?.trim();
    if (!t) continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function FolderRow({
  node,
  depth,
  query,
  filter,
  onSelect,
}: {
  node: FolderNode;
  depth: number;
  query: string;
  filter: SidebarFilter | null;
  onSelect: (path: string) => void;
}) {
  const [open, setOpen] = useState(depth < 1);
  const children = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name));
  const q = query.trim().toLowerCase();
  const selfMatches = !q || node.name.toLowerCase().includes(q);
  const visibleChildren = q ? children.filter((c) => subtreeMatches(c, q)) : children;
  if (q && !selfMatches && visibleChildren.length === 0) return null;
  const active = filter?.mode === "folder" && filter.value === node.fullPath;

  return (
    <div>
      <div
        className={cn(
          "flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-sm hover:bg-accent",
          active && "bg-accent font-medium",
        )}
        style={{ paddingLeft: 6 + depth * 14 }}
        onClick={() => onSelect(node.fullPath)}
      >
        {children.length > 0 ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setOpen((o) => !o);
            }}
            className="shrink-0 text-muted-foreground"
          >
            {open || q ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate" title={node.fullPath}>
          {node.name}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{node.count}</span>
      </div>
      {(open || q) &&
        visibleChildren.map((c) => (
          <FolderRow key={c.fullPath} node={c} depth={depth + 1} query={query} filter={filter} onSelect={onSelect} />
        ))}
    </div>
  );
}

function subtreeMatches(node: FolderNode, q: string): boolean {
  if (node.name.toLowerCase().includes(q)) return true;
  for (const c of node.children.values()) if (subtreeMatches(c, q)) return true;
  return false;
}

/**
 * Library browser: Folders / Genres / Artists, each filtering the track
 * table down to an exact match — a plain in-memory filter over what's
 * already loaded, never a disk rescan. A search box narrows the tree/list
 * itself, separate from the table's own row search.
 *
 * Genres and Albums are the exception (both are one "facet", lib/facets.ts):
 * they list every value in the indexed library (not just the loaded files')
 * and a click *loads* it as the batch via `onFacetClick`. Without an index
 * they fall back to filtering the loaded files. Search finds any indexed
 * track and adds it to the session; Refresh re-scans the Library folder.
 */
export function LibrarySidebar({
  files,
  tags,
  trackGroups,
  width,
  collapsed,
  filter,
  libraryFacets,
  activePick,
  onFacetClick,
  onRenameFacet,
  searchFiles,
  searchTags,
  sessionPaths,
  onAddTracks,
  indexing,
  progress,
  onRefresh,
  onFilterChange,
  onWidthChange,
  onCollapsedChange,
}: {
  files: AudioFile[];
  tags: Record<string, TagData>;
  trackGroups: TrackGroup[];
  width: number;
  collapsed: boolean;
  filter: SidebarFilter | null;
  /** Every value of each facet in the library index, with counts. Empty = no index yet. */
  libraryFacets: Record<Facet, FacetCount[]>;
  /** The genre / album the current batch was loaded from, if it was loaded from one. */
  activePick: FacetPick | null;
  onFacetClick: (pick: FacetPick) => void;
  /** Retags every track in the bucket (indexed or not). */
  onRenameFacet: (pick: FacetPick, newName: string) => void;
  /** The indexed collection, for the Search tab. */
  searchFiles: AudioFile[];
  searchTags: Record<string, TagData>;
  /** Paths already in the current session. */
  sessionPaths: Set<string>;
  onAddTracks: (paths: string[]) => void;
  indexing: boolean;
  progress: IndexProgress | null;
  /** Re-runs the incremental scan; resolves to the "N new, M changed, K removed" line (null = skipped). */
  onRefresh: () => Promise<string | null>;
  onFilterChange: (filter: SidebarFilter | null) => void;
  onWidthChange: (width: number) => void;
  onCollapsedChange: (collapsed: boolean) => void;
}) {
  const [mode, setMode] = useState<SidebarMode>("folders");
  const [query, setQuery] = useState("");
  // A UI preference, not a setting: kept in localStorage so it survives a
  // restart without a settings-version bump. Storage can throw (or be empty)
  // in odd webview states, so every access is guarded.
  const [sorts, setSorts] = useState<Record<Facet, FacetSort>>(() => {
    const read = (facet: Facet): FacetSort => {
      try {
        return localStorage.getItem(sortKey(facet)) === "name" ? "name" : "count";
      } catch {
        return "count";
      }
    };
    return { genre: read("genre"), album: read("album") };
  });
  const toggleSort = (facet: Facet) => {
    const next: FacetSort = sorts[facet] === "count" ? "name" : "count";
    setSorts((prev) => ({ ...prev, [facet]: next }));
    try {
      localStorage.setItem(sortKey(facet), next);
    } catch {
      /* not persisted — fine */
    }
  };
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  const refresh = async () => {
    setRefreshNote(null);
    const note = await onRefresh().catch((e) => `Refresh failed: ${e}`);
    if (note) setRefreshNote(note);
  };

  const folderTree = useMemo(() => buildFolderTree(files), [files]);
  // The index's list wins; tallying the loaded files only covers the case
  // where there is no index to ask.
  const facetFromIndex = (facet: Facet) => libraryFacets[facet].length > 0;
  const facetItems = (facet: Facet): FacetCount[] =>
    facetFromIndex(facet) ? libraryFacets[facet] : tallyFacet(facet, files.map((f) => tags[f.path]));
  const genreItems = useMemo(
    () => facetItems("genre"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [libraryFacets.genre, files, tags],
  );
  const albumItems = useMemo(
    () => facetItems("album"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [libraryFacets.album, files, tags],
  );
  const artistCounts = useMemo(
    () => tally(files.map((f) => tags[f.path]?.artist)),
    [files, tags],
  );

  const select = (mode: "folder" | "artist" | "group", value: string) => {
    if (filter?.mode === mode && filter.value === value) onFilterChange(null);
    else onFilterChange({ mode, value });
  };
  // With an index a click loads the bucket; without one it narrows the loaded files.
  const pickFacet = (pick: FacetPick) => {
    if (facetFromIndex(pick.facet)) return onFacetClick(pick);
    if (filter?.mode === "facet" && filter.pick.facet === pick.facet && filter.pick.name === pick.name && filter.pick.artist === pick.artist) {
      onFilterChange(null);
    } else {
      onFilterChange({ mode: "facet", pick });
    }
  };

  // Width while a resize drag is in progress. The drag only re-renders this
  // sidebar; the setting is saved once, on release. Saving per mousemove wrote
  // the settings file and re-rendered the whole app ~60 times a second.
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const shownWidth = dragWidth ?? width;

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    let latest = width;
    const onMove = (ev: MouseEvent) => {
      latest = Math.max(160, Math.min(420, startWidth + ev.clientX - startX));
      setDragWidth(latest);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setDragWidth(null);
      if (latest !== startWidth) onWidthChange(latest);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp, { once: true });
  };

  if (collapsed) {
    return (
      <button
        onClick={() => onCollapsedChange(false)}
        className="flex w-6 shrink-0 items-center justify-center border-r bg-card/50 text-muted-foreground hover:bg-accent"
        title="Show library browser"
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
    );
  }

  const q = query.trim().toLowerCase();
  const arranged = (facet: Facet, items: FacetCount[]) =>
    arrangeFacet(items, sorts[facet], query, FACETS[facet].noneLabel);
  const arrangedGenres = mode === "genres" ? arranged("genre", genreItems) : [];
  const arrangedAlbums = mode === "albums" ? arranged("album", albumItems) : [];
  const activeFacetPick: FacetPick | null =
    activePick ?? (filter?.mode === "facet" ? filter.pick : null);
  const filteredArtists = q ? artistCounts.filter((a) => a.name.toLowerCase().includes(q)) : artistCounts;
  const filteredGroups = q
    ? trackGroups.filter(
        (g) =>
          g.name.toLowerCase().includes(q) ||
          g.trackId.toLowerCase().includes(q) ||
          g.formats.some((f) => f.toLowerCase().includes(q)),
      )
    : trackGroups;

  return (
    <div
      className="relative flex shrink-0 flex-col border-r bg-card/50"
      style={{ width: shownWidth }}
    >
      <div className="flex items-start gap-1 border-b p-2">
        <div className="grid min-w-0 flex-1 grid-cols-3 gap-1">
          {(
            [
              { id: "folders", label: "Folders", icon: Folder },
              { id: "genres", label: "Genres", icon: Music2 },
              { id: "albums", label: "Albums", icon: Disc3 },
              { id: "artists", label: "Artists", icon: User },
              { id: "tracks", label: "Tracks", icon: Link2 },
              { id: "search", label: "Search", icon: Search },
            ] as const
          ).map((m) => (
            <button
              key={m.id}
              onClick={() => setMode(m.id)}
              className={cn(
                "flex flex-col items-center gap-0.5 rounded-md py-1.5 text-[10px] font-medium",
                mode === m.id ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60",
              )}
              title={m.label}
            >
              <m.icon className="h-3.5 w-3.5" />
              {m.label}
            </button>
          ))}
        </div>
        <button
          onClick={() => onCollapsedChange(true)}
          className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-accent"
          title="Hide library browser"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex items-center gap-1.5 border-b px-2 py-1.5">
        <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={
            mode === "search"
              ? "Search the whole library…"
              : `Find a ${
                  mode === "folders"
                    ? "folder"
                    : mode === "genres"
                      ? "genre"
                      : mode === "albums"
                        ? "album"
                        : mode === "artists"
                          ? "artist"
                          : "track"
                }…`
          }
          className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          autoFocus={mode === "search"}
        />
        {query && (
          <button onClick={() => setQuery("")} className="shrink-0 text-muted-foreground hover:text-foreground">
            <X className="h-3 w-3" />
          </button>
        )}
        {(mode === "genres" || mode === "albums") && (
          <button
            onClick={() => toggleSort(mode === "genres" ? "genre" : "album")}
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            title={
              sorts[mode === "genres" ? "genre" : "album"] === "name"
                ? "Sorted A–Z (click to sort by track count)"
                : "Sorted by track count (click to sort A–Z)"
            }
          >
            {sorts[mode === "genres" ? "genre" : "album"] === "name" ? (
              <ArrowDownAZ className="h-3.5 w-3.5" />
            ) : (
              <ArrowDownWideNarrow className="h-3.5 w-3.5" />
            )}
          </button>
        )}
      </div>

      {filter && (
        <div
          className="flex items-center gap-1.5 border-b bg-primary/5 px-2 py-1.5 text-xs"
          title={filter.mode === "folder" ? filter.value : undefined}
        >
          <span className="min-w-0 flex-1 truncate">
            Filtered to{" "}
            <span className="font-medium">
              {filter.mode === "folder"
                ? filter.value.split(SEP).pop()
                : filter.mode === "group"
                  ? (trackGroups.find((g) => g.trackId === filter.value)?.name ?? filter.value)
                  : filter.mode === "facet"
                    ? facetLabel(filter.pick)
                    : filter.value}
            </span>
          </span>
          <button onClick={() => onFilterChange(null)} className="shrink-0 text-muted-foreground hover:text-foreground">
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {(mode === "genres" || mode === "albums") && (
        <>
          {!facetFromIndex(mode === "genres" ? "genre" : "album") && (
            <p className="px-3 pt-1.5 text-[11px] text-muted-foreground">
              Add a library folder in Settings to browse every {FACETS[mode === "genres" ? "genre" : "album"].singular}.
            </p>
          )}
          <SidebarFacetList
            facet={mode === "genres" ? "genre" : "album"}
            items={mode === "genres" ? arrangedGenres : arrangedAlbums}
            query={query}
            active={activeFacetPick}
            canRename={facetFromIndex(mode === "genres" ? "genre" : "album")}
            emptyText={`No ${mode === "genres" ? "genres" : "albums"} found.`}
            onPick={pickFacet}
            onRename={(pick, next) => onRenameFacet(pick, next)}
          />
        </>
      )}
      {mode === "search" && (
        <SidebarTrackSearch
          query={query}
          files={searchFiles}
          tags={searchTags}
          sessionPaths={sessionPaths}
          hasIndex={searchFiles.length > 0}
          onAdd={onAddTracks}
        />
      )}

      <div className={cn("overflow-y-auto p-1.5", mode === "genres" || mode === "albums" || mode === "search" ? "hidden" : "flex-1")}>
        {mode === "folders" &&
          (folderTree.children.size === 0 ? (
            <p className="px-1.5 py-2 text-xs text-muted-foreground">No folders loaded.</p>
          ) : (
            [...folderTree.children.values()]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((c) => (
                <FolderRow
                  key={c.fullPath}
                  node={c}
                  depth={0}
                  query={query}
                  filter={filter}
                  onSelect={(p) => select("folder", p)}
                />
              ))
          ))}
        {mode === "artists" &&
          (filteredArtists.length === 0 ? (
            <p className="px-1.5 py-2 text-xs text-muted-foreground">No artists found.</p>
          ) : (
            filteredArtists.map((a) => (
              <button
                key={a.name}
                onClick={() => select("artist", a.name)}
                className={cn(
                  "flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm hover:bg-accent",
                  filter?.mode === "artist" && filter.value === a.name && "bg-accent font-medium",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{a.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{a.count}</span>
              </button>
            ))
          ))}
        {mode === "tracks" &&
          (filteredGroups.length === 0 ? (
            <p className="px-1.5 py-2 text-xs text-muted-foreground">
              {trackGroups.length === 0
                ? "No multi-format tracks. Convert a file, or run Unify IDs to link matches."
                : "No tracks match."}
            </p>
          ) : (
            filteredGroups.map((g) => (
              <button
                key={g.trackId}
                onClick={() => select("group", g.trackId)}
                title={`${g.name} · Track ID ${g.trackId}`}
                className={cn(
                  "flex w-full flex-col gap-0.5 rounded-md px-1.5 py-1 text-left hover:bg-accent",
                  filter?.mode === "group" && filter.value === g.trackId && "bg-accent font-medium",
                )}
              >
                <span className="flex items-center gap-1.5">
                  <Link2 className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm">{g.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{g.paths.length}</span>
                </span>
                <span className="flex flex-wrap gap-1 pl-[18px]">
                  {g.formats.map((f) => (
                    <span
                      key={f}
                      className="rounded bg-secondary px-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground"
                    >
                      {f}
                    </span>
                  ))}
                </span>
              </button>
            ))
          ))}
      </div>

      <div className="flex items-center gap-1.5 border-t px-2 py-1.5">
        <button
          onClick={() => void refresh()}
          disabled={indexing}
          className="flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-1 text-[11px] font-medium hover:bg-accent disabled:opacity-60"
          title="Re-scan the Library folder for new, changed and removed files"
        >
          <RefreshCw className={cn("h-3 w-3", indexing && "animate-spin")} />
          Refresh
        </button>
        <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground" title={refreshNote ?? undefined}>
          {indexing ? describeProgress(progress) : (refreshNote ?? "")}
        </span>
      </div>

      <div
        className="absolute -right-1 top-0 h-full w-2 cursor-col-resize"
        onMouseDown={startResize}
        title="Drag to resize"
      />
    </div>
  );
}

/** Whether `file` matches the current sidebar filter (folder/genre/album/artist). */
export function matchesSidebarFilter(
  file: AudioFile,
  tags: Record<string, TagData>,
  filter: SidebarFilter | null,
): boolean {
  if (!filter) return true;
  if (filter.mode === "folder") {
    const sep = file.path.includes("\\") ? "\\" : "/";
    return file.path === filter.value || file.path.startsWith(filter.value + sep);
  }
  const t = tags[file.path];
  if (filter.mode === "facet") return matchesFacet(t, filter.pick);
  if (filter.mode === "group") return (t?.trackId ?? "") === filter.value;
  return (t?.artist ?? "") === filter.value;
}
