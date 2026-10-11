/**
 * Action registry (D1).
 *
 * One list of named things the app can do, each with a JSON Schema for its
 * parameters. The registry is the single source of truth that the AI bridge
 * (Rust HTTP server -> MCP tools) exposes, and that D2 plugin actions register
 * into. It is purely additive: toolbar buttons and context menus keep calling
 * their handlers directly; a registration just *wraps* one of those handlers.
 *
 * To add an action (e.g. C1's playlist ops) it is one line in
 * `src/lib/appActions.ts`:
 *   reg.register({ id: "playlist.create", title: "...", params: {...}, run: (p) => ... });
 *
 * This file has no React and no Tauri imports so it is unit-testable.
 */

export interface JsonSchema {
  type?: "string" | "number" | "integer" | "boolean" | "array" | "object" | "null";
  description?: string;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  default?: unknown;
}

export interface ActionCtx {
  /** Who asked: the AI bridge, a script step, or the UI itself. */
  caller: "ai" | "script" | "ui";
  /** Logs a line to the Logs page (and a toast unless silent). */
  notify: (message: string, kind?: "success" | "error" | "info", opts?: { silent?: boolean; details?: unknown }) => void;
  /**
   * Asks the person before a dangerous action runs. Absent = nobody to ask,
   * which counts as a refusal for non-UI callers.
   */
  confirmDangerous?: (action: ActionInfo, params: unknown) => Promise<boolean>;
}

export interface ActionDef<P = any> {
  /** Dotted id, `area.verb` (e.g. `tags.standardize`). Also the MCP tool name (dots become underscores there). */
  id: string;
  title: string;
  /** What it does and what to expect (preview needs a follow-up apply, etc.). */
  description?: string;
  /** JSON Schema of the params object. `{type:"object", properties:{}}` for none. */
  params: JsonSchema;
  run: (params: P, ctx: ActionCtx) => unknown | Promise<unknown>;
  /** Deletes, moves, or otherwise hard-to-undo: needs an in-app confirm for AI callers. */
  dangerous?: boolean;
  /** The wrapped handler already shows its own confirm dialog; don't ask twice. */
  confirmsItself?: boolean;
  /** Changes nothing (queries). Marked so clients can treat it as safe. */
  readOnly?: boolean;
}

/** The serialisable part of a definition, what `GET /actions` returns. */
export interface ActionInfo {
  id: string;
  title: string;
  description: string;
  params: JsonSchema;
  dangerous: boolean;
  readOnly: boolean;
}

export const NO_PARAMS: JsonSchema = { type: "object", properties: {}, additionalProperties: false };

/** Returns a list of human-readable problems; empty = valid. */
export function validateAgainstSchema(value: unknown, schema: JsonSchema, path = "params"): string[] {
  const errors: string[] = [];
  const t = schema.type;
  if (schema.enum && !schema.enum.some((e) => e === value)) {
    errors.push(`${path} must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`);
    return errors;
  }
  if (t === "null") {
    if (value !== null) errors.push(`${path} must be null`);
  } else if (t === "string") {
    if (typeof value !== "string") return [`${path} must be a string`];
    if (schema.minLength !== undefined && value.length < schema.minLength)
      errors.push(`${path} must be at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      errors.push(`${path} must be at most ${schema.maxLength} characters`);
  } else if (t === "number" || t === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) return [`${path} must be a number`];
    if (t === "integer" && !Number.isInteger(value)) errors.push(`${path} must be an integer`);
    if (schema.minimum !== undefined && value < schema.minimum)
      errors.push(`${path} must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum)
      errors.push(`${path} must be <= ${schema.maximum}`);
  } else if (t === "boolean") {
    if (typeof value !== "boolean") errors.push(`${path} must be true or false`);
  } else if (t === "array") {
    if (!Array.isArray(value)) return [`${path} must be an array`];
    if (schema.minItems !== undefined && value.length < schema.minItems)
      errors.push(`${path} needs at least ${schema.minItems} item(s)`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      errors.push(`${path} allows at most ${schema.maxItems} item(s)`);
    if (schema.items) {
      value.forEach((v, i) => errors.push(...validateAgainstSchema(v, schema.items!, `${path}[${i}]`)));
    }
  } else if (t === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return [`${path} must be an object`];
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (obj[key] === undefined) errors.push(`${path}.${key} is required`);
    }
    const props = schema.properties ?? {};
    for (const [key, v] of Object.entries(obj)) {
      if (v === undefined) continue;
      const sub = props[key];
      if (sub) errors.push(...validateAgainstSchema(v, sub, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key} is not a known parameter`);
    }
  }
  return errors;
}

export class ActionError extends Error {
  constructor(
    message: string,
    readonly code: "unknown_action" | "invalid_params" | "denied" | "failed",
  ) {
    super(message);
  }
}

export interface ScriptStep {
  action: string;
  params?: unknown;
  /** Keep going if this step fails (default: stop the script). */
  continueOnError?: boolean;
}

export interface ScriptStepResult {
  index: number;
  action: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface ScriptPlanStep {
  index: number;
  action: string;
  title: string;
  dangerous: boolean;
  valid: boolean;
  errors: string[];
}

const MAX_SCRIPT_STEPS = 50;

export class ActionRegistry {
  private defs = new Map<string, ActionDef>();
  /** Pause after each step so React commits state a following step reads (see `settle`). */
  settle: () => Promise<void> = async () => {};

  /** Registers (or replaces) an action. Returns a function that removes it again. */
  register<P = any>(def: ActionDef<P>): () => void {
    if (!/^[a-z][A-Za-z0-9]*(\.[a-zA-Z][A-Za-z0-9]*)+$/.test(def.id)) {
      throw new Error(`Bad action id "${def.id}" (use area.verb)`);
    }
    this.defs.set(def.id, def as ActionDef);
    return () => {
      if (this.defs.get(def.id) === (def as ActionDef)) this.defs.delete(def.id);
    };
  }

  has(id: string): boolean {
    return this.defs.has(id);
  }

  info(id: string): ActionInfo | undefined {
    const d = this.defs.get(id);
    return d && toInfo(d);
  }

  list(): ActionInfo[] {
    return [...this.defs.values()].map(toInfo).sort((a, b) => a.id.localeCompare(b.id));
  }

  validate(id: string, params: unknown): string[] {
    const d = this.defs.get(id);
    if (!d) return [`Unknown action "${id}"`];
    return validateAgainstSchema(params ?? {}, d.params);
  }

  /** Validates, asks for confirmation if dangerous, then runs one action. */
  async run(id: string, params: unknown, ctx: ActionCtx): Promise<unknown> {
    const d = this.defs.get(id);
    if (!d) throw new ActionError(`Unknown action "${id}"`, "unknown_action");
    const p = params ?? {};
    const problems = validateAgainstSchema(p, d.params);
    if (problems.length) throw new ActionError(problems.join("; "), "invalid_params");
    if (d.dangerous && !d.confirmsItself && ctx.caller !== "ui") {
      const ok = ctx.confirmDangerous ? await ctx.confirmDangerous(toInfo(d), p) : false;
      if (!ok) throw new ActionError(`"${id}" was not approved in the app`, "denied");
    }
    try {
      return await d.run(p, ctx);
    } catch (e) {
      if (e instanceof ActionError) throw e;
      throw new ActionError(e instanceof Error ? e.message : String(e), "failed");
    }
  }

  /** What a script would do, without running anything. */
  plan(steps: ScriptStep[]): ScriptPlanStep[] {
    return steps.map((s, index) => {
      const info = this.info(s.action);
      const errors = this.validate(s.action, s.params);
      if (s.action === "script.run") errors.push("scripts cannot nest script.run");
      return {
        index,
        action: s.action,
        title: info?.title ?? "(unknown action)",
        dangerous: info?.dangerous ?? false,
        valid: errors.length === 0,
        errors,
      };
    });
  }

  /**
   * Runs steps in order. `dryRun` returns the plan and touches nothing. A
   * script is validated up front, so a typo in step 9 is reported before step
   * 1 has changed anything.
   */
  async runScript(
    steps: ScriptStep[],
    opts: { dryRun?: boolean },
    ctx: ActionCtx,
  ): Promise<{ dryRun: boolean; plan: ScriptPlanStep[]; results: ScriptStepResult[]; ok: boolean }> {
    if (steps.length > MAX_SCRIPT_STEPS) {
      throw new ActionError(`A script can have at most ${MAX_SCRIPT_STEPS} steps`, "invalid_params");
    }
    const plan = this.plan(steps);
    const results: ScriptStepResult[] = [];
    if (opts.dryRun) return { dryRun: true, plan, results, ok: plan.every((p) => p.valid) };
    const bad = plan.filter((p) => !p.valid);
    if (bad.length) {
      throw new ActionError(
        `Script not run. ${bad.map((b) => `step ${b.index} (${b.action}): ${b.errors.join(", ")}`).join("; ")}`,
        "invalid_params",
      );
    }
    let ok = true;
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      try {
        const result = await this.run(s.action, s.params, { ...ctx, caller: ctx.caller === "ui" ? "ui" : "script" });
        results.push({ index: i, action: s.action, ok: true, result });
        await this.settle();
      } catch (e) {
        ok = false;
        results.push({ index: i, action: s.action, ok: false, error: e instanceof Error ? e.message : String(e) });
        if (!s.continueOnError) break;
      }
    }
    return { dryRun: false, plan, results, ok };
  }
}

function toInfo(d: ActionDef): ActionInfo {
  return {
    id: d.id,
    title: d.title,
    description: d.description ?? d.title,
    params: d.params,
    dangerous: !!d.dangerous,
    readOnly: !!d.readOnly,
  };
}

/** Caps a result so one huge query can't wedge the bridge. */
export function clampResult(value: unknown, maxChars = 400_000): unknown {
  let text: string;
  try {
    text = JSON.stringify(value ?? null);
  } catch {
    return { error: "result was not serialisable" };
  }
  if (text.length <= maxChars) return value ?? null;
  return { truncated: true, note: `result was ${text.length} characters; narrow the query`, preview: text.slice(0, 2000) };
}

/** The app-wide registry. Plugin (D2) code registers into this too. */
export const actionRegistry = new ActionRegistry();
