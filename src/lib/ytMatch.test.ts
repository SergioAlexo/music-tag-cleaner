import { describe, expect, it } from "vitest";
import type { AudioFile, PlaylistEntry, TagData } from "../types";
import {
  buildIdentity,
  buildWanted,
  CONFIDENT_THRESHOLD,
  matchPlaylist,
  normalizeForMatch,
  parseSearchableBackup,
  prepare,
  preparedTextSimilarity,
  splitArtistTitle,
  stringSimilarity,
  textSimilarity,
  tokenSimilarity,
  versionSignature,
} from "./ytMatch";

function file(path: string, durationSecs?: number): AudioFile {
  return {
    path,
    filename: path.split(/[\\/]/).pop() ?? path,
    format: "mp3",
    size: 1,
    hasBackup: false,
    durationSecs,
  };
}

function tag(partial: Partial<TagData>): TagData {
  return { hasCoverArt: false, allFields: {}, ...partial };
}

function entry(
  index: number,
  title: string,
  durationSecs?: number,
  uploader?: string,
  artist?: string,
  artists?: string[],
): PlaylistEntry {
  return {
    index,
    videoId: `v${index}`,
    url: `https://music.youtube.com/watch?v=v${index}`,
    title,
    durationSecs,
    uploader,
    artist,
    artists,
  };
}

describe("parseSearchableBackup", () => {
  it("parses the four-slot backup the app writes", () => {
    const parsed = parseSearchableBackup("01 track_final | | Boris Brejcha | | Gravity | | 2019");
    expect(parsed).toEqual({
      stem: "01 track_final",
      artist: "Boris Brejcha",
      title: "Gravity",
      year: "2019",
    });
  });

  it("ignores an ordinary Comment/Composer value that is not a backup", () => {
    expect(parseSearchableBackup("Ripped from vinyl, 2019")).toBeNull();
    expect(parseSearchableBackup("")).toBeNull();
    expect(parseSearchableBackup(undefined)).toBeNull();
  });
});

describe("splitArtistTitle", () => {
  it("splits on a dash (with surrounding whitespace) and strips official-video noise", () => {
    expect(splitArtistTitle("Fred again.. - Delilah (Official Video)")).toEqual({
      artist: "Fred again..",
      title: "Delilah",
    });
  });

  it("leaves an unsplittable title whole", () => {
    expect(splitArtistTitle("Delilah")).toEqual({ artist: null, title: "Delilah" });
  });

  it("never splits inside a hyphenated name that has no surrounding spaces", () => {
    expect(splitArtistTitle("Jay-Z")).toEqual({ artist: null, title: "Jay-Z" });
    expect(splitArtistTitle("T-Pain")).toEqual({ artist: null, title: "T-Pain" });
    expect(splitArtistTitle("Ne-Yo")).toEqual({ artist: null, title: "Ne-Yo" });
  });

  it("splits a real 'Artist - Title' even when the artist itself is hyphenated", () => {
    expect(splitArtistTitle("A-ha - Take On Me")).toEqual({ artist: "A-ha", title: "Take On Me" });
  });

  it("no longer treats a colon as a separator", () => {
    expect(splitArtistTitle("Chapter 1: Intro")).toEqual({ artist: null, title: "Chapter 1: Intro" });
  });
});

describe("buildWanted — artist only ever comes from real metadata", () => {
  it("uses artists[0] when several artists are present — features are already in the title", () => {
    const w = buildWanted(entry(0, "Low (feat. T-Pain)", undefined, undefined, undefined, ["Flo Rida", "T-Pain"]));
    expect(w.artist).toBe("Flo Rida");
    expect(w.title).toBe("Low (feat. T-Pain)");
  });

  it("falls back to the legacy structured artist field when artists[] is absent", () => {
    const w = buildWanted(entry(0, "Some Video Title", undefined, "Some Channel - Topic", "Real Artist"));
    expect(w.artist).toBe("Real Artist");
  });

  it("never derives the artist by splitting the title", () => {
    const w = buildWanted(entry(0, "Boris Brejcha - Gravity"));
    expect(w.artist).toBeNull();
    expect(w.title).toBe("Boris Brejcha - Gravity");
  });

  it("never derives the artist from the uploading channel", () => {
    const w = buildWanted(entry(0, "Gravity", undefined, "Boris Brejcha - Topic"));
    expect(w.artist).toBeNull();
  });

  it("has no artist at all, and the title is unchanged (not mangled by a bad split), when nothing is available", () => {
    const w = buildWanted(entry(0, "Low (feat. T-Pain)"));
    expect(w.artist).toBeNull();
    expect(w.title).toBe("Low (feat. T-Pain)");
  });
});

describe("versionSignature", () => {
  it("keeps the remixer's name and drops generic filler", () => {
    // "remix" itself is kept: a bare "(Remix)" really is a different
    // recording from the original, so it should still count against a file
    // that claims no version at all. "(Original Mix)" is pure filler.
    expect([...versionSignature("Gravity (Tale Of Us Remix)")]).toEqual(["tale", "of", "us", "remix"]);
    expect([...versionSignature("Gravity (Original Mix)")]).toEqual([]);
    expect([...versionSignature("Gravity (Extended Mix)")]).toEqual(["extended"]);
    expect([...versionSignature("Gravity")]).toEqual([]);
  });

  it("reads a version stated after a second dash", () => {
    expect([...versionSignature("Artist - Gravity - Kolsch Remix")]).toContain("kolsch");
  });
});

describe("textSimilarity", () => {
  it("is order-insensitive enough to survive a swapped artist/title", () => {
    expect(textSimilarity("Boris Brejcha Gravity", "Gravity Boris Brejcha")).toBeGreaterThan(0.95);
  });

  it("tolerates an extra featured artist", () => {
    expect(textSimilarity("Calvin Harris Summer", "Calvin Harris feat. Example Summer")).toBeGreaterThan(0.8);
  });
});

/**
 * The fast path skips the edit-distance DP whenever a character-histogram
 * bound proves it cannot beat the token score. That is only sound if the
 * answer is bit-for-bit identical to computing both and taking the max, so
 * this checks it against a naive implementation over adversarial inputs:
 * anagrams (identical histograms, different order), single-character typos,
 * shared prefixes, and disjoint strings.
 */
describe("textSimilarity pruning", () => {
  const naive = (a: string, b: string) => Math.max(stringSimilarity(a, b), tokenSimilarity(a, b));

  const CASES: [string, string][] = [
    ["", ""],
    ["", "gravity"],
    ["gravity", "gravity"],
    ["gravity", "gravty"],
    ["gravity", "ytivarg"],
    ["boris brejcha gravity", "gravity boris brejcha"],
    ["disturbia", "rihanna disturbia"],
    ["rihanna disturbia", "disturbia"],
    ["evacuate the dancefloor", "cascada evacuate the dancefloor"],
    ["metallica enter sandman", "boris brejcha gravity"],
    ["aaaa", "aaab"],
    ["abc def", "def abc"],
    ["a", "b"],
    ["the the the", "the"],
    ["hotel room service", "pitbull hotel room service"],
    ["calvin harris summer", "calvin harris feat example summer"],
  ];

  it("returns exactly what the unpruned definition returns", () => {
    for (const [a, b] of CASES) {
      expect(textSimilarity(a, b)).toBeCloseTo(naive(a, b), 12);
      // Symmetry matters too: the bound uses max(da, db), not one direction.
      expect(textSimilarity(b, a)).toBeCloseTo(naive(b, a), 12);
    }
  });

  it("is unaffected by the caller's minUseful floor when the result clears it", () => {
    // A floor only ever licenses returning a lower bound for results that
    // fall below it; anything at or above must still be exact.
    for (const [a, b] of CASES) {
      const exact = textSimilarity(a, b);
      for (const floor of [0, 0.3, 0.6, 0.87, 1]) {
        const v = preparedTextSimilarity(prepare(a), prepare(b), floor);
        if (exact >= floor) expect(v).toBeCloseTo(exact, 12);
        else expect(v).toBeLessThanOrEqual(exact + 1e-12);
      }
    }
  });

  it("agrees with the unpruned definition on random strings", () => {
    const alphabet = "abcdefg hij";
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const str = () => {
      const n = 1 + Math.floor(rnd() * 18);
      let out = "";
      for (let i = 0; i < n; i++) out += alphabet[Math.floor(rnd() * alphabet.length)];
      return out;
    };
    for (let i = 0; i < 2000; i++) {
      const a = str();
      const b = str();
      expect(textSimilarity(a, b)).toBeCloseTo(naive(a, b), 12);
    }
  });
});

describe("buildIdentity", () => {
  it("compares against tags, filename and the searchable backup", () => {
    const id = buildIdentity(
      file("C:/music/01-gravity_clean.mp3", 400),
      tag({
        artist: "Boris Brejcha",
        title: "Gravity",
        originalArtist: "BorisBrejcha-Gravity(ExtendedMix) | | Boris Brejcha | | Gravity | | 2019",
      }),
    );
    const vias = id.texts.map((t) => t.via);
    expect(vias).toContain("tags");
    expect(vias).toContain("filename");
    expect(vias).toContain("backup");
  });
});

describe("matchPlaylist", () => {
  it("auto-accepts a confident match and reports how it was found", () => {
    const files = [file("C:/music/gravity.mp3", 402)];
    const tags = { "C:/music/gravity.mp3": tag({ artist: "Boris Brejcha", title: "Gravity" }) };
    const [m] = matchPlaylist([entry(0, "Boris Brejcha - Gravity", 400)], files, tags);
    expect(m.status).toBe("matched");
    expect(m.candidates[0].path).toBe("C:/music/gravity.mp3");
    expect(m.candidates[0].via).toBe("tags");
  });

  it("matches on real artists[] metadata, keeping the feature in the title rather than splitting it out", () => {
    const f = file("C:/music/Flo Rida - Low.mp3", 200);
    const tags = { [f.path]: tag({ artist: "Flo Rida", title: "Low (feat. T-Pain)" }) };
    const [m] = matchPlaylist(
      [entry(0, "Low (feat. T-Pain)", 200, undefined, undefined, ["Flo Rida", "T-Pain"])],
      [f],
      tags,
    );
    expect(m.status).toBe("matched");
    expect(m.candidates[0].path).toBe(f.path);
  });

  it("does not confuse two different remixes of the same track", () => {
    const original = file("C:/music/gravity-original.mp3", 402);
    const remix = file("C:/music/gravity-tale-of-us.mp3", 480);
    const files = [original, remix];
    const tags = {
      [original.path]: tag({ artist: "Boris Brejcha", title: "Gravity (Original Mix)" }),
      [remix.path]: tag({ artist: "Boris Brejcha", title: "Gravity (Tale Of Us Remix)" }),
    };
    const matches = matchPlaylist(
      [
        entry(0, "Boris Brejcha - Gravity (Tale Of Us Remix)", 478),
        entry(1, "Boris Brejcha - Gravity", 400),
      ],
      files,
      tags,
    );
    expect(matches[0].candidates[0].path).toBe(remix.path);
    expect(matches[1].candidates[0].path).toBe(original.path);
  });

  it("never lets one file back two playlist entries", () => {
    const only = file("C:/music/gravity.mp3", 402);
    const tags = { [only.path]: tag({ artist: "Boris Brejcha", title: "Gravity" }) };
    const matches = matchPlaylist(
      [entry(0, "Boris Brejcha - Gravity", 402), entry(1, "Boris Brejcha - Gravity", 402)],
      [only],
      tags,
    );
    const claimed = matches.filter((m) => m.status !== "missing").map((m) => m.candidates[0].path);
    expect(claimed).toHaveLength(1);
    expect(matches.some((m) => m.status === "missing")).toBe(true);
  });

  it("matches a track whose tags were wiped, using its searchable backup", () => {
    const f = file("C:/music/track01.mp3", 402);
    const tags = {
      [f.path]: tag({
        title: "track01",
        composer: "BorisBrejcha - Gravity | | Boris Brejcha | | Gravity | | 2019",
      }),
    };
    const [m] = matchPlaylist([entry(0, "Boris Brejcha - Gravity", 402)], [f], tags);
    expect(m.status).not.toBe("missing");
    expect(m.candidates[0].via).toBe("backup");
  });

  it("matches from the filename when there are no tags at all", () => {
    const f = file("C:/music/Boris Brejcha - Gravity.mp3", 402);
    const [m] = matchPlaylist([entry(0, "Boris Brejcha - Gravity", 402)], [f], {});
    expect(m.status).toBe("matched");
    expect(m.candidates[0].via).toBe("filename");
  });

  it("reports an unrelated entry as missing rather than forcing a match", () => {
    const f = file("C:/music/gravity.mp3", 402);
    const tags = { [f.path]: tag({ artist: "Boris Brejcha", title: "Gravity" }) };
    const [m] = matchPlaylist([entry(0, "Metallica - Enter Sandman", 331)], [f], tags);
    expect(m.status).toBe("missing");
  });

  /**
   * The case that motivated the title-only comparison. A real YouTube Music
   * playlist ("(Dance) Wedding Music", 70 tracks) gave bare titles with no
   * uploader, so every entry had no artist. Scored against the library's
   * "artist title" the correct matches landed at 59-86% and *nothing*
   * auto-accepted — the artist tokens the entry could never have supplied
   * were counted against it.
   */
  it("auto-matches a bare title with no artist against the right track", () => {
    const f = file("C:/music/rihanna-disturbia.mp3", 238);
    const tags = { [f.path]: tag({ artist: "Rihanna", title: "Disturbia" }) };
    const [m] = matchPlaylist([entry(0, "Disturbia", 238)], [f], tags);
    expect(m.candidates[0].score).toBeGreaterThan(CONFIDENT_THRESHOLD);
    expect(m.status).toBe("matched");
  });

  it("still prefers the track whose artist also agrees", () => {
    const cascada = file("C:/music/cascada.mp3", 200);
    const cover = file("C:/music/cover.mp3", 200);
    const tags = {
      [cascada.path]: tag({ artist: "Cascada", title: "Evacuate The Dancefloor" }),
      [cover.path]: tag({ artist: "Someone Else", title: "Evacuate The Dancefloor" }),
    };
    const [m] = matchPlaylist(
      [entry(0, "Cascada - Evacuate the Dancefloor", 200)],
      [cascada, cover],
      tags,
    );
    expect(m.candidates[0].path).toBe(cascada.path);
  });

  /** A title-only entry must not become a licence to match anything. */
  it("does not let a bare title match an unrelated track", () => {
    const f = file("C:/music/gravity.mp3", 402);
    const tags = { [f.path]: tag({ artist: "Boris Brejcha", title: "Gravity" }) };
    const [m] = matchPlaylist([entry(0, "Enter Sandman", 331)], [f], tags);
    expect(m.status).toBe("missing");
  });

  /** Real case from the owner's library: "Justice Dance" is three inserts
   * from "Just Dance", and that edit-distance coincidence used to beat the
   * actual Lady Gaga file (a remix, 21 s off the video). */
  it("does not let a contradicting artist win on a spelling coincidence", () => {
    const gaga = file("C:/music/Lady Gaga - Just Dance (Gallardo Remix).mp3", 221);
    const justice = file("C:/music/Justice - Dance - 14.mp3", 232);
    const tags = {
      [gaga.path]: tag({
        artist: "Lady Gaga",
        title: "Just Dance",
        composer: "Lady Gaga - Just Dance (Gallardo Remix) | | Lady Gaga | | Just Dance | | 2008",
      }),
      [justice.path]: tag({ artist: "Justice", title: "Dance" }),
    };
    const [m] = matchPlaylist(
      [entry(0, "Just Dance", 242, undefined, undefined, ["Lady Gaga"])],
      [gaga, justice],
      tags,
    );
    expect(m.candidates[0].path).toBe(gaga.path);
  });

  /** Real case: both copies the owner has are a different length from the
   * 4:50 video (a 4:07 edit, a 2:02 remix). The old >25 s rule capped them
   * at 45%, under the ask bar, so a same-artist *different song* took the row. */
  it("still offers the right song when every copy owned is a different length", () => {
    const edit = file("C:/music/The Black Eyed Peas - I Gotta Feeling - 002701.mp3", 247);
    const quick = file("C:/music/Black Eyed Peas - I Gotta Feeling (Dj Getdown Remix).mp3", 122);
    const other = file("C:/music/The Black Eyed Peas - The Time - 003308.mp3", 308);
    const tags = {
      [edit.path]: tag({ artist: "The Black Eyed Peas", title: "I Gotta Feeling" }),
      [quick.path]: tag({ artist: "Black Eyed Peas", title: "I Gotta Feeling" }),
      [other.path]: tag({ artist: "The Black Eyed Peas", title: "The Time" }),
    };
    const [m] = matchPlaylist(
      [entry(0, "I Gotta Feeling", 290, undefined, undefined, ["The Black Eyed Peas"])],
      [edit, quick, other],
      tags,
    );
    expect(m.status).toBe("ambiguous"); // offered, never auto-accepted at that gap
    expect(m.candidates[0].path).toBe(edit.path);
    expect(m.candidates.find((c) => c.path === other.path)?.score ?? 0).toBeLessThan(0.52);
  });

  it("ignores featured-artist credits in the video title when comparing titles", () => {
    const f = file("C:/music/1Nonly - Dance.mp3", 163);
    const tags = { [f.path]: tag({ artist: "1Nonly", title: "Dance" }) };
    const [m] = matchPlaylist(
      [entry(0, "DANCE! (feat. Ciscaux & Wassup Rocker)", 164, undefined, undefined, ["1nonly"])],
      [f],
      tags,
    );
    expect(m.status).toBe("matched");
  });

  it("treats a collaboration credit as the same artist, not a mismatch", () => {
    const f = file("C:/music/just-dance.mp3", 242);
    const tags = { [f.path]: tag({ artist: "Lady Gaga feat. Colby O'Donis", title: "Just Dance" }) };
    const [m] = matchPlaylist(
      [entry(0, "Just Dance", 242, undefined, undefined, ["Lady Gaga"])],
      [f],
      tags,
    );
    expect(m.status).toBe("matched");
  });

  it("offers alternates to step through when several mixes could fit", () => {
    const a = file("C:/music/gravity-a.mp3", 402);
    const b = file("C:/music/gravity-b.mp3", 405);
    const tags = {
      [a.path]: tag({ artist: "Boris Brejcha", title: "Gravity" }),
      [b.path]: tag({ artist: "Boris Brejcha", title: "Gravity (Extended Mix)" }),
    };
    const [m] = matchPlaylist([entry(0, "Boris Brejcha - Gravity", 402)], [a, b], tags);
    expect(m.candidates.length).toBeGreaterThan(1);
  });
});

// Both from the owner's real library: normalizing to a-z0-9 deleted Cyrillic,
// so a typed row matched on whatever Latin letters were left.
describe("non-Latin names", () => {
  const collection: [string, string][] = [
    ["Anna Asti", "Ночью На Кухне"],
    ["Anna Asti", "Топит"],
    ["Anna Asti", "Царица"],
    ["Dj Smash", "Волна"],
    ["Nivesta", "Позвони"],
    ["Дора", "Втюрилась"],
    ["Дмитрий Маликов", "Ты Одна Ты Такая"],
    ["Филипп Киркоров", "Цвет Настроения Синий"],
  ];
  const files = collection.map(([a, t]) => file(`C:/m/${a} - ${t}.mp3`));
  const tags = Object.fromEntries(collection.map(([artist, title], i) => [files[i].path, tag({ artist, title })]));
  const run = (...titles: string[]) =>
    matchPlaylist(titles.map((t, i) => ({ ...entry(i, t), source: "text" as const })), files, tags).map((m) =>
      m.status === "matched" ? tags[m.candidates[0].path].title : m.status,
    );

  it("finds the named song, not another one by the same artist", () => {
    expect(
      run("Anna Asti — Царица", "D.J. Smash & Nivesta — Позвони", "Дора — Втюрилась", "Дмитрий Маликов — Ты одна, ты такая"),
    ).toEqual(["Царица", "Позвони", "Втюрилась", "Ты Одна Ты Такая"]);
  });

  it("reads Title - Artist order too", () => {
    expect(run("Царица - Anna Asti")).toEqual(["Царица"]);
  });

  it("leaves a song the library doesn't have missing", () => {
    expect(run("Киркоров — Роза чайная", "Anna Asti — Феникс")).toEqual(["missing", "missing"]);
  });

  it("folds dotted initials and a dollar sign used as an S", () => {
    expect(normalizeForMatch("D.J. Smash")).toBe(normalizeForMatch("DJ Smash"));
    expect(normalizeForMatch("GAYAZOV$ BROTHER$")).toBe("gayazovs brothers");
    expect(normalizeForMatch("Mr. Brightside")).toBe("mr brightside");
  });
});

describe("a typed Artist - Title line", () => {
  const files = [file("C:/m/a.mp3"), file("C:/m/b.mp3")];
  const tags = {
    "C:/m/a.mp3": tag({ artist: "Some Cover Band", title: "Disturbia" }),
    "C:/m/b.mp3": tag({ artist: "Rihanna", title: "Umbrella" }),
  };
  it("asks instead of accepting the same title by someone else", () => {
    const [m] = matchPlaylist([{ ...entry(0, "Rihanna - Disturbia"), source: "text" }], files, tags);
    expect(m.status).toBe("ambiguous");
    expect(m.candidates[0].path).toBe("C:/m/a.mp3");
  });
});
