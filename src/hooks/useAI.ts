import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  basename,
  type CleanedTrack,
  type OllamaStatus,
  type PendingChange,
  type Settings,
  type TagData,
} from "../types";

/** Same wording as the Rust pre-check in `claude_cli.rs`, for the cheap
 *  `navigator.onLine` check that runs before a Claude batch even starts. */
export const CLAUDE_OFFLINE_MESSAGE =
  "No internet connection — the Claude CLI needs to reach Anthropic. Check your connection and try again.";

/** One track as the clean prompt sees it. `index` is 1-based and global to the run. */
export interface TrackInput {
  index: number;
  filename: string;
  artist: string;
  title: string;
  year: string;
  genre: string;
}

const AI_FIELDS = ["artist", "title", "year", "genre"] as const;

/**
 * Batch size clamped to a sane range. A zero/negative/NaN value from settings
 * would otherwise make the batching loops never advance, hanging the app with
 * no way out short of killing it.
 */
function safeBatchSize(n: number): number {
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

/** Filename without its extension — given to the AI as a fallback source. */
function stem(path: string): string {
  return basename(path).replace(/\.[^.]+$/, "");
}

export interface CleanResult {
  rows: PendingChange[];
  stopped: boolean;
  /** Tracks the AI could not identify from tags or filename. */
  unresolved: string[];
  /** One message per batch that failed; the other batches' results stand. */
  batchErrors: string[];
}

/**
 * Keeps only the results whose index belongs to `batch`. A model that
 * answers with an index from outside the batch it was given would otherwise
 * overwrite another track's result — a different song's tags written into it.
 */
export function resultsForBatch(batch: TrackInput[], results: CleanedTrack[]): CleanedTrack[] {
  const allowed = new Set(batch.map((t) => t.index));
  return results.filter((r) => allowed.has(r.index));
}

/** Builds the clean prompt's track list. Indexes are 1-based over `paths`. */
export function cleanInputs(paths: string[], map: Record<string, TagData>): TrackInput[] {
  return paths.map((p, i) => ({
    index: i + 1,
    filename: stem(p),
    artist: map[p]?.artist ?? "",
    title: map[p]?.title ?? "",
    year: map[p]?.year ?? "",
    genre: map[p]?.genre ?? "",
  }));
}

/**
 * Turns cleaned tracks (keyed by their 1-based index) into preview rows.
 * Shared by the Ollama run and manual mode so a pasted answer is treated
 * exactly like a locally generated one.
 */
export function buildCleanRows(
  paths: string[],
  map: Record<string, TagData>,
  cleanedByIndex: Map<number, CleanedTrack>,
): { rows: PendingChange[]; unresolved: string[] } {
  const rows: PendingChange[] = [];
  const unresolved: string[] = [];
  paths.forEach((path, i) => {
    const tags = map[path];
    const cleaned = cleanedByIndex.get(i + 1);
    const filename = basename(path);

    // Unresolved: no artist AND no title survive, from tags or filename.
    const finalTitle = (cleaned?.title ?? "").trim() || (tags.title ?? "").trim();
    const finalArtist = (cleaned?.artist ?? "").trim() || (tags.artist ?? "").trim();
    if (!finalTitle && !finalArtist) unresolved.push(path);

    // Only build change rows for tracks we actually got a result for.
    if (!cleaned) return;

    for (const field of AI_FIELDS) {
      const before = (tags[field] ?? "").trim();
      let after = (cleaned?.[field] ?? "").trim();
      // Keep the original year unless the AI returned a plausible one.
      if (field === "year" && after && !/^\d{4}([-.].*)?$/.test(after)) after = "";
      const changed = !!after && after !== before;
      rows.push({
        id: `${path}::ai::${field}`,
        path,
        filename,
        field,
        before,
        after: changed ? after : before,
        include: changed,
        changed,
        kind: "update",
      });
    }

    // Rule: if Album Artist is empty and Artist is set, copy it.
    const albumArtist = (tags.albumArtist ?? "").trim();
    if (!albumArtist && finalArtist) {
      rows.push({
        id: `${path}::ai::albumArtist`,
        path,
        filename,
        field: "albumArtist",
        before: "",
        after: finalArtist,
        include: true,
        changed: true,
        kind: "update",
      });
    }
  });
  return { rows, unresolved };
}

export function useAI() {
  const [status, setStatus] = useState<OllamaStatus | null>(null);
  const stopRef = useRef(false);

  /** Requests the in-progress AI run to stop after the current batch. */
  const stop = () => {
    stopRef.current = true;
  };

  const check = async (url: string): Promise<OllamaStatus> => {
    try {
      const result = await invoke<OllamaStatus>("check_ollama", { url });
      setStatus(result);
      return result;
    } catch (e) {
      const failed: OllamaStatus = { running: false, models: [], error: String(e) };
      setStatus(failed);
      return failed;
    }
  };

  /**
   * Runs the AI cleanup over `paths` in batches and returns preview rows.
   * Malformed or missing AI values fall back to the original (no row).
   */
  const runClean = async (
    paths: string[],
    map: Record<string, TagData>,
    settings: Settings,
    model: string,
    onProgress: (done: number, total: number) => void,
  ): Promise<CleanResult> => {
    stopRef.current = false;
    // Thrown (not notified) so the caller's catch clears its busy state, the
    // same way a failed invoke would.
    if (settings.aiBackend === "claude" && !navigator.onLine) throw new Error(CLAUDE_OFFLINE_MESSAGE);
    const valid = paths.filter((p) => map[p]);
    const inputs = cleanInputs(valid, map);

    const cleanedByIndex = new Map<number, CleanedTrack>();
    const batchErrors: string[] = [];
    const batchSize = safeBatchSize(settings.batchSize);
    onProgress(0, valid.length);
    for (let start = 0; start < inputs.length; start += batchSize) {
      if (stopRef.current) break;
      const batch = inputs.slice(start, start + batchSize);
      // Which backend runs the batch is the only difference between them:
      // batching, progress and Stop are identical either way, and both
      // commands build the prompt and parse the answer with the same shared
      // Rust helpers, so a track cleans the same whichever is selected.
      let results: CleanedTrack[];
      try {
        results =
          settings.aiBackend === "claude"
            ? await invoke<CleanedTrack[]>("claude_clean_batch", {
                tracks: batch,
                transliterateScripts: settings.transliterateScripts,
                model: settings.claudeTasks.clean.model || null,
                effort: settings.claudeTasks.clean.effort || null,
              })
            : await invoke<CleanedTrack[]>("ai_clean_batch", {
                url: settings.ollamaUrl,
                model,
                tracks: batch,
                transliterateScripts: settings.transliterateScripts,
              });
      } catch (e) {
        // One bad batch (a dropped connection, an answer that isn't JSON)
        // used to throw away every batch already finished. Keep them, and
        // report which tracks this one covered.
        const first = batch[0].index;
        const last = batch[batch.length - 1].index;
        batchErrors.push(`Tracks ${first}–${last}: ${String(e)}`);
        onProgress(Math.min(start + batch.length, valid.length), valid.length);
        continue;
      }
      // Discard a batch that finished after the user asked to stop.
      if (stopRef.current) break;
      for (const r of resultsForBatch(batch, results)) cleanedByIndex.set(r.index, r);
      onProgress(Math.min(start + batch.length, valid.length), valid.length);
    }

    // Every batch failed: that is an error (offline, Ollama down), not an
    // empty result.
    if (batchErrors.length && cleanedByIndex.size === 0 && !stopRef.current) {
      throw new Error(batchErrors[0]);
    }
    const { rows, unresolved } = buildCleanRows(valid, map, cleanedByIndex);
    return { rows, stopped: stopRef.current, unresolved, batchErrors };
  };

  /**
   * One free-form prompt through the configured backend (D2 "New button").
   * "manual" has no way to answer by itself, so it is refused here and the
   * dialog offers copy-prompt / paste-answer instead.
   */
  const generateText = async (prompt: string, settings: Settings, model: string): Promise<string> => {
    if (settings.aiBackend === "claude") {
      if (!navigator.onLine) throw new Error(CLAUDE_OFFLINE_MESSAGE);
      return invoke<string>("claude_generate_text", {
        prompt,
        model: settings.claudeTasks.clean.model || null,
        effort: settings.claudeTasks.clean.effort || null,
      });
    }
    if (settings.aiBackend === "ollama") {
      return invoke<string>("ai_generate_text", { url: settings.ollamaUrl, model, prompt });
    }
    throw new Error("The manual AI backend cannot answer by itself");
  };

  return { status, check, runClean, generateText, stop };
}
