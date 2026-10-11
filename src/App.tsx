import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirm, open, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { requestFocusPath } from "./lib/focusPath";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { audioDir, join as joinPath } from "@tauri-apps/api/path";
import { listen } from "@tauri-apps/api/event";
import { Upload, X } from "lucide-react";

import { Sidebar, type Page } from "./components/Sidebar";
import StatusBar from "./components/StatusBar";
import type { ManualResults } from "./components/ManualAIDialog";
import type { ConvertOptions } from "./components/ConvertDialog";
import type { UnifyGroup } from "./components/UnifyDialog";
import { Button, Card, cn } from "./components/ui";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { buildCleanRows, useAI } from "./hooks/useAI";
import { useCovers } from "./hooks/useCovers";
import { useImageInfo } from "./hooks/useImageInfo";
import { useAnalytics } from "./hooks/useAnalytics";
import { useFiles, type NotifyOpts } from "./hooks/useFiles";
import { useHistory, type HistoryChange } from "./hooks/useHistory";
import { useSettings } from "./hooks/useSettings";
import { useLibraryIndex, mergeWithSession } from "./hooks/useLibraryIndex";
import { useRekordboxLookup, withRekordbox } from "./hooks/useRekordbox";
import { buildRekordboxSyncPreview } from "./lib/rekordboxSync";
import { useTags } from "./hooks/useTags";
import { OrganizeDialog, toOrganizeItem } from "./components/OrganizeDialog";
import { LibraryPage } from "./pages/LibraryPage";
import { ALL_COLUMNS } from "./components/TrackTable";
import { useActionBridge } from "./hooks/useActionBridge";
import { useGenreLoad } from "./hooks/useGenreLoad";
import { describeRefresh, refreshChangedAnything } from "./lib/libraryRefresh";
import { buildLanguagePreview, normalizeLanguageCode, type LangSuggestion } from "./lib/language";
import { describeLyricsTally, tallyLyrics, type LyricsResult } from "./lib/lyrics";
import { LyricsPanel } from "./components/LyricsPanel";
import { FACETS, matchesFacet, type Facet, type FacetPick } from "./lib/facets";
import { useSessionTabs } from "./hooks/useSessionTabs";
import {
  applyCapitalization,
  applyReplacements,
  buildRenameStem,
  buildTrackIdMigrationPreview,
  formatTrackId,
  isUid,
  removeCharsFrom,
} from "./lib/standardize";
import { detectGenreGroups, libraryGenreNames } from "./lib/genres";
import { matchesShortcut } from "./lib/shortcuts";
import { internalDrag } from "./lib/internalDrag";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  basename,
  FIELD_LABELS,
  formatBytes,
  type AudioFile,
  type Capitalization,
  type ClaudeCliInfo,
  type ConvertOutcome,
  type DemucsInfo,
  type DuplicateGroup,
  type FfmpegInfo,
  type PendingChange,
  type PreviewMode,
  type Settings,
  type TagData,
} from "./types";

/**
 * Everything that isn't the Library page — the app's landing screen — is split
 * into its own chunk so the initial bundle the webview parses at launch stays
 * small. `prefetchSecondaryChunks` pulls them in once the app is idle, so the
 * first click on Settings or Duplicates is still instant.
 */
const ComponentsPage = lazy(() =>
  import("./pages/ComponentsPage").then((m) => ({ default: m.ComponentsPage })),
);
const DuplicatesPage = lazy(() =>
  import("./pages/DuplicatesPage").then((m) => ({ default: m.DuplicatesPage })),
);
const YtMusicImportPage = lazy(() =>
  import("./pages/YtMusicImportPage").then((m) => ({ default: m.YtMusicImportPage })),
);
const SettingsPage = lazy(() =>
  import("./pages/SettingsPage").then((m) => ({ default: m.SettingsPage })),
);
const LogsPage = lazy(() => import("./pages/LogsPage").then((m) => ({ default: m.LogsPage })));
const ManualAIDialog = lazy(() =>
  import("./components/ManualAIDialog").then((m) => ({ default: m.ManualAIDialog })),
);
const ConvertDialog = lazy(() =>
  import("./components/ConvertDialog").then((m) => ({ default: m.ConvertDialog })),
);
const ArtworkDialog = lazy(() =>
  import("./components/ArtworkDialog").then((m) => ({ default: m.ArtworkDialog })),
);
const JunkArtDialog = lazy(() =>
  import("./components/ArtworkDialog").then((m) => ({ default: m.JunkArtDialog })),
);
const StemsDialog = lazy(() =>
  import("./components/StemsDialog").then((m) => ({ default: m.StemsDialog })),
);
const UnifyDialog = lazy(() =>
  import("./components/UnifyDialog").then((m) => ({ default: m.UnifyDialog })),
);

function prefetchSecondaryChunks() {
  void import("./pages/SettingsPage");
  void import("./pages/DuplicatesPage");
  void import("./pages/LogsPage");
  void import("./pages/ComponentsPage");
  void import("./pages/YtMusicImportPage");
  void import("./components/ManualAIDialog");
  void import("./components/ConvertDialog");
  void import("./components/StemsDialog");
  void import("./components/UnifyDialog");
}

interface Toast {
  id: number;
  message: string;
  kind: "success" | "error" | "info";
}

export interface LogEntry {
  id: number;
  time: number;
  message: string;
  kind: "success" | "error" | "info";
  /** Structured context for this entry (a fetched URL, a match's score and
   * runner-ups, an export's file list, …) — shown expanded in the Logs page
   * and included when the log is copied. */
  details?: unknown;
}

const LOG_LIMIT = 500;

/** Files per `read_tags_batch` call when filling the table in the background. */
const TAG_READ_CHUNK = 200;

let toastId = 0;

export default function App() {
  const { settings, save, update, loaded } = useSettings();
  /** Merges a partial change into the newest settings (see `update`). */
  const savePatch = useCallback(
    (patch: Partial<Settings>) => void update((prev) => ({ ...prev, ...patch })),
    [update],
  );
  const [page, setPage] = useState<Page>("library");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const notify = useCallback((message: string, kind: Toast["kind"] = "info", opts?: NotifyOpts) => {
    const id = ++toastId;
    // `silent` records the log line without the on-screen toast — for
    // per-click events (confirming/denying a YT-import match, cycling a
    // candidate, …) that are too frequent to pop up but still worth having
    // in the Logs page when troubleshooting a session afterwards.
    if (!opts?.silent) {
      setToasts((prev) => [...prev, { id, message, kind }]);
      setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 5000);
    }
    setLogs((prev) => [
      ...prev.slice(-(LOG_LIMIT - 1)),
      { id, time: Date.now(), message, kind, details: opts?.details },
    ]);
  }, []);

  // Keep a live reference so async callbacks always see current settings.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const filesApi = useFiles(
    settings.recursive,
    notify,
    (folder) => {
      // `lastFolder` is the *working batch* you just opened, purely a UI
      // convenience (shown as a hint, reopened on next launch) — it must
      // never touch the Library or its roots. See the owner's mental model
      // in PLAN-v0.15-library.md: opening a batch can never shrink or
      // replace the Library.
      void update((prev) => ({ ...prev, lastFolder: folder }));
    },
    settings.lastFolder,
  );
  const tagsApi = useTags();
  const ai = useAI();
  const { covers, invalidate: invalidateCovers } = useCovers(filesApi.files);
  const imageInfoApi = useImageInfo(filesApi.files, settings.visibleColumns.includes("imageInfo"));
  const analytics = useAnalytics();
  const libraryIndex = useLibraryIndex(notify);

  // One-time prompt for a never-configured Library folder — defaults to
  // Music\Collection when it exists, so most installs need only a click.
  const [libraryPromptOpen, setLibraryPromptOpen] = useState(false);
  const [suggestedLibraryFolder, setSuggestedLibraryFolder] = useState<string | null>(null);

  // The Library's roots are always exactly `[settings.libraryFolder]` —
  // nothing else ever writes them. Opening a working batch (above) is
  // deliberately excluded, which is the whole point of this workstream: a
  // folder you open to clean up never becomes part of the permanent Library.
  const startupIndexRef = useRef(false);
  useEffect(() => {
    if (!loaded || startupIndexRef.current) return;
    startupIndexRef.current = true;
    void (async () => {
      if (settings.libraryFolder) {
        try {
          const roots = await libraryIndex.getRoots();
          if (roots.length !== 1 || roots[0] !== settings.libraryFolder) {
            await libraryIndex.setRoots([settings.libraryFolder]);
          }
          void libraryIndex.runIndex(false);
        } catch {
          // Settings' own index card still works for a manual run.
        }
        // Re-import Rekordbox BPM/key only when the export actually
        // changed since the last import — not on every launch.
        if (settings.rekordboxXmlPath) {
          try {
            const mtime = await invoke<number | null>("file_mtime_secs", {
              path: settings.rekordboxXmlPath,
            });
            if (mtime != null && mtime !== settings.rekordboxXmlMtime) {
              await libraryIndex.importRekordboxTags(settings.rekordboxXmlPath);
              void update((prev) => ({ ...prev, rekordboxXmlMtime: mtime }));
            }
          } catch {
            // Settings' own Rekordbox row still works for a manual re-import.
          }
        }
        return;
      }
      // No Library folder ever configured — ask once, suggesting this
      // user's own Music\Collection (the owner's layout) or else their Music
      // folder, whichever actually exists. This used to be a hard-coded
      // "C:\Users\sopas\..." path, which no other install could ever have.
      try {
        const music = await audioDir();
        const candidates = [await joinPath(music, "Collection"), music];
        let suggestion: string | null = null;
        for (const candidate of candidates) {
          const exists = await invoke<boolean>("path_exists", { path: candidate }).catch(
            () => false,
          );
          if (exists) {
            suggestion = candidate;
            break;
          }
        }
        setSuggestedLibraryFolder(suggestion);
      } catch {
        setSuggestedLibraryFolder(null);
      } finally {
        setLibraryPromptOpen(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  // Opt-in (`libraryAutoRefresh`): re-scan when the window regains focus, which
  // is when new downloads are most likely to be waiting. Throttled, and quiet
  // unless the scan actually found something. A file watcher would need a new
  // native dependency for little gain over this on a folder you edit elsewhere.
  const refreshFromDisk = libraryIndex.refreshFromDisk;
  useEffect(() => {
    if (!settings.libraryAutoRefresh || !settings.libraryFolder) return;
    let last = Date.now();
    const onFocus = () => {
      if (Date.now() - last < 60_000) return;
      last = Date.now();
      refreshFromDisk()
        .then((s) => {
          if (s && refreshChangedAnything(s)) {
            notify(`Library refreshed: ${describeRefresh(s)}`, "info", { silent: true });
          }
        })
        .catch(() => {});
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [settings.libraryAutoRefresh, settings.libraryFolder, refreshFromDisk, notify]);

  const chooseLibraryFolder = async (folder: string) => {
    setLibraryPromptOpen(false);
    try {
      await libraryIndex.setRoots([folder]);
      void update((prev) => ({ ...prev, libraryFolder: folder }));
      void libraryIndex.runIndex(false);
    } catch (e) {
      notify(String(e), "error");
    }
  };

  const pickLibraryFolder = async () => {
    const picked = await open({ directory: true, multiple: false, title: "Where is your music library?" });
    if (typeof picked === "string") void chooseLibraryFolder(picked);
  };
  const withTrack = (name: string, fn: () => void) => () => {
    analytics.track(name);
    fn();
  };
  const withTrack1 = <T,>(name: string, fn: (arg: T) => void) => (arg: T) => {
    analytics.track(name);
    fn(arg);
  };

  const [libraryTags, setLibraryTags] = useState<Record<string, TagData>>({});

  /**
   * The genre vocabulary: whatever the indexed collection uses, plus the
   * genres on tracks loaded right now. No stored preset — see lib/genres.ts.
   */
  const genreOptions = useMemo(
    () => libraryGenreNames(libraryIndex.genres, libraryTags),
    [libraryIndex.genres, libraryTags],
  );

  // Feeds Settings > Genres > "Detect genres" — every distinct genre spelling
  // in the collection, near-duplicates grouped together. Drawn from the index
  // when there is one, so it sees the whole library and not just what's open.
  const collectionGenreGroups = useMemo(() => {
    const fromIndex = libraryIndex.genres.flatMap((g) => Array<string>(g.count).fill(g.name));
    const fromSession = Object.values(libraryTags).map((t) => t.genre);
    return detectGenreGroups(fromIndex.length ? fromIndex : fromSession);
  }, [libraryIndex.genres, libraryTags]);

  /**
   * Everything the app knows about, for matching and search: the indexed
   * collection with this session's loaded files layered on top. See
   * `mergeWithSession` for why both halves are needed.
   */
  const wholeCollection = useMemo(
    () => mergeWithSession(libraryIndex.files, libraryIndex.tags, filesApi.files, libraryTags),
    [libraryIndex.files, libraryIndex.tags, filesApi.files, libraryTags],
  );
  const [pending, setPending] = useState<PendingChange[] | null>(null);
  // Rekordbox BPM/key/rating for whatever is loaded, from the last imported
  // rekordbox.xml. Re-asked after a re-import (mtime change).
  const loadedPaths = useMemo(() => filesApi.files.map((f) => f.path), [filesApi.files]);
  const rekordboxInfo = useRekordboxLookup(
    loadedPaths,
    settings.rekordboxXmlPath,
    settings.rekordboxXmlMtime,
  );
  const [previewMode, setPreviewMode] = useState<PreviewMode>("clear");
  const [tagsMap, setTagsMap] = useState<Record<string, TagData>>({});
  const [busy, setBusy] = useState(false);
  const [aiRunning, setAiRunning] = useState(false);
  const [backupRunning, setBackupRunning] = useState(false);

  /**
   * Refreshes the Library index rows for whichever of `paths` sit inside the
   * Library folder — after edits, and after renames/deletes too: the backend
   * drops the row of a path that no longer exists, so passing a rename's old
   * path stops it lingering as a ghost track in search and matching.
   * Compared with separators normalised, so it works for macOS paths as well
   * as Windows ones (it used to assume a trailing "\").
   */
  const reindexLibraryPaths = (paths: string[]) => {
    const root = settingsRef.current.libraryFolder;
    if (!root || !paths.length) return Promise.resolve();
    const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
    const prefix = norm(root).replace(/\/+$/, "") + "/";
    const inLibrary = [...new Set(paths)].filter((p) => norm(p).startsWith(prefix));
    return inLibrary.length ? libraryIndex.reindexPaths(inLibrary) : Promise.resolve();
  };

  const history = useHistory({
    tagsApi,
    settings,
    notify,
    busy,
    setBusy,
    invalidateCovers,
    dropLibraryTags: (paths) => dropLibraryTags(paths),
    resetLibraryTags: () => setLibraryTags({}),
    refreshPaths: (paths) => filesApi.refreshPaths(paths),
    refreshAll: () => filesApi.refresh(),
    reindexLibraryPaths,
  });
  const pushHistory = history.push;

  const genreLoad = useGenreLoad({
    libraryIndex,
    filesApi,
    tagsApi,
    libraryTags,
    setLibraryTags,
    notify,
  });

  /** Drops the open preview, asking first when it hasn't been applied. False = the user kept it. */
  const releasePreview = async () => {
    if (pending && previewMode !== "history") {
      const ok = await confirm("You have a preview that hasn't been applied. Continuing discards it.", {
        title: "Unapplied preview",
        kind: "warning",
      });
      if (!ok) return false;
    }
    setPending(null);
    return true;
  };

  const sessionTabs = useSessionTabs({
    filesApi,
    history,
    cancelGenreLoad: genreLoad.cancel,
    releasePreview,
  });

  // The three ways a library genre / album click can land (the page picks which).
  const loadLibraryFacet = async (pick: FacetPick) => {
    if (await releasePreview()) await genreLoad.loadFacet(pick);
  };
  const openFacetInNewTab = async (pick: FacetPick) => {
    if (await sessionTabs.openNewTab()) await genreLoad.loadFacet(pick);
  };
  const replaceWithFacet = async (pick: FacetPick) => {
    if (!(await releasePreview())) return;
    sessionTabs.resetHistory();
    await genreLoad.loadFacet(pick);
  };

  /** Read-only diff of every change applied so far this session, reusing the preview table. */
  const showHistoryCompare = () => {
    setPreviewMode("history");
    setPending(history.compareRows());
  };

  const [dropActive, setDropActive] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>(
    null,
  );
  const [inspected, setInspected] = useState<{ file: AudioFile; tags: TagData } | null>(null);
  /** D2 diagnostic switch for the horizontal-wheel bug (ROADMAP item 42) —
   * in-memory only, off by default, toggled from the Logs page. Not a
   * setting: it exists to collect evidence for a bug that's resisted three
   * blind fixes, not as a feature anyone should leave on. */
  const [logWheelEvents, setLogWheelEvents] = useState(false);
  // Tracks the AI could not identify from tags or filename — flagged for manual edit.
  const [unresolved, setUnresolved] = useState<Set<string>>(new Set());
  /** Open manual-AI session: the tracks and tags the copy/paste dialog works on. */
  const [manual, setManual] = useState<{
    paths: string[];
    map: Record<string, TagData>;
  } | null>(null);

  // FFmpeg-backed conversion (v0.10). `ffmpegInfo` gates the Convert dialog.
  const [ffmpegInfo, setFfmpegInfo] = useState<FfmpegInfo | null>(null);
  const [convertOpen, setConvertOpen] = useState(false);
  const [artworkPaths, setArtworkPaths] = useState<string[] | null>(null);
  const [junkArtOpen, setJunkArtOpen] = useState(false);
  /** Paths queued for stem separation; non-null means the dialog is open. */
  const [stemsPaths, setStemsPaths] = useState<string[] | null>(null);
  const [demucsInfo, setDemucsInfo] = useState<DemucsInfo | null>(null);
  /** A right-clicked file to convert on its own (vs. the whole selection). */
  const [convertSeedFile, setConvertSeedFile] = useState<AudioFile | null>(null);
  /** Preview state for "Unify Track IDs" — null when the dialog is closed. */
  const [unifyState, setUnifyState] = useState<{ groups: UnifyGroup[]; alternates: number } | null>(
    null,
  );

  const refreshFfmpeg = useCallback(async () => {
    try {
      setFfmpegInfo(await invoke<FfmpegInfo>("ffmpeg_info"));
    } catch {
      setFfmpegInfo({ installed: false, managed: false });
    }
  }, []);

  const clearUnresolved = (path: string) =>
    setUnresolved((prev) => {
      if (!prev.has(path)) return prev;
      const next = new Set(prev);
      next.delete(path);
      return next;
    });

  // Theme class on <html> (dark is the default, set in index.html).
  // "system" — the default since v0.13 — follows the OS setting live, so
  // flipping Windows to light mode retints the app without a restart. There
  // is no in-app switcher any more; the subscription is the whole feature.
  useEffect(() => {
    const apply = (dark: boolean) => document.documentElement.classList.toggle("dark", dark);
    if (settings.theme !== "system") {
      apply(settings.theme === "dark");
      return;
    }
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    apply(mq.matches);
    const onChange = (e: MediaQueryListEvent) => apply(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [settings.theme]);

  // Warm the code-split chunks once the first paint is done, so switching
  // pages or opening a dialog never waits on a chunk fetch. FFmpeg detection
  // rides along: the Convert dialog needs its answer before it can render
  // correctly, but nothing on screen at launch does, and probing it means
  // spawning `ffmpeg -version` — work worth keeping off the startup path.
  const warmUp = useCallback(() => {
    prefetchSecondaryChunks();
    void refreshFfmpeg();
  }, [refreshFfmpeg]);
  useEffect(() => {
    // Called through `window` on purpose: these are Window methods and throw
    // "Illegal invocation" when detached into a bare local.
    if (typeof window.requestIdleCallback === "function") {
      const handle = window.requestIdleCallback(warmUp, { timeout: 3000 });
      return () => window.cancelIdleCallback?.(handle);
    }
    const timer = setTimeout(warmUp, 1200);
    return () => clearTimeout(timer);
  }, [warmUp]);

  useEffect(() => {
    if (loaded) ai.check(settings.ollamaUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  // Accumulates local Ollama token usage into settings.usage as AI calls complete.
  useEffect(() => {
    const unlisten = listen<{
      model: string;
      promptEvalCount: number;
      evalCount: number;
      tracks: number;
    }>("ai-usage", (e) => {
      const { promptEvalCount, evalCount, tracks } = e.payload;
      // Accumulate against the newest settings, not a render snapshot — batches
      // can complete faster than React re-renders, and a plain read-modify-write
      // on settingsRef would drop every count but the last.
      void update((prev) => ({
        ...prev,
        usage: {
          // `?? 0`: a missing count would turn the running total into NaN,
          // which is saved as null and breaks the Settings page on next launch.
          totalPromptTokens: prev.usage.totalPromptTokens + (promptEvalCount ?? 0),
          totalCompletionTokens: prev.usage.totalCompletionTokens + (evalCount ?? 0),
          totalCalls: prev.usage.totalCalls + 1,
          songsProcessed: prev.usage.songsProcessed + (tracks ?? 0),
        },
      }));
    });
    return () => {
      unlisten.then((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Eagerly read tags for files in the list so table columns fill in.
  // Chunked so a large folder paints its first rows in a fraction of a second
  // instead of showing an empty table until every file has been parsed —
  // each chunk is still parsed across several threads on the Rust side.
  useEffect(() => {
    const missing = filesApi.files.map((f) => f.path).filter((p) => !libraryTags[p]);
    if (!missing.length) return;
    let cancelled = false;
    (async () => {
      for (let i = 0; i < missing.length; i += TAG_READ_CHUNK) {
        if (cancelled) return;
        try {
          const { map } = await tagsApi.read(missing.slice(i, i + TAG_READ_CHUNK));
          if (cancelled) return;
          setLibraryTags((prev) => ({ ...prev, ...map }));
        } catch (e) {
          console.error("Failed to read tags for table:", e);
          return;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filesApi.files]);

  /**
   * Auto-update on launch. Checks once, a few seconds in (so it never competes
   * with the first paint or the initial library scan), and installs silently
   * when `settings.autoUpdate` is on.
   *
   * The install is gated on the library still being empty. On Windows the
   * updater hands off to the NSIS/MSI installer and the running app exits, so
   * installing while tracks are loaded — or while there are pending changes —
   * would take the app out from under work in progress. At launch there is
   * nothing to lose, which is exactly why this runs here and not on a timer.
   * If the user has already loaded something by the time the check returns,
   * it stands down and leaves it to the Components page button.
   */
  // Read when the update check *resolves*, not when the effect ran, so the
  // "is the user mid-work?" gate sees the real state a few seconds later.
  const filesRef = useRef(filesApi.files);
  filesRef.current = filesApi.files;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const autoUpdateRanRef = useRef(false);
  useEffect(() => {
    if (!loaded || !settings.autoUpdate || autoUpdateRanRef.current) return;
    autoUpdateRanRef.current = true;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const found = await check();
          if (!found) return;
          if (filesRef.current.length > 0 || pendingRef.current) {
            notify(`Version ${found.version} is available — install it from Components`, "info");
            return;
          }
          notify(`Installing update ${found.version}…`, "info");
          await found.downloadAndInstall();
          notify(`Version ${found.version} installed — restarting`, "success");
          await relaunch();
        } catch (e) {
          // A failed update check must never be in the user's way on launch:
          // offline, GitHub down, or a signature mismatch all land here.
          console.error("Auto-update failed:", e);
        }
      })();
    }, 4000);
    return () => clearTimeout(timer);
  }, [loaded, settings.autoUpdate, notify]);

  // Native drag-and-drop of files/folders onto the window.
  const importPathsRef = useRef(filesApi.importPaths);
  importPathsRef.current = filesApi.importPaths;
  useEffect(() => {
    const promise = getCurrentWebview().onDragDropEvent((event) => {
      // On Windows, this fires for ANY drag over the webview — including an
      // in-page HTML5 drag like column reordering — not just an external OS
      // file drag. Ignore it while TrackTable reports one in progress, so
      // dragging a column header doesn't paint the "drop files" overlay.
      if (internalDrag.active) return;
      const p = event.payload;
      if (p.type === "over" || p.type === "enter") setDropActive(true);
      else if (p.type === "leave") setDropActive(false);
      else if (p.type === "drop") {
        setDropActive(false);
        if (p.paths?.length) void importPathsRef.current(p.paths);
      }
    });
    return () => {
      promise.then((unlisten) => unlisten());
    };
  }, []);

  // Files the app was launched with ("Open with MusicTagCleaner" in Explorer,
  // or a path on the command line). The Rust side keeps a queue; we drain it on
  // mount, whenever the "open-files" event nudges us (a later "Open with"), and
  // a couple more times to catch the burst of processes a multi-file selection
  // spawns before this webview had a listener.
  useEffect(() => {
    const drain = () =>
      invoke<string[]>("take_opened_files")
        .then((paths) => {
          if (paths.length) void importPathsRef.current(paths);
        })
        .catch(() => {});
    const promise = listen("open-files", drain);
    drain();
    const timers = [setTimeout(drain, 800), setTimeout(drain, 2500)];
    return () => {
      timers.forEach(clearTimeout);
      promise.then((unlisten) => unlisten());
    };
  }, []);

  /**
   * Drops the cached tags for just `paths`, so the "eagerly read tags" effect
   * re-parses only those files from disk. Clearing the whole `libraryTags`
   * map instead — the previous behaviour — made every single-track edit
   * (write, undo, redo) re-parse the *entire* library, which on a large
   * collection is slow enough to look like the edit did nothing.
   */
  const dropLibraryTags = (paths: string[]) => {
    setLibraryTags((prev) => {
      const next = { ...prev };
      for (const p of paths) delete next[p];
      return next;
    });
  };

  const afterWrite = async (affected: string[] = []) => {
    setPending(null);
    setInspected(null);
    if (affected.length) {
      dropLibraryTags(affected);
      // Only re-read artwork if the write could actually have changed it.
      // `write_tags` carries the existing pictures over when "Preserve
      // embedded cover art" is on, so the cached thumbnails are still valid —
      // and dropping them made every apply regenerate a thumbnail per file
      // (decode + resize + re-encode), which on a big selection pegged every
      // core for seconds afterwards and read as the app hanging.
      if (!settingsRef.current.preserveCoverArt) invalidateCovers(affected);
      setProgress({ done: 0, total: affected.length, label: "Refreshing library…" });
      await filesApi.refreshPaths(affected);
    } else {
      setLibraryTags({});
      setProgress({ done: 0, total: 0, label: "Refreshing library…" });
      await filesApi.refresh();
    }
    setProgress(null);
  };

  // Remembers the transform used to build the current standardize preview so
  // applyPending can also apply it to filenames (see standardizeFilename).
  const lastStandardizeTransformRef = useRef<((value: string) => string) | null>(null);

  const runStandardize = async (
    mode: PreviewMode,
    transform: (value: string, field: string) => string,
    emptyMessage: string,
  ) => {
    const paths = filesApi.selectedPaths;
    if (!paths.length) return notify("No files selected", "info");
    lastStandardizeTransformRef.current = (v: string) => transform(v, "filename");
    setBusy(true);
    try {
      const { map, errors } = await tagsApi.read(paths);
      errors.forEach((e) => notify(e, "error"));
      const rows = tagsApi.buildStandardizePreview(paths, map, transform, settingsRef.current.standardizeFields);
      setTagsMap(map);
      setPreviewMode(mode);
      setPending(rows);
      if (!rows.some((r) => r.changed)) notify(emptyMessage, "info");
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const runRemoveChars = () =>
    runStandardize(
      "standardize",
      (value) => removeCharsFrom(value, settingsRef.current.removeChars),
      `No "${settingsRef.current.removeChars}" characters found`,
    );

  /**
   * Capitalization pulled out of Standardize as its own action (CapitalizationMenu):
   * runs `mode` immediately and remembers it as the new default, same split-button
   * pattern as Clear Fields.
   */
  const runCapitalizationOnly = (mode: Capitalization) => {
    void update((prev) => ({ ...prev, capitalization: mode }));
    runStandardize(
      "standardize",
      (value) => applyCapitalization(value, mode, settingsRef.current.casingExceptions),
      "Nothing to change with this capitalization",
    );
  };

  /**
   * The character/separator rules (feat. normalization, bracket style, dash
   * spacing, junk-suffix removal, whitespace collapse) pulled out of
   * Standardize as their own action — everything Standardize does *except*
   * recasing.
   */
  const runCharacterRules = () =>
    runStandardize(
      "standardize",
      (value) => applyReplacements(value, settingsRef.current.replacements),
      "Nothing to change with the current character rules",
    );

  /**
   * Manual backend: read the tags, then hand the tracks to the copy/paste
   * dialog instead of calling Ollama. Nothing leaves the app on its own — the
   * user pastes the prompt into whichever AI they like.
   */
  const openManual = async () => {
    const paths = filesApi.selectedPaths;
    setBusy(true);
    try {
      const { map, errors } = await tagsApi.read(paths);
      errors.forEach((e) => notify(e, "error"));
      const valid = paths.filter((p) => map[p]);
      if (!valid.length) return notify("Could not read tags for the selected files", "error");
      setManual({ paths: valid, map });
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  /** Turns the answers pasted into the dialog into the usual preview rows. */
  const applyManualResults = (results: ManualResults) => {
    if (!manual) return;
    const { paths, map } = manual;
    setTagsMap(map);
    const { rows, unresolved: unresolvedPaths } = buildCleanRows(paths, map, results.byIndex);
    setPreviewMode("ai");
    setUnresolved(new Set(unresolvedPaths));
    setPending(rows);
    if (!rows.some((r) => r.changed)) notify("That answer changes nothing", "info");
    if (unresolvedPaths.length)
      notify(
        `${unresolvedPaths.length} track${
          unresolvedPaths.length === 1 ? "" : "s"
        } couldn't be identified — highlighted in amber. Edit them manually.`,
        "error",
      );
    setManual(null);
  };

  /**
   * Resolves which model string the selected backend should run with, or
   * null if it isn't usable — having already told the user why.
   *
   * Ollama needs a running server and a pulled model; the Claude CLI needs
   * to be installed *and signed in*, which are different failures with
   * different fixes (the copy bundled inside the Claude desktop app is
   * installed but not separately logged in, and would otherwise fail with
   * something cryptic mid-run).
   */
  const resolveAiModel = async (): Promise<string | null> => {
    if (settingsRef.current.aiBackend === "claude") {
      const info = await invoke<ClaudeCliInfo>("claude_cli_info");
      if (!info.found) {
        notify(
          "No Claude CLI found. Install it with: npm i -g @anthropic-ai/claude-code",
          "error",
        );
        return null;
      }
      if (!info.loggedIn) {
        notify(info.error ?? "The Claude CLI is not signed in — run `claude` once and log in", "error");
        return null;
      }
      // The CLI picks its own default when none is set.
      return settingsRef.current.claudeTasks.clean.model || "";
    }

    const status = await ai.check(settingsRef.current.ollamaUrl);
    if (!status.running) {
      notify(
        "Ollama not detected. Make sure Ollama is running locally. Download at ollama.com",
        "error",
      );
      return null;
    }
    const model = settingsRef.current.ollamaModel || status.models[0];
    if (!model) {
      notify("No Ollama models installed. Pull one first, e.g.: ollama pull llama3.1", "error");
      return null;
    }
    return model;
  };

  const runAIClean = async () => {
    const paths = filesApi.selectedPaths;
    if (!paths.length) return notify("No files selected", "info");

    if (settings.aiBackend === "manual") return openManual();

    const model = await resolveAiModel();
    if (model === null) return;

    setBusy(true);
    setAiRunning(true);
    // Tallied locally (rather than read back from settings.usage, which
    // updates asynchronously) so the completion toast can report this run's
    // own token cost, not the lifetime total.
    let runTokens = 0;
    const unlistenUsage = await listen<{ promptEvalCount: number; evalCount: number }>(
      "ai-usage",
      (e) => {
        runTokens += e.payload.promptEvalCount + e.payload.evalCount;
      },
    );
    try {
      const { map, errors } = await tagsApi.read(paths);
      errors.forEach((e) => notify(e, "error"));
      const {
        rows,
        stopped,
        unresolved: unresolvedPaths,
        batchErrors,
      } = await ai.runClean(
        paths,
        map,
        settings,
        model,
        (done, total) =>
          setProgress({
            done,
            total,
            label: `Processing track ${Math.min(done + 1, total)} of ${total}`,
          }),
      );
      batchErrors.forEach((e) => notify(`AI batch failed — ${e}`, "error"));
      setTagsMap(map);
      setPreviewMode("ai");
      setUnresolved(new Set(unresolvedPaths));
      const tokenNote = runTokens > 0 ? ` (${runTokens.toLocaleString()} tokens)` : "";
      if (stopped && rows.length === 0) {
        notify("AI stopped — no results to show", "info");
      } else {
        setPending(rows);
        if (stopped) notify(`AI stopped — showing results processed so far${tokenNote}`, "info");
        else if (!rows.some((r) => r.changed)) notify(`AI found nothing to change${tokenNote}`, "info");
        else if (tokenNote) notify(`AI Clean ready — review changes below${tokenNote}`, "success");
      }
      if (unresolvedPaths.length)
        notify(
          `${unresolvedPaths.length} track${
            unresolvedPaths.length === 1 ? "" : "s"
          } couldn't be identified from tags or filename — highlighted in amber. Edit them manually.`,
          "error",
        );
    } catch (e) {
      notify(String(e), "error");
    } finally {
      unlistenUsage();
      setProgress(null);
      setAiRunning(false);
      setBusy(false);
    }
  };

  const applyPending = async () => {
    if (!pending) return;
    // The Compare view reuses `pending` to render a read-only session diff. Its
    // rows carry synthetic fields (__coverArt, __raw:*) and no matching tagsMap,
    // so they must never be written back.
    if (previewMode === "history") return setPending(null);
    const affected = [...new Set(pending.map((r) => r.path))];
    setBusy(true);
    const onWriteProgress = (done: number, total: number) =>
      setProgress({ done, total, label: `Writing ${Math.min(done, total)} of ${total}` });
    try {
      const result = await tagsApi.applyUpdates(pending, tagsMap, settings, onWriteProgress);
      result.errors.forEach((e) => notify(e, "error"));
      if (result.written)
        notify(`Updated ${result.written} file${result.written === 1 ? "" : "s"}`, "success");
      // Only files that were actually written go into history: undoing a
      // change that never happened would write its "before" over whatever is
      // really there. Curated clears are `kind: "remove"`, so match those too.
      // Cleared raw frames are recorded under the `__raw:` prefix — the
      // backend can recreate a removed frame from its name, so they undo too.
      const failed = new Set(result.failedPaths ?? []);
      const changes = pending
        .filter(
          (r) =>
            r.changed &&
            r.include &&
            !failed.has(r.path) &&
            (r.kind === "update" || previewMode === "clear"),
        )
        .map((r) => ({
          path: r.path,
          field: r.raw ? `__raw:${r.field}` : r.field,
          before: r.before,
          after: r.after,
        }));
      pushHistory({
        label: previewMode === "rekordboxSync"
          ? "Rekordbox BPM/Key/Rating into tags"
          : previewMode === "language"
            ? "Detected languages"
            : `Apply ${previewMode}`,
        changes,
      });
      await afterWrite(affected);
      await autoMoveAfterSave(affected);
      if (previewMode === "standardize" && settings.standardizeFilename && lastStandardizeTransformRef.current) {
        await renameFilenamesInPlace(affected, lastStandardizeTransformRef.current);
      }
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setProgress(null);
      setBusy(false);
    }
  };

  /** Applies `transform` to each affected file's stem (extension preserved), used by Standardize's filename scope. */
  const renameFilenamesInPlace = async (paths: string[], transform: (stem: string) => string) => {
    const byPath = new Map(filesApi.files.map((f) => [f.path, f]));
    /** [old path, new path] per successful rename, re-read in one call below. */
    const renamed: [string, string][] = [];
    for (const path of paths) {
      const file = byPath.get(path);
      if (!file) continue;
      const dot = file.filename.lastIndexOf(".");
      const stem = dot > 0 ? file.filename.slice(0, dot) : file.filename;
      const newStem = transform(stem).trim();
      if (!newStem || newStem === stem) continue;
      try {
        // Sequential on purpose: collision suffixes (" (2)") are resolved
        // against what is on disk, one rename at a time.
        renamed.push([path, await invoke<string>("rename_file", { path, newStem })]);
      } catch (e) {
        notify(String(e), "error");
      }
    }
    if (!renamed.length) return;
    const updated = await invoke<AudioFile[]>("list_files", { paths: renamed.map(([, p]) => p) });
    const byNewPath = new Map(updated.map((f) => [f.path, f]));
    const mapping: Record<string, AudioFile> = {};
    for (const [oldPath, newPath] of renamed) {
      const info = byNewPath.get(newPath);
      if (info) mapping[oldPath] = info;
    }
    invalidateCovers(Object.keys(mapping));
    filesApi.remap(mapping);
    void reindexLibraryPaths(renamed.flat());
    notify(`Renamed ${renamed.length} file${renamed.length === 1 ? "" : "s"}`, "success");
  };

  /**
   * "Rekordbox → tags": previews writing Rekordbox's BPM, key and rating into
   * the selected files' own tags, through the same preview/apply/undo flow as
   * Standardize. Only fields that are missing or different produce a row.
   */
  const runRekordboxToTags = async () => {
    const paths = filesApi.selectedPaths;
    if (!paths.length) return notify("No files selected", "info");
    if (!settings.rekordboxXmlPath) return notify("Choose a rekordbox.xml in Settings first", "info");
    setBusy(true);
    try {
      const { map, errors } = await tagsApi.read(paths);
      errors.forEach((e) => notify(e, "error"));
      const selected = new Set(paths);
      const files = withRekordbox(
        filesApi.files.filter((f) => selected.has(f.path)),
        rekordboxInfo,
      );
      const rows = buildRekordboxSyncPreview(files, map);
      setTagsMap(map);
      setPreviewMode("rekordboxSync");
      setPending(rows);
      if (!rows.length) {
        notify(
          files.some((f) => rekordboxInfo[f.path])
            ? "The selected files already match Rekordbox"
            : "Rekordbox has no BPM, key or rating for the selected files (re-export the collection?)",
          "info",
        );
      }
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  /**
   * "Fetch lyrics" from LRCLIB for `paths`, stored per the Lyrics storage
   * setting (sidecar .lrc/.txt by default). Chunked so the status bar can show
   * progress; the backend caches every answer, misses included.
   */
  const runFetchLyrics = async (paths: string[]) => {
    if (!paths.length) return notify("No files selected", "info");
    setBusy(true);
    try {
      const storage = settingsRef.current.lyricsStorage;
      const results: LyricsResult[] = [];
      const CHUNK = 12;
      for (let i = 0; i < paths.length; i += CHUNK) {
        setProgress({
          done: i,
          total: paths.length,
          label: `Fetching lyrics ${Math.min(i + 1, paths.length)} of ${paths.length}`,
        });
        results.push(
          ...(await invoke<LyricsResult[]>("lyrics_fetch", {
            paths: paths.slice(i, i + CHUNK),
            storage,
            overwrite: false,
          })),
        );
      }
      const tally = tallyLyrics(results);
      results
        .filter((r) => r.status === "error")
        .slice(0, 5)
        .forEach((r) => notify(`${basename(r.path)}: ${r.detail ?? "lyrics lookup failed"}`, "error"));
      notify(`Lyrics: ${describeLyricsTally(tally)}`, tally.synced + tally.plain > 0 ? "success" : "info");
      // Embedding changed the files themselves: refresh their rows and the index.
      const embedded = results.filter((r) => r.embedded).map((r) => r.path);
      if (embedded.length) {
        dropLibraryTags(embedded);
        await filesApi.refreshPaths(embedded);
        void reindexLibraryPaths(embedded);
      }
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setProgress(null);
      setBusy(false);
    }
  };

  /**
   * "Detect language": offline suggestions from stored lyrics (else
   * title + artist), shown in the preview table. Nothing is written until the
   * user applies it; low-confidence guesses arrive unticked.
   */
  const runDetectLanguage = async (paths: string[]) => {
    if (!paths.length) return notify("No files selected", "info");
    setBusy(true);
    try {
      const { map, errors } = await tagsApi.read(paths);
      errors.forEach((e) => notify(e, "error"));
      const suggestions = await invoke<LangSuggestion[]>("detect_languages", { paths });
      const selected = new Set(paths);
      const files = filesApi.files.filter((f) => selected.has(f.path));
      const rows = buildLanguagePreview(files, map, suggestions, {
        appendComment: settingsRef.current.languageAppendComment,
      });
      setTagsMap(map);
      setPreviewMode("language");
      setPending(rows);
      const langRows = rows.filter((r) => r.field === "language");
      if (!langRows.length) {
        notify(
          suggestions.some((s) => s.code)
            ? "The selected files already have those languages"
            : "No language could be told. Fetch lyrics first for a better guess.",
          "info",
        );
      } else {
        const low = langRows.filter((r) => !r.include).length;
        if (low) notify(`${low} of ${langRows.length} suggestions are low confidence or replace a value, so they start unticked`, "info");
      }
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const generateIds = async () => {
    const paths = filesApi.selectedPaths;
    if (!paths.length) return notify("No files selected", "info");
    setBusy(true);
    try {
      const { map, errors } = await tagsApi.read(paths);
      errors.forEach((e) => notify(e, "error"));
      const result = await tagsApi.generateIds(paths, map, settings, (done, total) =>
        setProgress({ done, total, label: `Assigning ID ${Math.min(done, total)} of ${total}` }),
      );
      result.errors.forEach((e) => notify(e, "error"));
      if (result.assigned) void update((prev) => ({ ...prev, nextTrackId: result.nextId }));
      notify(
        result.assigned
          ? `Assigned ${result.assigned} ID${result.assigned === 1 ? "" : "s"} (next: ${result.nextId
              .toString()
              .padStart(6, "0")})`
          : "No tracks to assign",
        result.assigned ? "success" : "info",
      );
      await afterWrite(paths);
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setProgress(null);
      setBusy(false);
    }
  };

  /**
   * "Move Track Number IDs into Track ID" — a one-off cleanup for a library
   * that used Generate IDs before v4, when it wrote into Track Number
   * because Track ID didn't exist yet (see ROADMAP.md item 9). Scans every
   * *loaded* file (not just the selection — this is meant to be
   * comprehensive) via the same preview/apply flow as Standardize, so
   * nothing is written until the user reviews and applies it.
   */
  const runTrackIdMigration = async () => {
    const paths = filesApi.files.map((f) => f.path);
    if (!paths.length) return notify("No files loaded", "info");
    setBusy(true);
    try {
      const { map, errors } = await tagsApi.read(paths);
      errors.forEach((e) => notify(e, "error"));
      const rows = buildTrackIdMigrationPreview(paths, map, settingsRef.current.trackIdDigits);
      setTagsMap(map);
      setPreviewMode("trackIdMigration");
      setPending(rows);
      if (!rows.length) {
        notify("No Track Number values look like a pre-v4 generated ID", "info");
      }
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  // ---- v0.10: format conversion + cross-format grouping -------------------

  /** Opens the Convert dialog, optionally seeded with one right-clicked file. */
  const openConvert = (file?: AudioFile) => {
    if (!file && filesApi.selectedPaths.length === 0) {
      return notify("No files selected", "info");
    }
    setConvertSeedFile(file ?? null);
    setConvertOpen(true);
    void refreshFfmpeg(); // pick up an install done since last check
  };

  /**
   * Opens the Stems dialog for the selection, after checking Demucs is
   * actually there. The check runs on open rather than being cached at
   * launch: probing Python costs a process spawn, and the answer changes
   * exactly when the user installs it from the Components page.
   */
  const openStems = async (file?: AudioFile) => {
    const paths = file
      ? [file.path]
      : filesApi.files.filter((f) => filesApi.selected.has(f.path)).map((f) => f.path);
    if (!paths.length) return notify("No files selected", "info");

    let info = demucsInfo;
    try {
      info = await invoke<DemucsInfo>("demucs_info");
      setDemucsInfo(info);
    } catch (e) {
      return notify(String(e), "error");
    }
    if (!info?.pythonFound) {
      notify("Python isn't installed — see the Components page to set Demucs up", "error");
      setPage("components");
      return;
    }
    if (!info.installed) {
      notify("Demucs isn't installed yet — install it on the Components page", "info");
      setPage("components");
      return;
    }
    setStemsPaths(paths);
  };

  const runConvert = async (opts: ConvertOptions) => {
    setConvertOpen(false);
    const paths = convertSeedFile
      ? [convertSeedFile.path]
      : filesApi.files.filter((f) => filesApi.selected.has(f.path)).map((f) => f.path);
    setConvertSeedFile(null);
    if (!paths.length) return;

    setBusy(true);
    setProgress({ done: 0, total: paths.length, label: "Converting…" });
    const unlisten = await listen<{ done: number; total: number; file: string | null }>(
      "convert-progress",
      (e) => {
        const { done, total, file } = e.payload;
        setProgress({
          done,
          total,
          label: file ? `Converting ${basename(file)} (${done + 1}/${total})` : "Finishing…",
        });
      },
    );
    try {
      const outcomes = await invoke<ConvertOutcome[]>("convert_files", {
        paths,
        preset: opts.preset,
        subfolder: opts.output === "subfolder",
        overwrite: false,
      });
      const ok = outcomes.filter((o) => o.ok);
      const failed = outcomes.filter((o) => !o.ok);
      failed.forEach((o) => notify(`${basename(o.source)}: ${o.error}`, "error"));
      ok.filter((o) => o.error).forEach((o) => notify(`${basename(o.source)}: ${o.error}`, "info"));

      const newPaths = ok.map((o) => o.output!).filter(Boolean);
      if (opts.addToLibrary && newPaths.length) {
        const added = await invoke<AudioFile[]>("list_files", { paths: newPaths });
        filesApi.merge(added);
        dropLibraryTags(newPaths);
      }
      if (opts.deleteOriginals && ok.length) {
        for (const o of ok) {
          try {
            await invoke("delete_file", { path: o.source });
          } catch (e) {
            notify(`Could not remove ${basename(o.source)}: ${e}`, "error");
          }
        }
        const removed = ok.map((o) => o.source);
        invalidateCovers(removed);
        filesApi.removeFiles(removed);
        void reindexLibraryPaths(removed);
      }
      if (ok.length) {
        notify(
          `Converted ${ok.length} file${ok.length === 1 ? "" : "s"}${
            failed.length ? `, ${failed.length} failed` : ""
          }`,
          failed.length ? "info" : "success",
        );
      }
    } catch (e) {
      notify(String(e), "error");
    } finally {
      unlisten();
      setProgress(null);
      setBusy(false);
    }
  };

  /**
   * Scans the loaded files for same-recording clusters (reusing the duplicate
   * detector) and previews assigning each cluster a shared Track ID, so the
   * files group as one track. Nothing is written until the dialog is confirmed.
   */
  const startUnify = async () => {
    const paths = filesApi.files.map((f) => f.path);
    if (paths.length < 2) return notify("Load at least two files first", "info");
    setBusy(true);
    setProgress({ done: 0, total: paths.length, label: "Scanning for matches…" });
    const unlisten = await listen<{ done: number; total: number; phase: string }>(
      "duplicate-scan-progress",
      (e) => {
        const { done, total, phase } = e.payload;
        setProgress({ done, total, label: `${phase} ${done}/${total}` });
      },
    );
    try {
      const { map } = await tagsApi.read(paths);
      setLibraryTags((prev) => ({ ...prev, ...map }));
      const clusters = await invoke<DuplicateGroup[]>("scan_duplicates", { paths });
      const dupes = clusters.filter((c) => c.kind === "duplicate");
      const alternates = clusters.filter((c) => c.kind === "alternate").length;

      let counter = settings.nextTrackId;
      const groups: UnifyGroup[] = dupes.map((c) => {
        const existing = c.paths
          .map((p) => map[p]?.trackId)
          .find((id) => isUid(id, settings.trackIdDigits));
        const canonicalId = existing ?? formatTrackId(counter++, settings.trackIdDigits);
        return {
          canonicalId,
          generated: !existing,
          members: c.paths.map((p) => {
            const fromId = map[p]?.trackId;
            const file = filesApi.files.find((f) => f.path === p);
            return {
              path: p,
              format: (file?.format || "?").toUpperCase(),
              fromId,
              changes: fromId !== canonicalId,
            };
          }),
        };
      });

      if (groups.every((g) => g.members.every((m) => !m.changes))) {
        notify(
          dupes.length
            ? "All matching files already share a Track ID"
            : "No same-recording matches found",
          "info",
        );
        return;
      }
      setUnifyState({ groups, alternates });
    } catch (e) {
      notify(String(e), "error");
    } finally {
      unlisten();
      setProgress(null);
      setBusy(false);
    }
  };

  const applyUnify = async () => {
    const state = unifyState;
    setUnifyState(null);
    if (!state) return;
    setBusy(true);
    try {
      const changes: HistoryChange[] = [];
      const edits = [];
      let maxCounter = settings.nextTrackId;
      const { map } = await tagsApi.read(
        state.groups.flatMap((g) => g.members.filter((m) => m.changes).map((m) => m.path)),
      );
      for (const g of state.groups) {
        const idNum = Number(g.canonicalId);
        if (g.generated && Number.isFinite(idNum)) maxCounter = Math.max(maxCounter, idNum + 1);
        for (const m of g.members) {
          if (!m.changes) continue;
          const current = map[m.path];
          if (!current) continue;
          edits.push({
            path: m.path,
            current,
            field: "trackId" as keyof TagData & string,
            value: g.canonicalId,
          });
          changes.push({
            path: m.path,
            field: "trackId",
            before: m.fromId ?? "",
            after: g.canonicalId,
          });
        }
      }
      const result = await tagsApi.updateFieldMany(edits, settings);
      result.errors.forEach((e) => notify(e, "error"));
      if (changes.length) {
        setLibraryTags((prev) => {
          const next = { ...prev };
          for (const c of changes) {
            if (next[c.path]) next[c.path] = { ...next[c.path], trackId: String(c.after) };
          }
          return next;
        });
        pushHistory({ label: `Unify Track IDs (${changes.length})`, changes });
        if (maxCounter !== settings.nextTrackId) {
          void update((prev) => ({ ...prev, nextTrackId: maxCounter }));
        }
        await filesApi.refreshPaths(changes.map((c) => c.path));
        notify(
          `Linked ${changes.length} file${changes.length === 1 ? "" : "s"} across ${state.groups.length} track${
            state.groups.length === 1 ? "" : "s"
          }`,
          "success",
        );
      }
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const renameToStandard = async () => {
    const files = filesApi.files.filter((f) => filesApi.selected.has(f.path));
    if (!files.length) return notify("No files selected", "info");
    // A deliberately narrowed selection (not "everything") is already an explicit
    // choice — only prompt when acting on the full/default set, where the blast
    // radius is bigger and less obviously intentional.
    const isPartialSelection = files.length < filesApi.files.length;
    if (!isPartialSelection) {
      const pattern = settings.strictFilenames
        ? "Artist - Title - id (accents folded, punctuation removed)"
        : "Artist - Title - id";
      const ok = await confirm(
        `Rename ${files.length} file${files.length === 1 ? "" : "s"} to "${pattern}"? ` +
          "Original tags are not affected.",
        { title: "Rename to Standard", kind: "info" },
      );
      if (!ok) return;
    }
    setBusy(true);
    try {
      const { map, errors } = await tagsApi.read(files.map((f) => f.path));
      errors.forEach((e) => notify(e, "error"));

      // Warn (don't block) when two files would land on the same stem —
      // Rename to Standard still appends " (2)" on a real collision, but
      // strict mode makes near-duplicates ("Beyoncé" / "Beyonce") collapse
      // far more often, so it's worth calling out before writing anything.
      const stemCounts = new Map<string, number>();
      for (const file of files) {
        const tags = map[file.path];
        if (!tags) continue;
        const uid = isUid(tags.trackId, settings.trackIdDigits) ? tags.trackId : undefined;
        const stem = buildRenameStem(tags.artist, tags.title, uid, settings.strictFilenames);
        if (stem) stemCounts.set(stem, (stemCounts.get(stem) ?? 0) + 1);
      }
      const collisions = [...stemCounts.values()].filter((n) => n > 1).length;
      if (collisions > 0) {
        const ok = await confirm(
          `${collisions} file name${collisions === 1 ? "" : "s"} would collapse to the same name as ` +
            `another file. They'll get " (2)", " (3)", … appended so nothing is overwritten. Continue?`,
          { title: "Rename to Standard", kind: "warning" },
        );
        if (!ok) return;
      }

      const result = await tagsApi.renameFiles(
        files,
        map,
        settings.trackIdDigits,
        settings.strictFilenames,
      );
      result.errors.forEach((e) => notify(e, "error"));
      if (Object.keys(result.mapping).length) {
        invalidateCovers(Object.keys(result.mapping));
        filesApi.remap(result.mapping);
        void reindexLibraryPaths(
          Object.entries(result.mapping).flatMap(([oldPath, f]) => [oldPath, f.path]),
        );
        // A rename only changes the path, not the tags — carry the cached
        // TagData over to the new path instead of clearing everything and
        // forcing a full-library re-read from disk.
        setLibraryTags((prev) => {
          const next: Record<string, TagData> = {};
          for (const [path, tags] of Object.entries(prev)) {
            const newPath = result.mapping[path]?.path ?? path;
            next[newPath] = tags;
          }
          return next;
        });
      }
      if (result.written)
        notify(`Renamed ${result.written} file${result.written === 1 ? "" : "s"}`, "success");
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const deleteFile = async (file: AudioFile, opts?: { onConfirmed?: () => void }) => {
    const ok = await confirm(
      `Delete "${file.filename}"? It will be moved to the Recycle Bin.`,
      { title: "Delete File", kind: "warning" },
    );
    if (!ok) return;
    // Runs only once the user has said yes, and before the file actually
    // moves: Genre Mode uses it to hand playback to the next track, so the
    // <audio> element isn't still holding the file being deleted — and a
    // cancelled delete leaves the current track playing untouched.
    opts?.onConfirmed?.();
    try {
      await invoke("delete_file", { path: file.path });
      invalidateCovers([file.path]);
      filesApi.removeFiles([file.path]);
      void reindexLibraryPaths([file.path]);
      setLibraryTags((prev) => {
        const next = { ...prev };
        delete next[file.path];
        return next;
      });
      notify(`Deleted "${file.filename}"`, "success");
    } catch (e) {
      notify(String(e), "error");
    }
  };

  /**
   * Batch removal for the Duplicates page: confirms with the exact count and
   * total size, then moves each file to the Recycle Bin (never a hard
   * delete) via the same `delete_file` command as the single-file path
   * above. Returns whether anything was actually removed, so the caller
   * knows whether to update its own UI.
   */
  const deleteDuplicateFiles = async (paths: string[]): Promise<boolean> => {
    if (!paths.length) return false;
    const totalBytes = paths.reduce(
      (sum, p) => sum + (filesApi.files.find((f) => f.path === p)?.size ?? 0),
      0,
    );
    const ok = await confirm(
      `Move ${paths.length} file${paths.length === 1 ? "" : "s"} (${formatBytes(totalBytes)}) to the Recycle Bin?`,
      { title: "Remove Duplicates", kind: "warning" },
    );
    if (!ok) return false;
    setBusy(true);
    let removed = 0;
    const errors: string[] = [];
    for (const p of paths) {
      try {
        await invoke("delete_file", { path: p });
        removed++;
      } catch (e) {
        errors.push(`${basename(p)}: ${e}`);
      }
    }
    errors.forEach((e) => notify(e, "error"));
    if (removed) {
      invalidateCovers(paths);
      filesApi.removeFiles(paths);
      void reindexLibraryPaths(paths);
      setLibraryTags((prev) => {
        const next = { ...prev };
        for (const p of paths) delete next[p];
        return next;
      });
      notify(`Removed ${removed} file${removed === 1 ? "" : "s"}`, "success");
    }
    setBusy(false);
    return removed > 0;
  };

  /**
   * Simple backup archive (v0.9 F6): a store-only ZIP of the selection (or
   * the whole loaded collection if nothing is ticked) with a generated
   * name, a size estimate up front, and a manifest inside for later
   * verification. The user picks where it goes and moves it somewhere safe
   * themselves — no scheduling, no cloud, no incremental logic.
   */
  const runBackupArchive = async () => {
    const paths = filesApi.selectedPaths.length ? filesApi.selectedPaths : filesApi.files.map((f) => f.path);
    if (!paths.length) return notify("No files loaded", "info");
    const totalBytes = paths.reduce(
      (sum, p) => sum + (filesApi.files.find((f) => f.path === p)?.size ?? 0),
      0,
    );
    const now = new Date();
    const pad = (n: number) => n.toString().padStart(2, "0");
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
    const defaultName = `MusicTagCleaner-backup-${stamp}-${paths.length}-tracks.zip`;

    const ok = await confirm(
      `Archive ${paths.length} file${paths.length === 1 ? "" : "s"} (${formatBytes(totalBytes)}, uncompressed) into a single ZIP?`,
      { title: "Backup Archive", kind: "info" },
    );
    if (!ok) return;

    const dest = await saveDialog({
      title: "Save Backup Archive",
      defaultPath: defaultName,
      filters: [{ name: "ZIP Archive", extensions: ["zip"] }],
    });
    if (!dest) return;

    setBusy(true);
    setProgress({ done: 0, total: paths.length, label: `Archiving 0 of ${paths.length}` });
    const unlisten = await listen<{ done: number; total: number }>("backup-archive-progress", (e) =>
      setProgress({
        done: e.payload.done,
        total: e.payload.total,
        label: `Archiving ${e.payload.done} of ${e.payload.total}`,
      }),
    );
    try {
      await invoke("create_backup_archive", { paths, destPath: dest });
      notify(`Backup archive saved (${paths.length} tracks, ${formatBytes(totalBytes)})`, "success");
      await revealItemInDir(dest);
    } catch (e) {
      notify(String(e), "error");
    } finally {
      unlisten();
      setProgress(null);
      setBusy(false);
    }
  };

  const setCoverArt = async (file: AudioFile) => {
    const picked = await open({
      title: "Choose Artwork",
      multiple: false,
      filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "gif", "bmp"] }],
    });
    if (!picked || typeof picked !== "string") return;
    try {
      const before = await invoke<string | null>("read_cover_art", { path: file.path });
      await invoke("set_cover_art", { path: file.path, imagePath: picked });
      const after = await invoke<string | null>("read_cover_art", { path: file.path });
      invalidateCovers([file.path]);
      imageInfoApi.invalidate([file.path]);
      pushHistory({
        label: "Set artwork",
        changes: [{ path: file.path, field: "__coverArt", before: before ?? "", after: after ?? "" }],
      });
      notify("Artwork updated", "success");
    } catch (e) {
      notify(String(e), "error");
    }
  };

  /** Bulk "Remove art" for the junk-art dialog: one undoable history entry. */
  const removeArtForPaths = async (paths: string[]) => {
    const changes: HistoryChange[] = [];
    for (const path of paths) {
      try {
        const before = await invoke<string | null>("read_cover_art", { path });
        if (!before) continue;
        await invoke("remove_cover_art", { path });
        changes.push({ path, field: "__coverArt", before, after: "" });
      } catch (e) {
        notify(`${basename(path)}: ${e}`, "error");
      }
    }
    if (changes.length) {
      invalidateCovers(changes.map((c) => c.path));
      imageInfoApi.invalidate(changes.map((c) => c.path));
      pushHistory({ label: `Remove artwork (${changes.length})`, changes });
    }
    notify(
      changes.length ? `Removed artwork from ${changes.length} track${changes.length === 1 ? "" : "s"}` : "Nothing to remove",
      changes.length ? "success" : "info",
    );
  };

  const artworkApplied = (changes: HistoryChange[], label: string) => {
    invalidateCovers(changes.map((c) => c.path));
    imageInfoApi.invalidate(changes.map((c) => c.path));
    pushHistory({ label, changes });
    notify(`Artwork updated on ${changes.length} track${changes.length === 1 ? "" : "s"}`, "success");
  };

  const removeCoverArt = async (file: AudioFile) => {
    try {
      const before = await invoke<string | null>("read_cover_art", { path: file.path });
      if (!before) return; // Nothing to remove — no history entry needed.
      await invoke("remove_cover_art", { path: file.path });
      invalidateCovers([file.path]);
      imageInfoApi.invalidate([file.path]);
      pushHistory({
        label: "Remove artwork",
        changes: [{ path: file.path, field: "__coverArt", before, after: "" }],
      });
      notify("Artwork removed", "success");
    } catch (e) {
      notify(String(e), "error");
    }
  };

  const standardizeArtwork = async () => {
    const paths = filesApi.selectedPaths;
    if (!paths.length) return notify("No files selected", "info");
    const { artworkMaxDim, artworkJpegQuality } = settingsRef.current;
    setBusy(true);
    setProgress({ done: 0, total: paths.length, label: `Compressing artwork 0 of ${paths.length}` });
    const changes: HistoryChange[] = [];
    let savedBytes = 0;
    try {
      for (let i = 0; i < paths.length; i++) {
        const path = paths[i];
        try {
          const res = await invoke<{
            beforeDataUrl: string;
            afterDataUrl: string;
            beforeBytes: number;
            afterBytes: number;
          } | null>("standardize_artwork", {
            path,
            maxDim: artworkMaxDim,
            quality: artworkJpegQuality,
          });
          if (res) {
            changes.push({ path, field: "__coverArt", before: res.beforeDataUrl, after: res.afterDataUrl });
            savedBytes += Math.max(0, res.beforeBytes - res.afterBytes);
          }
        } catch (e) {
          notify(`${basename(path)}: ${e}`, "error");
        }
        setProgress({
          done: i + 1,
          total: paths.length,
          label: `Compressing artwork ${Math.min(i + 1, paths.length)} of ${paths.length}`,
        });
      }
      if (changes.length) {
        invalidateCovers(changes.map((c) => c.path));
        imageInfoApi.invalidate(changes.map((c) => c.path));
        pushHistory({ label: `Standardize artwork (${changes.length})`, changes });
      }
      notify(
        changes.length
          ? `Recompressed ${changes.length} cover${changes.length === 1 ? "" : "s"}${
              savedBytes > 0 ? `, saved ${formatBytes(savedBytes)}` : ""
            }`
          : "Every selected cover already meets the target",
        changes.length ? "success" : "info",
      );
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setProgress(null);
      setBusy(false);
    }
  };

  /**
   * Moves every selected track's tags into the one container its format calls
   * canonical — ID3v2 for mp3/wav/aiff, Vorbis Comments for flac/ogg, MP4
   * atoms for m4a/aac — and drops the others it has collected (ID3v1, APE).
   *
   * Values are only moved, never edited, so this deliberately does not go
   * through the pending/preview flow the way Standardize does: there is no
   * before/after to show per field. It also can't be undone from history for
   * the same reason — the confirmation says so, and the sweep is a no-op on
   * anything already standard.
   */
  const standardizeContainers = async () => {
    const paths = filesApi.selectedPaths;
    if (!paths.length) return notify("No files selected", "info");
    const ok = await confirm(
      `Move tags in ${paths.length} file${paths.length === 1 ? "" : "s"} into the standard ` +
        `container for each format, and drop any others (ID3v1, APE)?

` +
        `Values are moved, not changed. Anything a secondary tag holds that the main one ` +
        `doesn't is kept. This isn't undoable from history.`,
      { title: "Standardize Tag Format", kind: "warning" },
    );
    if (!ok) return;
    setBusy(true);
    setProgress({ done: 0, total: paths.length, label: "Standardizing tag format…" });
    try {
      const res = await invoke<{ converted: number; already: number; failed: string[] }>(
        "standardize_tag_containers",
        { paths },
      );
      for (const f of res.failed.slice(0, 5)) notify(f, "error");
      if (res.failed.length > 5) {
        notify(`…and ${res.failed.length - 5} more failed`, "error");
      }
      if (res.converted) {
        dropLibraryTags(paths);
        await filesApi.refreshPaths(paths);
      }
      notify(
        res.converted
          ? `Standardized ${res.converted} file${res.converted === 1 ? "" : "s"}` +
              (res.already ? ` — ${res.already} already were` : "")
          : "Every selected file already uses its standard tag format",
        res.converted ? "success" : "info",
      );
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setProgress(null);
      setBusy(false);
    }
  };

  // --- B4: move to collection ------------------------------------------------
  const [organizePaths, setOrganizePaths] = useState<string[] | null>(null);

  const openOrganize = (paths: string[]) => {
    if (!paths.length) return notify("No files selected", "info");
    if (!settingsRef.current.collectionRoot) {
      return notify("Set a collection folder first (Settings, Organize)", "info");
    }
    setOrganizePaths(paths);
  };

  /** Re-points the session rows, tag cache and index at files that just moved. */
  const applyMoves = async (moves: { from: string; to: string }[]) => {
    if (!moves.length) return;
    const updated = await invoke<AudioFile[]>("list_files", { paths: moves.map((m) => m.to) });
    const byNew = new Map(updated.map((f) => [f.path, f]));
    const mapping: Record<string, AudioFile> = {};
    for (const m of moves) {
      const info = byNew.get(m.to);
      if (info) mapping[m.from] = info;
    }
    invalidateCovers(Object.keys(mapping));
    filesApi.remap(mapping);
    setLibraryTags((prev) => {
      const next = { ...prev };
      for (const m of moves) {
        if (next[m.from]) {
          next[m.to] = next[m.from];
          delete next[m.from];
        }
      }
      return next;
    });
  };

  const readTagMap = async (paths: string[]) => (await tagsApi.read(paths)).map;

  /** autoMoveOnSave: files just written that sit outside the collection go into it. */
  const autoMoveAfterSave = async (paths: string[]) => {
    const s = settingsRef.current;
    if (!s.autoMoveOnSave || !s.collectionRoot) return;
    const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
    const root = norm(s.collectionRoot) + "/";
    const outside = paths.filter((p) => !norm(p).startsWith(root));
    if (!outside.length) return;
    try {
      const tags = await readTagMap(outside);
      const plan = await invoke<{ from: string; to: string; status: string }[]>("organize_preview", {
        items: outside.map((p) => toOrganizeItem(p, tags[p])),
        root: s.collectionRoot,
        pattern: s.organizePattern,
      });
      const moves = plan
        .filter((e) => e.status === "move" || e.status === "renamed")
        .map((e) => ({ from: e.from, to: e.to }));
      if (!moves.length) return;
      const res = await invoke<{ results: { from: string; to: string; ok: boolean; error?: string }[] }>(
        "organize_move",
        { moves },
      );
      const ok = res.results.filter((r) => r.ok && r.from !== r.to);
      res.results.filter((r) => !r.ok).forEach((r) => notify(`${r.from}: ${r.error}`, "error"));
      await applyMoves(ok.map((r) => ({ from: r.from, to: r.to })));
      if (ok.length) notify(`Moved ${ok.length} file${ok.length === 1 ? "" : "s"} to the collection`, "success");
    } catch (e) {
      notify(String(e), "error");
    }
  };

  const renameSingleFile = async (path: string, newStem: string) => {
    setBusy(true);
    try {
      const newPath = await invoke<string>("rename_file", { path, newStem });
      const [updated] = await invoke<AudioFile[]>("list_files", { paths: [newPath] });
      if (updated) {
        invalidateCovers([path]);
        filesApi.remap({ [path]: updated });
        void reindexLibraryPaths([path, newPath]);
        setLibraryTags((prev) => {
          if (!prev[path]) return prev;
          const next = { ...prev };
          next[newPath] = next[path];
          delete next[path];
          return next;
        });
        notify(`Renamed to "${updated.filename}"`, "success");
      }
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  /** Edits `field` on every path in `paths` (multi-select bulk edit shares one value). */
  const editField = async (paths: string[], field: keyof TagData & string, value: string) => {
    setBusy(true);
    try {
      const changes: HistoryChange[] = [];
      const edits = [];
      for (const path of paths) {
        const current = libraryTags[path];
        if (!current) continue;
        const before = (current as unknown as Record<string, string | undefined>)[field] ?? "";
        if (before === value) continue;
        edits.push({ path, current, field, value });
        changes.push({ path, field, before, after: value });
        clearUnresolved(path);
      }
      const result = await tagsApi.updateFieldMany(edits, settings);
      result.errors.forEach((e) => notify(e, "error"));
      if (changes.length) {
        setLibraryTags((prev) => {
          const next = { ...prev };
          for (const c of changes) next[c.path] = { ...next[c.path], [field]: value };
          return next;
        });
        pushHistory({
          label: `Edit ${FIELD_LABELS[field] ?? field}${changes.length > 1 ? ` (${changes.length} tracks)` : ""}`,
          changes,
        });
        await filesApi.refreshPaths(changes.map((c) => c.path));
      }
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  /** Edits (or, when `value` is empty, completely deletes) a raw "All Tags" field. */
  const editRawField = async (paths: string[], rawKey: string, value: string) => {
    setBusy(true);
    try {
      const changes: HistoryChange[] = [];
      const edits = [];
      for (const path of paths) {
        const current = libraryTags[path];
        const before = current?.allFields?.[rawKey] ?? "";
        if (before === value) continue;
        edits.push({ path, fieldKey: rawKey, value });
        changes.push({ path, field: `__raw:${rawKey}`, before, after: value });
      }
      const result = await tagsApi.updateRawFieldMany(edits);
      result.errors.forEach((e) => notify(e, "error"));
      if (changes.length) {
        setLibraryTags((prev) => {
          const next = { ...prev };
          for (const c of changes) {
            const tags = next[c.path];
            if (!tags) continue;
            const allFields = { ...tags.allFields };
            if (value) allFields[rawKey] = value;
            else delete allFields[rawKey];
            next[c.path] = { ...tags, allFields };
          }
          return next;
        });
        pushHistory({
          label: `Edit ${rawKey}${changes.length > 1 ? ` (${changes.length} tracks)` : ""}`,
          changes,
        });
        await filesApi.refreshPaths(changes.map((c) => c.path));
      }
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const editRating = async (paths: string[], stars: number) => {
    setBusy(true);
    try {
      const changes: HistoryChange[] = [];
      const edits = [];
      for (const path of paths) {
        const current = libraryTags[path];
        if (!current) continue;
        const before = current.rating ?? 0;
        if (before === stars) continue;
        edits.push({ path, current: { ...current, rating: stars }, field: "rating" as const, value: stars });
        changes.push({ path, field: "rating", before, after: stars });
      }
      const result = await tagsApi.updateFieldMany(edits, settings);
      result.errors.forEach((e) => notify(e, "error"));
      if (changes.length) {
        setLibraryTags((prev) => {
          const next = { ...prev };
          for (const c of changes) next[c.path] = { ...next[c.path], rating: stars };
          return next;
        });
        pushHistory({
          label: `Set rating${changes.length > 1 ? ` (${changes.length} tracks)` : ""}`,
          changes,
        });
        await filesApi.refreshPaths(changes.map((c) => c.path));
      }
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const runBackup = async () => {
    const paths = filesApi.selectedPaths;
    if (!paths.length) return notify("No files selected", "info");
    setBusy(true);
    setBackupRunning(true);
    try {
      const result = await tagsApi.backupSelected(paths, settings, (done, total) =>
        setProgress({ done, total, label: `Backing up ${Math.min(done + 1, total)} of ${total}` }),
      );
      result.errors.forEach((e) => notify(e, "error"));
      if (result.written)
        notify(`Backed up ${result.written} file${result.written === 1 ? "" : "s"}`, "success");
      if (result.stopped) notify("Backup stopped", "info");
      await afterWrite(paths);
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setProgress(null);
      setBackupRunning(false);
      setBusy(false);
    }
  };

  const runClearFields = async (fields: string[]) => {
    const paths = filesApi.selectedPaths;
    if (!paths.length) return notify("No files selected", "info");
    if (!fields.length) return notify("No fields chosen to clear", "info");
    const backupFieldKey =
      settings.backupField.charAt(0).toLowerCase() + settings.backupField.slice(1);
    if (settings.searchableBackup && fields.includes(backupFieldKey)) {
      const ok = await confirm(
        `"${backupFieldKey}" currently holds your searchable backup text. Clearing it will erase that backup — continue?`,
        { title: "Clearing the backup field", kind: "warning" },
      );
      if (!ok) return;
    }
    // Remember this pick as the new default for next time.
    if (fields.slice().sort().join("\n") !== settingsRef.current.clearFields.slice().sort().join("\n")) {
      void update((prev) => ({ ...prev, clearFields: fields }));
    }
    setBusy(true);
    try {
      const { map, errors } = await tagsApi.read(paths);
      errors.forEach((e) => notify(e, "error"));
      const rows = tagsApi.buildClearPreview(paths, map, fields);
      setTagsMap(map);
      setPreviewMode("clear");
      setPending(rows);
      if (!rows.some((r) => r.changed)) notify("The chosen fields are already empty", "info");
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const restoreBackup = async () => {
    const paths = filesApi.files
      .filter((f) => filesApi.selected.has(f.path) && f.hasBackup)
      .map((f) => f.path);
    if (!paths.length) return;
    const ok = await confirm(
      `This will restore all original tags for ${paths.length} file${
        paths.length === 1 ? "" : "s"
      }. Continue?`,
      { title: "Restore Backup", kind: "warning" },
    );
    if (!ok) return;
    setBusy(true);
    setBackupRunning(true);
    try {
      const result = await tagsApi.restore(paths, (done, total) =>
        setProgress({ done, total, label: `Restoring ${Math.min(done + 1, total)} of ${total}` }),
      );
      result.errors.forEach((e) => notify(e, "error"));
      if (result.written)
        notify(
          `Restored original tags for ${result.written} file${result.written === 1 ? "" : "s"}`,
          "success",
        );
      if (result.stopped) notify("Restore stopped", "info");
      await afterWrite(paths);
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setProgress(null);
      setBackupRunning(false);
      setBusy(false);
    }
  };

  /**
   * The table's genre editor offers "Add …" for a value that isn't in the
   * list yet. There is no list to add it *to* any more — the vocabulary is
   * whatever the files carry — so creating a genre just means writing it to
   * the track, which the Combobox's own commit already does. This exists to
   * keep that affordance (and its analytics) rather than to store anything.
   */
  const noteNewGenre = (genre: string) => {
    if (genre.trim()) analytics.track("genre-created");
  };

  /**
   * Renames a genre **across the whole collection**, not just the tracks
   * currently open.
   *
   * This is the point of deriving genres from the library: the name in the
   * picker and the name in the files are the same thing, so renaming one has
   * to rename the other or they drift apart again. Tracks that aren't loaded
   * are retagged in Rust (`retag_field`), which also refreshes their index
   * rows; loaded tracks go through the normal edit path so undo still covers
   * them.
   */
  const renameFacetEverywhere = async (facet: Facet, oldName: string, newName: string, artist = "") => {
    const meta = FACETS[facet];
    // Renaming a language to a name or two-letter code stores the canonical code.
    const trimmed = facet === "language" ? (normalizeLanguageCode(newName) ?? newName.trim()) : newName.trim();
    if (!trimmed || trimmed === oldName) return;
    const pick: FacetPick = { facet, name: oldName, artist };

    let paths: string[] = [];
    try {
      paths = await libraryIndex.pathsWithFacet(facet, oldName, artist);
    } catch {
      paths = [];
    }
    // Loaded-but-not-yet-indexed tracks matter too — they're the ones most
    // likely to have just been given this value by hand.
    const loaded = Object.entries(libraryTags)
      .filter(([, t]) => matchesFacet(t, pick))
      .map(([path]) => path);
    const all = [...new Set([...paths, ...loaded])];
    const what = artist ? `"${oldName}" (${artist})` : `"${oldName}"`;
    if (!all.length) {
      notify(`Nothing in the collection uses ${what}`, "info");
      return;
    }

    const ok = await confirm(
      `${all.length} track${all.length === 1 ? "" : "s"} in your collection ` +
        `${all.length === 1 ? "uses" : "use"} ${what}. Rename ${
          all.length === 1 ? "it" : "them"
        } to "${trimmed}"?

This rewrites the ${meta.singular} tag on ${
          all.length === 1 ? "that file" : "those files"
        }.`,
      { title: `Rename ${meta.singular[0].toUpperCase()}${meta.singular.slice(1)}`, kind: "warning" },
    );
    if (!ok) return;

    const loadedSet = new Set(filesApi.files.map((f) => f.path));
    const inSession = all.filter((p) => loadedSet.has(p));
    const offSession = all.filter((p) => !loadedSet.has(p));

    setBusy(true);
    try {
      if (inSession.length) await editField(inSession, meta.retagField, trimmed);
      if (offSession.length) {
        const results = await invoke<{ path: string; error: string | null }[]>("retag_field", {
          paths: offSession,
          field: meta.retagField,
          value: trimmed,
          backup: settingsRef.current.backupBeforeChanges,
          preserveArt: settingsRef.current.preserveCoverArt,
          backupField: settingsRef.current.searchableBackup
            ? settingsRef.current.backupField
            : null,
        });
        const failed = results.filter((r) => r.error);
        failed.forEach((r) => notify(`${basename(r.path)}: ${r.error}`, "error"));
        notify(
          `Renamed ${what} to "${trimmed}" on ${all.length - failed.length} track(s)`,
          "success",
        );
      } else {
        notify(`Renamed ${what} to "${trimmed}"`, "success");
      }
      await libraryIndex.refresh();
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const renameGenreEverywhere = (oldName: string, newName: string) =>
    renameFacetEverywhere("genre", oldName, newName);

  /**
   * Detect Genres found several raw spellings that normalize to the same
   * thing (e.g. "Hip Hop" / "Hip-Hop"). Offers to retag every track using a
   * non-canonical variant so the collection converges on one spelling.
   */
  const mergeGenreVariants = async (variants: string[], canonical: string) => {
    const nonCanonical = new Set(variants.filter((v) => v !== canonical));
    if (!nonCanonical.size) return;
    const matching = Object.entries(libraryTags)
      .filter(([, t]) => t.genre && nonCanonical.has(t.genre))
      .map(([path]) => path);
    if (!matching.length) return;
    const ok = await confirm(
      `${matching.length} track${matching.length === 1 ? "" : "s"} in the collection use a ` +
        `different spelling of "${canonical}" (${[...nonCanonical].join(", ")}). ` +
        `Retag ${matching.length === 1 ? "it" : "them"} to "${canonical}"?`,
      { title: "Merge Genre Spellings", kind: "info" },
    );
    if (!ok) return;
    await editField(matching, "genre", canonical);
  };

  const inspect = (file: AudioFile) => {
    const tags = libraryTags[file.path];
    if (tags) setInspected({ file, tags });
  };

  // D1: expose the handlers above to the action registry / AI bridge (additive:
  // the toolbar keeps calling them directly). See src/lib/appActions.ts.
  useActionBridge(
    {
      page,
      setPage,
      busy: busy || filesApi.scanning,
      settings,
      columns: ALL_COLUMNS,
      savePatch,
      notify,
      files: filesApi.files,
      selectedPaths: filesApi.selectedPaths,
      setSelection: (paths) => {
        filesApi.setAll(false);
        filesApi.setManySelected(paths, true);
      },
      importPaths: filesApi.importPaths,
      readTags: tagsApi.read,
      library: {
        files: libraryIndex.files,
        tags: libraryIndex.tags,
        stats: libraryIndex.stats,
        facets: libraryIndex.facets,
        runIndex: libraryIndex.runIndex,
      },
      pending,
      previewMode,
      canUndo: history.canUndo,
      canRedo: history.canRedo,
      h: {
        applyPending,
        cancelPending: () => setPending(null),
        undo: history.undo,
        redo: history.redo,
        capitalization: runCapitalizationOnly,
        characterRules: runCharacterRules,
        removeChars: runRemoveChars,
        aiClean: runAIClean,
        clearFields: runClearFields,
        generateIds,
        rekordboxToTags: runRekordboxToTags,
        migrateTrackIds: runTrackIdMigration,
        startUnify,
        standardizeArtwork,
        removeArt: removeArtForPaths,
        standardizeContainers,
        renameToStandard,
        renameFile: renameSingleFile,
        editField: (paths, field, value) => editField(paths, field as keyof TagData & string, value),
        editRawField,
        editRating,
        deleteFile: (f) => deleteFile(f),
        deleteDuplicates: deleteDuplicateFiles,
        backup: runBackup,
        restoreBackup,
        backupArchive: runBackupArchive,
        runConvert: (o) => runConvert(o as ConvertOptions),
        openConvert: () => openConvert(),
        openStems: () => openStems(),
        openOrganize,
        openFindArtwork: (paths) => setArtworkPaths(paths),
        openJunkArt: () => setJunkArtOpen(true),
        loadFacet: loadLibraryFacet,
        showCompare: showHistoryCompare,
      },
    },
    settings.aiControl,
    loaded,
  );

  // Keyboard shortcuts: customizable via settings.shortcuts (see lib/shortcuts.ts), Escape close.
  // The handler closes over state that changes constantly (busy, pending, …), so
  // it lives in a ref that is refreshed each render while the listener itself is
  // attached only once — re-binding a window listener on every render is pure waste.
  const keyHandlerRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyHandlerRef.current = (e: KeyboardEvent) => {
    {
      const target = e.target as HTMLElement | null;
      // Let the browser handle native undo/redo while typing in a cell editor
      // or any other text field instead of hijacking it for tag history.
      const isEditable =
        target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;
      const overrides = settingsRef.current.shortcuts;

      if (matchesShortcut(e, "selectFolder", overrides)) {
        e.preventDefault();
        if (!busy) filesApi.selectFolder();
      } else if (!isEditable && matchesShortcut(e, "undo", overrides)) {
        e.preventDefault();
        void history.undo();
      } else if (!isEditable && matchesShortcut(e, "redo", overrides)) {
        e.preventDefault();
        void history.redo();
      } else if (!isEditable && e.ctrlKey && e.key.toLowerCase() === "y") {
        // Legacy secondary redo binding, not user-customizable.
        e.preventDefault();
        void history.redo();
      } else if (e.key === "Escape") {
        if (inspected) setInspected(null);
        else if (pending) setPending(null);
      }
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyHandlerRef.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex h-screen flex-col">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <Sidebar
          page={page}
          setPage={setPage}
          fileCount={filesApi.files.length}
          errorLogCount={logs.filter((l) => l.kind === "error").length}
          libraryTrackCount={libraryIndex.stats?.trackCount ?? 0}
        />
        <main className="relative min-w-0 flex-1 overflow-y-auto">
          <Suspense fallback={null}>
          <ErrorBoundary
            key={page}
            onError={(message) => notify(message, "error")}
            onBack={() => setPage("library")}
          >
          {page === "library" ? (
            <LibraryPage
              filesApi={filesApi}
              libraryTags={libraryTags}
              libraryIndex={libraryIndex}
              onLoadFacet={(pick) => void loadLibraryFacet(pick)}
              onOpenFacetInNewTab={(pick) => void openFacetInNewTab(pick)}
              onReplaceWithFacet={(pick) => void replaceWithFacet(pick)}
              onAddTracks={(paths) => void genreLoad.addTracks(paths)}
              onRenameFacet={renameFacetEverywhere}
              tabs={sessionTabs.views}
              activeTabId={sessionTabs.activeId}
              tabsLocked={busy || filesApi.scanning || aiRunning || backupRunning}
              onSelectTab={(id) => void sessionTabs.switchTo(id)}
              onNewTab={() => void sessionTabs.openNewTab()}
              onCloseTab={(id) => void sessionTabs.requestClose(id)}
              undoSteps={history.index + 1}
              covers={covers}
              unresolved={unresolved}
              settings={settings}
              busy={busy || filesApi.scanning}
              aiRunning={aiRunning}
              backupRunning={backupRunning}
              onStopBackup={tagsApi.stopBackup}
              canUndo={history.canUndo}
              canRedo={history.canRedo}
              onUndo={withTrack("undo", () => void history.undo())}
              onRedo={withTrack("redo", () => void history.redo())}
              historyTimeline={history.timeline.map((e) => ({
                label: e.label,
                changeCount: e.changes.length,
              }))}
              historyIndex={history.index}
              onJumpToHistory={history.jumpTo}
              onCompare={withTrack("compare", showHistoryCompare)}
              pending={pending}
              previewMode={previewMode}
              lastFolder={settings.lastFolder}
              onPendingChange={setPending}
              onApplyPending={applyPending}
              onCancelPending={() => setPending(null)}
              onAIClean={withTrack("aiClean", runAIClean)}
              onStopAI={ai.stop}
              onCapitalization={withTrack1<Capitalization>("capitalization", runCapitalizationOnly)}
              onCharacterRules={withTrack("characterRules", runCharacterRules)}
              onRemoveChars={withTrack("removeChars", runRemoveChars)}
              onGenerateIds={withTrack("generateIds", generateIds)}
              onRekordboxToTags={withTrack("rekordboxToTags", runRekordboxToTags)}
              rekordbox={rekordboxInfo}
              onUnifyIds={withTrack("unifyIds", () => void startUnify())}
              onConvert={withTrack("convert", () => openConvert())}
              onSeparateStems={withTrack("stems", () => void openStems())}
              onConvertFile={withTrack1("convertFile", (f: AudioFile) => openConvert(f))}
              onMoveToCollection={openOrganize}
              onFetchLyrics={withTrack1("fetchLyrics", runFetchLyrics)}
              onDetectLanguage={withTrack1("detectLanguage", runDetectLanguage)}
              onStandardizeArt={withTrack("standardizeArt", standardizeArtwork)}
              onFindArtwork={withTrack1("findArtwork", (paths: string[]) => setArtworkPaths(paths))}
              onJunkArt={withTrack("junkArt", () => setJunkArtOpen(true))}
              onStandardizeContainers={withTrack("standardizeContainers", standardizeContainers)}
              onRename={withTrack("renameToStandard", renameToStandard)}
              onClearFields={withTrack1("clearFields", runClearFields)}
              onAddGenre={noteNewGenre}
              onRenameGenre={renameGenreEverywhere}
              genreOptions={genreOptions}
              onBackup={withTrack("backup", runBackup)}
              onRestore={withTrack("restore", restoreBackup)}
              onBackupArchive={withTrack("backupArchive", runBackupArchive)}
              onEditField={editField}
              onEditRawField={editRawField}
              onEditRating={editRating}
              onInspect={inspect}
              onDeleteFile={(f, opts) => {
                analytics.track("deleteFile");
                return deleteFile(f, opts);
              }}
              onRenameFile={renameSingleFile}
              imageInfo={imageInfoApi.info}
              onFetchImageInfo={imageInfoApi.fetchOne}
              onSetCoverArt={withTrack1("setCoverArt", setCoverArt)}
              onRemoveCoverArt={withTrack1("removeCoverArt", removeCoverArt)}
              onSaveSettings={savePatch}
              backupFieldId={
                settings.searchableBackup
                  ? settings.backupField.charAt(0).toLowerCase() + settings.backupField.slice(1)
                  : null
              }
              shortcuts={settings.shortcuts}
              onTrack={analytics.track}
              notify={notify}
              logWheelEvents={logWheelEvents}
            />
          ) : page === "duplicates" ? (
            <DuplicatesPage
              files={filesApi.files}
              tags={libraryTags}
              notify={notify}
              onDelete={deleteDuplicateFiles}
              onShowInLibrary={(path) => {
                setPage("library");
                requestFocusPath(path);
              }}
              onInspect={(path) => {
                const file = filesApi.files.find((f) => f.path === path);
                if (file) inspect(file);
              }}
            />
          ) : page === "ytmusic" ? (
            <YtMusicImportPage
              files={wholeCollection.files}
              tags={wholeCollection.tags}
              indexedCount={libraryIndex.stats?.trackCount ?? 0}
              libraryTracks={libraryIndex.tracks}
              libraryFiles={libraryIndex.files}
              libraryTags={libraryIndex.tags}
              libraryGenres={libraryIndex.genres}
              settings={settings}
              notify={notify}
              indexing={libraryIndex.indexing}
              lastIndexedAt={libraryIndex.stats?.lastIndexedAt ?? null}
              onIndexNow={() => void libraryIndex.runIndex(false)}
              onInspect={(path) => {
                const file = filesApi.files.find((f) => f.path === path);
                if (file) {
                  inspect(file);
                  return;
                }
                // Indexed-only track (never opened this session): the index
                // has the curated fields but not `allFields`, so this reads
                // the file directly instead of showing "not loaded" — the
                // inspector is read-only either way, so there's no edit path
                // to wire up for a track that isn't part of the session.
                const indexed = wholeCollection.files.find((f) => f.path === path);
                if (!indexed) {
                  notify("That file could not be found — it may have moved or been deleted", "error");
                  return;
                }
                void (async () => {
                  try {
                    const { map, errors } = await tagsApi.read([path]);
                    const tags = map[path];
                    if (tags) setInspected({ file: indexed, tags });
                    else notify(errors[0] ?? `Could not read tags for ${indexed.filename}`, "error");
                  } catch (e) {
                    notify(String(e), "error");
                  }
                })();
              }}
              onAddToBatch={(paths) => void filesApi.importPaths(paths)}
            />
          ) : page === "components" ? (
            <ComponentsPage
              ollamaUrl={settings.ollamaUrl}
              notify={notify}
              onOllamaChanged={() => void ai.check(settingsRef.current.ollamaUrl)}
              onFfmpegChanged={refreshFfmpeg}
            />
          ) : page === "logs" ? (
            <LogsPage
              logs={logs}
              onClear={() => setLogs([])}
              actionCounts={analytics.counts}
              onResetActionCounts={analytics.reset}
              logWheelEvents={logWheelEvents}
              onToggleLogWheelEvents={setLogWheelEvents}
            />
          ) : (
            <SettingsPage
              settings={settings}
              onSave={save}
              onUpdate={update}
              onRenameGenre={renameGenreEverywhere}
              collectionGenreGroups={collectionGenreGroups}
              libraryIndex={libraryIndex}
              onMergeGenreVariants={mergeGenreVariants}
              onRunTrackIdMigration={runTrackIdMigration}
              checkOllama={ai.check}
              notify={notify}
            />
          )}
          </ErrorBoundary>
          </Suspense>
        </main>
      </div>

      <LyricsPanel storage={settings.lyricsStorage} onStored={(p, r) => r.embedded && void reindexLibraryPaths([p])} />

      <StatusBar
        fileCount={filesApi.files.length}
        selectedCount={filesApi.selectedPaths.length}
        totalSize={filesApi.totalSize}
        progress={progress}
        busy={busy || filesApi.scanning || backupRunning || aiRunning}
      />

      {dropActive && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-primary/10 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-2 rounded-xl border-2 border-dashed border-primary bg-card/90 px-10 py-8 text-primary">
            <Upload className="h-8 w-8" />
            <span className="text-sm font-medium">Drop audio files or folders to add them</span>
          </div>
        </div>
      )}

      <Suspense fallback={null}>
      {manual && (
        <ManualAIDialog
          paths={manual.paths}
          tags={manual.map}
          transliterateScripts={settings.transliterateScripts}
          chunkSize={settings.manualChunkSize}
          onChunkSizeChange={(size) => void update((prev) => ({ ...prev, manualChunkSize: size }))}
          onCancel={() => setManual(null)}
          onDone={applyManualResults}
        />
      )}

      {artworkPaths && (
        <Suspense fallback={null}>
          <ArtworkDialog
            paths={artworkPaths}
            durations={Object.fromEntries(filesApi.files.map((f) => [f.path, f.durationSecs]))}
            artworkMaxDim={settings.artworkMaxDim}
            artworkJpegQuality={settings.artworkJpegQuality}
            onApplied={artworkApplied}
            onClose={() => setArtworkPaths(null)}
          />
        </Suspense>
      )}
      {junkArtOpen && (
        <Suspense fallback={null}>
          <JunkArtDialog
            onRemoveArt={removeArtForPaths}
            onFindArt={(paths) => setArtworkPaths(paths)}
            notify={notify}
            onClose={() => setJunkArtOpen(false)}
          />
        </Suspense>
      )}
      {organizePaths && (
        <OrganizeDialog
          paths={organizePaths}
          settings={settings}
          readTags={readTagMap}
          onClose={() => setOrganizePaths(null)}
          onMoved={applyMoves}
          notify={notify}
        />
      )}

      {convertOpen && (
        <ConvertDialog
          ffmpeg={ffmpegInfo}
          count={
            convertSeedFile
              ? 1
              : filesApi.files.filter((f) => filesApi.selected.has(f.path)).length
          }
          settings={settings}
          onSaveSettings={savePatch}
          onCancel={() => {
            setConvertOpen(false);
            setConvertSeedFile(null);
          }}
          onConvert={runConvert}
          onGoComponents={() => {
            setConvertOpen(false);
            setConvertSeedFile(null);
            setPage("components");
          }}
        />
      )}

      {stemsPaths && demucsInfo && (
        <StemsDialog
          paths={stemsPaths}
          info={demucsInfo}
          options={settings.stemOptions}
          onSaveOptions={(stemOptions) => void update((prev) => ({ ...prev, stemOptions }))}
          onClose={() => setStemsPaths(null)}
          notify={notify}
        />
      )}

      {unifyState && (
        <UnifyDialog
          groups={unifyState.groups}
          alternates={unifyState.alternates}
          onCancel={() => setUnifyState(null)}
          onConfirm={() => void applyUnify()}
        />
      )}
      </Suspense>

      {inspected && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setInspected(null)}
        >
          <Card className="max-h-[85vh] w-[600px] overflow-y-auto">
            <div onClick={(e) => e.stopPropagation()} className="p-5">
              <div className="mb-1 flex items-start justify-between gap-4">
                <h2 className="min-w-0 truncate text-sm font-semibold">
                  {inspected.file.filename}
                </h2>
                <button
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => setInspected(null)}
                  title="Escape"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <p className="mb-4 text-xs text-muted-foreground">
                {inspected.file.format.toUpperCase()} ·{" "}
                {inspected.tags.hasCoverArt ? "has cover art" : "no cover art"} ·{" "}
                {inspected.file.hasBackup ? "backup present" : "no backup"}
              </p>
              <TagDetails tags={inspected.tags} />
            </div>
          </Card>
        </div>
      )}

      {libraryPromptOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <Card className="w-[480px]">
            <div className="p-5">
              <h2 className="mb-1 text-sm font-semibold">Where is your music library?</h2>
              <p className="mb-4 text-xs text-muted-foreground">
                Pick the one folder your finished collection lives in. It's indexed permanently and
                remembered across launches — separate from whatever folder you open to clean up
                right now.
              </p>
              <div className="flex flex-wrap gap-2">
                {suggestedLibraryFolder && (
                  <Button size="sm" onClick={() => void chooseLibraryFolder(suggestedLibraryFolder)}>
                    Use {suggestedLibraryFolder}
                  </Button>
                )}
                <Button variant="secondary" size="sm" onClick={pickLibraryFolder}>
                  Choose folder…
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setLibraryPromptOpen(false)}>
                  Not now
                </Button>
              </div>
            </div>
          </Card>
        </div>
      )}

      <div className="pointer-events-none fixed bottom-10 right-4 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              "pointer-events-auto max-w-sm rounded-lg border px-3 py-2 text-xs shadow-lg",
              t.kind === "success"
                ? "border-primary/40 bg-card text-primary"
                : t.kind === "error"
                  ? "border-destructive/40 bg-card text-destructive"
                  : "bg-card text-foreground",
            )}
          >
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}

function TagDetails({ tags }: { tags: TagData }) {
  const rows = Object.entries(FIELD_LABELS)
    .map(([field, label]) => ({
      label,
      value: (tags as unknown as Record<string, string | undefined>)[field],
    }))
    .filter((r) => r.value);
  const extras = Object.entries(tags.allFields);

  return (
    <>
      <table className="w-full text-left text-xs">
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-t border-border/50">
              <td className="w-32 py-1.5 pr-3 text-muted-foreground">{r.label}</td>
              <td className="py-1.5">{r.value}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {extras.length > 0 && (
        <>
          <h3 className="mb-1 mt-6 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            All tag fields ({extras.length})
          </h3>
          <table className="w-full text-left text-xs">
            <tbody>
              {extras.map(([key, value]) => (
                <tr key={key} className="border-t border-border/50">
                  <td className="w-48 py-1 pr-3 align-top font-mono text-[11px] text-muted-foreground">
                    {key}
                  </td>
                  <td className="max-w-0 truncate py-1" title={value}>
                    {value}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
