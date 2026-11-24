import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Loader2, Plus, Sparkles } from "lucide-react";
import { Button, cn, inputClass } from "./ui";
import {
  buildOrganizePrompt,
  checkOrganized,
  chunkLimitsFor,
  organizeList,
  parseOrganizedAnswer,
  repairLinks,
} from "../lib/ytListAI";

/** Non-empty lines, for the counts above the two columns. */
function lineCount(text: string): number {
  return text.split(/\r?\n/).filter((l) => l.trim()).length;
}

/**
 * Review dialog for "Organize with AI" on the YouTube Music import box: the
 * pasted text on the left, the AI's version on the right (editable), and
 * below them whatever the AI left out or made up. Nothing reaches the import
 * box until the user takes the result.
 *
 * With the manual backend there is nothing to call, so it shows the prompt to
 * paste into any AI and takes the answer back by paste.
 */
export function OrganizeListDialog({
  backend,
  source,
  generate,
  canFetch,
  onUse,
  onClose,
}: {
  backend: "ollama" | "claude" | "manual";
  source: string;
  generate: (prompt: string) => Promise<string>;
  /** Whether "Use & Fetch" can run (yt-dlp is there and nothing is fetching). */
  canFetch: boolean;
  onUse: (text: string, fetch: boolean) => void;
  onClose: () => void;
}) {
  const manual = backend === "manual";
  const [instructions, setInstructions] = useState("");
  const [answer, setAnswer] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const closedRef = useRef(false);
  const working = progress !== null;

  useEffect(() => {
    closedRef.current = false;
    return () => {
      closedRef.current = true;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const prompt = useMemo(() => buildOrganizePrompt(source, instructions), [source, instructions]);
  const check = useMemo(
    () => (result === null ? null : checkOrganized(source, result)),
    [source, result],
  );

  const run = async () => {
    setError("");
    if (manual) {
      const lines = repairLinks(source, parseOrganizedAnswer(answer));
      if (lines.length) setResult(lines.join("\n"));
      else setError("No songs found in that answer");
      return;
    }
    setProgress({ done: 0, total: 1 });
    try {
      const done = await organizeList(
        source,
        instructions,
        chunkLimitsFor(backend),
        generate,
        (d, total) => !closedRef.current && setProgress({ done: d, total }),
        () => closedRef.current,
      );
      if (!done) return;
      setResult(done.text);
      if (done.errors.length) setError(`Some of the list was kept as pasted.\n${done.errors.join("\n")}`);
    } catch (e) {
      if (!closedRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!closedRef.current) setProgress(null);
    }
  };

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
    } catch {
      setError("Could not reach the clipboard — select the prompt and press Ctrl+C");
    }
  };

  const boxClass = cn(inputClass, "w-full resize-none py-2 font-mono text-xs");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6">
      <div className="flex max-h-full w-full max-w-4xl flex-col rounded-xl border bg-popover text-popover-foreground shadow-2xl">
        <div className="border-b px-5 py-4">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Sparkles className="h-4 w-4 text-primary" /> Organize list with AI
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Puts one song per line as Artist - Title, and removes numbering, headings and times. You check the result
            before it replaces your list.
          </p>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
          <input
            autoFocus
            className={cn(inputClass, "w-full")}
            placeholder='Optional: tell the AI about this list, e.g. "title comes first" or "all by Pitbull"'
            value={instructions}
            disabled={working}
            onChange={(e) => {
              setInstructions(e.target.value);
              setCopied(false);
            }}
            onKeyDown={(e) => e.key === "Enter" && !manual && !working && void run()}
          />

          {manual && result === null && (
            <>
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold">1. Copy this prompt into your AI</span>
                <Button size="sm" variant="secondary" onClick={() => void copyPrompt()}>
                  {copied ? "Copied" : "Copy Prompt"}
                </Button>
              </div>
              <textarea readOnly className={cn(boxClass, "h-28")} value={prompt} />
              <div className="text-xs font-semibold">2. Paste its answer</div>
              <textarea className={cn(boxClass, "h-32")} value={answer} onChange={(e) => setAnswer(e.target.value)} />
            </>
          )}

          {!(manual && result === null) && (
            <div className="grid grid-cols-2 gap-3">
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-xs font-semibold">Your list ({lineCount(source)} lines)</span>
                <textarea readOnly wrap="off" className={cn(boxClass, "h-72")} value={source} />
              </div>
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-xs font-semibold">
                  Organized{result !== null ? ` (${lineCount(result)} songs) — you can edit it` : ""}
                </span>
                <textarea
                  wrap="off"
                  className={cn(boxClass, "h-72")}
                  value={result ?? ""}
                  readOnly={result === null || working}
                  placeholder={working ? "Working…" : "Press Organize to see the result here"}
                  onChange={(e) => setResult(e.target.value)}
                />
              </div>
            </div>
          )}

          {check && check.added.length > 0 && (
            <div className="rounded-md border border-destructive/40 px-3 py-2 text-xs">
              <div className="flex items-center gap-1.5 font-semibold text-destructive">
                <AlertTriangle className="h-3.5 w-3.5" /> Not in your list — check these ({check.added.length})
              </div>
              <ul className="mt-1 max-h-24 select-text overflow-y-auto">
                {check.added.map((l, i) => (
                  <li key={`${i}:${l}`} className="break-words">
                    {l}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {check && check.leftOut.length > 0 && (
            <div className="rounded-md border px-3 py-2 text-xs">
              <div className="font-semibold">Left out of the result ({check.leftOut.length})</div>
              <p className="text-muted-foreground">Usually headings and notes. Add a line back if it is a song.</p>
              <ul className="mt-1 max-h-32 overflow-y-auto">
                {check.leftOut.map((l, i) => (
                  <li key={`${i}:${l}`} className="flex items-center gap-2">
                    <button
                      className="flex shrink-0 items-center gap-1 text-primary hover:underline"
                      onClick={() => setResult((r) => (r?.trim() ? `${r.trimEnd()}\n${l}` : l))}
                    >
                      <Plus className="h-3 w-3" /> Add back
                    </button>
                    <span className="min-w-0 flex-1 select-text truncate" title={l}>
                      {l}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {error && <p className="select-text whitespace-pre-wrap text-xs text-destructive">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-5 py-3">
          {progress && (
            <span className="mr-auto flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              {progress.total > 1 ? `Part ${Math.min(progress.done + 1, progress.total)} of ${progress.total}` : "Asking the AI…"}
            </span>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={result === null ? "default" : "secondary"}
            onClick={() => void run()}
            disabled={working || (manual && !answer.trim())}
          >
            {manual ? "Read Answer" : result === null ? "Organize" : "Try Again"}
          </Button>
          {result !== null && (
            <>
              <Button variant="secondary" onClick={() => onUse(result, false)} disabled={working || !result.trim()}>
                Use List
              </Button>
              <Button onClick={() => onUse(result, true)} disabled={working || !result.trim() || !canFetch}>
                Use &amp; Fetch
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
