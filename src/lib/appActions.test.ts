import { describe, expect, it, vi } from "vitest";
import { ActionRegistry } from "./actions";
import { publicSettings, registerAppActions, type AppEnv } from "./appActions";
import { DEFAULT_SETTINGS } from "../hooks/useSettings";
import type { AudioFile } from "../types";

const file = (name: string): AudioFile => ({
  path: `C:/m/${name}.mp3`,
  filename: `${name}.mp3`,
  format: "mp3",
  size: 1,
  hasBackup: false,
});

function setup() {
  const calls: string[] = [];
  let selected: string[] = [];
  const env = {
    page: "library",
    setPage: vi.fn(),
    busy: false,
    settings: { ...DEFAULT_SETTINGS },
    columns: [
      { id: "title", label: "Title" },
      { id: "genre", label: "Genre" },
      { id: "artist", label: "Artist" },
    ],
    savePatch: vi.fn(),
    notify: vi.fn(),
    files: [file("a"), file("b")],
    get selectedPaths() {
      return selected;
    },
    setSelection: (p: string[]) => {
      selected = p;
    },
    importPaths: vi.fn(),
    readTags: async () => ({ map: {}, errors: [] }),
    library: { files: [], tags: {}, stats: null, facets: null, runIndex: vi.fn() },
    pending: null,
    previewMode: "clear",
    canUndo: false,
    canRedo: false,
    h: {
      removeChars: () => void calls.push(`removeChars:${selected.join(",")}`),
      deleteFile: vi.fn(),
    },
  } as unknown as AppEnv;
  const reg = new ActionRegistry();
  registerAppActions(reg, () => env);
  return { reg, env, calls };
}
const ctx = { caller: "ai" as const, notify: () => {} };

describe("registerAppActions", () => {
  it("registers a sane, serialisable set with unique ids", () => {
    const { reg } = setup();
    const list = reg.list();
    for (const id of ["session.list", "session.selection", "library.search", "track.get", "playlists.list",
      "settings.get", "columns.list", "table.select", "table.setColumns", "nav.goto", "ui.notify", "script.run"]) {
      expect(reg.has(id), id).toBe(true);
    }
    expect(new Set(list.map((a) => a.id)).size).toBe(list.length);
    expect(JSON.parse(JSON.stringify(list))).toHaveLength(list.length);
    for (const a of list) expect(a.params.type, a.id).toBe("object");
  });

  it("table.setColumns hides a column and rejects unknown ids", async () => {
    const { reg, env } = setup();
    env.settings.visibleColumns = ["title", "genre"];
    await reg.run("table.setColumns", { hide: ["genre"] }, ctx);
    expect(env.savePatch).toHaveBeenCalledWith({ visibleColumns: ["title"] });
    await expect(reg.run("table.setColumns", { hide: ["nope"] }, ctx)).rejects.toThrow(/Unknown column/);
  });

  it("table.select selects loaded paths only", async () => {
    const { reg, env } = setup();
    await reg.run("table.select", { paths: ["C:/m/a.mp3"] }, ctx);
    expect(env.selectedPaths).toEqual(["C:/m/a.mp3"]);
    await expect(reg.run("table.select", { paths: ["C:/other.mp3"] }, ctx)).rejects.toThrow(/not in the session/);
    await reg.run("table.select", { all: true }, ctx);
    expect(env.selectedPaths).toHaveLength(2);
  });

  it("selection-based actions select first, then call the wrapped handler", async () => {
    const { reg, calls } = setup();
    await reg.run("tags.standardize", { paths: ["C:/m/b.mp3"], scope: "removeChars" }, ctx);
    expect(calls).toEqual(["removeChars:C:/m/b.mp3"]);
  });

  it("script dry run lists dangerous steps and runs nothing", async () => {
    const { reg, env, calls } = setup();
    const out = (await reg.run(
      "script.run",
      {
        dryRun: true,
        steps: [
          { action: "table.select", params: { all: true } },
          { action: "files.delete", params: { path: "C:/m/a.mp3" } },
        ],
      },
      ctx,
    )) as { plan: { dangerous: boolean }[] };
    expect(out.plan.map((p) => p.dangerous)).toEqual([false, true]);
    expect(env.selectedPaths).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("dangerous action from the AI is refused when nobody approves", async () => {
    const { reg } = setup();
    // files.delete confirms itself in the app, so use a gate-only one.
    await expect(
      reg.run("convert.run", { paths: ["C:/m/a.mp3"], preset: "mp3-320" }, ctx),
    ).rejects.toMatchObject({ code: "denied" });
  });

  it("settings.get hides secret-looking keys", () => {
    const out = publicSettings({ ...DEFAULT_SETTINGS, apiKey: "sk-1" } as never);
    expect(out.apiKey).toBe("(hidden)");
    expect(out.aiBackend).toBe(DEFAULT_SETTINGS.aiBackend);
  });
});
