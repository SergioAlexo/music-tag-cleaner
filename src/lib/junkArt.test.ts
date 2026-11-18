import { describe, expect, it } from "vitest";
import { isLikelyJunkCluster, junkReason, poolNameIn, type JunkClusterInfo } from "./junkArt";

const cluster = (o: Partial<JunkClusterInfo>): JunkClusterInfo => ({
  count: 10,
  artists: 8,
  albums: 6,
  emptyAlbums: 0,
  blocked: false,
  samples: [{ path: "C:\\Music\\a.mp3", artist: "A", title: "T", album: "Some Album" }],
  ...o,
});

describe("junkReason", () => {
  it("flags one picture across many artists and albums", () => {
    expect(junkReason(cluster({}))).toMatch(/8 different artists/);
  });

  it("flags many artists with no album tag at all (a blank tag is not a shared album)", () => {
    expect(junkReason(cluster({ albums: 1, emptyAlbums: 10 }))).toMatch(/8 different artists/);
  });

  it("counts lead artists, so one act with many feat. credits is not flagged", () => {
    // 13 spellings of the artist tag, but really one act and a couple of guests.
    expect(junkReason(cluster({ artists: 13, leadArtists: 2, albums: 1, emptyAlbums: 16 }))).toBeNull();
    expect(junkReason(cluster({ artists: 13, leadArtists: 9, albums: 1, emptyAlbums: 16 }))).toMatch(/9 different/);
  });

  it("leaves a real compilation (one named album, many artists) for a human", () => {
    expect(junkReason(cluster({ artists: 40, albums: 1, emptyAlbums: 0 }))).toBeNull();
  });

  it("leaves a small cluster alone", () => {
    expect(junkReason(cluster({ artists: 3, albums: 3 }))).toBeNull();
  });

  it("recognises a record pool named in the album tag or folder", () => {
    const byAlbum = cluster({ artists: 3, albums: 1, samples: [{ path: "x.mp3", artist: "A", title: "T", album: "DJcity" }] });
    expect(junkReason(byAlbum)).toMatch(/DJcity/);
    expect(poolNameIn({ path: "D:\\Pools\\BPM_Supreme\\x.mp3", album: "" })).toMatch(/BPM Supreme/i);
    expect(poolNameIn({ path: "D:\\Music\\x.mp3", album: "Random Access Memories" })).toBeNull();
  });

  it("does not offer a cluster that is already marked junk", () => {
    expect(isLikelyJunkCluster(cluster({ blocked: true }))).toBe(false);
    expect(isLikelyJunkCluster(cluster({}))).toBe(true);
  });
});
