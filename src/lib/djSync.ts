/**
 * Rekordbox <-> Mixxx sync: the diff engine. Pure (no Tauri), so it is unit
 * tested; `commands/dj_sync.rs` supplies the data and performs the Mixxx writes.
 *
 * Model. Each side is reduced to a `SyncState`: named lists of track keys, and
 * per-track metadata, both keyed by a CANONICAL track key (the normalized path,
 * run through B4's old->new move maps so a file moved on disk still matches
 * while either program still points at its old location). The state saved after
 * the last sync is that side's BASE. A change is "this side differs from its
 * own base", never "the sides differ": that is what lets one side's edit
 * propagate without clobbering the other's, and what makes two edits of the
 * same thing a real conflict.
 *
 * Rekordbox is READ-ONLY: anything bound for it is exported as a rekordbox.xml
 * the owner imports. Such changes deliberately stay *pending* (the bases are not
 * advanced), so they are offered again until Rekordbox actually shows them, at
 * which point both sides agree and everything settles by itself. Changes bound
 * for Mixxx are written, and their bases advance.
 */
import { sameKey } from "./keys";
import {
  nodePath,
  pathKey,
  tracksOfNode,
  type DjOp,
  type DjSnapshot,
  type DjTrack,
  type XmlNode,
  type XmlOptions,
} from "./djPlaylists";

export type Side = "rekordbox" | "mixxx";
export type Dir = "off" | "rb2mx" | "mx2rb" | "both";

export const SYNC_GROUPS = ["playlists", "bpm", "key", "rating", "plays", "comment", "color"] as const;
export type SyncGroup = (typeof SYNC_GROUPS)[number];
export type MetaField = Exclude<SyncGroup, "playlists">;
export const META_FIELDS: MetaField[] = ["bpm", "key", "rating", "plays", "comment", "color"];

export const GROUP_LABEL: Record<SyncGroup, string> = {
  playlists: "Playlists and folders",
  bpm: "BPM",
  key: "Key",
  rating: "Rating",
  plays: "Play count",
  comment: "Comment",
  color: "Track colour",
};

export interface SyncSettings {
  dirs: Record<SyncGroup, Dir>;
  /** Mixxx has playlists (ordered) and crates (unordered); lists land in this one. */
  mixxxTarget: "playlist" | "crate";
  /** Wins when both sides differ and there is no history to say who changed it. */
  master: Side;
  /** Point Mixxx at files B4 moved (it would otherwise keep the old path). */
  relocate: boolean;
  /** Look for changes when the app starts (never applies anything by itself). */
  onStart: boolean;
}

export const DEFAULT_SYNC_SETTINGS: SyncSettings = {
  dirs: { playlists: "both", bpm: "rb2mx", key: "rb2mx", rating: "both", plays: "both", comment: "off", color: "off" },
  mixxxTarget: "playlist",
  master: "rekordbox",
  relocate: true,
  onStart: false,
};

/** Separator between folder names in a list's full name (Mixxx has no folders). */
export const FOLDER_SEP = " / ";

// --- state -----------------------------------------------------------------

export interface TrackMeta {
  bpm: number;
  key: string;
  rating: number;
  plays: number;
  comment: string;
  /** `#rrggbb` or "". */
  color: string;
}

export interface SyncList {
  /** Display name; folders are joined with FOLDER_SEP. */
  name: string;
  /** Canonical track keys. */
  members: string[];
  /** Mixxx crates and the like: order carries no meaning. */
  unordered?: boolean;
  /** Rekordbox smart list, materialized: Rekordbox's rules own its members. */
  smart?: boolean;
  /** The side's own id (Mixxx `p:3` / `c:1`); current state only. */
  ref?: string;
}

export interface SyncState {
  /** Keyed by lower-cased name. */
  lists: Record<string, SyncList>;
  /** Keyed by canonical track key. Base states may hold only some fields. */
  meta: Record<string, Partial<TrackMeta>>;
}

/** Current state plus what is only needed to act on it (never persisted). */
export interface SideState extends SyncState {
  meta: Record<string, TrackMeta>;
  /** canonical key -> the path this side actually stores. */
  paths: Record<string, string>;
  /** canonical key -> the track (for the rekordbox.xml). */
  info: Record<string, DjTrack>;
  /** Mixxx: tracks whose BPM is owned by a beat grid. */
  grid: Set<string>;
  /** Rekordbox smart lists with rules we can't evaluate (left out). */
  skipped: string[];
}

export function emptyState(): SyncState {
  return { lists: {}, meta: {} };
}

export const listKey = (name: string) => name.trim().toLowerCase();

// --- canonical keys (B4 move maps) -------------------------------------------

export interface Canon {
  /** Canonical key of a path (follows old->new chains). */
  key(p: string): string;
  /** The newest known spelling of the path, when it was moved. */
  moved(p: string): string | null;
}

export function makeCanon(maps: [string, string][]): Canon {
  const next = new Map<string, string>();
  for (const [from, to] of maps) {
    if (pathKey(from) !== pathKey(to)) next.set(pathKey(from), to);
  }
  const final = (p: string): { key: string; path: string } => {
    let key = pathKey(p);
    let path = p;
    for (let i = 0; i < 16; i++) {
      const n = next.get(key);
      if (!n) break;
      path = n;
      key = pathKey(n);
    }
    return { key, path };
  };
  return {
    key: (p) => final(p).key,
    moved: (p) => {
      const f = final(p);
      return f.key === pathKey(p) ? null : f.path;
    },
  };
}

// --- building a side's state ---------------------------------------------------

export interface RawMeta {
  path: string;
  bpm: number;
  key: string;
  rating: number;
  plays: number;
  comment: string;
  color: string;
  grid: boolean;
}

export function sameMembers(a: SyncList, b: SyncList): boolean {
  if (a.members.length !== b.members.length) return false;
  if (a.unordered || b.unordered) {
    const x = [...a.members].sort();
    const y = [...b.members].sort();
    return x.every((k, i) => k === y[i]);
  }
  return a.members.every((k, i) => k === b.members[i]);
}

export function buildSide(
  side: Side,
  snap: DjSnapshot,
  meta: RawMeta[],
  canon: Canon,
  mixxxTarget: "playlist" | "crate",
  now = Date.now(),
): SideState {
  const st: SideState = { lists: {}, meta: {}, paths: {}, info: {}, grid: new Set(), skipped: [] };
  for (const m of meta) {
    const k = canon.key(m.path);
    if (st.meta[k]) continue;
    st.meta[k] = {
      bpm: Math.round((m.bpm || 0) * 100) / 100,
      key: m.key ?? "",
      rating: m.rating | 0,
      plays: m.plays | 0,
      comment: (m.comment ?? "").trim(),
      color: (m.color ?? "").toLowerCase(),
    };
    st.paths[k] = m.path;
    if (m.grid) st.grid.add(k);
  }
  for (const t of snap.tracks) {
    const k = canon.key(t.path);
    if (st.meta[k] && !st.info[k]) st.info[k] = t;
  }
  const add = (name: string, node: DjSnapshot["nodes"][number], tracks: DjTrack[], extra: Partial<SyncList>) => {
    const key = listKey(name);
    if (!key || st.lists[key]) return;
    const members: string[] = [];
    for (const t of tracks) {
      const k = canon.key(t.path);
      if (st.meta[k]) members.push(k);
    }
    st.lists[key] = { name, members: extra.unordered ? members.sort() : members, ...extra, ref: node.id };
  };
  if (side === "rekordbox") {
    for (const n of snap.nodes) {
      if (n.kind === "folder") continue;
      const r = tracksOfNode(snap, n, now);
      const name = nodePath(snap.nodes, n.id).join(FOLDER_SEP);
      if (n.kind === "smart" && r.partial) {
        st.skipped.push(name);
        continue;
      }
      add(name, n, r.tracks, n.kind === "smart" ? { smart: true } : {});
    }
  } else {
    const want = mixxxTarget === "crate" ? "crate" : "playlist";
    for (const n of snap.nodes) {
      // Mixxx `[smart]` crates are MTC's pushed smart lists (C1); they belong to
      // MTC, not to this sync.
      if (n.kind !== want) continue;
      add(n.name, n, tracksOfNode(snap, n, now).tracks, want === "crate" ? { unordered: true } : {});
    }
  }
  return st;
}

/** What to tell Mixxx about moved files: paths it stores that B4 has since moved. */
export function relocations(mx: SideState, canon: Canon): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  for (const p of Object.values(mx.paths)) {
    const to = canon.moved(p);
    if (to) out.push({ from: p, to });
  }
  return out;
}

/** Persisted form: no refs, paths, track info. */
export function toBase(st: SyncState): SyncState {
  const lists: SyncState["lists"] = {};
  for (const [k, l] of Object.entries(st.lists)) {
    lists[k] = { name: l.name, members: l.members, ...(l.unordered ? { unordered: true } : {}), ...(l.smart ? { smart: true } : {}) };
  }
  return { lists, meta: st.meta };
}

// --- plan ----------------------------------------------------------------------

export interface ListEffect {
  id: string;
  target: Side;
  action: "create" | "update" | "delete" | "rename";
  key: string;
  name: string;
  /** rename: the old name. */
  from?: string;
  /** What the target will hold afterwards (canonical keys). */
  members: string[];
  ref?: string;
  /** Source tracks the target's library doesn't have. */
  unmatched: number;
  added: number;
  removed: number;
  reordered: boolean;
  /** For `rename` only: the key the list used to have (to retire its base). */
  fromKey?: string;
}

export interface MetaEffect {
  target: Side;
  key: string;
  field: MetaField;
  from: string | number;
  to: string | number;
  /** Why no question was asked: first sync, a blank filled, play counts. */
  auto?: "master" | "fill" | "max";
}

export interface Conflict {
  id: string;
  scope: "list" | "meta";
  group: SyncGroup;
  label: string;
  rekordbox: string;
  mixxx: string;
  /** What choosing Rekordbox / Mixxx would do. */
  ifRekordbox: ListEffect | MetaEffect | null;
  ifMixxx: ListEffect | MetaEffect | null;
}

interface ListOutcome {
  key: string;
  effect: ListEffect | null;
  conflict: Conflict | null;
  /** Nothing to do for this key: both bases may simply catch up. */
  settleNow: boolean;
}

interface MetaOutcome {
  key: string;
  field: MetaField;
  effect: MetaEffect | null;
  conflict: Conflict | null;
  settleNow: boolean;
  /** Settle values when `effect`/pick is applied to Mixxx (the value Mixxx ends up with). */
  mxFinal?: string | number;
}

export interface SyncPlan {
  firstSync: boolean;
  lists: ListEffect[];
  meta: MetaEffect[];
  conflicts: Conflict[];
  /** Changes on a side that no enabled direction carries anywhere. */
  ignored: number;
  /** Mixxx beat-grid BPMs left alone. */
  gridLocked: number;
  skippedSmart: string[];
  onlyOneSide: number;
  /** Internals for `finalize`. */
  _lists: ListOutcome[];
  _meta: MetaOutcome[];
  _rb: SideState;
  _mx: SideState;
  _baseRb: SyncState;
  _baseMx: SyncState;
  _vRb: Record<string, SyncList>;
  _vMx: Record<string, SyncList>;
  _settings: SyncSettings;
  _canon: Canon;
}

const canRb2Mx = (d: Dir) => d === "rb2mx" || d === "both";
const canMx2Rb = (d: Dir) => d === "mx2rb" || d === "both";

type Delta = "none" | "add" | "remove" | "change";

function classify(b: SyncList | undefined, c: SyncList | undefined): Delta {
  if (!b && !c) return "none";
  if (!b) return "add";
  if (!c) return "remove";
  return sameMembers(b, c) ? "none" : "change";
}

/** Source members the target has, plus target members the source never could have. */
function mergeMembers(
  src: SyncList,
  dst: SyncList | undefined,
  srcLib: Record<string, unknown>,
  dstLib: Record<string, unknown>,
  unordered: boolean,
): { members: string[]; unmatched: number } {
  const seen = new Set<string>();
  const out: string[] = [];
  let unmatched = 0;
  for (const k of src.members) {
    if (!dstLib[k]) {
      unmatched++;
      continue;
    }
    if (unordered && seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  for (const k of dst?.members ?? []) {
    if (!srcLib[k] && !(unordered && seen.has(k))) {
      seen.add(k);
      out.push(k);
    }
  }
  return { members: unordered ? out.sort() : out, unmatched };
}

function countChange(before: string[], after: string[]) {
  const b = new Set(before);
  const a = new Set(after);
  let added = 0;
  let removed = 0;
  for (const k of a) if (!b.has(k)) added++;
  for (const k of b) if (!a.has(k)) removed++;
  const common = before.filter((k) => a.has(k));
  const commonAfter = after.filter((k) => b.has(k));
  return { added, removed, reordered: common.some((k, i) => k !== commonAfter[i]) };
}

const isEmpty = (v: string | number) => v === "" || v === 0;

export function eqField(f: MetaField, a: string | number | undefined, b: string | number | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  switch (f) {
    case "bpm":
      return Math.abs(Number(a) - Number(b)) < 0.05;
    case "key":
      return sameKey(String(a), String(b));
    case "rating":
    case "plays":
      return Number(a) === Number(b);
    case "comment":
      return String(a).trim() === String(b).trim();
    case "color":
      return String(a).toLowerCase() === String(b).toLowerCase();
  }
}

function describe(f: MetaField, v: string | number | undefined): string {
  if (v === undefined || v === "" || v === 0) return "(none)";
  if (f === "rating") return `${v} stars`;
  if (f === "bpm") return Number(v).toFixed(2);
  return String(v);
}

export function describeValue(f: MetaField, v: string | number | undefined) {
  return describe(f, v);
}

export interface PlanInput {
  baseRb: SyncState | null;
  baseMx: SyncState | null;
  rb: SideState;
  mx: SideState;
  settings: SyncSettings;
  /** The move maps the sides were built with (used to point Mixxx at moved files). */
  canon?: Canon;
}

export function planSync({ baseRb, baseMx, rb, mx, settings, canon }: PlanInput): SyncPlan {
  const bRb = baseRb ?? emptyState();
  const bMx = baseMx ?? emptyState();
  const firstSync = !baseRb || !baseMx;
  const plan: SyncPlan = {
    firstSync,
    lists: [],
    meta: [],
    conflicts: [],
    ignored: 0,
    gridLocked: 0,
    skippedSmart: rb.skipped,
    onlyOneSide: 0,
    _lists: [],
    _meta: [],
    _rb: rb,
    _mx: mx,
    _baseRb: bRb,
    _baseMx: bMx,
    _vRb: {},
    _vMx: {},
    _settings: settings,
    _canon: canon ?? makeCanon([]),
  };
  if (settings.dirs.playlists !== "off") planLists(plan, bRb, bMx);
  planMeta(plan, bRb, bMx);
  for (const o of plan._lists) {
    if (o.effect) plan.lists.push(o.effect);
    if (o.conflict) plan.conflicts.push(o.conflict);
  }
  for (const o of plan._meta) {
    if (o.effect) plan.meta.push(o.effect);
    if (o.conflict) plan.conflicts.push(o.conflict);
  }
  return plan;
}

function planLists(plan: SyncPlan, bRb: SyncState, bMx: SyncState) {
  const dir = plan._settings.dirs.playlists;
  const rb = plan._rb;
  const mx = plan._mx;
  // Working copies: renames are applied virtually so the key-level merge below
  // sees one list instead of a delete plus an add.
  const bR = { ...bRb.lists };
  const bM = { ...bMx.lists };
  const cR = { ...rb.lists };
  const cM = { ...mx.lists };
  const renames = new Map<string, { from: string; target: Side }>();

  const move = (rec: Record<string, SyncList>, from: string, to: string, name: string) => {
    const l = rec[from];
    if (!l) return;
    delete rec[from];
    rec[to] = { ...l, name };
  };

  const detect = (
    side: Side,
    bS: Record<string, SyncList>,
    cS: Record<string, SyncList>,
    bO: Record<string, SyncList>,
    cO: Record<string, SyncList>,
    allowed: boolean,
  ) => {
    if (!allowed) return;
    const removed = Object.keys(bS).filter((k) => !cS[k]);
    const added = Object.keys(cS).filter((k) => !bS[k]);
    const taken = new Set<string>();
    for (const to of added) {
      const c = cS[to];
      if (!c.members.length) continue;
      const matches = removed.filter((f) => !taken.has(f) && sameMembers(bS[f], c));
      if (matches.length !== 1) continue;
      const from = matches[0];
      // The other side must still hold the old list untouched, and not the new name.
      if (!cO[from] || cO[to] || !bO[from] || !sameMembers(bO[from], cO[from]) || cO[from].smart) continue;
      taken.add(from);
      const target: Side = side === "rekordbox" ? "mixxx" : "rekordbox";
      // Both sides now hold the list under the new name; S's base follows.
      move(bS, from, to, c.name);
      move(bO, from, to, c.name);
      move(cO, from, to, c.name);
      renames.set(to, { from, target });
    }
  };
  detect("rekordbox", bR, cR, bM, cM, canRb2Mx(dir));
  detect("mixxx", bM, cM, bR, cR, canMx2Rb(dir));
  plan._vRb = cR;
  plan._vMx = cM;

  const keys = new Set([...Object.keys(bR), ...Object.keys(bM), ...Object.keys(cR), ...Object.keys(cM)]);
  const mkEffect = (
    target: Side,
    key: string,
    src: SyncList | undefined,
    dst: SyncList | undefined,
    srcLib: Record<string, unknown>,
    dstLib: Record<string, unknown>,
  ): ListEffect | null => {
    const id = `l:${key}`;
    if (!src) {
      if (!dst) return null;
      return { id, target, action: "delete", key, name: dst.name, members: [], ref: dst.ref, unmatched: 0, added: 0, removed: dst.members.length, reordered: false };
    }
    const unordered = !!(dst?.unordered ?? (target === "mixxx" && plan._settings.mixxxTarget === "crate"));
    const { members, unmatched } = mergeMembers(src, dst, srcLib, dstLib, unordered);
    if (dst) {
      const probe: SyncList = { ...dst, members, unordered };
      if (sameMembers(dst, probe)) return null; // everything left is unmatched: nothing to write
    }
    const ch = countChange(dst?.members ?? [], members);
    return {
      id,
      target,
      action: dst ? "update" : "create",
      key,
      name: src.name,
      members,
      ref: dst?.ref,
      unmatched,
      ...ch,
    };
  };

  for (const key of [...keys].sort()) {
    const r = classify(bR[key], cR[key]);
    const m = classify(bM[key], cM[key]);
    const out: ListOutcome = { key, effect: null, conflict: null, settleNow: false };
    plan._lists.push(out);
    const rn = renames.get(key);
    const rbList = cR[key];
    const mxList = cM[key];

    const finish = () => {
      // A rename's item always exists, whatever the content did.
      if (!rn) return;
      if (out.effect && out.effect.target === rn.target) {
        out.effect.action = "rename";
        out.effect.from = (rn.target === "mixxx" ? mx : rb).lists[rn.from]?.name ?? rn.from;
        out.effect.fromKey = rn.from;
        return;
      }
      const dst = rn.target === "mixxx" ? mxList : rbList;
      out.effect = {
        id: `l:${key}`,
        target: rn.target,
        action: "rename",
        key,
        name: dst.name,
        from: (rn.target === "mixxx" ? mx : rb).lists[rn.from]?.name ?? rn.from,
        fromKey: rn.from,
        members: dst.members,
        ref: dst.ref,
        unmatched: 0,
        added: 0,
        removed: 0,
        reordered: false,
      };
      out.settleNow = false;
    };

    if ((r === "none" && m === "none") || (!rbList && !mxList) || (rbList && mxList && sameMembers(rbList, mxList))) {
      out.settleNow = !rn;
      finish();
      continue;
    }
    const toMx = () => mkEffect("mixxx", key, rbList, mxList, rb.meta, mx.meta);
    const toRb = () => {
      // A Rekordbox smart list is owned by its rules; nothing flows into it.
      if (rbList?.smart) return null;
      return mkEffect("rekordbox", key, mxList, rbList, mx.meta, rb.meta);
    };
    const bothDirs = canRb2Mx(dir) && canMx2Rb(dir);

    if (r !== "none" && m !== "none") {
      if (rbList?.smart) {
        if (canRb2Mx(dir)) out.effect = toMx();
        else plan.ignored++;
      } else if (bothDirs) {
        const a = toMx();
        const b = toRb();
        out.conflict = {
          id: `c:${out.key}:l`,
          scope: "list",
          group: "playlists",
          label: (rbList ?? mxList)?.name ?? key,
          rekordbox: rbList ? `${rbList.members.length} tracks` : "deleted",
          mixxx: mxList ? `${mxList.members.length} tracks` : "deleted",
          ifRekordbox: a,
          ifMixxx: b,
        };
        if (!a && !b) out.conflict = null;
      } else if (canRb2Mx(dir)) out.effect = toMx();
      else if (canMx2Rb(dir)) out.effect = toRb();
    } else if (r !== "none") {
      if (canRb2Mx(dir)) out.effect = toMx();
      else plan.ignored++;
    } else {
      if (canMx2Rb(dir) && !rbList?.smart) out.effect = toRb();
      else plan.ignored++;
    }
    if (!out.effect && !out.conflict && !rn) {
      // Nothing left to write (all unmatched, or an ignored direction): only a
      // fully-ignored change must stay pending.
      out.settleNow = !(r !== "none" && !canRb2Mx(dir)) && !(m !== "none" && !canMx2Rb(dir));
    }
    finish();
  }
}

function planMeta(plan: SyncPlan, bRb: SyncState, bMx: SyncState) {
  const { dirs, master } = plan._settings;
  const rb = plan._rb;
  const mx = plan._mx;
  const fields = META_FIELDS.filter((f) => dirs[f] !== "off");
  if (!fields.length) return;
  for (const key of Object.keys(rb.meta)) {
    const mm = mx.meta[key];
    if (!mm) {
      plan.onlyOneSide++;
      continue;
    }
    const rm = rb.meta[key];
    for (const f of fields) {
      const d = dirs[f];
      const rv = rm[f];
      const mv = mm[f];
      const out: MetaOutcome = { key, field: f, effect: null, conflict: null, settleNow: false };
      if (eqField(f, rv, mv)) {
        out.settleNow = true;
        plan._meta.push(out);
        continue;
      }
      const bR = bRb.meta[key]?.[f];
      const bM = bMx.meta[key]?.[f];
      const hasBase = bR !== undefined && bM !== undefined;
      const rCh = hasBase ? !eqField(f, bR, rv) : true;
      const mCh = hasBase ? !eqField(f, bM, mv) : true;
      const eff = (target: Side, auto?: MetaEffect["auto"]): MetaEffect => ({
        target,
        key,
        field: f,
        from: target === "mixxx" ? mv : rv,
        to: target === "mixxx" ? rv : mv,
        auto,
      });
      // Without history an empty value never overwrites a real one.
      const blankOver = (target: Side) => !hasBase && isEmpty(target === "mixxx" ? rv : mv);
      let chosen: MetaEffect | null = null;

      if (rCh && mCh) {
        if (d === "both") {
          if (!hasBase) {
            if (isEmpty(rv) && !isEmpty(mv)) chosen = eff("rekordbox", "fill");
            else if (isEmpty(mv) && !isEmpty(rv)) chosen = eff("mixxx", "fill");
            else chosen = eff(master === "rekordbox" ? "mixxx" : "rekordbox", "master");
          } else if (f === "plays") {
            chosen = eff(Number(rv) >= Number(mv) ? "mixxx" : "rekordbox", "max");
          } else {
            out.conflict = {
              id: `c:${key}:${f}`,
              scope: "meta",
              group: f,
              label: rb.info[key]?.title || mx.info[key]?.title || key,
              rekordbox: describe(f, rv),
              mixxx: describe(f, mv),
              ifRekordbox: eff("mixxx"),
              ifMixxx: eff("rekordbox"),
            };
          }
        } else chosen = eff(d === "rb2mx" ? "mixxx" : "rekordbox");
      } else if (rCh) {
        if (canRb2Mx(d)) chosen = eff("mixxx");
        else plan.ignored++;
      } else if (mCh) {
        if (canMx2Rb(d)) chosen = eff("rekordbox");
        else plan.ignored++;
      }
      if (chosen && blankOver(chosen.target)) chosen = null;
      // A beat grid owns the BPM in Mixxx: never written, and not offered again.
      if (chosen && f === "bpm" && chosen.target === "mixxx" && mx.grid.has(key)) {
        plan.gridLocked++;
        chosen = null;
        out.settleNow = true;
      }
      out.effect = chosen;
      if (chosen?.target === "mixxx") out.mxFinal = chosen.to;
      plan._meta.push(out);
    }
  }
}

// --- selection and output --------------------------------------------------------

export interface Selection {
  /** Whole groups the user switched off for this run. */
  skipGroups: Set<SyncGroup>;
  /** List effect ids (`l:<key>`) unticked in the preview. */
  skipIds: Set<string>;
  /** Conflict id -> which side wins; missing = leave alone. */
  picks: Record<string, Side | "skip">;
}

export const noSelection = (): Selection => ({ skipGroups: new Set(), skipIds: new Set(), picks: {} });

export interface SyncOutput {
  mixxxOps: DjOp[];
  mixxxMeta: {
    path: string;
    bpm?: number;
    key?: string;
    rating?: number;
    plays?: number;
    comment?: string;
    color?: string;
  }[];
  relocations: { from: string; to: string }[];
  /** Everything bound for Rekordbox, for the rekordbox.xml. */
  toRekordbox: { lists: ListEffect[]; meta: MetaEffect[] };
  nextBaseRb: SyncState;
  nextBaseMx: SyncState;
  counts: {
    mixxxLists: number;
    mixxxTracks: number;
    rekordboxLists: number;
    rekordboxTracks: number;
    relocations: number;
  };
}

const groupOf = (e: MetaEffect | ListEffect): SyncGroup => ("field" in e ? e.field : "playlists");

export function finalize(plan: SyncPlan, sel: Selection, wantRelocate = plan._settings.relocate): SyncOutput {
  const rb = plan._rb;
  const mx = plan._mx;
  const nbRb: SyncState = { lists: { ...plan._baseRb.lists }, meta: structuredCloneMeta(plan._baseRb.meta) };
  const nbMx: SyncState = { lists: { ...plan._baseMx.lists }, meta: structuredCloneMeta(plan._baseMx.meta) };
  const listFx: ListEffect[] = [];
  const metaFx: MetaEffect[] = [];

  const ok = (e: ListEffect | MetaEffect | null): e is ListEffect | MetaEffect =>
    !!e && !sel.skipGroups.has(groupOf(e)) && !("id" in e && sel.skipIds.has(e.id));

  const setList = (nb: SyncState, key: string, l: SyncList | undefined) => {
    if (l) nb.lists[key] = { name: l.name, members: l.members, ...(l.unordered ? { unordered: true } : {}), ...(l.smart ? { smart: true } : {}) };
    else delete nb.lists[key];
  };
  const resultOf = (e: ListEffect): SyncList | undefined =>
    e.action === "delete"
      ? undefined
      : { name: e.name, members: e.members, ...(plan._settings.mixxxTarget === "crate" && e.target === "mixxx" ? { unordered: true } : {}) };

  for (const o of plan._lists) {
    let eff: ListEffect | null = o.effect;
    if (o.conflict) {
      const pick = sel.picks[o.conflict.id];
      eff = pick === "rekordbox" ? (o.conflict.ifRekordbox as ListEffect | null) : pick === "mixxx" ? (o.conflict.ifMixxx as ListEffect | null) : null;
    }
    const applied = ok(eff) ? (eff as ListEffect) : null;
    const rbCur = plan._vRb[o.key];
    const mxCur = plan._vMx[o.key];
    if (applied) {
      listFx.push(applied);
      if (applied.target === "mixxx") {
        // Mixxx will hold the result; the Rekordbox side's change is consumed.
        setList(nbRb, o.key, rbCur);
        setList(nbMx, o.key, resultOf(applied));
        if (applied.fromKey) {
          delete nbRb.lists[applied.fromKey];
          delete nbMx.lists[applied.fromKey];
        }
      }
      // Bound for Rekordbox: stays pending on both sides.
    } else if (o.settleNow) {
      setList(nbRb, o.key, rbCur);
      setList(nbMx, o.key, mxCur);
    }
  }

  const bumpMeta = (nb: SyncState, key: string, f: MetaField, v: string | number) => {
    const rec = (nb.meta[key] ??= {});
    (rec as Record<string, string | number>)[f] = v;
  };
  for (const o of plan._meta) {
    const rv = rb.meta[o.key][o.field];
    const mv = mx.meta[o.key][o.field];
    let eff: MetaEffect | null = o.effect;
    if (o.conflict) {
      const pick = sel.picks[o.conflict.id];
      eff = pick === "rekordbox" ? (o.conflict.ifRekordbox as MetaEffect | null) : pick === "mixxx" ? (o.conflict.ifMixxx as MetaEffect | null) : null;
    }
    const applied = ok(eff) ? (eff as MetaEffect) : null;
    if (applied) {
      metaFx.push(applied);
      if (applied.target === "mixxx") {
        bumpMeta(nbRb, o.key, o.field, rv);
        bumpMeta(nbMx, o.key, o.field, applied.to);
      }
    } else if (o.settleNow) {
      bumpMeta(nbRb, o.key, o.field, rv);
      bumpMeta(nbMx, o.key, o.field, mv);
    }
  }

  // Mixxx writes ------------------------------------------------------------
  const reloc = wantRelocate ? relocations(mx, plan._canon) : [];
  const relocTo = new Map(reloc.map((r) => [pathKey(r.from), r.to]));
  const mxPath = (k: string) => {
    const p = mx.paths[k] ?? rb.paths[k];
    return relocTo.get(pathKey(p)) ?? p;
  };
  const kind = plan._settings.mixxxTarget === "crate" ? "crate" : "playlist";
  const ops: DjOp[] = [];
  const mxLists = listFx.filter((e) => e.target === "mixxx");
  for (const e of mxLists) {
    const paths = e.members.map(mxPath);
    if (e.action === "delete") {
      if (e.ref) ops.push({ op: "delete", id: e.ref });
    } else if (e.action === "create") {
      ops.push({ op: "upsert", name: e.name, kind, paths });
    } else if (e.action === "rename") {
      if (e.ref) {
        ops.push({ op: "rename", id: e.ref, name: e.name });
        ops.push({ op: "setTracks", id: e.ref, paths });
      }
    } else if (e.ref) ops.push({ op: "setTracks", id: e.ref, paths });
  }
  const byTrack = new Map<string, SyncOutput["mixxxMeta"][number]>();
  for (const e of metaFx.filter((x) => x.target === "mixxx")) {
    const u = byTrack.get(e.key) ?? { path: mxPath(e.key) };
    byTrack.set(e.key, u);
    (u as Record<string, string | number>)[e.field === "plays" ? "plays" : e.field] = e.to;
  }

  const rbLists = listFx.filter((e) => e.target === "rekordbox");
  const rbMeta = metaFx.filter((e) => e.target === "rekordbox");
  const rbTracks = new Set(rbMeta.map((e) => e.key));
  return {
    mixxxOps: ops,
    mixxxMeta: [...byTrack.values()],
    relocations: reloc,
    toRekordbox: { lists: rbLists, meta: rbMeta },
    nextBaseRb: nbRb,
    nextBaseMx: nbMx,
    counts: {
      mixxxLists: mxLists.length,
      mixxxTracks: byTrack.size,
      rekordboxLists: rbLists.length,
      rekordboxTracks: rbTracks.size,
      relocations: reloc.length,
    },
  };
}

function structuredCloneMeta(m: SyncState["meta"]): SyncState["meta"] {
  const out: SyncState["meta"] = {};
  for (const [k, v] of Object.entries(m)) out[k] = { ...v };
  return out;
}

// --- rekordbox.xml for the Rekordbox-bound changes -----------------------------------

export interface RekordboxExport {
  nodes: XmlNode[];
  tracks: DjTrack[];
  options: XmlOptions;
  playlists: number;
  trackUpdates: number;
}

/** Folders are the FOLDER_SEP-joined prefix of a list's name. */
export function xmlNodesForLists(lists: { name: string; paths: string[] }[]): XmlNode[] {
  const roots: XmlNode[] = [];
  for (const l of lists) {
    const parts = l.name.split(FOLDER_SEP).map((s) => s.trim()).filter(Boolean);
    const leaf = parts.pop() ?? l.name;
    let level = roots;
    for (const part of parts) {
      let f = level.find((n): n is Extract<XmlNode, { type: "folder" }> => n.type === "folder" && n.name === part);
      if (!f) {
        f = { type: "folder", name: part, children: [] };
        level.push(f);
      }
      level = f.children;
    }
    level.push({ type: "playlist", name: leaf, paths: l.paths });
  }
  return roots;
}

export function buildRekordboxExport(out: SyncOutput, rb: SideState, mx: SideState): RekordboxExport | null {
  const { lists, meta } = out.toRekordbox;
  const live = lists.filter((l) => l.action !== "delete");
  if (!live.length && !meta.length) return null;
  const pathOf = (k: string) => rb.paths[k] ?? mx.paths[k];
  const infoOf = (k: string): DjTrack | undefined => mx.info[k] ?? rb.info[k];
  const nodes = xmlNodesForLists(live.map((l) => ({ name: l.name, paths: l.members.map(pathOf).filter(Boolean) })));
  const tracks = new Map<string, DjTrack>();
  const extras: NonNullable<XmlOptions["extras"]> = new Map();
  const extraPaths: string[] = [];
  const need = (k: string) => {
    const t = infoOf(k);
    if (t && pathOf(k)) tracks.set(pathKey(pathOf(k)), { ...t, path: pathOf(k) });
  };
  for (const l of live) l.members.forEach(need);
  const byTrack = new Map<string, MetaEffect[]>();
  for (const e of meta) byTrack.set(e.key, [...(byTrack.get(e.key) ?? []), e]);
  for (const [k, effs] of byTrack) {
    const base = infoOf(k);
    const p = pathOf(k);
    if (!base || !p) continue;
    // Only the changed fields go out: blank the rest so a re-import can't
    // carry Mixxx's other values over.
    const t: DjTrack = { ...base, path: p, bpm: 0, key: "", comment: "" };
    const x: { rating?: number; plays?: number; color?: string } = {};
    for (const e of effs) {
      if (e.field === "bpm") t.bpm = Number(e.to);
      else if (e.field === "key") t.key = String(e.to);
      else if (e.field === "comment") t.comment = String(e.to);
      else if (e.field === "rating") x.rating = Number(e.to);
      else if (e.field === "plays") x.plays = Number(e.to);
      else if (e.field === "color") x.color = String(e.to);
    }
    tracks.set(pathKey(p), { ...(tracks.get(pathKey(p)) ?? t), ...t });
    extras.set(pathKey(p), x);
    extraPaths.push(p);
  }
  return { nodes, tracks: [...tracks.values()], options: { extras, extraPaths }, playlists: live.length, trackUpdates: byTrack.size };
}

// --- summary for the preview ------------------------------------------------------------

export interface GroupSummary {
  group: SyncGroup;
  toMixxx: number;
  toRekordbox: number;
  conflicts: number;
}

export function summarize(plan: SyncPlan): GroupSummary[] {
  const rows = new Map<SyncGroup, GroupSummary>();
  const row = (g: SyncGroup) => {
    let r = rows.get(g);
    if (!r) rows.set(g, (r = { group: g, toMixxx: 0, toRekordbox: 0, conflicts: 0 }));
    return r;
  };
  for (const e of plan.lists) row("playlists")[e.target === "mixxx" ? "toMixxx" : "toRekordbox"]++;
  for (const e of plan.meta) row(e.field)[e.target === "mixxx" ? "toMixxx" : "toRekordbox"]++;
  for (const c of plan.conflicts) row(c.group).conflicts++;
  return SYNC_GROUPS.filter((g) => rows.has(g)).map((g) => rows.get(g)!);
}

export function planIsEmpty(plan: SyncPlan): boolean {
  return !plan.lists.length && !plan.meta.length && !plan.conflicts.length;
}

/** Whether `unmatched` list membership or counts remain worth showing (display helper). */
export function listDetail(e: ListEffect): string {
  switch (e.action) {
    case "create":
      return `${e.members.length} tracks${e.unmatched ? `, ${e.unmatched} not in the other library` : ""}`;
    case "delete":
      return `removes ${e.removed} tracks`;
    case "rename":
      return `renamed from "${e.from}"${e.added || e.removed ? `, +${e.added} -${e.removed}` : ""}`;
    default: {
      const bits = [];
      if (e.added) bits.push(`+${e.added}`);
      if (e.removed) bits.push(`-${e.removed}`);
      if (e.reordered) bits.push("reordered");
      return bits.join(" ") || "no change";
    }
  }
}

