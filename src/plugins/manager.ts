/**
 * Plugin manager (D2): the one object that knows which plugins exist, which
 * the person has approved, and which are running.
 *
 * Trust model: nothing runs until the person approved that exact content. The
 * approval is a hash of `manifest.json` + the script (`approvedHash`); change a
 * byte (a store update, an AI `plugins.update`, a hand edit) and the plugin
 * drops back to "needs review". Proposals from an AI or the store are held in
 * memory and only written to disk when the person approves them in the review
 * dialog, so a rejected proposal leaves no trace.
 *
 * No React / Tauri imports: the disk, storage, network and sandbox are injected.
 */
import type { ActionRegistry } from "../lib/actions";
import { PluginInstance, type HostEnv, type SandboxFactory, type UiColumn, type UiItem } from "./host";
import { contentHash, parseManifest, type PluginManifest } from "./manifest";

export interface InstalledFiles {
  id: string;
  manifest: string;
  code: string | null;
}

export interface PluginBackend {
  list(): Promise<InstalledFiles[]>;
  write(id: string, manifest: string, code: string | null): Promise<void>;
  remove(id: string): Promise<void>;
  clearStorage(id: string): void;
}

export interface PluginRecord {
  enabled: boolean;
  approvedHash: string;
  /** Per-plugin settings values (contributes.settings). */
  values?: Record<string, unknown>;
}

export type PluginRecords = Record<string, PluginRecord>;

export type PluginStatus = "running" | "starting" | "error" | "disabled" | "needs-review" | "invalid" | "theme";

export interface PluginEntry {
  id: string;
  manifestText: string;
  code: string | null;
  manifest: PluginManifest | null;
  errors: string[];
  hash: string;
  status: PluginStatus;
  lastError: string;
}

export type ProposalSource = "ai" | "store" | "user" | "folder";

export interface Proposal {
  id: string;
  source: ProposalSource;
  manifestText: string;
  code: string | null;
  manifest: PluginManifest;
  /** Set when this replaces an installed plugin. */
  previous: { version: string; manifestText: string; code: string | null } | null;
}

export type ProposeResult =
  | { status: "pending_review"; id: string; message: string }
  | { status: "invalid"; errors: string[] };

export interface ManagerDeps {
  backend: PluginBackend;
  registry: ActionRegistry;
  env: HostEnv;
  sandbox: SandboxFactory;
  getRecords: () => PluginRecords;
  setRecords: (next: PluginRecords) => void;
}

export class PluginManager {
  entries: PluginEntry[] = [];
  proposals: Proposal[] = [];
  private instances = new Map<string, PluginInstance>();
  private listeners = new Set<() => void>();
  private version = 0;

  constructor(private readonly d: ManagerDeps) {}

  subscribe = (cb: () => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };
  /** Changes whenever anything visible changed (for useSyncExternalStore). */
  getVersion = () => this.version;
  private emit() {
    this.version++;
    for (const l of this.listeners) l();
  }

  // ---- reading -----------------------------------------------------------

  /** Re-reads the plugins folder and (re)starts what is enabled and approved. */
  async refresh(): Promise<void> {
    const files = await this.d.backend.list();
    const records = this.d.getRecords();
    const next: PluginEntry[] = [];
    for (const f of files) {
      const parsed = parseManifest(f.manifest);
      const hash = await contentHash(f.manifest, f.code);
      if (!parsed.ok) {
        next.push({ id: f.id, manifestText: f.manifest, code: f.code, manifest: null, errors: parsed.errors, hash, status: "invalid", lastError: "" });
        continue;
      }
      const m = parsed.manifest;
      const errors: string[] = [];
      if (m.id !== f.id) errors.push(`manifest id "${m.id}" does not match its folder "${f.id}"`);
      if (m.entry && f.code === null) errors.push(`entry "${m.entry}" is missing`);
      next.push({
        id: f.id, manifestText: f.manifest, code: f.code, manifest: errors.length ? null : m, errors, hash,
        status: errors.length ? "invalid" : "disabled", lastError: "",
      });
    }
    this.entries = next;

    // Stop what is gone, changed, or no longer approved/enabled.
    for (const [id, inst] of [...this.instances]) {
      const e = next.find((x) => x.id === id);
      const rec = records[id];
      if (!e || !e.manifest || !rec?.enabled || rec.approvedHash !== e.hash) {
        inst.stop();
        this.instances.delete(id);
      }
    }
    await Promise.all(next.map((e) => this.ensureRunning(e, records)));
    this.recomputeStatus();
    this.emit();
  }

  private async ensureRunning(e: PluginEntry, records: PluginRecords) {
    if (!e.manifest || e.manifest.kind === "theme") return;
    const rec = records[e.id];
    if (!rec?.enabled || rec.approvedHash !== e.hash) return;
    if (this.instances.has(e.id)) return;
    const inst = new PluginInstance(e.manifest, e.code, this.d.env, this.d.sandbox, rec.values ?? {});
    inst.onChange = () => {
      this.recomputeStatus();
      this.emit();
    };
    this.instances.set(e.id, inst);
    await inst.start();
  }

  private recomputeStatus() {
    const records = this.d.getRecords();
    for (const e of this.entries) {
      if (!e.manifest) {
        e.status = "invalid";
        continue;
      }
      if (e.manifest.kind === "theme") {
        e.status = "theme";
        continue;
      }
      const rec = records[e.id];
      const inst = this.instances.get(e.id);
      if (!rec || rec.approvedHash !== e.hash) e.status = "needs-review";
      else if (inst?.state === "error") {
        e.status = "error";
        e.lastError = inst.lastError;
      } else if (inst?.state === "starting") e.status = "starting";
      else if (inst && rec.enabled) e.status = "running";
      else e.status = "disabled";
    }
  }

  entry(id: string): PluginEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  // ---- contributions ------------------------------------------------------

  buttons(): UiItem[] {
    return [...this.instances.values()].flatMap((i) => i.buttons);
  }
  menuItems(): UiItem[] {
    return [...this.instances.values()].flatMap((i) => i.menuItems);
  }
  columns(): UiColumn[] {
    return [...this.instances.values()].flatMap((i) => i.columns);
  }
  instance(id: string): PluginInstance | undefined {
    return this.instances.get(id);
  }
  running(): PluginInstance[] {
    return [...this.instances.values()].filter((i) => i.state === "running");
  }

  pushSelection(paths: string[]) {
    for (const i of this.instances.values()) i.pushSelection(paths);
  }

  /**
   * True when some enabled plugin, approved at its current content, declares
   * `requires.engines` containing `engineId`. Gates the host actions that drive
   * that engine (e.g. `presets.*` need the Preset Translator plugin).
   */
  hasEnabledEngine(engineId: string): boolean {
    const records = this.d.getRecords();
    return this.entries.some((e) => {
      const rec = records[e.id];
      return (
        !!e.manifest &&
        !!rec?.enabled &&
        rec.approvedHash === e.hash &&
        !!e.manifest.requires?.engines?.some((x) => x.id === engineId)
      );
    });
  }

  // ---- the person's decisions ----------------------------------------------

  async enable(id: string): Promise<void> {
    const e = this.entry(id);
    if (!e?.manifest) throw new Error(`No valid plugin "${id}"`);
    const rec = this.d.getRecords()[id];
    if (!rec || rec.approvedHash !== e.hash)
      throw new Error(`"${e.manifest.name}" has not been reviewed yet. Open Plugins in the app and approve it first.`);
    this.setRecord(id, { ...rec, enabled: true });
    await this.refresh();
  }

  async disable(id: string): Promise<void> {
    const rec = this.d.getRecords()[id];
    if (rec) this.setRecord(id, { ...rec, enabled: false });
    await this.refresh();
  }

  async remove(id: string): Promise<void> {
    this.instances.get(id)?.stop();
    this.instances.delete(id);
    await this.d.backend.remove(id);
    this.d.backend.clearStorage(id);
    const { [id]: _gone, ...rest } = this.d.getRecords();
    this.d.setRecords(rest);
    await this.refresh();
  }

  setPluginValues(id: string, values: Record<string, unknown>) {
    const rec = this.d.getRecords()[id];
    if (!rec) return;
    this.setRecord(id, { ...rec, values });
    this.instances.get(id)?.setSettings(values);
    this.emit();
  }

  private setRecord(id: string, rec: PluginRecord) {
    this.d.setRecords({ ...this.d.getRecords(), [id]: rec });
  }

  // ---- proposals (install / AI create / update) ------------------------------

  /**
   * Stages a plugin for review. Validates first (an AI that sent a broken
   * manifest gets the problems back to fix). Nothing is written or run.
   */
  async propose(manifestText: string, code: string | null, source: ProposalSource): Promise<ProposeResult> {
    const parsed = parseManifest(manifestText);
    if (!parsed.ok) return { status: "invalid", errors: parsed.errors };
    const m = parsed.manifest;
    const problems: string[] = [];
    if (m.entry && code === null) problems.push(`entry "${m.entry}" needs code`);
    if (!m.entry && code !== null && code.trim()) problems.push("code was given but the manifest has no entry");
    if (problems.length) return { status: "invalid", errors: problems };
    // Same-segment collision (hide-genre vs hideGenre can't both exist: ids have no capitals, but a-b vs ab can't collide either).
    const existing = this.entry(m.id);
    const previous =
      existing && existing.manifest
        ? { version: existing.manifest.version, manifestText: existing.manifestText, code: existing.code }
        : null;
    const proposal: Proposal = { id: m.id, source, manifestText, code, manifest: m, previous };
    this.proposals = [...this.proposals.filter((p) => p.id !== m.id), proposal];
    this.emit();
    return {
      status: "pending_review",
      id: m.id,
      message: `"${m.name}" is waiting for the person to review its permissions and code in Plugins. It does nothing until they approve it.`,
    };
  }

  /** The person approved the staged plugin: write it, record the approval, start it. */
  async approve(id: string): Promise<void> {
    const p = this.proposals.find((x) => x.id === id);
    if (!p) throw new Error("Nothing to approve");
    await this.d.backend.write(p.id, p.manifestText, p.code);
    const hash = await contentHash(p.manifestText, p.code);
    const old = this.d.getRecords()[p.id];
    const values: Record<string, unknown> = { ...(old?.values ?? {}) };
    for (const s of p.manifest.contributes.settings ?? []) if (!(s.key in values)) values[s.key] = s.default;
    this.setRecord(p.id, { enabled: p.manifest.kind === "plugin", approvedHash: hash, values });
    this.proposals = this.proposals.filter((x) => x.id !== id);
    await this.refresh();
  }

  reject(id: string) {
    this.proposals = this.proposals.filter((x) => x.id !== id);
    this.emit();
  }

  /** Review of a plugin that is already on disk (hand-copied folder, or content changed). */
  async approveInstalled(id: string): Promise<void> {
    const e = this.entry(id);
    if (!e?.manifest) throw new Error("This plugin is not valid");
    const old = this.d.getRecords()[id];
    const values: Record<string, unknown> = { ...(old?.values ?? {}) };
    for (const s of e.manifest.contributes.settings ?? []) if (!(s.key in values)) values[s.key] = s.default;
    this.setRecord(id, { enabled: e.manifest.kind === "plugin", approvedHash: e.hash, values });
    await this.refresh();
  }

  stopAll() {
    for (const i of this.instances.values()) i.stop();
    this.instances.clear();
  }
}
