import { useEffect, useRef, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";
import { actionRegistry } from "../lib/actions";
import type { AudioFile, Settings, TagData } from "../types";
import { syncPluginColumns } from "../components/TrackTable";
import type { HostEnv } from "./host";
import { createIframeSandbox } from "./iframeSandbox";
import { PluginManager, type InstalledFiles, type PluginBackend, type PluginRecords } from "./manager";
import { registerPluginActions } from "./pluginActions";
import { clearPluginColumnData, setPluginColumnData, setPluginUi } from "./pluginUi";

/**
 * Glue between the PluginManager and the app (D2): disk via Rust, per-plugin
 * storage in localStorage, network via the Rust proxy, dialogs via Tauri, and
 * the UI store that TrackTable reads. All the logic lives in `manager.ts` /
 * `host.ts`; this file only wires real implementations in.
 */

const STORAGE_PREFIX = "mtc.plugin.";

const tauriBackend: PluginBackend = {
  list: async () => {
    const rows = await invoke<{ id: string; manifest: string; code: string | null }[]>("plugins_list");
    return rows.map<InstalledFiles>((r) => ({ id: r.id, manifest: r.manifest, code: r.code }));
  },
  write: (id, manifest, code) => invoke("plugins_write", { id, manifest, code }),
  remove: (id) => invoke("plugins_remove", { id }),
  clearStorage: (id) => {
    try {
      const prefix = `${STORAGE_PREFIX}${id}.`;
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k?.startsWith(prefix)) localStorage.removeItem(k);
      }
    } catch {
      /* storage unavailable */
    }
  },
};

const localStorageKv: HostEnv["storage"] = {
  get: async (p, k) => {
    try {
      const raw = localStorage.getItem(`${STORAGE_PREFIX}${p}.${k}`);
      return raw === null ? null : JSON.parse(raw);
    } catch {
      return null;
    }
  },
  set: async (p, k, v) => localStorage.setItem(`${STORAGE_PREFIX}${p}.${k}`, JSON.stringify(v)),
  remove: async (p, k) => localStorage.removeItem(`${STORAGE_PREFIX}${p}.${k}`),
};

interface Args {
  settings: Settings;
  loaded: boolean;
  savePatch: (patch: Partial<Settings>) => void;
  notify: HostEnv["notify"];
  files: AudioFile[];
  tags: Record<string, TagData>;
  selectedPaths: string[];
  showPlugins: () => void;
}

const COLUMN_CHUNK = 1000;

function publishUi(manager: PluginManager, argsRef: { current: Args }) {
  setPluginUi({
    buttons: manager.buttons(),
    menuItems: manager.menuItems(),
    columns: manager.columns(),
    getSelection: () => argsRef.current.selectedPaths,
    run: (kind, pluginId, itemId, paths) => {
      const inst = manager.instance(pluginId);
      if (!inst) return;
      inst.click(kind, itemId, paths).catch((e) =>
        argsRef.current.notify(`[${inst.manifest.name}] ${e instanceof Error ? e.message : String(e)}`, "error"),
      );
    },
  });
}

export function usePlugins(args: Args): PluginManager {
  const argsRef = useRef(args);
  argsRef.current = args;
  const recordsRef = useRef<PluginRecords>(args.settings.plugins ?? {});
  const managerRef = useRef<PluginManager | null>(null);

  if (!managerRef.current) {
    const env: HostEnv = {
      registry: actionRegistry,
      notify: (m, k, o) => argsRef.current.notify(m, k, o),
      confirm: (message, name) => confirm(message, { title: `Plugin: ${name}`, kind: "info" }),
      confirmDangerous: (info, params) =>
        confirm(`A plugin wants to run "${info.title}" (${info.id}).\n\n${JSON.stringify(params).slice(0, 600)}\n\nAllow it?`, {
          title: "Plugin",
          kind: "warning",
        }),
      copyText: (text) => navigator.clipboard.writeText(text),
      storage: localStorageKv,
      fetchText: (url, init) => invoke("plugins_http", { url, method: init.method, headers: init.headers, body: init.body }),
      getSelection: () => argsRef.current.selectedPaths,
    };
    managerRef.current = new PluginManager({
      backend: tauriBackend,
      registry: actionRegistry,
      env,
      sandbox: createIframeSandbox,
      getRecords: () => recordsRef.current,
      setRecords: (r) => {
        recordsRef.current = r;
        argsRef.current.savePatch({ plugins: r });
      },
    });
  }
  const manager = managerRef.current;

  // Register plugins.* once, then load installed plugins after settings arrived.
  useEffect(() => {
    registerPluginActions(actionRegistry, { manager: () => manager, showPlugins: () => argsRef.current.showPlugins() });
  }, [manager]);

  useEffect(() => {
    if (!args.loaded) return;
    recordsRef.current = argsRef.current.settings.plugins ?? {};
    manager.refresh().catch((e) => argsRef.current.notify(`Plugins: ${String(e)}`, "error"));
    return () => manager.stopAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [args.loaded, manager]);

  // Selection -> plugins holding `read`.
  const selKey = args.selectedPaths.join("\n");
  useEffect(() => {
    manager.pushSelection(argsRef.current.selectedPaths);
  }, [selKey, manager]);

  // Contributions -> the UI store TrackTable reads.
  const managerVersion = useSyncExternalStore(manager.subscribe, manager.getVersion);
  const columns = manager.columns();
  const columnKey = columns.map((c) => c.id).join(",");
  useEffect(() => {
    syncPluginColumns(columns);
    publishUi(manager, argsRef);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [managerVersion, manager]);

  // Column values: computed in each plugin's sandbox, a chunk at a time, after the tags settle.
  useEffect(() => {
    if (!columnKey) {
      clearPluginColumnData(new Set());
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      const { files, tags } = argsRef.current;
      for (const col of manager.columns()) {
        const inst = manager.instance(col.pluginId);
        if (!inst) continue;
        const values = new Map<string, string>();
        for (let i = 0; i < files.length; i += COLUMN_CHUNK) {
          if (cancelled) return;
          const chunk = files.slice(i, i + COLUMN_CHUNK);
          const out = await inst.computeColumn(
            col.localId,
            chunk.map((f) => ({ path: f.path, tags: tags[f.path] ?? {} })),
          );
          chunk.forEach((f, k) => values.set(f.path, out[k] ?? ""));
        }
        if (cancelled) return;
        setPluginColumnData(col.id, values);
      }
      clearPluginColumnData(new Set(manager.columns().map((c) => c.id)));
      // Same data, new version: makes the table re-read the cells.
      publishUi(manager, argsRef);
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [columnKey, args.files, args.tags, manager]);

  return manager;
}
