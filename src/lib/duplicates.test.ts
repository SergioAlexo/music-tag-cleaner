import { describe, expect, it } from "vitest";
import type { AudioFile, TagData } from "../types";
import {
  MAX_SKIPPED_GROUPS,
  addSkipped,
  duplicateGroupKey,
  groupReasonLabel,
  looksLikeCopy,
  suggestAlternates,
  suggestKeeper,
  suggestReason,
  tagCompleteness,
  versionInfo,
} from "./duplicates";

function file(path: string, format: string, bitrateKbps?: number): AudioFile {
  return { path, filename: path, format, bitrateKbps, size: 1 } as unknown as AudioFile;
}
function tag(filled: number): TagData {
  const fields = ["title", "artist", "album", "albumArtist", "year", "genre", "trackNumber"];
  const t: Record<string, unknown> = { hasCoverArt: false, allFields: {} };
  fields.slice(0, filled).forEach((k) => (t[k] = "x"));
  return t as unknown as TagData;
}

describe("suggestKeeper / suggestReason", () => {
  it("FLAC beats a higher-bitrate MP3", () => {
    const files = { "a.mp3": file("a.mp3", "mp3", 320), "b.flac": file("b.flac", "flac", 900) };
    expect(suggestKeeper(["a.mp3", "b.flac"], files, {})).toBe("b.flac");
    expect(suggestReason("b.flac", "a.mp3", files, {})).toBe("lossless FLAC");
  });

  it("higher bitrate wins between lossy files", () => {
    const files = { "a.mp3": file("a.mp3", "mp3", 192), "b.mp3": file("b.mp3", "mp3", 320) };
    expect(suggestKeeper(["a.mp3", "b.mp3"], files, {})).toBe("b.mp3");
    expect(suggestReason("b.mp3", "a.mp3", files, {})).toBe("higher bitrate (320 vs 192 kbps)");
  });

  it("tag completeness breaks a quality tie", () => {
    const files = { "a.mp3": file("a.mp3", "mp3", 320), "b.mp3": file("b.mp3", "mp3", 320) };
    const tags = { "a.mp3": tag(2), "b.mp3": tag(5) };
    expect(tagCompleteness(tags["b.mp3"])).toBe(5);
    expect(suggestKeeper(["a.mp3", "b.mp3"], files, tags)).toBe("b.mp3");
    expect(suggestReason("b.mp3", "a.mp3", files, tags)).toBe("more complete tags");
  });

  it("falls back to path order on a full tie", () => {
    const files = { "b.mp3": file("b.mp3", "mp3", 320), "a.mp3": file("a.mp3", "mp3", 320) };
    expect(suggestKeeper(["b.mp3", "a.mp3"], files, {})).toBe("a.mp3");
    expect(suggestReason("a.mp3", "b.mp3", files, {})).toMatch(/file path/);
  });
});

describe("groupReasonLabel", () => {
  it("names each way a group can be found, defaulting to audio", () => {
    expect(groupReasonLabel("tags")).toMatch(/not confirmed/);
    expect(groupReasonLabel("tags+audio")).toMatch(/partly matches/);
    expect(groupReasonLabel("audio")).toBe("audio match");
    expect(groupReasonLabel(undefined)).toBe("audio match");
  });
});

const af = (path: string, durationSecs: number, extra: Partial<AudioFile> = {}): AudioFile =>
  ({ path, filename: path.split("/").pop()!, format: "mp3", size: 1, bitrateKbps: 320, durationSecs, ...extra }) as AudioFile;
const filesOf = (...list: AudioFile[]) => Object.fromEntries(list.map((f) => [f.path, f]));

describe("duplicateGroupKey", () => {
  it("is the same for the same files in any order, case or slash style", () => {
    const a = duplicateGroupKey(["C:\\Music\\A.mp3", "C:\\Music\\b.mp3"]);
    expect(duplicateGroupKey(["c:/music/b.mp3", "c:/music/a.mp3"])).toBe(a);
  });

  it("changes when the group gains a file", () => {
    expect(duplicateGroupKey(["a", "b"])).not.toBe(duplicateGroupKey(["a", "b", "c"]));
    expect(duplicateGroupKey(["a", "b"])).not.toBe(duplicateGroupKey(["a", "c"]));
  });

  it("addSkipped de-dupes and keeps the newest when capped", () => {
    expect(addSkipped(["x", "y"], ["y", "z"])).toEqual(["x", "y", "z"]);
    const many = Array.from({ length: MAX_SKIPPED_GROUPS }, (_, i) => `k${i}`);
    const next = addSkipped(many, ["new"]);
    expect(next).toHaveLength(MAX_SKIPPED_GROUPS);
    expect(next[next.length - 1]).toBe("new");
    expect(next).not.toContain("k0");
  });
});

describe("versionInfo", () => {
  it("reads the common DJ-pool version tags", () => {
    expect(versionInfo("Artist - Song (Extended Mix).mp3")).toMatchObject({ kind: "extended", label: "Extended Mix" });
    expect(versionInfo("Artist - Song (Radio Edit).mp3").kind).toBe("radio");
    expect(versionInfo("Artist - Song - Radio Edit.mp3").kind).toBe("radio");
    expect(versionInfo("Artist - Song (Original Mix).mp3").kind).toBe("plain");
    expect(versionInfo("Artist - Song.mp3")).toMatchObject({ kind: "plain", label: "" });
    expect(versionInfo("Artist - Song (Instrumental).mp3").kind).toBe("special");
    expect(versionInfo("Artist - Song (Intro - Dirty).mp3")).toMatchObject({ kind: "special", explicit: "dirty" });
    expect(versionInfo("Artist - Song (Clean) (Extended).mp3")).toMatchObject({ kind: "extended", explicit: "clean" });
  });

  it("keeps the remixer apart from the length words", () => {
    expect(versionInfo("Song (Joe Smith Extended Remix)").remix).toBe("joe smith");
    expect(versionInfo("Song (Joe Smith Remix) (Radio Edit)")).toMatchObject({ remix: "joe smith", kind: "radio" });
    expect(versionInfo("Song (Extended Mix)").remix).toBe("");
  });

  it("does not take a song's own name for a version", () => {
    expect(versionInfo("Artist - Radio.mp3").kind).toBe("plain");
    expect(versionInfo("Artist - Intro (feat. Someone).mp3")).toMatchObject({ kind: "plain", label: "" });
  });
});

describe("suggestAlternates", () => {
  it("keeps the extended mix and suggests removing the radio edit", () => {
    const files = filesOf(af("m/A - Song (Extended Mix).mp3", 372), af("m/A - Song (Radio Edit).mp3", 195));
    const s = suggestAlternates(Object.keys(files), files, {});
    expect(s.states).toEqual({ "m/A - Song (Extended Mix).mp3": "keep", "m/A - Song (Radio Edit).mp3": "remove" });
    expect(s.reasons["m/A - Song (Radio Edit).mp3"]).toMatch(/3:15.*6:12/);
  });

  it("treats an untagged shorter file as the radio cut only next to a tagged extended one", () => {
    const tagged = filesOf(af("m/A - Song (Extended).mp3", 360), af("m/A - Song.mp3", 200));
    expect(suggestAlternates(Object.keys(tagged), tagged, {}).states["m/A - Song.mp3"]).toBe("remove");
    const untagged = filesOf(af("m/A - Song.mp3", 360), af("m/A - Song 2.mp3", 200));
    expect(suggestAlternates(Object.keys(untagged), untagged, {}).states).toEqual({});
  });

  it("never touches instrumentals, other remixes, or the other clean/dirty side", () => {
    const files = filesOf(
      af("m/A - Song (Extended Mix).mp3", 360),
      af("m/A - Song (Instrumental).mp3", 200),
      af("m/A - Song (Joe Smith Remix) (Radio Edit).mp3", 190),
      af("m/A - Song (Clean) (Radio Edit).mp3", 195),
    );
    expect(suggestAlternates(Object.keys(files), files, {}).states).toEqual({});
  });

  it("pairs the radio and extended cut of the same remix", () => {
    const files = filesOf(
      af("m/A - Song (Joe Smith Extended Remix).mp3", 400),
      af("m/A - Song (Joe Smith Remix) (Radio Edit).mp3", 190),
      af("m/A - Song (Radio Edit).mp3", 185),
    );
    expect(suggestAlternates(Object.keys(files), files, {}).states).toEqual({
      "m/A - Song (Joe Smith Extended Remix).mp3": "keep",
      "m/A - Song (Joe Smith Remix) (Radio Edit).mp3": "remove",
    });
  });

  it("suggests nothing without lengths, or when the short file is barely shorter", () => {
    const noLen = filesOf(af("m/A - Song (Extended Mix).mp3", 0), af("m/A - Song (Radio Edit).mp3", 0));
    expect(suggestAlternates(Object.keys(noLen), noLen, {}).states).toEqual({});
    const close = filesOf(af("m/A - Song (Extended Mix).mp3", 200), af("m/A - Song (Radio Edit).mp3", 195));
    expect(suggestAlternates(Object.keys(close), close, {}).states).toEqual({});
  });

  it("prefers the title tag over the file name when the tag carries the version", () => {
    const files = filesOf(af("m/one.mp3", 360), af("m/two.mp3", 190));
    const tags = {
      "m/one.mp3": { title: "Song (Extended Mix)" },
      "m/two.mp3": { title: "Song (Radio Edit)" },
    } as unknown as Record<string, TagData>;
    expect(suggestAlternates(Object.keys(files), files, tags).states).toEqual({ "m/one.mp3": "keep", "m/two.mp3": "remove" });
  });
});

describe("copy-named files", () => {
  it("keeps the original over a byte-identical (1) / Copy file", () => {
    const files = filesOf(af("m/Avicii - Levels (1).mp3", 25), af("m/Avicii - Levels.mp3", 25));
    expect(suggestKeeper(Object.keys(files), files, {})).toBe("m/Avicii - Levels.mp3");
    expect(suggestReason("m/Avicii - Levels.mp3", "m/Avicii - Levels (1).mp3", files, {})).toMatch(/original file name/);
  });

  it("recognises the usual copy names and nothing else", () => {
    expect(looksLikeCopy("C:\m\Song (2).flac")).toBe(true);
    expect(looksLikeCopy("Song - Copy.mp3")).toBe(true);
    expect(looksLikeCopy("Song copy 2.mp3")).toBe(true);
    expect(looksLikeCopy("Song (Extended Mix).mp3")).toBe(false);
    expect(looksLikeCopy("Song (1999).mp3")).toBe(false);
    expect(looksLikeCopy("Carbon Copy.mp3")).toBe(false);
  });
});
