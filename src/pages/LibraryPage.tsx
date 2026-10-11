import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  Braces,
  Eraser,
  FileArchive,
  FilePlus2,
  FolderOpen,
  GitCompare,
  Hash,
  History,
  Import,
  ImageDown,
  RotateCcw,
  RotateCw,
  Sparkles,
  SquarePen,
  StopCircle,
  Link2,
  Repeat,
  Trash2,
  Type,
  Undo2,
  Layers,
} from "lucide-react";
import type {
  AudioFile,
  Capitalization,
  PendingChange,
  PreviewMode,
  RowHeight,
  Settings,
  TagData,
} from "../types";
import type { Notify } from "../hooks/useFiles";
import { KEPT_FIELD_KEYS } from "../types";
import type { ImageInfo as ImgInfo } from "../hooks/useImageInfo";
import type { RekordboxInfo } from "../hooks/useRekordbox";
import { buildTrackGroups, trackIdFormats } from "../lib/trackGroups";
import { shortcutFor } from "../lib/shortcuts";
import { TrackTable } from "../components/TrackTable";
import PreviewTable from "../components/PreviewTable";
import { ClearFieldsMenu } from "../components/ClearFieldsMenu";
import { CapitalizationMenu } from "../components/CapitalizationMenu";
import { LibrarySidebar, matchesSidebarFilter, type SidebarFilter } from "../components/LibrarySidebar";
import { Button } from "../components/ui";
import { decideGenreClick, tabTitle, type SessionSource } from "../lib/sessionTabs";
import { SessionTabs } from "../components/SessionTabs";
import { GenreSessionDialog, type GenreSessionChoice } from "../components/GenreSessionDialog";
import type { SessionTabView } from "../hooks/useSessionTabs";
import type { GenreCount } from "../types";

/** Whether the open working batch is somewhere other than inside the
 * permanent Library folder — the status line in A6 only needs to show up
 * when that's actually true, never when there's no Library set at all. */
function isBatchOutsideLibrary(batchFolder: string, libraryFolder: string): boolean {
  if (!libraryFolder) return false;
  const norm = (p: string) => p.replace(/[\\/]+$/, "").toLowerCase();
  const batch = norm(batchFolder);
  const lib = norm(libraryFolder);
  return batch !== lib && !batch.startsWith(lib + "\\") && !batch.startsWith(lib + "/");
}

interface FilesApi {
  files: AudioFile[];
  selected: Set<string>;
  selectedPaths: string[];
  scanning: boolean;
  source: SessionSource;
  selectFolder: () => void;
  addFiles: () => void;
  toggle: (path: string) => void;
  setAll: (checked: boolean) => void;
  setManySelected: (paths: string[], checked: boolean) => void;
  clearList: () => void;
}

interface Props {
  filesApi: FilesApi;
  libraryTags: Record<string, TagData>;
  /** Every genre in the library index (empty until one exists). */
  libraryGenres: GenreCount[];
  /** Swaps the batch for a library genre; the caller guards unapplied previews. */
  onLoadGenre: (genre: string) => void;
  /** Opens a library genre in a fresh session tab, leaving this one alone. */
  onOpenGenreInNewTab: (genre: string) => void;
  /** Forgets this session's list and undo history, then loads the genre. */
  onReplaceWithGenre: (genre: string) => void;
  tabs: SessionTabView[];
  activeTabId: string;
  /** Tab switching is off while a long action is running in the live tab. */
  tabsLocked: boolean;
  onSelectTab: (id: string) => void;
  onNewTab: () => void;
  onCloseTab: (id: string) => void;
  /** Applied undo steps in the live session, for the genre dialog's warning. */
  undoSteps: number;
  covers: Record<string, string | null>;
  unresolved: Set<string>;
  settings: Settings;
  busy: boolean;
  aiRunning: boolean;
  backupRunning: boolean;
  onStopBackup: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  historyTimeline: { label: string; changeCount: number }[];
  historyIndex: number;
  onJumpToHistory: (index: number) => void;
  onCompare: () => void;
  pending: PendingChange[] | null;
  previewMode: PreviewMode;
  lastFolder: string;
  onPendingChange: (rows: PendingChange[]) => void;
  onApplyPending: () => void;
  onCancelPending: () => void;
  onAIClean: () => void;
  onStopAI: () => void;
  onCapitalization: (mode: Capitalization) => void;
  onCharacterRules: () => void;
  onRemoveChars: () => void;
  onGenerateIds: () => void;
  /** Previews writing Rekordbox BPM / key / rating into the selected files' tags. */
  onRekordboxToTags: () => void;
  /** Rekordbox BPM/key/rating by path, for the table's BPM, Key and Rating columns. */
  rekordbox: Record<string, RekordboxInfo>;
  onUnifyIds: () => void;
  onConvert: () => void;
  /** Opens the Demucs stem-separation dialog for the selection. */
  onSeparateStems: () => void;
  onConvertFile: (file: AudioFile) => void;
  onStandardizeArt: () => void;
  /** Moves every selected track's tags into its format's canonical container. */
  onStandardizeContainers: () => void;
  onRename: () => void;
  onClearFields: (fields: string[]) => void;
  onAddGenre: (genre: string) => void;
  /** Genre vocabulary derived from the indexed library (see lib/genres.ts). */
  genreOptions: string[];
  onRenameGenre: (oldName: string, newName: string) => void;
  onBackup: () => void;
  onRestore: () => void;
  onBackupArchive: () => void;
  onEditField: (paths: string[], field: keyof TagData & string, value: string) => void;
  onEditRawField: (paths: string[], rawKey: string, value: string) => void;
  onEditRating: (paths: string[], stars: number) => void;
  onInspect: (file: AudioFile) => void;
  /** Confirms with the user, then moves the file to the Recycle Bin.
   * `onConfirmed` fires after the user says yes and before the file moves —
   * Genre Mode uses it to advance playback off the track being deleted. */
  onDeleteFile: (file: AudioFile, opts?: { onConfirmed?: () => void }) => void | Promise<void>;
  onRenameFile: (path: string, newStem: string) => void;
  /** Merges `patch` into the newest settings. A patch, not a whole object:
   * spreading this render's `settings` reverted whatever else changed between
   * the render and the call. */
  onSaveSettings: (patch: Partial<Settings>) => void;
  backupFieldId: string | null;
  shortcuts: Record<string, string>;
  onTrack: (name: string) => void;
  imageInfo: Record<string, ImgInfo | null>;
  onFetchImageInfo: (path: string) => void;
  onSetCoverArt: (file: AudioFile) => void;
  onRemoveCoverArt: (file: AudioFile) => void;
  notify: Notify;
  /** D2 diagnostic switch (ROADMAP item 42) — see TrackTable's wheel handler. */
  logWheelEvents: boolean;
}

export function LibraryPage({
  filesApi,
  libraryTags,
  libraryGenres,
  onLoadGenre,
  onOpenGenreInNewTab,
  onReplaceWithGenre,
  tabs,
  activeTabId,
  tabsLocked,
  onSelectTab,
  onNewTab,
  onCloseTab,
  undoSteps,
  covers,
  unresolved,
  settings,
  busy,
  aiRunning,
  backupRunning,
  onStopBackup,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  historyTimeline,
  historyIndex,
  onJumpToHistory,
  onCompare,
  pending,
  previewMode,
  lastFolder,
  onPendingChange,
  onApplyPending,
  onCancelPending,
  onAIClean,
  onStopAI,
  onCapitalization,
  onCharacterRules,
  onRemoveChars,
  onGenerateIds,
  onRekordboxToTags,
  rekordbox,
  onUnifyIds,
  onConvert,
  onSeparateStems,
  onConvertFile,
  onStandardizeArt,
  onStandardizeContainers,
  onRename,
  onClearFields,
  onAddGenre,
  genreOptions,
  onRenameGenre,
  onBackup,
  onRestore,
  onBackupArchive,
  onEditField,
  onEditRawField,
  onEditRating,
  onInspect,
  onDeleteFile,
  onRenameFile,
  onSaveSettings,
  backupFieldId,
  shortcuts,
  onTrack,
  imageInfo,
  onFetchImageInfo,
  onSetCoverArt,
  onRemoveCoverArt,
  notify,
  logWheelEvents,
}: Props) {
  const selectedCount = filesApi.selectedPaths.length;
  const noSel = busy || selectedCount === 0;

  // Library browser sidebar (Folders/Genres/Artists) — a plain in-memory
  // filter over the loaded files, layered underneath the table's own search.
  const [sidebarFilter, setSidebarFilter] = useState<SidebarFilter | null>(null);
  const sidebarFilteredFiles = useMemo(
    () => filesApi.files.filter((f) => matchesSidebarFilter(f, libraryTags, sidebarFilter)),
    [filesApi.files, libraryTags, sidebarFilter],
  );
  // A genre click normally loads that genre. A hand-built batch is never
  // thrown away by one: it asks (or follows the remembered answer) first.
  const [genreDialog, setGenreDialog] = useState<string | null>(null);
  const filterToGenre = (genre: string) =>
    setSidebarFilter((f) => (f?.mode === "genre" && f.value === genre ? null : { mode: "genre", value: genre }));
  const onGenreClick = (genre: string) => {
    const action = decideGenreClick({
      source: filesApi.source,
      hasUnappliedPreview: !!pending && previewMode !== "history",
      manualChoice: settings.genreClickInManualSession,
    });
    if (action === "ask") return setGenreDialog(genre);
    if (action === "filter") return filterToGenre(genre);
    setSidebarFilter(null);
    if (action === "new-tab") onOpenGenreInNewTab(genre);
    else if (action === "replace") onReplaceWithGenre(genre);
    else onLoadGenre(genre);
  };
  const chooseForGenre = (genre: string, choice: GenreSessionChoice, remember: boolean) => {
    setGenreDialog(null);
    if (remember) onSaveSettings({ genreClickInManualSession: choice });
    if (choice === "filter") return filterToGenre(genre);
    setSidebarFilter(null);
    if (choice === "newTab") onOpenGenreInNewTab(genre);
    else onReplaceWithGenre(genre);
  };

  // A filter narrows one tab's batch; it doesn't follow you to another tab.
  useEffect(() => {
    setSidebarFilter(null);
  }, [activeTabId]);
  const trackGroups = useMemo(
    () => buildTrackGroups(filesApi.files, libraryTags, settings.trackIdDigits),
    [filesApi.files, libraryTags, settings.trackIdDigits],
  );
  const tidFormats = useMemo(
    () => trackIdFormats(filesApi.files, libraryTags),
    [filesApi.files, libraryTags],
  );
  const backupCount = filesApi.files.filter(
    (f) => filesApi.selected.has(f.path) && f.hasBackup,
  ).length;

  // Extra tag-frame keys present on the currently selected files, offered as
  // additional Clear Fields targets (curated fields already have their own).
  const clearableRawKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const path of filesApi.selectedPaths) {
      const extra = libraryTags[path]?.allFields;
      if (!extra) continue;
      for (const [k, v] of Object.entries(extra)) if (v && !KEPT_FIELD_KEYS.has(k)) keys.add(k);
    }
    return [...keys].sort();
  }, [filesApi.selectedPaths, libraryTags]);

  const [historyOpen, setHistoryOpen] = useState(false);
  const historyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!historyOpen) return;
    const close = (e: MouseEvent) => {
      if (!historyRef.current?.contains(e.target as Node)) setHistoryOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [historyOpen]);

  // Every preview is shown inline in the table itself, except "history" —
  // a read-only session diff that gets the dedicated table below instead of
  // the inline editable preview (and its Apply bar).
  const inlinePreview = !!pending && previewMode !== "history";
  const changedCount = pending?.filter((r) => r.changed).length ?? 0;
  const includedCount = pending?.filter((r) => r.changed && r.include).length ?? 0;
  const fileCount = pending
    ? new Set(pending.filter((r) => r.changed && r.include).map((r) => r.path)).size
    : 0;
  const modeLabel =
    previewMode === "ai"
      ? "AI Cleanup"
      : previewMode === "clear"
        ? "Clear Fields"
        : "Standardize";

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-bold">Library</h1>
          <p className="truncate text-sm text-muted-foreground" title={lastFolder}>
            {lastFolder || "Tidy messy tags, then let AI clean the rest"}
          </p>
          {lastFolder && isBatchOutsideLibrary(lastFolder, settings.libraryFolder) && (
            <p className="truncate text-xs text-amber-500">
              Batch is not in your Library. Library genres are still available.
            </p>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            variant="secondary"
            onClick={filesApi.selectFolder}
            disabled={busy}
            title={`Choose a folder of music files to load (${shortcutFor("selectFolder", settings.shortcuts)})`}
          >
            <FolderOpen />
            Select Folder
          </Button>
          <Button variant="secondary" onClick={filesApi.addFiles} disabled={busy}>
            <FilePlus2 />
            Add Files
          </Button>
          {filesApi.files.length > 0 && (
            <Button
              variant="ghost"
              size="icon"
              onClick={filesApi.clearList}
              disabled={busy}
              title="Clear the list (files are not touched)"
            >
              <Trash2 />
            </Button>
          )}
        </div>
      </div>

      {inlinePreview && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2.5">
          <div className="min-w-0">
            <span className="text-sm font-semibold">{modeLabel} preview</span>
            <p className="text-xs text-muted-foreground">
              {includedCount} of {changedCount} change{changedCount === 1 ? "" : "s"} selected across{" "}
              {fileCount} file{fileCount === 1 ? "" : "s"} — nothing is written until you apply.
              Click a highlighted cell to include/exclude it, or the box in a column header to do
              the whole column. Select rows first (Shift/Ctrl+click) and one click covers that
              column across the selection. Double-click a cell to edit the new value.
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                onPendingChange(pending!.map((r) => (r.changed ? { ...r, include: true } : r)))
              }
            >
              Select All
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                onPendingChange(pending!.map((r) => (r.changed ? { ...r, include: false } : r)))
              }
            >
              Deselect All
            </Button>
            <Button variant="outline" size="sm" onClick={onCancelPending} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" onClick={onApplyPending} disabled={busy || includedCount === 0}>
              Apply Selected ({includedCount})
            </Button>
          </div>
        </div>
      )}

      {!pending && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={onUndo}
            disabled={busy || !canUndo}
            title={`Undo the last change (${shortcutFor("undo", settings.shortcuts)})`}
          >
            <RotateCcw />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onRedo}
            disabled={busy || !canRedo}
            title={`Redo the last undone change (${shortcutFor("redo", settings.shortcuts)})`}
          >
            <RotateCw />
          </Button>
          <div className="relative" ref={historyRef}>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setHistoryOpen((o) => !o)}
              disabled={historyTimeline.length === 0}
              title="Version history — jump to any point in this session"
            >
              <History />
            </Button>
            {historyOpen && (
              <div className="absolute left-0 top-9 z-30 max-h-80 w-72 overflow-y-auto rounded-lg border bg-popover p-1.5 shadow-lg">
                <button
                  onClick={() => {
                    onJumpToHistory(-1);
                    setHistoryOpen(false);
                  }}
                  className={`w-full rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent ${
                    historyIndex === -1 ? "bg-accent/60 font-medium" : "text-muted-foreground"
                  }`}
                >
                  Session start
                </button>
                {historyTimeline.map((entry, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      onJumpToHistory(i);
                      setHistoryOpen(false);
                    }}
                    className={`w-full rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent ${
                      historyIndex === i ? "bg-accent/60 font-medium" : ""
                    }`}
                  >
                    {entry.label}
                    <span className="ml-1 text-muted-foreground">
                      ({entry.changeCount} change{entry.changeCount === 1 ? "" : "s"})
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={onCompare}
            disabled={historyTimeline.length === 0}
            title="Compare — see everything changed this session"
          >
            <GitCompare />
          </Button>
          <span className="mx-1 h-6 w-px bg-border" />

          {backupRunning ? (
            <Button variant="destructive" onClick={onStopBackup}>
              <StopCircle />
              Stop
            </Button>
          ) : (
            <Button
              onClick={onBackup}
              disabled={noSel}
              title="Write the full + searchable backup for the selected files"
            >
              <Archive />
              Backup
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={onRestore}
            disabled={busy || backupCount === 0}
            title={
              backupCount === 0
                ? "None of the selected files contain a tag backup"
                : `${backupCount} selected file(s) contain a backup`
            }
          >
            <Undo2 />
            Restore{backupCount > 0 ? ` (${backupCount})` : ""}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onBackupArchive}
            disabled={busy || filesApi.files.length === 0}
            title={
              selectedCount > 0
                ? `Save ${selectedCount} selected file(s) as a single uncompressed .zip you move somewhere safe`
                : "Save the whole loaded collection as a single uncompressed .zip you move somewhere safe"
            }
          >
            <FileArchive />
            Backup Archive
          </Button>

          <span className="mx-1 h-6 w-px bg-border" />

          {aiRunning ? (
            <Button variant="destructive" onClick={onStopAI}>
              <StopCircle />
              Stop AI
            </Button>
          ) : (
            <Button
              variant="violet"
              onClick={onAIClean}
              disabled={noSel}
              title={
                settings.aiBackend === "manual"
                  ? "Copy the prompt into any AI (ChatGPT, Claude, Gemini…) and paste its answer back"
                  : "Clean Artist, Title, Year and Genre with the local Ollama model"
              }
            >
              <Sparkles />
              AI Clean
              {settings.aiBackend === "manual"
                ? " (manual)"
                : settings.aiBackend === "claude"
                  ? " (Claude)"
                  : ""}
            </Button>
          )}

          <span className="mx-1 h-6 w-px bg-border" />

          <CapitalizationMenu
            mode={settings.capitalization}
            disabled={noSel}
            onRun={onCapitalization}
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={onCharacterRules}
            disabled={noSel}
            title="Apply the character/separator rules from Settings (feat. style, brackets, dashes, junk suffixes, whitespace) — not recasing"
          >
            <Braces />
            Characters
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={onRemoveChars}
            disabled={noSel}
            title={`Remove these characters: ${settings.removeChars || "(none set)"}`}
          >
            <Eraser />
            Remove {settings.removeChars || "chars"}
          </Button>
          <ClearFieldsMenu
            selected={settings.clearFields}
            rawKeys={clearableRawKeys}
            disabled={noSel}
            backupFieldKey={backupFieldId ?? undefined}
            onRun={onClearFields}
          />
          <span className="mx-1 h-6 w-px bg-border" />

          <Button variant="secondary" size="sm" onClick={onGenerateIds} disabled={noSel}>
            <Hash />
            Generate IDs
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={onUnifyIds}
            disabled={busy || filesApi.files.length < 2}
            title="Find files that are the same recording (any format) and give them one shared Track ID so they group as one track"
          >
            <Link2 />
            Unify IDs
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={onRekordboxToTags}
            disabled={noSel || !settings.rekordboxXmlPath}
            title={
              settings.rekordboxXmlPath
                ? "Preview writing Rekordbox's BPM, key and rating into the selected files' tags (undoable)"
                : "Choose a rekordbox.xml in Settings first"
            }
          >
            <Import />
            Rekordbox → tags
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={onConvert}
            disabled={noSel}
            title="Convert the selected tracks to another format (MP3, FLAC, ALAC, AAC…) — tags and Track ID are carried over"
          >
            <Repeat />
            Convert
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={onSeparateStems}
            disabled={noSel}
            title="Split the selected tracks into stems (drums, bass, vocals, other) with Demucs"
          >
            <Layers />
            Stems
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={onStandardizeArt}
            disabled={noSel}
            title={`Re-encode embedded cover art to JPEG q${settings.artworkJpegQuality}, longest side ≤ ${settings.artworkMaxDim}px`}
          >
            <ImageDown />
            Standardize Art
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={onStandardizeContainers}
            disabled={noSel}
            title="Move each track's tags into the one container its format calls standard — ID3v2 for mp3/wav/aiff, Vorbis Comments for flac/ogg, MP4 atoms for m4a/aac — and drop the leftovers (ID3v1, APE). Values are moved, not changed."
          >
            <Layers />
            Standardize Tag Format
          </Button>
          <Button variant="secondary" size="sm" onClick={onRename} disabled={noSel}>
            <Type />
            Rename to Standard
          </Button>

          <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
            <SquarePen className="h-3.5 w-3.5" />
            Click to select, Shift/Ctrl to extend, Esc to clear · tick the box to choose targets
          </span>
        </div>
      )}

      <div className="flex min-h-0 flex-1 gap-3">
        <LibrarySidebar
          files={filesApi.files}
          tags={libraryTags}
          trackGroups={trackGroups}
          width={settings.sidebarWidth}
          collapsed={settings.sidebarCollapsed}
          filter={sidebarFilter}
          libraryGenres={libraryGenres}
          activeGenre={filesApi.source.kind === "genre" ? filesApi.source.genre : null}
          onGenreClick={onGenreClick}
          onFilterChange={setSidebarFilter}
          onWidthChange={(w) => onSaveSettings({ sidebarWidth: w })}
          onCollapsedChange={(c) => onSaveSettings({ sidebarCollapsed: c })}
        />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
          <SessionTabs
            tabs={tabs}
            activeId={activeTabId}
            disabled={tabsLocked}
            onSelect={onSelectTab}
            onNew={onNewTab}
            onClose={onCloseTab}
          />
          {pending && previewMode === "history" ? (
            <div className="min-h-0 flex-1 overflow-hidden rounded-lg border bg-card">
              <PreviewTable
                rows={pending}
                mode={previewMode}
                busy={busy}
                onRowsChange={onPendingChange}
                onApply={onApplyPending}
                onCancel={onCancelPending}
              />
            </div>
          ) : (
            <TrackTable
              files={sidebarFilteredFiles}
              rekordbox={rekordbox}
              keyNotation={settings.keyNotation}
              tags={libraryTags}
              covers={covers}
              imageInfo={imageInfo}
              onFetchImageInfo={onFetchImageInfo}
              onSetCoverArt={onSetCoverArt}
              onRemoveCoverArt={onRemoveCoverArt}
              unresolved={unresolved}
              selected={filesApi.selected}
              visibleColumns={settings.visibleColumns}
              columnWidths={settings.columnWidths}
              highlightSymbols={settings.highlightSymbols}
              flagExtraChars={settings.flagExtraChars}
              fieldNaming={settings.fieldNaming}
              rowHeight={settings.rowHeight}
              genreOptions={genreOptions}
              onToggle={filesApi.toggle}
              onSetAll={filesApi.setAll}
              onSetMany={filesApi.setManySelected}
              onVisibleColumnsChange={(cols) => onSaveSettings({ visibleColumns: cols })}
              onColumnWidthsChange={(widths) => onSaveSettings({ columnWidths: widths })}
              onRowHeightChange={(h: RowHeight) => onSaveSettings({ rowHeight: h })}
              onEditField={onEditField}
              onEditRawField={onEditRawField}
              onEditRating={onEditRating}
              onInspect={onInspect}
              onAddGenre={onAddGenre}
              onRenameGenre={onRenameGenre}
              onConvertFile={onConvertFile}
              trackIdFormats={tidFormats}
              onDeleteFile={onDeleteFile}
              onRenameFile={onRenameFile}
              backupFieldId={backupFieldId}
              shortcuts={shortcuts}
              onTrack={onTrack}
              pending={inlinePreview ? pending : null}
              onPendingChange={onPendingChange}
              previewMode={previewMode}
              notify={notify}
              logWheelEvents={logWheelEvents}
            />
          )}
        </div>
      </div>
      {genreDialog && (
        <GenreSessionDialog
          genre={genreDialog}
          sessionLabel={tabTitle(filesApi.source, filesApi.files.map((f) => f.path))}
          fileCount={filesApi.files.length}
          undoSteps={undoSteps}
          hasPreview={inlinePreview}
          onChoose={(choice, remember) => chooseForGenre(genreDialog, choice, remember)}
          onCancel={() => setGenreDialog(null)}
        />
      )}
    </div>
  );
}
