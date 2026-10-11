import { describe, expect, it } from "vitest";
import { formatKey, parseKey, sameKey, toCamelot, toOpenKey } from "./keys";

// The full table, written out independently of the implementation:
// [musical minor, musical major, camelot number, open key number]
const WHEEL: [string, string, number, number][] = [
  ["Abm", "B", 1, 6],
  ["Ebm", "F#", 2, 7],
  ["Bbm", "Db", 3, 8],
  ["Fm", "Ab", 4, 9],
  ["Cm", "Eb", 5, 10],
  ["Gm", "Bb", 6, 11],
  ["Dm", "F", 7, 12],
  ["Am", "C", 8, 1],
  ["Em", "G", 9, 2],
  ["Bm", "D", 10, 3],
  ["F#m", "A", 11, 4],
  ["C#m", "E", 12, 5],
];

describe("key conversion", () => {
  it("maps every one of the 24 keys between all three notations", () => {
    for (const [minor, major, camelot, open] of WHEEL) {
      expect(formatKey(minor, "camelot")).toBe(`${camelot}A`);
      expect(formatKey(major, "camelot")).toBe(`${camelot}B`);
      expect(formatKey(minor, "openkey")).toBe(`${open}m`);
      expect(formatKey(major, "openkey")).toBe(`${open}d`);
      expect(formatKey(`${camelot}A`, "openkey")).toBe(`${open}m`);
      expect(formatKey(`${camelot}B`, "openkey")).toBe(`${open}d`);
      expect(formatKey(`${open}m`, "camelot")).toBe(`${camelot}A`);
      expect(formatKey(`${open}d`, "camelot")).toBe(`${camelot}B`);
    }
  });

  it("matches the examples DJs know", () => {
    expect(formatKey("Am", "camelot")).toBe("8A");
    expect(formatKey("C", "camelot")).toBe("8B");
    expect(formatKey("8A", "openkey")).toBe("1m");
    expect(formatKey("10A", "openkey")).toBe("3m");
    expect(formatKey("3m", "camelot")).toBe("10A");
  });

  it("accepts sharps, flats, unicode accidentals, long names and leading zeros", () => {
    expect(toCamelot(parseKey("G#m")!)).toBe("1A");
    expect(toCamelot(parseKey("A♭m")!)).toBe("1A");
    expect(toCamelot(parseKey("F♯ minor")!)).toBe("11A");
    expect(toCamelot(parseKey("Bb major")!)).toBe("6B");
    expect(toCamelot(parseKey("bb")!)).toBe("6B");
    expect(toCamelot(parseKey("08a")!)).toBe("8A");
    expect(toOpenKey(parseKey("08A")!)).toBe("1m");
  });

  it("leaves 'stored' and unrecognised values exactly as they are", () => {
    expect(formatKey("Am", "stored")).toBe("Am");
    expect(formatKey("Xyz", "camelot")).toBe("Xyz");
    expect(formatKey("13A", "camelot")).toBe("13A");
    expect(formatKey("", "camelot")).toBe("");
    expect(formatKey(undefined, "openkey")).toBe("");
  });

  it("sameKey compares across notations", () => {
    expect(sameKey("Am", "8A")).toBe(true);
    expect(sameKey("8A", "1m")).toBe(true);
    expect(sameKey("8A", "8B")).toBe(false);
    expect(sameKey("weird", "WEIRD")).toBe(true);
    expect(sameKey("", undefined)).toBe(true);
  });
});
