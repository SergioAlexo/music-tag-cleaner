import { describe, expect, it } from "vitest";
import { describeProgress, describeRefresh, refreshChangedAnything } from "./libraryRefresh";

describe("describeRefresh", () => {
  it("reports new, changed and removed", () => {
    expect(describeRefresh({ added: 3, updated: 1, removed: 0, errors: [] })).toBe("3 new, 1 changed, 0 removed");
  });
  it("mentions unreadable files rather than hiding them", () => {
    expect(describeRefresh({ added: 0, updated: 0, removed: 2, errors: ["a: bad"] })).toBe(
      "0 new, 0 changed, 2 removed (1 unreadable)",
    );
  });
  it("knows when nothing changed", () => {
    expect(refreshChangedAnything({ added: 0, updated: 0, removed: 0 })).toBe(false);
    expect(refreshChangedAnything({ added: 0, updated: 0, removed: 1 })).toBe(true);
  });
});

describe("describeProgress", () => {
  it("covers the phases", () => {
    expect(describeProgress(null)).toBe("Scanning folders…");
    expect(describeProgress({ phase: "reading", done: 5, total: 40, current: "" })).toBe("Reading 5 of 40…");
    expect(describeProgress({ phase: "reading", done: 0, total: 0, current: "" })).toBe("Reading…");
  });
});
