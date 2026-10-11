import { describe, expect, it } from "vitest";
import type { AudioFile, TagData } from "../types";
import { groupReasonLabel, suggestKeeper, suggestReason, tagCompleteness } from "./duplicates";

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