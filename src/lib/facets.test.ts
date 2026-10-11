import { describe, expect, it } from "vitest";
import type { TagData } from "../types";
import {
  arrangeFacet,
  facetLabel,
  matchesFacet,
  samePick,
  tallyFacet,
  type FacetCount,
} from "./facets";

const tag = (p: Partial<TagData>): TagData => ({ hasCoverArt: false, allFields: {}, ...p });
const fc = (name: string, artist: string, count: number): FacetCount => ({ name, artist, count });

describe("arrangeFacet", () => {
  const list = [fc("House", "", 3), fc("", "", 7), fc("Techno", "", 10), fc("Ambient", "", 3)];

  it("puts the none bucket first whatever the sort", () => {
    expect(arrangeFacet(list, "count", "", "No genre").map((f) => f.name)).toEqual(["", "Techno", "Ambient", "House"]);
    expect(arrangeFacet(list, "name", "", "No genre").map((f) => f.name)).toEqual(["", "Ambient", "House", "Techno"]);
  });

  it("filters by name and album artist, and keeps none findable by its label", () => {
    const albums = [fc("Greatest Hits", "Queen", 2), fc("Greatest Hits", "ABBA", 1), fc("Solo", "", 1), fc("", "", 4)];
    expect(arrangeFacet(albums, "count", "abba", "No album").map((f) => f.artist)).toEqual(["ABBA"]);
    expect(arrangeFacet(albums, "count", "no al", "No album").map((f) => f.name)).toEqual([""]);
    expect(arrangeFacet(albums, "count", "greatest", "No album")).toHaveLength(2);
  });

  it("orders same-named albums by artist when sorting A-Z", () => {
    const albums = [fc("Greatest Hits", "Queen", 2), fc("Greatest Hits", "ABBA", 1)];
    expect(arrangeFacet(albums, "name", "", "No album").map((f) => f.artist)).toEqual(["ABBA", "Queen"]);
  });

  it("does not mutate its input", () => {
    const copy = [...list];
    arrangeFacet(list, "name", "", "No genre");
    expect(list).toEqual(copy);
  });
});

describe("tallyFacet", () => {
  it("keeps same-titled albums by different album artists apart and counts untagged", () => {
    const rows = tallyFacet("album", [
      tag({ album: "Greatest Hits", albumArtist: "Queen" }),
      tag({ album: "Greatest Hits", albumArtist: "Queen" }),
      tag({ album: "Greatest Hits", albumArtist: "ABBA" }),
      tag({ album: " " }),
      undefined,
    ]);
    expect(rows).toEqual([fc("Greatest Hits", "Queen", 2), fc("Greatest Hits", "ABBA", 1), fc("", "", 2)]);
  });

  it("genres ignore album artist", () => {
    const rows = tallyFacet("genre", [tag({ genre: "House", albumArtist: "x" }), tag({ genre: "House" })]);
    expect(rows).toEqual([fc("House", "", 2)]);
  });
});

describe("matchesFacet / labels", () => {
  it("matches the none bucket, exact values and album artist", () => {
    expect(matchesFacet(tag({}), { facet: "genre", name: "", artist: "" })).toBe(true);
    expect(matchesFacet(tag({ genre: "House" }), { facet: "genre", name: "", artist: "" })).toBe(false);
    expect(matchesFacet(tag({ genre: "House" }), { facet: "genre", name: "House", artist: "" })).toBe(true);
    const q = { facet: "album", name: "Greatest Hits", artist: "Queen" } as const;
    expect(matchesFacet(tag({ album: "Greatest Hits", albumArtist: "Queen" }), q)).toBe(true);
    expect(matchesFacet(tag({ album: "Greatest Hits", albumArtist: "ABBA" }), q)).toBe(false);
  });

  it("labels", () => {
    expect(facetLabel({ facet: "genre", name: "", artist: "" })).toBe("No genre");
    expect(facetLabel({ facet: "album", name: "X", artist: "Y" })).toBe("X — Y");
    expect(samePick({ facet: "album", name: "X", artist: "" }, { facet: "genre", name: "X", artist: "" })).toBe(false);
  });
});
