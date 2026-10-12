import { useSyncExternalStore } from "react";

/**
 * What the prelisten player is playing right now, for anything that wants to
 * follow it (the lyrics panel today; a "lyrics output" window or an OSC
 * bridge later). `AudioPreview` is mounted once per visible row, so the state
 * cannot live in a component: the one that is actually playing publishes here
 * and consumers subscribe.
 */
export interface NowPlaying {
  path: string;
  /** Playback position in milliseconds. */
  timeMs: number;
  playing: boolean;
}

let state: NowPlaying | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

/** Called by the player that is playing (or has just seeked). */
export function publishNowPlaying(next: NowPlaying) {
  if (state && state.path === next.path && state.playing === next.playing && state.timeMs === next.timeMs) return;
  state = next;
  emit();
}

/** A player paused or ended: keep the last position, mark it stopped (only if it is still the current one). */
export function publishPaused(path: string) {
  if (!state || state.path !== path || !state.playing) return;
  state = { ...state, playing: false };
  emit();
}

// ---------------------------------------------------------------------------
// Seek channel: the lyrics panel (click a line) asks the active prelisten
// player to jump. Mirrors the position publishing above, in the other
// direction. The single global player contract stays in AudioPreview
// (`takeOverPlayback`): a handler that resumes playback goes through it.

/** Seconds to seek to for a lyric line at `ms`, kept inside the track when its length is known. */
export function seekTargetSecs(ms: number, durationSecs: number): number {
  if (!Number.isFinite(ms) || ms < 0) return 0;
  const secs = ms / 1000;
  return durationSecs > 0 ? Math.min(secs, durationSecs) : secs;
}

/** Return true when this player took the request (first taker wins, so one player moves). */
export type SeekHandler = (req: { path: string; ms: number }) => boolean;
const seekHandlers = new Set<SeekHandler>();

export function onSeekRequest(handler: SeekHandler): () => void {
  seekHandlers.add(handler);
  return () => seekHandlers.delete(handler);
}

/** Asks the player of `path` to seek to `ms` (and play). False when no player owns that path. */
export function requestSeek(path: string, ms: number): boolean {
  for (const h of seekHandlers) if (h({ path, ms })) return true;
  return false;
}

/**
 * Which player instance published last. `AudioPreview` is mounted per row and
 * the same file can appear in several lists; only the one that actually
 * played answers a seek.
 */
let lastOwner: object | null = null;
export function setNowPlayingOwner(owner: object) {
  lastOwner = owner;
}
export function isNowPlayingOwner(owner: object): boolean {
  return lastOwner === owner;
}

export function useNowPlaying(): NowPlaying | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
  );
}
