import { describe, expect, it } from "vitest";
import { ActionRegistry, NO_PARAMS } from "./actions";
import { DEFAULT_SETTINGS } from "../hooks/useSettings";
import {
  DEFAULT_TOOLBAR_ORDER,
  SEQUENCE_STEPS,
  describeStep,
  normalizeCustomFeatures,
  normalizeToolbarOrder,
  runCustomFeature,
  visibleToolbarItems,
  type CustomFeature,
} from "./toolbarLayout";

const feature = (over: Partial<CustomFeature> = {}): CustomFeature => ({
  id: "f1",
  name: "Quick clean",
  steps: [{ kind: "capitalization" }, { kind: "characters" }, { kind: "generateIds" }],
  review: false,
  ...over,
});

describe("normalizeToolbarOrder", () => {
  it("keeps a saved order, drops junk/dupes, appends missing items and custom features", () => {
    const out = normalizeToolbarOrder(["rename", "nope", "rename", "custom:gone", "backup"], [feature()]);
    expect(out.slice(0, 2)).toEqual(["rename", "backup"]);
    expect(out).toHaveLength(DEFAULT_TOOLBAR_ORDER.length + 1);
    expect(out[out.length - 1]).toBe("custom:f1");
    expect(out).not.toContain("custom:gone");
  });
  it("falls back to the default order for garbage", () => {
    expect(normalizeToolbarOrder(null, [])).toEqual(DEFAULT_TOOLBAR_ORDER);
  });
});

describe("normalizeCustomFeatures", () => {
  it("drops bad entries and unknown steps", () => {
    const out = normalizeCustomFeatures([
      // Bare ids are how steps were saved before step options existed.
      {
        id: "a",
        name: "A",
        steps: ["characters", "convert", 3, { kind: "clearFields", clearMode: "keep", fields: ["comment", 7] }],
        review: 1,
      },
      { id: "a", name: "dupe", steps: [] },
      { name: "no id" },
      "x",
    ]);
    expect(out).toEqual([
      {
        id: "a",
        name: "A",
        steps: [{ kind: "characters" }, { kind: "clearFields", clearMode: "keep", fields: ["comment"] }],
        review: true,
      },
    ]);
  });
});

describe("visibleToolbarItems", () => {
  it("never leaves leading, trailing or doubled dividers", () => {
    expect(visibleToolbarItems(["sep1", "backup", "sep2", "aiClean", "sep3", "rename", "sep4"], ["aiClean"])).toEqual([
      "backup",
      "sep2",
      "rename",
    ]);
  });
});

/** A fake registry that mimics the app: preview steps set `pending`, apply clears it. */
function fakeRegistry(opts: { changedRows?: number } = {}) {
  const reg = new ActionRegistry();
  const log: string[] = [];
  let pending: number | null = null;
  const params = { type: "object" as const, additionalProperties: true };
  reg.register({
    id: "tags.standardize",
    title: "s",
    params,
    run: (p: { scope: string }) => {
      log.push(`standardize:${p.scope}`);
      pending = opts.changedRows ?? 2;
    },
  });
  reg.register({ id: "tags.generateIds", title: "g", params, run: () => void log.push("generateIds") });
  reg.register({
    id: "changes.get",
    title: "c",
    params,
    run: () => (pending === null ? { mode: null, rows: [] } : { mode: "standardize", totalChanged: pending }),
  });
  reg.register({ id: "changes.apply", title: "a", params: NO_PARAMS, run: () => void (log.push("apply"), (pending = null)) });
  reg.register({ id: "changes.cancel", title: "x", params: NO_PARAMS, run: () => void (log.push("cancel"), (pending = null)) });
  return { reg, log, clearPending: () => (pending = null), setPending: (n: number) => (pending = n) };
}

const base = { settings: { ...DEFAULT_SETTINGS, capitalization: "title" as const }, getSelection: () => ["/a.mp3"], notify: () => {} };

describe("runCustomFeature", () => {
  it("runs steps in order and applies each preview before the next step", async () => {
    const { reg, log } = fakeRegistry();
    const ran = await runCustomFeature({ ...base, reg, feature: feature() });
    expect(ran).toBe(3);
    expect(log).toEqual(["standardize:capitalization", "apply", "standardize:characters", "apply", "generateIds"]);
  });

  it("discards a preview with no changes instead of applying it", async () => {
    const { reg, log } = fakeRegistry({ changedRows: 0 });
    await runCustomFeature({ ...base, reg, feature: feature({ steps: [{ kind: "characters" }] }) });
    expect(log).toEqual(["standardize:characters", "cancel"]);
  });

  it("skips capitalization when it is set to Leave as is", async () => {
    const { reg, log } = fakeRegistry();
    await runCustomFeature({
      ...base,
      settings: { ...DEFAULT_SETTINGS, capitalization: "asis" },
      reg,
      feature: feature({ steps: [{ kind: "capitalization" }, { kind: "generateIds" }] }),
    });
    expect(log).toEqual(["generateIds"]);
  });

  it("won't start over a preview that is already waiting", async () => {
    const { reg, log, setPending } = fakeRegistry();
    setPending(3);
    expect(await runCustomFeature({ ...base, reg, feature: feature() })).toBe(0);
    expect(log).toEqual([]);
  });

  it("in review mode waits until the preview is applied by the person", async () => {
    const { reg, log, clearPending } = fakeRegistry();
    const run = runCustomFeature({ ...base, reg, pollMs: 5, feature: feature({ steps: [{ kind: "characters" }, { kind: "generateIds" }], review: true }) });
    await new Promise((r) => setTimeout(r, 30));
    expect(log).toEqual(["standardize:characters"]);
    clearPending();
    await run;
    expect(log).toEqual(["standardize:characters", "generateIds"]);
  });

  it("stops when cancelled", async () => {
    const { reg, log } = fakeRegistry();
    let stop = false;
    const notify = (m: string) => {
      if (m.includes("finished")) return;
    };
    reg.register({ id: "tags.generateIds", title: "g", params: { type: "object", additionalProperties: true }, run: () => {
      log.push("generateIds");
      stop = true;
    } });
    await runCustomFeature({ ...base, notify, reg, cancelled: () => stop, feature: feature({ steps: [{ kind: "generateIds" }, { kind: "characters" }] }) });
    expect(log).toEqual(["generateIds"]);
  });
});

describe("step options", () => {
  const tags = {
    "/a.mp3": { hasCoverArt: false, allFields: { TrackTitle: "x", "Unknown(DJCITY)": "junk", "Unknown(purl)": "u" } },
  } as unknown as Record<string, import("../types").TagData>;
  const env = { settings: { ...DEFAULT_SETTINGS, clearFields: ["album"] }, tags };

  it("clear mode uses the step's own fields, or Settings when none are ticked", () => {
    const def = SEQUENCE_STEPS.clearFields;
    expect(def.build(["/a.mp3"], { kind: "clearFields", fields: ["comment"] }, env)?.params.fields).toEqual(["comment"]);
    expect(def.build(["/a.mp3"], { kind: "clearFields" }, env)?.params.fields).toEqual(["album"]);
  });

  it("keep mode clears every other clearable field and raw frame", () => {
    const fields = SEQUENCE_STEPS.clearFields.build(
      ["/a.mp3"],
      { kind: "clearFields", clearMode: "keep", fields: ["comment", "sourceUrl"] },
      env,
    )?.params.fields as string[];
    expect(fields).toContain("album");
    expect(fields).toContain("raw:Unknown(DJCITY)");
    expect(fields).not.toContain("comment");
    expect(fields).not.toContain("sourceUrl");
    // Curated frames (title, the purl behind Source URL) are never raw targets.
    expect(fields).not.toContain("raw:TrackTitle");
    expect(fields).not.toContain("raw:Unknown(purl)");
  });

  it("capitalization and AI Clean take their own options", () => {
    expect(SEQUENCE_STEPS.capitalization.build(["/a"], { kind: "capitalization", capitalization: "upper" }, env)?.params)
      .toMatchObject({ capitalization: "upper" });
    expect(SEQUENCE_STEPS.aiClean.build(["/a"], { kind: "aiClean", fields: ["genre", "bogus"] }, env)?.params)
      .toEqual({ paths: ["/a"], fields: ["genre"] });
    expect(SEQUENCE_STEPS.aiClean.build(["/a"], { kind: "aiClean" }, env)?.params).toEqual({ paths: ["/a"] });
  });

  it("describes a step with its options", () => {
    expect(describeStep({ kind: "clearFields", clearMode: "keep", fields: ["comment", "raw:Unknown(X)"] }))
      .toBe("Clear Fields (keep Comment, Unknown(X))");
    expect(describeStep({ kind: "capitalization", capitalization: "title" })).toBe("Capitalization (Aa)");
  });
});
