import { describe, expect, it } from "vitest";
import {
  afterManualAdd,
  closeTab,
  decideGenreClick,
  tabTitle,
  type SessionSource,
} from "./sessionTabs";

describe("decideGenreClick", () => {
  const empty: SessionSource = { kind: "empty" };
  const genre: SessionSource = { kind: "facet", facet: "genre", name: "House", artist: "" };
  const manual: SessionSource = { kind: "manual" };

  it("loads straight away in an empty or genre session", () => {
    expect(decideGenreClick({ source: empty, hasUnappliedPreview: false })).toBe("load");
    expect(decideGenreClick({ source: genre, hasUnappliedPreview: false })).toBe("load");
  });

  it("confirms first only when a preview would be discarded", () => {
    expect(decideGenreClick({ source: empty, hasUnappliedPreview: true })).toBe("confirm-load");
    expect(decideGenreClick({ source: genre, hasUnappliedPreview: true })).toBe("confirm-load");
  });

  it("ignores a remembered choice outside a hand-built batch", () => {
    expect(decideGenreClick({ source: genre, hasUnappliedPreview: false, manualChoice: "replace" })).toBe("load");
    expect(decideGenreClick({ source: empty, hasUnappliedPreview: false, manualChoice: "filter" })).toBe("load");
  });

  it("asks in a hand-built batch unless a choice was remembered", () => {
    expect(decideGenreClick({ source: manual, hasUnappliedPreview: false })).toBe("ask");
    expect(decideGenreClick({ source: manual, hasUnappliedPreview: true, manualChoice: "ask" })).toBe("ask");
  });

  it("maps each remembered choice for a hand-built batch", () => {
    const base = { source: manual, hasUnappliedPreview: false };
    expect(decideGenreClick({ ...base, manualChoice: "newTab" })).toBe("new-tab");
    expect(decideGenreClick({ ...base, manualChoice: "replace" })).toBe("replace");
    expect(decideGenreClick({ ...base, manualChoice: "filter" })).toBe("filter");
  });
});

describe("afterManualAdd", () => {
  it("flips every source, genre sessions included, to manual", () => {
    expect(afterManualAdd({ kind: "empty" })).toEqual({ kind: "manual" });
    expect(afterManualAdd({ kind: "facet", facet: "genre", name: "House", artist: "" })).toEqual({ kind: "manual" });
    expect(afterManualAdd({ kind: "manual" })).toEqual({ kind: "manual" });
  });
});

describe("tabTitle", () => {
  it("uses the genre name for a genre session", () => {
    expect(tabTitle({ kind: "facet", facet: "genre", name: "Deep House", artist: "" }, ["D:\\Music\\a.mp3"])).toBe("Deep House");
  });

  it("names an album tab with its album artist, and a none bucket by its label", () => {
    expect(tabTitle({ kind: "facet", facet: "album", name: "Greatest Hits", artist: "Queen" }, ["a"])).toBe(
      "Greatest Hits — Queen",
    );
    expect(tabTitle({ kind: "facet", facet: "genre", name: "", artist: "" }, ["a"])).toBe("No genre");
  });

  it("uses the shared folder for a manual session", () => {
    const paths = ["D:\\Music\\Incoming\\a.mp3", "D:\\Music\\Incoming\\b.mp3"];
    expect(tabTitle({ kind: "manual" }, paths)).toBe("Incoming");
    expect(tabTitle({ kind: "manual" }, ["/home/dj/Incoming/a.mp3"])).toBe("Incoming");
  });

  it("falls back to Files when the files come from several folders", () => {
    expect(tabTitle({ kind: "manual" }, ["D:\\A\\a.mp3", "D:\\B\\b.mp3"])).toBe("Files");
  });

  it("calls an empty session a new tab", () => {
    expect(tabTitle({ kind: "empty" }, [])).toBe("New tab");
    expect(tabTitle({ kind: "manual" }, [])).toBe("New tab");
  });
});

describe("closeTab", () => {
  const t = (id: string) => ({ id });
  const fresh = () => t("fresh");

  it("keeps the active tab when closing a different one", () => {
    const r = closeTab([t("a"), t("b"), t("c")], "b", "c", fresh);
    expect(r.tabs.map((x) => x.id)).toEqual(["a", "b"]);
    expect(r.activeId).toBe("b");
    expect(r.restore).toBeNull();
  });

  it("moves to the right neighbour when closing the active tab", () => {
    const r = closeTab([t("a"), t("b"), t("c")], "b", "b", fresh);
    expect(r.activeId).toBe("c");
    expect(r.restore?.id).toBe("c");
  });

  it("moves left when the active tab was the last one", () => {
    const r = closeTab([t("a"), t("b")], "b", "b", fresh);
    expect(r.activeId).toBe("a");
  });

  it("leaves one empty tab after closing the last", () => {
    const r = closeTab([t("a")], "a", "a", fresh);
    expect(r.tabs.map((x) => x.id)).toEqual(["fresh"]);
    expect(r.activeId).toBe("fresh");
    expect(r.restore?.id).toBe("fresh");
  });

  it("ignores an unknown id", () => {
    const tabs = [t("a")];
    expect(closeTab(tabs, "a", "zzz", fresh).tabs).toBe(tabs);
  });
});
