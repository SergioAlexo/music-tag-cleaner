import { useState } from "react";
import { Sparkles } from "lucide-react";
import { Button, inputClass, cn } from "./ui";
import { buildNewButtonPrompt, parseGeneratedPlugin } from "../plugins/aiPlugin";

/**
 * "New button" (D2): describe what you want; the configured AI backend writes
 * a plugin. The result is only STAGED (`onGenerated`): the Plugins page then
 * shows the normal review dialog with permissions and code.
 *
 * With the manual backend there is nothing to call, so the dialog shows the
 * prompt to paste into any AI and takes the answer back by paste.
 */
export function NewButtonDialog({
  backend,
  actionIds,
  generate,
  onGenerated,
  onClose,
}: {
  backend: "ollama" | "claude" | "manual";
  actionIds: string[];
  generate: (prompt: string) => Promise<string>;
  onGenerated: (manifestText: string, code: string | null) => Promise<string | null>;
  onClose: () => void;
}) {
  const [description, setDescription] = useState("");
  const [answer, setAnswer] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const manual = backend === "manual";
  const prompt = buildNewButtonPrompt(description || "(describe the button above)", actionIds);

  const finish = async (text: string) => {
    const parsed = parseGeneratedPlugin(text);
    if (!parsed.ok) throw new Error(parsed.error);
    const problem = await onGenerated(parsed.manifestText, parsed.code);
    if (problem) throw new Error(problem);
    onClose();
  };

  const run = async () => {
    setWorking(true);
    setError("");
    try {
      await finish(manual ? answer : await generate(prompt));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6">
      <div className="flex max-h-full w-full max-w-xl flex-col rounded-xl border bg-popover text-popover-foreground shadow-2xl">
        <div className="border-b px-5 py-4">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Sparkles className="h-4 w-4 text-primary" /> New button with AI
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Say what you want in words. You review its permissions and code before anything runs.
          </p>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
          <textarea
            autoFocus
            className={cn(inputClass, "h-24 w-full resize-none select-text py-2")}
            placeholder='e.g. "A button that hides the Genre column" or "Right-click: copy Artist - Title"'
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          {manual && (
            <>
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold">1. Copy this prompt into your AI</span>
                <Button size="sm" variant="secondary" onClick={() => void navigator.clipboard.writeText(prompt)}>
                  Copy prompt
                </Button>
              </div>
              <textarea readOnly className={cn(inputClass, "h-20 w-full select-text py-2 font-mono text-[11px]")} value={prompt} />
              <div className="text-xs font-semibold">2. Paste its answer</div>
              <textarea
                className={cn(inputClass, "h-28 w-full select-text py-2 font-mono text-[11px]")}
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
              />
            </>
          )}
          {error && <p className="whitespace-pre-wrap text-xs text-destructive">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 border-t px-5 py-3">
          <Button variant="ghost" onClick={onClose} disabled={working}>
            Cancel
          </Button>
          <Button onClick={() => void run()} disabled={working || !description.trim() || (manual && !answer.trim())}>
            {working ? "Generating…" : manual ? "Review" : "Generate"}
          </Button>
        </div>
      </div>
    </div>
  );
}
