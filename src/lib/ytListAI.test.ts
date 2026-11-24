import { describe, expect, it } from "vitest";
import {
  buildOrganizePrompt,
  checkOrganized,
  chunkList,
  organizeList,
  parseOrganizedAnswer,
  repairLinks,
} from "./ytListAI";

describe("chunkList", () => {
  it("keeps a short list whole", () => {
    expect(chunkList("a\nb\nc", { maxLines: 40, maxChars: 3000 })).toEqual(["a\nb\nc"]);
  });

  it("loses no line and prefers to cut at a blank line", () => {
    const text = ["a1", "a2", "", "b1", "b2", "", "c1", "c2"].join("\n");
    const chunks = chunkList(text, { maxLines: 4, maxChars: 3000 });
    expect(chunks[0].trim()).toBe("a1\na2");
    expect(chunks.join("\n").split("\n").filter(Boolean)).toEqual(["a1", "a2", "b1", "b2", "c1", "c2"]);
  });

  it("still advances past a single line over the character limit", () => {
    const long = "x".repeat(50);
    expect(chunkList(`${long}\nb`, { maxLines: 40, maxChars: 10 })).toEqual([long, "b"]);
  });

  it("handles no limits (manual mode) and an empty list", () => {
    expect(chunkList("a\nb", { maxLines: Infinity, maxChars: Infinity })).toEqual(["a\nb"]);
    expect(chunkList("\n \n", { maxLines: 1, maxChars: 10 })).toEqual([]);
  });
});

describe("buildOrganizePrompt", () => {
  it("carries the list, and the user's note only when there is one", () => {
    const p = buildOrganizePrompt("Low / Flo Rida", "title comes first");
    expect(p).toContain("Low / Flo Rida");
    expect(p).toContain("title comes first");
    expect(buildOrganizePrompt("Low / Flo Rida", "  ")).not.toContain("WHAT THE USER SAYS");
  });
});

describe("parseOrganizedAnswer", () => {
  it("reads the tagged list and ignores talk around it", () => {
    expect(parseOrganizedAnswer("Sure!\n<list>\nFlo Rida - Low\n\nLady Gaga - Bad Romance\n</list>\nDone")).toEqual([
      "Flo Rida - Low",
      "Lady Gaga - Bad Romance",
    ]);
  });

  it("reads a cut-off answer up to where it stops", () => {
    expect(parseOrganizedAnswer("<list>\nFlo Rida - Low\nLady")).toEqual(["Flo Rida - Low", "Lady"]);
  });

  it("falls back to a code fence, then to bare lines without the preamble", () => {
    expect(parseOrganizedAnswer("Here:\n```text\n1. A - B\n```")).toEqual(["A - B"]);
    expect(parseOrganizedAnswer("Here is the list:\n- A - B\n2) C - D")).toEqual(["A - B", "C - D"]);
  });

  it("drops a reasoning block and keeps titles that start with a number", () => {
    expect(parseOrganizedAnswer("<think><list>x</list></think><list>24K Magic</list>")).toEqual(["24K Magic"]);
  });
});

describe("checkOrganized", () => {
  it("accepts swaps, joined lines, split lines and removed numbering", () => {
    const source = "1. Low - Flo Rida 3:51\nBad Romance\nLady Gaga\nGravity / Boris Brejcha; Animals / Martin Garrix";
    const result = "Flo Rida - Low\nLady Gaga - Bad Romance\nBoris Brejcha - Gravity\nMartin Garrix - Animals";
    expect(checkOrganized(source, result)).toEqual({ leftOut: [], added: [] });
  });

  it("reports a song the AI left out and one it made up", () => {
    const check = checkOrganized("Flo Rida - Low\nMartin Garrix - Animals", "Flo Rida - Low\nAvicii - Levels");
    expect(check.leftOut).toEqual(["Martin Garrix - Animals"]);
    expect(check.added).toEqual(["Avicii - Levels"]);
  });

  it("does not flag a fixed typo or accents", () => {
    expect(checkOrganized("Lady Gagga - Bad Romance\nBeyonce - Halo", "Lady Gaga - Bad Romance\nBeyoncé - Halo")).toEqual({
      leftOut: [],
      added: [],
    });
  });

  it("compares Cyrillic titles", () => {
    expect(checkOrganized("Гуси - Wellboy", "Wellboy - Гуси")).toEqual({ leftOut: [], added: [] });
  });

  it("treats a kept link as covering the text next to it", () => {
    const src = "Flo Rida - Low https://youtu.be/abc";
    expect(checkOrganized(src, "https://youtu.be/abc").leftOut).toEqual([]);
    expect(checkOrganized(src, "Flo Rida - Low").leftOut).toEqual([src]);
  });
});

describe("repairLinks", () => {
  it("drops invented links and restores lost ones", () => {
    expect(repairLinks("Low https://youtu.be/abc\nAnimals", ["Flo Rida - Low", "https://youtu.be/zzz"])).toEqual([
      "Flo Rida - Low",
      "https://youtu.be/abc",
    ]);
  });
});

describe("organizeList", () => {
  const limits = { maxLines: 1, maxChars: 1000 };

  it("keeps a failed part as pasted and reports it", async () => {
    const run = await organizeList("Low - Flo Rida\nAnimals - Garrix", "", limits, async (p) => {
      if (p.includes("Garrix")) throw new Error("offline");
      return "<list>Flo Rida - Low</list>";
    });
    expect(run?.text).toBe("Flo Rida - Low\nAnimals - Garrix");
    expect(run?.errors).toEqual(["Part 2 of 2: offline"]);
  });

  it("fails when every part fails, and returns null when cancelled", async () => {
    await expect(
      organizeList("a", "", limits, async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
    expect(await organizeList("a", "", limits, async () => "x", undefined, () => true)).toBeNull();
  });
});
