import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, Download, ShieldCheck } from "lucide-react";
import type { Proposal } from "../plugins/manager";
import { PERMISSION_INFO } from "../plugins/manifest";
import { Button, cn } from "./ui";

const SOURCE_LABEL: Record<Proposal["source"], string> = {
  ai: "Created by an AI assistant",
  store: "From the plugin store",
  user: "Created in this app",
  folder: "Found in the plugins folder",
};

export function describePermission(p: string): { label: string; risk: "low" | "medium" | "high" } {
  if (PERMISSION_INFO[p]) return PERMISSION_INFO[p];
  if (p.startsWith("network:")) return { label: `Send and receive data with ${p.slice(8)}`, risk: "high" };
  if (p.startsWith("action:")) return { label: `Run the app action ${p.slice(7)}`, risk: "medium" };
  return { label: p, risk: "high" };
}

const RISK_CLASS = {
  low: "bg-secondary text-secondary-foreground",
  medium: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  high: "bg-destructive/15 text-destructive",
} as const;

export interface EngineStatus {
  id: string;
  installedVersion?: string;
  path?: string;
  devOverride: boolean;
  available?: { version: string; size: number };
}

/** Lists the engines this plugin needs, with their install state and an Install button. */
function EngineRequirements({ engines }: { engines: { id: string; version: string }[] }) {
  const [status, setStatus] = useState<EngineStatus[] | null>(null);
  const [error, setError] = useState("");
  const [installing, setInstalling] = useState<string | null>(null);

  const refresh = useCallback(() => {
    invoke<EngineStatus[]>("engines_status")
      .then((s) => {
        setStatus(s);
        setError("");
      })
      .catch((e) => setError(String(e)));
  }, []);
  useEffect(refresh, [refresh]);

  const install = async (id: string) => {
    setInstalling(id);
    setError("");
    try {
      await invoke("engine_install", { id });
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setInstalling(null);
    }
  };

  return (
    <div>
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Needs</div>
      <ul className="space-y-1.5">
        {engines.map((e) => {
          const st = status?.find((x) => x.id === e.id);
          const installed = !!st && (st.installedVersion !== undefined || st.devOverride);
          return (
            <li key={e.id} className="flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-secondary-foreground">{e.id}</span>
              <span>
                engine {e.version}
                {st?.available ? ` (about ${Math.max(1, Math.round(st.available.size / 1048576))} MB download)` : ""}
              </span>
              {status === null ? (
                <span className="text-muted-foreground">checking...</span>
              ) : installed ? (
                <span className="text-emerald-600 dark:text-emerald-400">
                  installed{st?.installedVersion ? ` (v${st.installedVersion})` : st?.devOverride ? " (dev override)" : ""}
                </span>
              ) : (
                <>
                  <span className="text-amber-600 dark:text-amber-400">not installed</span>
                  {st?.available && (
                    <Button size="sm" variant="outline" disabled={installing !== null} onClick={() => install(e.id)}>
                      <Download className="mr-1 h-3.5 w-3.5" />
                      {installing === e.id ? "Installing..." : "Install"}
                    </Button>
                  )}
                  {st && !st.available && <span className="text-muted-foreground">no download is published yet</span>}
                </>
              )}
            </li>
          );
        })}
      </ul>
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  );
}

/**
 * The install / review prompt (D2): permissions and the full code are shown
 * before anything activates. Used for store installs, AI-created plugins and
 * for plugins whose files changed on disk.
 */
export function PluginReviewDialog({
  title,
  source,
  manifest,
  code,
  previousVersion,
  onApprove,
  onReject,
}: {
  title?: string;
  source: Proposal["source"];
  manifest: Proposal["manifest"];
  code: string | null;
  previousVersion?: string | null;
  onApprove: () => void;
  onReject: () => void;
}) {
  const [showCode, setShowCode] = useState(true);
  const c = manifest.contributes;
  const contributes = [
    c.buttons?.length ? `${c.buttons.length} toolbar button(s): ${c.buttons.map((b) => b.label).join(", ")}` : "",
    c.contextMenu?.length ? `${c.contextMenu.length} right-click item(s): ${c.contextMenu.map((b) => b.label).join(", ")}` : "",
    c.columns?.length ? `${c.columns.length} table column(s): ${c.columns.map((b) => b.label).join(", ")}` : "",
    c.actions?.length ? `${c.actions.length} action(s) (also usable by AI assistants): ${c.actions.map((a) => a.title).join(", ")}` : "",
    c.theme ? "A colour theme" : "",
  ].filter(Boolean);
  const highRisk = manifest.permissions.some((p) => describePermission(p).risk === "high");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6">
      <div className="flex max-h-full w-full max-w-2xl flex-col rounded-xl border bg-popover text-popover-foreground shadow-2xl">
        <div className="border-b px-5 py-4">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <ShieldCheck className="h-4 w-4 text-primary" />
            {title ?? (previousVersion ? "Review plugin update" : "Review plugin before installing")}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {SOURCE_LABEL[source]}. Nothing runs until you approve it.
          </p>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4 text-sm">
          <div>
            <div className="text-base font-semibold">
              {manifest.name} <span className="text-xs font-normal text-muted-foreground">v{manifest.version}</span>
              {previousVersion && (
                <span className="ml-2 text-xs font-normal text-muted-foreground">(replaces v{previousVersion})</span>
              )}
            </div>
            <div className="text-xs text-muted-foreground">by {manifest.author}</div>
            <p className="mt-1">{manifest.description}</p>
          </div>

          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Permissions</div>
            {manifest.permissions.length === 0 ? (
              <p className="text-xs text-muted-foreground">None. It cannot read or change anything.</p>
            ) : (
              <ul className="space-y-1">
                {manifest.permissions.map((p) => {
                  const d = describePermission(p);
                  return (
                    <li key={p} className="flex items-center gap-2 text-xs">
                      <span className={cn("rounded px-1.5 py-0.5 font-mono text-[10px]", RISK_CLASS[d.risk])}>{p}</span>
                      <span>{d.label}</span>
                    </li>
                  );
                })}
              </ul>
            )}
            {highRisk && (
              <p className="mt-2 flex items-start gap-1.5 text-xs text-destructive">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                This plugin asks for powerful permissions. Only approve it if you trust where it came from.
              </p>
            )}
          </div>

          {manifest.requires?.engines?.length ? <EngineRequirements engines={manifest.requires.engines} /> : null}

          {contributes.length > 0 && (
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Adds</div>
              <ul className="list-disc space-y-0.5 pl-5 text-xs">
                {contributes.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {code === null ? "Manifest (no code)" : "Code"}
              </span>
              <button className="text-xs text-primary hover:underline" onClick={() => setShowCode((v) => !v)}>
                {showCode ? "Hide" : "Show"}
              </button>
            </div>
            {showCode && (
              <pre className="max-h-72 select-text overflow-auto rounded-md border bg-background p-3 font-mono text-[11px] leading-snug">
                {code ?? JSON.stringify(manifest, null, 2)}
              </pre>
            )}
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t px-5 py-3">
          <Button variant="ghost" onClick={onReject}>
            Reject
          </Button>
          <Button onClick={onApprove}>{previousVersion ? "Approve update" : "Approve and enable"}</Button>
        </div>
      </div>
    </div>
  );
}
