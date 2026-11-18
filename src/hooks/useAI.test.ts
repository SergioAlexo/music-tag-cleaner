import { describe, expect, it } from "vitest";
import { buildCleanRows, cleanInputs, resultsForBatch } from "./useAI";
import type { CleanedTrack, TagData } from "../types";

describe("resultsForBatch", () => {
  it("drops results whose index belongs to another batch", () => {
    const paths = ["a.mp3", "b.mp3", "c.mp3", "d.mp3"];
    const map = Object.fromEntries(paths.map((p) => [p, { allFields: {} } as unknown as TagData]));
    const inputs = cleanInputs(paths, map);
    const secondBatch = inputs.slice(2); // indexes 3 and 4
    const answer: CleanedTrack[] = [
      { index: 3, title: "Right" },
      { index: 1, title: "Hallucinated — belongs to the first batch" },
      { index: 9, title: "Out of range" },
    ] as CleanedTrack[];
    expect(resultsForBatch(secondBatch, answer).map((r) => r.index)).toEqual([3]);
  });
});

describe("buildCleanRows field selection", () => {
  const map = {
    "a.mp3": {
      artist: "Daft Punk feat. X",
      title: "One More Time (Radio Edit)",
      year: "",
      genre: "",
      album: "",
      hasCoverArt: false,
      allFields: {},
    } as unknown as TagData,
  };
  const answer = new Map<number, CleanedTrack>([
    [1, { index: 1, artist: "Daft Punk", title: "One More Time", year: "2000", genre: "House", album: "Discovery" }],
  ]);
  const changedFields = (opts?: Parameters<typeof buildCleanRows>[3]) =>
    buildCleanRows(["a.mp3"], map, answer, opts)
      .rows.filter((r) => r.changed)
      .map((r) => r.field);

  it("defaults to the four classic fields plus the Album Artist copy", () => {
    expect(changedFields()).toEqual(["artist", "title", "year", "genre", "albumArtist"]);
  });

  it("only Year touches nothing else, even when the model answered more", () => {
    expect(changedFields({ fields: ["year"] })).toEqual(["year"]);
  });

  it("writes Album only when asked", () => {
    expect(changedFields({ fields: ["album"] })).toEqual(["album"]);
  });

  it("fill-empty-only keeps fields that already have a value", () => {
    expect(changedFields({ fields: ["artist", "title", "year", "genre"], fillEmptyOnly: true })).toEqual([
      "year",
      "genre",
    ]);
  });

  it("does not report a track as unidentified when names were not asked for", () => {
    const blank = { "b.mp3": { hasCoverArt: false, allFields: {} } as unknown as TagData };
    const none = new Map<number, CleanedTrack>([[1, { index: 1, year: "1999" }]]);
    expect(buildCleanRows(["b.mp3"], blank, none, { fields: ["year"] }).unresolved).toEqual([]);
    expect(buildCleanRows(["b.mp3"], blank, none, { fields: ["artist", "year"] }).unresolved).toEqual(["b.mp3"]);
  });

  it("the Album Artist copy alone needs no model answer", () => {
    const rows = buildCleanRows(["a.mp3"], map, new Map(), { fields: ["albumArtist"] }).rows;
    expect(rows.map((r) => [r.field, r.after])).toEqual([["albumArtist", "Daft Punk feat. X"]]);
  });
});
