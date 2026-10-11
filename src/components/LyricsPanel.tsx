import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Download, Mic2, X } from "lucide-react";
import type { LyricsData, LyricsResult } from "../lib/lyrics";
import { currentLineIndex, parseLrc } from "../lib/lrc";
import { useNowPlaying } from "../lib/nowPlaying";
import { basename, type LyricsStorage } from "../types";
import { cn } from "./ui";

/**
 * Lyrics for the track being prelistened. Synced lyrics highlight and scroll
 * to the current line; plain ones just show. Reads what is already on disk /
 * in the cache (`lyrics_for_path`), and offers a one-click fetch when there is
 * nothing. This is the seed of the "DJ + karaoke visuals" idea: the same
 * `useNowPlaying` feed would drive a projector window (see notes/B3.md).
 *
 * Rendered once, floating, rather than inside a row: `AudioPreview` is
 * mounted per visible row, so only the shared now-playing store can reach it.
 */
export function LyricsPanel({
  storage,
  onStored,
}: {
  storage: LyricsStorage;
  /** Called after a fetch wrote something, so the caller can re-index embedded writes. */
  onStored?: (path: string, result: LyricsResult) => void;
}) {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem("lyricsPanel.open") === "1";
    } catch {
      return false;
    }
  });
  const setOpenPersist = (v: boolean) => {
    setOpen(v);
    try {
      localStorage.setItem("lyricsPanel.open", v ? "1" : "0");
    } catch {
      /* not persisted */
    }
  };
  const now = useNowPlaying();
  // The track the panel shows keeps showing after pause; it changes when a different one plays.
  const [path, setPath] = useState<string | null>(null);
  useEffect(() => {
    if (now?.playing) setPath(now.path);
  }, [now?.playing, now?.path]);

  const [data, setData] = useState<LyricsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!open || !path) return;
    let cancelled = false;
    setLoading(true);
    setNote(null);
    invoke<LyricsData | null>("lyrics_for_path", { path })
      .then((d) => !cancelled && setData(d))
      .catch(() => !cancelled && setData(null))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [open, path, nonce]);

  const lines = useMemo(() => (data?.synced ? parseLrc(data.synced) : []), [data]);
  const timeMs = now && now.path === path ? now.timeMs : 0;
  const active = lines.length ? currentLineIndex(lines, timeMs) : -1;

  const boxRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = boxRef.current;
    const el = activeRef.current;
    if (!box || !el) return;
    box.scrollTo({ top: el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2, behavior: "smooth" });
  }, [active]);

  const fetchNow = async () => {
    if (!path) return;
    setFetching(true);
    try {
      const [r] = await invoke<LyricsResult[]>("lyrics_fetch", { paths: [path], storage, overwrite: false });
      if (r.status === "error") setNote(r.detail ?? "Could not fetch lyrics");
      else if (r.status === "notFound") setNote("LRCLIB has no lyrics for this track");
      else if (r.status === "instrumental") setNote("Instrumental");
      else {
        onStored?.(path, r);
        setNonce((n) => n + 1);
      }
    } catch (e) {
      setNote(String(e));
    } finally {
      setFetching(false);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpenPersist(true)}
        className="fixed bottom-4 right-4 z-40 flex items-center gap-1.5 rounded-full border bg-card px-3 py-1.5 text-xs shadow-md hover:bg-accent"
        title="Show lyrics for the track you are prelistening"
      >
        <Mic2 className="h-3.5 w-3.5" />
        Lyrics
      </button>
    );
  }

  return (
    <div className="fixed bottom-4 right-4 z-40 flex h-80 w-80 flex-col overflow-hidden rounded-lg border bg-card shadow-xl">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Mic2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={path ?? undefined}>
          {path ? basename(path) : "Lyrics"}
        </span>
        <button
          onClick={() => setOpenPersist(false)}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          title="Hide"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div ref={boxRef} className="relative min-h-0 flex-1 overflow-y-auto px-3 py-2 text-sm">
        {!path ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            Press play on a track (prelisten) and its lyrics show here.
          </p>
        ) : loading ? (
          <p className="py-6 text-center text-xs text-muted-foreground">Looking for lyrics…</p>
        ) : data?.instrumental ? (
          <p className="py-6 text-center text-xs text-muted-foreground">Instrumental.</p>
        ) : lines.length > 0 ? (
          lines.map((l, i) => (
            <div
              key={i}
              ref={i === active ? activeRef : undefined}
              className={cn(
                "py-0.5 leading-snug transition-colors",
                i === active ? "font-semibold text-primary" : i < active ? "text-muted-foreground/60" : "text-muted-foreground",
              )}
            >
              {l.text || " "}
            </div>
          ))
        ) : data?.plain ? (
          <pre className="whitespace-pre-wrap font-sans text-xs text-muted-foreground">{data.plain}</pre>
        ) : (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <p className="text-xs text-muted-foreground">{note ?? "No lyrics stored for this track yet."}</p>
            {!note && (
              <button
                onClick={() => void fetchNow()}
                disabled={fetching}
                className="flex items-center gap-1.5 rounded-md bg-secondary px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
              >
                <Download className="h-3.5 w-3.5" />
                {fetching ? "Fetching…" : "Fetch from LRCLIB"}
              </button>
            )}
          </div>
        )}
      </div>
      {data && !data.instrumental && (
        <div className="border-t px-3 py-1 text-[10px] text-muted-foreground">
          {data.synced ? "Synced" : "Plain"} · from {data.source}
        </div>
      )}
    </div>
  );
}
