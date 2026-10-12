/**
 * Registrations of the app's own actions into the registry (D1).
 *
 * Everything here *wraps* an existing handler from App.tsx/hooks; no logic was
 * moved. `AppEnv` is the narrow slice of app state/handlers the actions need;
 * `App` builds one per render and hands it over as a getter, so a registered
 * action always sees the newest closure (the handlers close over React state).
 *
 * Adding an action = one `reg.register({...})` call below (or from anywhere
 * else with access to `actionRegistry`, e.g. C1 playlists, B3 lyrics, D2 plugins).
 *
 * Convention: actions that need review (standardize, AI clean, Rekordbox ->
 * tags, ...) only build the *preview* (`pending`); the caller then reads it with
 * `changes.get` and writes it with `changes.apply`. Nothing is written by a
 * preview step.
 */
import { invoke } from "@tauri-apps/api/core";
import type { AudioFile, Capitalization, PendingChange, Settings, TagData } from "../types";
import { searchTracks } from "./trackSearch";
import type { ActionCtx, ActionRegistry, JsonSchema } from "./actions";
import { NO_PARAMS } from "./actions";
import type { FacetPick } from "./facets";

export const PAGES = ["library", "duplicates", "playlists", "ytmusic", "components", "plugins", "settings", "logs"] as const;
export type AppPage = (typeof PAGES)[number];

export interface AppEnv {
  page: AppPage;
  setPage: (p: AppPage) => void;
  busy: boolean;
  settings: Settings;
  /** Every column the table can show (id + label), from TrackTable's ALL_COLUMNS. */
  columns: { id: string; label: string }[];
  savePatch: (patch: Partial<Settings>) => void;
  notify: ActionCtx["notify"];

  files: AudioFile[];
  selectedPaths: string[];
  setSelection: (paths: string[]) => void;
  importPaths: (paths: string[]) => Promise<void>;
  /** Tags of loaded tracks, read on demand. */
  readTags: (paths: string[]) => Promise<{ map: Record<string, TagData>; errors: string[] }>;

  library: {
    files: AudioFile[];
    tags: Record<string, TagData>;
    stats: unknown;
    facets: unknown;
    runIndex: (full: boolean) => Promise<unknown>;
  };

  pending: PendingChange[] | null;
  previewMode: string;
  canUndo: boolean;
  canRedo: boolean;

  h: {
    applyPending: () => Promise<void>;
    cancelPending: () => void;
    undo: () => Promise<unknown> | void;
    redo: () => Promise<unknown> | void;
    capitalization: (mode: Capitalization) => Promise<unknown> | void;
    characterRules: () => Promise<unknown> | void;
    removeChars: () => Promise<unknown> | void;
    aiClean: () => Promise<unknown> | void;
    clearFields: (fields: string[]) => Promise<unknown> | void;
    generateIds: () => Promise<unknown> | void;
    rekordboxToTags: () => Promise<unknown> | void;
    migrateTrackIds: () => Promise<unknown> | void;
    startUnify: () => Promise<unknown> | void;
    standardizeArtwork: () => Promise<unknown> | void;
    removeArt: (paths: string[]) => Promise<unknown> | void;
    standardizeContainers: () => Promise<unknown> | void;
    renameToStandard: () => Promise<unknown> | void;
    renameFile: (path: string, newStem: string) => Promise<unknown> | void;
    editField: (paths: string[], field: string, value: string) => Promise<unknown> | void;
    editRawField: (paths: string[], rawKey: string, value: string) => Promise<unknown> | void;
    editRating: (paths: string[], stars: number) => Promise<unknown> | void;
    deleteFile: (file: AudioFile) => Promise<unknown> | void;
    deleteDuplicates: (paths: string[]) => Promise<boolean>;
    backup: () => Promise<unknown> | void;
    restoreBackup: () => Promise<unknown> | void;
    backupArchive: () => Promise<unknown> | void;
    runConvert: (opts: {
      preset: string;
      output: "alongside" | "subfolder";
      addToLibrary: boolean;
      deleteOriginals: boolean;
    }) => Promise<unknown> | void;
    openConvert: () => void;
    openStems: () => Promise<unknown> | void;
    openOrganize: (paths: string[]) => void;
    openFindArtwork: (paths: string[]) => void;
    openJunkArt: () => void;
    loadFacet: (pick: FacetPick) => Promise<unknown> | void;
    showCompare: () => void;
    fetchLyrics: (paths: string[]) => Promise<unknown> | void;
    detectLanguage: (paths: string[]) => Promise<unknown> | void;
  };
}

const str = (description?: string): JsonSchema => ({ type: "string", description });
const paths = (description = "Absolute file paths"): JsonSchema => ({
  type: "array",
  items: { type: "string" },
  minItems: 1,
  maxItems: 5000,
  description,
});
const obj = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

/** Settings keys never shown to a client (none today; keep the guard for future secrets). */
const SECRET_SETTING = /(api.?key|token|secret|password)/i;

export function publicSettings(s: Settings): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) out[k] = SECRET_SETTING.test(k) ? "(hidden)" : v;
  return out;
}

const TAG_FIELDS = [
  "title", "artist", "album", "albumArtist", "trackNumber", "discNumber", "year", "genre",
  "comment", "composer", "originalArtist", "trackId", "bpm", "key", "language",
];

export function registerAppActions(reg: ActionRegistry, get: () => AppEnv): void {
  const env = () => get();
  /** Tracks of the session by path, so an AI can't make us touch a file that isn't loaded. */
  const loaded = (ps: string[]) => {
    const have = new Set(env().files.map((f) => f.path));
    const missing = ps.filter((p) => !have.has(p));
    if (missing.length) {
      throw new Error(
        `${missing.length} path(s) are not in the session (first: ${missing[0]}). Load them with session.open or library.addToSession first.`,
      );
    }
  };
  /** Runs `fn` with exactly `ps` selected (the wrapped handlers all act on the selection). */
  const withSelection = async (ps: string[], fn: () => unknown) => {
    loaded(ps);
    env().setSelection(ps);
    await reg.settle();
    return fn();
  };
  const fileInfo = (f: AudioFile, sel: Set<string>) => ({
    path: f.path,
    filename: f.filename,
    format: f.format,
    sizeBytes: f.size,
    durationSecs: f.durationSecs,
    bitrateKbps: f.bitrateKbps,
    selected: sel.has(f.path),
    hasBackup: f.hasBackup,
  });
  const summary = (t: TagData | undefined) =>
    t && {
      title: t.title, artist: t.artist, album: t.album, albumArtist: t.albumArtist, genre: t.genre,
      year: t.year, bpm: t.bpm, key: t.key, rating: t.rating, trackId: t.trackId, hasCoverArt: t.hasCoverArt,
    };

  // ---- queries -------------------------------------------------------------

  reg.register({
    id: "app.info",
    title: "App state",
    description: "Current page, whether the app is busy, track counts, whether a preview is waiting to be applied.",
    params: NO_PARAMS,
    readOnly: true,
    run: () => {
      const e = env();
      return {
        page: e.page,
        busy: e.busy,
        sessionTracks: e.files.length,
        selectedTracks: e.selectedPaths.length,
        libraryTracks: e.library.files.length,
        previewWaiting: e.pending ? { mode: e.previewMode, rows: e.pending.length } : null,
        canUndo: e.canUndo,
        canRedo: e.canRedo,
      };
    },
  });

  reg.register({
    id: "session.list",
    title: "List session tracks",
    description:
      "Tracks loaded in the current tab (the working batch). Paged; set withTags to include a tag summary (reads the files).",
    params: obj({
      offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: 1000, description: "Default 200" },
      withTags: { type: "boolean" },
    }),
    readOnly: true,
    run: async (p: { offset?: number; limit?: number; withTags?: boolean }) => {
      const e = env();
      const sel = new Set(e.selectedPaths);
      const offset = p.offset ?? 0;
      const slice = e.files.slice(offset, offset + (p.limit ?? 200));
      let tags: Record<string, TagData> = {};
      if (p.withTags && slice.length) tags = (await e.readTags(slice.map((f) => f.path))).map;
      return {
        total: e.files.length,
        offset,
        tracks: slice.map((f) => ({ ...fileInfo(f, sel), tags: summary(tags[f.path]) })),
      };
    },
  });

  reg.register({
    id: "session.selection",
    title: "Current selection",
    description: "The selected tracks in the session table, with a tag summary.",
    params: NO_PARAMS,
    readOnly: true,
    run: async () => {
      const e = env();
      const sel = new Set(e.selectedPaths);
      const picked = e.files.filter((f) => sel.has(f.path)).slice(0, 500);
      const tags = picked.length ? (await e.readTags(picked.map((f) => f.path))).map : {};
      return {
        count: e.selectedPaths.length,
        tracks: picked.map((f) => ({ ...fileInfo(f, sel), tags: summary(tags[f.path]) })),
        truncated: e.selectedPaths.length > picked.length,
      };
    },
  });

  reg.register({
    id: "session.open",
    title: "Add files or folders to the session",
    description: "Imports audio files/folders into the current session (like dropping them on the window).",
    params: obj({ paths: paths("Files or folders") }, ["paths"]),
    run: async (p: { paths: string[] }) => {
      await env().importPaths(p.paths);
      return { sessionTracks: env().files.length };
    },
  });

  reg.register({
    id: "library.search",
    title: "Search the indexed library",
    description:
      'Search every indexed track. Same syntax as the app search box: plain words, "quoted phrases", -negation, and field filters like artist:, genre:, bpm:, key:.',
    params: obj(
      { query: { type: "string", minLength: 1 }, limit: { type: "integer", minimum: 1, maximum: 500 } },
      ["query"],
    ),
    readOnly: true,
    run: (p: { query: string; limit?: number }) => {
      const lib = env().library;
      const hits = searchTracks(lib.files, lib.tags, p.query, p.limit ?? 50);
      return hits.map((h) => ({ ...fileInfo(h.file, new Set()), tags: summary(lib.tags[h.file.path]) }));
    },
  });

  reg.register({
    id: "library.stats",
    title: "Library index stats and facets",
    description: "Track count, last index time, genre and album buckets with counts.",
    params: NO_PARAMS,
    readOnly: true,
    run: () => ({ stats: env().library.stats, facets: env().library.facets }),
  });

  reg.register({
    id: "library.addToSession",
    title: "Add indexed tracks to the session",
    description: "Adds library tracks (by path, e.g. from library.search) to the session so actions can act on them.",
    params: obj({ paths: paths() }, ["paths"]),
    run: async (p: { paths: string[] }) => {
      await env().importPaths(p.paths);
      return { sessionTracks: env().files.length };
    },
  });

  reg.register({
    id: "library.loadFacet",
    title: "Load a genre or album as the working batch",
    params: obj(
      {
        facet: { type: "string", enum: ["genre", "album", "language"] },
        name: str("Genre/album name; empty string loads the 'No genre / No album' bucket"),
        artist: str("Album artist (albums only)"),
      },
      ["facet", "name"],
    ),
    run: async (p: { facet: FacetPick["facet"]; name: string; artist?: string }) => {
      await env().h.loadFacet({ facet: p.facet, name: p.name, artist: p.artist ?? "" });
      await reg.settle();
      return { sessionTracks: env().files.length };
    },
  });

  reg.register({
    id: "library.refresh",
    title: "Refresh the library index",
    description: "Incremental re-index of the Library folder (new/changed/removed files).",
    params: NO_PARAMS,
    run: async () => {
      await env().library.runIndex(false);
      return env().library.stats;
    },
  });

  reg.register({
    id: "track.get",
    title: "Read one file's tags",
    description: "Reads the file itself (all curated tags plus the raw tag dump).",
    params: obj({ path: str() }, ["path"]),
    readOnly: true,
    run: (p: { path: string }) => invoke("read_tags", { path: p.path }),
  });

  reg.register({
    id: "playlists.list",
    title: "List Rekordbox playlists",
    description: "The playlist tree from the rekordbox.xml chosen in Settings.",
    params: NO_PARAMS,
    readOnly: true,
    run: async () => {
      const xml = env().settings.rekordboxXmlPath;
      if (!xml) throw new Error("No rekordbox.xml is set in Settings.");
      return invoke("read_rekordbox_playlists", { xmlPath: xml });
    },
  });

  reg.register({
    id: "settings.get",
    title: "Read app settings",
    params: NO_PARAMS,
    readOnly: true,
    run: () => publicSettings(env().settings),
  });

  reg.register({
    id: "columns.list",
    title: "List table columns",
    description: "Every column id with its label and whether it is visible (in display order for visible ones).",
    params: NO_PARAMS,
    readOnly: true,
    run: () => {
      const vis = env().settings.visibleColumns;
      return {
        visible: vis,
        columns: env().columns.map((c) => ({ ...c, visible: vis.includes(c.id) })),
      };
    },
  });

  reg.register({
    id: "changes.get",
    title: "Read the waiting preview",
    description:
      "Rows of the preview that standardize / AI clean / clear fields / Rekordbox sync built and that changes.apply would write.",
    params: obj({ limit: { type: "integer", minimum: 1, maximum: 2000 } }),
    readOnly: true,
    run: (p: { limit?: number }) => {
      const e = env();
      if (!e.pending) return { mode: null, rows: [] };
      const rows = e.pending.filter((r) => r.changed);
      return {
        mode: e.previewMode,
        totalChanged: rows.length,
        rows: rows.slice(0, p.limit ?? 300).map((r) => ({
          id: r.id, path: r.path, field: r.field, before: r.before, after: r.after, include: r.include, kind: r.kind,
        })),
      };
    },
  });

  // ---- UI state ------------------------------------------------------------

  reg.register({
    id: "table.select",
    title: "Select tracks in the table",
    description:
      "Selects session tracks. Provide paths, or all:true / none:true, or query (app search syntax over the session). add:true keeps the current selection.",
    params: obj({
      paths: { type: "array", items: { type: "string" } },
      all: { type: "boolean" },
      none: { type: "boolean" },
      query: { type: "string" },
      add: { type: "boolean" },
    }),
    run: async (p: { paths?: string[]; all?: boolean; none?: boolean; query?: string; add?: boolean }) => {
      const e = env();
      let next: string[];
      if (p.all) next = e.files.map((f) => f.path);
      else if (p.none) next = [];
      else if (p.query) {
        const tags = (await e.readTags(e.files.map((f) => f.path))).map;
        next = searchTracks(e.files, tags, p.query, e.files.length || 1).map((h) => h.file.path);
      } else if (p.paths) {
        loaded(p.paths);
        next = p.paths;
      } else throw new Error("Give paths, query, all or none");
      if (p.add) next = [...new Set([...e.selectedPaths, ...next])];
      e.setSelection(next);
      return { selected: next.length };
    },
  });

  reg.register({
    id: "table.setColumns",
    title: "Show, hide or reorder table columns",
    description:
      "Use show/hide to toggle columns, or set to give the exact visible list in order. Ids come from columns.list.",
    params: obj({
      show: { type: "array", items: { type: "string" } },
      hide: { type: "array", items: { type: "string" } },
      set: { type: "array", items: { type: "string" } },
    }),
    run: (p: { show?: string[]; hide?: string[]; set?: string[] }) => {
      const known = new Set(env().columns.map((c) => c.id));
      const unknown = [...(p.show ?? []), ...(p.hide ?? []), ...(p.set ?? [])].filter((id) => !known.has(id));
      if (unknown.length) throw new Error(`Unknown column id(s): ${unknown.join(", ")} (see columns.list)`);
      let cols = p.set ? [...new Set(p.set)] : [...env().settings.visibleColumns];
      for (const id of p.show ?? []) if (!cols.includes(id)) cols.push(id);
      const hide = new Set(p.hide ?? []);
      cols = cols.filter((c) => !hide.has(c));
      env().savePatch({ visibleColumns: cols });
      return { visible: cols };
    },
  });

  reg.register({
    id: "nav.goto",
    title: "Go to a page",
    params: obj({ page: { type: "string", enum: [...PAGES] } }, ["page"]),
    run: (p: { page: AppPage }) => {
      env().setPage(p.page);
      return { page: p.page };
    },
  });

  reg.register({
    id: "ui.notify",
    title: "Show a message in the app",
    description: "Toast + Logs entry; use it to tell the person what you are doing.",
    params: obj(
      { message: { type: "string", minLength: 1, maxLength: 500 }, kind: { type: "string", enum: ["info", "success", "error"] } },
      ["message"],
    ),
    run: (p: { message: string; kind?: "info" | "success" | "error" }, ctx) => {
      ctx.notify(p.message, p.kind ?? "info");
      return { shown: true };
    },
  });

  // ---- tag edits (all undoable through the app's history) -----------------

  reg.register({
    id: "tags.edit",
    title: "Set a tag field on tracks",
    description: `Writes one curated field (${TAG_FIELDS.join(", ")}) on the given session tracks. Undoable. Use an empty value to clear.`,
    params: obj(
      { paths: paths(), field: { type: "string", enum: TAG_FIELDS }, value: { type: "string" } },
      ["paths", "field", "value"],
    ),
    run: async (p: { paths: string[]; field: string; value: string }) => {
      loaded(p.paths);
      await env().h.editField(p.paths, p.field, p.value);
      return { edited: p.paths.length };
    },
  });

  reg.register({
    id: "tags.editRaw",
    title: "Set a raw tag frame",
    description: "Writes a raw field by its key as shown in track.get allFields.",
    params: obj({ paths: paths(), key: str(), value: { type: "string" } }, ["paths", "key", "value"]),
    run: async (p: { paths: string[]; key: string; value: string }) => {
      loaded(p.paths);
      await env().h.editRawField(p.paths, p.key, p.value);
      return { edited: p.paths.length };
    },
  });

  reg.register({
    id: "tags.setRating",
    title: "Set star rating",
    params: obj({ paths: paths(), stars: { type: "integer", minimum: 0, maximum: 5 } }, ["paths", "stars"]),
    run: async (p: { paths: string[]; stars: number }) => {
      loaded(p.paths);
      await env().h.editRating(p.paths, p.stars);
      return { edited: p.paths.length };
    },
  });

  reg.register({
    id: "tags.clearFields",
    title: "Preview clearing tag fields",
    description: "Builds a preview that clears the given fields on the paths (e.g. 'album', 'raw:TXXX'). Apply with changes.apply.",
    params: obj({ paths: paths(), fields: { type: "array", items: { type: "string" }, minItems: 1 } }, ["paths", "fields"]),
    run: (p: { paths: string[]; fields: string[] }) =>
      withSelection(p.paths, () => env().h.clearFields(p.fields)).then(() => ({ previewBuilt: true })),
  });

  reg.register({
    id: "tags.standardize",
    title: "Preview Standardize",
    description:
      "Builds a preview of one standardize rule set on the paths: characters (replacements/feat./brackets), capitalization (needs capitalization), or removeChars. Review with changes.get, write with changes.apply.",
    params: obj(
      {
        paths: paths(),
        scope: { type: "string", enum: ["characters", "capitalization", "removeChars"] },
        capitalization: { type: "string", enum: ["upper", "title", "lower", "sentence"] },
      },
      ["paths", "scope"],
    ),
    run: async (p: { paths: string[]; scope: string; capitalization?: Capitalization }) => {
      await withSelection(p.paths, () => {
        if (p.scope === "characters") return env().h.characterRules();
        if (p.scope === "removeChars") return env().h.removeChars();
        if (!p.capitalization) throw new Error("capitalization is required for scope=capitalization");
        return env().h.capitalization(p.capitalization);
      });
      await reg.settle();
      return { previewBuilt: !!env().pending, rows: env().pending?.filter((r) => r.changed).length ?? 0 };
    },
  });

  reg.register({
    id: "tags.aiClean",
    title: "Preview AI Clean",
    description: "Runs the app's configured AI backend over the paths and builds a preview (manual backend opens its dialog instead).",
    params: obj({ paths: paths() }, ["paths"]),
    run: async (p: { paths: string[] }) => {
      await withSelection(p.paths, () => env().h.aiClean());
      await reg.settle();
      return { previewBuilt: !!env().pending, rows: env().pending?.filter((r) => r.changed).length ?? 0 };
    },
  });

  reg.register({
    id: "tags.rekordboxToTags",
    title: "Preview Rekordbox BPM/key/rating into tags",
    params: obj({ paths: paths() }, ["paths"]),
    run: async (p: { paths: string[] }) => {
      await withSelection(p.paths, () => env().h.rekordboxToTags());
      await reg.settle();
      return { previewBuilt: !!env().pending, rows: env().pending?.length ?? 0 };
    },
  });

  reg.register({
    id: "tags.migrateTrackIds",
    title: "Preview moving Track Number IDs into Track ID",
    description: "One-off cleanup over every loaded file.",
    params: NO_PARAMS,
    run: async () => {
      await env().h.migrateTrackIds();
      await reg.settle();
      return { previewBuilt: !!env().pending, rows: env().pending?.length ?? 0 };
    },
  });

  reg.register({
    id: "tags.generateIds",
    title: "Generate Track IDs",
    description: "Assigns the next sequential Track ID to selected tracks that have none. Writes immediately (undo in History).",
    params: obj({ paths: paths() }, ["paths"]),
    run: (p: { paths: string[] }) => withSelection(p.paths, () => env().h.generateIds()).then(() => ({ done: true })),
  });

  reg.register({
    id: "tags.unifyIds",
    title: "Start Unify IDs",
    description: "Scans loaded files for the same song in several formats and opens the Unify dialog for the person to confirm.",
    params: NO_PARAMS,
    run: async () => {
      await env().h.startUnify();
      return { dialogOpened: true };
    },
  });

  reg.register({
    id: "changes.apply",
    title: "Apply the waiting preview",
    description: "Writes every included row of the preview built by a previous action. Undoable.",
    params: NO_PARAMS,
    run: async () => {
      const e = env();
      if (!e.pending) throw new Error("There is no preview waiting");
      const rows = e.pending.filter((r) => r.changed && r.include).length;
      await e.h.applyPending();
      return { rowsApplied: rows };
    },
  });

  reg.register({
    id: "changes.cancel",
    title: "Discard the waiting preview",
    params: NO_PARAMS,
    run: () => {
      env().h.cancelPending();
      return { cancelled: true };
    },
  });

  reg.register({
    id: "history.undo",
    title: "Undo the last change",
    params: NO_PARAMS,
    run: async () => {
      if (!env().canUndo) throw new Error("Nothing to undo");
      await env().h.undo();
      return { undone: true };
    },
  });

  reg.register({
    id: "history.redo",
    title: "Redo",
    params: NO_PARAMS,
    run: async () => {
      if (!env().canRedo) throw new Error("Nothing to redo");
      await env().h.redo();
      return { redone: true };
    },
  });

  // ---- files, artwork, backup, convert -------------------------------------

  reg.register({
    id: "files.rename",
    title: "Rename one file",
    description: "Changes the file name (without extension) of a session track.",
    params: obj({ path: str(), newStem: { type: "string", minLength: 1 } }, ["path", "newStem"]),
    dangerous: true,
    run: async (p: { path: string; newStem: string }) => {
      loaded([p.path]);
      await env().h.renameFile(p.path, p.newStem);
      return { done: true };
    },
  });

  reg.register({
    id: "files.renameToStandard",
    title: "Rename files to the standard pattern",
    description: "Renames the given tracks to 'Artist - Title' style names.",
    params: obj({ paths: paths() }, ["paths"]),
    dangerous: true,
    run: (p: { paths: string[] }) => withSelection(p.paths, () => env().h.renameToStandard()).then(() => ({ done: true })),
  });

  reg.register({
    id: "files.delete",
    title: "Move a file to the Recycle Bin",
    params: obj({ path: str() }, ["path"]),
    dangerous: true,
    confirmsItself: true,
    run: async (p: { path: string }) => {
      const f = env().files.find((x) => x.path === p.path);
      if (!f) throw new Error("That file is not in the session");
      await env().h.deleteFile(f);
      return { requested: true };
    },
  });

  reg.register({
    id: "files.standardizeContainers",
    title: "Move tags into each format's standard container",
    params: obj({ paths: paths() }, ["paths"]),
    dangerous: true,
    confirmsItself: true,
    run: (p: { paths: string[] }) =>
      withSelection(p.paths, () => env().h.standardizeContainers()).then(() => ({ done: true })),
  });

  reg.register({
    id: "duplicates.delete",
    title: "Delete duplicate files",
    description: "Moves the given files to the Recycle Bin after the app's own confirmation. Find duplicates on the Duplicates page first.",
    params: obj({ paths: paths() }, ["paths"]),
    dangerous: true,
    confirmsItself: true,
    run: async (p: { paths: string[] }) => ({ deleted: await env().h.deleteDuplicates(p.paths) }),
  });

  reg.register({
    id: "artwork.standardize",
    title: "Standardize artwork",
    description: "Re-encodes embedded covers to the size/quality in Settings. Undoable.",
    params: obj({ paths: paths() }, ["paths"]),
    run: (p: { paths: string[] }) => withSelection(p.paths, () => env().h.standardizeArtwork()).then(() => ({ done: true })),
  });

  reg.register({
    id: "artwork.remove",
    title: "Remove embedded artwork",
    params: obj({ paths: paths() }, ["paths"]),
    run: async (p: { paths: string[] }) => {
      loaded(p.paths);
      await env().h.removeArt(p.paths);
      return { done: true };
    },
  });

  reg.register({
    id: "artwork.find",
    title: "Open Find Artwork",
    description: "Opens the artwork lookup dialog (MusicBrainz / iTunes / Deezer) for the tracks; the person picks.",
    params: obj({ paths: paths() }, ["paths"]),
    run: (p: { paths: string[] }) => {
      loaded(p.paths);
      env().h.openFindArtwork(p.paths);
      return { dialogOpened: true };
    },
  });

  reg.register({
    id: "artwork.junkArt",
    title: "Open Junk Art scan",
    params: NO_PARAMS,
    run: () => {
      env().h.openJunkArt();
      return { dialogOpened: true };
    },
  });

  reg.register({
    id: "organize.open",
    title: "Open Move to collection",
    description: "Opens the organize dialog with a move preview for the tracks; the person confirms the move.",
    params: obj({ paths: paths() }, ["paths"]),
    run: (p: { paths: string[] }) => {
      loaded(p.paths);
      env().h.openOrganize(p.paths);
      return { dialogOpened: true };
    },
  });

  reg.register({
    id: "convert.open",
    title: "Open Convert dialog",
    params: obj({ paths: paths() }, ["paths"]),
    run: async (p: { paths: string[] }) => {
      await withSelection(p.paths, () => env().h.openConvert());
      return { dialogOpened: true };
    },
  });

  reg.register({
    id: "convert.run",
    title: "Convert tracks to another format",
    description: "Runs ffmpeg on the tracks. preset e.g. mp3-320, mp3-v0, flac, alac. deleteOriginals recycles the sources.",
    params: obj(
      {
        paths: paths(),
        preset: str("Preset id as in the Convert dialog"),
        output: { type: "string", enum: ["alongside", "subfolder"] },
        addToLibrary: { type: "boolean" },
        deleteOriginals: { type: "boolean" },
      },
      ["paths", "preset"],
    ),
    dangerous: true,
    run: (p: { paths: string[]; preset: string; output?: "alongside" | "subfolder"; addToLibrary?: boolean; deleteOriginals?: boolean }) =>
      withSelection(p.paths, () =>
        env().h.runConvert({
          preset: p.preset,
          output: p.output ?? env().settings.convertOutput,
          addToLibrary: !!p.addToLibrary,
          deleteOriginals: !!p.deleteOriginals,
        }),
      ).then(() => ({ done: true })),
  });

  reg.register({
    id: "stems.open",
    title: "Open Stem separation",
    params: obj({ paths: paths() }, ["paths"]),
    run: async (p: { paths: string[] }) => {
      await withSelection(p.paths, () => env().h.openStems());
      return { dialogOpened: true };
    },
  });

  reg.register({
    id: "lyrics.fetch",
    title: "Fetch lyrics (LRCLIB)",
    description: "Looks up lyrics online and stores them per the 'Store fetched lyrics' setting (sidecar .lrc/.txt by default). Needs internet.",
    params: obj({ paths: paths() }, ["paths"]),
    run: async (p: { paths: string[] }) => {
      loaded(p.paths);
      await env().h.fetchLyrics(p.paths);
      return { done: true };
    },
  });

  reg.register({
    id: "language.detect",
    title: "Preview language detection",
    description: "Guesses each track's language (offline) and builds a preview of Language tag changes; apply with changes.apply.",
    params: obj({ paths: paths() }, ["paths"]),
    run: async (p: { paths: string[] }) => {
      loaded(p.paths);
      await env().h.detectLanguage(p.paths);
      await reg.settle();
      return { previewBuilt: !!env().pending, rows: env().pending?.filter((r) => r.changed).length ?? 0 };
    },
  });

  reg.register({
    id: "backup.tags",
    title: "Back up tags into the files",
    params: obj({ paths: paths() }, ["paths"]),
    run: (p: { paths: string[] }) => withSelection(p.paths, () => env().h.backup()).then(() => ({ done: true })),
  });

  reg.register({
    id: "backup.restore",
    title: "Restore tags from their backup",
    params: obj({ paths: paths() }, ["paths"]),
    dangerous: true,
    run: (p: { paths: string[] }) => withSelection(p.paths, () => env().h.restoreBackup()).then(() => ({ done: true })),
  });

  reg.register({
    id: "backup.archive",
    title: "Save a backup .zip of tracks",
    description: "Opens the save dialog for a zip of the selected tracks.",
    params: obj({ paths: paths() }, ["paths"]),
    run: (p: { paths: string[] }) => withSelection(p.paths, () => env().h.backupArchive()).then(() => ({ done: true })),
  });

  // ---- DJ playlists (C1) -----------------------------------------------------
  // Straight to the dj_* commands: they don't depend on any App state. Writes
  // are all `dangerous` because the same action can target Mixxx's database.

  const SRC: JsonSchema = { type: "string", enum: ["rekordbox", "mixxx", "mtc"], description: "rekordbox (read-only) | mixxx | mtc (Music Tag Cleaner's own)" };
  const WSRC: JsonSchema = { type: "string", enum: ["mixxx", "mtc"], description: "mixxx (needs Mixxx closed; backed up first) | mtc" };
  const loadSnap = (source: string) => invoke<DjSnapshotLite>("dj_load", { source });

  reg.register({
    id: "djplaylists.list",
    title: "List playlists of Rekordbox, Mixxx or Music Tag Cleaner",
    description: "Tree of folders, playlists, smart playlists and crates with ids and track counts.",
    params: obj({ source: SRC }, ["source"]),
    readOnly: true,
    run: async (p: { source: string }) => {
      const s = await loadSnap(p.source);
      return s.nodes.map((n) => ({ id: n.id, parentId: n.parentId, name: n.name, kind: n.kind, tracks: n.count }));
    },
  });

  reg.register({
    id: "djplaylists.tracks",
    title: "List the tracks of a playlist",
    description: "Static playlists only (a Rekordbox smart playlist's members are computed in the Playlists page). Capped at 2000.",
    params: obj({ source: SRC, id: str("Playlist id from djplaylists.list") }, ["source", "id"]),
    readOnly: true,
    run: async (p: { source: string; id: string }) => {
      const s = await loadSnap(p.source);
      const ids = s.members[p.id];
      if (!ids) throw new Error("No stored members for that id (folder, smart playlist, or unknown).");
      const byId = new Map(s.tracks.map((t) => [t.id, t]));
      return ids.slice(0, 2000).map((id) => {
        const t = byId.get(id);
        return { path: t?.path ?? id, title: t?.title, artist: t?.artist };
      });
    },
  });

  reg.register({
    id: "djplaylists.create",
    title: "Create a playlist (or folder / crate)",
    description: "kind: playlist | folder (mtc only) | crate (mixxx only). Tracks are matched by file path; unmatched paths are returned.",
    params: obj(
      { source: WSRC, name: str(), kind: { type: "string", enum: ["playlist", "folder", "crate"] }, paths: { type: "array", items: { type: "string" }, maxItems: 20000 } },
      ["source", "name"],
    ),
    dangerous: true,
    run: async (p: { source: string; name: string; kind?: string; paths?: string[] }) => {
      const r = await invoke<unknown[]>("dj_apply", { source: p.source, ops: [{ op: "create", name: p.name, kind: p.kind ?? "playlist", paths: p.paths ?? [] }] });
      env().notify(`Created playlist “${p.name}”`, "success", { silent: true });
      return r[0];
    },
  });

  reg.register({
    id: "djplaylists.setTracks",
    title: "Replace a playlist's tracks",
    params: obj({ source: WSRC, id: str(), paths: { type: "array", items: { type: "string" }, maxItems: 20000 } }, ["source", "id", "paths"]),
    dangerous: true,
    run: async (p: { source: string; id: string; paths: string[] }) =>
      (await invoke<unknown[]>("dj_apply", { source: p.source, ops: [{ op: "setTracks", id: p.id, paths: p.paths }] }))[0],
  });

  reg.register({
    id: "djplaylists.rename",
    title: "Rename a playlist",
    params: obj({ source: WSRC, id: str(), name: str() }, ["source", "id", "name"]),
    dangerous: true,
    run: async (p: { source: string; id: string; name: string }) =>
      (await invoke<unknown[]>("dj_apply", { source: p.source, ops: [{ op: "rename", id: p.id, name: p.name }] }))[0],
  });

  reg.register({
    id: "djplaylists.delete",
    title: "Delete a playlist, folder or crate",
    description: "Tracks themselves are never touched. A folder takes its contents with it.",
    params: obj({ source: WSRC, id: str() }, ["source", "id"]),
    dangerous: true,
    run: async (p: { source: string; id: string }) =>
      (await invoke<unknown[]>("dj_apply", { source: p.source, ops: [{ op: "delete", id: p.id }] }))[0],
  });

  reg.register({
    id: "djplaylists.open",
    title: "Open the Playlists page",
    params: NO_PARAMS,
    run: () => {
      env().setPage("playlists");
      return { page: "playlists" };
    },
  });

  // ---- Rekordbox <-> Mixxx sync (C2) -----------------------------------------
  // `preview` only reads both libraries; `apply` writes Mixxx (closed, backed up,
  // one transaction) and optionally a rekordbox.xml. Conflicts are never resolved
  // here: they are left alone and counted.

  const syncPlan = async () => {
    const { normalizeSettings, planFromRaw, readRaw } = await import("./djSyncRun");
    return planFromRaw(await readRaw(), normalizeSettings(env().settings.djSync));
  };

  reg.register({
    id: "djsync.preview",
    title: "Preview a Rekordbox <-> Mixxx sync",
    description:
      "Counts of what a sync would change per item (playlists, BPM, key, rating, play count, comment, colour) and in which direction, plus conflicts. Uses the directions chosen in the sync dialog. Writes nothing.",
    params: NO_PARAMS,
    readOnly: true,
    run: async () => {
      const { summarize } = await import("./djSync");
      const { plan } = await syncPlan();
      return {
        firstSync: plan.firstSync,
        perItem: summarize(plan),
        conflicts: plan.conflicts.length,
        ignored: plan.ignored,
        samples: plan.lists.slice(0, 20).map((l) => ({ action: l.action, target: l.target, name: l.name })),
      };
    },
  });

  reg.register({
    id: "djsync.apply",
    title: "Apply a Rekordbox <-> Mixxx sync",
    description:
      "Applies everything djsync.preview lists except conflicts. Mixxx must be closed. Changes bound for Rekordbox are written to xmlPath (a rekordbox.xml the owner imports); omit xmlPath to leave them pending.",
    params: obj({ xmlPath: str("Where to save the rekordbox.xml for Rekordbox-bound changes") }, []),
    dangerous: true,
    run: async (p: { xmlPath?: string }) => {
      const { applyPlan, describeReport } = await import("./djSyncRun");
      const { noSelection } = await import("./djSync");
      const loaded = await syncPlan();
      const r = await applyPlan(loaded, noSelection(), p.xmlPath ?? null);
      env().notify(`DJ sync: ${describeReport(r)}`, "success", { silent: true });
      return { ...r, conflictsLeft: loaded.plan.conflicts.length };
    },
  });

  // ---- scripting -----------------------------------------------------------

  reg.register({
    id: "script.run",
    title: "Run several actions in order",
    description:
      "steps: [{action, params, continueOnError?}]. dryRun:true validates and returns the plan (which steps are dangerous) without running anything. Stops at the first failure unless continueOnError.",
    params: obj(
      {
        steps: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: obj({ action: str(), params: { type: "object" }, continueOnError: { type: "boolean" } }, ["action"]),
        },
        dryRun: { type: "boolean" },
      },
      ["steps"],
    ),
    run: (p: { steps: { action: string; params?: unknown; continueOnError?: boolean }[]; dryRun?: boolean }, ctx) =>
      reg.runScript(p.steps, { dryRun: p.dryRun }, ctx),
  });
}

/** The slice of a `dj_load` snapshot the playlist actions read. */
interface DjSnapshotLite {
  nodes: { id: string; parentId: string | null; name: string; kind: string; count: number }[];
  tracks: { id: string; path: string; title: string; artist: string }[];
  members: Record<string, string[]>;
}
