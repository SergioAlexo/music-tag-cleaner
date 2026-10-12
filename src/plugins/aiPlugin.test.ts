import { describe, expect, it } from "vitest";
import { buildNewButtonPrompt, parseGeneratedPlugin } from "./aiPlugin";
import { baseManifest, makeEnv, makeManager } from "./testKit";

describe("New button (AI) generation", () => {
  it("prompt carries the request, the guide and the action list but hides plugin/script actions", () => {
    const p = buildNewButtonPrompt("  hide the genre column ", ["table.setColumns", "plugins.create", "script.run"]);
    expect(p).toContain("hide the genre column");
    expect(p).toContain("table.setColumns");
    expect(p).not.toContain("plugins.create,");
    expect(p).toContain("MANIFEST");
  });

  it("parses a fenced answer with prose around it", () => {
    const m = baseManifest({ id: "hide-genre" });
    const r = parseGeneratedPlugin("Sure!\n```json\n" + JSON.stringify({ manifest: m, code: null }) + "\n```");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(JSON.parse(r.manifestText).id).toBe("hide-genre");
      expect(r.code).toBeNull();
    }
  });

  it("accepts a bare manifest and a think block, rejects junk", () => {
    const m = baseManifest({ id: "bare-one" });
    const r = parseGeneratedPlugin("<think>hmm {</think>" + JSON.stringify(m));
    expect(r.ok).toBe(true);
    expect(parseGeneratedPlugin("no json here").ok).toBe(false);
    expect(parseGeneratedPlugin("{ not json }").ok).toBe(false);
    expect(parseGeneratedPlugin('{"manifest": 3}').ok).toBe(false);
    expect(parseGeneratedPlugin('{"manifest": {"id":"x"}, "code": 5}').ok).toBe(false);
  });

  it("a generated plugin only stages: it is not written or enabled until approved", async () => {
    const t = makeEnv();
    const { manager, backend } = makeManager(t);
    const m = baseManifest({
      id: "hide-genre",
      permissions: ["ui.control"],
      contributes: { buttons: [{ id: "go", label: "Hide", action: "table.setColumns", params: { hide: ["genre"] } }] },
    });
    const g = parseGeneratedPlugin(JSON.stringify({ manifest: m, code: null }));
    if (!g.ok) throw new Error(g.error);
    const res = await manager.propose(g.manifestText, g.code, "ai");
    expect(res.status).toBe("pending_review");
    expect(backend.files.size).toBe(0);
    expect(manager.proposals.map((p) => p.source)).toEqual(["ai"]);
  });
});
