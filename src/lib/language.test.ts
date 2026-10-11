import { describe, expect, it } from "vitest";
import type { AudioFile, TagData } from "../types";
import {
  buildLanguagePreview,
  findLanguage,
  languageFromOption,
  languageName,
  LANGUAGE_OPTIONS,
  langHashtag,
  normalizeLanguageCode,
  sameLanguage,
  searchLanguages,
  withLangHashtag,
  type LangSuggestion,
} from "./language";
import { facetLabel, matchesFacet, arrangeFacet, FACETS } from "./facets";
import { searchTracks } from "./trackSearch";

describe("language code mapping", () => {
  it("reads codes, two-letter codes, regions, bibliographic codes and names", () => {
    expect(normalizeLanguageCode("spa")).toBe("spa");
    expect(normalizeLanguageCode("ES")).toBe("spa");
    expect(normalizeLanguageCode("es-MX")).toBe("spa");
    expect(normalizeLanguageCode("fre")).toBe("fra");
    expect(normalizeLanguageCode("ger")).toBe("deu");
    expect(normalizeLanguageCode("Spanish")).toBe("spa");
    expect(normalizeLanguageCode("mandarin")).toBe("zho");
    expect(normalizeLanguageCode("zxx")).toBe("zxx");
    expect(normalizeLanguageCode("instrumental")).toBe("zxx");
    expect(normalizeLanguageCode("klingon")).toBeNull();
    expect(normalizeLanguageCode("")).toBeNull();
  });

  it("shows friendly names and leaves unknown values as written", () => {
    expect(languageName("fra")).toBe("French");
    expect(languageName("fre")).toBe("French");
    expect(languageName("xx-unknown")).toBe("xx-unknown");
    expect(languageName(undefined)).toBe("");
  });

  it("compares by language, not spelling", () => {
    expect(sameLanguage("es", "spa")).toBe(true);
    expect(sameLanguage("fre", "fra")).toBe(true);
    expect(sameLanguage("spa", "fra")).toBe(false);
    expect(sameLanguage("weird", "WEIRD")).toBe(true);
  });

  it("every language has a unique code", () => {
    const codes = LANGUAGE_OPTIONS.map((o) => languageFromOption(o));
    expect(new Set(codes).size).toBe(codes.length);
    expect(findLanguage("eng")?.iso1).toBe("en");
  });

  it("type-ahead finds by name, code and two-letter code", () => {
    expect(searchLanguages("span")[0].code).toBe("spa");
    expect(searchLanguages("fra")[0].code).toBe("fra");
    expect(searchLanguages("de")[0].code).toBe("deu");
    expect(searchLanguages("")).toHaveLength(12);
  });

  it("turns a combobox pick or a typed entry into the stored value", () => {
    expect(languageFromOption("Spanish (spa, es)")).toBe("spa");
    expect(languageFromOption("Instrumental (no vocals) (zxx)")).toBe("zxx");
    expect(languageFromOption("french")).toBe("fra");
    expect(languageFromOption("  ")).toBe("");
    expect(languageFromOption("tlh")).toBe("tlh");
  });
});

describe("#lang hashtag", () => {
  it("uses the two-letter code when there is one", () => {
    expect(langHashtag("spa")).toBe("#lang-es");
    expect(langHashtag("zxx")).toBe("#lang-zxx");
    expect(langHashtag("nope")).toBeNull();
  });

  it("appends once, replaces an older tag and keeps the rest of the comment", () => {
    expect(withLangHashtag("", "spa")).toBe("#lang-es");
    expect(withLangHashtag("energy 8", "spa")).toBe("energy 8 #lang-es");
    expect(withLangHashtag("energy 8 #lang-es", "spa")).toBe("energy 8 #lang-es");
    expect(withLangHashtag("#lang-en energy 8", "spa")).toBe("energy 8 #lang-es");
    expect(withLangHashtag("a #lang-en b", "fra")).toBe("a b #lang-fr");
    expect(withLangHashtag("keep", "nope")).toBe("keep");
  });
});

describe("buildLanguagePreview", () => {
  const file = (p: string): AudioFile => ({ path: p, filename: p, format: "mp3", size: 1, hasBackup: false });
  const tag = (t: Partial<TagData>): TagData => ({ hasCoverArt: false, allFields: {}, ...t });
  const sug = (
    path: string,
    code: string | null,
    level: "high" | "low" | null,
    source: LangSuggestion["source"] = "lyrics",
  ): LangSuggestion => ({ path, code, confidence: 0.9, level, source, error: null });
  const files = ["a", "b", "c", "d", "e"].map(file);
  const tags: Record<string, TagData> = {
    a: tag({}),
    b: tag({}),
    c: tag({ language: "fra" }),
    d: tag({ language: "es", comment: "hot" }),
    e: tag({}),
  };

  it("ticks only confident suggestions that do not replace anything", () => {
    const rows = buildLanguagePreview(
      files,
      tags,
      [sug("a", "spa", "high"), sug("b", "spa", "low", "title"), sug("c", "spa", "high"), sug("e", null, null)],
      { appendComment: false },
    );
    const byPath = Object.fromEntries(rows.map((r) => [r.path, r]));
    expect(byPath.a.include).toBe(true);
    expect(byPath.b.include).toBe(false);
    expect(byPath.c.include).toBe(false);
    expect(byPath.c.note).toContain('replaces "fra"');
    expect(byPath.e).toBeUndefined();
    expect(rows.every((r) => r.field === "language" && r.kind === "update")).toBe(true);
  });

  it("rewrites a same-language spelling as the canonical code, and skips an exact match", () => {
    const rows = buildLanguagePreview(files, tags, [sug("d", "spa", "high"), sug("c", "fra", "high")], {
      appendComment: false,
    });
    expect(rows.map((r) => [r.path, r.before, r.after, r.include])).toEqual([["d", "es", "spa", true]]);
  });

  it("adds a Comment row with the hashtag when asked, with the same tick state", () => {
    const rows = buildLanguagePreview(files, tags, [sug("d", "spa", "high"), sug("b", "eng", "low", "title")], {
      appendComment: true,
    });
    const comment = rows.filter((r) => r.field === "comment");
    expect(comment.map((r) => [r.path, r.after, r.include])).toEqual([
      ["d", "hot #lang-es", true],
      ["b", "#lang-en", false],
    ]);
  });
});

describe("language facet and search", () => {
  it("shows the language name and finds it by name or code", () => {
    expect(facetLabel({ facet: "language", name: "spa", artist: "" })).toBe("Spanish");
    expect(facetLabel({ facet: "language", name: "", artist: "" })).toBe("No language");
    const list = [
      { name: "spa", artist: "", count: 2 },
      { name: "eng", artist: "", count: 5 },
      { name: "fra", artist: "", count: 1 },
    ];
    const arranged = (q: string, sort: "count" | "name" = "name") =>
      arrangeFacet(list, sort, q, "No language", FACETS.language.display).map((f) => f.name);
    expect(arranged("")).toEqual(["eng", "fra", "spa"]); // English, French, Spanish
    expect(arranged("span")).toEqual(["spa"]);
    expect(arranged("fra")).toEqual(["fra"]);
  });

  it("matches a tag written in capitals against the lowercased index bucket", () => {
    const t = { hasCoverArt: false, allFields: {}, language: "SPA" } as TagData;
    expect(matchesFacet(t, { facet: "language", name: "spa", artist: "" })).toBe(true);
    expect(matchesFacet(t, { facet: "language", name: "fra", artist: "" })).toBe(false);
    expect(matchesFacet({ hasCoverArt: false, allFields: {} }, { facet: "language", name: "", artist: "" })).toBe(true);
  });

  it("search finds a track by language code, two-letter code or name, and by lang:", () => {
    const f1 = { path: "C:/m/a.mp3", filename: "a.mp3", format: "mp3", size: 1, hasBackup: false };
    const f2 = { path: "C:/m/b.mp3", filename: "b.mp3", format: "mp3", size: 1, hasBackup: false };
    const tags: Record<string, TagData> = {
      [f1.path]: { hasCoverArt: false, allFields: {}, title: "Uno", language: "spa" },
      [f2.path]: { hasCoverArt: false, allFields: {}, title: "Two", language: "eng" },
    };
    const found = (q: string) => searchTracks([f1, f2], tags, q).map((h) => h.file.path);
    expect(found("spanish")).toEqual([f1.path]);
    expect(found("lang:spa")).toEqual([f1.path]);
    expect(found("language:english")).toEqual([f2.path]);
  });
});
