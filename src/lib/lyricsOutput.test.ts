import { describe, expect, it } from "vitest";
import {
  DEFAULT_LYRICS_OUTPUT,
  extrapolate,
  formatClock,
  lineWindow,
  manualNow,
  manualPause,
  manualPaused,
  manualStart,
  manualStep,
  normalizeOutputSettings,
  parseClockInput,
  plainToLines,
  trackMsgFrom,
} from "./lyricsOutput";
import { seekTargetSecs } from "./nowPlaying";

const lines = [
  { timeMs: 1000, text: "one" },
  { timeMs: 5000, text: "two" },
  { timeMs: 9000, text: "" },
  { timeMs: 12000, text: "four" },
];

describe("normalizeOutputSettings", () => {
  it("fills defaults and clamps junk", () => {
    expect(normalizeOutputSettings(undefined)).toEqual(DEFAULT_LYRICS_OUTPUT);
    const n = normalizeOutputSettings({ style: "disco", fontSize: 9999, offsetMs: -99999, background: "green", monitor: -1, showPrev: "yes" });
    expect(n.style).toBe("clean");
    expect(n.fontSize).toBe(160);
    expect(n.offsetMs).toBe(-10000);
    expect(n.background).toBe("green");
    expect(n.monitor).toBeNull();
    expect(n.showPrev).toBe(false);
  });
  it("keeps valid values", () => {
    const n = normalizeOutputSettings({ style: "neon", fontSize: 50, offsetMs: 250, mode: "manual", monitor: 2, showPrev: true });
    expect(n).toMatchObject({ style: "neon", fontSize: 50, offsetMs: 250, mode: "manual", monitor: 2, showPrev: true });
  });
});

describe("lineWindow", () => {
  it("is empty before the first line", () => {
    const w = lineWindow(lines, 500);
    expect(w).toMatchObject({ index: -1, prev: null, current: null, next: "one", progress: 0 });
  });
  it("gives prev/current/next and progress through the line", () => {
    const w = lineWindow(lines, 3000);
    expect(w.index).toBe(0);
    expect(w.current).toBe("one");
    expect(w.next).toBe("two");
    expect(w.progress).toBeCloseTo(0.5);
  });
  it("shows nothing for an empty break line but keeps neighbours", () => {
    const w = lineWindow(lines, 10000);
    expect(w).toMatchObject({ index: 2, prev: "two", current: null, next: "four" });
  });
  it("caps the fill time of the last line", () => {
    const w = lineWindow(lines, 12000 + 4000);
    expect(w.index).toBe(3);
    expect(w.progress).toBeCloseTo(0.5);
    expect(lineWindow(lines, 99999).progress).toBe(1);
  });
  it("applies the offset (positive = earlier)", () => {
    expect(lineWindow(lines, 4500, 600).current).toBe("two");
    expect(lineWindow(lines, 5500, -600).current).toBe("one");
  });
  it("handles no lines", () => {
    expect(lineWindow([], 1000)).toMatchObject({ index: -1, current: null, next: null });
  });
});

describe("extrapolate", () => {
  it("advances only while playing and never goes back", () => {
    expect(extrapolate(1000, true, 100, 350)).toBe(1250);
    expect(extrapolate(1000, false, 100, 350)).toBe(1000);
    expect(extrapolate(1000, true, 100, 50)).toBe(1000);
  });
});

describe("manual clock", () => {
  it("runs from the start position and pauses where it is", () => {
    const c = manualStart(30_000, 1000);
    expect(manualNow(c, 3500)).toBe(32_500);
    const p = manualPause(c, 3500);
    expect(manualNow(p, 99_999)).toBe(32_500);
  });
  it("steps to the next/previous line and stays paused or running", () => {
    const paused = manualStep(manualPaused(2000), lines, 1, 0, 0);
    expect(paused).toEqual({ baseMs: 5000, startedAt: null });
    const running = manualStep(manualStart(2000, 0), lines, 1, 0, 100);
    expect(running).toEqual({ baseMs: 5000, startedAt: 100 });
    expect(manualStep(manualPaused(5000), lines, -1, 0, 0).baseMs).toBe(1000);
  });
  it("clamps at the ends and from before the first line", () => {
    expect(manualStep(manualPaused(0), lines, 1, 0, 0).baseMs).toBe(1000);
    expect(manualStep(manualPaused(0), lines, -1, 0, 0).baseMs).toBe(1000);
    expect(manualStep(manualPaused(20_000), lines, 1, 0, 0).baseMs).toBe(12_000);
  });
  it("accounts for the sync offset so the stepped line is the displayed one", () => {
    const c = manualStep(manualPaused(0), lines, 1, 400, 0);
    expect(lineWindow(lines, manualNow(c, 0), 400).current).toBe("one");
  });
  it("steps plain lyrics by line", () => {
    const plain = plainToLines("a\n\n b \nc");
    expect(plain.map((l) => l.text)).toEqual(["a", "b", "c"]);
    // Line 0 is already showing at clock 0, so the first step lands on line 1.
    expect(lineWindow(plain, 0).current).toBe("a");
    const c = manualStep(manualPaused(0), plain, 1, 0, 0);
    expect(lineWindow(plain, manualNow(c, 0)).current).toBe("b");
    const d = manualStep(c, plain, 1, 0, 0);
    expect(lineWindow(plain, manualNow(d, 0)).current).toBe("c");
    expect(lineWindow(plain, manualNow(manualStep(d, plain, -1, 0, 0), 0)).current).toBe("b");
  });
  it("does nothing without lines", () => {
    const c = manualPaused(5);
    expect(manualStep(c, [], 1, 0, 0)).toBe(c);
  });
});

describe("clock text", () => {
  it("parses mm:ss and seconds", () => {
    expect(parseClockInput("1:23")).toBe(83_000);
    expect(parseClockInput("83")).toBe(83_000);
    expect(parseClockInput(" 0:05.5 ")).toBe(5500);
    expect(parseClockInput("abc")).toBeNull();
    expect(parseClockInput("")).toBeNull();
  });
  it("formats", () => {
    expect(formatClock(83_999)).toBe("1:23");
    expect(formatClock(-5)).toBe("0:00");
  });
});

describe("seekTargetSecs (click a lyric line)", () => {
  it("converts ms to seconds and clamps into the track", () => {
    expect(seekTargetSecs(12_500, 200)).toBe(12.5);
    expect(seekTargetSecs(-50, 200)).toBe(0);
    expect(seekTargetSecs(500_000, 200)).toBe(200);
    expect(seekTargetSecs(500_000, 0)).toBe(500);
    expect(seekTargetSecs(Number.NaN, 200)).toBe(0);
  });
});

describe("trackMsgFrom", () => {
  it("prefers synced lines, falls back to plain, then to empty", () => {
    const synced = trackMsgFrom("/a.mp3", "a", { synced: "[00:01.00]hi\n[00:02.00]yo", plain: "x", source: "sidecar", instrumental: false });
    expect(synced).toMatchObject({ synced: true });
    expect(synced.lines).toHaveLength(2);
    const plain = trackMsgFrom("/a.mp3", "a", { synced: null, plain: "x\ny", source: "cache", instrumental: false });
    expect(plain).toMatchObject({ synced: false });
    expect(plain.lines).toHaveLength(2);
    expect(trackMsgFrom("/a.mp3", "a", null)).toMatchObject({ lines: [], instrumental: false });
    expect(trackMsgFrom("/a.mp3", "a", { synced: null, plain: null, source: "cache", instrumental: true }).instrumental).toBe(true);
  });
});
