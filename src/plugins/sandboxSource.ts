/**
 * The code that runs INSIDE a plugin's sandbox (D2).
 *
 * Layering, outside in:
 *  1. `<iframe sandbox="allow-scripts">` (no `allow-same-origin`): an opaque
 *     origin, so no access to the app's DOM, storage, cookies or Tauri IPC, and
 *     no top navigation, popups or forms. Its CSP is `default-src 'none'`, so it
 *     cannot load or fetch anything either.
 *  2. A Worker created from a blob inside that iframe runs the plugin code. It
 *     inherits the CSP (no `fetch`/XHR/WebSocket), has no DOM, and cannot
 *     navigate the frame (which would be an exfiltration channel). Running in a
 *     worker also means a plugin stuck in `while(true){}` does not freeze the
 *     app window; the host's watchdog just removes the iframe.
 *  3. The worker additionally deletes the network-capable globals (defence in
 *     depth if a CSP were ever loosened).
 *
 * The only way out is `postMessage` to the host, which treats every message as
 * untrusted and checks permissions (see `host.ts`).
 *
 * `workerMain` is a real function so it type-checks and can be unit-tested with
 * a fake `self`; it is stringified for the blob. It must not reference anything
 * outside itself.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
export function workerMain(self: any): void {
  "use strict";
  const post = self.postMessage.bind(self);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

  for (const k of [
    "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "indexedDB",
    "caches", "BroadcastChannel", "SharedWorker", "Worker", "WebTransport", "Request",
  ]) {
    try {
      delete self[k];
    } catch {
      /* non-configurable: the CSP still blocks it */
    }
  }

  let seq = 0;
  const pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  const rpc = (method: string, ...args: any[]) =>
    new Promise<any>((res, rej) => {
      const id = ++seq;
      pending.set(id, { res, rej });
      post({ t: "rpc", id, method, args });
    });

  const handlers = new Map<string, (arg: any) => any>();
  const selectionCbs: ((paths: string[]) => void)[] = [];
  const columns = new Map<string, (row: any) => any>();
  let selection: string[] = [];
  let settings: Record<string, any> = {};

  const need = (fn: unknown, what: string) => {
    if (typeof fn !== "function") throw new TypeError(`${what} must be a function`);
    return fn as (a: any) => any;
  };

  const mtc = Object.freeze({
    apiVersion: 1,
    registerAction(id: string, fn: (params: any) => any) {
      handlers.set("action:" + id, need(fn, "registerAction handler"));
      return rpc("register", id);
    },
    call: (action: string, params?: unknown) => rpc("call", action, params ?? {}),
    addToolbarButton(spec: any, fn: (arg: any) => any) {
      handlers.set("button:" + spec.id, need(fn, "addToolbarButton handler"));
      return rpc("addButton", { id: spec.id, label: spec.label, title: spec.title });
    },
    addContextMenuItem(spec: any, fn: (arg: any) => any) {
      handlers.set("menu:" + spec.id, need(fn, "addContextMenuItem handler"));
      return rpc("addMenuItem", { id: spec.id, label: spec.label, title: spec.title });
    },
    addColumn(spec: any, compute: (row: any) => any) {
      columns.set(spec.id, need(compute, "addColumn compute"));
      return rpc("addColumn", { id: spec.id, label: spec.label, width: spec.width });
    },
    onSelectionChange(fn: (paths: string[]) => void) {
      selectionCbs.push(need(fn, "onSelectionChange handler"));
    },
    selection: () => selection.slice(),
    storage: {
      get: (key: string) => rpc("storage.get", key),
      set: (key: string, value: unknown) => rpc("storage.set", key, value),
      remove: (key: string) => rpc("storage.remove", key),
    },
    settings: {
      get: (key: string) => settings[key],
      all: () => ({ ...settings }),
    },
    ui: {
      notify: (message: string, kind?: string) => rpc("ui.notify", message, kind),
      confirm: (message: string) => rpc("ui.confirm", message),
      copy: (text: string) => rpc("ui.copy", text),
    },
    fetch: (url: string, init?: unknown) => rpc("fetch", url, init ?? {}),
  });

  const reply = (id: number, ok: boolean, value?: unknown, error?: unknown) =>
    post({
      t: "invoke-result",
      id,
      ok,
      value: ok ? value ?? null : undefined,
      error: ok ? undefined : String((error as Error)?.message ?? error),
    });

  self.onmessage = async (e: { data: any }) => {
    const m = e.data;
    if (!m || typeof m !== "object") return;
    try {
      switch (m.t) {
        case "init": {
          settings = m.settings ?? {};
          selection = m.selection ?? [];
          try {
            // AsyncFunction so plugin code can use top-level await.
            await new AsyncFunction("mtc", '"use strict";\n' + m.code)(mtc);
            post({ t: "ready" });
          } catch (err) {
            post({ t: "error", message: "Plugin failed to start: " + String((err as Error)?.message ?? err) });
          }
          break;
        }
        case "rpc-result": {
          const p = pending.get(m.id);
          if (!p) break;
          pending.delete(m.id);
          if (m.ok) p.res(m.value);
          else p.rej(new Error(m.error));
          break;
        }
        case "invoke": {
          const fn = handlers.get(m.target);
          if (!fn) return reply(m.id, false, undefined, `no handler for ${m.target}`);
          try {
            reply(m.id, true, await fn(m.params));
          } catch (err) {
            reply(m.id, false, undefined, err);
          }
          break;
        }
        case "selection": {
          selection = m.paths ?? [];
          for (const cb of selectionCbs) {
            try {
              cb(selection.slice());
            } catch (err) {
              post({ t: "error", message: "onSelectionChange: " + String((err as Error)?.message ?? err) });
            }
          }
          break;
        }
        case "settings": {
          settings = m.values ?? {};
          break;
        }
        case "compute": {
          const fn = columns.get(m.column);
          if (!fn) return post({ t: "compute-result", id: m.id, ok: false, error: `no column ${m.column}` });
          try {
            const values = (m.rows as any[]).map((row) => {
              try {
                const v = fn(row);
                return v === undefined || v === null ? "" : String(v);
              } catch {
                return "";
              }
            });
            post({ t: "compute-result", id: m.id, ok: true, values });
          } catch (err) {
            post({ t: "compute-result", id: m.id, ok: false, error: String((err as Error)?.message ?? err) });
          }
          break;
        }
      }
    } catch (err) {
      post({ t: "error", message: String((err as Error)?.message ?? err) });
    }
  };
}

export const WORKER_SOURCE = `(${workerMain.toString()})(self);`;

/** Document for the sandboxed iframe: relays host <-> worker and nothing else. */
export function iframeSrcdoc(): string {
  const src = JSON.stringify(WORKER_SOURCE).replace(/</g, "\\u003c");
  return (
    `<!doctype html><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob:">` +
    `<script>(function(){` +
    `var w=new Worker(URL.createObjectURL(new Blob([${src}],{type:"text/javascript"})));` +
    `w.onmessage=function(e){parent.postMessage(e.data,"*")};` +
    `w.onerror=function(e){parent.postMessage({t:"error",message:String(e.message||"worker error")},"*")};` +
    `addEventListener("message",function(e){if(e.source===parent)w.postMessage(e.data)});` +
    `parent.postMessage({t:"booted"},"*");` +
    `})();<\/script>`
  );
}
