import { useState } from "react";
import { ListMusic, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import type { ImportSessionSummary } from "../types";
import { Button, Card, cn, inputClass } from "./ui";

/** The name of a session as an editable field: Enter or leaving it saves,
 * Esc puts the old name back, and an empty name is never saved. */
export function SessionNameInput({
  name,
  className,
  autoFocus,
  onRename,
  onDone,
}: {
  name: string;
  className?: string;
  autoFocus?: boolean;
  onRename: (name: string) => void;
  onDone?: () => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const commit = () => {
    const next = text?.trim();
    if (next && next !== name) onRename(next);
    setText(null);
    onDone?.();
  };
  return (
    <input
      autoFocus={autoFocus}
      aria-label="Import name"
      className={className}
      value={text ?? name}
      onFocus={(e) => e.target.select()}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setText(null);
          onDone?.();
        }
      }}
    />
  );
}

/** The start page of the YouTube Music import: every saved import, newest
 * first, and a button for a new one. */
export function ImportSessionsLanding({
  sessions,
  openKeys,
  fetchingKeys,
  onNew,
  onOpen,
  onRename,
  onDelete,
}: {
  /** null while the list is still loading. */
  sessions: ImportSessionSummary[] | null;
  openKeys: string[];
  fetchingKeys: string[];
  onNew: () => void;
  onOpen: (key: string) => void;
  onRename: (key: string, name: string) => void;
  onDelete: (key: string) => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  /** Deleting takes a second click: it can't be undone. */
  const [confirming, setConfirming] = useState<string | null>(null);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold">YouTube Music Import</h1>
          <p className="text-sm text-muted-foreground">
            Each import keeps its own list and matches, and saves itself. Open several and swap between them in the tabs
            above.
          </p>
        </div>
        <Button onClick={onNew}>
          <Plus />
          New Import
        </Button>
      </div>

      {sessions === null ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading your imports…
        </div>
      ) : !sessions.length ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          No imports yet. Press New Import, then paste a playlist link or a list of songs.
        </Card>
      ) : (
        <Card className="divide-y">
          {sessions.map((s) => {
            const fetching = fetchingKeys.includes(s.key);
            return (
              <div key={s.key} className="flex items-center gap-3 px-4 py-2.5 hover:bg-accent/20">
                {fetching ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
                ) : (
                  <ListMusic
                    className={cn(
                      "h-4 w-4 shrink-0",
                      openKeys.includes(s.key) ? "text-primary" : "text-muted-foreground",
                    )}
                  />
                )}
                {renaming === s.key ? (
                  <SessionNameInput
                    autoFocus
                    name={s.title}
                    className={cn(inputClass, "h-8 min-w-0 flex-1")}
                    onRename={(n) => onRename(s.key, n)}
                    onDone={() => setRenaming(null)}
                  />
                ) : (
                  <button className="min-w-0 flex-1 text-left" onClick={() => onOpen(s.key)}>
                    <div className="truncate text-sm font-medium">{s.title || "Untitled import"}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {fetching
                        ? "Fetching…"
                        : !s.trackCount
                          ? "Nothing fetched yet"
                          : s.matched === null
                            ? `${s.trackCount} track${s.trackCount === 1 ? "" : "s"}`
                            : `${s.matched} of ${s.trackCount} matched`}
                      {" · "}
                      {new Date(s.savedAt * 1000).toLocaleString()}
                    </div>
                  </button>
                )}
                {!!s.trackCount && s.matched !== null && (
                  <div className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-secondary">
                    <div className="h-full bg-primary" style={{ width: `${(s.matched / s.trackCount) * 100}%` }} />
                  </div>
                )}
                <button
                  className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                  title="Rename"
                  onClick={() => setRenaming(s.key)}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                {confirming === s.key ? (
                  <Button
                    size="sm"
                    variant="destructive"
                    autoFocus
                    onBlur={() => setConfirming(null)}
                    onClick={() => {
                      setConfirming(null);
                      onDelete(s.key);
                    }}
                  >
                    Delete
                  </Button>
                ) : (
                  <button
                    className="shrink-0 rounded-md p-1 text-muted-foreground hover:text-destructive"
                    title="Delete this import and its decisions (your files are not touched)"
                    onClick={() => setConfirming(s.key)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            );
          })}
        </Card>
      )}
    </div>
  );
}
