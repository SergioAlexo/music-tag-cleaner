import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { Copy, Disc3, ListChecks, ListMusic, Music, Package, Puzzle, Settings, Terminal } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { cn } from "./ui";
import logoBlack from "../assets/logo-sergioalexo-black.svg";
import logoWhite from "../assets/logo-sergioalexo-white.svg";

export type Page = "library" | "duplicates" | "playlists" | "ytmusic" | "components" | "plugins" | "settings" | "logs";

const NAV: { page: Page; label: string; icon: typeof Music }[] = [
  { page: "library", label: "Library", icon: Disc3 },
  { page: "duplicates", label: "Duplicates", icon: Copy },
  { page: "playlists", label: "Playlists", icon: ListChecks },
  { page: "ytmusic", label: "YT Music Import", icon: ListMusic },
  { page: "components", label: "Components", icon: Package },
  { page: "plugins", label: "Plugins", icon: Puzzle },
  { page: "logs", label: "Logs", icon: Terminal },
  { page: "settings", label: "Settings", icon: Settings },
];

interface Props {
  page: Page;
  setPage: (page: Page) => void;
  fileCount: number;
  errorLogCount: number;
  /** Tracks in the permanent Library index — distinct from `fileCount`, the
   * working batch open right now. See PLAN-v0.15-library.md Workstream A6. */
  libraryTrackCount: number;
}

export function Sidebar({ page, setPage, fileCount, errorLogCount, libraryTrackCount }: Props) {
  // getVersion() reads the real app version at runtime (package.json /
  // tauri.conf.json / Cargo.toml all stay in sync via `npm version`) instead
  // of a hardcoded string that silently goes stale across releases.
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion(null));
  }, []);

  return (
    <aside className="flex h-full w-56 shrink-0 flex-col border-r bg-card/50">
      <div className="flex items-center gap-2.5 px-5 pb-4 pt-5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary shadow-lg shadow-primary/25">
          <Music className="h-5 w-5 text-primary-foreground" />
        </div>
        <div className="min-w-0">
          <button
            onClick={() => void openUrl("https://sergioalexo.com")}
            title="sergioalexo.com"
            className="block opacity-100 transition-opacity hover:opacity-70"
          >
            <img
              src={logoBlack}
              alt="SERGIO ALEXO"
              draggable={false}
              className="mb-1 h-2.5 w-auto select-none dark:hidden"
            />
            <img
              src={logoWhite}
              alt="SERGIO ALEXO"
              draggable={false}
              className="mb-1 hidden h-2.5 w-auto select-none dark:block"
            />
          </button>
          <div className="text-sm font-bold leading-tight">
            <span className="text-muted-foreground">/ </span>Vatra Wave
          </div>
          <div className="text-[10px] text-muted-foreground">
            {version ? `v${version}` : "v…"} · lofty · ollama
          </div>
        </div>
      </div>

      <nav className="flex-1 space-y-1 px-3 py-2">
        {NAV.map(({ page: p, label, icon: Icon }) => {
          const active = page === p;
          return (
            <button
              key={p}
              onClick={() => setPage(p)}
              className={cn(
                "relative flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                active
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4" />
              <span className="flex-1 text-left font-medium">{label}</span>
              {p === "library" && fileCount > 0 && (
                <span
                  className="inline-flex h-5 min-w-5 items-center justify-center rounded-md bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground"
                  title={`Working batch: ${fileCount} track${fileCount === 1 ? "" : "s"} open right now`}
                >
                  {fileCount}
                </span>
              )}
              {p === "logs" && errorLogCount > 0 && (
                <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-md bg-destructive px-1.5 text-[10px] font-semibold text-destructive-foreground">
                  {errorLogCount}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="border-t px-5 py-3 text-[10px] text-muted-foreground">
        <span className="font-medium text-foreground">Library</span>{" "}
        {libraryTrackCount > 0 ? `(${libraryTrackCount})` : "— not set up"}
        {fileCount > 0 && (
          <>
            {" · "}
            <span className="font-medium text-foreground">Working batch</span> ({fileCount})
          </>
        )}
      </div>
    </aside>
  );
}
