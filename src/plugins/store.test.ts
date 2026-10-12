import { describe, expect, it } from "vitest";
import { compareVersions, parseStoreIndex, storeStatus } from "./store";
import { baseManifest, makeEnv, makeManager } from "./testKit";
import { sha256Hex } from "./manifest";

const SHA = "a".repeat(64);
const idx = (plugins: unknown[]) => JSON.stringify({ plugins });

describe("store index", () => {
  it("parses entries and resolves relative urls against the index", () => {
    const r = parseStoreIndex(
      idx([{ manifest: baseManifest({ id: "one-plug" }), url: "pkg/one.zip", sha256: SHA.toUpperCase() }]),
      "https://example.com/store/index.json",
    );
    expect(r.problems).toEqual([]);
    expect(r.entries[0].url).toBe("https://example.com/store/pkg/one.zip");
    expect(r.entries[0].sha256).toBe(SHA);
  });

  it("skips bad entries but keeps good ones and says why", () => {
    const good = { manifest: baseManifest({ id: "good-one" }), url: "g.zip", sha256: SHA };
    const r = parseStoreIndex(
      idx([
        good,
        { manifest: baseManifest({ id: "no-sha" }), url: "x.zip" },
        { manifest: baseManifest({ id: "short-sha" }), url: "x.zip", sha256: "abc" },
        { manifest: { id: "BAD" }, url: "x.zip", sha256: SHA },
        { ...good },
      ]),
      "https://e.com/i.json",
    );
    expect(r.entries.map((e) => e.id)).toEqual(["good-one"]);
    expect(r.problems).toHaveLength(4);
    expect(r.problems.join("|")).toContain("listed twice");
  });

  it("rejects non-JSON and a missing list", () => {
    expect(parseStoreIndex("<html>", "https://e.com/i.json").problems[0]).toContain("not valid JSON");
    expect(parseStoreIndex("{}", "https://e.com/i.json").problems[0]).toContain("plugins");
  });

  it("compares versions numerically and reports update status", () => {
    expect(compareVersions("1.2.0", "1.10.0")).toBe(-1);
    expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    const e = parseStoreIndex(
      idx([{ manifest: baseManifest({ id: "up-plug", version: "1.1.0" }), url: "u.zip", sha256: SHA }]),
      "https://e.com/i.json",
    ).entries[0];
    expect(storeStatus(e, null)).toBe("new");
    expect(storeStatus(e, baseManifest({ id: "up-plug", version: "1.0.0" }) as never)).toBe("update");
    expect(storeStatus(e, baseManifest({ id: "up-plug", version: "1.1.0" }) as never)).toBe("installed");
  });

  it("a store package goes through review: staged as 'store', nothing written until approved", async () => {
    const t = makeEnv();
    const { manager, backend } = makeManager(t);
    const m = baseManifest({ id: "from-store" });
    const res = await manager.propose(JSON.stringify(m), null, "store");
    expect(res.status).toBe("pending_review");
    expect(backend.files.size).toBe(0);
    expect(manager.proposals[0].source).toBe("store");
    await manager.approve("from-store");
    expect(backend.files.has("from-store")).toBe(true);
  });

  it("the SHA-256 helper agrees with the Rust test vector", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
