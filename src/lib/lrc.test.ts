import { describe, expect, it } from "vitest";
import { currentLineIndex, isSynced, parseLrc, parseTimestamp } from "./lrc";

describe("parseTimestamp", () => {
  it("handles every precision", () => {
    expect(parseTimestamp("01:02")).toBe(62_000);
    expect(parseTimestamp("01:02.5")).toBe(62_500);
    expect(parseTimestamp("01:02.50")).toBe(62_500);
    expect(parseTimestamp("01:02.345")).toBe(62_345);
    expect(parseTimestamp("01:02:34")).toBe(62_340);
    expect(parseTimestamp("ar:Someone")).toBeNull();
  });
});

describe("parseLrc", () => {
  it("sorts lines, expands repeated tags and ignores metadata", () => {
    const lines = parseLrc("[ar:X]\n[ti:Y]\n[00:20.00][00:40.00]Chorus\n[00:12.00]First\r\n[00:15.5]Second\nno tag here\n");
    expect(lines.map((l) => [l.timeMs, l.text])).toEqual([
      [12_000, "First"],
      [15_500, "Second"],
      [20_000, "Chorus"],
      [40_000, "Chorus"],
    ]);
  });

  it("applies the offset tag and clamps at zero", () => {
    const lines = parseLrc("[offset:+500]\n[00:00.20]a\n[00:10.00]b");
    expect(lines.map((l) => l.timeMs)).toEqual([0, 9_500]);
  });

  it("tells synced from plain", () => {
    expect(isSynced("[00:01.00]a\n[00:02.00]b")).toBe(true);
    expect(isSynced("just\nwords")).toBe(false);
  });
});

describe("currentLineIndex", () => {
  const lines = parseLrc("[00:10.00]a\n[00:20.00]b\n[00:30.00]c");
  it("finds the line being sung", () => {
    expect(currentLineIndex(lines, 0)).toBe(-1);
    expect(currentLineIndex(lines, 10_000)).toBe(0);
    expect(currentLineIndex(lines, 19_999)).toBe(0);
    expect(currentLineIndex(lines, 25_000)).toBe(1);
    expect(currentLineIndex(lines, 999_999)).toBe(2);
    expect(currentLineIndex([], 5)).toBe(-1);
  });
});
