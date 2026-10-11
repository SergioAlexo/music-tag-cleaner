import { useState } from "react";
import { Music2, X } from "lucide-react";
import type { GenreClickChoice } from "../lib/sessionTabs";
import { Button, Card } from "./ui";

/** An answer to the dialog; `ask` is never an answer, it is the "not decided" setting. */
export type GenreSessionChoice = Exclude<GenreClickChoice, "ask">;

/**
 * Shown when a library genre or album is clicked while the batch was built by hand
 * (folder, files, drop). The default is a new tab, which loses nothing;
 * Replace states exactly what it forgets. Edits are already written to the
 * files, so only the list and the undo history are at stake.
 */
export function GenreSessionDialog({
  label,
  sessionLabel,
  fileCount,
  undoSteps,
  hasPreview,
  onChoose,
  onCancel,
}: {
  /** What was clicked: a genre or an album ("Greatest Hits — Queen"). */
  label: string;
  /** Folder name (or "Files") the current session is known by. */
  sessionLabel: string;
  fileCount: number;
  undoSteps: number;
  /** An unapplied preview that opening the genre elsewhere would discard. */
  hasPreview: boolean;
  onChoose: (choice: GenreSessionChoice, remember: boolean) => void;
  onCancel: () => void;
}) {
  const [remember, setRemember] = useState(false);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <Card className="flex w-[460px] flex-col overflow-hidden">
        <div className="flex items-start justify-between gap-4 border-b px-5 py-3.5">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <Music2 className="h-4 w-4" /> Open &ldquo;{label}&rdquo;
            </h2>
            <p className="text-xs text-muted-foreground">
              You have a session open: {fileCount} file{fileCount === 1 ? "" : "s"} from{" "}
              {sessionLabel}
              {undoSteps > 0 && ` · ${undoSteps} undo step${undoSteps === 1 ? "" : "s"}`}.
            </p>
          </div>
          <button className="text-muted-foreground hover:text-foreground" onClick={onCancel}>
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-col gap-2 px-5 py-4">
          <Button onClick={() => onChoose("newTab", remember)}>Open in new tab</Button>
          <Button variant="secondary" onClick={() => onChoose("replace", remember)}>
            Replace session
          </Button>
          <Button variant="secondary" onClick={() => onChoose("filter", remember)}>
            Filter this batch to it
          </Button>
          <p className="text-xs text-muted-foreground">
            Your edits are already saved to the files. Replace only forgets this list and its undo
            history.
            {hasPreview && " An unapplied preview is discarded either way, except when filtering."}
          </p>
        </div>

        <div className="flex items-center justify-between gap-3 border-t px-5 py-3">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="accent-[var(--primary)]"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            Remember my choice
          </label>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </Card>
    </div>
  );
}
