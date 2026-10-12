import type { SandboxFactory } from "./host";
import { iframeSrcdoc } from "./sandboxSource";

/**
 * Real sandbox: a hidden `<iframe sandbox="allow-scripts">` (opaque origin, no
 * same-origin, no popups/forms/top-navigation) whose srcdoc starts a Worker for
 * the plugin code. See `sandboxSource.ts` for the layering.
 */
export const createIframeSandbox: SandboxFactory = (onMessage) => {
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.style.cssText = "position:fixed;width:0;height:0;border:0;opacity:0;pointer-events:none;";
  frame.srcdoc = iframeSrcdoc();

  // Messages posted before the frame has loaded would be lost; queue them
  // until the frame says it has booted.
  let booted = false;
  const queue: unknown[] = [];

  // Messages from a sandboxed (opaque-origin) frame carry origin "null", so the
  // source window is the only identity check available.
  const listener = (e: MessageEvent) => {
    if (e.source !== frame.contentWindow) return;
    const m = e.data as { t?: unknown } | null;
    if (!booted && m && typeof m === "object" && m.t === "booted") {
      booted = true;
      for (const q of queue.splice(0)) frame.contentWindow?.postMessage(q, "*");
    }
    onMessage(e.data);
  };
  window.addEventListener("message", listener);
  document.body.appendChild(frame);

  return {
    post(message) {
      if (booted) frame.contentWindow?.postMessage(message, "*");
      else queue.push(message);
    },
    dispose() {
      window.removeEventListener("message", listener);
      frame.remove();
    },
  };
};
