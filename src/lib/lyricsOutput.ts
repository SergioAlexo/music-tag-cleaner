/**
 * Pure parts of the "Lyrics output" window (projector / OBS overlay): the
 * settings shape, the message payloads that cross the Tauri event bus, which
 * lines to show for a given time, and the manual clock used when the music
 * plays from Rekordbox (which has no API to follow).
 *
 * The output window has no logic of its own beyond this: the main window
 * sends `{lines, position}` and the window animates locally between updates,
 * so it keeps running while the main window is busy.
 */
import { currentLineIndex, parseLrc, type LrcLine } from "./lrc";
import type { LyricsData } from "./lyrics";

export type LyricsOutputStyle = "clean" | "karaoke" | "neon" | "lowerThird";
export type LyricsOutputBackground = "black" | "transparent" | "green";
/** prelisten = follow this app's player; manual = the DJ drives it (Rekordbox etc.). */
export type LyricsOutputMode = "prelisten" | "manual";

export interface LyricsOutputSettings {
  style: LyricsOutputStyle;
  /** Font size of the current line, in vw-independent px at 1080p-ish; scaled by window height in the page. */
  fontSize: number;
  /** Added to the playback time: positive = lyrics appear earlier. */
  offsetMs: number;
  showPrev: boolean;
  background: LyricsOutputBackground;
  mode: LyricsOutputMode;
  /** Monitor index (as listed by the window API) to restore on open; null = leave where it opens. */
  monitor: number | null;
}

export const STYLES: { id: LyricsOutputStyle; label: string; hint: string }[] = [
  { id: "clean", label: "Clean", hint: "White on black" },
  { id: "karaoke", label: "Karaoke", hint: "Current line fills as it is sung" },
  { id: "neon", label: "Neon", hint: "Glowing colours" },
  { id: "lowerThird", label: "Lower third", hint: "Small bar at the bottom, for overlaying in OBS" },
];

export const BACKGROUNDS: { id: LyricsOutputBackground; label: string }[] = [
  { id: "black", label: "Black" },
  { id: "transparent", label: "Transparent" },
  { id: "green", label: "Chroma green" },
];

export const FONT_SIZE_MIN = 24;
export const FONT_SIZE_MAX = 160;
export const OFFSET_LIMIT_MS = 10_000;

export const DEFAULT_LYRICS_OUTPUT: LyricsOutputSettings = {
  style: "clean",
  fontSize: 72,
  offsetMs: 0,
  showPrev: false,
  background: "black",
  mode: "prelisten",
  monitor: null,
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Fills defaults and clamps anything out of range (settings files and the AI action can both hand in junk). */
export function normalizeOutputSettings(raw: unknown): LyricsOutputSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const D = DEFAULT_LYRICS_OUTPUT;
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const pick = <T extends string>(v: unknown, ok: readonly T[], d: T): T => (ok.includes(v as T) ? (v as T) : d);
  return {
    style: pick(r.style, STYLES.map((s) => s.id), D.style),
    fontSize: Math.round(clamp(num(r.fontSize, D.fontSize), FONT_SIZE_MIN, FONT_SIZE_MAX)),
    offsetMs: Math.round(clamp(num(r.offsetMs, D.offsetMs), -OFFSET_LIMIT_MS, OFFSET_LIMIT_MS)),
    showPrev: typeof r.showPrev === "boolean" ? r.showPrev : D.showPrev,
    background: pick(r.background, BACKGROUNDS.map((b) => b.id), D.background),
    mode: pick(r.mode, ["prelisten", "manual"] as const, D.mode),
    monitor: typeof r.monitor === "number" && Number.isInteger(r.monitor) && r.monitor >= 0 ? r.monitor : null,
  };
}

export const BACKGROUND_CSS: Record<LyricsOutputBackground, string> = {
  black: "#000000",
  transparent: "transparent",
  green: "#00b140",
};

// ---------------------------------------------------------------------------
// Event bus (main window -> output window; the output window only answers
// "ready" and reports the monitor the DJ picked there)

export const EV = {
  track: "lyrics-out:track",
  time: "lyrics-out:time",
  config: "lyrics-out:config",
  ready: "lyrics-out:ready",
  monitor: "lyrics-out:monitor",
} as const;

export interface TrackMsg {
  path: string;
  title: string;
  /** Synced lines; for plain-only lyrics, one line per non-empty row with synthetic times (manual stepping only). */
  lines: LrcLine[];
  synced: boolean;
  instrumental: boolean;
}

export interface TimeMsg {
  path: string;
  timeMs: number;
  playing: boolean;
}

/** Plain lyrics as steppable lines: non-empty rows, 1 s apart (the manual clock is never auto-started for these). */
export function plainToLines(plain: string): LrcLine[] {
  return plain
    .split(/\r?\n/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((text, i) => ({ timeMs: i * 1000, text }));
}

/** What the output window gets for a track (null data = nothing found, shown as an empty screen). */
export function trackMsgFrom(path: string, title: string, data: LyricsData | null): TrackMsg {
  const synced = data?.synced ? parseLrc(data.synced) : [];
  if (synced.length) return { path, title, lines: synced, synced: true, instrumental: false };
  return {
    path,
    title,
    lines: data?.plain ? plainToLines(data.plain) : [],
    synced: false,
    instrumental: !!data?.instrumental,
  };
}

// ---------------------------------------------------------------------------
// Which lines to show

export interface LineWindow {
  /** Index of the current line, -1 before the first. */
  index: number;
  prev: string | null;
  current: string | null;
  next: string | null;
  /** 0..1 through the current line (karaoke fill). */
  progress: number;
}

/** A line with no successor, or a long instrumental gap, fills over at most this long. */
export const MAX_FILL_MS = 8000;

/** Lines around `timeMs + offsetMs`. Empty lines (instrumental breaks) count as lines but show nothing. */
export function lineWindow(lines: LrcLine[], timeMs: number, offsetMs = 0): LineWindow {
  const t = timeMs + offsetMs;
  const index = lines.length ? currentLineIndex(lines, t) : -1;
  const text = (i: number) => (i >= 0 && i < lines.length && lines[i].text ? lines[i].text : null);
  let progress = 0;
  if (index >= 0) {
    const start = lines[index].timeMs;
    const end = index + 1 < lines.length ? lines[index + 1].timeMs : start + MAX_FILL_MS;
    const span = Math.min(Math.max(end - start, 1), MAX_FILL_MS);
    progress = clamp((t - start) / span, 0, 1);
  }
  return { index, prev: text(index - 1), current: text(index), next: text(index + 1), progress };
}

/** Position of a player that last reported `timeMs` at `receivedAt`, now `now` (both performance.now()-style). */
export function extrapolate(timeMs: number, playing: boolean, receivedAt: number, now: number): number {
  return playing ? timeMs + Math.max(0, now - receivedAt) : timeMs;
}

// ---------------------------------------------------------------------------
// Manual clock: tap / arrow keys / "start at" when the music is not ours

export interface ManualClock {
  baseMs: number;
  /** performance.now() when it started running; null = paused. */
  startedAt: number | null;
}

export const manualPaused = (atMs = 0): ManualClock => ({ baseMs: atMs, startedAt: null });

export function manualNow(c: ManualClock, now: number): number {
  return c.startedAt == null ? c.baseMs : c.baseMs + Math.max(0, now - c.startedAt);
}

export function manualStart(atMs: number, now: number): ManualClock {
  return { baseMs: Math.max(0, atMs), startedAt: now };
}

export function manualPause(c: ManualClock, now: number): ManualClock {
  return { baseMs: manualNow(c, now), startedAt: null };
}

/**
 * Steps the displayed line by `dir` (+1 next, -1 previous) and re-bases the
 * clock so that line is exactly the current one (taking the sync offset into
 * account); keeps running if it was running. Clamped to the first/last line.
 */
export function manualStep(c: ManualClock, lines: LrcLine[], dir: 1 | -1, offsetMs: number, now: number): ManualClock {
  if (!lines.length) return c;
  const cur = currentLineIndex(lines, manualNow(c, now) + offsetMs);
  const target = clamp(cur + dir, 0, lines.length - 1);
  const baseMs = Math.max(0, lines[target].timeMs - offsetMs);
  return { baseMs, startedAt: c.startedAt == null ? null : now };
}

/** "1:23" / "83" / "1:23.5" -> ms; null if it is not a time. */
export function parseClockInput(s: string): number | null {
  const m = /^\s*(?:(\d+):)?(\d+)(?:[.,](\d{1,3}))?\s*$/.exec(s);
  if (!m) return null;
  const frac = m[3] ? Number(m[3].padEnd(3, "0")) : 0;
  return Number(m[1] ?? 0) * 60_000 + Number(m[2]) * 1000 + frac;
}

export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
