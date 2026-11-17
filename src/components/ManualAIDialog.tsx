import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, ChevronLeft, ChevronRight, Copy, ExternalLink, X } from "lucide-react";

import { cleanInputs } from "../hooks/useAI";
import { basename, type CleanedTrack, type TagData } from "../types";
import { Button, Card, cn, selectClass } from "./ui";

/** What the dialog hands back once the user is done pasting answers. */
export type ManualResults = { byIndex: Map<number, CleanedTrack> };

interface Props {
  /** Tracks to process, in the order their 1-based prompt index follows. */
  paths: string[];
  tags: Record<string, TagData>;
  transliterateScripts: string[];
  /** Fields this run asks the AI for; the prompt carries rules for these only. */
  fields: string[];
  chunkSize: number;
  onChunkSizeChange: (size: number) => void;
  onCancel: () => void;
  onDone: (results: ManualResults) => void;
}

const CHUNK_SIZES = [10, 25, 50, 100, 250];

/** Popular chat AIs, offered as a shortcut — any AI can answer the prompt. */
const AI_SITES = [
  { label: "ChatGPT", url: "https://chatgpt.com" },
  { label: "Claude", url: "https://claude.ai" },
  { label: "Gemini", url: "https://gemini.google.com" },
];

/** Clipboard write, with a fallback for webviews that block the async API. */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const el = document.createElement("textarea");
      el.value = text;
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(el);
      return ok;
    } catch {
      return false;
    }
  }
}

export function ManualAIDialog({
  paths,
  tags,
  transliterateScripts,
  fields,
  chunkSize,
  onChunkSizeChange,
  onCancel,
  onDone,
}: Props) {
  const [chunk, setChunk] = useState(0);
  /** Raw pasted text, per batch. */
  const [texts, setTexts] = useState<Record<number, string>>({});
  /** Parsed results per batch — reparsing a batch replaces only its own entries. */
  const [parsed, setParsed] = useState<Record<number, CleanedTrack[]>>({});
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [prompt, setPrompt] = useState("");
  const [copied, setCopied] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);

  const size = Math.max(1, chunkSize);
  const chunkCount = Math.max(1, Math.ceil(paths.length / size));
  const current = Math.min(chunk, chunkCount - 1);
  const start = current * size;
  const end = Math.min(start + size, paths.length);
  const chunkPaths = paths.slice(start, end);

  // Prompt indexes are global (1-based over the whole selection), so a pasted
  // answer lands on the right track no matter which order batches are done in.
  const inputs = useMemo(
    () => cleanInputs(paths, tags).slice(start, end),
    [paths, tags, start, end],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const text = await invoke<string>("ai_clean_prompt", { tracks: inputs, transliterateScripts, fields });
        if (!cancelled) setPrompt(text);
      } catch (e) {
        if (!cancelled) setPrompt(`Could not build the prompt: ${String(e)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `fields` is a fresh array each render; its content is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputs, transliterateScripts, fields.join(",")]);

  // Parse while the user pastes, so a bad answer is caught before they move on.
  const text = texts[current] ?? "";
  useEffect(() => {
    if (!text.trim()) {
      setParsed((p) => {
        if (!(current in p)) return p;
        const next = { ...p };
        delete next[current];
        return next;
      });
      setErrors((e) => ({ ...e, [current]: "" }));
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const results = await invoke<CleanedTrack[]>("ai_parse_clean_response", { text });
        if (cancelled) return;
        setParsed((p) => ({ ...p, [current]: results }));
        setErrors((e) => ({ ...e, [current]: "" }));
      } catch (e) {
        if (cancelled) return;
        setParsed((p) => {
          const next = { ...p };
          delete next[current];
          return next;
        });
        setErrors((er) => ({ ...er, [current]: String(e) }));
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [text, current]);

  /** Every batch's results merged by global index; out-of-range ones are dropped. */
  const merged = useMemo(() => {
    const byIndex = new Map<number, CleanedTrack>();
    for (const key of Object.keys(parsed)
      .map(Number)
      .sort((a, b) => a - b)) {
      for (const r of parsed[key]) {
        if (r.index >= 1 && r.index <= paths.length) byIndex.set(r.index, r);
      }
    }
    return byIndex;
  }, [parsed, paths.length]);

  /** How many of a batch's own tracks have an answer — drives the batch pills. */
  const answeredIn = (i: number) => {
    let n = 0;
    for (let k = i * size + 1; k <= Math.min((i + 1) * size, paths.length); k++) {
      if (merged.has(k)) n++;
    }
    return n;
  };

  const copyPrompt = async () => {
    if (await copyToClipboard(prompt)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      return;
    }
    // Selecting it at least lets the user press Ctrl+C themselves.
    promptRef.current?.select();
  };

  const finish = () => {
    const byIndex = new Map<number, CleanedTrack>();
    merged.forEach((v, k) => byIndex.set(k, v));
    onDone({ byIndex });
  };

  const chunkError = errors[current];
  const chunkParsed = parsed[current]?.length ?? 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <Card className="flex max-h-full w-[860px] flex-col overflow-hidden">
        <div className="flex items-start justify-between gap-4 border-b px-5 py-3.5">
          <div>
            <h2 className="text-sm font-semibold">Manual AI — Clean tags</h2>
            <p className="text-xs text-muted-foreground">
              No Ollama needed. Copy the prompt, paste it into any AI, then paste its answer back
              here. {paths.length} track{paths.length === 1 ? "" : "s"} selected.
            </p>
          </div>
          <button className="text-muted-foreground hover:text-foreground" onClick={onCancel}>
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Batch bar — a long selection is split so each part fits one chat message. */}
        <div className="flex flex-wrap items-center gap-2 border-b px-5 py-2.5">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setChunk(Math.max(0, current - 1))}
            disabled={current === 0}
            title="Previous batch"
          >
            <ChevronLeft />
          </Button>
          <span className="text-xs font-medium">
            Batch {current + 1} of {chunkCount}
            <span className="ml-1.5 font-normal text-muted-foreground">
              (tracks {start + 1}–{end})
            </span>
          </span>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setChunk(Math.min(chunkCount - 1, current + 1))}
            disabled={current >= chunkCount - 1}
            title="Next batch"
          >
            <ChevronRight />
          </Button>

          {chunkCount > 1 && (
            <div className="flex flex-wrap gap-1">
              {Array.from({ length: chunkCount }, (_, i) => {
                const done = answeredIn(i);
                const total = Math.min((i + 1) * size, paths.length) - i * size;
                return (
                  <button
                    key={i}
                    onClick={() => setChunk(i)}
                    title={`Batch ${i + 1} — ${done} of ${total} answered`}
                    className={cn(
                      "h-5 min-w-5 rounded px-1 text-[10px] font-semibold transition-colors",
                      i === current
                        ? "bg-primary text-primary-foreground"
                        : done >= total
                          ? "bg-primary/20 text-primary"
                          : done > 0
                            ? "bg-amber-500/20 text-amber-500"
                            : "bg-secondary text-muted-foreground hover:bg-accent",
                    )}
                  >
                    {i + 1}
                  </button>
                );
              })}
            </div>
          )}

          <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            Tracks per batch
            <select
              className={cn(selectClass, "h-7 py-0 text-xs")}
              value={size}
              onChange={(e) => {
                onChunkSizeChange(Number(e.target.value));
                setChunk(0);
              }}
            >
              {CHUNK_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <section>
            <div className="mb-1.5 flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold">1. Copy this prompt</span>
              <Button size="sm" variant={copied ? "secondary" : "default"} onClick={copyPrompt}>
                {copied ? <Check /> : <Copy />}
                {copied ? "Copied" : "Copy prompt"}
              </Button>
              <span className="text-xs text-muted-foreground">then paste it into</span>
              {AI_SITES.map((s) => (
                <Button
                  key={s.label}
                  size="sm"
                  variant="outline"
                  onClick={() => void openUrl(s.url)}
                  title={`Open ${s.url}`}
                >
                  {s.label}
                  <ExternalLink />
                </Button>
              ))}
            </div>
            <textarea
              ref={promptRef}
              readOnly
              value={prompt}
              spellCheck={false}
              className="h-40 w-full resize-y rounded-md border bg-secondary/40 p-3 font-mono text-[11px] leading-relaxed outline-none"
            />
          </section>

          <section>
            <div className="mb-1.5 flex flex-wrap items-baseline gap-2">
              <span className="text-xs font-semibold">2. Paste the answer back</span>
              <span className="text-xs text-muted-foreground">
                Just paste the whole reply — code fences, reasoning or prose around the JSON are
                fine.
              </span>
            </div>
            <textarea
              value={text}
              spellCheck={false}
              placeholder='[{"index": 1, "artist": "…", "title": "…", "year": "…", "genre": "…"}]'
              onChange={(e) => setTexts((t) => ({ ...t, [current]: e.target.value }))}
              className="h-40 w-full resize-y rounded-md border bg-transparent p-3 font-mono text-[11px] leading-relaxed outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            {chunkError ? (
              <p className="mt-1 text-xs text-destructive">{chunkError}</p>
            ) : chunkParsed > 0 ? (
              <p className="mt-1 text-xs text-primary">
                Read {chunkParsed} result{chunkParsed === 1 ? "" : "s"} — {answeredIn(current)} of{" "}
                {chunkPaths.length} track{chunkPaths.length === 1 ? "" : "s"} in this batch answered
              </p>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">
                Waiting for an answer{chunkCount > 1 ? " for this batch" : ""}.
              </p>
            )}
          </section>

          {chunkPaths.length > 0 && (
            <section>
              <div className="mb-1.5 text-xs font-semibold">Tracks in this batch</div>
              <div className="max-h-40 overflow-y-auto rounded-md border">
                {chunkPaths.map((p, i) => {
                  const index = start + i + 1;
                  const hit = merged.get(index);
                  const answer = hit ? `${hit.artist ?? "?"} — ${hit.title ?? "?"}` : "—";
                  return (
                    <div
                      key={p}
                      className="flex items-center gap-2 border-b px-2 py-1 text-[11px] last:border-b-0"
                    >
                      <span className="w-8 shrink-0 text-right text-muted-foreground">{index}</span>
                      <span className="min-w-0 flex-1 truncate" title={p}>
                        {basename(p)}
                      </span>
                      <span
                        className={cn(
                          "max-w-[45%] shrink-0 truncate",
                          hit ? "text-primary" : "text-muted-foreground",
                        )}
                        title={answer}
                      >
                        {answer}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </div>

        <div className="flex items-center justify-between gap-4 border-t px-5 py-3">
          <span className="text-xs text-muted-foreground">
            {merged.size} of {paths.length} track{paths.length === 1 ? "" : "s"} answered
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onCancel}>
              Cancel
            </Button>
            <Button size="sm" onClick={finish} disabled={merged.size === 0}>
              Preview changes ({merged.size})
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
