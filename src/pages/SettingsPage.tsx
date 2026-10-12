import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Notify } from "../hooks/useFiles";
import { listen } from "@tauri-apps/api/event";
import { confirm, open, save } from "@tauri-apps/plugin-dialog";
import {
  ArrowRightLeft,
  Download,
  FolderOpen,
  Library,
  ListMusic,
  Loader2,
  Plus,
  PlugZap,
  RefreshCw,
  Sparkles,
  Terminal,
  Upload,
  X,
} from "lucide-react";
import type {
  CharReplacement,
  ClaudeCliInfo,
  DjApp,
  ImportResult,
  OllamaStatus,
  Settings,
} from "../types";
import { CONVERT_PRESETS } from "../types";
import {
  CAP_OPTIONS,
  CLEARABLE_FIELDS,
  DJ_APP_LABELS,
  DJ_APP_RATING_SCALE,
  FIELD_LABELS,
  recommendedBackupField,
  TRANSLITERATE_SCRIPTS,
} from "../types";
import { migrate, mergeWithDefaults, CURRENT_SETTINGS_VERSION, DEFAULT_SETTINGS } from "../hooks/useSettings";
import { STANDARDIZE_FIELDS } from "../hooks/useTags";
import { ALLOWED_DESCRIPTION, DEFAULT_FLAG_EXTRA_CHARS } from "../lib/standardize";
import { SHORTCUTS, comboFromEvent, shortcutFor } from "../lib/shortcuts";
import type { GenreGroup } from "../lib/genres";
import { Badge, Button, Card, CardHeader, Row, cn, inputClass, selectClass } from "../components/ui";
import { ThemePicker } from "../components/ThemePicker";
import type { PluginManifest } from "../plugins/manifest";
import { Combobox } from "../components/Combobox";
import { RekordboxMixxxExportDialog } from "../components/RekordboxMixxxExportDialog";
import { OrganizeSettingsCard } from "../components/OrganizeSettingsCard";
import { AiControlCard } from "../components/AiControlCard";
import type { LibraryIndexApi } from "../hooks/useLibraryIndex";

interface Props {
  settings: Settings;
  /** Theme plugins found in the plugins folder (D2). */
  installedThemes: PluginManifest[];
  onSave: (settings: Settings) => void;
  /** Read-modify-write against the newest settings (see `useSettings.update`).
   * Every single-field change goes through this: building the whole object
   * from this render's `settings` reverted anything that changed in between —
   * most visibly after an `await`, like the Rekordbox re-import. */
  onUpdate: (fn: (prev: Settings) => Settings) => void;
  /** Renames a genre across the whole collection, after confirming. */
  onRenameGenre: (oldName: string, newName: string) => void;
  /** Every distinct genre spelling in the collection, near-duplicates grouped. */
  collectionGenreGroups: GenreGroup[];
  /** The whole-library index — roots, indexing, and the genre tally. */
  libraryIndex: LibraryIndexApi;
  /** Offers to retag tracks using a non-canonical spelling to the canonical one. */
  onMergeGenreVariants: (variants: string[], canonical: string) => void;
  /** One-off cleanup for a pre-v4 library: offers to move an id sitting in
   * Track Number (isUid()) over to Track ID and clear it. */
  onRunTrackIdMigration: () => void;
  checkOllama: (url: string) => Promise<OllamaStatus>;
  notify: Notify;
}

const BATCH_SIZES = [10, 25, 50, 100];

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-5 w-9 rounded-full transition-colors",
        checked ? "bg-primary" : "bg-input",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all",
          checked ? "left-[18px]" : "left-0.5",
        )}
      />
    </button>
  );
}

/** Client-side cap on the Claude CLI check; the backend ping gives up at 30 s. */
const CLAUDE_CHECK_GUARD_MS = 40_000;

const CLAUDE_MODEL_PRESETS = ["", "haiku", "sonnet", "opus"] as const;
const CLAUDE_MODEL_LABELS: Record<string, string> = {
  "": "Claude Code default",
  haiku: "Haiku",
  sonnet: "Sonnet",
  opus: "Opus",
};
const CLAUDE_EFFORT_PRESETS = ["", "low", "medium", "high"] as const;
const CLAUDE_EFFORT_LABELS: Record<string, string> = {
  "": "Default",
  low: "Low",
  medium: "Medium",
  high: "High",
};

/** A model picker for a Claude CLI task: Haiku/Sonnet/Opus/CLI-default, or a
 * free-typed model id via "Custom". */
function ModelSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const isPreset = (CLAUDE_MODEL_PRESETS as readonly string[]).includes(value);
  return (
    <div className="flex items-center gap-2">
      <select
        className={cn(selectClass, "w-44")}
        value={isPreset ? value : "custom"}
        onChange={(e) => onChange(e.target.value === "custom" ? value || " " : e.target.value)}
      >
        {CLAUDE_MODEL_PRESETS.map((m) => (
          <option key={m} value={m}>
            {CLAUDE_MODEL_LABELS[m]}
          </option>
        ))}
        <option value="custom">Custom…</option>
      </select>
      {!isPreset && (
        <input
          className={cn(inputClass, "w-36")}
          value={value.trim()}
          placeholder="full model id"
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  );
}

function EffortSelect({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled?: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <select
      className={cn(selectClass, "w-32")}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      {CLAUDE_EFFORT_PRESETS.map((e) => (
        <option key={e} value={e}>
          {CLAUDE_EFFORT_LABELS[e]}
        </option>
      ))}
    </select>
  );
}

/**
 * A genre input with its own draft, committed on blur/Enter rather than on
 * every keystroke. Committing goes through `onCommit(newName)` (a rename,
 * not a raw array splice) so the caller can offer to retag the collection.
 */
/**
 * One genre from the collection. Editing the name is a rename *of the
 * collection* — there is no list this could be edited in isolation from —
 * so the commit handler prompts before rewriting any tags.
 */
function GenreRow({
  value,
  count,
  onCommit,
}: {
  value: string;
  count: number;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== value) onCommit(trimmed);
    else setDraft(value);
  };

  return (
    <div className="flex items-center gap-2">
      <input
        className={cn(inputClass, "h-8 flex-1")}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          else if (e.key === "Escape") setDraft(value);
        }}
        title={`${count} track${count === 1 ? "" : "s"} use this genre`}
      />
      <span className="w-16 shrink-0 text-right text-xs text-muted-foreground">
        {count} track{count === 1 ? "" : "s"}
      </span>
    </div>
  );
}

/**
 * Near-duplicate genre spellings ("Hip Hop" vs "Hip-Hop") found in the
 * collection, offered as merges.
 *
 * It used to also offer to *add* detected genres to a preset; there is no
 * preset any more, and a genre already on a track is already in the
 * vocabulary by definition. Only the merge is a real action now.
 */
function DetectGenresPanel({
  groups,
  onMerge,
}: {
  groups: GenreGroup[];
  onMerge: (variants: string[], canonical: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const mergeable = groups.filter((g) => g.variants.length > 1);

  if (!open) {
    return (
      <Button variant="ghost" size="sm" className="mt-2" onClick={() => setOpen(true)}>
        <Sparkles />
        Find near-duplicate spellings ({mergeable.length})
      </Button>
    );
  }

  return (
    <div className="mt-2 rounded-lg border bg-secondary/20 p-3">
      {mergeable.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No near-duplicates — every genre in the collection is spelled one way.
        </p>
      ) : (
        <>
          <p className="mb-2 text-xs text-muted-foreground">
            These genres differ only by case, punctuation or separator style. Merging retags every
            track using a variant.
          </p>
          <div className="max-h-56 space-y-2 overflow-y-auto">
            {mergeable.map((g) => (
              <div key={g.canonical} className="flex items-start justify-between gap-2 text-sm">
                <span className="min-w-0">
                  <span className="font-medium">{g.canonical}</span>{" "}
                  <span className="text-xs text-muted-foreground">
                    ({g.count} track{g.count === 1 ? "" : "s"})
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    also spelled: {g.variants.slice(1).map((v) => v.name).join(", ")}
                  </span>
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  className="shrink-0"
                  onClick={() => onMerge(g.variants.map((v) => v.name), g.canonical)}
                >
                  Merge
                </Button>
              </div>
            ))}
          </div>
        </>
      )}
      <div className="mt-3">
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>
    </div>
  );
}

/**
 * The whole-library index: which folders it covers, when it last ran, and
 * what it found.
 *
 * Indexing is incremental — a file whose size and modified time both match
 * the stored row is skipped without being opened — so re-running it after
 * adding a few tracks costs seconds, not another full pass. "Re-read
 * everything" is there for when that assumption is wrong (files restored
 * from a backup keep their old mtime, for instance).
 */
function LibraryIndexCard({
  settings,
  onUpdate,
  libraryIndex,
  notify,
}: {
  settings: Settings;
  onUpdate: (fn: (prev: Settings) => Settings) => void;
  libraryIndex: LibraryIndexApi;
  notify: Notify;
}) {
  const { stats, indexing, progress } = libraryIndex;
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [clearConfirmText, setClearConfirmText] = useState("");
  const [rbImporting, setRbImporting] = useState(false);

  const runIndex = async (rescanAll: boolean) => {
    try {
      const summary = await libraryIndex.runIndex(rescanAll);
      const bits = [
        `${summary.scanned} scanned`,
        summary.added ? `${summary.added} added` : null,
        summary.updated ? `${summary.updated} updated` : null,
        summary.removed ? `${summary.removed} removed` : null,
        summary.unchanged ? `${summary.unchanged} unchanged` : null,
      ].filter(Boolean);
      notify(`Library indexed — ${bits.join(", ")}`, "success");
      summary.errors.slice(0, 5).forEach((e) => notify(e, "error"));
    } catch (e) {
      notify(String(e), "error");
    }
  };

  const changeFolder = async () => {
    const picked = await open({
      directory: true,
      multiple: false,
      title: "Choose your Library folder",
    });
    if (typeof picked !== "string" || picked === settings.libraryFolder) return;
    const ok = await confirm(
      `Library will be re-scanned from "${picked}".\n\nThis replaces "${settings.libraryFolder || "(none set)"}" as the Library.`,
      { title: "Change Library Folder", kind: "warning" },
    );
    if (!ok) return;
    try {
      await libraryIndex.setRoots([picked]);
      onUpdate((prev) => ({ ...prev, libraryFolder: picked }));
      void runIndex(false);
    } catch (e) {
      notify(String(e), "error");
    }
  };

  const clearIndex = async () => {
    if (clearConfirmText.trim().toUpperCase() !== "CLEAR") return;
    await libraryIndex.clear();
    setClearConfirmText("");
    notify("Library index cleared", "info");
  };

  const chooseRekordboxXml = async () => {
    const picked = await open({
      title: "Select rekordbox.xml",
      multiple: false,
      filters: [{ name: "Rekordbox XML", extensions: ["xml"] }],
    });
    if (typeof picked !== "string") return;
    onUpdate((prev) => ({ ...prev, rekordboxXmlPath: picked }));
    void reimportRekordboxXml(picked);
  };

  const reimportRekordboxXml = async (xmlPath: string) => {
    setRbImporting(true);
    try {
      const summary = await libraryIndex.importRekordboxTags(xmlPath);
      const mtime = await invoke<number | null>("file_mtime_secs", { path: xmlPath });
      onUpdate((prev) => ({ ...prev, rekordboxXmlPath: xmlPath, rekordboxXmlMtime: mtime ?? 0 }));
      notify(
        `Rekordbox BPM/key imported — ${summary.matched} of ${summary.libraryTrackCount} Library tracks matched (${summary.xmlEntries} entries in the XML)`,
        "success",
      );
    } catch (e) {
      notify(`Could not import Rekordbox BPM/key: ${e}`, "error");
    } finally {
      setRbImporting(false);
    }
  };

  const pct =
    progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : null;
  const folderMissing = !indexing && !!settings.libraryFolder && (stats?.trackCount ?? 0) > 0 && !stats?.roots.includes(settings.libraryFolder);

  return (
    <Card>
      <CardHeader
        title="Library"
        hint="The one permanent folder your genres, search and playlist matching are drawn from — separate from whatever folder you have open to work on right now"
      />
      <div className="px-5 py-3">
        <div className="mb-3 space-y-1.5">
          {!settings.libraryFolder ? (
            <p className="text-xs text-muted-foreground">
              No Library folder set yet. Choose the folder your finished collection lives in.
            </p>
          ) : (
            <div className="flex items-center gap-2 rounded-md bg-secondary/30 px-2 py-1.5">
              <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-mono text-xs" title={settings.libraryFolder}>
                {settings.libraryFolder}
              </span>
            </div>
          )}
          {folderMissing && (
            <p className="text-xs text-amber-500">
              Library folder not found — showing last known library.
            </p>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={changeFolder} disabled={indexing}>
            <FolderOpen />
            {settings.libraryFolder ? "Change…" : "Choose Library Folder…"}
          </Button>
          <Button
            size="sm"
            onClick={() => void runIndex(false)}
            disabled={indexing || !settings.libraryFolder}
          >
            {indexing ? <Loader2 className="animate-spin" /> : <Library />}
            {indexing ? "Indexing…" : "Index Library"}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void runIndex(true)}
            disabled={indexing || !settings.libraryFolder}
            title="Ignore the size/modified-time check and re-read every file"
          >
            <RefreshCw />
            Re-read Everything
          </Button>
        </div>

        {indexing && (
          <div className="mt-3">
            <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: pct !== null ? `${pct}%` : "15%" }}
              />
            </div>
            <p className="mt-1 truncate text-[10px] text-muted-foreground">
              {progress?.phase === "walking"
                ? "Finding files…"
                : progress
                  ? `${progress.done} / ${progress.total} — ${progress.current}`
                  : "Starting…"}
            </p>
          </div>
        )}

        {!indexing && stats && (
          <p className="mt-3 text-xs text-muted-foreground">
            {stats.trackCount === 0 ? (
              "Not indexed yet."
            ) : (
              <>
                <span className="font-medium text-foreground">{stats.trackCount}</span> tracks ·{" "}
                {stats.artistCount} artists · {stats.genreCount} genres
                {stats.lastIndexedAt
                  ? ` · last indexed ${new Date(stats.lastIndexedAt * 1000).toLocaleString()}`
                  : ""}
              </>
            )}
          </p>
        )}

        <div className="mt-3 border-t pt-3">
          <Row
            label="Key notation"
            hint="How the Key column is displayed. Files are never changed by this; &quot;as stored&quot; shows the tag exactly as written."
          >
            <select
              className={cn(selectClass, "w-44")}
              value={settings.keyNotation}
              onChange={(e) =>
                onUpdate((prev) => ({ ...prev, keyNotation: e.target.value as Settings["keyNotation"] }))
              }
            >
              <option value="stored">As stored</option>
              <option value="camelot">Camelot (8A)</option>
              <option value="openkey">Open Key (1m)</option>
            </select>
          </Row>
        </div>

        <div className="mt-3 border-t pt-3">
          <Row
            label="Refresh the library when the window gets focus"
            hint="Re-scans the Library folder for new, changed and removed files whenever you switch back to the app (at most once a minute). Cheap: unchanged files are skipped without being opened. The sidebar's Refresh button does the same on demand."
          >
            <Toggle
              checked={settings.libraryAutoRefresh}
              onChange={(v) => onUpdate((prev) => ({ ...prev, libraryAutoRefresh: v }))}
            />
          </Row>
        </div>

        <div className="mt-3 border-t pt-3">
          <Row
            label="Store fetched lyrics"
            hint="Fetch lyrics (LRCLIB) is in the track right-click menu. A sidecar .lrc next to the audio file is what VirtualDJ, Mixxx skins and karaoke/visual tools read, and touches no tags. Embedded writes the plain-text lyrics tag (USLT / LYRICS) into the file."
          >
            <select
              className="h-8 rounded-md border border-input bg-background px-2 text-xs"
              value={settings.lyricsStorage}
              onChange={(e) =>
                onUpdate((prev) => ({ ...prev, lyricsStorage: e.target.value as Settings["lyricsStorage"] }))
              }
            >
              <option value="sidecar">Sidecar .lrc file (default)</option>
              <option value="embedded">Embedded in the tags</option>
              <option value="both">Both</option>
            </select>
          </Row>
        </div>

        <div className="mt-3 border-t pt-3">
          <Row
            label="Also write the language into Comment"
            hint="When you apply detected languages, add a #lang-es style tag to Comment too. Rekordbox can't show the Language tag, but it (and Serato/Traktor) can search Comment."
          >
            <Toggle
              checked={settings.languageAppendComment}
              onChange={(v) => onUpdate((prev) => ({ ...prev, languageAppendComment: v }))}
            />
          </Row>
        </div>

        <div className="mt-3 border-t pt-3">
          <Row
            label="Genre click in a hand-built batch"
            hint="What clicking a genre in the Library sidebar does when you loaded the files yourself (folder, files, drop). Empty and genre sessions always just open the genre."
          >
            <select
              className={cn(selectClass, "w-44")}
              value={settings.genreClickInManualSession}
              onChange={(e) =>
                onUpdate((prev) => ({
                  ...prev,
                  genreClickInManualSession: e.target.value as Settings["genreClickInManualSession"],
                }))
              }
            >
              <option value="ask">Ask each time</option>
              <option value="newTab">Open in a new tab</option>
              <option value="replace">Replace the session</option>
              <option value="filter">Filter this batch</option>
            </select>
          </Row>
        </div>

        <div className="mt-3 border-t pt-3">
          <div className="mb-1 text-sm font-medium">Rekordbox BPM / Key / Rating</div>
          <p className="mb-2 text-xs text-muted-foreground">
            Rekordbox's own BPM/key analysis and star ratings, read from a collection export — in
            Rekordbox: File → Export Collection in xml format. They show in the table (marked RB)
            where a file has no tag of its own; "Rekordbox → tags" writes them into the files.
          </p>
          <div className="mb-2 flex items-center gap-2">
            {settings.rekordboxXmlPath ? (
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={settings.rekordboxXmlPath}>
                {settings.rekordboxXmlPath}
              </span>
            ) : (
              <span className="flex-1 text-xs text-muted-foreground">No rekordbox.xml chosen yet.</span>
            )}
            <Button variant="secondary" size="sm" onClick={chooseRekordboxXml} disabled={rbImporting}>
              <FolderOpen />
              Choose…
            </Button>
            {settings.rekordboxXmlPath && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void reimportRekordboxXml(settings.rekordboxXmlPath)}
                disabled={rbImporting}
              >
                {rbImporting ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                {rbImporting ? "Importing…" : "Re-import"}
              </Button>
            )}
          </div>
          {stats && stats.trackCount > 0 && settings.rekordboxXmlPath && (
            <p className="text-xs text-muted-foreground">
              {stats.rekordboxMatched} of {stats.trackCount} Library tracks have Rekordbox BPM/key.
            </p>
          )}
        </div>

        <div className="mt-3 border-t pt-3">
          {!advancedOpen ? (
            <Button variant="ghost" size="sm" onClick={() => setAdvancedOpen(true)}>
              Advanced
            </Button>
          ) : (
            <div className="space-y-2">
              <Button variant="ghost" size="sm" onClick={() => setAdvancedOpen(false)}>
                Hide Advanced
              </Button>
              {(stats?.trackCount ?? 0) > 0 && (
                <div className="rounded-lg border bg-secondary/20 p-3">
                  <p className="mb-2 text-xs text-muted-foreground">
                    Empties the library index. Nothing on disk changes — you would just need to
                    index again. Type <span className="font-mono">CLEAR</span> to confirm.
                  </p>
                  <div className="flex items-center gap-2">
                    <input
                      className={cn(inputClass, "h-8 w-32 font-mono")}
                      value={clearConfirmText}
                      onChange={(e) => setClearConfirmText(e.target.value)}
                      placeholder="CLEAR"
                    />
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={clearIndex}
                      disabled={clearConfirmText.trim().toUpperCase() !== "CLEAR"}
                    >
                      Clear Index
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

export function SettingsPage({
  settings,
  installedThemes,
  onSave,
  onUpdate,
  onRenameGenre,
  collectionGenreGroups,
  libraryIndex,
  onMergeGenreVariants,
  onRunTrackIdMigration,
  checkOllama,
  notify,
}: Props) {
  const [status, setStatus] = useState<OllamaStatus | null>(null);
  const [claudeCli, setClaudeCli] = useState<ClaudeCliInfo | null>(null);
  const [checkingClaude, setCheckingClaude] = useState(false);
  const claudeCheckRun = useRef(0);
  const [installingClaude, setInstallingClaude] = useState(false);
  const [signingInClaude, setSigningInClaude] = useState(false);
  const [testing, setTesting] = useState(false);
  const [url, setUrl] = useState(settings.ollamaUrl);
  const [promptOpen, setPromptOpen] = useState(false);
  const [promptText, setPromptText] = useState("");
  const [promptLoading, setPromptLoading] = useState(false);
  const [exportingSettings, setExportingSettings] = useState(false);
  const [importingSettings, setImportingSettings] = useState(false);
  const [recordingShortcut, setRecordingShortcut] = useState<string | null>(null);
  const [rbImporting, setRbImporting] = useState(false);
  const [rbProgress, setRbProgress] = useState<{ done: number; total: number } | null>(null);
  const [mixxxExportXmlPath, setMixxxExportXmlPath] = useState<string | null>(null);
  const [casingExceptionDraft, setCasingExceptionDraft] = useState("");

  const exportSettings = async () => {
    const dest = await save({
      title: "Export Settings",
      defaultPath: "music-tag-cleaner-settings.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!dest) return;
    setExportingSettings(true);
    try {
      await invoke("write_text_file", { path: dest, contents: JSON.stringify(settings, null, 2) });
      notify("Settings exported", "success");
    } catch (e) {
      notify(`Could not export settings: ${e}`, "error");
    } finally {
      setExportingSettings(false);
    }
  };

  const importSettings = async () => {
    const src = await open({
      title: "Import Settings",
      multiple: false,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!src || typeof src !== "string") return;
    setImportingSettings(true);
    try {
      const raw = await invoke<string>("read_text_file", { path: src });
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("that file isn't a settings export");
      }
      // The same merge + sanitising the startup load uses: a bare spread let
      // an imported file with a null usage counter crash the Settings page.
      const merged = mergeWithDefaults(parsed as Partial<Settings>);
      const savedVersion = (parsed as Partial<Settings>).settingsVersion ?? 1;
      const next = savedVersion < CURRENT_SETTINGS_VERSION ? migrate(merged, savedVersion) : merged;
      onSave(next);
      notify("Settings imported", "success");
    } catch (e) {
      notify(`Could not import settings: ${e}`, "error");
    } finally {
      setImportingSettings(false);
    }
  };

  const pickRekordboxXmlForMixxxExport = async () => {
    const picked = await open({
      title: "Select rekordbox.xml",
      multiple: false,
      filters: [{ name: "Rekordbox XML", extensions: ["xml"] }],
    });
    if (typeof picked === "string") setMixxxExportXmlPath(picked);
  };

  const importRekordboxCues = async () => {
    const picked = await open({
      title: "Select rekordbox.xml",
      multiple: false,
      filters: [{ name: "Rekordbox XML", extensions: ["xml"] }],
    });
    if (!picked || typeof picked !== "string") return;
    setRbImporting(true);
    setRbProgress({ done: 0, total: 0 });
    const unlisten = await listen<{ done: number; total: number }>("rekordbox-import-progress", (e) => {
      setRbProgress(e.payload);
    });
    try {
      const result = await invoke<ImportResult>("import_rekordbox_cues", { xmlPath: picked });
      const skipped = result.errors.length;
      notify(
        `Imported cues for ${result.matched} of ${result.totalEntries} tracks` +
          (result.notFoundOnDisk > 0 ? ` (${result.notFoundOnDisk} not found on disk)` : "") +
          (skipped > 0 ? ` — ${skipped} error(s)` : ""),
        skipped > 0 ? "info" : "success",
      );
    } catch (e) {
      notify(`Could not import Rekordbox cues: ${e}`, "error");
    } finally {
      unlisten();
      setRbImporting(false);
      setRbProgress(null);
    }
  };

  useEffect(() => {
    if (!recordingShortcut) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
      if (e.key === "Escape") {
        setRecordingShortcut(null);
        return;
      }
      const combo = comboFromEvent(e);
      set("shortcuts", { ...settings.shortcuts, [recordingShortcut]: combo });
      setRecordingShortcut(null);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordingShortcut]);

  const viewPrompt = async () => {
    setPromptOpen(true);
    setPromptLoading(true);
    try {
      const text = await invoke<string>("ai_preview_prompt", {
        transliterateScripts: settings.transliterateScripts,
      });
      setPromptText(text);
    } catch (e) {
      setPromptText(`Could not load the prompt: ${e}`);
    } finally {
      setPromptLoading(false);
    }
  };

  const toggleScript = (id: string) =>
    set(
      "transliterateScripts",
      settings.transliterateScripts.includes(id)
        ? settings.transliterateScripts.filter((s) => s !== id)
        : [...settings.transliterateScripts, id],
    );

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    onUpdate((prev) => ({ ...prev, [key]: value }));

  const addCasingException = () => {
    const value = casingExceptionDraft.trim();
    if (!value) return;
    // Case-insensitive de-dupe: re-adding "ac/dc" after "AC/DC" replaces the
    // stored casing rather than piling up a second, shadowed entry.
    const without = settings.casingExceptions.filter((e) => e.toLowerCase() !== value.toLowerCase());
    set("casingExceptions", [...without, value]);
    setCasingExceptionDraft("");
  };

  const removeCasingException = (value: string) =>
    set("casingExceptions", settings.casingExceptions.filter((e) => e !== value));

  /**
   * Probes the Claude CLI. This costs a real (tiny) round trip because
   * "installed" and "usable" are different things — the copy bundled with
   * the Claude desktop app is installed but not signed in for standalone
   * use — so it only runs when the backend is actually selected, or on
   * demand.
   */
  const checkClaude = async () => {
    const run = ++claudeCheckRun.current;
    setCheckingClaude(true);
    try {
      // The backend gives up after 30 s; this guard is slightly longer so the
      // spinner can never be permanent even if the command never returns.
      const info = await Promise.race([
        invoke<ClaudeCliInfo>("claude_cli_info"),
        new Promise<ClaudeCliInfo>((resolve) =>
          setTimeout(
            () =>
              resolve({
                found: true,
                loggedIn: false,
                error: "The Claude CLI check didn't finish — check your internet connection and re-check.",
                errorKind: "timeout",
              }),
            CLAUDE_CHECK_GUARD_MS,
          ),
        ),
      ]);
      if (run === claudeCheckRun.current) setClaudeCli(info);
    } catch (e) {
      notify(String(e), "error");
    } finally {
      if (run === claudeCheckRun.current) setCheckingClaude(false);
    }
  };

  // Reconnecting after an offline result should refresh it by itself — that
  // is exactly the "I got connected and Settings didn't notice" case.
  useEffect(() => {
    if (settings.aiBackend !== "claude" || claudeCli?.errorKind !== "offline") return;
    const onOnline = () => void checkClaude();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.aiBackend, claudeCli]);

  useEffect(() => {
    if (settings.aiBackend === "claude" && !claudeCli && !checkingClaude) void checkClaude();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.aiBackend]);

  /** Runs the official installer (same one the docs tell you to run by hand). */
  const installClaude = async () => {
    setInstallingClaude(true);
    try {
      await invoke("install_claude_cli");
      notify("Claude CLI installed", "success");
      await checkClaude();
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setInstallingClaude(false);
    }
  };

  /** Opens a real terminal running `claude` so the user can finish the
   *  browser-based `/login` themselves — that step can't be automated. */
  const signInClaude = async () => {
    setSigningInClaude(true);
    try {
      await invoke("open_claude_login");
      notify("Opened a terminal — sign in there, then Re-check", "info");
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setSigningInClaude(false);
    }
  };

  const test = async (u: string) => {
    setTesting(true);
    const result = await checkOllama(u);
    setStatus(result);
    setTesting(false);
    if (result.running && result.models.length && !result.models.includes(settings.ollamaModel)) {
      onUpdate((prev) => ({ ...prev, ollamaUrl: u, ollamaModel: result.models[0] }));
    }
  };

  useEffect(() => {
    test(settings.ollamaUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <div>
        <h1 className="text-xl font-bold">Settings</h1>
        <p className="text-sm text-muted-foreground">Changes apply immediately</p>
      </div>

      <Card>
        <CardHeader title="Appearance" hint="Follow OS is the default. More themes can be installed from the Plugins page." />
        <div className="px-5 py-4">
          <ThemePicker
            themeId={settings.themeId}
            installed={installedThemes}
            onPick={(id) => onUpdate((prev) => ({ ...prev, themeId: id }))}
          />
        </div>
      </Card>

      <Card>
        <CardHeader title="AI Backend" />
        <div className="px-5 py-2">
          <Row label="Local (Ollama)" hint="Runs entirely on this machine">
            <input
              type="radio"
              name="backend"
              className="accent-[var(--primary)]"
              checked={settings.aiBackend === "ollama"}
              onChange={() => set("aiBackend", "ollama")}
            />
          </Row>
          <Row
            label="Claude (already on this computer)"
            hint="Drives the Claude Code CLI you're already signed into — no API key, no separate bill"
          >
            <input
              type="radio"
              name="backend"
              className="accent-[var(--primary)]"
              checked={settings.aiBackend === "claude"}
              onChange={() => set("aiBackend", "claude")}
            />
          </Row>
          {settings.aiBackend === "claude" && (
            <>
              <p className="pb-2 text-xs text-muted-foreground">
                AI Clean and Genre run through <span className="font-mono">claude --print</span>,
                its documented non-interactive mode, on the Claude subscription this machine is
                already signed into. Same prompt and same parsing as the other backends, so the
                preview, diffs and Undo behave identically — it just doesn't need you in the loop.
              </p>
              <div className="mb-2 rounded-lg border bg-secondary/20 p-3 text-xs">
                {checkingClaude ? (
                  <span className="flex items-center gap-2 text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" /> Checking the Claude CLI…
                  </span>
                ) : !claudeCli ? (
                  <span className="text-muted-foreground">Not checked yet.</span>
                ) : claudeCli.loggedIn ? (
                  <span className="flex items-center gap-2">
                    <Badge className="gap-1 bg-primary/15 text-primary">Ready</Badge>
                    <span className="min-w-0 truncate text-muted-foreground" title={claudeCli.path ?? ""}>
                      {claudeCli.version ?? "claude"} · {claudeCli.path}
                    </span>
                  </span>
                ) : (
                  <div className="space-y-1">
                    <span className="flex items-center gap-2">
                      <Badge className="gap-1 bg-destructive/15 text-destructive">
                        {!claudeCli.found
                          ? "Not found"
                          : claudeCli.errorKind === "offline"
                            ? "Offline"
                            : claudeCli.errorKind === "timeout"
                              ? "No response"
                              : "Not signed in"}
                      </Badge>
                      {claudeCli.found && claudeCli.version && (
                        <span className="text-muted-foreground">Installed, {claudeCli.version}</span>
                      )}
                    </span>
                    <p className="text-muted-foreground">{claudeCli.error}</p>
                    {!claudeCli.found ? (
                      <p className="text-muted-foreground">
                        Click Install below, or run{" "}
                        <span className="font-mono">npm i -g @anthropic-ai/claude-code</span>{" "}
                        yourself — either way, sign in afterwards.
                      </p>
                    ) : claudeCli.errorKind === "offline" || claudeCli.errorKind === "timeout" ? (
                      <p className="text-muted-foreground">
                        This isn't a sign-in problem. Re-check once you're connected
                        {claudeCli.errorKind === "offline" ? " — it re-checks by itself when the network returns." : "."}
                      </p>
                    ) : (
                      <p className="text-muted-foreground">
                        Click Sign In below and complete the login in the terminal that opens.
                      </p>
                    )}
                  </div>
                )}
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button variant="ghost" size="sm" onClick={checkClaude} disabled={checkingClaude}>
                    <PlugZap className={checkingClaude ? "animate-pulse" : ""} />
                    Re-check
                  </Button>
                  {claudeCli && !claudeCli.found && (
                    <Button size="sm" onClick={installClaude} disabled={installingClaude}>
                      {installingClaude ? <Loader2 className="animate-spin" /> : <Download />}
                      {installingClaude ? "Installing…" : "Install"}
                    </Button>
                  )}
                  {claudeCli &&
                    claudeCli.found &&
                    !claudeCli.loggedIn &&
                    claudeCli.errorKind !== "offline" &&
                    claudeCli.errorKind !== "timeout" && (
                    <Button size="sm" onClick={signInClaude} disabled={signingInClaude}>
                      {signingInClaude ? <Loader2 className="animate-spin" /> : <Terminal />}
                      Sign In
                    </Button>
                  )}
                </div>
              </div>
              <Row
                label="Model"
                hint="Which model AI Clean runs on — Custom lets you type a full model id"
              >
                <ModelSelect
                  value={settings.claudeTasks.clean.model}
                  onChange={(model) =>
                    set("claudeTasks", { ...settings.claudeTasks, clean: { ...settings.claudeTasks.clean, model } })
                  }
                />
              </Row>
              <Row
                label="Effort"
                hint={
                  settings.claudeTasks.clean.model === "haiku"
                    ? "Haiku 4.5 has no effort setting"
                    : "How much the model thinks before answering — low is fastest"
                }
              >
                <EffortSelect
                  value={settings.claudeTasks.clean.effort}
                  disabled={settings.claudeTasks.clean.model === "haiku"}
                  onChange={(effort) =>
                    set("claudeTasks", { ...settings.claudeTasks, clean: { ...settings.claudeTasks.clean, effort } })
                  }
                />
              </Row>
            </>
          )}
          <Row
            label="Manual — use any AI"
            hint="Copy the prompt into ChatGPT, Claude, Gemini… then paste the answer back"
          >
            <input
              type="radio"
              name="backend"
              className="accent-[var(--primary)]"
              checked={settings.aiBackend === "manual"}
              onChange={() => set("aiBackend", "manual")}
            />
          </Row>
          {settings.aiBackend === "manual" && (
            <>
              <p className="pb-2 text-xs text-muted-foreground">
                AI Clean and Genre now open a copy/paste window instead of calling Ollama. The
                prompt is the exact same one the local model gets, and the answer is parsed the same
                way — so the preview, the diffs and Undo all behave identically. Nothing is sent
                anywhere by the app itself.
              </p>
              <Row
                label="Tracks per batch"
                hint="How many tracks go into one copy/paste round — lower it if the AI truncates its answer"
              >
                <select
                  className={selectClass}
                  value={settings.manualChunkSize}
                  onChange={(e) => set("manualChunkSize", Number(e.target.value))}
                >
                  {[10, 25, 50, 100, 250].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </Row>
            </>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Ollama"
          hint={
            settings.aiBackend === "ollama"
              ? undefined
              : `Unused while the ${settings.aiBackend} backend is selected`
          }
        />
        <div className="px-5 py-3">
          <Row label="URL">
            <input
              type="text"
              className={cn(inputClass, "w-64")}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onBlur={() => set("ollamaUrl", url)}
            />
          </Row>
          <Row label="Model" hint="Type to filter installed models">
            {status?.running && status.models.length > 0 ? (
              <Combobox
                className="w-64"
                value={settings.ollamaModel}
                options={status.models}
                allowCustom
                onChange={(v) => set("ollamaModel", v)}
                placeholder="Select a model"
              />
            ) : (
              <input
                type="text"
                className={cn(inputClass, "w-64")}
                placeholder="e.g. deepseek-r1:14b"
                value={settings.ollamaModel}
                onChange={(e) => set("ollamaModel", e.target.value)}
              />
            )}
          </Row>
          <Row label="Connection">
            <Button variant="secondary" size="sm" onClick={() => test(url)} disabled={testing}>
              <PlugZap />
              {testing ? "Testing…" : "Test Connection"}
            </Button>
          </Row>
          {status && (
            <p className={cn("pb-2 text-xs", status.running ? "text-primary" : "text-destructive")}>
              {status.running
                ? `✅ Ollama running — ${status.models.length} model${
                    status.models.length === 1 ? "" : "s"
                  } found`
                : `❌ Ollama not detected${
                    status.error ? ` (${status.error})` : ""
                  }. Make sure Ollama is running locally. Download at ollama.com`}
            </p>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="AI Clean"
          hint="What the AI Clean button actually does to Artist, Title, Year, and Genre"
        />
        <div className="px-5 py-2">
          <Row label="See the exact instructions" hint="The real prompt sent to the model, not a summary">
            <Button variant="secondary" size="sm" onClick={viewPrompt}>
              View AI instructions
            </Button>
          </Row>
          <div className="border-t py-3">
            <div className="mb-1 text-sm font-medium">Foreign alphabets</div>
            <p className="mb-2 text-xs text-muted-foreground">
              For scripts you check here, AI Clean transliterates Artist/Title into Latin letters
              (phonetic spelling) instead of keeping the original script — handy if you can't read
              it yourself. Unchecked scripts are always preserved exactly as written.
            </p>
            <div className="flex flex-wrap gap-x-6 gap-y-1">
              {TRANSLITERATE_SCRIPTS.map((s) => (
                <label key={s.id} className="flex items-center gap-2 text-sm" title={s.hint}>
                  <input
                    type="checkbox"
                    className="accent-[var(--primary)]"
                    checked={settings.transliterateScripts.includes(s.id)}
                    onChange={() => toggleScript(s.id)}
                  />
                  {s.label}
                </label>
              ))}
            </div>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="DJ Software"
          hint="Stored for a recommended backup field below, and for cross-platform export targets planned later"
        />
        <div className="px-5 py-2">
          <Row label="Primary">
            <select
              className={cn(selectClass, "w-40")}
              value={settings.djApp.primary}
              onChange={(e) =>
                set("djApp", { ...settings.djApp, primary: e.target.value as DjApp })
              }
            >
              {(Object.keys(DJ_APP_LABELS) as DjApp[]).map((app) => (
                <option key={app} value={app}>
                  {DJ_APP_LABELS[app]}
                </option>
              ))}
            </select>
          </Row>
          <Row label="Secondary" hint="Optional — a second app you also load tracks into">
            <select
              className={cn(selectClass, "w-40")}
              value={settings.djApp.secondary}
              onChange={(e) =>
                set("djApp", { ...settings.djApp, secondary: e.target.value as DjApp })
              }
            >
              {(Object.keys(DJ_APP_LABELS) as DjApp[]).map((app) => (
                <option key={app} value={app}>
                  {DJ_APP_LABELS[app]}
                </option>
              ))}
            </select>
          </Row>
          <div className="py-1.5 text-xs text-muted-foreground">
            Rating scale: {DJ_APP_RATING_SCALE[settings.djApp.primary]}.{" "}
            {settings.backupField === recommendedBackupField(settings.djApp.primary) ? (
              <>Backup field below already matches {DJ_APP_LABELS[settings.djApp.primary]}.</>
            ) : (
              <>
                {DJ_APP_LABELS[settings.djApp.primary]} reads{" "}
                <b>{recommendedBackupField(settings.djApp.primary) === "OriginalArtist" ? "Original Artist" : "Comment"}</b>{" "}
                for the searchable backup, not the current "{settings.backupField}".{" "}
                <button
                  className="font-medium text-primary underline underline-offset-2"
                  onClick={() => set("backupField", recommendedBackupField(settings.djApp.primary))}
                >
                  Use it
                </button>
                .
              </>
            )}
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title="Tag Processing" />
        <div className="px-5 py-2">
          <Row
            label="Backup original tags before changes"
            hint="Full JSON snapshot stored inside the file (TAGBACKUP_v1)"
          >
            <Toggle
              checked={settings.backupBeforeChanges}
              onChange={(v) => set("backupBeforeChanges", v)}
            />
          </Row>
          <Row
            label="Searchable backup"
            hint='Writes "file name | | artist | | title | | year" into a chosen field before the first change'
          >
            <Toggle
              checked={settings.searchableBackup}
              onChange={(v) => set("searchableBackup", v)}
            />
          </Row>
          {settings.searchableBackup && (
            <Row label="Backup field" hint="An existing value here is never overwritten">
              <select
                className={cn(selectClass, "w-40")}
                value={settings.backupField}
                onChange={(e) => set("backupField", e.target.value as Settings["backupField"])}
              >
                <option value="Composer">Composer</option>
                <option value="OriginalArtist">Original Artist</option>
                <option value="Comment">Comment</option>
                <option value="Album">Album</option>
                <option value="AlbumArtist">Album Artist</option>
                <option value="Genre">Genre</option>
              </select>
            </Row>
          )}
          <Row label="Preserve embedded cover art">
            <Toggle
              checked={settings.preserveCoverArt}
              onChange={(v) => set("preserveCoverArt", v)}
            />
          </Row>
          <Row
            label="Install updates automatically"
            hint="Checks for a new version a few seconds after launch and installs it, then restarts. Only ever runs while no tracks are loaded, so it can't interrupt work — otherwise it just tells you an update is waiting on the Components page."
          >
            <Toggle checked={settings.autoUpdate} onChange={(v) => set("autoUpdate", v)} />
          </Row>
          <Row
            label="Standardize Art — max size"
            hint="Longest side the Standardize Art button scales cover art down to (never up)"
          >
            <div className="flex items-center gap-1">
              <input
                type="number"
                min={64}
                max={4000}
                step={100}
                className={cn(inputClass, "w-24 text-center font-mono")}
                value={settings.artworkMaxDim}
                onChange={(e) =>
                  set("artworkMaxDim", Math.min(4000, Math.max(64, Number(e.target.value) || 1000)))
                }
              />
              <span className="text-xs text-muted-foreground">px</span>
            </div>
          </Row>
          <Row
            label="Standardize Art — JPEG quality"
            hint="1–100; 80–88 is a good balance of size and quality"
          >
            <input
              type="number"
              min={40}
              max={100}
              className={cn(inputClass, "w-20 text-center font-mono")}
              value={settings.artworkJpegQuality}
              onChange={(e) =>
                set("artworkJpegQuality", Math.min(100, Math.max(40, Number(e.target.value) || 85)))
              }
            />
          </Row>
          <Row label="Process subdirectories recursively">
            <Toggle checked={settings.recursive} onChange={(v) => set("recursive", v)} />
          </Row>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Standardization"
          hint="Rules used by the Standardize and Remove Characters actions"
        />
        <div className="px-5 py-2">
          <Row
            label="Highlight unusual symbols"
            hint={`Anything that isn't ${ALLOWED_DESCRIPTION} is flagged in Title/Artist, so you can highlight and filter those tracks`}
          >
            <Toggle
              checked={settings.highlightSymbols}
              onChange={(v) => set("highlightSymbols", v)}
            />
          </Row>
          <Row
            label="Also flag these characters"
            hint="Characters to flag even though the rule above treats them as normal — brackets by default. Type the characters themselves, no separators."
          >
            <div className="flex items-center gap-2">
              <input
                className={cn(inputClass, "w-40 font-mono")}
                value={settings.flagExtraChars}
                spellCheck={false}
                placeholder="none"
                onChange={(e) => set("flagExtraChars", e.target.value)}
              />
              {settings.flagExtraChars !== DEFAULT_FLAG_EXTRA_CHARS && (
                <button
                  className="shrink-0 text-xs text-primary hover:underline"
                  onClick={() => set("flagExtraChars", DEFAULT_FLAG_EXTRA_CHARS)}
                >
                  Reset
                </button>
              )}
            </div>
          </Row>
          <Row
            label="Field naming"
            hint='Table headers as "Title", the raw frame name "TIT2", or "Title (TIT2)" — picked from the most common format in the loaded collection'
          >
            <div className="flex gap-1">
              {(
                [
                  { value: "friendly", label: "Title" },
                  { value: "raw", label: "TIT2" },
                  { value: "both", label: "Both" },
                ] as const
              ).map((o) => (
                <button
                  key={o.value}
                  onClick={() => set("fieldNaming", o.value)}
                  className={cn(
                    "rounded-md border px-2.5 py-1 text-xs font-medium",
                    settings.fieldNaming === o.value
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-input bg-background hover:bg-accent",
                  )}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </Row>
          <Row label="Capitalization" hint="How to re-case values when standardizing">
            <div className="flex gap-1">
              {CAP_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  onClick={() => set("capitalization", o.value)}
                  className={cn(
                    "h-8 rounded-md px-3 text-xs font-medium transition-colors",
                    settings.capitalization === o.value
                      ? "bg-primary text-primary-foreground"
                      : "bg-secondary text-secondary-foreground hover:bg-accent",
                  )}
                  title={
                    o.value === "upper"
                      ? "UPPERCASE"
                      : o.value === "title"
                        ? "Capitalize Each Word"
                        : o.value === "lower"
                          ? "lowercase"
                          : "Leave as is"
                  }
                >
                  {o.label}
                </button>
              ))}
            </div>
          </Row>

          <Row
            label="Casing exceptions"
            hint='Tokens Capitalize/Title Case always renders exactly as typed here, whatever case they appear in — "AC/DC", "feat.", "McFly"'
          >
            <div className="flex w-full flex-col gap-2">
              <div className="flex gap-2">
                <input
                  className={cn(inputClass, "w-40")}
                  placeholder="e.g. AC/DC"
                  value={casingExceptionDraft}
                  onChange={(e) => setCasingExceptionDraft(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addCasingException()}
                />
                <Button variant="secondary" size="sm" onClick={addCasingException}>
                  <Plus />
                  Add
                </Button>
              </div>
              {settings.casingExceptions.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {settings.casingExceptions.map((exc) => (
                    <Badge key={exc} className="gap-1 bg-secondary font-mono">
                      {exc}
                      <button
                        onClick={() => removeCasingException(exc)}
                        className="text-muted-foreground hover:text-destructive"
                        title={`Remove "${exc}"`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          </Row>

          <Row
            label="Characters to remove"
            hint='The "Remove" button deletes each of these characters'
          >
            <input
              className={cn(inputClass, "w-40 text-center font-mono")}
              value={settings.removeChars}
              placeholder=",."
              onChange={(e) => set("removeChars", e.target.value)}
            />
          </Row>

          <div className="border-t py-3">
            <div className="mb-2 text-sm font-medium">Character replacements</div>
            <div className="space-y-2">
              {settings.replacements.map((r: CharReplacement, i: number) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    className={cn(inputClass, "h-8 w-16 text-center")}
                    value={r.from}
                    maxLength={4}
                    placeholder="&"
                    onChange={(e) =>
                      set(
                        "replacements",
                        settings.replacements.map((x, idx) =>
                          idx === i ? { ...x, from: e.target.value } : x,
                        ),
                      )
                    }
                  />
                  <span className="text-muted-foreground">→</span>
                  <input
                    className={cn(inputClass, "h-8 w-16 text-center")}
                    value={r.to}
                    maxLength={8}
                    placeholder="N"
                    onChange={(e) =>
                      set(
                        "replacements",
                        settings.replacements.map((x, idx) =>
                          idx === i ? { ...x, to: e.target.value } : x,
                        ),
                      )
                    }
                  />
                  <div className="ml-auto flex items-center gap-2">
                    <button
                      className={cn(
                        "h-8 rounded-md px-2 text-xs font-medium transition-colors",
                        r.caseSensitive !== false
                          ? "bg-primary text-primary-foreground"
                          : "bg-secondary text-secondary-foreground hover:bg-accent",
                      )}
                      title={
                        r.caseSensitive !== false
                          ? "Case-sensitive — click to match any case"
                          : "Case-insensitive — click to require exact case"
                      }
                      onClick={() =>
                        set(
                          "replacements",
                          settings.replacements.map((x, idx) =>
                            idx === i ? { ...x, caseSensitive: x.caseSensitive === false } : x,
                          ),
                        )
                      }
                    >
                      Aa
                    </button>
                    <Toggle
                      checked={r.enabled}
                      onChange={(v) =>
                        set(
                          "replacements",
                          settings.replacements.map((x, idx) =>
                            idx === i ? { ...x, enabled: v } : x,
                          ),
                        )
                      }
                    />
                    <button
                      className="text-muted-foreground hover:text-destructive"
                      title="Remove rule"
                      onClick={() =>
                        set(
                          "replacements",
                          settings.replacements.filter((_, idx) => idx !== i),
                        )
                      }
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="mt-2"
              onClick={() =>
                set("replacements", [
                  ...settings.replacements,
                  { from: "", to: "", enabled: true },
                ])
              }
            >
              <Plus />
              Add rule
            </Button>
          </div>

          <div className="border-t py-3">
            <div className="mb-2 text-sm font-medium">Scope — fields Standardize touches</div>
            <div className="flex flex-wrap gap-x-6 gap-y-1">
              {STANDARDIZE_FIELDS.map((f) => (
                <label key={f} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="accent-[var(--primary)]"
                    checked={settings.standardizeFields.includes(f)}
                    onChange={(e) =>
                      set(
                        "standardizeFields",
                        e.target.checked
                          ? [...settings.standardizeFields, f]
                          : settings.standardizeFields.filter((x) => x !== f),
                      )
                    }
                  />
                  {FIELD_LABELS[f] ?? f}
                </label>
              ))}
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="accent-[var(--primary)]"
                  checked={settings.standardizeFilename}
                  onChange={(e) => set("standardizeFilename", e.target.checked)}
                />
                File name
              </label>
            </div>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Clear Fields"
          hint="The Clear Fields button erases these fields on the selected tracks"
        />
        <div className="flex flex-wrap gap-x-6 gap-y-1 px-5 py-3">
          {CLEARABLE_FIELDS.map((f) => {
            const backupFieldKey =
              settings.backupField.charAt(0).toLowerCase() + settings.backupField.slice(1);
            const isBackupField = settings.searchableBackup && f === backupFieldKey;
            return (
              <label key={f} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="accent-[var(--primary)]"
                  checked={settings.clearFields.includes(f)}
                  onChange={async (e) => {
                    if (e.target.checked && isBackupField) {
                      const ok = await confirm(
                        `${FIELD_LABELS[f] ?? f} currently holds your searchable backup text. Clearing it here will erase that backup too — clear it anyway?`,
                        { title: "Clearing the backup field", kind: "warning" },
                      );
                      if (!ok) return;
                    }
                    set(
                      "clearFields",
                      e.target.checked
                        ? [...settings.clearFields, f]
                        : settings.clearFields.filter((x) => x !== f),
                    );
                  }}
                />
                {FIELD_LABELS[f] ?? f}
                {isBackupField && (
                  <span className="text-xs text-amber-500" title="This field holds the searchable backup">
                    (Backup)
                  </span>
                )}
              </label>
            );
          })}
        </div>
      </Card>

      <LibraryIndexCard settings={settings} onUpdate={onUpdate} libraryIndex={libraryIndex} notify={notify} />

      <AiControlCard settings={settings} onUpdate={onUpdate} notify={notify} />

      <OrganizeSettingsCard
        settings={settings}
        onUpdate={onUpdate}
        notify={notify}
        onLibraryReplaced={() => libraryIndex.refresh()}
      />

      <Card>
        <CardHeader
          title="Genres"
          hint="Taken from your collection — there is no stored list to keep in sync"
        />
        <div className="px-5 py-3">
          {libraryIndex.genres.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No genres yet. Index your library above (or open some tracks) and the genres you
              actually use will appear here.
            </p>
          ) : (
            <>
              <p className="mb-2 text-xs text-muted-foreground">
                {libraryIndex.genres.length} genre
                {libraryIndex.genres.length === 1 ? "" : "s"} across{" "}
                {libraryIndex.stats?.trackCount ?? 0} indexed track
                {libraryIndex.stats?.trackCount === 1 ? "" : "s"}. Renaming one here rewrites the
                genre tag on every track that uses it.
              </p>
              <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
                {libraryIndex.genres.map((g) => (
                  <GenreRow
                    key={g.name}
                    value={g.name}
                    count={g.count}
                    onCommit={(next) => onRenameGenre(g.name, next)}
                  />
                ))}
              </div>
            </>
          )}
          <DetectGenresPanel groups={collectionGenreGroups} onMerge={onMergeGenreVariants} />
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Track IDs"
          hint={`Sequential ${settings.trackIdDigits}-digit IDs written to a private Track ID field (not Track Number)`}
        />
        <div className="px-5 py-3">
          <Row label="ID length" hint="How many digits Generate IDs zero-pads to">
            <input
              type="number"
              min={1}
              max={12}
              className={cn(inputClass, "w-20 text-center font-mono")}
              value={settings.trackIdDigits}
              onChange={(e) =>
                set("trackIdDigits", Math.min(12, Math.max(1, Number(e.target.value) || 6)))
              }
            />
          </Row>
          <Row
            label="Next track ID"
            hint="The next number Generate IDs will assign — reset it to regenerate"
          >
            <input
              type="number"
              min={0}
              max={10 ** settings.trackIdDigits - 1}
              className={cn(inputClass, "w-28 text-center font-mono")}
              value={settings.nextTrackId}
              onChange={(e) => set("nextTrackId", Math.max(0, Number(e.target.value) || 0))}
            />
          </Row>
          <Row
            label="Strict file names"
            hint='Rename to Standard folds accents away and drops punctuation, keeping letters, numbers and spaces — e.g. "Beyonce - Halo - 000123" instead of "Beyoncé - Halo! - 000123". Cyrillic (Russian/Ukrainian) is kept as written.'
          >
            <Toggle
              checked={settings.strictFilenames}
              onChange={(v) => set("strictFilenames", v)}
            />
          </Row>
          <Row
            label="Pre-v4 IDs"
            hint="Before Track ID existed, Generate IDs wrote its number into Track Number instead — offers to move any that still look like one over, clearing Track Number"
          >
            <Button variant="secondary" size="sm" onClick={onRunTrackIdMigration}>
              <ArrowRightLeft />
              Move IDs from Track Number
            </Button>
          </Row>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Convert"
          hint="Default target format and output location for the Convert action (needs FFmpeg — install it on the Components page)"
        />
        <div className="px-5 py-3">
          <Row label="Target format" hint="Codec and quality Convert defaults to">
            <select
              className={cn(selectClass, "w-64")}
              value={settings.convertPreset}
              onChange={(e) => set("convertPreset", e.target.value as Settings["convertPreset"])}
            >
              {CONVERT_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </Row>
          <Row label="Save to" hint="Where converted files are written">
            <select
              className={cn(selectClass, "w-64")}
              value={settings.convertOutput}
              onChange={(e) =>
                set("convertOutput", e.target.value as Settings["convertOutput"])
              }
            >
              <option value="alongside">Next to each original</option>
              <option value="subfolder">A “converted/” subfolder</option>
            </select>
          </Row>
        </div>
      </Card>

      <Card>
        <CardHeader title="AI Batch Size" hint="Tracks sent per Ollama call" />
        <div className="px-5 py-3">
          <Row label="Batch size">
            <select
              className={cn(selectClass, "w-24")}
              value={settings.batchSize}
              onChange={(e) => set("batchSize", Number(e.target.value))}
            >
              {BATCH_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Row>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Usage & Plan"
          hint="Ollama runs locally and is free — this tracks usage as groundwork for a possible future paid tier"
        />
        <div className="px-5 py-3">
          <Row label="Plan">
            <div className="flex items-center gap-2">
              <Badge className={settings.plan.tier === "pro" ? "bg-primary/15 text-primary" : "bg-secondary"}>
                {settings.plan.tier === "pro" ? "Pro" : "Free"}
              </Badge>
              <span className="text-xs text-muted-foreground">Local Ollama has no usage limits today</span>
            </div>
          </Row>
          {(() => {
            const totalTokens = settings.usage.totalPromptTokens + settings.usage.totalCompletionTokens;
            const creditsUsed = Math.ceil(totalTokens / 1000);
            const pct = Math.min(100, (creditsUsed / settings.plan.creditsTotal) * 100);
            return (
              <>
                <Row label="Credits used" hint="Placeholder unit — 1 credit ≈ 1,000 tokens">
                  <span className="font-mono text-sm">
                    {creditsUsed.toLocaleString()} / {settings.plan.creditsTotal.toLocaleString()}
                  </span>
                </Row>
                <div className="mb-3 h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                  <div
                    className="h-full rounded-full bg-primary transition-all"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <Row label="Tokens used">
                  <span className="font-mono text-sm">{totalTokens.toLocaleString()}</span>
                </Row>
                <Row label="Songs processed">
                  <span className="font-mono text-sm">{settings.usage.songsProcessed.toLocaleString()}</span>
                </Row>
                <Row label="AI calls made">
                  <span className="font-mono text-sm">{settings.usage.totalCalls.toLocaleString()}</span>
                </Row>
              </>
            );
          })()}
          <div className="mt-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => set("usage", DEFAULT_SETTINGS.usage)}
            >
              Reset usage stats
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title="Keyboard Shortcuts" hint="Click Change, then press the new key combo" />
        <div className="px-5 py-2">
          {SHORTCUTS.map((s) => (
            <Row key={s.id} label={s.label}>
              <div className="flex items-center gap-2">
                <Badge className="bg-secondary font-mono">
                  {recordingShortcut === s.id ? "Press keys…" : shortcutFor(s.id, settings.shortcuts)}
                </Badge>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setRecordingShortcut(s.id)}
                  disabled={recordingShortcut !== null}
                >
                  Change
                </Button>
                {settings.shortcuts[s.id] && (
                  <button
                    className="text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => {
                      const next = { ...settings.shortcuts };
                      delete next[s.id];
                      set("shortcuts", next);
                    }}
                  >
                    Reset
                  </button>
                )}
              </div>
            </Row>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Backup & Restore Settings"
          hint="Save all of the settings on this page to a file, or load them back in"
        />
        <div className="flex gap-2 px-5 py-3">
          <Button variant="secondary" size="sm" onClick={exportSettings} disabled={exportingSettings}>
            <Download />
            Export Settings
          </Button>
          <Button variant="secondary" size="sm" onClick={importSettings} disabled={importingSettings}>
            <Upload />
            Import Settings
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Rekordbox Cue Import"
          hint="Read memory cues, hot cues, loops and the beat grid from a rekordbox.xml collection export — matched to your files by audio fingerprint, so it survives renames. Read-only: nothing is written back to Rekordbox."
        />
        <div className="flex items-center gap-3 px-5 py-3">
          <Button variant="secondary" size="sm" onClick={importRekordboxCues} disabled={rbImporting}>
            <ListMusic />
            {rbImporting ? "Importing…" : "Import Rekordbox Cues"}
          </Button>
          {rbImporting && rbProgress && rbProgress.total > 0 && (
            <span className="text-xs text-muted-foreground">
              {rbProgress.done} of {rbProgress.total}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 border-t px-5 py-3">
          <Button variant="secondary" size="sm" onClick={pickRekordboxXmlForMixxxExport}>
            <ListMusic />
            Export Playlists for Mixxx
          </Button>
          <span className="text-xs text-muted-foreground">
            Writes each Rekordbox playlist as a .m3u8 — no USB/SD device required.
          </span>
        </div>
      </Card>
    </div>

    {mixxxExportXmlPath && (
      <RekordboxMixxxExportDialog
        xmlPath={mixxxExportXmlPath}
        onClose={() => setMixxxExportXmlPath(null)}
        notify={notify}
      />
    )}

    {promptOpen && (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
        onClick={() => setPromptOpen(false)}
      >
        <Card className="max-h-[85vh] w-[700px] overflow-y-auto">
          <div onClick={(e) => e.stopPropagation()} className="p-5">
            <div className="mb-1 flex items-start justify-between gap-4">
              <h2 className="text-sm font-semibold">Exact AI Clean instructions</h2>
              <button
                className="text-muted-foreground hover:text-foreground"
                onClick={() => setPromptOpen(false)}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="mb-4 text-xs text-muted-foreground">
              This is the literal system prompt sent to the model for every AI Clean run, including
              your current foreign-alphabet choices above. The track list (filename, artist, title,
              year, genre) is appended after it.
            </p>
            {promptLoading ? (
              <p className="text-xs text-muted-foreground">Loading…</p>
            ) : (
              <pre className="whitespace-pre-wrap rounded-md border bg-secondary/40 p-3 text-xs">
                {promptText}
              </pre>
            )}
          </div>
        </Card>
      </div>
    )}
    </>
  );
}
