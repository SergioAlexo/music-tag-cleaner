import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseManifest, validateManifest, sha256Hex, contentHash, actionSegment, pluginActionId } from "./manifest";
import { checkActionPermission, networkAllowed } from "./permissions";
import { PluginInstance } from "./host";
import { baseManifest, flush, inProcessSandbox, makeEnv, makeManager } from "./testKit";

describe("manifest validation", () => {
  it("accepts a minimal plugin and a declarative button", () => {
    expect(validateManifest(baseManifest()).ok).toBe(true);
    const r = validateManifest(
      baseManifest({
        permissions: ["ui.control"],
        contributes: { buttons: [{ id: "go", label: "Hide", action: "table.setColumns", params: { hide: ["genre"] } }] },
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("reports every problem, not just the first", () => {
    const r = validateManifest({ id: "Bad Id", name: "", version: "1", apiVersion: 9, permissions: ["root"] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const t = r.errors.join("|");
      expect(t).toContain("id must be");
      expect(t).toContain("name is required");
      expect(t).toContain("version must look like");
      expect(t).toContain("apiVersion must be 1");
      expect(t).toContain('unknown permission "root"');
    }
  });

  it("rejects bad network hosts, undeclared local actions, and code-needing contributions without entry", () => {
    expect(validateManifest(baseManifest({ permissions: ["network:not a host"] })).ok).toBe(false);
    expect(validateManifest(baseManifest({ permissions: ["network:api.example.com", "network:*.example.org"] })).ok).toBe(true);
    expect(
      validateManifest(baseManifest({ contributes: { buttons: [{ id: "a", label: "A", action: "nope" }] } })).ok,
    ).toBe(false);
    expect(
      validateManifest(baseManifest({ contributes: { actions: [{ id: "a", title: "A" }] } })).ok,
    ).toBe(false); // needs entry
    expect(
      validateManifest(baseManifest({ permissions: [], contributes: { columns: [{ id: "c", label: "C" }] }, entry: "index.js" })).ok,
    ).toBe(false); // columns need read
  });

  it("rejects path-like entries and bad JSON", () => {
    expect(validateManifest(baseManifest({ entry: "../x.js" })).ok).toBe(false);
    expect(validateManifest(baseManifest({ entry: "a/b.js" })).ok).toBe(false);
    expect(parseManifest("{nope").ok).toBe(false);
  });

  it("builds registry ids from plugin ids", () => {
    expect(actionSegment("hide-genre-btn")).toBe("hideGenreBtn");
    expect(pluginActionId("hide-genre", "run")).toBe("plugin.hideGenre.run");
  });
});

describe("sha256", () => {
  it("matches the known digest of 'abc'", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("content hash changes with the code", async () => {
    expect(await contentHash("{}", "a")).not.toBe(await contentHash("{}", "b"));
    expect(await contentHash("{}", "a")).toBe(await contentHash("{}", "a"));
  });
});

describe("permission table", () => {
  const seg = "demo";
  const ro = { readOnly: true };
  const rw = { readOnly: false };
  it("maps actions to the right permission", () => {
    expect(checkActionPermission([], "tags.edit", rw, seg).allowed).toBe(false);
    expect(checkActionPermission(["tags.write"], "tags.edit", rw, seg).allowed).toBe(true);
    expect(checkActionPermission(["read"], "library.search", ro, seg).allowed).toBe(true);
    expect(checkActionPermission([], "library.search", ro, seg).allowed).toBe(false);
    expect(checkActionPermission(["tags.write"], "files.delete", rw, seg).allowed).toBe(false);
  });
  it("denies unmapped writers unless named, and never script.run / plugins.*", () => {
    expect(checkActionPermission(["read", "tags.write"], "some.unmapped", rw, seg).allowed).toBe(false);
    expect(checkActionPermission(["action:some.unmapped"], "some.unmapped", rw, seg).allowed).toBe(true);
    expect(checkActionPermission(["action:script.run"], "script.run", rw, seg).allowed).toBe(false);
    expect(checkActionPermission(["read"], "plugins.list", ro, seg).allowed).toBe(false);
    expect(checkActionPermission([], "plugin.demo.run", rw, seg).allowed).toBe(true);
    expect(checkActionPermission([], "plugin.other.run", rw, seg).allowed).toBe(false);
  });
  it("matches network hosts exactly or by wildcard", () => {
    const g = ["network:api.example.com", "network:*.cdn.test"];
    expect(networkAllowed(g, "https://api.example.com/x")).toBe(true);
    expect(networkAllowed(g, "https://evil.example.com/x")).toBe(false);
    expect(networkAllowed(g, "https://a.cdn.test/x")).toBe(true);
    expect(networkAllowed(g, "https://cdn.test/x")).toBe(false);
    expect(networkAllowed(g, "https://api.example.com.evil.io/")).toBe(false);
    expect(networkAllowed(g, "file:///etc/passwd")).toBe(false);
    expect(networkAllowed([], "https://api.example.com/")).toBe(false);
  });
});

async function run(manifest: Record<string, unknown>, code: string | null) {
  const t = makeEnv();
  const parsed = validateManifest(manifest);
  if (!parsed.ok) throw new Error(parsed.errors.join(";"));
  const inst = new PluginInstance(parsed.manifest, code, t.env, inProcessSandbox);
  await inst.start();
  return { t, inst };
}

describe("sandboxed plugin through the real SDK shim", () => {
  it("a plugin without tags.write cannot call tags.edit; with it, it can", async () => {
    const code = `mtc.registerAction("go", async () => mtc.call("tags.edit", { paths: ["/a.mp3"], field: "genre", value: "House" }));`;
    const base = { entry: "index.js", contributes: { actions: [{ id: "go", title: "Go" }] } };
    const denied = await run(baseManifest({ ...base, permissions: [] }), code);
    await expect(denied.t.registry.run("plugin.demo.go", {}, { caller: "ui", notify: () => {} })).rejects.toThrow(
      /needs the "tags.write" permission/,
    );
    expect(denied.t.calls).toHaveLength(0);

    const ok = await run(baseManifest({ ...base, permissions: ["tags.write"] }), code);
    const res = await ok.t.registry.run("plugin.demo.go", {}, { caller: "ui", notify: () => {} });
    expect(res).toEqual({ ok: "tags.edit" });
    expect(ok.t.calls).toEqual([{ id: "tags.edit", params: { paths: ["/a.mp3"], field: "genre", value: "House" } }]);
  });

  it("dangerous actions called by a plugin still ask the person", async () => {
    const code = `mtc.registerAction("go", async () => mtc.call("files.delete", {}));`;
    const base = { entry: "index.js", permissions: ["files.delete"], contributes: { actions: [{ id: "go", title: "Go" }] } };
    const { t } = await run(baseManifest(base), code);
    t.confirmAnswer.value = false;
    await expect(t.registry.run("plugin.demo.go", {}, { caller: "ui", notify: () => {} })).rejects.toThrow(/not approved/);
    expect(t.calls).toHaveLength(0);
    t.confirmAnswer.value = true;
    await t.registry.run("plugin.demo.go", {}, { caller: "ui", notify: () => {} });
    expect(t.calls).toHaveLength(1);
  });

  it("network: blocked without permission, allowed for the granted host only", async () => {
    const code = `mtc.registerAction("get", async ({ url }) => (await mtc.fetch(url)).body);`;
    const base = { entry: "index.js", contributes: { actions: [{ id: "get", title: "Get", params: { type: "object", properties: { url: { type: "string" } } } }] } };
    const none = await run(baseManifest({ ...base, permissions: [] }), code);
    await expect(none.t.registry.run("plugin.demo.get", { url: "https://api.example.com/" }, { caller: "ui", notify: () => {} })).rejects.toThrow(
      /not granted/,
    );
    const some = await run(baseManifest({ ...base, permissions: ["network:api.example.com"] }), code);
    expect(await some.t.registry.run("plugin.demo.get", { url: "https://api.example.com/x" }, { caller: "ui", notify: () => {} })).toBe("hello");
    await expect(some.t.registry.run("plugin.demo.get", { url: "https://other.example.com/x" }, { caller: "ui", notify: () => {} })).rejects.toThrow(
      /not granted/,
    );
    expect(some.t.fetched).toEqual(["https://api.example.com/x"]);
  });

  it("declarative button runs its registry action only if the permission is held", async () => {
    const contributes = { buttons: [{ id: "hide", label: "Hide", action: "table.setColumns", params: { hide: ["genre"] } }] };
    const no = await run(baseManifest({ contributes, permissions: [] }), null);
    await expect(no.inst.click("button", "hide", [])).rejects.toThrow(/ui.control/);
    const yes = await run(baseManifest({ contributes, permissions: ["ui.control"] }), null);
    await yes.inst.click("button", "hide", []);
    expect(yes.t.calls).toEqual([{ id: "table.setColumns", params: { hide: ["genre"] } }]);
  });

  it("menu items receive the selected paths", async () => {
    const m = {
      entry: "index.js",
      contributes: { actions: [{ id: "copy", title: "Copy" }], contextMenu: [{ id: "c", label: "Copy", action: "copy" }] },
    };
    const code = `mtc.registerAction("copy", async ({ paths }) => { await mtc.storage.set("last", paths); return paths.length; });`;
    const { t, inst } = await run(baseManifest(m), code);
    await inst.click("menu", "c", ["/x.mp3", "/y.mp3"]);
    expect(t.store.get("demo:last")).toEqual(["/x.mp3", "/y.mp3"]);
  });

  it("columns compute in the sandbox and need read", async () => {
    const m = { entry: "index.js", permissions: ["read"], contributes: { columns: [{ id: "len", label: "Len" }] } };
    const code = `mtc.addColumn({ id: "len", label: "Len" }, (row) => (row.tags.title || "").length);`;
    const { inst } = await run(baseManifest(m), code);
    await flush();
    expect(inst.columns.map((c) => c.id)).toEqual(["plugin.demo.len"]);
    expect(await inst.computeColumn("len", [{ path: "/a", tags: { title: "abcd" } }, { path: "/b", tags: {} }])).toEqual(["4", "0"]);
  });

  it("selection is withheld without read, delivered with it", async () => {
    const code = `globalThis.seen = []; mtc.onSelectionChange((p) => mtc.storage.set("sel", p));`;
    const withRead = await run(baseManifest({ entry: "index.js", permissions: ["read"] }), code);
    withRead.inst.pushSelection(["/q.mp3"]);
    await flush();
    expect(withRead.t.store.get("demo:sel")).toEqual(["/q.mp3"]);
    const noRead = await run(baseManifest({ entry: "index.js", permissions: [] }), code);
    noRead.inst.pushSelection(["/q.mp3"]);
    await flush();
    expect(noRead.t.store.has("demo:sel")).toBe(false);
  });

  it("plugins cannot call script.run, plugins.*, or undeclared actions", async () => {
    const code = `
      mtc.registerAction("a", async () => mtc.call("script.run", {}));
      mtc.registerAction("b", async () => mtc.call("plugins.remove", { id: "x" }));`;
    const m = { entry: "index.js", permissions: ["read", "tags.write", "action:script.run"], contributes: { actions: [{ id: "a", title: "A" }, { id: "b", title: "B" }] } };
    const { t } = await run(baseManifest(m), code);
    await expect(t.registry.run("plugin.demo.a", {}, { caller: "ui", notify: () => {} })).rejects.toThrow(/cannot call/);
    await expect(t.registry.run("plugin.demo.b", {}, { caller: "ui", notify: () => {} })).rejects.toThrow();
  });

  it("registering an undeclared action is refused", async () => {
    const code = `await mtc.registerAction("ghost", async () => 1);`;
    const { inst } = await run(baseManifest({ entry: "index.js" }), code);
    expect(inst.state).toBe("error");
    expect(inst.lastError).toMatch(/not declared/);
  });

  it("a plugin that throws at startup is isolated: error state, nothing registered, app unaffected", async () => {
    const code = `throw new Error("boom");`;
    const { t, inst } = await run(baseManifest({ entry: "index.js", contributes: { actions: [{ id: "x", title: "X" }] } }), code);
    expect(inst.state).toBe("error");
    expect(inst.lastError).toMatch(/boom/);
    expect(t.registry.has("plugin.demo.x")).toBe(false);
    expect(t.notes.some((n) => n.kind === "error" && /boom/.test(n.message))).toBe(true);
  });

  it("a plugin action that throws surfaces as an action error, plugin keeps running", async () => {
    const code = `mtc.registerAction("bad", async () => { throw new Error("nope"); });`;
    const { t, inst } = await run(baseManifest({ entry: "index.js", contributes: { actions: [{ id: "bad", title: "Bad" }] } }), code);
    await expect(t.registry.run("plugin.demo.bad", {}, { caller: "ui", notify: () => {} })).rejects.toThrow(/nope/);
    expect(inst.state).toBe("running");
  });

  it("plugin-declared actions are never read-only and are listed with the plugin in the description", async () => {
    const { t } = await run(baseManifest({ entry: "index.js", permissions: ["files.delete"], contributes: { actions: [{ id: "x", title: "X" }] } }), `mtc.registerAction("x", () => 1);`);
    const info = t.registry.info("plugin.demo.x")!;
    expect(info.readOnly).toBe(false);
    expect(info.dangerous).toBe(true); // holds files.delete
    expect(info.description).toContain('plugin "Demo"');
  });

  it("stop removes registrations", async () => {
    const { t, inst } = await run(baseManifest({ entry: "index.js", contributes: { actions: [{ id: "x", title: "X" }] } }), `mtc.registerAction("x", () => 1);`);
    expect(t.registry.has("plugin.demo.x")).toBe(true);
    inst.stop();
    expect(t.registry.has("plugin.demo.x")).toBe(false);
  });

  it("per-plugin storage is namespaced and size-capped", async () => {
    const code = `mtc.registerAction("w", async ({ big }) => { await mtc.storage.set("k", big ? "x".repeat(300000) : 5); return await mtc.storage.get("k"); });`;
    const { t } = await run(baseManifest({ entry: "index.js", contributes: { actions: [{ id: "w", title: "W", params: { type: "object", properties: { big: { type: "boolean" } } } }] } }), code);
    expect(await t.registry.run("plugin.demo.w", {}, { caller: "ui", notify: () => {} })).toBe(5);
    expect(t.store.get("demo:k")).toBe(5);
    await expect(t.registry.run("plugin.demo.w", { big: true }, { caller: "ui", notify: () => {} })).rejects.toThrow(/256 KB/);
  });
});

describe("manager: approval gate", () => {
  const manifest = JSON.stringify(
    baseManifest({ entry: "index.js", contributes: { actions: [{ id: "x", title: "X" }] } }),
    null,
    2,
  );
  const code = `mtc.registerAction("x", () => 1);`;

  it("an unreviewed folder does not run; approving starts it; editing the code revokes it", async () => {
    const t = makeEnv();
    const { manager, backend } = makeManager(t);
    backend.files.set("demo", { id: "demo", manifest, code });
    await manager.refresh();
    expect(manager.entry("demo")?.status).toBe("needs-review");
    expect(t.registry.has("plugin.demo.x")).toBe(false);
    await expect(manager.enable("demo")).rejects.toThrow(/not been reviewed/);

    await manager.approveInstalled("demo");
    expect(manager.entry("demo")?.status).toBe("running");
    expect(t.registry.has("plugin.demo.x")).toBe(true);

    backend.files.set("demo", { id: "demo", manifest, code: code + "\n// sneaky" });
    await manager.refresh();
    expect(manager.entry("demo")?.status).toBe("needs-review");
    expect(t.registry.has("plugin.demo.x")).toBe(false);
  });

  it("proposals (AI/store) touch nothing until approved; reject leaves no trace", async () => {
    const t = makeEnv();
    const { manager, backend } = makeManager(t);
    const r = await manager.propose(manifest, code, "ai");
    expect(r.status).toBe("pending_review");
    expect(backend.files.size).toBe(0);
    expect(t.registry.has("plugin.demo.x")).toBe(false);
    manager.reject("demo");
    expect(manager.proposals).toHaveLength(0);

    await manager.propose(manifest, code, "ai");
    await manager.approve("demo");
    expect(backend.files.has("demo")).toBe(true);
    expect(manager.entry("demo")?.status).toBe("running");
    expect(t.registry.has("plugin.demo.x")).toBe(true);
  });

  it("an invalid proposal returns the problems", async () => {
    const t = makeEnv();
    const { manager } = makeManager(t);
    const r = await manager.propose(JSON.stringify({ id: "x" }), null, "ai");
    expect(r.status).toBe("invalid");
  });

  it("disable stops it and remove deletes it; one failing plugin does not stop another", async () => {
    const t = makeEnv();
    const { manager, backend } = makeManager(t);
    const bad = JSON.stringify(baseManifest({ id: "bad-one", entry: "index.js" }), null, 2);
    backend.files.set("demo", { id: "demo", manifest, code });
    backend.files.set("bad-one", { id: "bad-one", manifest: bad, code: "throw new Error('x')" });
    await manager.refresh();
    await manager.approveInstalled("demo");
    await manager.approveInstalled("bad-one");
    expect(manager.entry("bad-one")?.status).toBe("error");
    expect(manager.entry("demo")?.status).toBe("running");
    await manager.disable("demo");
    expect(manager.entry("demo")?.status).toBe("disabled");
    expect(t.registry.has("plugin.demo.x")).toBe(false);
    await manager.remove("demo");
    expect(backend.files.has("demo")).toBe(false);
  });
});

describe("bundled example plugins (plugins-examples/)", () => {
  const root = resolve(__dirname, "../../plugins-examples");
  const dirs = readdirSync(root).filter((d) => statSync(join(root, d)).isDirectory());
  const load = (d: string) => {
    const manifest = readFileSync(join(root, d, "manifest.json"), "utf8");
    const entry = JSON.parse(manifest).entry as string | undefined;
    return { manifest, code: entry ? readFileSync(join(root, d, entry), "utf8") : null };
  };

  it("every example has a valid manifest whose id matches its folder", () => {
    expect(dirs.length).toBeGreaterThanOrEqual(3);
    for (const d of dirs) {
      const { manifest } = load(d);
      const r = parseManifest(manifest);
      expect(r.ok, d).toBe(true);
      if (r.ok) expect(r.manifest.id).toBe(d);
    }
  });

  it("hide-genre button hides the genre column through the registry", async () => {
    const t = makeEnv();
    const { manager, backend } = makeManager(t);
    const { manifest, code } = load("hide-genre-button");
    backend.files.set("hide-genre-button", { id: "hide-genre-button", manifest, code });
    await manager.refresh();
    await manager.approveInstalled("hide-genre-button");
    await manager.instance("hide-genre-button")!.click("button", "hide", []);
    expect(t.calls).toEqual([{ id: "table.setColumns", params: { hide: ["genre"] } }]);
  });

  it("copy-artist-title copies a list from track.get", async () => {
    const t = makeEnv();
    t.registry.register({
      id: "track.get",
      title: "t",
      params: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      readOnly: true,
      run: (p: { path: string }) => ({ artist: "A" + p.path, title: "T" }),
    });
    const { manager, backend } = makeManager(t);
    const { manifest, code } = load("copy-artist-title");
    backend.files.set("copy-artist-title", { id: "copy-artist-title", manifest, code });
    await manager.refresh();
    await manager.approveInstalled("copy-artist-title");
    await manager.instance("copy-artist-title")!.click("menu", "copy", ["1", "2"]);
    expect(t.copied).toEqual(["A1 - T" + String.fromCharCode(10) + "A2 - T"]);
  });

  it("bpm-range-column buckets BPM using its setting", async () => {
    const t = makeEnv();
    const { manager, backend } = makeManager(t);
    const { manifest, code } = load("bpm-range-column");
    backend.files.set("bpm-range-column", { id: "bpm-range-column", manifest, code });
    await manager.refresh();
    await manager.approveInstalled("bpm-range-column");
    const inst = manager.instance("bpm-range-column")!;
    await flush();
    const rows = [
      { path: "a", tags: { bpm: "126" } },
      { path: "b", tags: { bpm: "" } },
    ];
    expect(await inst.computeColumn("range", rows)).toEqual(["120-129", ""]);
    manager.setPluginValues("bpm-range-column", { step: 5 });
    await flush();
    expect(await inst.computeColumn("range", rows)).toEqual(["125-129", ""]);
  });
});
