import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * Open / close / ask-if-open for the lyrics output window. The window itself
 * is created in Rust (`commands/lyrics_output.rs`); this is the thin JS side
 * shared by the Lyrics panel button and the `lyrics.output.*` actions.
 */
const openListeners = new Set<(open: boolean) => void>();
let known = false;

function set(open: boolean) {
  if (known === open) return;
  known = open;
  openListeners.forEach((l) => l(open));
}

export async function openLyricsOutput(): Promise<void> {
  await invoke("lyrics_output_open");
  set(true);
}

export async function closeLyricsOutput(): Promise<void> {
  await invoke("lyrics_output_close");
  set(false);
}

export async function lyricsOutputIsOpen(): Promise<boolean> {
  const open = await invoke<boolean>("lyrics_output_is_open").catch(() => false);
  set(open);
  return open;
}

/** Called when the output window says it is up (it may also have been opened from somewhere else). */
export function markLyricsOutputOpen() {
  set(true);
}

/**
 * Whether the output window exists. The window can be closed with its own X,
 * and closing it from there cannot be observed without extra window
 * permissions, so while it is open this re-asks every 2 s (a cheap command).
 */
export function useLyricsOutputOpen(): boolean {
  const [open, setOpen] = useState(known);
  useEffect(() => {
    openListeners.add(setOpen);
    void lyricsOutputIsOpen();
    return () => {
      openListeners.delete(setOpen);
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    const id = window.setInterval(() => void lyricsOutputIsOpen(), 2000);
    return () => window.clearInterval(id);
  }, [open]);
  return open;
}
