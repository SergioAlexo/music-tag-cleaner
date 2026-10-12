import { describe, expect, it } from "vitest";
import {
  buildRekordboxExport,
  buildSide,
  DEFAULT_SYNC_SETTINGS,
  finalize,
  listKey,
  makeCanon,
  noSelection,
  planIsEmpty,
  planSync,
  relocations,
  toBase,
  xmlNodesForLists,
  type Selection,
  type SideState,
  type SyncOutput,
  type SyncPlan,
  type SyncSettings,
  type SyncState,
  type TrackMeta,
} from "./djSync";
import { buildRekordboxTreeXml, type DjSnapshot, type DjTrack } from "./djPlaylists";

const blank: TrackMeta = { bpm: 0, key: "", rating: 0, plays: 0, comment: "", color: "" };

/** Track keys double as their paths in these tests. */
function side(
  lists: Record<string, string[]>,
  tracks: string[] | Record<string, Partial<TrackMeta>>,
  extra: { smart?: string[]; unordered?: boolean; grid?: string[] } = {},
): SideState {
  const meta: SideState["meta"] = {};
  const paths: SideState["paths"] = {};
  const info: SideState["info"] = {};
  const entries = Array.isArray(tracks) ? tracks.map((t) => [t, {}] as const) : Object.entries(tracks);
  for (const [k, m] of entries) {
    meta[k] = { ...blank, ...m };
    paths[k] = k;
    info[k] = { id: k, path: k, title: k, artist: "", album: "", genre: "", key: "", bpm: 0, rating: 0, year: "", comment: "", dateAdded: "", language: "", duration: 0 };
  }
  const out: SideState = { lists: {}, meta, paths, info, grid: new Set(extra.grid ?? []), skipped: [] };
  for (const [name, members] of Object.entries(lists)) {
    out.lists[listKey(name)] = {
      name,
      members: extra.unordered ? [...members].sort() : members,
      ref: `p:${name}`,
      ...(extra.smart?.includes(name) ? { smart: true } : {}),
      ...(extra.unordered ? { unordered: true } : {}),
    };
  }
  return out;
}

const ALL = ["a", "b", "c", "d", "e"];
const settings = (over: Partial<SyncSettings> = {}, dirs: Partial<SyncSettings["dirs"]> = {}): SyncSettings => ({
  ...DEFAULT_SYNC_SETTINGS,
  ...over,
  dirs: { ...DEFAULT_SYNC_SETTINGS.dirs, ...dirs },
});
const only = (g: keyof SyncSettings["dirs"], d: "both" | "rb2mx" | "mx2rb" | "off" = "both"): SyncSettings["dirs"] => ({
  playlists: "off", bpm: "off", key: "off", rating: "off", plays: "off", comment: "off", color: "off", [g]: d,
});

function run(
  rb: SideState,
  mx: SideState,
  baseRb: SyncState | null,
  baseMx: SyncState | null,
  s: SyncSettings,
  sel: Selection = noSelection(),
) {
  const plan = planSync({ baseRb, baseMx, rb, mx, settings: s });
  return { plan, out: finalize(plan, sel) };
}

/** What Mixxx holds after the ops ran (track keys are paths here). */
function applyToMixxx(mx: SideState, out: SyncOutput): SideState {
  const next: SideState = { ...mx, lists: { ...mx.lists }, meta: Object.fromEntries(Object.entries(mx.meta).map(([k, v]) => [k, { ...v }])) };
  const byRef = (id: string) => Object.entries(next.lists).find(([, l]) => l.ref === id);
  for (const op of out.mixxxOps) {
    if (op.op === "upsert") {
      next.lists[listKey(op.name)] = { name: op.name, members: op.paths ?? [], ref: `p:${op.name}`, ...(op.kind === "crate" ? { unordered: true } : {}) };
    } else if (op.op === "setTracks") {
      const f = byRef(op.id);
      if (f) next.lists[f[0]] = { ...f[1], members: f[1].unordered ? [...op.paths].sort() : op.paths };
    } else if (op.op === "delete") {
      const f = byRef(op.id);
      if (f) delete next.lists[f[0]];
    } else if (op.op === "rename") {
      const f = byRef(op.id);
      if (f) {
        delete next.lists[f[0]];
        next.lists[listKey(op.name)] = { ...f[1], name: op.name, ref: `p:${op.name}` };
      }
    }
  }
  for (const u of out.mixxxMeta) {
    const m = next.meta[u.path];
    if (!m) continue;
    for (const f of ["bpm", "key", "rating", "plays", "comment", "color"] as const) {
      if (u[f] !== undefined) (m as Record<string, string | number>)[f] = u[f]!;
    }
  }
  return next;
}

/** The owner importing the Rekordbox-bound xml. */
function importIntoRekordbox(rb: SideState, out: SyncOutput): SideState {
  const next: SideState = { ...rb, lists: { ...rb.lists }, meta: Object.fromEntries(Object.entries(rb.meta).map(([k, v]) => [k, { ...v }])) };
  for (const e of out.toRekordbox.lists) {
    if (e.action === "delete") delete next.lists[e.key];
    else {
      if (e.fromKey) delete next.lists[e.fromKey];
      next.lists[e.key] = { name: e.name, members: e.members, ref: `p:${e.name}` };
    }
  }
  for (const e of out.toRekordbox.meta) (next.meta[e.key] as Record<string, string | number>)[e.field] = e.to;
  return next;
}

const lists = (p: ReturnType<typeof planSync>) => p.lists.map((l) => `${l.target}:${l.action}:${l.name}`);

describe("lists: first sync", () => {
  it("adds in both directions and never deletes", () => {
    const rb = side({ House: ["a", "b"], Both: ["a"] }, ALL);
    const mx = side({ Techno: ["c"], Both: ["a"] }, ALL);
    const { plan } = run(rb, mx, null, null, settings({}, only("playlists")));
    expect(plan.firstSync).toBe(true);
    expect(lists(plan).sort()).toEqual(["mixxx:create:House", "rekordbox:create:Techno"]);
    expect(plan.conflicts).toHaveLength(0);
  });

  it("flags same-named lists with different contents as a conflict", () => {
    const rb = side({ Peak: ["a", "b"] }, ALL);
    const mx = side({ Peak: ["a", "c"] }, ALL);
    const { plan } = run(rb, mx, null, null, settings({}, only("playlists")));
    expect(plan.lists).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0].rekordbox).toBe("2 tracks");
  });
});

describe("lists: changes since the last sync", () => {
  const base = (rb: SideState, mx: SideState) => ({ rb: toBase(rb), mx: toBase(mx) });
  const s = settings({}, only("playlists"));

  it("carries add / remove / reorder / rename from Rekordbox to Mixxx", () => {
    const rb0 = side({ Add: ["a"], Gone: ["a", "b"], Order: ["a", "b", "c"], Old: ["a", "d"] }, ALL);
    const mx0 = side({ Add: ["a"], Gone: ["a", "b"], Order: ["a", "b", "c"], Old: ["a", "d"] }, ALL);
    const b = base(rb0, mx0);
    const rb1 = side({ Add: ["a", "b"], Order: ["c", "b", "a"], New: ["a", "d"], Fresh: ["e"] }, ALL);
    const { plan, out } = run(rb1, mx0, b.rb, b.mx, s);
    expect(lists(plan).sort()).toEqual([
      "mixxx:create:Fresh",
      "mixxx:delete:Gone",
      "mixxx:rename:New",
      "mixxx:update:Add",
      "mixxx:update:Order",
    ]);
    const ren = plan.lists.find((l) => l.action === "rename")!;
    expect(ren.from).toBe("Old");
    expect(plan.lists.find((l) => l.name === "Order")!.reordered).toBe(true);
    expect(out.mixxxOps).toContainEqual({ op: "delete", id: "p:Gone" });
    expect(out.mixxxOps).toContainEqual({ op: "rename", id: "p:Old", name: "New" });
    expect(out.mixxxOps).toContainEqual({ op: "upsert", name: "Fresh", kind: "playlist", paths: ["e"] });
  });

  it("carries a Mixxx edit to Rekordbox as xml (never a write)", () => {
    const rb0 = side({ L: ["a"] }, ALL);
    const mx0 = side({ L: ["a"] }, ALL);
    const b = base(rb0, mx0);
    const mx1 = side({ L: ["a", "b"], Extra: ["c"] }, ALL);
    const { plan, out } = run(rb0, mx1, b.rb, b.mx, s);
    expect(lists(plan).sort()).toEqual(["rekordbox:create:Extra", "rekordbox:update:L"]);
    expect(out.mixxxOps).toHaveLength(0);
    expect(out.toRekordbox.lists).toHaveLength(2);
  });

  it("is a conflict when both sides changed the same list, and honours the pick", () => {
    const rb0 = side({ L: ["a"] }, ALL);
    const mx0 = side({ L: ["a"] }, ALL);
    const b = base(rb0, mx0);
    const rb1 = side({ L: ["a", "b"] }, ALL);
    const mx1 = side({ L: ["a", "c"] }, ALL);
    const { plan } = run(rb1, mx1, b.rb, b.mx, s);
    expect(plan.lists).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(1);
    const id = plan.conflicts[0].id;
    // Unresolved: nothing happens.
    expect(finalize(plan, noSelection()).mixxxOps).toHaveLength(0);
    // Rekordbox wins: Mixxx is rewritten.
    const rbWins = finalize(plan, { ...noSelection(), picks: { [id]: "rekordbox" } });
    expect(rbWins.mixxxOps).toEqual([{ op: "setTracks", id: "p:L", paths: ["a", "b"] }]);
    // Mixxx wins: it goes to the xml instead.
    const mxWins = finalize(plan, { ...noSelection(), picks: { [id]: "mixxx" } });
    expect(mxWins.mixxxOps).toHaveLength(0);
    expect(mxWins.toRekordbox.lists[0].members).toEqual(["a", "c"]);
  });

  it("a delete against an edit is a conflict; both deleting is not", () => {
    const rb0 = side({ L: ["a"], M: ["a"] }, ALL);
    const mx0 = side({ L: ["a"], M: ["a"] }, ALL);
    const b = base(rb0, mx0);
    const { plan } = run(side({ M: [] }, ALL), side({ L: ["a", "b"] }, ALL), b.rb, b.mx, s);
    // L: rb deleted, mx edited. M: rb emptied, mx deleted -> conflict as well.
    expect(plan.conflicts.map((c) => c.label).sort()).toEqual(["L", "M"]);
    const both = run(side({}, ALL), side({}, ALL), b.rb, b.mx, s);
    expect(planIsEmpty(both.plan)).toBe(true);
  });

  it("one-way mode: the other side's edits are ignored, not conflicts", () => {
    const rb0 = side({ L: ["a"] }, ALL);
    const mx0 = side({ L: ["a"] }, ALL);
    const b = base(rb0, mx0);
    const { plan } = run(side({ L: ["a", "b"] }, ALL), side({ L: ["a", "c"], Mine: ["e"] }, ALL), b.rb, b.mx, settings({}, only("playlists", "rb2mx")));
    expect(lists(plan)).toEqual(["mixxx:update:L"]);
    expect(plan.conflicts).toHaveLength(0);
    expect(plan.ignored).toBe(1);
  });

  it("never writes into a Rekordbox smart list", () => {
    const rb0 = side({ Smart: ["a"] }, ALL, { smart: ["Smart"] });
    const mx0 = side({ Smart: ["a"] }, ALL);
    const b = base(rb0, mx0);
    const edited = run(rb0, side({ Smart: ["a", "b"] }, ALL), b.rb, b.mx, s);
    expect(edited.plan.lists).toHaveLength(0);
    // Its rules changed membership: that does flow to Mixxx.
    const regrown = run(side({ Smart: ["a", "c"] }, ALL, { smart: ["Smart"] }), mx0, b.rb, b.mx, s);
    expect(lists(regrown.plan)).toEqual(["mixxx:update:Smart"]);
  });

  it("reports tracks the other library lacks and keeps ones only it has", () => {
    const rb = side({ L: ["a", "x", "b"] }, ["a", "b", "x"]);
    const mx = side({ L: ["a", "m"] }, ["a", "b", "m"]);
    const b0 = side({ L: ["a"] }, ["a", "b", "x"]);
    const m0 = side({ L: ["a", "m"] }, ["a", "b", "m"]);
    const { plan } = run(rb, mx, toBase(b0), toBase(m0), s);
    const e = plan.lists[0];
    expect(e.members).toEqual(["a", "b", "m"]); // x is not in Mixxx; m (Mixxx only) is kept
    expect(e.unmatched).toBe(1);
  });

  it("unordered Mixxx crates compare as sets", () => {
    const rb = side({ L: ["b", "a"] }, ALL);
    const mx = side({ L: ["a", "b"] }, ALL, { unordered: true });
    const { plan } = run(rb, mx, null, null, settings({ mixxxTarget: "crate" }, only("playlists")));
    expect(planIsEmpty(plan)).toBe(true);
  });
});

describe("idempotency: syncing twice is a no-op", () => {
  it("lists and metadata, both directions, with renames", () => {
    const s = settings({}, { ...only("playlists"), rating: "both", plays: "both", bpm: "rb2mx", key: "rb2mx" });
    const rbT = { a: { rating: 4, plays: 3, bpm: 128, key: "Am" }, b: { rating: 0 }, c: {}, d: {} };
    const mxT = { a: { rating: 0, plays: 5 }, b: { rating: 2 }, c: {}, d: {} };
    const rb = side({ House: ["a", "b"], Old: ["c", "d"] }, rbT);
    const mx = side({ Techno: ["b", "c"] }, mxT);

    // 1st sync (nothing known).
    const r1 = run(rb, mx, null, null, s);
    expect(r1.plan.firstSync).toBe(true);
    const mx1 = applyToMixxx(mx, r1.out);
    const rb1 = importIntoRekordbox(rb, r1.out);
    // 2nd sync: no changes, both bases now agree with the sides.
    const r2 = run(rb1, mx1, r1.out.nextBaseRb, r1.out.nextBaseMx, s);
    expect(planIsEmpty(r2.plan)).toBe(true);
    expect(r2.out.mixxxOps).toHaveLength(0);
    expect(r2.out.mixxxMeta).toHaveLength(0);

    // Rekordbox renames a list and adds a track; Mixxx rates a track.
    const rb2 = side({ House: ["a", "b", "c"], Older: ["c", "d"], Techno: ["b", "c"] }, rb1.meta);
    const mx2 = applyToMixxx(mx1, { ...r1.out, mixxxOps: [], mixxxMeta: [{ path: "c", rating: 5 }] });
    const r3 = run(rb2, mx2, r2.out.nextBaseRb, r2.out.nextBaseMx, s);
    expect(r3.plan.lists.map((l) => `${l.action}:${l.name}`).sort()).toEqual(["rename:Older", "update:House"]);
    expect(r3.plan.meta.map((m) => `${m.target}:${m.field}:${m.key}`)).toEqual(["rekordbox:rating:c"]);
    const mx3 = applyToMixxx(mx2, r3.out);
    const rb3 = importIntoRekordbox(rb2, r3.out);
    const r4 = run(rb3, mx3, r3.out.nextBaseRb, r3.out.nextBaseMx, s);
    expect(planIsEmpty(r4.plan)).toBe(true);
  });

  it("Rekordbox-bound changes stay pending until Rekordbox shows them", () => {
    const s = settings({}, only("playlists"));
    const rb = side({}, ALL);
    const mx = side({ Mine: ["a", "b"] }, ALL);
    const r1 = run(rb, mx, null, null, s);
    expect(lists(r1.plan)).toEqual(["rekordbox:create:Mine"]);
    // Not imported yet: offered again, not lost and not reverted onto Mixxx.
    const r2 = run(rb, mx, r1.out.nextBaseRb, r1.out.nextBaseMx, s);
    expect(lists(r2.plan)).toEqual(["rekordbox:create:Mine"]);
    // Imported: settles.
    const r3 = run(importIntoRekordbox(rb, r1.out), mx, r2.out.nextBaseRb, r2.out.nextBaseMx, s);
    expect(planIsEmpty(r3.plan)).toBe(true);
    const r4 = run(importIntoRekordbox(rb, r1.out), mx, r3.out.nextBaseRb, r3.out.nextBaseMx, s);
    expect(planIsEmpty(r4.plan)).toBe(true);
  });

  it("an unticked item is offered again next time", () => {
    const s = settings({}, only("playlists"));
    const rb = side({ A: ["a"], B: ["b"] }, ALL);
    const mx = side({}, ALL);
    const r1 = run(rb, mx, null, null, s, { ...noSelection(), skipIds: new Set(["l:b"]) });
    expect(r1.out.mixxxOps).toEqual([{ op: "upsert", name: "A", kind: "playlist", paths: ["a"] }]);
    const mx1 = applyToMixxx(mx, r1.out);
    const r2 = run(rb, mx1, r1.out.nextBaseRb, r1.out.nextBaseMx, s);
    expect(lists(r2.plan)).toEqual(["mixxx:create:B"]);
  });
});

describe("metadata", () => {
  const tracks = (rbM: Partial<TrackMeta>, mxM: Partial<TrackMeta>, grid = false) => ({
    rb: side({}, { t: rbM }),
    mx: side({}, { t: mxM }, grid ? { grid: ["t"] } : {}),
  });

  it("first sync: a blank is filled from the other side, a real value is never blanked", () => {
    const { rb, mx } = tracks({ rating: 4, comment: "" }, { rating: 0, comment: "hello" });
    const { plan } = run(rb, mx, null, null, settings({}, { ...only("rating"), comment: "both" }));
    const by = Object.fromEntries(plan.meta.map((m) => [m.field, m]));
    expect(by.rating).toMatchObject({ target: "mixxx", to: 4, auto: "fill" });
    expect(by.comment).toMatchObject({ target: "rekordbox", to: "hello", auto: "fill" });
    // One-way Rekordbox -> Mixxx, Rekordbox blank, Mixxx has a value: nothing happens.
    const oneWay = run(rb, mx, null, null, settings({}, only("comment", "rb2mx")));
    expect(oneWay.plan.meta).toHaveLength(0);
  });

  it("first sync with two real values: the master wins", () => {
    const { rb, mx } = tracks({ rating: 4 }, { rating: 2 });
    const rbMaster = run(rb, mx, null, null, settings({ master: "rekordbox" }, only("rating")));
    expect(rbMaster.plan.meta[0]).toMatchObject({ target: "mixxx", to: 4, auto: "master" });
    const mxMaster = run(rb, mx, null, null, settings({ master: "mixxx" }, only("rating")));
    expect(mxMaster.plan.meta[0]).toMatchObject({ target: "rekordbox", to: 2, auto: "master" });
  });

  it("later: one side's edit flows, both sides' edits conflict (play counts take the max)", () => {
    const s = settings({}, { ...only("rating"), plays: "both" });
    const t0 = tracks({ rating: 3, plays: 10 }, { rating: 3, plays: 10 });
    const b0 = run(t0.rb, t0.mx, null, null, s);
    const t1 = tracks({ rating: 5, plays: 12 }, { rating: 3, plays: 11 });
    const r1 = run(t1.rb, t1.mx, b0.out.nextBaseRb, b0.out.nextBaseMx, s);
    expect(r1.plan.meta.map((m) => `${m.field}:${m.target}:${m.to}:${m.auto ?? ""}`).sort()).toEqual([
      "plays:mixxx:12:max",
      "rating:mixxx:5:",
    ]);
    const t2 = tracks({ rating: 5 }, { rating: 1 });
    const r2 = run(t2.rb, t2.mx, b0.out.nextBaseRb, b0.out.nextBaseMx, s);
    expect(r2.plan.conflicts).toHaveLength(1);
    expect(r2.plan.conflicts[0]).toMatchObject({ rekordbox: "5 stars", mixxx: "1 stars" });
  });

  it("never writes a BPM over a Mixxx beat grid", () => {
    const { rb, mx } = tracks({ bpm: 128 }, { bpm: 0 }, true);
    const s = settings({}, only("bpm", "rb2mx"));
    const r1 = run(rb, mx, null, null, s);
    expect(r1.plan.meta).toHaveLength(0);
    expect(r1.plan.gridLocked).toBe(1);
    // ...and is not asked again.
    expect(planIsEmpty(run(rb, mx, r1.out.nextBaseRb, r1.out.nextBaseMx, s).plan)).toBe(true);
  });

  it("compares keys by meaning and BPM with a tolerance", () => {
    const { rb, mx } = tracks({ key: "Db", bpm: 128 }, { key: "C#", bpm: 128.03 });
    const { plan } = run(rb, mx, null, null, settings({}, { ...only("key"), bpm: "both" }));
    expect(plan.meta).toHaveLength(0);
  });

  it("builds the Mixxx updates and the Rekordbox xml entries", () => {
    const t = tracks({ rating: 4, color: "#ff0000", key: "Am" }, { rating: 0, color: "", key: "" });
    const s = settings({}, { ...only("rating"), color: "both", key: "both" });
    const r = run(t.rb, t.mx, null, null, s);
    expect(r.out.mixxxMeta).toEqual([{ path: "t", rating: 4, color: "#ff0000", key: "Am" }]);
    const t2 = tracks({ rating: 0, comment: "" }, { rating: 5, plays: 7 });
    const r2 = run(t2.rb, t2.mx, null, null, settings({}, { ...only("rating"), plays: "both" }));
    const exp = buildRekordboxExport(r2.out, t2.rb, t2.mx)!;
    expect(exp.trackUpdates).toBe(1);
    const xml = buildRekordboxTreeXml(exp.nodes, exp.tracks, exp.options);
    expect(xml).toContain('Rating="255"');
    expect(xml).toContain('PlayCount="7"');
    expect(xml).not.toContain("<NODE Name=");
  });
});

describe("moved files (B4 maps)", () => {
  it("a track moved on disk still matches while both programs hold the old path", () => {
    const canon = makeCanon([["C:/Old/a.mp3", "C:/New/a.mp3"]]);
    const snap = (paths: string[]): DjSnapshot => ({
      source: "mixxx",
      dbPath: null,
      running: false,
      nodes: [{ id: "p:1", parentId: null, name: "L", kind: "playlist", seq: 0, count: 1, smartXml: null, rulesJson: null }],
      tracks: paths.map((p, i) => ({ id: String(i + 1), path: p, title: "", artist: "", album: "", genre: "", key: "", bpm: 0, rating: 0, year: "", comment: "", dateAdded: "", language: "", duration: 0 }) as DjTrack),
      members: { "p:1": paths.map((_, i) => String(i + 1)) },
    });
    const raw = (p: string) => ({ path: p, bpm: 0, key: "", rating: 0, plays: 0, comment: "", color: "", grid: false });
    const rb = buildSide("rekordbox", { ...snap(["C:/Old/a.mp3"]), source: "rekordbox" }, [raw("C:/Old/a.mp3")], canon, "playlist");
    const mx = buildSide("mixxx", snap(["C:/New/a.mp3"]), [raw("C:/New/a.mp3")], canon, "playlist");
    expect(Object.keys(rb.meta)).toEqual(Object.keys(mx.meta));
    expect(planIsEmpty(planSync({ baseRb: null, baseMx: null, rb, mx, settings: settings({}, only("playlists")) }))).toBe(true);
    // Mixxx still on the old path -> relocation proposed.
    const mxOld = buildSide("mixxx", snap(["C:/Old/a.mp3"]), [raw("C:/Old/a.mp3")], canon, "playlist");
    expect(relocations(mxOld, canon)).toEqual([{ from: "C:/Old/a.mp3", to: "C:/New/a.mp3" }]);
    // Chains: old -> mid -> new.
    const chain = makeCanon([["x/1", "x/2"], ["x/2", "x/3"]]);
    expect(chain.key("x/1")).toBe("x/3");
    expect(chain.moved("x/3")).toBeNull();
  });

  it("relocation paths replace the old path in the Mixxx ops", () => {
    const canon = makeCanon([["a", "A-new"]]);
    const rb = side({ L: ["anew"] }, ["anew"]);
    const mx = side({}, ["anew"]);
    mx.paths = { anew: "a" };
    const plan = planSync({ baseRb: null, baseMx: null, rb, mx, settings: settings({}, only("playlists")), canon });
    const out = finalize(plan, noSelection());
    expect(out.mixxxOps[0]).toMatchObject({ op: "upsert", paths: ["A-new"] });
    expect(out.relocations).toEqual([{ from: "a", to: "A-new" }]);
    expect(finalize(plan, noSelection(), false).relocations).toEqual([]);
  });
});

describe("rekordbox xml tree", () => {
  it("splits folder names", () => {
    const n = xmlNodesForLists([
      { name: "Sets / Warm / One", paths: ["a"] },
      { name: "Sets / Warm / Two", paths: ["b"] },
      { name: "Flat", paths: [] },
    ]);
    expect(n).toHaveLength(2);
    expect(n[0]).toMatchObject({ type: "folder", name: "Sets" });
    const warm = (n[0] as { children: { children: unknown[] }[] }).children[0];
    expect(warm.children).toHaveLength(2);
  });

  it("exports only Rekordbox-bound lists, with member paths", () => {
    const rb = side({}, ["a", "b"]);
    const mx = side({ "F / L": ["a", "b"] }, ["a", "b"]);
    const r = run(rb, mx, null, null, settings({}, only("playlists")));
    const exp = buildRekordboxExport(r.out, rb, mx)!;
    expect(exp.playlists).toBe(1);
    const xml = buildRekordboxTreeXml(exp.nodes, exp.tracks, exp.options);
    expect(xml).toContain('Name="F"');
    expect(xml).toContain('Name="L"');
    expect(xml.match(/<TRACK Key=/g)).toHaveLength(2);
  });
});
