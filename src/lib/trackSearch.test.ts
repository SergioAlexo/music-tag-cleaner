import { describe, expect, it } from "vitest";
import type { AudioFile, TagData } from "../types";
import { cachedTrackSearchText, parseQuery, searchTracks, trackSearchText } from "./trackSearch";

function file(path: string): AudioFile {
  return { path, filename: path.split(/[\\/]/).pop() ?? path, format: "mp3", size: 1, hasBackup: false };
}
function tag(partial: Partial<TagData>): TagData {
  return { hasCoverArt: false, allFields: {}, ...partial };
}

const gravity = file("C:/music/01 - track.mp3");
const summer = file("C:/music/calvin-harris-summer.mp3");
const tags: Record<string, TagData> = {
  [gravity.path]: tag({ artist: "Boris Brejcha", title: "Gravity", genre: "Techno Melodic" }),
  [summer.path]: tag({ artist: "Calvin Harris", title: "Summer", comment: "gravity of the moment" }),
};
const files = [gravity, summer];

describe("trackSearchText", () => {
  it("includes tags, filename and the parsed searchable backup", () => {
    const text = trackSearchText(
      file("C:/music/track01.mp3"),
      tag({ title: "track01", composer: "OldName-Gravity | | Boris Brejcha | | Gravity | | 2019" }),
    );
    expect(text).toContain("track01");
    expect(text).toContain("boris brejcha");
    expect(text).toContain("2019");
  });
});

describe("cachedTrackSearchText", () => {
  it("reuses the cached text while the tag object is unchanged", () => {
    const f = file("C:/music/cached.mp3");
    const t = tag({ artist: "A", title: "B" });
    const first = cachedTrackSearchText(f, t);
    const second = cachedTrackSearchText(f, t);
    expect(second).toBe(first);
    expect(first).toBe(trackSearchText(f, t));
  });

  it("recomputes once the tag object is replaced, as an edit always does", () => {
    const f = file("C:/music/recache.mp3");
    const before = cachedTrackSearchText(f, tag({ artist: "Old", title: "X" }));
    const after = cachedTrackSearchText(f, tag({ artist: "New", title: "X" }));
    expect(after).not.toBe(before);
    expect(after).toContain("new");
  });
});

describe("parseQuery", () => {
  it("reads field scoping, negation and quoted phrases", () => {
    expect(parseQuery('artist:brejcha -live "tale of us"')).toEqual([
      { field: "artist", text: "brejcha", negated: false },
      { field: null, text: "live", negated: true },
      { field: null, text: "tale of us", negated: false },
    ]);
  });

  it("treats an unknown prefix as literal text, not a field", () => {
    expect(parseQuery("mood:128")).toEqual([{ field: null, text: "mood:128", negated: false }]);
  });
});

describe("searchTracks", () => {
  it("finds a track by artist even though the filename says nothing", () => {
    const hits = searchTracks(files, tags, "brejcha");
    expect(hits.map((h) => h.file.path)).toEqual([gravity.path]);
  });

  it("ranks a title hit above an incidental comment hit", () => {
    const hits = searchTracks(files, tags, "gravity");
    expect(hits[0].file.path).toBe(gravity.path);
    expect(hits).toHaveLength(2);
  });

  it("scopes a field-qualified term to that field only", () => {
    expect(searchTracks(files, tags, "title:gravity").map((h) => h.file.path)).toEqual([gravity.path]);
  });

  it("ANDs multiple terms", () => {
    expect(searchTracks(files, tags, "boris gravity")).toHaveLength(1);
    expect(searchTracks(files, tags, "boris summer")).toHaveLength(0);
  });

  it("excludes with a leading dash", () => {
    expect(searchTracks(files, tags, "gravity -brejcha").map((h) => h.file.path)).toEqual([summer.path]);
  });

  it("folds diacritics so plain ASCII finds accented tags", () => {
    const bjork = file("C:/music/x.mp3");
    const hits = searchTracks([bjork], { [bjork.path]: tag({ artist: "Björk", title: "Jóga" }) }, "bjork");
    expect(hits).toHaveLength(1);
  });

  it("returns nothing for an empty query rather than everything", () => {
    expect(searchTracks(files, tags, "   ")).toEqual([]);
  });
});

describe("BPM and key search", () => {
  const a = file("C:/m/a.mp3");
  const b = file("C:/m/b.mp3");
  const c = file("C:/m/c.mp3");
  const ts: Record<string, TagData> = {
    [a.path]: tag({ title: "Alpha", bpm: "127.99", key: "Am" }),
    [b.path]: tag({ title: "Bravo", bpm: "140", key: "8B" }),
    [c.path]: tag({ title: "Charlie", key: "Bm" }),
  };
  const all = [a, b, c];
  const found = (q: string) => searchTracks(all, ts, q).map((h) => h.file.path);

  it("finds a BPM by its stored text or its rounded value", () => {
    expect(found("bpm:127.99")).toEqual([a.path]);
    expect(found("bpm:128")).toEqual([a.path]);
    expect(found("bpm:140")).toEqual([b.path]);
  });

  it("a bare number searches BPM too", () => {
    expect(found("140")).toEqual([b.path]);
  });

  it("finds a key in every notation, whatever it is stored as", () => {
    // Am == 8A == 1m; 8B == C major == 1d.
    expect(found("key:8A")).toEqual([a.path]);
    expect(found("key:1m")).toEqual([a.path]);
    expect(found("key:Am")).toEqual([a.path]);
    expect(found("key:8B")).toEqual([b.path]);
    expect(found("key:C")).toEqual([b.path]);
    expect(found("key:1d")).toEqual([b.path]);
  });

  it("key: is exact, not a substring match", () => {
    // "Bm" is 10A; it must not match "Am" or a plain "m".
    expect(found("key:10A")).toEqual([c.path]);
    expect(found("key:A")).toEqual([]);
  });

  it("a bare camelot key finds the track without the key: prefix", () => {
    expect(found("8a")).toEqual([a.path]);
  });

  it("does not change with the haystack cache: a re-tagged BPM is found", () => {
    const f = file("C:/m/retag.mp3");
    const t1 = tag({ bpm: "100" });
    expect(searchTracks([f], { [f.path]: t1 }, "bpm:100")).toHaveLength(1);
    const t2 = tag({ bpm: "122" });
    expect(searchTracks([f], { [f.path]: t2 }, "bpm:100")).toHaveLength(0);
    expect(searchTracks([f], { [f.path]: t2 }, "bpm:122")).toHaveLength(1);
  });
});
