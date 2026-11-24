/**
 * Import sessions for the YouTube Music import page: what one holds, how a
 * list is recognized again, and which sessions are open right now.
 *
 * No React / Tauri imports: unit-tested.
 */
import type { ImportSessionSummary, PlaylistEntry } from "../types";
import type { FoundLink } from "./ytLinks";

export const DEFAULT_SESSION_NAME = "New import";

/**
 * Everything about one import run that is worth surviving the app closing.
 *
 * Matching a playlist is rarely a single sitting: you match what you own, go
 * and buy the rest, and come back days later to re-fetch. Without this, that
 * second pass starts from nothing — every confirmation and, worse, every
 * *denial* is lost, so the matcher cheerfully re-proposes exactly the matches
 * already rejected.
 *
 * Decisions are keyed by video id, never by position, so they survive the
 * playlist gaining, losing or reordering tracks, and they survive the library
 * growing — which is the whole reason to come back.
 */
export interface SessionPayload {
  version: 1;
  entries: PlaylistEntry[];
  overrides: Record<string, string>;
  denied: Record<string, string[]>;
  candIndex: Record<string, number>;
  fromSearch: Record<string, boolean>;
  /** The raw text pasted into the import box that produced `entries` —
   * absent on a session saved before list-import shipped (C5), in which
   * case the textarea falls back to the single playlist URL. */
  sourceText?: string;
  /** What the box holds now, when that differs from what was fetched — so a
   * half-written list survives swapping to another session. */
  draft?: string;
  /** The user named this session, so a fetch must not rename it. */
  named?: boolean;
  /** Which list this is (see `contentKeyFor`), so pasting the same list into
   * a new session can pick up the decisions made here. Sessions from before
   * the landing page have it as their own key instead. */
  contentKey?: string;
  /** For the landing page, which can't run the matcher on every session. */
  stats?: { matched: number; total: number };
  /** YouTube Music links looked up for typed songs, by entry id. */
  links?: Record<string, FoundLink>;
}

export type Decisions = Pick<SessionPayload, "overrides" | "denied" | "candIndex" | "fromSearch">;

export function emptyPayload(): SessionPayload {
  return { version: 1, entries: [], overrides: {}, denied: {}, candIndex: {}, fromSearch: {} };
}

/** Null when the stored text is unreadable — the caller must then leave the
 * row alone rather than save an empty session over it. */
export function parsePayload(text: string): SessionPayload | null {
  try {
    const p = JSON.parse(text) as Partial<SessionPayload> | null;
    if (!p || typeof p !== "object") return null;
    return {
      ...p,
      version: 1,
      entries: p.entries ?? [],
      overrides: p.overrides ?? {},
      denied: p.denied ?? {},
      candIndex: p.candIndex ?? {},
      fromSearch: p.fromSearch ?? {},
    };
  } catch {
    return null;
  }
}

/** Keeps the decisions about entries the new list still has. */
export function keepDecisions(from: Decisions, ids: Set<string>): Decisions {
  const keep = <T>(o: Record<string, T>) =>
    Object.fromEntries(Object.entries(o).filter(([id]) => ids.has(id))) as Record<string, T>;
  return {
    overrides: keep(from.overrides),
    denied: keep(from.denied),
    candIndex: keep(from.candIndex),
    fromSearch: keep(from.fromSearch),
  };
}

export function hasDecisions(d: Decisions): boolean {
  return [d.overrides, d.denied, d.candIndex, d.fromSearch].some((o) => Object.keys(o).length > 0);
}

/**
 * Stable identity for a playlist. The `list=` id is the same across
 * `music.youtube.com` and `youtube.com` and survives extra query params, so
 * a session saved from one link is found again from the other.
 */
export function contentKeyFor(url: string): string {
  const m = url.match(/[?&]list=([^&]+)/i);
  if (m) return `list:${m[1]}`;
  const v = url.match(/[?&]v=([^&]+)/i);
  if (v) return `video:${v[1]}`;
  return `url:${url.trim()}`;
}

/** The newest other session that holds the same list, if any. */
export function findSameList(
  sessions: ImportSessionSummary[],
  contentKey: string,
  exceptKey: string,
): ImportSessionSummary | null {
  return sessions.find((s) => s.key !== exceptKey && (s.contentKey ?? s.key) === contentKey) ?? null;
}

export function newSessionKey(): string {
  return `s:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** "New import", "New import 2", … so several fresh ones can be told apart. */
export function freshName(sessions: { title: string }[]): string {
  const taken = new Set(sessions.map((s) => s.title));
  if (!taken.has(DEFAULT_SESSION_NAME)) return DEFAULT_SESSION_NAME;
  let n = 2;
  while (taken.has(`${DEFAULT_SESSION_NAME} ${n}`)) n++;
  return `${DEFAULT_SESSION_NAME} ${n}`;
}

/**
 * What must outlive the page component. It unmounts on every trip to another
 * page (Settings, to index the library mid-import), and a fetch keeps running
 * while another session, or another page, is on screen. Deliberately not
 * saved: a new app run starts on the landing page.
 */
export const openSessions = {
  activeKey: null as string | null,
  /** Open tabs, in order. */
  keys: [] as string[],
  /** Fetches still running, by session. */
  inFlight: new Map<string, Promise<void>>(),
  /** The last save on its way to the database; a load waits for it. */
  pendingSave: Promise.resolve() as Promise<unknown>,
};
