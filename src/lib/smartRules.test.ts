import { describe, expect, it } from "vitest";
import {
  buildRekordboxSmartList,
  compatibleKeys,
  describeRuleSet,
  evaluateRuleSet,
  parseRekordboxSmartList,
  parseRuleSet,
  type RuleSet,
  type RuleTrack,
} from "./smartRules";

const t = (o: Partial<RuleTrack>): RuleTrack => ({
  title: "", artist: "", album: "", genre: "", key: "", bpm: 0, rating: 0, year: "", comment: "", dateAdded: "", language: "", ...o,
});

const lib: RuleTrack[] = [
  t({ title: "A", genre: "House Deep", bpm: 124, key: "8A", rating: 3, year: "2020", language: "eng", dateAdded: "2026-10-01" }),
  t({ title: "B", genre: "RU Drum And Bass", bpm: 174, key: "Am", rating: 5, year: "2019", language: "rus", dateAdded: "2026-01-01" }),
  t({ title: "C", genre: "RU Pop", bpm: 127.99, key: "9A", rating: 0, year: "2021", language: "spa", dateAdded: "2026-10-09", comment: "Peak Time" }),
  t({ title: "D", genre: "", bpm: 0 }),
  t({ title: "E", genre: "Techno", bpm: 130, key: "1B", rating: 4 }),
];
const titles = (s: RuleSet, now = Date.parse("2026-10-11")) => evaluateRuleSet(s, lib, now).map((x) => x.title);

describe("rule evaluation", () => {
  it("text operators are case/accent-insensitive", () => {
    expect(titles({ match: "all", rules: [{ field: "genre", op: "is", value: "house deep" }] })).toEqual(["A"]);
    expect(titles({ match: "all", rules: [{ field: "genre", op: "contains", value: "ru" }] })).toEqual(["B", "C"]);
    expect(titles({ match: "all", rules: [{ field: "genre", op: "startsWith", value: "tech" }] })).toEqual(["E"]);
    expect(titles({ match: "all", rules: [{ field: "genre", op: "empty", value: "" }] })).toEqual(["D"]);
  });
  it("all vs any", () => {
    const rules = [
      { field: "genre" as const, op: "contains" as const, value: "RU" },
      { field: "genre" as const, op: "notContains" as const, value: "Drum And Bass" },
    ];
    expect(titles({ match: "all", rules })).toEqual(["C"]); // the owner's "Russian" playlist
    expect(titles({ match: "any", rules })).toEqual(["A", "B", "C", "D", "E"]);
    expect(titles({ match: "all", rules: [] })).toEqual([]);
  });
  it("bpm is tolerant and ranges are inclusive", () => {
    expect(titles({ match: "all", rules: [{ field: "bpm", op: "is", value: "128" }] })).toEqual(["C"]);
    expect(titles({ match: "all", rules: [{ field: "bpm", op: "between", value: "124", value2: "130" }] })).toEqual(["A", "C", "E"]);
    expect(titles({ match: "all", rules: [{ field: "bpm", op: "gt", value: "150" }] })).toEqual(["B"]);
    expect(titles({ match: "all", rules: [{ field: "bpm", op: "empty", value: "" }] })).toEqual(["D"]);
  });
  it("rating and year", () => {
    expect(titles({ match: "all", rules: [{ field: "rating", op: "gt", value: "3" }] })).toEqual(["B", "E"]);
    expect(titles({ match: "all", rules: [{ field: "year", op: "between", value: "2020", value2: "2021" }] })).toEqual(["A", "C"]);
  });
  it("keys: same key in any spelling, and compatible keys", () => {
    expect(titles({ match: "all", rules: [{ field: "key", op: "is", value: "8A" }] })).toEqual(["A", "B"]);
    expect(compatibleKeys("8A").sort()).toEqual(["7A", "8A", "8B", "9A"]);
    expect(compatibleKeys("1B").sort()).toEqual(["12B", "1A", "1B", "2B"]); // wraps the wheel
    expect(titles({ match: "all", rules: [{ field: "key", op: "compatible", value: "Am" }] })).toEqual(["A", "B", "C"]);
  });
  it("language accepts codes and names", () => {
    expect(titles({ match: "all", rules: [{ field: "language", op: "is", value: "Spanish" }] })).toEqual(["C"]);
    expect(titles({ match: "all", rules: [{ field: "language", op: "is", value: "ru" }] })).toEqual(["B"]);
  });
  it("date added: in the last N days", () => {
    expect(titles({ match: "all", rules: [{ field: "dateAdded", op: "inLast", value: "7" }] })).toEqual(["C"]);
    expect(titles({ match: "all", rules: [{ field: "dateAdded", op: "inLast", value: "30" }] })).toEqual(["A", "C"]);
  });
  it("comment contains", () => {
    expect(titles({ match: "all", rules: [{ field: "comment", op: "contains", value: "peak" }] })).toEqual(["C"]);
  });
  it("describes and parses stored rules", () => {
    const s: RuleSet = { match: "any", rules: [{ field: "bpm", op: "between", value: "120", value2: "128" }, { field: "genre", op: "is", value: "House" }] };
    expect(describeRuleSet(s)).toBe("BPM is between 120 and 128 OR Genre is House");
    expect(parseRuleSet(JSON.stringify(s))).toEqual(s);
    expect(parseRuleSet("nope")).toBeNull();
  });
});

// Real SmartList values from the owner's master.db (plans/v0.19/notes/C0-findings.md).
const REAL_GENRE_IS =
  '<NODE Id="1345573694" LogicalOperator="1" AutomaticUpdate="0"><CONDITION PropertyName="genre" Operator="1" ValueUnit="" ValueLeft="House Deep" ValueRight=""/></NODE>';
const REAL_RUSSIAN =
  '<NODE Id="-534637076" LogicalOperator="1" AutomaticUpdate="0"><CONDITION PropertyName="genre" Operator="8" ValueUnit="" ValueLeft="RU" ValueRight=""/><CONDITION PropertyName="genre" Operator="9" ValueUnit="" ValueLeft="Drum And Bass" ValueRight=""/></NODE>';
const REAL_MYTAG =
  '<NODE Id="1" LogicalOperator="1" AutomaticUpdate="0"><CONDITION PropertyName="myTag" Operator="8" ValueUnit="" ValueLeft="-160068167" ValueRight=""/></NODE>';

describe("Rekordbox smart list XML", () => {
  it("parses the real genre-is list and round-trips byte-for-byte", () => {
    const s = parseRekordboxSmartList(REAL_GENRE_IS)!;
    expect(s).toEqual({ match: "all", rules: [{ field: "genre", op: "is", value: "House Deep" }] });
    expect(buildRekordboxSmartList(s, 1345573694)).toBe(REAL_GENRE_IS);
  });
  it("parses the real two-condition list and round-trips byte-for-byte", () => {
    const s = parseRekordboxSmartList(REAL_RUSSIAN)!;
    expect(s.rules.map((r) => [r.field, r.op, r.value])).toEqual([
      ["genre", "contains", "RU"],
      ["genre", "notContains", "Drum And Bass"],
    ]);
    // The signed-int32 Id for playlist 3760330220 is -534637076.
    expect(buildRekordboxSmartList(s, 3760330220)).toBe(REAL_RUSSIAN);
    expect(titles(s)).toEqual(["C"]);
  });
  it("keeps myTag as an unsupported rule and still round-trips it", () => {
    const s = parseRekordboxSmartList(REAL_MYTAG)!;
    expect(s.rules).toEqual([]);
    expect(s.unsupported).toHaveLength(1);
    expect(s.unsupported![0].label).toContain("myTag");
    expect(describeRuleSet(s)).toContain("[unsupported");
    expect(buildRekordboxSmartList(s, 1)).toBe(REAL_MYTAG);
  });
  it("won't invent XML for rules Rekordbox can't express", () => {
    expect(buildRekordboxSmartList({ match: "all", rules: [{ field: "language", op: "is", value: "spa" }] }, 5)).toBeNull();
    expect(buildRekordboxSmartList({ match: "all", rules: [{ field: "key", op: "compatible", value: "8A" }] }, 5)).toBeNull();
  });
  it("escapes values and reads ANY lists", () => {
    const s: RuleSet = { match: "any", rules: [{ field: "genre", op: "is", value: 'R&B "Soul"' }] };
    const x = buildRekordboxSmartList(s, 7)!;
    expect(x).toContain('LogicalOperator="2"');
    expect(parseRekordboxSmartList(x)).toEqual(s);
  });
  it("returns null for junk", () => {
    expect(parseRekordboxSmartList("")).toBeNull();
    expect(parseRekordboxSmartList("<PLAYLISTS/>")).toBeNull();
  });
});
