/**
 * Library toolbar layout: which feature buttons show, in what order, and the
 * owner's custom "sequence" features (one button that runs several features
 * one after another).
 *
 * Undo / Redo / History / Compare stay fixed at the left — they are session
 * controls, not features, and hiding Undo would be a trap.
 *
 * Custom features run through the action registry (`appActions.ts`), the same
 * path the AI bridge uses, so a sequence step behaves exactly like clicking
 * the button. Steps that only build a *preview* (capitalization, characters,
 * AI Clean...) are applied before the next step runs — otherwise step 2 would
 * read the old tags from disk and its preview would silently undo step 1.
 */
import type { ActionCtx, ActionRegistry } from "./actions";
import type { Capitalization, Settings, TagData } from "../types";
import { AI_CLEAN_FIELDS, CAP_OPTIONS, CLEARABLE_FIELDS, FIELD_LABELS, KEPT_FIELD_KEYS } from "../types";

/** Every built-in toolbar item, in the default order. `sep*` are dividers. */
export const BUILTIN_TOOLBAR_ITEMS = [
  { id: "backup", label: "Backup" },
  { id: "restore", label: "Restore" },
  { id: "backupArchive", label: "Backup Archive" },
  { id: "sep1", label: "Divider" },
  { id: "aiClean", label: "AI Clean" },
  { id: "sep2", label: "Divider" },
  { id: "capitalization", label: "Capitalization" },
  { id: "characters", label: "Characters" },
  { id: "removeChars", label: "Remove characters" },
  { id: "clearFields", label: "Clear Fields" },
  { id: "sep3", label: "Divider" },
  { id: "generateIds", label: "Generate IDs" },
  { id: "unifyIds", label: "Unify IDs" },
  { id: "rekordboxToTags", label: "Rekordbox → tags" },
  { id: "convert", label: "Convert" },
  { id: "stems", label: "Stems" },
  { id: "standardizeArt", label: "Standardize Art" },
  { id: "squareArt", label: "Square Art" },
  { id: "findArt", label: "Find Art" },
  { id: "junkArt", label: "Junk Art" },
  { id: "standardizeContainers", label: "Standardize Tag Format" },
  { id: "rename", label: "Rename to Standard" },
] as const;

export type BuiltinToolbarId = (typeof BUILTIN_TOOLBAR_ITEMS)[number]["id"];
export const DEFAULT_TOOLBAR_ORDER: string[] = BUILTIN_TOOLBAR_ITEMS.map((i) => i.id);
export const CUSTOM_PREFIX = "custom:";

/**
 * One step of a custom feature. Options left out fall back to Settings (the
 * same values the toolbar button itself uses).
 */
export interface SequenceStep {
  kind: string;
  /** Capitalization: the mode for this step. */
  capitalization?: Capitalization;
  /** Clear Fields: clear the listed fields, or keep them and clear every other one. */
  clearMode?: "clear" | "keep";
  /** Clear Fields: curated keys and `raw:KEY` frames. AI Clean: the fields to look up. */
  fields?: string[];
}

export interface CustomFeature {
  id: string;
  name: string;
  /** Run in this order. */
  steps: SequenceStep[];
  /** Stop at each preview so the owner can review it; otherwise previews are applied automatically. */
  review: boolean;
}

export const isDivider = (id: string) => /^sep\d+$/.test(id);

export const RAW_PREFIX = "raw:";

/** What a step build needs besides its own options. */
export interface StepEnv {
  settings: Settings;
  /** Tags of the tracks the step runs on (for "keep these, clear the rest"). */
  tags: Record<string, TagData | undefined>;
}

/**
 * Fields "keep these, clear the rest" clears: every clearable curated field
 * and every raw frame present on the tracks, minus the ones to keep. Title,
 * Artist, BPM, Key and Rating are never clearable, so they always stay.
 */
export function fieldsToClearKeeping(keep: string[], paths: string[], tags: StepEnv["tags"]): string[] {
  const kept = new Set(keep);
  const out: string[] = CLEARABLE_FIELDS.filter((f) => !kept.has(f));
  const raw = new Set<string>();
  for (const p of paths) {
    for (const [k, v] of Object.entries(tags[p]?.allFields ?? {})) {
      if (v && !KEPT_FIELD_KEYS.has(k)) raw.add(RAW_PREFIX + k);
    }
  }
  for (const r of [...raw].sort()) if (!kept.has(r)) out.push(r);
  return out;
}

/**
 * Features that can be a step of a sequence. Ones that only open a dialog
 * (Convert, Stems, Find Art, Junk Art, Unify IDs, Backup Archive) are left
 * out: the sequence would race on while the dialog is still open.
 */
export interface SequenceStepDef {
  label: string;
  /** Builds the registry call, or null to skip (e.g. capitalization set to "Leave as is"). */
  build: (paths: string[], step: SequenceStep, env: StepEnv) => { action: string; params: Record<string, unknown> } | null;
  /** The action only builds a preview that still has to be applied. */
  preview: boolean;
  /** Which per-step options the editor shows. */
  options?: "capitalization" | "clearFields" | "aiClean";
}

export const SEQUENCE_STEPS: Record<string, SequenceStepDef> = {
  backup: { label: "Backup", preview: false, build: (paths) => ({ action: "backup.tags", params: { paths } }) },
  aiClean: {
    label: "AI Clean",
    preview: true,
    options: "aiClean",
    build: (paths, step) => {
      const fields = step.fields?.filter((f) => (AI_CLEAN_FIELDS as readonly string[]).includes(f));
      return { action: "tags.aiClean", params: fields?.length ? { paths, fields } : { paths } };
    },
  },
  capitalization: {
    label: "Capitalization",
    preview: true,
    options: "capitalization",
    build: (paths, step, { settings }) => {
      const mode = step.capitalization ?? settings.capitalization;
      return mode === "asis"
        ? null
        : { action: "tags.standardize", params: { paths, scope: "capitalization", capitalization: mode } };
    },
  },
  characters: {
    label: "Characters",
    preview: true,
    build: (paths) => ({ action: "tags.standardize", params: { paths, scope: "characters" } }),
  },
  removeChars: {
    label: "Remove characters",
    preview: true,
    build: (paths, _step, { settings }) =>
      settings.removeChars ? { action: "tags.standardize", params: { paths, scope: "removeChars" } } : null,
  },
  clearFields: {
    label: "Clear Fields",
    preview: true,
    options: "clearFields",
    build: (paths, step, { settings, tags }) => {
      const fields =
        step.clearMode === "keep"
          ? fieldsToClearKeeping(step.fields ?? [], paths, tags)
          : step.fields?.length
            ? step.fields
            : settings.clearFields;
      return fields.length ? { action: "tags.clearFields", params: { paths, fields } } : null;
    },
  },
  generateIds: { label: "Generate IDs", preview: false, build: (paths) => ({ action: "tags.generateIds", params: { paths } }) },
  rekordboxToTags: {
    label: "Rekordbox → tags",
    preview: true,
    build: (paths, _step, { settings }) =>
      settings.rekordboxXmlPath ? { action: "tags.rekordboxToTags", params: { paths } } : null,
  },
  standardizeArt: { label: "Standardize Art", preview: false, build: (paths) => ({ action: "artwork.standardize", params: { paths } }) },
  squareArt: { label: "Square Art", preview: false, build: (paths) => ({ action: "artwork.square", params: { paths } }) },
  standardizeContainers: {
    label: "Standardize Tag Format",
    preview: false,
    build: (paths) => ({ action: "files.standardizeContainers", params: { paths } }),
  },
  rename: { label: "Rename to Standard", preview: false, build: (paths) => ({ action: "files.renameToStandard", params: { paths } }) },
};

/** A field key as shown to people: "Comment", or a raw frame's own name. */
export function fieldName(f: string): string {
  return f.startsWith(RAW_PREFIX) ? f.slice(RAW_PREFIX.length) : (FIELD_LABELS[f] ?? f);
}

/** "Clear Fields (keep Title, Comment)": a step's label with its options. */
export function describeStep(step: SequenceStep): string {
  const def = SEQUENCE_STEPS[step.kind];
  const label = def?.label ?? step.kind;
  const names = (fs: string[]) => fs.map(fieldName).join(", ");
  if (def?.options === "capitalization" && step.capitalization) {
    return `${label} (${CAP_OPTIONS.find((o) => o.value === step.capitalization)?.label ?? step.capitalization})`;
  }
  if (def?.options === "clearFields") {
    if (step.clearMode === "keep") return `${label} (keep ${step.fields?.length ? names(step.fields) : "nothing"})`;
    if (step.fields?.length) return `${label} (${names(step.fields)})`;
  }
  if (def?.options === "aiClean" && step.fields?.length) return `${label} (${names(step.fields)})`;
  return label;
}

/** A saved step: a bare id (before step options existed) or a step object. */
function normalizeStep(raw: unknown): SequenceStep | null {
  const r = typeof raw === "string" ? { kind: raw } : (raw as Partial<SequenceStep> | null);
  if (!r || typeof r.kind !== "string" || !(r.kind in SEQUENCE_STEPS)) return null;
  const step: SequenceStep = { kind: r.kind };
  if (CAP_OPTIONS.some((o) => o.value === r.capitalization)) step.capitalization = r.capitalization;
  if (r.clearMode === "keep" || r.clearMode === "clear") step.clearMode = r.clearMode;
  if (Array.isArray(r.fields)) step.fields = r.fields.filter((f): f is string => typeof f === "string");
  return step;
}

export function labelFor(id: string, customs: CustomFeature[]): string {
  if (id.startsWith(CUSTOM_PREFIX)) {
    return customs.find((c) => CUSTOM_PREFIX + c.id === id)?.name ?? "(deleted feature)";
  }
  return BUILTIN_TOOLBAR_ITEMS.find((i) => i.id === id)?.label ?? id;
}

/**
 * Repairs a saved order: drops unknown / duplicate ids and deleted custom
 * features, and appends anything missing (a built-in added in a later version,
 * or a custom feature just created) at the end so it is never lost.
 */
export function normalizeToolbarOrder(order: unknown, customs: CustomFeature[]): string[] {
  const valid = new Set([...DEFAULT_TOOLBAR_ORDER, ...customs.map((c) => CUSTOM_PREFIX + c.id)]);
  const out: string[] = [];
  for (const id of Array.isArray(order) ? order : []) {
    if (typeof id === "string" && valid.has(id) && !out.includes(id)) out.push(id);
  }
  for (const id of valid) if (!out.includes(id)) out.push(id);
  return out;
}

export function normalizeCustomFeatures(raw: unknown): CustomFeature[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: CustomFeature[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const c = r as Partial<CustomFeature>;
    if (typeof c.id !== "string" || !c.id || seen.has(c.id)) continue;
    seen.add(c.id);
    out.push({
      id: c.id,
      name: typeof c.name === "string" && c.name.trim() ? c.name : "Custom feature",
      steps: Array.isArray(c.steps) ? c.steps.map(normalizeStep).filter((s): s is SequenceStep => s !== null) : [],
      review: !!c.review,
    });
  }
  return out;
}

/**
 * Items to render, dividers tidied: no divider at either end and never two in
 * a row (hiding everything between two dividers would otherwise leave "||").
 */
export function visibleToolbarItems(order: string[], hidden: string[]): string[] {
  const hide = new Set(hidden);
  const out: string[] = [];
  for (const id of order) {
    if (hide.has(id)) continue;
    if (isDivider(id) && (out.length === 0 || isDivider(out[out.length - 1]))) continue;
    out.push(id);
  }
  while (out.length && isDivider(out[out.length - 1])) out.pop();
  return out;
}

export interface RunSequenceOpts {
  reg: ActionRegistry;
  feature: CustomFeature;
  settings: Settings;
  /** Current selection; read again before each step (Rename changes the paths). */
  getSelection: () => string[];
  /** Newest tags of the session (for "keep these, clear the rest"). */
  getTags?: () => Record<string, TagData | undefined>;
  notify: ActionCtx["notify"];
  /** Poll interval while waiting for the owner to review a preview. */
  pollMs?: number;
  /** Lets the caller abort a run that is waiting on a review. */
  cancelled?: () => boolean;
}

type ChangesInfo = { mode: string | null; totalChanged?: number };

/** Runs a custom feature's steps in order. Resolves to the number of steps that ran. */
export async function runCustomFeature(o: RunSequenceOpts): Promise<number> {
  const { reg, feature, settings, notify } = o;
  const ctx: ActionCtx = { caller: "ui", notify };
  const changes = async () => (await reg.run("changes.get", { limit: 1 }, ctx)) as ChangesInfo;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  if ((await changes()).mode !== null) {
    notify(`"${feature.name}": apply or cancel the waiting preview first`, "info");
    return 0;
  }
  let ran = 0;
  for (let i = 0; i < feature.steps.length; i++) {
    if (o.cancelled?.()) {
      notify(`"${feature.name}" stopped after ${ran} step${ran === 1 ? "" : "s"}`, "info");
      return ran;
    }
    const step = feature.steps[i];
    const def = SEQUENCE_STEPS[step.kind];
    if (!def) continue;
    const paths = o.getSelection();
    if (!paths.length) {
      notify(`"${feature.name}" stopped before "${def.label}": no tracks selected`, "info");
      break;
    }
    const call = def.build(paths, step, { settings, tags: o.getTags?.() ?? {} });
    if (!call) {
      notify(`"${feature.name}": skipped "${def.label}" (nothing set up for it in Settings)`, "info", { silent: true });
      continue;
    }
    try {
      await reg.run(call.action, call.params, ctx);
      await reg.settle();
      ran++;
      if (!def.preview) continue;
      const c = await changes();
      if (c.mode === null) continue;
      if (!c.totalChanged) {
        await reg.run("changes.cancel", {}, ctx);
        await reg.settle();
        continue;
      }
      if (feature.review) {
        notify(
          `"${feature.name}" step ${i + 1}/${feature.steps.length} (${def.label}): review the preview, then Apply to continue (Cancel skips this step)`,
          "info",
        );
        while ((await changes()).mode !== null) {
          if (o.cancelled?.()) return ran;
          await wait(o.pollMs ?? 250);
        }
      } else {
        await reg.run("changes.apply", {}, ctx);
      }
      await reg.settle();
    } catch (e) {
      notify(`"${feature.name}" stopped at "${def.label}": ${e instanceof Error ? e.message : String(e)}`, "error");
      return ran;
    }
  }
  notify(`"${feature.name}" finished (${ran} step${ran === 1 ? "" : "s"})`, "success");
  return ran;
}
