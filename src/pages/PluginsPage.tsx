import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { AlertTriangle, Download, FolderOpen, Puzzle, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import type { Settings } from "../types";
import type { PluginEntry, PluginManager, PluginStatus } from "../plugins/manager";
import { Badge, Button, Card, CardHeader, cn, inputClass } from "../components/ui";
import { NewButtonDialog } from "../components/NewButtonDialog";
import { actionRegistry } from "../lib/actions";
import { parseStoreIndex, storeStatus, type StoreEntry } from "../plugins/store";
import { ThemePicker } from "../components/ThemePicker";
import { useInstalledThemes } from "../plugins/useAppTheme";
import { PluginReviewDialog, describePermission } from "../components/PluginReviewDialog";

type Notify = (message: string, kind?: "success" | "error" | "info") => void;
type Tab = "installed" | "store" | "themes";

interface StoreState {
  loading: boolean;
  entries: StoreEntry[];
  problems: string[];
  error: string;
  loaded: boolean;
}

interface StorePackage {
  id: string;
  manifest: string;
  code: string | null;
}

const STATUS_LABEL: Record<PluginStatus, { text: string; cls: string }> = {
  running: { text: "On", cls: "bg-primary/15 text-primary" },
  starting: { text: "Starting", cls: "bg-secondary text-secondary-foreground" },
  error: { text: "Error", cls: "bg-destructive/15 text-destructive" },
  disabled: { text: "Off", cls: "bg-secondary text-secondary-foreground" },
  "needs-review": { text: "Needs review", cls: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
  invalid: { text: "Invalid", cls: "bg-destructive/15 text-destructive" },
  theme: { text: "Theme", cls: "bg-secondary text-secondary-foreground" },
};

export function PluginsPage({
  manager,
  settings,
  notify,
  onUpdate,
  generate,
}: {
  manager: PluginManager;
  settings: Settings;
  notify: Notify;
  onUpdate: (fn: (prev: Settings) => Settings) => void;
  /** One prompt through the configured AI backend (useAI.generateText). */
  generate: (prompt: string) => Promise<string>;
}) {
  useSyncExternalStore(manager.subscribe, manager.getVersion);
  const installedThemes = useInstalledThemes(manager);
  const [tab, setTab] = useState<Tab>("installed");
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newButton, setNewButton] = useState(false);
  const [store, setStore] = useState<StoreState>({ loading: false, entries: [], problems: [], error: "", loaded: false });
  const [urlDraft, setUrlDraft] = useState(settings.pluginStoreUrl);
  const storeUrl = settings.pluginStoreUrl.trim();

  const loadStore = async () => {
    if (!storeUrl) return setStore({ loading: false, entries: [], problems: [], error: "", loaded: true });
    setStore((s) => ({ ...s, loading: true, error: "" }));
    try {
      const text = await invoke<string>("plugin_store_index", { url: storeUrl });
      const parsed = parseStoreIndex(text, storeUrl);
      setStore({ loading: false, entries: parsed.entries, problems: parsed.problems, error: "", loaded: true });
    } catch (e) {
      setStore({ loading: false, entries: [], problems: [], error: String(e), loaded: true });
    }
  };
  // Fetch once per store address (also gives the update count on the tab label).
  const fetchedFor = useRef<string | null>(null);
  useEffect(() => {
    if (fetchedFor.current === storeUrl) return;
    fetchedFor.current = storeUrl;
    if (storeUrl) void loadStore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeUrl]);

  /** Downloads + verifies in Rust, then stages for the normal review dialog. */
  const installFromStore = async (entry: StoreEntry) => {
    const pkg = await invoke<StorePackage>("plugin_store_package", { url: entry.url, sha256: entry.sha256 });
    if (pkg.id !== entry.id) throw new Error(`The package contains "${pkg.id}", not "${entry.id}". Not installed.`);
    const res = await manager.propose(pkg.manifest, pkg.code, "store");
    if (res.status === "invalid") throw new Error(`The package is not valid:\n- ${res.errors.join("\n- ")}`);
    setReviewing(res.id);
  };
  const updateCount = store.entries.filter((e) => storeStatus(e, manager.entry(e.id)?.manifest) === "update").length;

  const guard = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const plugins = manager.entries.filter((e) => e.manifest?.kind !== "theme");
  const proposal = manager.proposals.find((p) => p.id === reviewing);
  const reviewEntry = reviewing && !proposal ? manager.entry(reviewing) : undefined;

  return (
    <div className="mx-auto max-w-3xl space-y-5 px-8 py-8">
      <div>
        <h1 className="text-lg font-semibold">Plugins</h1>
        <p className="text-sm text-muted-foreground">
          Small add-ons that run in a sandbox: extra buttons, menu items and columns. Each one lists the permissions it
          needs and you approve its code before it runs.
        </p>
      </div>

      <div className="flex gap-1 border-b">
        {(["installed", "store", "themes"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm font-medium capitalize",
              tab === t ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t}
            {t === "store" && updateCount > 0 && (
              <span className="ml-1.5 rounded-full bg-primary px-1.5 py-0.5 text-[10px] text-primary-foreground">{updateCount}</span>
            )}
          </button>
        ))}
      </div>

      {manager.proposals.length > 0 && (
        <Card className="border-amber-500/50">
          <div className="flex items-center justify-between gap-3 px-5 py-3.5">
            <div className="text-sm">
              <span className="font-semibold">{manager.proposals.length} plugin(s) waiting for your review: </span>
              {manager.proposals.map((p) => p.manifest.name).join(", ")}
            </div>
            <Button size="sm" onClick={() => setReviewing(manager.proposals[0].id)}>
              Review
            </Button>
          </div>
        </Card>
      )}

      {tab === "installed" && (
        <Card>
          <CardHeader title="Installed plugins" hint="Folders in the plugins directory. Copy a folder in, then press Rescan." />
          <div className="divide-y">
            {plugins.length === 0 && (
              <div className="flex items-center gap-2 px-5 py-6 text-sm text-muted-foreground">
                <Puzzle className="h-4 w-4" /> No plugins yet. Ask an AI assistant to make a button, or copy a plugin folder in.
              </div>
            )}
            {plugins.map((e) => (
              <PluginRow
                key={e.id}
                entry={e}
                settings={settings}
                manager={manager}
                busy={busy}
                guard={guard}
                onReview={() => setReviewing(e.id)}
                notify={notify}
              />
            ))}
          </div>
          <div className="flex gap-2 border-t px-5 py-3">
            <Button size="sm" onClick={() => setNewButton(true)}>
              <Sparkles /> New button with AI
            </Button>
            <Button variant="ghost" size="sm" onClick={() => guard(() => manager.refresh())}>
              <RefreshCw /> Rescan
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => guard(async () => revealItemInDir(`${await invoke<string>("plugins_dir")}`))}
            >
              <FolderOpen /> Open plugins folder
            </Button>
          </div>
        </Card>
      )}

      {tab === "store" && (
        <Card>
          <CardHeader
            title="Plugin store"
            hint="A list of free plugins published at an address you choose. Every download is checked against its published SHA-256 and shown to you for review before it runs."
          />
          <div className="space-y-3 px-5 py-4">
            <div className="flex gap-2">
              <input
                className={cn(inputClass, "flex-1 select-text")}
                placeholder="https://raw.githubusercontent.com/you/plugin-store/main/index.json"
                value={urlDraft}
                onChange={(e) => setUrlDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && onUpdate((p) => ({ ...p, pluginStoreUrl: urlDraft.trim() }))}
              />
              <Button
                size="sm"
                variant="secondary"
                disabled={urlDraft.trim() === storeUrl}
                onClick={() => onUpdate((p) => ({ ...p, pluginStoreUrl: urlDraft.trim() }))}
              >
                Save
              </Button>
              <Button size="sm" variant="ghost" disabled={!storeUrl || store.loading} onClick={() => void loadStore()}>
                <RefreshCw /> Check
              </Button>
            </div>
            {!storeUrl && <p className="text-sm text-muted-foreground">No store configured. Paste the address of a store index above.</p>}
            {store.loading && <p className="text-sm text-muted-foreground">Contacting the store…</p>}
            {store.error && <p className="text-sm text-destructive">{store.error}</p>}
            {store.problems.length > 0 && (
              <ul className="list-disc pl-4 text-xs text-amber-600 dark:text-amber-400">
                {store.problems.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            )}
            {storeUrl && store.loaded && !store.loading && !store.error && store.entries.length === 0 && (
              <p className="text-sm text-muted-foreground">The store lists no plugins.</p>
            )}
          </div>
          <div className="divide-y border-t">
            {store.entries.map((e) => {
              const st = storeStatus(e, manager.entry(e.id)?.manifest);
              return (
                <div key={e.id} className="flex items-start gap-3 px-5 py-3.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold">{e.manifest.name}</span>
                      <span className="text-xs text-muted-foreground">v{e.manifest.version}</span>
                      {e.manifest.kind === "theme" && <Badge className="bg-secondary text-secondary-foreground">Theme</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground">{e.manifest.description}</p>
                    <p className="text-[11px] text-muted-foreground">by {e.manifest.author}</p>
                    {e.manifest.permissions.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {e.manifest.permissions.map((p) => (
                          <span key={p} className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px]">
                            {p}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  {st === "installed" ? (
                    <Badge className="bg-secondary text-secondary-foreground">Installed</Badge>
                  ) : (
                    <Button size="sm" disabled={busy} onClick={() => guard(() => installFromStore(e))}>
                      <Download /> {st === "update" ? "Update" : "Install"}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {tab === "themes" && (
        <Card>
          <CardHeader title="Themes" hint="Pick a look. Installed theme plugins show up here too; Follow OS keeps the default." />
          <div className="px-5 py-4">
            <ThemePicker
              themeId={settings.themeId}
              installed={installedThemes}
              onPick={(id) => onUpdate((prev) => ({ ...prev, themeId: id }))}
            />
          </div>
        </Card>
      )}

      {newButton && (
        <NewButtonDialog
          backend={settings.aiBackend}
          actionIds={actionRegistry.list().map((a) => a.id)}
          generate={generate}
          onClose={() => setNewButton(false)}
          onGenerated={async (manifestText, code) => {
            const res = await manager.propose(manifestText, code, "ai");
            if (res.status === "invalid") return `The plugin is not valid:\n- ${res.errors.join("\n- ")}`;
            setReviewing(res.id);
            return null;
          }}
        />
      )}

      {proposal && reviewing !== null && (
        <PluginReviewDialog
          source={proposal.source}
          manifest={proposal.manifest}
          code={proposal.code}
          previousVersion={proposal.previous?.version}
          onApprove={() => {
            setReviewing(null);
            void guard(async () => {
              await manager.approve(proposal.id);
              notify(`${proposal.manifest.name} installed`, "success");
            });
          }}
          onReject={() => {
            manager.reject(proposal.id);
            setReviewing(null);
          }}
        />
      )}

      {reviewEntry?.manifest && (
        <PluginReviewDialog
          title="Review plugin"
          source="folder"
          manifest={reviewEntry.manifest}
          code={reviewEntry.code}
          onApprove={() => {
            setReviewing(null);
            void guard(() => manager.approveInstalled(reviewEntry.id));
          }}
          onReject={() => setReviewing(null)}
        />
      )}
    </div>
  );
}

function PluginRow({
  entry,
  settings,
  manager,
  busy,
  guard,
  onReview,
  notify,
}: {
  entry: PluginEntry;
  settings: Settings;
  manager: PluginManager;
  busy: boolean;
  guard: (fn: () => Promise<unknown>) => Promise<void>;
  onReview: () => void;
  notify: Notify;
}) {
  const m = entry.manifest;
  const st = STATUS_LABEL[entry.status];
  const rec = settings.plugins[entry.id];
  const [open, setOpen] = useState(false);
  const on = entry.status === "running" || entry.status === "starting";

  return (
    <div className="px-5 py-3.5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold">{m?.name ?? entry.id}</span>
            {m && <span className="text-xs text-muted-foreground">v{m.version}</span>}
            <Badge className={st.cls}>{st.text}</Badge>
          </div>
          {m && <p className="text-xs text-muted-foreground">{m.description}</p>}
          {m && m.permissions.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {m.permissions.map((p) => (
                <span key={p} title={describePermission(p).label} className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px]">
                  {p}
                </span>
              ))}
            </div>
          )}
          {entry.status === "error" && (
            <p className="mt-1 flex items-center gap-1 text-xs text-destructive">
              <AlertTriangle className="h-3 w-3" /> {entry.lastError}
            </p>
          )}
          {entry.errors.length > 0 && (
            <ul className="mt-1 list-disc pl-4 text-xs text-destructive">
              {entry.errors.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {entry.status === "needs-review" && (
            <Button size="sm" onClick={onReview} disabled={busy}>
              Review
            </Button>
          )}
          {m && entry.status !== "needs-review" && (
            <Button
              variant={on ? "secondary" : "default"}
              size="sm"
              disabled={busy}
              onClick={() => guard(() => (on ? manager.disable(entry.id) : manager.enable(entry.id)))}
            >
              {on ? "Turn off" : "Turn on"}
            </Button>
          )}
          {(m?.contributes.settings?.length ?? 0) > 0 && (
            <Button variant="ghost" size="sm" onClick={() => setOpen((v) => !v)}>
              Settings
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            title="Uninstall"
            disabled={busy}
            onClick={() =>
              guard(async () => {
                if (!(await confirm(`Uninstall "${m?.name ?? entry.id}"? Its folder and stored data are deleted.`, { kind: "warning" }))) return;
                await manager.remove(entry.id);
                notify(`${m?.name ?? entry.id} uninstalled`, "success");
              })
            }
          >
            <Trash2 />
          </Button>
        </div>
      </div>
      {open && m && rec && (
        <div className="mt-3 space-y-2 rounded-md border bg-background p-3">
          {(m.contributes.settings ?? []).map((s) => {
            const v = rec.values?.[s.key] ?? s.default;
            const set = (x: unknown) => manager.setPluginValues(entry.id, { ...(rec.values ?? {}), [s.key]: x });
            return (
              <label key={s.key} className="flex items-center justify-between gap-4 text-sm">
                <span>{s.label}</span>
                {s.type === "boolean" ? (
                  <input type="checkbox" className="accent-[var(--primary)]" checked={!!v} onChange={(e) => set(e.target.checked)} />
                ) : s.type === "number" ? (
                  <input
                    type="number"
                    className={cn(inputClass, "w-32")}
                    value={Number(v)}
                    onChange={(e) => set(Number(e.target.value))}
                  />
                ) : (
                  <input className={cn(inputClass, "w-56")} value={String(v)} onChange={(e) => set(e.target.value)} />
                )}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
