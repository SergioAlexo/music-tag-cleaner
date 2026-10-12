/**
 * Dry run against COPIES of the owner's real databases. Skipped unless
 * MTC_SYNC_DRYRUN_DIR holds rb.json / mx.json (see the `dryrun_*` ignored tests
 * in `commands/dj_sync.rs`). Writes ops.json for the Rust apply step, and on
 * the second invocation (after.json present) checks the replan is a no-op for
 * everything Mixxx-bound.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildRekordboxExport,
  buildSide,
  DEFAULT_SYNC_SETTINGS,
  finalize,
  makeCanon,
  noSelection,
  planSync,
  summarize,
  toBase,
  type SyncSettings,
} from "./djSync";
import { buildRekordboxTreeXml } from "./djPlaylists";

const dir = process.env.MTC_SYNC_DRYRUN_DIR;
const have = !!dir && existsSync(`${dir}/rb.json`) && existsSync(`${dir}/mx.json`);

describe.skipIf(!have)("dry run on copies of the real databases", () => {
  const read = (n: string) => JSON.parse(readFileSync(`${dir}/${n}`, "utf8"));
  const settings: SyncSettings = {
    ...DEFAULT_SYNC_SETTINGS,
    dirs: { playlists: "both", bpm: "rb2mx", key: "rb2mx", rating: "both", plays: "both", comment: "both", color: "both" },
  };
  const canon = makeCanon([]);

  it("plans a first sync and, once applied, a second one is a no-op for Mixxx", () => {
    const rbRead = read("rb.json");
    const mxRead = read("mx.json");
    const stage2 = existsSync(`${dir}/stage1.json`);
    const rb = buildSide("rekordbox", rbRead.snapshot, rbRead.meta, canon, "playlist");
    const mx = buildSide("mixxx", mxRead.snapshot, mxRead.meta, canon, "playlist");
    if (!stage2) {
      const plan = planSync({ baseRb: null, baseMx: null, rb, mx, settings, canon });
      const out = finalize(plan, noSelection());
      const xml = buildRekordboxExport(out, rb, mx);
      const summary = {
        rekordbox: { lists: Object.keys(rb.lists).length, tracks: Object.keys(rb.meta).length, skippedSmart: rb.skipped.length },
        mixxx: { lists: Object.keys(mx.lists).length, tracks: Object.keys(mx.meta).length },
        firstSync: plan.firstSync,
        perGroup: summarize(plan),
        conflicts: plan.conflicts.length,
        ignored: plan.ignored,
        gridLocked: plan.gridLocked,
        onlyOneSide: plan.onlyOneSide,
        mixxxOps: out.mixxxOps.length,
        mixxxMetaTracks: out.mixxxMeta.length,
        xml: xml ? { playlists: xml.playlists, trackUpdates: xml.trackUpdates, bytes: buildRekordboxTreeXml(xml.nodes, xml.tracks, xml.options).length } : null,
      };
      console.log("DRYRUN " + JSON.stringify(summary));
      writeFileSync(`${dir}/ops.json`, JSON.stringify({ ops: out.mixxxOps, extras: { relocations: out.relocations, meta: out.mixxxMeta } }));
      writeFileSync(`${dir}/stage1.json`, JSON.stringify({ rb: toBase(rb), mx: out.nextBaseMx, baseRb: out.nextBaseRb, baseMx: out.nextBaseMx }));
      expect(plan.lists.length + plan.meta.length).toBeGreaterThan(0);
    } else {
      const st = read("stage1.json");
      const plan = planSync({ baseRb: st.baseRb, baseMx: st.baseMx, rb, mx, settings, canon });
      const out = finalize(plan, noSelection());
      console.log(
        "DRYRUN2 " +
          JSON.stringify({
            toMixxxLists: plan.lists.filter((l) => l.target === "mixxx").length,
            toMixxxMeta: plan.meta.filter((m) => m.target === "mixxx").length,
            toRekordboxLists: plan.lists.filter((l) => l.target === "rekordbox").length,
            toRekordboxMeta: plan.meta.filter((m) => m.target === "rekordbox").length,
            conflicts: plan.conflicts.length,
            mixxxOps: out.mixxxOps.length,
          }),
      );
      expect(plan.lists.filter((l) => l.target === "mixxx")).toHaveLength(0);
      expect(plan.meta.filter((m) => m.target === "mixxx")).toHaveLength(0);
    }
  });
});
