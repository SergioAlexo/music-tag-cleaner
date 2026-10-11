import { describe, expect, it, vi } from "vitest";
import { ActionError, ActionRegistry, NO_PARAMS, clampResult, validateAgainstSchema, type ActionCtx } from "./actions";

const ctx = (over: Partial<ActionCtx> = {}): ActionCtx => ({ caller: "ai", notify: () => {}, ...over });

describe("validateAgainstSchema", () => {
  const schema = {
    type: "object" as const,
    properties: {
      paths: { type: "array" as const, items: { type: "string" as const }, minItems: 1 },
      stars: { type: "integer" as const, minimum: 0, maximum: 5 },
      mode: { type: "string" as const, enum: ["a", "b"] },
    },
    required: ["paths"],
    additionalProperties: false,
  };

  it("accepts a valid object", () => {
    expect(validateAgainstSchema({ paths: ["x"], stars: 3, mode: "a" }, schema)).toEqual([]);
  });
  it("reports missing, wrong-typed, out-of-range, enum and unknown keys", () => {
    expect(validateAgainstSchema({}, schema)).toContain("params.paths is required");
    expect(validateAgainstSchema({ paths: [1] }, schema)[0]).toMatch(/paths\[0\] must be a string/);
    expect(validateAgainstSchema({ paths: ["x"], stars: 6 }, schema)[0]).toMatch(/<= 5/);
    expect(validateAgainstSchema({ paths: ["x"], stars: 1.5 }, schema)[0]).toMatch(/integer/);
    expect(validateAgainstSchema({ paths: ["x"], mode: "c" }, schema)[0]).toMatch(/one of/);
    expect(validateAgainstSchema({ paths: ["x"], nope: 1 }, schema)[0]).toMatch(/not a known/);
    expect(validateAgainstSchema({ paths: [] }, schema)[0]).toMatch(/at least 1/);
  });
  it("rejects non-objects", () => {
    expect(validateAgainstSchema([], schema)[0]).toMatch(/must be an object/);
    expect(validateAgainstSchema(null, schema)[0]).toMatch(/must be an object/);
  });
});

describe("ActionRegistry", () => {
  const make = () => {
    const reg = new ActionRegistry();
    const run = vi.fn(async (p: { n?: number }) => ({ got: p.n ?? 0 }));
    reg.register({
      id: "demo.echo",
      title: "Echo",
      params: { type: "object", properties: { n: { type: "number" } }, additionalProperties: false },
      run,
      readOnly: true,
    });
    const del = vi.fn(async () => "deleted");
    reg.register({ id: "demo.delete", title: "Delete", params: NO_PARAMS, run: del, dangerous: true });
    return { reg, run, del };
  };

  it("lists serialisable infos sorted by id and rejects bad ids", () => {
    const { reg } = make();
    expect(reg.list().map((a) => a.id)).toEqual(["demo.delete", "demo.echo"]);
    expect(() => reg.register({ id: "nodot", title: "x", params: NO_PARAMS, run: () => 1 })).toThrow();
    expect(JSON.parse(JSON.stringify(reg.list()))).toHaveLength(2);
  });

  it("validates params before running", async () => {
    const { reg, run } = make();
    await expect(reg.run("demo.echo", { n: "x" }, ctx())).rejects.toMatchObject({ code: "invalid_params" });
    expect(run).not.toHaveBeenCalled();
    await expect(reg.run("nope.nope", {}, ctx())).rejects.toMatchObject({ code: "unknown_action" });
    expect(await reg.run("demo.echo", { n: 2 }, ctx())).toEqual({ got: 2 });
  });

  it("dangerous actions need approval from AI callers, not from the UI", async () => {
    const { reg, del } = make();
    await expect(reg.run("demo.delete", {}, ctx())).rejects.toMatchObject({ code: "denied" });
    await expect(reg.run("demo.delete", {}, ctx({ confirmDangerous: async () => false }))).rejects.toBeInstanceOf(
      ActionError,
    );
    expect(del).not.toHaveBeenCalled();
    expect(await reg.run("demo.delete", {}, ctx({ confirmDangerous: async () => true }))).toBe("deleted");
    expect(await reg.run("demo.delete", {}, ctx({ caller: "ui" }))).toBe("deleted");
  });

  it("wraps handler exceptions as failed", async () => {
    const reg = new ActionRegistry();
    reg.register({
      id: "demo.boom",
      title: "Boom",
      params: NO_PARAMS,
      run: () => {
        throw new Error("kaput");
      },
    });
    await expect(reg.run("demo.boom", {}, ctx())).rejects.toMatchObject({ code: "failed", message: "kaput" });
  });

  it("register returns an unregister function that leaves a replacement alone", () => {
    const reg = new ActionRegistry();
    const off = reg.register({ id: "demo.a", title: "A", params: NO_PARAMS, run: () => 1 });
    reg.register({ id: "demo.a", title: "A2", params: NO_PARAMS, run: () => 2 });
    off();
    expect(reg.info("demo.a")?.title).toBe("A2");
  });
});

describe("scripts", () => {
  const make = () => {
    const reg = new ActionRegistry();
    const calls: string[] = [];
    reg.register({
      id: "demo.step",
      title: "Step",
      params: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      run: (p: { name: string }) => {
        calls.push(p.name);
        if (p.name === "bad") throw new Error("step failed");
        return p.name;
      },
    });
    reg.register({ id: "demo.danger", title: "Danger", params: NO_PARAMS, dangerous: true, run: () => calls.push("danger") });
    return { reg, calls };
  };

  it("dry run returns the plan and runs nothing", async () => {
    const { reg, calls } = make();
    const out = await reg.runScript(
      [{ action: "demo.step", params: { name: "a" } }, { action: "demo.danger" }, { action: "demo.missing" }],
      { dryRun: true },
      ctx(),
    );
    expect(calls).toEqual([]);
    expect(out.dryRun).toBe(true);
    expect(out.ok).toBe(false);
    expect(out.plan.map((p) => [p.valid, p.dangerous])).toEqual([
      [true, false],
      [true, true],
      [false, false],
    ]);
  });

  it("refuses to start a script with an invalid step, before running step 0", async () => {
    const { reg, calls } = make();
    await expect(
      reg.runScript([{ action: "demo.step", params: { name: "a" } }, { action: "demo.step" }], {}, ctx()),
    ).rejects.toMatchObject({ code: "invalid_params" });
    expect(calls).toEqual([]);
  });

  it("stops at the first failure unless continueOnError", async () => {
    const { reg, calls } = make();
    const stop = await reg.runScript(
      [{ action: "demo.step", params: { name: "bad" } }, { action: "demo.step", params: { name: "after" } }],
      {},
      ctx(),
    );
    expect(stop.ok).toBe(false);
    expect(calls).toEqual(["bad"]);
    const go = await reg.runScript(
      [
        { action: "demo.step", params: { name: "bad" }, continueOnError: true },
        { action: "demo.step", params: { name: "after" } },
      ],
      {},
      ctx(),
    );
    expect(go.results.map((r) => r.ok)).toEqual([false, true]);
  });

  it("script steps still go through the dangerous gate and cannot nest scripts", async () => {
    const { reg, calls } = make();
    const out = await reg.runScript([{ action: "demo.danger" }], {}, ctx());
    expect(out.results[0].ok).toBe(false);
    expect(calls).toEqual([]);
    reg.register({ id: "script.run", title: "Script", params: NO_PARAMS, run: () => 1 });
    await expect(reg.runScript([{ action: "script.run" }], {}, ctx())).rejects.toMatchObject({ code: "invalid_params" });
  });

  it("calls settle between steps", async () => {
    const { reg } = make();
    const settle = vi.fn(async () => {});
    reg.settle = settle;
    await reg.runScript([{ action: "demo.step", params: { name: "a" } }, { action: "demo.step", params: { name: "b" } }], {}, ctx());
    expect(settle).toHaveBeenCalledTimes(2);
  });
});

describe("clampResult", () => {
  it("passes small values and truncates huge ones", () => {
    expect(clampResult({ a: 1 })).toEqual({ a: 1 });
    const big = clampResult("x".repeat(500_000)) as { truncated: boolean };
    expect(big.truncated).toBe(true);
  });
});
