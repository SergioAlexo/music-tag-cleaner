import { describe, expect, it } from "vitest";
import { contentKeyFor, findSameList, freshName, hasDecisions, keepDecisions, parsePayload } from "./ytSessions";
import { linkLooksRight, runLimited } from "./ytLinks";

describe("parsePayload", () => {
  it("fills in what an old or fresh session lacks and refuses unreadable text", () => {
    expect(parsePayload('{"version":1,"entries":[],"links":{}}')).toMatchObject({ overrides: {}, denied: {}, links: {} });
    expect(parsePayload("{")).toBeNull();
    expect(parsePayload("null")).toBeNull();
  });
});

describe("keepDecisions", () => {
  it("keeps only decisions about entries still in the list", () => {
    const d = { overrides: { a: "x", b: "y" }, denied: { b: ["z"] }, candIndex: { a: 1 }, fromSearch: {} };
    const kept = keepDecisions(d, new Set(["a"]));
    expect(kept).toEqual({ overrides: { a: "x" }, denied: {}, candIndex: { a: 1 }, fromSearch: {} });
    expect(hasDecisions(kept)).toBe(true);
    expect(hasDecisions(keepDecisions(d, new Set()))).toBe(false);
  });
});

describe("findSameList", () => {
  const base = { url: "", savedAt: 0, trackCount: 0, matched: null, title: "x" };
  it("finds an old session by its key and a new one by its content key", () => {
    const old = { ...base, key: "list:PL1", contentKey: null };
    const fresh = { ...base, key: "s:1", contentKey: "list:PL2" };
    expect(findSameList([old, fresh], "list:PL1", "s:9")).toBe(old);
    expect(findSameList([old, fresh], "list:PL2", "s:9")).toBe(fresh);
    expect(findSameList([old, fresh], "list:PL2", "s:1")).toBeNull();
  });

  it("recognizes a playlist from either domain", () => {
    expect(contentKeyFor("https://music.youtube.com/playlist?list=PL1&si=x")).toBe(
      contentKeyFor("https://www.youtube.com/playlist?list=PL1"),
    );
  });
});

describe("freshName", () => {
  it("numbers further new sessions", () => {
    expect(freshName([])).toBe("New import");
    expect(freshName([{ title: "New import" }, { title: "New import 2" }])).toBe("New import 3");
  });
});

describe("linkLooksRight", () => {
  const link = (title: string, ...artists: string[]) => ({ videoId: "x", url: "", title, artists });

  it("accepts the song, either way round, with features and Cyrillic", () => {
    expect(linkLooksRight("Anna Asti — Царица", link("Царица", "ANNA ASTI"))).toBe(true);
    expect(linkLooksRight("Low - Flo Rida", link("Low (feat. T-Pain)", "Flo Rida"))).toBe(true);
    expect(linkLooksRight("Sandstorm", link("Sandstorm", "Darude"))).toBe(true);
  });

  it("rejects another song by the artist, and the title by someone else", () => {
    expect(linkLooksRight("Anna Asti — Царица", link("По барам", "ANNA ASTI"))).toBe(false);
    expect(linkLooksRight("Rihanna - Disturbia", link("Disturbia", "The Cheap Covers"))).toBe(false);
  });
});

describe("runLimited", () => {
  it("handles every item, never more than the limit at once, and stops when cancelled", async () => {
    let running = 0;
    let most = 0;
    const seen: number[] = [];
    await runLimited(
      [1, 2, 3, 4, 5],
      2,
      async (n) => {
        most = Math.max(most, ++running);
        await Promise.resolve();
        running--;
        seen.push(n);
      },
      () => false,
    );
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(most).toBe(2);

    const few: number[] = [];
    await runLimited([1, 2, 3], 1, async (n) => void few.push(n), () => few.length >= 1);
    expect(few).toEqual([1]);
  });
});
