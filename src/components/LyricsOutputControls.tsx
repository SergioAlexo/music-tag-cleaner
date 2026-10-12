import { Monitor } from "lucide-react";
import {
  BACKGROUNDS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  OFFSET_LIMIT_MS,
  STYLES,
  type LyricsOutputSettings,
} from "../lib/lyricsOutput";
import { closeLyricsOutput, openLyricsOutput, useLyricsOutputOpen } from "../lib/lyricsOutputCtl";
import { cn } from "./ui";

/** Open/close button plus the output's style settings; shown inside the Lyrics panel. */
export function LyricsOutputControls({
  value,
  onChange,
  onError,
}: {
  value: LyricsOutputSettings;
  onChange: (patch: Partial<LyricsOutputSettings>) => void;
  onError: (msg: string) => void;
}) {
  const open = useLyricsOutputOpen();
  const toggle = () =>
    (open ? closeLyricsOutput() : openLyricsOutput()).catch((e) => onError(`Lyrics output: ${String(e)}`));
  const nudge = (d: number) =>
    onChange({ offsetMs: Math.max(-OFFSET_LIMIT_MS, Math.min(OFFSET_LIMIT_MS, value.offsetMs + d)) });

  return (
    <div className="space-y-2 border-t px-3 py-2 text-xs">
      <button
        onClick={() => void toggle()}
        className={cn(
          "flex w-full items-center justify-center gap-1.5 rounded-md px-3 py-1.5",
          open ? "bg-primary text-primary-foreground" : "bg-secondary hover:bg-accent",
        )}
        title="A second window for a projector or an OBS overlay"
      >
        <Monitor className="h-3.5 w-3.5" />
        {open ? "Close lyrics output" : "Lyrics output"}
      </button>

      <Row label="Source">
        <select
          className="w-full rounded border bg-background px-1 py-0.5"
          value={value.mode}
          onChange={(e) => onChange({ mode: e.target.value as LyricsOutputSettings["mode"] })}
        >
          <option value="prelisten">Prelisten player</option>
          <option value="manual">Manual (selected track; arrow keys)</option>
        </select>
      </Row>
      <Row label="Style">
        <select
          className="w-full rounded border bg-background px-1 py-0.5"
          value={value.style}
          onChange={(e) => onChange({ style: e.target.value as LyricsOutputSettings["style"] })}
          title={STYLES.find((s) => s.id === value.style)?.hint}
        >
          {STYLES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Background">
        <select
          className="w-full rounded border bg-background px-1 py-0.5"
          value={value.background}
          onChange={(e) => onChange({ background: e.target.value as LyricsOutputSettings["background"] })}
        >
          {BACKGROUNDS.map((b) => (
            <option key={b.id} value={b.id}>
              {b.label}
            </option>
          ))}
        </select>
      </Row>
      <Row label={`Size ${value.fontSize}`}>
        <input
          type="range"
          min={FONT_SIZE_MIN}
          max={FONT_SIZE_MAX}
          value={value.fontSize}
          onChange={(e) => onChange({ fontSize: Number(e.target.value) })}
          className="w-full accent-[var(--primary)]"
        />
      </Row>
      <Row label="Sync">
        <div className="flex items-center gap-1">
          <button className="rounded bg-secondary px-1.5 py-0.5 hover:bg-accent" onClick={() => nudge(-100)} title="Lyrics later">
            -100
          </button>
          <span className="w-16 text-center font-mono">{value.offsetMs} ms</span>
          <button className="rounded bg-secondary px-1.5 py-0.5 hover:bg-accent" onClick={() => nudge(100)} title="Lyrics earlier">
            +100
          </button>
          <button className="ml-1 text-muted-foreground hover:text-foreground" onClick={() => onChange({ offsetMs: 0 })}>
            reset
          </button>
        </div>
      </Row>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={value.showPrev} onChange={(e) => onChange({ showPrev: e.target.checked })} />
        Show the previous line
      </label>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[5.5rem_1fr] items-center gap-2">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}
