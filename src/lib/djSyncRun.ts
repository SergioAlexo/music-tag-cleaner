/**
 * Glue between the pure engine (`djSync.ts`) and the Tauri commands in
 * `commands/dj_sync.rs`: read both libraries, plan, apply. Used by the sync
 * dialog, the app-start check and the registered actions.
 */
import { invoke } from "@tauri-apps/api/core";
import type { DjSnapshot } from "./djPlaylists";
import { buildRekordboxTreeXml } from "./djPlaylists";
import {
  buildRekordboxExport,
  buildSide,
  DEFAULT_SYNC_SETTINGS,
  finalize,
  makeCanon,
  planSync,
  type Canon,
  type RawMeta,
  type Selection,
  type SyncOutput,
  type SyncPlan,
  type SyncSettings,
  type SyncState,
  type SideState,
} from "./djSync";

interface SyncRead {
  snapshot: DjSnapshot;
  meta: RawMeta[];
}
interface StateRows {
  rekordbox: string | null;
  mixxx: string | null;
  savedAt: number | null;
}

/** What is read from disk (independent of the sync options). */
export interface RawSync {
  rb: SyncRead;
  mx: SyncRead;
  maps: [string, string][];
  state: StateRows;
  savedBase: { rb: SyncState; mx: SyncState; target: SyncSettings["mixxxTarget"] } | null;
}

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Same overrides the Playlists page uses for the database locations. */
function dbPath(source: "rekordbox" | "mixxx"): string | null {
  return lsGet(`playlists.path.${source}`);
}

export function normalizeSettings(s: SyncSettings | undefined): SyncSettings {
  return { ...DEFAULT_SYNC_SETTINGS, ...(s ?? {}), dirs: { ...DEFAULT_SYNC_SETTINGS.dirs, ...(s?.dirs ?? {}) } };
}

export async function readRaw(): Promise<RawSync> {
  const [rb, mx, maps, state] = await Promise.all([
    invoke<SyncRead>("dj_sync_read", { source: "rekordbox", dbPath: dbPath("rekordbox") }),
    invoke<SyncRead>("dj_sync_read", { source: "mixxx", dbPath: dbPath("mixxx") }),
    invoke<[string, string][]>("dj_sync_move_maps"),
    invoke<StateRows>("dj_sync_state_load"),
  ]);
  let savedBase: RawSync["savedBase"] = null;
  try {
    if (state.rekordbox && state.mixxx) {
      const a = JSON.parse(state.rekordbox);
      const b = JSON.parse(state.mixxx);
      if (a?.state && b?.state) savedBase = { rb: a.state, mx: b.state, target: a.target ?? "playlist" };
    }
  } catch {
    savedBase = null; // unreadable history = first sync again (which never deletes)
  }
  return { rb, mx, maps, state, savedBase };
}

export interface LoadedPlan {
  plan: SyncPlan;
  rb: SideState;
  mx: SideState;
  canon: Canon;
  settings: SyncSettings;
}

/** Pure given the raw reads, so the dialog re-plans instantly when options change. */
export function planFromRaw(raw: RawSync, settingsIn: SyncSettings): LoadedPlan {
  const settings = normalizeSettings(settingsIn);
  const canon = makeCanon(raw.maps);
  const rb = buildSide("rekordbox", raw.rb.snapshot, raw.rb.meta, canon, settings.mixxxTarget);
  const mx = buildSide("mixxx", raw.mx.snapshot, raw.mx.meta, canon, settings.mixxxTarget);
  // History made for playlists is meaningless against crates (and vice versa):
  // start over rather than read every list as added/removed.
  const base = raw.savedBase && raw.savedBase.target === settings.mixxxTarget ? raw.savedBase : null;
  const plan = planSync({ baseRb: base?.rb ?? null, baseMx: base?.mx ?? null, rb, mx, settings, canon });
  return { plan, rb, mx, canon, settings };
}

export interface ApplyReport {
  mixxxLists: number;
  mixxxTracks: number;
  relocated: number;
  bpmSkippedGrid: number;
  unmatched: number;
  xmlPath: string | null;
  xmlPlaylists: number;
  xmlTracks: number;
  backupNote: string;
}

export function wantsXml(out: SyncOutput): boolean {
  return out.toRekordbox.lists.some((l) => l.action !== "delete") || out.toRekordbox.meta.length > 0;
}

/**
 * Writes the Mixxx side (one backed-up transaction), the rekordbox.xml (when
 * `xmlDest` is given and there is anything for Rekordbox), and finally the
 * new history. History is saved last so a failure leaves the changes pending.
 */
export async function applyPlan(
  loaded: LoadedPlan,
  sel: Selection,
  xmlDest: string | null,
): Promise<ApplyReport> {
  const out = finalize(loaded.plan, sel, loaded.settings.relocate);
  const report: ApplyReport = {
    mixxxLists: out.counts.mixxxLists,
    mixxxTracks: out.counts.mixxxTracks,
    relocated: 0,
    bpmSkippedGrid: 0,
    unmatched: 0,
    xmlPath: null,
    xmlPlaylists: 0,
    xmlTracks: 0,
    backupNote: "",
  };
  if (out.mixxxOps.length || out.mixxxMeta.length || out.relocations.length) {
    const r = await invoke<{
      ops: { unmatched: string[] }[];
      relocated: number;
      bpmSkippedGrid: number;
    }>("dj_sync_apply_mixxx", {
      ops: out.mixxxOps,
      extras: { relocations: out.relocations, meta: out.mixxxMeta },
      dbPath: dbPath("mixxx"),
    });
    report.relocated = r.relocated;
    report.bpmSkippedGrid = r.bpmSkippedGrid;
    report.unmatched = r.ops.reduce((n, o) => n + o.unmatched.length, 0);
    report.backupNote = "A backup of mixxxdb.sqlite was made next to it first.";
  }
  const exp = xmlDest ? buildRekordboxExport(out, loaded.rb, loaded.mx) : null;
  if (exp && xmlDest) {
    const tracks = [...exp.tracks];
    await invoke("write_text_file", { path: xmlDest, contents: buildRekordboxTreeXml(exp.nodes, tracks, exp.options) });
    report.xmlPath = xmlDest;
    report.xmlPlaylists = exp.playlists;
    report.xmlTracks = exp.trackUpdates;
  }
  const target = loaded.settings.mixxxTarget;
  await invoke("dj_sync_state_save", {
    rekordbox: JSON.stringify({ target, state: out.nextBaseRb }),
    mixxx: JSON.stringify({ target, state: out.nextBaseMx }),
  });
  return report;
}

export function describeReport(r: ApplyReport): string {
  const bits: string[] = [];
  if (r.mixxxLists || r.mixxxTracks) bits.push(`Mixxx: ${r.mixxxLists} playlists, ${r.mixxxTracks} tracks updated`);
  if (r.relocated) bits.push(`${r.relocated} moved files re-pointed`);
  if (r.bpmSkippedGrid) bits.push(`${r.bpmSkippedGrid} BPMs left to Mixxx's beat grid`);
  if (r.unmatched) bits.push(`${r.unmatched} tracks not in Mixxx's library were skipped`);
  if (r.xmlPath) bits.push(`Rekordbox: ${r.xmlPlaylists} playlists, ${r.xmlTracks} track updates saved to ${r.xmlPath} (import it in Rekordbox)`);
  return bits.length ? bits.join("; ") : "Nothing to change";
}

/** Counts for a quiet app-start check. */
export async function checkForChanges(settings: SyncSettings): Promise<{ toMixxx: number; toRekordbox: number; conflicts: number }> {
  const raw = await readRaw();
  const { plan } = planFromRaw(raw, settings);
  return {
    toMixxx: plan.lists.filter((l) => l.target === "mixxx").length + plan.meta.filter((m) => m.target === "mixxx").length,
    toRekordbox: plan.lists.filter((l) => l.target === "rekordbox").length + plan.meta.filter((m) => m.target === "rekordbox").length,
    conflicts: plan.conflicts.length,
  };
}
