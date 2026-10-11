import { describe, expect, it } from "vitest";
import { CURRENT_SETTINGS_VERSION, DEFAULT_SETTINGS, mergeWithDefaults, migrate } from "./useSettings";
import type { Settings } from "../types";

describe("mergeWithDefaults", () => {
  it("fills keys a nested object saved by an older version is missing", () => {
    const saved = {
      stemOptions: { model: "htdemucs_ft" },
      claudeTasks: { clean: { model: "opus" } },
    } as unknown as Partial<Settings>;
    const merged = mergeWithDefaults(saved);
    expect(merged.stemOptions.model).toBe("htdemucs_ft");
    for (const key of Object.keys(DEFAULT_SETTINGS.stemOptions)) {
      expect(merged.stemOptions).toHaveProperty(key);
    }
    expect(merged.claudeTasks.clean).toEqual({ model: "opus", effort: DEFAULT_SETTINGS.claudeTasks.clean.effort });
    expect(merged.claudeTasks.playlist).toEqual(DEFAULT_SETTINGS.claudeTasks.playlist);
  });

  it("repairs null usage counters instead of passing them to the Settings page", () => {
    const saved = { usage: { totalCalls: null, totalPromptTokens: 12 } } as unknown as Partial<Settings>;
    const merged = mergeWithDefaults(saved);
    expect(merged.usage.totalCalls).toBe(0);
    expect(merged.usage.totalPromptTokens).toBe(12);
    expect(merged.usage.songsProcessed).toBe(0);
  });
});

describe("migrate", () => {
  it("v15 forgets the rekordbox.xml mtime so BPM/key re-import once", () => {
    const old = { ...DEFAULT_SETTINGS, rekordboxXmlPath: "C:/rb.xml", rekordboxXmlMtime: 1234 };
    const next = migrate(old, 14);
    expect(next.rekordboxXmlMtime).toBe(0);
    expect(next.rekordboxXmlPath).toBe("C:/rb.xml");
    expect(next.settingsVersion).toBe(CURRENT_SETTINGS_VERSION);
  });

  it("leaves an up-to-date mtime alone", () => {
    const current = { ...DEFAULT_SETTINGS, rekordboxXmlMtime: 99 };
    expect(migrate(current, 16).rekordboxXmlMtime).toBe(99);
  });

  it("v16 re-imports once for ratings and shows BPM/Key after Rating", () => {
    const old = {
      ...DEFAULT_SETTINGS,
      rekordboxXmlMtime: 99,
      visibleColumns: ["preview", "title", "genre", "rating", "trackId"],
    };
    const next = migrate(old, 15);
    expect(next.rekordboxXmlMtime).toBe(0);
    expect(next.visibleColumns).toEqual(["preview", "title", "genre", "rating", "bpm", "key", "trackId"]);
    expect(next.keyNotation).toBe("stored");
  });

  it("v16 keeps a BPM column the user already placed", () => {
    const old = { ...DEFAULT_SETTINGS, visibleColumns: ["bpm", "title", "rating"] };
    expect(migrate(old, 15).visibleColumns).toEqual(["bpm", "title", "rating", "key"]);
  });

  it("v17 adds libraryAutoRefresh, off by default, without touching anything else", () => {
    const next = migrate({ ...DEFAULT_SETTINGS, keyNotation: "camelot" }, 16);
    expect(next.libraryAutoRefresh).toBe(false);
    expect(next.keyNotation).toBe("camelot");
    expect(next.settingsVersion).toBe(CURRENT_SETTINGS_VERSION);
  });

  it("v20 adds lyricsStorage (sidecar) and languageAppendComment (off) and keeps columns as they are", () => {
    const old = { ...DEFAULT_SETTINGS, visibleColumns: ["title", "artist"] };
    const next = migrate(old, 18);
    expect(next.lyricsStorage).toBe("sidecar");
    expect(next.languageAppendComment).toBe(false);
    expect(next.visibleColumns).toEqual(["title", "artist"]);
    expect(next.settingsVersion).toBe(CURRENT_SETTINGS_VERSION);
    expect(next.aiControl).toBe(false);
  });
});
