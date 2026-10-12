/**
 * Plugin store (D2): the index format and the install/update decision logic.
 *
 * The store is a static `index.json` (in a GitHub repo, say) whose address is
 * `settings.pluginStoreUrl`:
 *
 *   { "plugins": [ { "manifest": { ...manifest.json... },
 *                    "url": "packages/hide-genre-1.0.0.zip",   // relative to the index, or absolute
 *                    "sha256": "<hex of the zip>" } ] }
 *
 * Rust downloads, verifies the SHA-256 and unpacks (commands/plugin_store.rs);
 * the result is staged through `PluginManager.propose(..., "store")`, the same
 * review dialog as every other source. This file has no React/Tauri imports.
 */
import { validateManifest, type PluginManifest } from "./manifest";

export interface StoreEntry {
  id: string;
  manifest: PluginManifest;
  /** Absolute download address (relative ones are resolved against the index). */
  url: string;
  sha256: string;
}

export interface ParsedIndex {
  entries: StoreEntry[];
  /** One line per entry that was skipped, so a bad entry never hides the good ones. */
  problems: string[];
}

const SHA_RE = /^[0-9a-fA-F]{64}$/;

export function parseStoreIndex(text: string, indexUrl: string): ParsedIndex {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { entries: [], problems: [`The store index is not valid JSON: ${e instanceof Error ? e.message : e}`] };
  }
  const list = Array.isArray(raw) ? raw : (raw as { plugins?: unknown } | null)?.plugins;
  if (!Array.isArray(list)) return { entries: [], problems: ['The store index has no "plugins" list'] };
  const entries: StoreEntry[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  list.forEach((item, i) => {
    const o = (item ?? {}) as Record<string, unknown>;
    const v = validateManifest(o.manifest);
    if (!v.ok) return void problems.push(`Entry ${i + 1}: ${v.errors[0]}`);
    const m = v.manifest;
    if (typeof o.sha256 !== "string" || !SHA_RE.test(o.sha256))
      return void problems.push(`${m.id}: missing or malformed sha256`);
    if (typeof o.url !== "string" || !o.url) return void problems.push(`${m.id}: missing url`);
    let abs: string;
    try {
      abs = new URL(o.url, indexUrl).toString();
    } catch {
      return void problems.push(`${m.id}: bad url`);
    }
    if (seen.has(m.id)) return void problems.push(`${m.id}: listed twice`);
    seen.add(m.id);
    entries.push({ id: m.id, manifest: m, url: abs, sha256: o.sha256.toLowerCase() });
  });
  return { entries, problems };
}

/** Numeric x.y.z comparison; a missing/odd part counts as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export type StoreStatus = "new" | "installed" | "update";

export function storeStatus(entry: StoreEntry, installed: PluginManifest | null | undefined): StoreStatus {
  if (!installed) return "new";
  return compareVersions(installed.version, entry.manifest.version) < 0 ? "update" : "installed";
}
