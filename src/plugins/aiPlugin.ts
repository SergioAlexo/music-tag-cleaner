/**
 * "New button" (D2): turns a plain-language description into a plugin through
 * the configured AI backend. This file only builds the prompt and parses the
 * answer; the result goes through `PluginManager.propose(..., "ai")`, i.e. the
 * very same review-before-anything-runs flow as plugins an AI creates over MCP.
 *
 * No React / Tauri imports: unit-tested.
 */
import { AUTHORING_GUIDE } from "./guide";

export function buildNewButtonPrompt(description: string, actionIds: string[]): string {
  const actions = actionIds.filter((a) => !a.startsWith("plugins.") && a !== "script.run").join(", ");
  return [
    "You write small plugins for the desktop app Vatra Wave (a DJ music-library manager, formerly called Music Tag Cleaner).",
    "Turn the request below into ONE plugin. Prefer a declarative plugin (no code) when a button that calls an existing app action with fixed parameters is enough; only write a script when it truly needs logic.",
    "Ask for the fewest permissions that work.",
    "",
    "AUTHORING GUIDE",
    AUTHORING_GUIDE,
    "",
    `APP ACTIONS you can call: ${actions || "(none listed)"}`,
    "",
    "REQUEST",
    description.trim(),
    "",
    'Reply with ONLY a JSON object, no prose and no markdown fences: {"manifest": { ... }, "code": "<contents of index.js, or null when the plugin has no entry>"}.',
  ].join("\n");
}

export type GeneratedPlugin = { ok: true; manifestText: string; code: string | null } | { ok: false; error: string };

/** Pulls `{manifest, code}` out of a model answer, tolerating fences, prose and think blocks. */
export function parseGeneratedPlugin(text: string): GeneratedPlugin {
  let t = text;
  const think = t.lastIndexOf("</think>");
  if (think >= 0) t = t.slice(think + "</think>".length);
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) return { ok: false, error: "The answer did not contain a JSON object." };
  let v: unknown;
  try {
    v = JSON.parse(t.slice(start, end + 1));
  } catch (e) {
    return { ok: false, error: `The answer was not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!v || typeof v !== "object") return { ok: false, error: "The answer was not a JSON object." };
  const o = v as Record<string, unknown>;
  // A model that skipped the wrapper and returned the bare manifest is accepted.
  const manifest = "manifest" in o ? o.manifest : "id" in o && "apiVersion" in o ? o : undefined;
  if (!manifest || typeof manifest !== "object") return { ok: false, error: 'The answer has no "manifest" object.' };
  const code = "manifest" in o ? o.code : null;
  if (code !== null && code !== undefined && typeof code !== "string")
    return { ok: false, error: '"code" must be a string or null.' };
  return {
    ok: true,
    manifestText: JSON.stringify(manifest, null, 2),
    code: typeof code === "string" && code.trim() ? code : null,
  };
}
