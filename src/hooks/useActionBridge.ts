import { useEffect, useRef, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { confirm } from "@tauri-apps/plugin-dialog";
import { actionRegistry, clampResult, type ActionCtx, type ActionInfo } from "../lib/actions";
import { registerAppActions, type AppEnv } from "../lib/appActions";

/**
 * "AI control" glue (D1): connects the Rust bridge to the action registry.
 *
 * The Rust side (src-tauri/src/bridge) is a dumb, authenticated relay: it
 * emits `bridge-request` events and waits for `bridge_respond`. Everything
 * that knows about actions lives in the registry, so new registrations (C1,
 * B3, D2 plugins) appear in `GET /actions` with no Rust change.
 */

interface BridgeRequest {
  id: number;
  kind: "list" | "call";
  action?: string;
  params?: unknown;
}

// ---- "allow without asking" is per app session, never persisted ---------
let allowWithoutAsking = false;
const listeners = new Set<() => void>();
export function setAllowWithoutAsking(v: boolean) {
  allowWithoutAsking = v;
  listeners.forEach((l) => l());
}
export function useAllowWithoutAsking(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => allowWithoutAsking,
  );
}

/**
 * Lets React commit the state an action just set before the next one reads
 * it (the wrapped handlers close over render state).
 */
const settle = () => new Promise<void>((r) => setTimeout(r, 90));

function describeParams(params: unknown): string {
  try {
    const s = JSON.stringify(params);
    return s.length > 600 ? s.slice(0, 600) + "…" : s;
  } catch {
    return "";
  }
}

export function useActionBridge(env: AppEnv, enabled: boolean, loaded: boolean) {
  const envRef = useRef(env);
  envRef.current = env;

  // The registry is app-wide and registered once; actions read the newest env through the ref.
  useEffect(() => {
    actionRegistry.settle = settle;
    registerAppActions(actionRegistry, () => envRef.current);
  }, []);

  // Start/stop the Rust server to follow the setting. Skipped until settings
  // have loaded so the default "off" never races a saved "on".
  useEffect(() => {
    if (!loaded) return;
    invoke("bridge_set_enabled", { enabled }).catch((e) =>
      envRef.current.notify(`AI control: ${String(e)}`, "error"),
    );
  }, [enabled, loaded]);

  useEffect(() => {
    if (!enabled) return;
    let queue: Promise<unknown> = Promise.resolve();
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    const respond = (id: number, ok: boolean, payload: unknown) =>
      invoke("bridge_respond", { id, ok, payload }).catch(() => {});

    const confirmDangerous: NonNullable<ActionCtx["confirmDangerous"]> = async (info: ActionInfo, params) => {
      if (allowWithoutAsking) return true;
      // Bring the window forward is Rust's job; here we only ask.
      return confirm(
        `An AI assistant wants to run "${info.title}" (${info.id}).\n\n${describeParams(params)}\n\nAllow it?`,
        { title: "AI control", kind: "warning" },
      );
    };

    const handle = async (req: BridgeRequest) => {
      const e = envRef.current;
      if (req.kind === "list") {
        return respond(req.id, true, actionRegistry.list());
      }
      const action = req.action ?? "";
      const ctx: ActionCtx = { caller: "ai", notify: e.notify, confirmDangerous };
      e.notify(`AI: ${action} ${describeParams(req.params)}`, "info", { silent: true });
      try {
        const result = clampResult(await actionRegistry.run(action, req.params, ctx));
        e.notify(`AI: ${action} done`, "info", { silent: true, details: { params: req.params, result } });
        await settle();
        await respond(req.id, true, result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        envRef.current.notify(`AI: ${action} failed: ${message}`, "error", {
          details: { params: req.params },
        });
        await respond(req.id, false, message);
      }
    };

    void listen<BridgeRequest>("bridge-request", (ev) => {
      // Listing is read-only: don't make it wait behind a running action.
      if (ev.payload.kind === "list") return void handle(ev.payload);
      // One action at a time: they share app state (selection, preview, busy).
      queue = queue.then(() => handle(ev.payload)).catch(() => {});
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [enabled]);
}
