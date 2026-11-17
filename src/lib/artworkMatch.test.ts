import { describe, expect, it } from "vitest";
import {
  baseTitle,
  primaryArtist,
  queryFromFilename,
  goodEnough,
  isCompilation,
  normalize,
  pickBest,
  rankCandidates,
  similarity,
  type ArtworkCandidate,
} from "./artworkMatch";

const base: ArtworkCandidate = {
  source: "musicbrainz",
  id: "1",
  release: "Album",
  releaseArtist: "Daft Punk",
  trackTitle: "Get Lucky",
  trackArtist: "Daft Punk",
  kind: "Album",
  date: "2013",
  trackCount: 13,
  durationMs: 369000,
  sourceScore: 100,
  nominalSize: 1200,
  previewDataUrl: "",
  fullUrls: [],
};
const cand = (o: Partial<ArtworkCandidate>): ArtworkCandidate => ({ ...base, ...o });
const q = { artist: "Daft Punk", title: "Get Lucky", durationSecs: 369 };

describe("similarity", () => {
  it("ignores case, accents, feat and punctuation", () => {
    expect(normalize("Beyoncé (feat. Jay-Z)")).toBe("beyonce");
    expect(similarity("Get Lucky!", "get lucky")).toBe(1);
    expect(similarity("Get Lucky", "Something Else")).toBe(0);
  });
});

describe("rankCandidates", () => {
  it("prefers the single over the album when the file is a single", () => {
    const r = rankCandidates(q, [
      cand({ id: "alb", kind: "Album", release: "Random Access Memories" }),
      cand({ id: "sgl", kind: "Single", release: "Get Lucky", trackCount: 2 }),
    ]);
    expect(r[0].id).toBe("sgl");
  });

  it("prefers the album when the file has an album tag that is not a single", () => {
    const r = rankCandidates({ ...q, album: "Random Access Memories" }, [
      cand({ id: "sgl", kind: "Single", release: "Get Lucky", trackCount: 2 }),
      cand({ id: "alb", kind: "Album", release: "Random Access Memories" }),
    ]);
    expect(r[0].id).toBe("alb");
  });

  it("pushes compilations to the bottom", () => {
    const r = rankCandidates(q, [
      cand({ id: "now", release: "Now That's What I Call Music! 85", releaseArtist: "Various Artists", kind: "Compilation", source: "itunes" }),
      cand({ id: "alb", release: "Random Access Memories" }),
    ]);
    expect(r.map((c) => c.id)).toEqual(["alb", "now"]);
    expect(r[1].isCompilation).toBe(true);
  });

  it("drops the confidence of a different-length recording", () => {
    const [r] = rankCandidates(q, [cand({ durationMs: 200000 })]);
    const [ok] = rankCandidates(q, [cand({ durationMs: 369500 })]);
    expect(r.confidence).toBeLessThan(ok.confidence - 0.25);
  });

  it("dedupes by source and id", () => {
    expect(rankCandidates(q, [cand({}), cand({})])).toHaveLength(1);
  });
});

describe("pickBest / goodEnough", () => {
  it("auto-picks only above the threshold and never a compilation", () => {
    const wrong = rankCandidates(q, [cand({ trackTitle: "Other Song", trackArtist: "Someone", releaseArtist: "Someone" })]);
    expect(pickBest(wrong, 0.8)).toBeNull();
    expect(goodEnough(wrong)).toBe(false);
    const right = rankCandidates(q, [cand({})]);
    expect(pickBest(right, 0.8)?.id).toBe("1");
    const comp = rankCandidates(q, [cand({ kind: "Compilation" })]);
    expect(pickBest(comp, 0.5)).toBeNull();
  });

  it("detects compilation names", () => {
    expect(isCompilation({ kind: "", release: "DJ Pool Hits Vol. 23", releaseArtist: "X" })).toBe(true);
    expect(isCompilation({ kind: "Album", release: "Discovery", releaseArtist: "Daft Punk" })).toBe(false);
  });
});

describe("version-tagged titles", () => {
  it("strips version tags but keeps brackets that are part of the name", () => {
    expect(baseTitle("Titanium (Extended Mix)")).toBe("Titanium");
    expect(baseTitle("Titanium - Radio Edit")).toBe("Titanium");
    expect(baseTitle("Levels [Original Mix] (Clean)")).toBe("Levels");
    expect(baseTitle("Song (Part 2)")).toBe("Song (Part 2)");
    expect(baseTitle("(Extended Mix)")).toBe("(Extended Mix)");
  });

  it("an extended mix clears the auto-pick bar against the plain single", () => {
    const dj = { artist: "Daft Punk", title: "Get Lucky (Extended Mix)", durationSecs: 480 };
    const ranked = rankCandidates(dj, [cand({ kind: "Single", trackCount: 1 })]);
    // Different length is expected for a different edit, so no duration penalty.
    expect(ranked[0].confidence).toBeGreaterThanOrEqual(0.95);
    expect(pickBest(ranked, 0.95)?.id).toBe("1");
  });

  it("still penalises a wrong length when the titles match as written", () => {
    const ranked = rankCandidates({ ...q, durationSecs: 200 }, [cand({})]);
    expect(ranked[0].confidence).toBeLessThan(0.75);
  });

  it("matches a guest-billed artist against the lead artist", () => {
    const ranked = rankCandidates({ artist: "Daft Punk & Pharrell Williams", title: "Get Lucky" }, [cand({})]);
    expect(ranked[0].confidence).toBeGreaterThanOrEqual(0.85);
    expect(primaryArtist("Daft Punk, Pharrell Williams")).toBe("Daft Punk");
  });

  it("does not let a different song through on artist alone", () => {
    const ranked = rankCandidates({ artist: "Daft Punk", title: "Around the World (Radio Edit)" }, [cand({})]);
    expect(pickBest(ranked, 0.75)).toBeNull();
  });
});

describe("queryFromFilename", () => {
  it("splits Artist - Title and drops the extension and track number", () => {
    expect(queryFromFilename("C:\\Music\\01 - Daft Punk - Get Lucky (Radio Edit).mp3")).toEqual({
      artist: "Daft Punk",
      title: "Get Lucky (Radio Edit)",
    });
    expect(queryFromFilename("/m/Get_Lucky.flac")).toEqual({ artist: "", title: "Get Lucky" });
  });
});
