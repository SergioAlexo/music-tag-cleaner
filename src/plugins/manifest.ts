/**
 * Plugin manifest format and validation (D2).
 *
 * A plugin is a folder `<appData>/plugins/<id>/` with `manifest.json` and an
 * optional entry script. Everything in a manifest is untrusted input (store
 * package, hand-copied folder, or an AI via `plugins.create`), so validation is
 * strict and returns every problem at once instead of throwing on the first.
 *
 * No React / Tauri imports: unit-tested.
 */
import type { JsonSchema } from "../lib/actions";

export const PLUGIN_API_VERSION = 1;

export type PluginKind = "plugin" | "theme";

export interface ButtonSpec {
  id: string;
  label: string;
  title?: string;
  /** Local action id of this plugin, or a registry action id (e.g. `table.setColumns`). */
  action?: string;
  /** Fixed params for `action`. */
  params?: Record<string, unknown>;
  /** Key under which the selected tracks' paths are added to the params (menu items). */
  pathsParam?: string;
}

export interface ColumnSpec {
  id: string;
  label: string;
  width?: number;
}

export interface ActionSpec {
  id: string;
  title: string;
  description?: string;
  params?: JsonSchema;
  dangerous?: boolean;
}

export interface SettingSpec {
  key: string;
  label: string;
  type: "boolean" | "string" | "number";
  default: boolean | string | number;
}

export const THEME_TOKENS = [
  "background", "foreground", "card", "card-foreground", "popover", "popover-foreground",
  "primary", "primary-foreground", "secondary", "secondary-foreground", "muted",
  "muted-foreground", "accent", "accent-foreground", "destructive", "destructive-foreground",
  "border", "input", "ring", "violet",
] as const;
export type ThemeToken = (typeof THEME_TOKENS)[number];

export interface ThemeSpec {
  /** "auto" (default) follows the OS light/dark; a theme that only makes sense in one sets it. */
  mode?: "auto" | "light" | "dark";
  light?: Partial<Record<ThemeToken, string>>;
  dark?: Partial<Record<ThemeToken, string>>;
  /** CSS length for `--radius-lg`. */
  radius?: string;
  /** CSS font-family list for the app body. */
  font?: string;
  /** Preview swatches shown in the picker (any 3-4 CSS colors); defaults are derived. */
  swatch?: string[];
}

export interface Contributes {
  buttons?: ButtonSpec[];
  contextMenu?: ButtonSpec[];
  columns?: ColumnSpec[];
  actions?: ActionSpec[];
  settings?: SettingSpec[];
  theme?: ThemeSpec;
}

/** A host-managed binary the plugin needs (installed by the app from its own allowlisted index). */
export interface EngineRequirement {
  id: string;
  /** Version range such as `>=0.1` or `0.1.2`; informational for the review prompt. */
  version: string;
}

export interface PluginRequires {
  engines?: EngineRequirement[];
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  apiVersion: number;
  kind: PluginKind;
  permissions: string[];
  entry?: string;
  /** Optional host-provided dependencies (plugin API v1 stays 1: absent = none). */
  requires?: PluginRequires;
  contributes: Contributes;
}

/** What each fixed permission lets a plugin do, shown on the review prompt. */
export const PERMISSION_INFO: Record<string, { label: string; risk: "low" | "medium" | "high" }> = {
  read: { label: "Read your session, library and settings", risk: "low" },
  "ui.control": { label: "Change the view: select tracks, show/hide columns, open pages", risk: "low" },
  "tags.write": { label: "Edit tags, apply/undo changes, build tag previews", risk: "medium" },
  "artwork.write": { label: "Change or remove cover art", risk: "medium" },
  backup: { label: "Create tag backups", risk: "low" },
  "files.move": { label: "Rename, move and convert files", risk: "high" },
  "files.delete": { label: "Delete files (still asks you each time)", risk: "high" },
  presets: { label: "Read synth presets and write converted presets to your output folder", risk: "medium" },
};

export const FIXED_PERMISSIONS = Object.keys(PERMISSION_INFO);

const ID_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const LOCAL_ID_RE = /^[a-zA-Z][A-Za-z0-9]{0,39}$/;
const HOST_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?$/;
const ACTION_ID_RE = /^[a-z][A-Za-z0-9]*(\.[a-zA-Z][A-Za-z0-9]*)+$/;
const ENTRY_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*\.js$/;
const ENGINE_VERSION_RE = /^(>=|<=|>|<|=|\^|~)?\d+(\.\d+){0,2}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/;

export function isPermissionValid(p: string): boolean {
  if (FIXED_PERMISSIONS.includes(p)) return true;
  if (p.startsWith("network:")) return HOST_RE.test(p.slice(8));
  if (p.startsWith("action:")) return ACTION_ID_RE.test(p.slice(7));
  return false;
}

const THEME_VALUE_RE =
  /^(#[0-9a-fA-F]{3,8}|(hsl|rgb)a?\([0-9.,%\s/deg]+\)|[0-9.]+\s+[0-9.]+%\s+[0-9.]+%)$/;

/** Normalises a token value to a CSS colour, or null if it isn't one we accept. */
export function themeColor(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!THEME_VALUE_RE.test(s) || s.length > 60) return null;
  // shadcn's bare "H S% L%" triple becomes a real hsl().
  return /^[0-9.]+\s+[0-9.]+%\s+[0-9.]+%$/.test(s) ? `hsl(${s})` : s;
}

const RADIUS_RE = /^\d+(\.\d+)?(rem|px)$/;
const FONT_RE = /^[A-Za-z0-9 ,'"._-]{1,200}$/;

export type ValidationResult =
  | { ok: true; manifest: PluginManifest; warnings: string[] }
  | { ok: false; errors: string[] };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function checkButtons(list: unknown, where: string, errors: string[], localActions: Set<string>) {
  if (list === undefined) return;
  if (!Array.isArray(list)) return void errors.push(`${where} must be an array`);
  if (list.length > 20) errors.push(`${where} allows at most 20 entries`);
  const seen = new Set<string>();
  list.forEach((b, i) => {
    const w = `${where}[${i}]`;
    if (!isObj(b)) return void errors.push(`${w} must be an object`);
    if (typeof b.id !== "string" || !LOCAL_ID_RE.test(b.id)) errors.push(`${w}.id must be letters/digits (max 40)`);
    else if (seen.has(b.id)) errors.push(`${w}.id "${b.id}" is duplicated`);
    else seen.add(b.id);
    if (typeof b.label !== "string" || !b.label.trim() || b.label.length > 40)
      errors.push(`${w}.label is required (max 40 characters)`);
    if (b.title !== undefined && (typeof b.title !== "string" || b.title.length > 200))
      errors.push(`${w}.title must be a string up to 200 characters`);
    if (b.action !== undefined) {
      if (typeof b.action !== "string") errors.push(`${w}.action must be a string`);
      else if (!b.action.includes(".") && !localActions.has(b.action))
        errors.push(`${w}.action "${b.action}" is not declared in contributes.actions`);
      else if (b.action.includes(".") && !ACTION_ID_RE.test(b.action)) errors.push(`${w}.action is not a valid action id`);
    }
    if (b.params !== undefined && !isObj(b.params)) errors.push(`${w}.params must be an object`);
    if (b.pathsParam !== undefined && (typeof b.pathsParam !== "string" || !/^[a-zA-Z]\w*$/.test(b.pathsParam)))
      errors.push(`${w}.pathsParam must be a parameter name`);
  });
}

function checkTheme(t: unknown, errors: string[]) {
  if (!isObj(t)) return void errors.push("contributes.theme must be an object");
  if (t.mode !== undefined && !["auto", "light", "dark"].includes(t.mode as string))
    errors.push('theme.mode must be "auto", "light" or "dark"');
  for (const variant of ["light", "dark"] as const) {
    const m = t[variant];
    if (m === undefined) continue;
    if (!isObj(m)) {
      errors.push(`theme.${variant} must be an object of tokens`);
      continue;
    }
    for (const [k, v] of Object.entries(m)) {
      if (!(THEME_TOKENS as readonly string[]).includes(k)) errors.push(`theme.${variant}.${k} is not a known token`);
      else if (themeColor(v) === null) errors.push(`theme.${variant}.${k} is not a colour (use #hex, hsl() or rgb())`);
    }
  }
  if (!t.light && !t.dark) errors.push("a theme needs a light and/or dark token map");
  if (t.radius !== undefined && !(typeof t.radius === "string" && RADIUS_RE.test(t.radius)))
    errors.push('theme.radius must look like "0.5rem"');
  if (t.font !== undefined && !(typeof t.font === "string" && FONT_RE.test(t.font)))
    errors.push("theme.font has characters that are not allowed in a font list");
  if (t.swatch !== undefined) {
    if (!Array.isArray(t.swatch) || t.swatch.length > 5 || t.swatch.some((c) => themeColor(c) === null))
      errors.push("theme.swatch must be up to 5 colours");
  }
}

/** Validates unknown JSON as a manifest. */
export function validateManifest(raw: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isObj(raw)) return { ok: false, errors: ["manifest must be a JSON object"] };

  const id = raw.id;
  if (typeof id !== "string" || !ID_RE.test(id) || id.length < 2 || id.length > 40)
    errors.push("id must be 2-40 lowercase letters, digits and hyphens, starting with a letter");
  for (const key of ["name", "author", "description"] as const) {
    const v = raw[key];
    if (typeof v !== "string" || !v.trim()) errors.push(`${key} is required`);
    else if (v.length > (key === "description" ? 400 : 80)) errors.push(`${key} is too long`);
  }
  if (typeof raw.version !== "string" || !SEMVER_RE.test(raw.version)) errors.push("version must look like 1.0.0");
  if (raw.apiVersion !== PLUGIN_API_VERSION)
    errors.push(`apiVersion must be ${PLUGIN_API_VERSION} (this app speaks plugin API ${PLUGIN_API_VERSION})`);
  const kind = raw.kind ?? "plugin";
  if (kind !== "plugin" && kind !== "theme") errors.push('kind must be "plugin" or "theme"');

  const perms = raw.permissions ?? [];
  if (!Array.isArray(perms) || perms.some((p) => typeof p !== "string")) {
    errors.push("permissions must be an array of strings");
  } else {
    for (const p of perms as string[]) if (!isPermissionValid(p)) errors.push(`unknown permission "${p}"`);
    if (new Set(perms).size !== perms.length) errors.push("permissions has duplicates");
  }

  const entry = raw.entry;
  if (entry !== undefined && (typeof entry !== "string" || !ENTRY_RE.test(entry) || entry.includes("..")))
    errors.push("entry must be a plain file name ending in .js");

  let requires: PluginRequires | undefined;
  if (raw.requires !== undefined) {
    const r = raw.requires;
    if (!isObj(r)) errors.push("requires must be an object");
    else {
      for (const k of Object.keys(r)) if (k !== "engines") warnings.push(`requires.${k} is ignored`);
      if (r.engines !== undefined) {
        if (!Array.isArray(r.engines)) errors.push("requires.engines must be an array");
        else {
          if (r.engines.length > 5) errors.push("requires.engines allows at most 5 entries");
          const seen = new Set<string>();
          r.engines.forEach((e, i) => {
            const w = `requires.engines[${i}]`;
            if (!isObj(e)) return void errors.push(`${w} must be an object`);
            if (typeof e.id !== "string" || !ID_RE.test(e.id) || e.id.length < 2 || e.id.length > 40)
              errors.push(`${w}.id must be 2-40 lowercase letters, digits and hyphens`);
            else if (seen.has(e.id)) errors.push(`${w}.id "${e.id}" is duplicated`);
            else seen.add(e.id);
            if (typeof e.version !== "string" || !ENGINE_VERSION_RE.test(e.version))
              errors.push(`${w}.version must look like ">=0.1"`);
          });
          if (!errors.some((x) => x.startsWith("requires.")))
            requires = { engines: (r.engines as EngineRequirement[]).map((e) => ({ id: e.id, version: e.version })) };
        }
      }
    }
  }

  const c = raw.contributes ?? {};
  if (!isObj(c)) {
    errors.push("contributes must be an object");
  } else {
    const known = ["buttons", "contextMenu", "columns", "actions", "settings", "theme"];
    for (const k of Object.keys(c)) if (!known.includes(k)) warnings.push(`contributes.${k} is ignored`);

    const localActions = new Set<string>();
    if (c.actions !== undefined) {
      if (!Array.isArray(c.actions)) errors.push("contributes.actions must be an array");
      else {
        if (c.actions.length > 30) errors.push("contributes.actions allows at most 30 entries");
        c.actions.forEach((a, i) => {
          const w = `contributes.actions[${i}]`;
          if (!isObj(a)) return void errors.push(`${w} must be an object`);
          if (typeof a.id !== "string" || !LOCAL_ID_RE.test(a.id)) errors.push(`${w}.id must be letters/digits (max 40)`);
          else if (localActions.has(a.id)) errors.push(`${w}.id "${a.id}" is duplicated`);
          else localActions.add(a.id);
          if (typeof a.title !== "string" || !a.title.trim() || a.title.length > 80) errors.push(`${w}.title is required`);
          if (a.params !== undefined && !isObj(a.params)) errors.push(`${w}.params must be a JSON Schema object`);
          if (a.dangerous !== undefined && typeof a.dangerous !== "boolean") errors.push(`${w}.dangerous must be true/false`);
        });
      }
    }
    checkButtons(c.buttons, "contributes.buttons", errors, localActions);
    checkButtons(c.contextMenu, "contributes.contextMenu", errors, localActions);
    if (c.columns !== undefined) {
      if (!Array.isArray(c.columns)) errors.push("contributes.columns must be an array");
      else
        c.columns.forEach((col, i) => {
          const w = `contributes.columns[${i}]`;
          if (!isObj(col)) return void errors.push(`${w} must be an object`);
          if (typeof col.id !== "string" || !LOCAL_ID_RE.test(col.id)) errors.push(`${w}.id must be letters/digits`);
          if (typeof col.label !== "string" || !col.label.trim() || col.label.length > 30) errors.push(`${w}.label is required`);
          if (col.width !== undefined && !(typeof col.width === "number" && col.width >= 40 && col.width <= 600))
            errors.push(`${w}.width must be 40-600`);
        });
      if ((c.columns as unknown[]).length > 0 && !(perms as string[]).includes("read"))
        errors.push('contributes.columns needs the "read" permission (columns are computed from tags)');
    }
    if (c.settings !== undefined) {
      if (!Array.isArray(c.settings)) errors.push("contributes.settings must be an array");
      else
        c.settings.forEach((s, i) => {
          const w = `contributes.settings[${i}]`;
          if (!isObj(s)) return void errors.push(`${w} must be an object`);
          if (typeof s.key !== "string" || !LOCAL_ID_RE.test(s.key)) errors.push(`${w}.key must be letters/digits`);
          if (typeof s.label !== "string" || !s.label.trim()) errors.push(`${w}.label is required`);
          if (!["boolean", "string", "number"].includes(s.type as string)) errors.push(`${w}.type must be boolean, string or number`);
          else if (typeof s.default !== s.type) errors.push(`${w}.default must be a ${s.type}`);
        });
    }
    if (kind === "theme") {
      if (c.theme === undefined) errors.push("a theme needs contributes.theme");
      else checkTheme(c.theme, errors);
      if (entry !== undefined) errors.push("a theme has no code: remove entry");
      if ((perms as unknown[]).length) errors.push("a theme cannot ask for permissions");
      for (const k of ["buttons", "contextMenu", "columns", "actions"])
        if (c[k] !== undefined) errors.push(`a theme cannot contribute ${k}`);
    } else if (c.theme !== undefined) {
      errors.push('contributes.theme is only for kind "theme"');
    }
    const usesCode = (c.actions as unknown[] | undefined)?.length || (c.columns as unknown[] | undefined)?.length;
    if (kind === "plugin" && usesCode && !entry)
      errors.push("contributes.actions / columns need code: set entry to your script");
  }

  if (errors.length) return { ok: false, errors };
  const m = raw as unknown as PluginManifest;
  return {
    ok: true,
    warnings,
    manifest: {
      id: m.id,
      name: m.name,
      version: m.version,
      author: m.author,
      description: m.description,
      apiVersion: m.apiVersion,
      kind: kind as PluginKind,
      permissions: [...((perms as string[]) ?? [])],
      entry: m.entry,
      ...(requires ? { requires } : {}),
      contributes: (c as Contributes) ?? {},
    },
  };
}

/** Parses manifest text; JSON errors become a validation error. */
export function parseManifest(text: string): ValidationResult {
  try {
    return validateManifest(JSON.parse(text));
  } catch (e) {
    return { ok: false, errors: [`manifest.json is not valid JSON: ${e instanceof Error ? e.message : e}`] };
  }
}

/** `hide-genre` -> `hideGenre`: the plugin's segment of its registry action ids. */
export function actionSegment(pluginId: string): string {
  return pluginId.replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

/** Registry id of a plugin's own action. */
export function pluginActionId(pluginId: string, localId: string): string {
  return `plugin.${actionSegment(pluginId)}.${localId}`;
}

/** SHA-256 hex of text (WebCrypto: available in the webview and in Node tests). */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** What the person approves: any change to the manifest or code changes this. */
export async function contentHash(manifestText: string, code: string | null | undefined): Promise<string> {
  return sha256Hex(`${manifestText}\u0000${code ?? ""}`);
}
