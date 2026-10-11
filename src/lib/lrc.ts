/**
 * LRC parsing for the lyrics panel. The Rust twin (`parse_lrc` in
 * commands/lyrics.rs) is used where lyrics are stripped for embedding and
 * language detection; this one drives the highlighted line during prelisten.
 */
export interface LrcLine {
  timeMs: number;
  text: string;
}

/** `mm:ss`, `mm:ss.f`, `mm:ss.ff`, `mm:ss.fff` (a `:` before the fraction also appears in the wild). */
export function parseTimestamp(tag: string): number | null {
  const m = /^(\d+):(\d{1,2})(?:[.:](\d+))?$/.exec(tag.trim());
  if (!m) return null;
  const frac = m[3] ? Number(m[3].slice(0, 3).padEnd(3, "0")) : 0;
  return Number(m[1]) * 60_000 + Number(m[2]) * 1000 + frac;
}

/** Time-ordered synced lines. Lines with no time tag are dropped; `[offset:]` is applied. */
export function parseLrc(src: string): LrcLine[] {
  let offset = 0;
  const out: LrcLine[] = [];
  for (const raw of src.split(/\r?\n/)) {
    let rest = raw.replace(/^﻿/, "").trim();
    const times: number[] = [];
    for (;;) {
      const m = /^\[([^\]]*)\]\s*/.exec(rest);
      if (!m) break;
      const t = parseTimestamp(m[1]);
      if (t !== null) times.push(t);
      else if (m[1].startsWith("offset:")) offset = Number(m[1].slice(7)) || 0;
      else if (!m[1].includes(":")) break;
      rest = rest.slice(m[0].length);
    }
    for (const t of times) out.push({ timeMs: Math.max(0, t - offset), text: rest.trim() });
  }
  return out.sort((a, b) => a.timeMs - b.timeMs);
}

export function isSynced(text: string): boolean {
  return parseLrc(text).length >= 2;
}

/** Index of the line being sung at `ms` (-1 before the first line). Binary search; lines are sorted. */
export function currentLineIndex(lines: LrcLine[], ms: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].timeMs <= ms) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}
