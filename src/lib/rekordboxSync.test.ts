import { describe, expect, it } from "vitest";
import type { AudioFile, TagData } from "../types";
import { bpmCell, bpmForFormat, buildRekordboxSyncPreview, keyCell, ratingCell } from "./rekordboxSync";

const file = (over: Partial<AudioFile> = {}): AudioFile => ({
  path: "C:/m/a.mp3",
  filename: "a.mp3",
  format: "mp3",
  size: 1,
  hasBackup: false,
  ...over,
});
const tags = (over: Partial<TagData> = {}): TagData => ({ hasCoverArt: false, allFields: {}, ...over });

describe("bpmForFormat", () => {
  it("rounds for integer containers and keeps two decimals for Vorbis", () => {
    expect(bpmForFormat(127.99, "mp3")).toBe("128");
    expect(bpmForFormat(127.99, "m4a")).toBe("128");
    expect(bpmForFormat(127.994, "flac")).toBe("127.99");
    expect(bpmForFormat(128, "FLAC")).toBe("128");
  });
});

describe("table cells", () => {
  it("shows the tag, not Rekordbox, when both agree", () => {
    expect(bpmCell(file({ bpm: 127.9 }), tags({ bpm: "128" }))).toMatchObject({ text: "128", fromRekordbox: false });
    expect(keyCell(file({ key: "8A" }), tags({ key: "Am" }))).toMatchObject({ text: "Am", fromRekordbox: false });
  });
  it("falls back to Rekordbox with a marker when the tag is empty", () => {
    expect(bpmCell(file({ bpm: 127.6 }), tags())).toMatchObject({ text: "128", fromRekordbox: true });
    expect(keyCell(file({ key: "8A" }), tags())).toMatchObject({ text: "8A", fromRekordbox: true });
    expect(bpmCell(file(), tags())).toMatchObject({ text: "", fromRekordbox: false });
  });
  it("keeps the tag but flags a disagreement", () => {
    const c = bpmCell(file({ bpm: 140 }), tags({ bpm: "70" }));
    expect(c).toMatchObject({ text: "70", fromRekordbox: true });
    expect(c.note).toContain("140");
    expect(keyCell(file({ key: "9A" }), tags({ key: "8A" }))).toMatchObject({ text: "8A", fromRekordbox: true });
  });
  it("rating: tag first, then Rekordbox", () => {
    expect(ratingCell(file({ rbRating: 5 }), tags({ rating: 3 }))).toEqual({ stars: 3, fromRekordbox: false });
    expect(ratingCell(file({ rbRating: 5 }), tags())).toEqual({ stars: 5, fromRekordbox: true });
    expect(ratingCell(file(), tags())).toEqual({ stars: 0, fromRekordbox: false });
  });
});

describe("buildRekordboxSyncPreview", () => {
  it("emits only fields that are missing or different", () => {
    const f = file({ bpm: 127.6, key: "8A", rbRating: 4 });
    const rows = buildRekordboxSyncPreview([f], { [f.path]: tags({ bpm: "128", key: "Am", rating: 4 }) });
    expect(rows).toEqual([]);

    const rows2 = buildRekordboxSyncPreview([f], { [f.path]: tags({ bpm: "120", rating: 2 }) });
    expect(rows2.map((r) => [r.field, r.before, r.after])).toEqual([
      ["bpm", "120", "128"],
      ["key", "", "8A"],
      ["rating", "2", "4"],
    ]);
    expect(rows2.every((r) => r.include && r.changed && r.kind === "update")).toBe(true);
  });
  it("skips files Rekordbox does not know and files with no loaded tags", () => {
    const a = file({ path: "x" });
    const b = file({ path: "y", bpm: 120 });
    expect(buildRekordboxSyncPreview([a, b], { x: tags() })).toEqual([]);
  });
  it("writes decimals only where the format keeps them", () => {
    const f = file({ path: "z.flac", format: "flac", bpm: 127.99 });
    const rows = buildRekordboxSyncPreview([f], { [f.path]: tags() });
    expect(rows[0].after).toBe("127.99");
  });
});
