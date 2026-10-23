import { describe, expect, it } from "vitest";
import type { TagData } from "../types";
import { foldEditsByPath, writtenOnly } from "./useTags";

const tags = (over: Partial<TagData> = {}): TagData => ({
  title: "Kerala",
  artist: "Bonobo",
  genre: "Downtempo",
  hasCoverArt: false,
  allFields: { TrackTitle: "Kerala", TrackArtist: "Bonobo", Label: "Ninja Tune" },
  ...over,
});

describe("foldEditsByPath", () => {
  it("writes several edits of one file as one item carrying all of them", () => {
    const current = tags();
    const items = foldEditsByPath([
      { path: "a.mp3", current, field: "title", value: "Kerala (Edit)" },
      { path: "b.mp3", current: tags({ title: "Other" }), field: "rating", value: 4 },
      { path: "a.mp3", current, field: "genre", value: "Electronica" },
    ]);
    expect(items.map((i) => i.path)).toEqual(["a.mp3", "b.mp3"]);
    // Two separate items for a.mp3 would each carry the other's field at its
    // old value, and the second write would undo the first.
    expect(items[0].tags).toMatchObject({ title: "Kerala (Edit)", genre: "Electronica", artist: "Bonobo" });
    expect(items[1].tags).toMatchObject({ title: "Other", rating: 4 });
  });

  it("keeps every non-curated field and leaves the caller's snapshot alone", () => {
    const current = tags();
    const [item] = foldEditsByPath([{ path: "a.mp3", current, field: "artist", value: "Simon Green" }]);
    expect(item.keepExtra).toEqual(["Label"]);
    expect(current.artist).toBe("Bonobo");
  });

  it("keeps only the changes whose file was written", () => {
    const attempted = [
      { path: "a.mp3", field: "title" },
      { path: "locked.mp3", field: "title" },
      { path: "b.mp3", field: "title" },
    ];
    // A file another program held open must not show (or undo) an edit it never got.
    expect(writtenOnly(attempted, { written: 2, errors: ["locked"], failedPaths: ["locked.mp3"] })).toEqual([
      attempted[0],
      attempted[2],
    ]);
    expect(writtenOnly(attempted, { written: 3, errors: [] })).toEqual(attempted);
  });

  it("lets the later of two edits to the same field win", () => {
    const current = tags();
    const [item] = foldEditsByPath([
      { path: "a.mp3", current, field: "title", value: "First" },
      { path: "a.mp3", current, field: "title", value: "Second" },
    ]);
    expect(item.tags.title).toBe("Second");
  });
});
