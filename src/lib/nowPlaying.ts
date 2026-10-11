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

export function useNowPlaying(): NowPlaying | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
  );
}
