/**
 * Host side of one running plugin (D2): owns its sandbox, answers its RPC
 * calls through the action registry with the plugin's permissions enforced,
 * and exposes what it contributes (buttons, menu items, columns).
 *
 * Everything the plugin sends is untrusted. Nothing here touches React, Tauri
 * or the DOM: the sandbox, storage, network and confirm dialogs are injected
 * (`HostEnv`, `SandboxFactory`) so the whole thing is unit-tested with a fake
 * sandbox that runs the real SDK shim in-process.
 */
import { ActionError, type ActionCtx, type ActionRegistry, type JsonSchema } from "../lib/actions";
import { actionSegment, pluginActionId, type ButtonSpec, type PluginManifest } from "./manifest";
import { checkActionPermission, networkAllowed } from "./permissions";

export interface SandboxHandle {
  post(message: unknown): void;
  dispose(): void;
}
/** Creates a sandbox; `onMessage` receives everything the plugin posts. */
export type SandboxFactory = (onMessage: (m: unknown) => void) => SandboxHandle;

export interface FetchResult {
  status: number;
  ok: boolean;
  body: string;
}

export interface HostEnv {
  registry: ActionRegistry;
  notify: ActionCtx["notify"];
  /** Plugin asked the person a yes/no question. */
  confirm: (message: string, pluginName: string) => Promise<boolean>;
  confirmDangerous: ActionCtx["confirmDangerous"];
  /** Puts text on the clipboard (plugins have no clipboard of their own). */
  copyText: (text: string) => Promise<void>;
  storage: {
    get(pluginId: string, key: string): Promise<unknown>;
    set(pluginId: string, key: string, value: unknown): Promise<void>;
    remove(pluginId: string, key: string): Promise<void>;
  };
  /** Performs an already permission-checked request (Rust-side in the app). */
  fetchText: (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<FetchResult>;
  /** Current selection; only handed to plugins holding `read`. */
  getSelection: () => string[];
}

export interface UiItem {
  pluginId: string;
  pluginName: string;
  id: string;
  label: string;
  title?: string;
}
export interface UiColumn {
  pluginId: string;
  /** Table column id: `plugin.<segment>.<local>`. */
  id: string;
  localId: string;
  label: string;
  width: number;
}

export type PluginState = "idle" | "starting" | "running" | "error" | "stopped";

const START_TIMEOUT_MS = 8_000;
const INVOKE_TIMEOUT_MS = 30_000;
const MAX_ITEMS = 20;
const MAX_STORAGE_BYTES = 256 * 1024;
const MAX_RESPONSE_CHARS = 1_000_000;

const isObj = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);

export class PluginInstance {
  state: PluginState = "idle";
  lastError = "";
  buttons: UiItem[] = [];
  menuItems: UiItem[] = [];
  columns: UiColumn[] = [];
  /** Called when contributions or state change (the manager re-renders). */
  onChange: () => void = () => {};

  private sandbox: SandboxHandle | null = null;
  private unregister: (() => void)[] = [];
  private seq = 0;
  private waiting = new Map<number, { res: (v: any) => void; rej: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private startWaiter: { res: () => void; rej: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private clickable = new Map<string, ButtonSpec & { dynamic?: boolean }>();
  readonly segment: string;

  constructor(
    readonly manifest: PluginManifest,
    private readonly code: string | null,
    private readonly env: HostEnv,
    private readonly makeSandbox: SandboxFactory,
    private settings: Record<string, unknown> = {},
  ) {
    this.segment = actionSegment(manifest.id);
  }

  get id() {
    return this.manifest.id;
  }

  private has(perm: string) {
    return this.manifest.permissions.includes(perm);
  }

  private say: ActionCtx["notify"] = (message, kind, opts) =>
    this.env.notify(`[${this.manifest.name}] ${message}`, kind, opts);

  // ---- lifecycle ------------------------------------------------------

  async start(): Promise<void> {
    if (this.state === "starting" || this.state === "running") return;
    this.state = "starting";
    this.lastError = "";
    try {
      this.loadDeclared();
      if (this.manifest.entry && this.code !== null) await this.boot();
      this.state = "running";
    } catch (e) {
      this.fail(e instanceof Error ? e.message : String(e));
    }
    this.onChange();
  }

  /** Registers what the manifest declares, so it exists before any code runs. */
  private loadDeclared() {
    const m = this.manifest;
    for (const a of m.contributes.actions ?? []) {
      const id = pluginActionId(m.id, a.id);
      const dangerous = !!a.dangerous || this.has("files.delete");
      this.unregister.push(
        this.env.registry.register({
          id,
          title: `${m.name}: ${a.title}`,
          description:
            (a.description ?? a.title) +
            ` (plugin "${m.name}" v${m.version}; permissions: ${m.permissions.join(", ") || "none"})`,
          params: (a.params as JsonSchema | undefined) ?? { type: "object", properties: {}, additionalProperties: true },
          dangerous,
          // A plugin cannot vouch for itself as read-only.
          run: (params) => this.invoke(`action:${a.id}`, params),
        }),
      );
    }
    const toItem = (b: ButtonSpec): UiItem => ({
      pluginId: m.id, pluginName: m.name, id: b.id, label: b.label, title: b.title,
    });
    for (const b of m.contributes.buttons ?? []) {
      this.buttons.push(toItem(b));
      this.clickable.set("button:" + b.id, b);
    }
    for (const b of m.contributes.contextMenu ?? []) {
      this.menuItems.push(toItem(b));
      this.clickable.set("menu:" + b.id, b);
    }
    for (const c of m.contributes.columns ?? []) {
      this.columns.push({
        pluginId: m.id, localId: c.id, id: `plugin.${this.segment}.${c.id}`, label: c.label, width: c.width ?? 120,
      });
    }
  }

  private boot(): Promise<void> {
    return new Promise<void>((res, rej) => {
      const timer = setTimeout(() => {
        this.startWaiter = null;
        rej(new Error("did not start within 8 seconds"));
      }, START_TIMEOUT_MS);
      this.startWaiter = { res, rej, timer };
      this.sandbox = this.makeSandbox((m) => this.onMessage(m));
      this.sandbox.post({
        t: "init",
        code: this.code,
        settings: this.settings,
        selection: this.has("read") ? this.env.getSelection() : [],
      });
    });
  }

  stop() {
    if (this.state === "stopped") return;
    this.teardown(new Error("plugin stopped"));
    this.state = "stopped";
    this.onChange();
  }

  private teardown(reason: Error) {
    for (const u of this.unregister) u();
    this.unregister = [];
    this.sandbox?.dispose();
    this.sandbox = null;
    for (const w of this.waiting.values()) {
      clearTimeout(w.timer);
      w.rej(reason);
    }
    this.waiting.clear();
    if (this.startWaiter) {
      clearTimeout(this.startWaiter.timer);
      this.startWaiter.rej(reason);
      this.startWaiter = null;
    }
    this.buttons = [];
    this.menuItems = [];
    this.columns = [];
    this.clickable.clear();
  }

  /** One broken plugin never takes the app down: record, tear down, tell the person. */
  private fail(message: string) {
    if (this.state === "error") return;
    this.lastError = message;
    this.teardown(new Error(message));
    this.state = "error";
    this.say(`stopped: ${message}`, "error");
    this.onChange();
  }

  // ---- host -> plugin ---------------------------------------------------

  private invoke(target: string, params: unknown): Promise<unknown> {
    const sb = this.sandbox;
    if (!sb || this.state !== "running") return Promise.reject(new Error(`plugin "${this.manifest.name}" is not running`));
    return new Promise((res, rej) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        rej(new Error(`plugin "${this.manifest.name}" did not answer in 30 seconds`));
        this.fail("unresponsive (no answer in 30 seconds)");
      }, INVOKE_TIMEOUT_MS);
      this.waiting.set(id, { res, rej, timer });
      sb.post({ t: "invoke", id, target, params });
    });
  }

  pushSelection(paths: string[]) {
    if (this.state === "running" && this.sandbox && this.has("read")) this.sandbox.post({ t: "selection", paths });
  }

  setSettings(values: Record<string, unknown>) {
    this.settings = values;
    if (this.state === "running") this.sandbox?.post({ t: "settings", values });
  }

  /** Computes one column for a batch of rows (`{path, tags}`); [] on failure. */
  computeColumn(localId: string, rows: { path: string; tags: unknown }[]): Promise<string[]> {
    const sb = this.sandbox;
    if (!sb || this.state !== "running" || !this.has("read")) return Promise.resolve([]);
    return new Promise((res) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        res([]);
        this.fail("unresponsive while computing a column");
      }, INVOKE_TIMEOUT_MS);
      this.waiting.set(id, {
        res: (v) => res(Array.isArray(v) ? v.map(String) : []),
        rej: () => res([]),
        timer,
      });
      sb.post({ t: "compute", id, column: localId, rows });
    });
  }

  /** The person clicked a toolbar button or a context-menu item. */
  async click(kind: "button" | "menu", itemId: string, paths: string[]): Promise<void> {
    const spec = this.clickable.get(`${kind}:${itemId}`);
    if (!spec) throw new Error("no such item");
    const params: Record<string, unknown> = { ...(spec.params ?? {}) };
    if (spec.pathsParam) params[spec.pathsParam] = paths;
    if (!spec.action) {
      // A dynamic item (added in code): its handler lives in the sandbox.
      await this.invoke(`${kind}:${itemId}`, { paths });
      return;
    }
    if (!spec.action.includes(".")) {
      await this.env.registry.run(pluginActionId(this.manifest.id, spec.action), { ...params, paths }, {
        caller: "ui",
        notify: this.say,
      });
      return;
    }
    await this.callAction(spec.action, params);
  }

  // ---- plugin -> host ---------------------------------------------------

  private async callAction(action: string, params: unknown): Promise<unknown> {
    const decision = checkActionPermission(
      this.manifest.permissions,
      action,
      this.env.registry.info(action),
      this.segment,
    );
    if (!decision.allowed) {
      this.say(`blocked: ${decision.reason}`, "error", { silent: true });
      throw new ActionError(decision.reason, "denied");
    }
    this.say(`${action}`, "info", { silent: true, details: params });
    // "script", not "ui": a plugin is not the person, so risky actions still ask.
    return this.env.registry.run(action, params ?? {}, {
      caller: "script",
      notify: this.say,
      confirmDangerous: this.env.confirmDangerous,
    });
  }

  private onMessage(raw: unknown) {
    if (!isObj(raw) || typeof raw.t !== "string") return;
    try {
      switch (raw.t) {
        case "booted":
          return;
        case "ready":
          if (this.startWaiter) {
            clearTimeout(this.startWaiter.timer);
            this.startWaiter.res();
            this.startWaiter = null;
          }
          return;
        case "error":
          return this.fail(String(raw.message ?? "error").slice(0, 500));
        case "invoke-result": {
          const w = this.waiting.get(raw.id);
          if (!w) return;
          this.waiting.delete(raw.id);
          clearTimeout(w.timer);
          if (raw.ok) w.res(raw.value);
          else w.rej(new Error(String(raw.error ?? "failed")));
          return;
        }
        case "compute-result": {
          const w = this.waiting.get(raw.id);
          if (!w) return;
          this.waiting.delete(raw.id);
          clearTimeout(w.timer);
          if (raw.ok) w.res(raw.values);
          else w.rej(new Error(String(raw.error ?? "failed")));
          return;
        }
        case "rpc":
          void this.handleRpc(raw.id, String(raw.method), Array.isArray(raw.args) ? raw.args : []);
          return;
      }
    } catch (e) {
      this.fail(e instanceof Error ? e.message : String(e));
    }
  }

  private async handleRpc(id: number, method: string, args: any[]) {
    let ok = true;
    let value: unknown = null;
    try {
      value = await this.rpc(method, args);
    } catch (e) {
      ok = false;
      value = e instanceof Error ? e.message : String(e);
    }
    // After a stop/fail the sandbox is gone; late replies are dropped.
    this.sandbox?.post({ t: "rpc-result", id, ok, value: ok ? value ?? null : undefined, error: ok ? undefined : value });
  }

  private async rpc(method: string, args: any[]): Promise<unknown> {
    const m = this.manifest;
    switch (method) {
      case "register": {
        const local = String(args[0]);
        if (!(m.contributes.actions ?? []).some((a) => a.id === local))
          throw new Error(`action "${local}" is not declared in contributes.actions`);
        return true;
      }
      case "call":
        return this.callAction(String(args[0]), args[1]);
      case "ui.notify": {
        const kind = ["success", "error", "info"].includes(args[1]) ? args[1] : "info";
        this.say(String(args[0]).slice(0, 500), kind);
        return true;
      }
      case "ui.confirm":
        return this.env.confirm(String(args[0]).slice(0, 500), m.name);
      case "ui.copy":
        await this.env.copyText(String(args[0]).slice(0, 200_000));
        return true;
      case "storage.get":
        return this.env.storage.get(m.id, this.key(args[0]));
      case "storage.set": {
        const key = this.key(args[0]);
        const size = JSON.stringify(args[1] ?? null).length;
        if (size > MAX_STORAGE_BYTES) throw new Error("storage value is larger than 256 KB");
        await this.env.storage.set(m.id, key, args[1] ?? null);
        return true;
      }
      case "storage.remove":
        await this.env.storage.remove(m.id, this.key(args[0]));
        return true;
      case "fetch": {
        const url = String(args[0]);
        if (!networkAllowed(m.permissions, url))
          throw new ActionError(`network access to ${safeHost(url)} was not granted (permission "network:<host>")`, "denied");
        const init = isObj(args[1]) ? args[1] : {};
        const method = String(init.method ?? "GET").toUpperCase();
        if (!["GET", "POST"].includes(method)) throw new Error("only GET and POST are allowed");
        const r = await this.env.fetchText(url, {
          method,
          headers: isObj(init.headers) ? (init.headers as Record<string, string>) : undefined,
          body: typeof init.body === "string" ? init.body.slice(0, 1_000_000) : undefined,
        });
        return { status: r.status, ok: r.ok, body: r.body.slice(0, MAX_RESPONSE_CHARS) };
      }
      case "addButton":
      case "addMenuItem": {
        const spec = args[0];
        if (!isObj(spec) || typeof spec.id !== "string" || !/^[a-zA-Z][A-Za-z0-9]{0,39}$/.test(spec.id))
          throw new Error("item id must be letters/digits");
        if (typeof spec.label !== "string" || !spec.label.trim() || spec.label.length > 40)
          throw new Error("item label is required (max 40 characters)");
        const list = method === "addButton" ? this.buttons : this.menuItems;
        const kind = method === "addButton" ? "button" : "menu";
        if (list.length >= MAX_ITEMS) throw new Error(`at most ${MAX_ITEMS} ${kind} items`);
        if (list.some((x) => x.id === spec.id)) throw new Error(`"${spec.id}" already exists`);
        list.push({
          pluginId: m.id, pluginName: m.name, id: spec.id, label: spec.label,
          title: typeof spec.title === "string" ? spec.title.slice(0, 200) : undefined,
        });
        this.clickable.set(`${kind}:${spec.id}`, { id: spec.id, label: spec.label, dynamic: true });
        this.onChange();
        return true;
      }
      case "addColumn": {
        if (!this.has("read")) throw new ActionError('columns need the "read" permission', "denied");
        const spec = args[0];
        if (!isObj(spec) || typeof spec.id !== "string" || !/^[a-zA-Z][A-Za-z0-9]{0,39}$/.test(spec.id))
          throw new Error("column id must be letters/digits");
        if (typeof spec.label !== "string" || !spec.label.trim() || spec.label.length > 30)
          throw new Error("column label is required (max 30 characters)");
        if (this.columns.length >= 10) throw new Error("at most 10 columns");
        if (!this.columns.some((c) => c.localId === spec.id)) {
          this.columns.push({
            pluginId: m.id, localId: spec.id, id: `plugin.${this.segment}.${spec.id}`, label: spec.label,
            width: typeof spec.width === "number" ? Math.min(600, Math.max(40, spec.width)) : 120,
          });
          this.onChange();
        }
        return true;
      }
      default:
        throw new Error(`unknown SDK call "${method}"`);
    }
  }

  private key(k: unknown): string {
    if (typeof k !== "string" || !k || k.length > 100) throw new Error("storage key must be a string up to 100 characters");
    return k;
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "that address";
  }
}
