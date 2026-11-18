import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActionRegistry } from "./actions";
import { registerAppActions, type AppEnv } from "./appActions";

const invoke = vi.fn(async (..._a: unknown[]) => ({ ok: true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

const MSG = /Install the Preset Translator plugin/;
const ctx = { caller: "ai" as const, notify: () => {} };

function setup(active: boolean, confirm = true) {
  const h = { openPresets: vi.fn(), confirmPresetsApply: vi.fn(async () => confirm) };
  const env = { presetsPluginActive: () => active, h } as unknown as AppEnv;
  const reg = new ActionRegistry();
  registerAppActions(reg, () => env);
  return { reg, h };
}

describe("presets.* actions", () => {
  beforeEach(() => invoke.mockClear());

  it("are registered with the expected flags", () => {
    const { reg } = setup(true);
    const ids = ["presets.open", "presets.scan", "presets.convert", "presets.verify", "presets.apply", "presets.report"];
    for (const id of ids) expect(reg.has(id)).toBe(true);
    expect(reg.info("presets.apply")?.dangerous).toBe(true);
    expect(reg.info("presets.scan")?.readOnly).toBe(true);
    expect(reg.info("presets.convert")?.dangerous).toBe(false);
  });

  it("refuse without an enabled plugin that requires the engine", async () => {
    const { reg } = setup(false);
    for (const [id, p] of [
      ["presets.scan", { paths: ["C:/p"] }],
      ["presets.convert", { paths: ["C:/p"] }],
      ["presets.verify", { batchId: "b" }],
      ["presets.report", { batchId: "b" }],
      ["presets.apply", { batchId: "b", outputDir: "C:/o" }],
    ] as const)
      await expect(reg.run(id, p, ctx)).rejects.toThrow(MSG);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("presets.open works without the plugin and tells the dialog it is unavailable", async () => {
    const { reg, h } = setup(false);
    await reg.run("presets.open", { folder: "C:/p" }, ctx);
    expect(h.openPresets).toHaveBeenCalledWith({ folder: "C:/p", available: false });
  });

  it("pass camelCase args straight to the commands", async () => {
    const { reg } = setup(true);
    await reg.run("presets.scan", { paths: ["C:/p"] }, ctx);
    expect(invoke).toHaveBeenLastCalledWith("presets_scan", { paths: ["C:/p"] });
    await reg.run("presets.convert", { paths: ["C:/p"], serumRoot: "C:/s", maxFrames: 16 }, ctx);
    expect(invoke).toHaveBeenLastCalledWith("presets_convert", { paths: ["C:/p"], serumRoot: "C:/s", maxFrames: 16 });
    await reg.run("presets.verify", { batchId: "b1" }, ctx);
    expect(invoke).toHaveBeenLastCalledWith("presets_verify", { batchId: "b1" });
    await reg.run("presets.report", { batchId: "b1" }, ctx);
    expect(invoke).toHaveBeenLastCalledWith("presets_report", { batchId: "b1" });
  });

  it("presets.apply asks every time, even for the UI caller, and writes only on yes", async () => {
    const yes = setup(true, true);
    await yes.reg.run("presets.apply", { batchId: "b1", outputDir: "C:/o", include: ["C:/p/a.fxp"] }, { ...ctx, caller: "ui" });
    expect(yes.h.confirmPresetsApply).toHaveBeenCalledWith("C:/o", 1);
    expect(invoke).toHaveBeenLastCalledWith("presets_apply", { batchId: "b1", outputDir: "C:/o", include: ["C:/p/a.fxp"] });

    invoke.mockClear();
    const no = setup(true, false);
    await expect(no.reg.run("presets.apply", { batchId: "b1", outputDir: "C:/o" }, ctx)).rejects.toThrow(/not confirmed/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("validate params", async () => {
    const { reg } = setup(true);
    await expect(reg.run("presets.scan", { paths: [] }, ctx)).rejects.toMatchObject({ code: "invalid_params" });
    await expect(reg.run("presets.apply", { batchId: "b" }, ctx)).rejects.toMatchObject({ code: "invalid_params" });
  });
});
