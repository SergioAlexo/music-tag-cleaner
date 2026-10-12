import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import type { LyricsData } from "../lib/lyrics";
import { EV, trackMsgFrom, type LyricsOutputSettings, type TimeMsg, type TrackMsg } from "../lib/lyricsOutput";
import { markLyricsOutputOpen, useLyricsOutputOpen } from "../lib/lyricsOutputCtl";
import { useNowPlaying } from "../lib/nowPlaying";
import { basename } from "../types";

/**
 * Main-window side of the lyrics output: renders nothing, broadcasts.
 *
 * The output window only listens (see `pages/LyricsOutputPage.tsx`), so a
 * busy main window cannot freeze it: it animates between position updates on
 * its own clock. Sent here: the track's lines when the track changes, the
 * playback position on every player update (prelisten mode), and the style
 * config when it changes; everything again when the window says it is ready
 * (it was just opened, or reloaded).
 */
export function LyricsOutputBridge({
  settings,
  onSettings,
  prelistenPath,
  selectedPath,
  refreshKey,
}: {
  settings: LyricsOutputSettings;
  onSettings: (patch: Partial<LyricsOutputSettings>) => void;
  /** The track the prelisten player last played. */
  prelistenPath: string | null;
  /** First selected library track: the source in manual mode (music plays elsewhere). */
  selectedPath: string | null;
  /** Bumped when lyrics were just fetched, so the output reloads them. */
  refreshKey: number;
}) {
  const open = useLyricsOutputOpen();
  const now = useNowPlaying();
  const sourcePath = settings.mode === "manual" ? selectedPath : prelistenPath;

  const [track, setTrack] = useState<TrackMsg | null>(null);
  useEffect(() => {
    if (!open || !sourcePath) {
      setTrack(null);
      return;
    }
    let cancelled = false;
    invoke<LyricsData | null>("lyrics_for_path", { path: sourcePath })
      .catch(() => null)
      .then((d) => !cancelled && setTrack(trackMsgFrom(sourcePath, basename(sourcePath), d)));
    return () => {
      cancelled = true;
    };
  }, [open, sourcePath, refreshKey]);

  const timeMsg: TimeMsg | null =
    settings.mode === "prelisten" && now && now.path === sourcePath
      ? { path: now.path, timeMs: now.timeMs, playing: now.playing }
      : null;

  // Everything the window needs, kept current for the "ready" handshake.
  const latest = useRef({ track, settings, timeMsg });
  latest.current = { track, settings, timeMsg };
  const sendAll = () => {
    const { track: t, settings: s, timeMsg: tm } = latest.current;
    void emit(EV.config, s);
    void emit(EV.track, t);
    if (tm) void emit(EV.time, tm);
  };

  useEffect(() => {
    const subs = [
      listen(EV.ready, () => {
        markLyricsOutputOpen();
        sendAll();
      }),
      listen<{ index: number | null }>(EV.monitor, (e) => onSettings({ monitor: e.payload.index })),
    ];
    return () => {
      subs.forEach((p) => void p.then((un) => un()));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (open) void emit(EV.config, settings);
  }, [open, settings]);
  useEffect(() => {
    if (open) void emit(EV.track, track);
  }, [open, track]);
  useEffect(() => {
    if (open && timeMsg) void emit(EV.time, timeMsg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, timeMsg?.path, timeMsg?.timeMs, timeMsg?.playing]);

  return null;
}
