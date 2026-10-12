/**
 * Test helpers: an in-process "sandbox" that runs the REAL SDK shim
 * (`workerMain`) with a fake `self`, so host + SDK + permissions are tested
 * together without a browser.
 */
import { ActionRegistry } from "../lib/actions";
import type { HostEnv, SandboxFactory } from "./host";
import type { PluginBackend, InstalledFiles, PluginRecords } from "./manager";
import { PluginManager } from "./manager";
import { workerMain } from "./sandboxSource";

export const inProcessSandbox: SandboxFactory = (onMessage) => {
  let disposed = false;
  const self: any = {
    postMessage: (m: unknown) =>
      queueMicrotask(() => {
        if (!disposed) onMessage(structuredClone(m));
      }),
    onmessage: null,
  };
  workerMain(self);
  return {
    post(m) {
      queueMicrotask(() => {
        if (!disposed) self.onmessage?.({ data: structuredClone(m) });
      });
    },
    dispose() {
      disposed = true;
    },
  };
};

export interface TestEnv {
  registry: ActionRegistry;
  env: HostEnv;
  calls: { id: string; params: unknown }[];
  notes: { message: string; kind?: string }[];
  store: Map<string, unknown>;
  confirmAnswer: { value: boolean };
  fetched: string[];
  copied: string[];
}

export function makeEnv(): TestEnv {
  const registry = new ActionRegistry();
  const calls: TestEnv["calls"] = [];
  const notes: TestEnv["notes"] = [];
  const store = new Map<string, unknown>();
  const confirmAnswer = { value: true };
  const fetched: string[] = [];
  const copied: string[] = [];
  const stub = (id: string, extra: object = {}) =>
    registry.register({
      id,
      title: id,
      params: { type: "object", properties: {}, additionalProperties: true },
      run: (params) => {
        calls.push({ id, params });
        return { ok: id };
      },
      ...extra,
    });
  stub("tags.edit");
  stub("table.setColumns");
  stub("library.search", { readOnly: true });
  stub("files.delete", { dangerous: true });
  stub("script.run");
  stub("some.unmapped");
  const env: HostEnv = {
    registry,
    notify: (message, kind) => void notes.push({ message, kind }),
    confirm: async () => confirmAnswer.value,
    confirmDangerous: async () => confirmAnswer.value,
    copyText: async (t) => void copied.push(t),
    storage: {
      get: async (p, k) => store.get(`${p}:${k}`) ?? null,
      set: async (p, k, v) => void store.set(`${p}:${k}`, v),
      remove: async (p, k) => void store.delete(`${p}:${k}`),
    },
    fetchText: async (url) => {
      fetched.push(url);
      return { status: 200, ok: true, body: "hello" };
    },
    getSelection: () => ["/a.mp3"],
  };
  return { registry, env, calls, notes, store, confirmAnswer, fetched, copied };
}

export function memoryBackend(initial: InstalledFiles[] = []): PluginBackend & { files: Map<string, InstalledFiles> } {
  const files = new Map(initial.map((f) => [f.id, f]));
  return {
    files,
    list: async () => [...files.values()],
    write: async (id, manifest, code) => void files.set(id, { id, manifest, code }),
    remove: async (id) => void files.delete(id),
    clearStorage: () => {},
  };
}

export function makeManager(t: TestEnv, backend = memoryBackend()) {
  let records: PluginRecords = {};
  const manager = new PluginManager({
    backend,
    registry: t.registry,
    env: t.env,
    sandbox: inProcessSandbox,
    getRecords: () => records,
    setRecords: (r) => void (records = r),
  });
  return { manager, backend, records: () => records };
}

/** Lets queued microtasks (sandbox messages) and a few timers run. */
export const flush = async (n = 8) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

export const baseManifest = (over: Record<string, unknown> = {}) => ({
  id: "demo",
  name: "Demo",
  version: "1.0.0",
  author: "t",
  description: "d",
  apiVersion: 1,
  kind: "plugin",
  permissions: [],
  ...over,
});
