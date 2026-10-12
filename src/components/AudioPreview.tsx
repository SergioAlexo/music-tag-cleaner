import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Pause, Play } from "lucide-react";
import {
  isNowPlayingOwner,
  onSeekRequest,
  publishNowPlaying,
  publishPaused,
  seekTargetSecs,
  setNowPlayingOwner,
} from "../lib/nowPlaying";
import { cn } from "./ui";

// Only one thing plays at a time across the whole table — a row's own
// prelisten button here, or Genre Mode's single-audio-element player in
// TrackTable. Whoever starts playing registers its own stop function so the
// next one to start can pre-empt it.
let activeStopper: (() => void) | null = null;

export function takeOverPlayback(stop: () => void) {
  if (activeStopper && activeStopper !== stop) activeStopper();
  activeStopper = stop;
}

export function releasePlayback(stop: () => void) {
  if (activeStopper === stop) activeStopper = null;
}

/** Stops whatever is currently playing anywhere in the table. */
export function stopAllPlayback() {
  activeStopper?.();
  activeStopper = null;
}

export function formatDuration(seconds: number): string {
  if (!seconds || !Number.isFinite(seconds)) return "--:--";
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Inline prelisten: play/pause plus a scrub bar to rewind through the track.
 *
 * The bar and duration are always shown — everywhere this renders, not just
 * the main Library table — because a row with no way to jump around the
 * track is a worse tool for "is this the right file?" than one with a bar.
 *
 * The trick that keeps this cheap at scale (the YouTube-import matcher and
 * the library search dock can render hundreds of these at once) is
 * `durationSecs`: when the caller already knows the track's length — from
 * the library index or a loaded file's tags — that's used to size the bar
 * immediately and nothing is read from disk until Play (or a scrub) is
 * actually pressed. Only when no hint is available does this fall back to
 * `preload="metadata"` and read the real file up front, which is fine for
 * the main table since it only ever renders its ~60 visible rows.
 */
export function AudioPreview({
  path,
  durationSecs,
  dense = false,
}: {
  path: string;
  /** Known track length, when the caller already has it (avoids touching
   * disk just to size the scrub bar). */
  durationSecs?: number | null;
  /** Slightly smaller bar, for dense list rows. Never hides it. */
  dense?: boolean;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const ownerRef = useRef<object>({});
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [loadedDuration, setLoadedDuration] = useState(0);
  const hasHint = durationSecs != null && durationSecs > 0;

  useEffect(() => {
    // This must run on every `path` change, not just mount: the YouTube-import
    // matcher and the search dock reuse the same <AudioPreview> element as
    // the row underneath it changes, so `path` changes without the
    // component ever unmounting.
    const el = audioRef.current;
    if (el) {
      el.pause();
      if (hasHint) {
        // A known duration means nothing needs to be read yet — the source
        // is only attached lazily, on Play or on a scrub.
        el.removeAttribute("src");
      } else {
        el.src = convertFileSrc(path);
      }
    }
    setReady(!hasHint);
    setPlaying(false);
    setTime(0);
    setLoadedDuration(0);
    return () => {
      if (audioRef.current) audioRef.current.pause();
      releasePlayback(pause);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  const duration = loadedDuration || durationSecs || 0;

  // Tell the lyrics panel (and anything else following playback) where we are.
  useEffect(() => {
    if (playing) {
      setNowPlayingOwner(ownerRef.current);
      publishNowPlaying({ path, timeMs: Math.round(time * 1000), playing: true });
    } else publishPaused(path);
  }, [playing, time, path]);

  // A click on a lyric line asks the player that is (or was last) playing this
  // file to jump there. Same steps as the scrub bar below, so the single
  // global player contract (takeOverPlayback) holds.
  const seekRef = useRef<(ms: number) => void>(() => {});
  seekRef.current = (ms) => {
    const el = audioRef.current;
    if (!el) return;
    ensureLoaded();
    const value = seekTargetSecs(ms, duration);
    el.currentTime = value;
    setTime(value);
    if (!playing) {
      takeOverPlayback(pause);
      void el.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    }
  };
  useEffect(
    () =>
      onSeekRequest((req) => {
        if (req.path !== path || !isNowPlayingOwner(ownerRef.current)) return false;
        seekRef.current(req.ms);
        return true;
      }),
    [path],
  );

  const pause = () => {
    audioRef.current?.pause();
    setPlaying(false);
  };

  const ensureLoaded = () => {
    const el = audioRef.current;
    if (el && !ready) {
      el.src = convertFileSrc(path);
      setReady(true);
    }
  };

  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    const el = audioRef.current;
    if (!el) return;
    if (playing) {
      pause();
      return;
    }
    ensureLoaded();
    takeOverPlayback(pause);
    void el.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
  };

  const seek = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.stopPropagation();
    const el = audioRef.current;
    if (!el) return;
    ensureLoaded();
    const value = Number(e.target.value);
    // Setting currentTime before metadata has loaded is fine — the webview
    // queues it and applies it once the file is readable, so this works
    // even on the very first click before anything has played.
    el.currentTime = value;
    setTime(value);
    if (!playing) {
      takeOverPlayback(pause);
      void el.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    }
  };

  return (
    <div className="flex min-w-0 items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
      <audio
        ref={audioRef}
        preload={hasHint ? "none" : "metadata"}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setLoadedDuration(e.currentTarget.duration || 0)}
        onEnded={() => {
          setPlaying(false);
          setTime(0);
        }}
      />
      <button
        onClick={toggle}
        className={cn(
          "flex shrink-0 items-center justify-center rounded-full",
          dense ? "h-5 w-5" : "h-6 w-6",
          playing ? "bg-primary text-primary-foreground" : "bg-secondary hover:bg-accent",
        )}
        title={playing ? "Pause" : "Prelisten"}
      >
        {playing ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
      </button>
      <input
        type="range"
        min={0}
        max={duration || 0}
        step={0.1}
        value={time}
        onChange={seek}
        onMouseDown={(e) => e.stopPropagation()}
        disabled={!duration}
        className={cn(
          "cursor-pointer accent-[var(--primary)] disabled:opacity-40",
          dense ? "h-1 w-14 min-w-0" : "h-1 min-w-0 flex-1",
        )}
        title="Scrub — click to play from here"
      />
      <span
        className={cn(
          "shrink-0 text-right font-mono text-muted-foreground",
          dense ? "w-8 text-[10px]" : "w-9 text-[11px]",
        )}
      >
        {formatDuration(duration)}
      </span>
    </div>
  );
}
