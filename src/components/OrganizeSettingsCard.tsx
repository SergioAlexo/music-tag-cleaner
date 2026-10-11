import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirm, open, save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

import type { Settings } from "../types";
import { Button, Card, CardHeader, Row, inputClass } from "./ui";

interface DbInfo {
  path: string;
  defaultPath: string;
  isDefault: boolean;
  configuredMissing: boolean;
  sizeBytes: number;
}

interface SnapshotInfo {
  sqlitePath: string;
  jsonPath: string;
  tracks: number;
}

type Notify = (message: string, kind?: "success" | "error" | "info") => void;

const TOKENS = "{genre} {album} {albumartist} {artist} {title} {year} {bpm} {key} {trackid} {ext}";

/**
 * Settings for "Move to collection" and the relocatable library file /
 * snapshots (B4). Kept in its own file so it merges cleanly beside the
 * other Settings cards.
 */
export function OrganizeSettingsCard({
  settings,
  onUpdate,
  notify,
  onLibraryReplaced,
}: {
  settings: Settings;
  onUpdate: (fn: (prev: Settings) => Settings) => void;
  notify: Notify;
  /** Re-read stats/tracks after the db file was swapped (restore / relocate). */
  onLibraryReplaced: () => void | Promise<void>;
}) {
  const [db, setDb] = useState<DbInfo | null>(null);
  const [busy, setBusy] = useState(false);

  const loadInfo = () => invoke<DbInfo>("library_db_info").then(setDb).catch(() => setDb(null));
  useEffect(() => {
    void loadInfo();
  }, []);

  // The exit hook runs in Rust, so it needs its own copy of these settings.
  useEffect(() => {
    void invoke("set_snapshot_config", {
      config: {
        onExit: settings.snapshotOnExit,
        folder: settings.snapshotFolder,
        keep: settings.snapshotKeep,
      },
    }).catch(() => {});
  }, [settings.snapshotOnExit, settings.snapshotFolder, settings.snapshotKeep]);

  const pickFolder = async (title: string): Promise<string | null> => {
    const p = await open({ directory: true, multiple: false, title });
    return typeof p === "string" ? p : null;
  };

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const relocate = (newPath: string) =>
    guard(async () => {
      const info = await invoke<DbInfo>("set_library_db_path", { newPath });
      setDb(info);
      await onLibraryReplaced();
      notify(`Library file now at ${info.path}. The old one is kept as .bak`, "success");
    });

  const chooseDbLocation = async () => {
    const picked = await save({
      title: "Where should the library file live?",
      defaultPath: db?.path,
      filters: [{ name: "SQLite", extensions: ["sqlite"] }],
    });
    if (!picked) return;
    const ok = await confirm(
      `Move the library file to:\n${picked}\n\nIt is copied and verified first; the old file stays as a .bak.\n\nTip: pick a local or backed-up drive, not a folder a sync client (OneDrive, Dropbox) watches. Use snapshots for those.`,
      { title: "Move library file", kind: "warning" },
    );
    if (ok) await relocate(picked);
  };

  const exportSnapshot = () =>
    guard(async () => {
      const folder = settings.snapshotFolder || (await pickFolder("Folder for library snapshots"));
      if (!folder) return;
      if (folder !== settings.snapshotFolder) onUpdate((p) => ({ ...p, snapshotFolder: folder }));
      const info = await invoke<SnapshotInfo>("export_library_snapshot", {
        folder,
        keep: settings.snapshotKeep,
      });
      notify(`Snapshot saved (${info.tracks} tracks)`, "success");
      void revealItemInDir(info.sqlitePath);
    });

  const restoreSnapshot = async () => {
    const picked = await open({
      multiple: false,
      title: "Choose a library snapshot",
      defaultPath: settings.snapshotFolder || undefined,
      filters: [{ name: "Library snapshot", extensions: ["sqlite"] }],
    });
    if (typeof picked !== "string") return;
    const ok = await confirm(
      `Replace the current library index with:\n${picked}\n\nYour current index is kept next to it as .pre-restore.bak. Audio files are not touched.`,
      { title: "Restore library snapshot", kind: "warning" },
    );
    if (!ok) return;
    await guard(async () => {
      const n = await invoke<number>("restore_library_snapshot", { snapshot: picked });
      await onLibraryReplaced();
      notify(`Restored ${n} tracks from the snapshot`, "success");
    });
  };

  return (
    <Card>
      <CardHeader
        title="Organize and library file"
        hint="Move tracks into a tidy collection folder, and keep the library index somewhere you can back up"
      />
      <div className="px-5 py-2">
        <Row label="Collection folder" hint="Destination for Move to collection">
          <div className="flex w-[26rem] max-w-full gap-2">
            <input
              className={inputClass}
              value={settings.collectionRoot}
              placeholder="(not set)"
              onChange={(e) => onUpdate((p) => ({ ...p, collectionRoot: e.target.value }))}
            />
            <Button
              variant="outline"
              onClick={async () => {
                const f = await pickFolder("Choose your collection folder");
                if (f) onUpdate((p) => ({ ...p, collectionRoot: f }));
              }}
            >
              Browse
            </Button>
          </div>
        </Row>
        <Row label="Folder and file pattern" hint={`Tokens: ${TOKENS}`}>
          <input
            className={`${inputClass} w-[26rem] font-mono`}
            value={settings.organizePattern}
            onChange={(e) => onUpdate((p) => ({ ...p, organizePattern: e.target.value }))}
          />
        </Row>
        <Row
          label="Move automatically after saving tags"
          hint="Saved files outside the collection folder are moved into it (breaks Rekordbox paths; use Relocate)"
        >
          <input
            type="checkbox"
            className="accent-[var(--primary)]"
            checked={settings.autoMoveOnSave}
            disabled={!settings.collectionRoot}
            onChange={(e) => onUpdate((p) => ({ ...p, autoMoveOnSave: e.target.checked }))}
          />
        </Row>

        <div className="my-2 border-t" />

        <Row
          label="Library file location"
          hint={
            db
              ? `${db.path}${db.isDefault ? " (default)" : ""}${db.configuredMissing ? " - chosen location unavailable, using the default" : ""}`
              : "..."
          }
        >
          <div className="flex gap-2">
            <Button variant="outline" disabled={busy} onClick={() => void chooseDbLocation()}>
              Move...
            </Button>
            {db && !db.isDefault && (
              <Button variant="outline" disabled={busy} onClick={() => void relocate("")}>
                Reset
              </Button>
            )}
          </div>
        </Row>
        <p className="pb-2 text-xs text-muted-foreground">
          Keep the live file on a local drive: sqlite and sync clients (OneDrive, Dropbox) can corrupt each
          other. For a synced backup, point snapshots at the synced folder instead.
        </p>
        <Row label="Snapshot folder" hint="Gets library-YYYYMMDD-HHMM.sqlite plus a readable library.json">
          <div className="flex w-[26rem] max-w-full gap-2">
            <input
              className={inputClass}
              value={settings.snapshotFolder}
              placeholder="(not set)"
              onChange={(e) => onUpdate((p) => ({ ...p, snapshotFolder: e.target.value }))}
            />
            <Button
              variant="outline"
              onClick={async () => {
                const f = await pickFolder("Folder for library snapshots");
                if (f) onUpdate((p) => ({ ...p, snapshotFolder: f }));
              }}
            >
              Browse
            </Button>
          </div>
        </Row>
        <Row label="Snapshot when the app closes" hint="Keeps the newest few">
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              keep
              <input
                type="number"
                min={1}
                max={100}
                className={`${inputClass} w-16`}
                value={settings.snapshotKeep}
                onChange={(e) =>
                  onUpdate((p) => ({ ...p, snapshotKeep: Math.max(1, Number(e.target.value) || 1) }))
                }
              />
            </label>
            <input
              type="checkbox"
              className="accent-[var(--primary)]"
              checked={settings.snapshotOnExit}
              disabled={!settings.snapshotFolder}
              onChange={(e) => onUpdate((p) => ({ ...p, snapshotOnExit: e.target.checked }))}
            />
          </div>
        </Row>
        <div className="flex gap-2 pb-3 pt-1">
          <Button variant="outline" disabled={busy} onClick={() => void exportSnapshot()}>
            Export library snapshot
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => void restoreSnapshot()}>
            Restore from snapshot...
          </Button>
        </div>
      </div>
    </Card>
  );
}
