import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, RefreshCw } from "lucide-react";
import type { CueData, CuePoint, LoopPoint } from "../types";
import { cn } from "./ui";

/** Rekordbox's default hot cue colors (pad 1-8), used when a cue has no
 * explicit color in the XML — matches what Rekordbox itself shows. */
const DEFAULT_HOT_CUE_COLORS = [
  "#ff2eb6", "#ff6600", "#ffcc00", "#4dff4d",
  "#00ccff", "#3366ff", "#9933ff", "#ff3333",
];

function cueColor(cue: CuePoint | LoopPoint, index: number): string {
  if (cue.color) {
    const [r, g, b] = cue.color;
    return `rgb(${r}, ${g}, ${b})`;
  }
  if (cue.pad != null) return DEFAULT_HOT_CUE_COLORS[cue.pad % DEFAULT_HOT_CUE_COLORS.length];
  return index === 0 ? "#4dff4d" : "#e0e0e0"; // memory cues: first one greenish, rest neutral
}

const cache: Record<string, number[]> = {};

/**
 * A track's waveform (peak amplitude per bucket, 0-1), fetched via the
 * `get_waveform` command (full-file decode, cached in the same sqlite
 * database the duplicate-detection fingerprint cache uses — see
 * duplicates.rs). Cached in memory per path for the life of the page so
 * switching between already-seen tracks (e.g. Genre Mode navigation) is instant.
 *
 * `progress` (0-1, optional) draws a playhead line — used by the Genre Mode
 * strip to show where playback currently is.
 */
export function Waveform({
  path,
  height = 32,
  progress,
  className,
  cues,
  durationSecs,
  onSeek,
}: {
  path: string;
  height?: number;
  progress?: number;
  className?: string;
  /** Needle drop: press anywhere on the waveform (and drag to scrub) to jump
   * playback there. Receives the position as a 0-1 fraction of the track.
   * Omitted, the waveform stays a passive display. */
  onSeek?: (fraction: number) => void;
  /** Rekordbox cues/loops for this track (see `get_cues_for_path`), drawn as
   * an overlay on top of the waveform. Requires `durationSecs` to position
   * them — without it, cues are silently skipped. */
  cues?: CueData | null;
  durationSecs?: number;
}) {
  const [peaks, setPeaks] = useState<number[] | null>(cache[path] ?? null);

  // Bumped by the "regenerate" button to re-run the fetch below.
  const [retry, setRetry] = useState(0);
  const [regenerating, setRegenerating] = useState(false);

  useEffect(() => {
    // `retry > 0` bypasses the in-memory cache. Empty/failed results are never
    // stored there, so a failure can't be pinned for the session.
    if (cache[path] && retry === 0) {
      setPeaks(cache[path]);
      return;
    }
    let cancelled = false;
    setPeaks(null);
    invoke<number[]>("get_waveform", { path })
      .then((p) => {
        if (p.length) cache[path] = p;
        else delete cache[path];
        if (!cancelled) setPeaks(p);
      })
      .catch(() => {
        delete cache[path];
        if (!cancelled) setPeaks([]);
      })
      .finally(() => {
        if (!cancelled) setRegenerating(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, retry]);

  if (peaks === null) {
    return (
      <div
        className={cn("flex items-center justify-center text-muted-foreground", className)}
        style={{ height }}
      >
        <Loader2 className="h-3 w-3 animate-spin" />
      </div>
    );
  }
  if (peaks.length === 0) {
    // No peaks: keep a flat bar that still seeks (by fraction of duration, which
    // the caller resolves) so rewinding works even when generation failed.
    const seekFromBar = (e: React.PointerEvent<HTMLDivElement>) => {
      if (!onSeek) return;
      const r = e.currentTarget.getBoundingClientRect();
      if (r.width > 0) onSeek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
    };
    return (
      <div className={cn("flex items-center gap-1.5", className)} style={{ height }}>
        <div
          className={cn("relative h-3 min-w-0 flex-1 rounded-sm bg-primary/20", onSeek && "cursor-pointer")}
          style={{ touchAction: onSeek ? "none" : undefined }}
          title="No waveform data. Click to seek."
          onPointerDown={(e) => {
            if (!onSeek || e.button !== 0) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            seekFromBar(e);
          }}
          onPointerMove={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) seekFromBar(e);
          }}
          onPointerUp={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId))
              e.currentTarget.releasePointerCapture(e.pointerId);
          }}
        >
          {progress !== undefined && progress >= 0 && progress <= 1 && (
            <div className="absolute inset-y-0 w-0.5 bg-primary" style={{ left: `${progress * 100}%` }} />
          )}
        </div>
        <button
          type="button"
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent"
          title="Regenerate waveform"
          disabled={regenerating}
          onClick={() => {
            setRegenerating(true);
            setRetry((n) => n + 1);
          }}
        >
          <RefreshCw className={cn("h-3 w-3", regenerating && "animate-spin")} />
        </button>
      </div>
    );
  }

  const n = peaks.length;

  // Pointer x -> 0-1 position. Pointer capture (rather than window listeners)
  // keeps the scrub alive when the cursor leaves the 28px-tall strip, which it
  // does almost immediately on any real drag.
  const seekFrom = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!onSeek) return;
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width <= 0) return;
    onSeek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
  };

  return (
    <svg
      viewBox={`0 0 ${n} 100`}
      preserveAspectRatio="none"
      className={cn("block w-full", onSeek && "cursor-pointer", className)}
      style={{ height, touchAction: onSeek ? "none" : undefined }}
      onPointerDown={
        onSeek
          ? (e) => {
              if (e.button !== 0) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              seekFrom(e);
            }
          : undefined
      }
      onPointerMove={
        onSeek
          ? (e) => {
              if (e.currentTarget.hasPointerCapture(e.pointerId)) seekFrom(e);
            }
          : undefined
      }
      onPointerUp={
        onSeek
          ? (e) => {
              if (e.currentTarget.hasPointerCapture(e.pointerId))
                e.currentTarget.releasePointerCapture(e.pointerId);
            }
          : undefined
      }
    >
      {peaks.map((p, i) => {
        const barHeight = Math.max(2, p * 98);
        return (
          <rect
            key={i}
            x={i}
            y={(100 - barHeight) / 2}
            width={1}
            height={barHeight}
            className="fill-primary/60"
          />
        );
      })}
      {cues && durationSecs && durationSecs > 0 && (
        <>
          {cues.loops.map((loop, i) => {
            const x0 = (loop.startSecs / durationSecs) * n;
            const x1 = (loop.endSecs / durationSecs) * n;
            const color = cueColor(loop, i);
            return (
              <rect
                key={`loop-${i}`}
                x={Math.min(x0, x1)}
                y={0}
                width={Math.max(0.5, Math.abs(x1 - x0))}
                height={100}
                fill={color}
                opacity={0.22}
              >
                <title>{loop.name || `Loop ${i + 1}`}</title>
              </rect>
            );
          })}
          {cues.memoryCues.map((cue, i) => {
            const x = (cue.positionSecs / durationSecs) * n;
            const color = cueColor(cue, i);
            return (
              <rect key={`mem-${i}`} x={x} y={0} width={Math.max(0.5, n * 0.0025)} height={100} fill={color}>
                <title>{cue.name || `Memory Cue ${i + 1}`}</title>
              </rect>
            );
          })}
          {cues.hotCues.map((cue, i) => {
            const x = (cue.positionSecs / durationSecs) * n;
            const color = cueColor(cue, i);
            return (
              <g key={`hot-${i}`}>
                <rect x={x} y={0} width={Math.max(0.6, n * 0.003)} height={100} fill={color}>
                  <title>{cue.name || `Hot Cue ${(cue.pad ?? i) + 1}`}</title>
                </rect>
                <rect x={x} y={0} width={Math.max(2.5, n * 0.01)} height={10} fill={color} />
              </g>
            );
          })}
        </>
      )}
      {progress !== undefined && progress >= 0 && progress <= 1 && (
        <g className="fill-primary">
          <rect x={progress * n} y={0} width={Math.max(0.6, n * 0.003)} height={100} />
          <rect
            x={progress * n - Math.max(1.2, n * 0.006)}
            y={0}
            width={Math.max(3, n * 0.015)}
            height={8}
            rx={Math.max(0.6, n * 0.003)}
          />
        </g>
      )}
    </svg>
  );
}
