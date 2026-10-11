/**
 * `plugins.*` registry actions (D2). Because they live in D1's registry they
 * are automatically MCP tools, so an AI can say "make me a button that ...".
 *
 * Safety rules baked in here:
 *  - `plugins.create` / `plugins.update` only STAGE a plugin. It runs after the
 *    person approves its permissions and code in the app. There is no action
 *    that approves; `plugins.enable` refuses anything unreviewed.
 *  - `plugins.remove` is `dangerous` (asks for confirmation like file deletes).
 *  - Plugin code can never call `plugins.*` (see permissions.ts).
 */
import type { ActionRegistry, JsonSchema } from "../lib/actions";
import { NO_PARAMS } from "../lib/actions";
import { AUTHORING_GUIDE } from "./guide";
import type { PluginManager } from "./manager";

const obj = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export interface PluginActionsEnv {
  manager: () => PluginManager;
  /** Brings the Plugins page forward so the person sees the review prompt. */
  showPlugins: () => void;
}

export function registerPluginActions(reg: ActionRegistry, env: PluginActionsEnv): void {
  const m = () => env.manager();

  reg.register({
    id: "plugins.docs",
    title: "How to write a plugin",
    description:
      "Returns the plugin authoring guide (manifest format, permissions, SDK, themes). Read this before plugins.create.",
    params: NO_PARAMS,
    readOnly: true,
    run: () => ({ guide: AUTHORING_GUIDE }),
  });

  reg.register({
    id: "plugins.list",
    title: "List plugins",
    description: "Installed plugins with status, and plugins waiting for the person's review.",
    params: NO_PARAMS,
    readOnly: true,
    run: () => ({
      installed: m().entries.map((e) => ({
        id: e.id,
        name: e.manifest?.name ?? e.id,
        version: e.manifest?.version,
        kind: e.manifest?.kind,
        status: e.status,
        permissions: e.manifest?.permissions ?? [],
        errors: e.errors,
        lastError: e.lastError || undefined,
      })),
      pendingReview: m().proposals.map((p) => ({
        id: p.id,
        name: p.manifest.name,
        version: p.manifest.version,
        source: p.source,
        permissions: p.manifest.permissions,
        replaces: p.previous?.version ?? null,
      })),
    }),
  });

  const stage = (mode: "create" | "update") => async (p: { manifest: Record<string, unknown>; code?: string }) => {
    const id = typeof p.manifest?.id === "string" ? p.manifest.id : "";
    const exists = !!m().entry(id);
    if (mode === "create" && exists)
      throw new Error(`A plugin "${id}" already exists. Use plugins.update to change it, or pick another id.`);
    if (mode === "update" && !exists) throw new Error(`No plugin "${id}" to update. Use plugins.create.`);
    const res = await m().propose(JSON.stringify(p.manifest, null, 2), p.code ?? null, "ai");
    if (res.status === "invalid") throw new Error(`The plugin is not valid:\n- ${res.errors.join("\n- ")}`);
    env.showPlugins();
    return res;
  };
  const codeSchema: JsonSchema = {
    type: "string",
    maxLength: 200_000,
    description: "Contents of the entry script. Omit for a declarative plugin (no code).",
  };
  const manifestSchema: JsonSchema = {
    type: "object",
    description: "The manifest.json object. See plugins.docs.",
  };

  reg.register({
    id: "plugins.create",
    title: "Create a plugin (needs the person's approval)",
    description:
      "Stages a new plugin (toolbar button, menu item, column, action or theme). It does NOT run until the person reviews its permissions and code in the app and approves. Call plugins.docs first.",
    params: obj({ manifest: manifestSchema, code: codeSchema }, ["manifest"]),
    run: stage("create"),
  });

  reg.register({
    id: "plugins.update",
    title: "Update a plugin (needs the person's approval)",
    description:
      "Stages a new version of an installed plugin. The installed version is disabled until the person approves the change.",
    params: obj({ manifest: manifestSchema, code: codeSchema }, ["manifest"]),
    run: stage("update"),
  });

  const id = obj({ id: { type: "string", description: "Plugin id" } }, ["id"]);
  reg.register({
    id: "plugins.enable",
    title: "Enable a plugin",
    description: "Turns on an installed plugin the person has already approved. Unreviewed plugins are refused.",
    params: id,
    run: async (p: { id: string }) => {
      await m().enable(p.id);
      return { id: p.id, enabled: true };
    },
  });
  reg.register({
    id: "plugins.disable",
    title: "Disable a plugin",
    params: id,
    run: async (p: { id: string }) => {
      await m().disable(p.id);
      return { id: p.id, enabled: false };
    },
  });
  reg.register({
    id: "plugins.remove",
    title: "Remove a plugin",
    description: "Uninstalls a plugin and deletes its folder and stored data.",
    params: id,
    dangerous: true,
    run: async (p: { id: string }) => {
      if (!m().entry(p.id)) throw new Error(`No plugin "${p.id}"`);
      await m().remove(p.id);
      return { id: p.id, removed: true };
    },
  });
}
