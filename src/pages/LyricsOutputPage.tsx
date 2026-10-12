import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import {
  BACKGROUND_CSS,
  DEFAULT_LYRICS_OUTPUT,
  EV,
  extrapolate,
  lineWindow,
  manualNow,
  manualPause,
  manualPaused,
  manualStart,
  manualStep,
  normalizeOutputSettings,
  parseClockInput,
  type ManualClock,
  type LyricsOutputSettings,
  type TimeMsg,
  type TrackMsg,
} from "../lib/lyricsOutput";

interface Monitor {
  index: number;
  name: string;
  primary: boolean;
}

/**
 * The window on the projector / the OBS capture. No logic of its own: lines
 * and the player position arrive over events from the main window, and
 * between updates it extrapolates with its own clock (so a busy main window
 * does not stall it). In manual mode it owns the clock: arrow keys / N step
 * lines, Space pauses, "Start at" begins at a time, for music that plays from
 * Rekordbox.
 *
 * Keys: F or double-click = fullscreen, Esc = leave fullscreen,
 * Right/Down/N/Enter = next line, Left/Up/P = previous line (manual mode),
 * Space = start/pause the manual clock, [ and ] = sync offset -/+ 100 ms (shown
 * here only; set it in the Lyrics panel to keep it).
 */
export function LyricsOutputPage() {
  const [cfg, setCfg] = useState<LyricsOutputSettings>(DEFAULT_LYRICS_OUTPUT);
  const [track, setTrack] = useState<TrackMsg | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [startText, setStartText] = useState("0:00");
  const [localOffset, setLocalOffset] = useState(0);

  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;
  const trackRef = useRef(track);
  trackRef.current = track;
  const timeRef = useRef<{ msg: TimeMsg; at: number } | null>(null);
  const clockRef = useRef<ManualClock>(manualPaused(0));
  const placedRef = useRef(false);
  const localOffsetRef = useRef(0);
  localOffsetRef.current = localOffset;

  // What is on screen, recomputed every animation frame but only committed on change.
  const [view, setView] = useState({ index: -2, prev: null as string | null, current: null as string | null, next: null as string | null, progress: 0 });
  const [running, setRunning] = useState(false);

  const effectiveOffset = () => cfgRef.current.offsetMs + localOffsetRef.current;
  const currentTime = (nowTs: number): number | null => {
    if (cfgRef.current.mode === "manual") return manualNow(clockRef.current, nowTs);
    const t = timeRef.current;
    if (!t || t.msg.path !== trackRef.current?.path) return null;
    return extrapolate(t.msg.timeMs, t.msg.playing, t.at, nowTs);
  };

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const lines = trackRef.current?.lines ?? [];
      const t = currentTime(performance.now());
      const w = t == null ? { index: -1, prev: null, current: null, next: null, progress: 0 } : lineWindow(lines, t, effectiveOffset());
      const progress = Math.round(w.progress * 100) / 100;
      setView((v) =>
        v.index === w.index && v.progress === progress && v.current === w.current && v.next === w.next && v.prev === w.prev
          ? v
          : { index: w.index, prev: w.prev, current: w.current, next: w.next, progress },
      );
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshMonitors = useCallback(async () => {
    try {
      setMonitors(await invoke<Monitor[]>("lyrics_output_monitors"));
    } catch {
      /* window going away */
    }
  }, []);

  const setFs = useCallback(async (on: boolean) => {
    try {
      await invoke("lyrics_output_fullscreen", { on });
      setFullscreen(on);
    } catch {
      /* ignore */
    }
  }, []);

  // Listen to the main window; then say we are ready so it sends everything.
  useEffect(() => {
    const subs = [
      listen<unknown>(EV.config, (e) => {
        const next = normalizeOutputSettings(e.payload);
        setCfg(next);
        // Restore the remembered monitor once, right after opening.
        if (!placedRef.current) {
          placedRef.current = true;
          if (next.monitor != null) void invoke("lyrics_output_place", { index: next.monitor, fullscreen: false }).catch(() => {});
        }
      }),
      listen<TrackMsg | null>(EV.track, (e) => {
        setTrack(e.payload);
        // A new track restarts the manual clock at the top, paused.
        clockRef.current = manualPaused(0);
        setRunning(false);
      }),
      listen<TimeMsg>(EV.time, (e) => {
        timeRef.current = { msg: e.payload, at: performance.now() };
      }),
    ];
    void Promise.all(subs).then(() => {
      void emit(EV.ready, {});
      void refreshMonitors();
    });
    return () => {
      subs.forEach((p) => void p.then((un) => un()));
    };
  }, [refreshMonitors]);

  const step = useCallback((dir: 1 | -1) => {
    const lines = trackRef.current?.lines ?? [];
    if (cfgRef.current.mode !== "manual" || !lines.length) return;
    clockRef.current = manualStep(clockRef.current, lines, dir, effectiveOffset(), performance.now());
  }, []);

  const startAt = useCallback(() => {
    const ms = parseClockInput(startText) ?? 0;
    clockRef.current = manualStart(ms, performance.now());
    setRunning(true);
  }, [startText]);

  const togglePause = useCallback(() => {
    const nowTs = performance.now();
    if (clockRef.current.startedAt == null) {
      // Plain lyrics have no time to run; only stepping works there.
      if (trackRef.current && !trackRef.current.synced) return;
      clockRef.current = manualStart(clockRef.current.baseMs, nowTs);
      setRunning(true);
    } else {
      clockRef.current = manualPause(clockRef.current, nowTs);
      setRunning(false);
    }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT" || (e.target as HTMLElement)?.tagName === "SELECT") return;
      const k = e.key;
      if (k === "f" || k === "F") void setFs(!fullscreen);
      else if (k === "Escape") void setFs(false);
      else if (k === "ArrowRight" || k === "ArrowDown" || k === "n" || k === "N" || k === "Enter") {
        e.preventDefault();
        step(1);
      } else if (k === "ArrowLeft" || k === "ArrowUp" || k === "p" || k === "P") {
        e.preventDefault();
        step(-1);
      } else if (k === " ") {
        e.preventDefault();
        if (cfgRef.current.mode === "manual") togglePause();
      } else if (k === "[") setLocalOffset((o) => o - 100);
      else if (k === "]") setLocalOffset((o) => o + 100);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen, setFs, step, togglePause]);

  // Controls fade out after a moment without the mouse (and the cursor with them).
  const hideTimer = useRef<number | undefined>(undefined);
  const poke = () => {
    setControlsVisible(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setControlsVisible(false), 2500);
  };
  useEffect(() => {
    poke();
    return () => window.clearTimeout(hideTimer.current);
  }, []);

  const bg = BACKGROUND_CSS[cfg.background];
  useEffect(() => {
    for (const el of [document.documentElement, document.body, document.getElementById("root")]) {
      if (el) el.style.setProperty("background", bg, "important");
    }
  }, [bg]);

  const pickMonitor = async (index: number) => {
    try {
      await invoke("lyrics_output_place", { index, fullscreen: true });
      setFullscreen(true);
      void emit(EV.monitor, { index });
    } catch {
      void refreshMonitors();
    }
  };

  const hasLines = (track?.lines.length ?? 0) > 0;

  return (
    <div
      className="relative h-screen w-screen select-none overflow-hidden"
      style={{ background: bg, cursor: controlsVisible ? "default" : "none", color: "#fff", fontFamily: "system-ui, sans-serif" }}
      onMouseMove={poke}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest("[data-controls]")) return;
        void setFs(!fullscreen);
      }}
    >
      <Stage cfg={cfg} view={view} hasLines={hasLines} title={track?.title ?? null} instrumental={!!track?.instrumental} manual={cfg.mode === "manual"} />

      <div
        data-controls
        className="absolute inset-x-0 top-0 flex flex-wrap items-center gap-2 bg-black/70 px-3 py-2 text-xs text-white transition-opacity"
        style={{ opacity: controlsVisible ? 1 : 0, pointerEvents: controlsVisible ? "auto" : "none" }}
      >
        <button className="rounded bg-white/15 px-2 py-1 hover:bg-white/25" onClick={() => void setFs(!fullscreen)}>
          {fullscreen ? "Exit fullscreen (Esc)" : "Fullscreen (F)"}
        </button>
        <select
          className="rounded bg-white/15 px-2 py-1"
          value=""
          onFocus={() => void refreshMonitors()}
          onChange={(e) => e.target.value !== "" && void pickMonitor(Number(e.target.value))}
        >
          <option value="">Move to monitor…</option>
          {monitors.map((m) => (
            <option key={m.index} value={m.index} className="text-black">
              {m.name}
              {m.primary ? " (main)" : ""}
              {cfg.monitor === m.index ? " ✓" : ""}
            </option>
          ))}
        </select>
        <span className="opacity-70">Sync {formatOffset(cfg.offsetMs + localOffset)} ([ / ])</span>
        {cfg.mode === "manual" ? (
          <>
            <span className="mx-1 opacity-40">|</span>
            <span className="opacity-70">Manual</span>
            <button className="rounded bg-white/15 px-2 py-1 hover:bg-white/25" onClick={() => step(-1)}>
              Prev
            </button>
            <button className="rounded bg-white/15 px-2 py-1 hover:bg-white/25" onClick={() => step(1)}>
              Next (→)
            </button>
            <button className="rounded bg-white/15 px-2 py-1 hover:bg-white/25" onClick={togglePause} disabled={!track?.synced}>
              {running ? "Pause (Space)" : "Resume (Space)"}
            </button>
            <input
              className="w-16 rounded bg-white/15 px-2 py-1"
              value={startText}
              onChange={(e) => setStartText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && startAt()}
              title="mm:ss"
            />
            <button className="rounded bg-white/15 px-2 py-1 hover:bg-white/25" onClick={startAt} disabled={!track?.synced}>
              Start at
            </button>
          </>
        ) : (
          <span className="opacity-70">Following the prelisten player</span>
        )}
        {track && <span className="ml-auto max-w-[40%] truncate opacity-60">{track.title}</span>}
      </div>
    </div>
  );
}

function formatOffset(ms: number): string {
  return `${ms > 0 ? "+" : ""}${ms} ms`;
}

interface View {
  index: number;
  prev: string | null;
  current: string | null;
  next: string | null;
  progress: number;
}

function Stage({
  cfg,
  view,
  hasLines,
  title,
  instrumental,
  manual,
}: {
  cfg: LyricsOutputSettings;
  view: View;
  hasLines: boolean;
  title: string | null;
  instrumental: boolean;
  manual: boolean;
}) {
  // Sizes scale with the window height so a 1080p projector and a small preview look alike.
  const [h, setH] = useState(() => window.innerHeight);
  useEffect(() => {
    const on = () => setH(window.innerHeight);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  const big = (cfg.fontSize / 1080) * h;
  const small = big * 0.55;

  const hint = !title
    ? manual
      ? "Select a track in the library, then press Start at or Next"
      : "Play a track (prelisten) in the main window"
    : instrumental
      ? "Instrumental"
      : !hasLines
        ? "No lyrics for this track"
        : null;

  const style = cfg.style;
  const color = {
    clean: { cur: "#ffffff", dim: "rgba(255,255,255,0.45)", shadow: "none" },
    karaoke: { cur: "#ffd400", dim: "rgba(255,255,255,0.85)", shadow: "0 2px 12px rgba(0,0,0,0.6)" },
    neon: {
      cur: "#7df9ff",
      dim: "rgba(255,105,230,0.75)",
      shadow: "0 0 8px #00e5ff, 0 0 24px #00b8ff, 0 0 48px #0077ff",
    },
    lowerThird: { cur: "#ffffff", dim: "rgba(255,255,255,0.75)", shadow: "0 2px 8px rgba(0,0,0,0.8)" },
  }[style];

  if (hint) {
    return (
      <div className="flex h-full items-center justify-center px-8 text-center opacity-60" style={{ fontSize: small * 0.6 }}>
        {hint}
      </div>
    );
  }

  if (style === "lowerThird") {
    return (
      <div className="absolute inset-x-0 bottom-0 flex justify-start p-[4vh]">
        <div
          key={view.index}
          className="lyrics-fade max-w-[80%] rounded-md px-[2vh] py-[1.2vh]"
          style={{
            background: cfg.background === "transparent" ? "rgba(0,0,0,0.65)" : "rgba(0,0,0,0.55)",
            borderLeft: `${Math.max(4, big * 0.08)}px solid ${color.cur}`,
          }}
        >
          <div style={{ fontSize: big * 0.62, fontWeight: 700, lineHeight: 1.15, color: color.cur, textShadow: color.shadow }}>
            {view.current ?? " "}
          </div>
          {view.next && (
            <div style={{ fontSize: big * 0.34, lineHeight: 1.2, color: color.dim, marginTop: 4 }}>{view.next}</div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-[3vh] px-[6vw] text-center">
      {cfg.showPrev && (
        <div key={`p${view.index}`} className="lyrics-fade" style={{ fontSize: small, color: color.dim, opacity: 0.55, textShadow: color.shadow, minHeight: small * 1.2 }}>
          {view.prev ?? " "}
        </div>
      )}
      <div
        key={`c${view.index}`}
        className="lyrics-rise"
        style={{
          fontSize: big,
          fontWeight: 800,
          lineHeight: 1.12,
          minHeight: big * 1.2,
          ...(style === "karaoke"
            ? {
                backgroundImage: `linear-gradient(90deg, ${color.cur} 0%, ${color.cur} ${view.progress * 100}%, ${color.dim} ${view.progress * 100}%, ${color.dim} 100%)`,
                WebkitBackgroundClip: "text",
                backgroundClip: "text",
                color: "transparent",
                WebkitTextFillColor: "transparent",
                filter: "drop-shadow(0 2px 12px rgba(0,0,0,0.6))",
              }
            : { color: color.cur, textShadow: color.shadow }),
        }}
      >
        {view.current ?? " "}
      </div>
      <div key={`n${view.index}`} className="lyrics-fade" style={{ fontSize: small, color: color.dim, textShadow: color.shadow, minHeight: small * 1.2 }}>
        {view.next ?? " "}
      </div>
    </div>
  );
}
