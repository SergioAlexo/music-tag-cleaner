import { useDeferredValue, useMemo, useState } from "react";
import { Plus, Sparkles, Trash2, X } from "lucide-react";
import { Button, Card, cn, inputClass, selectClass } from "./ui";
import { VirtualList } from "./VirtualList";
import {
  FIELDS,
  OP_LABELS,
  evaluateRuleSet,
  fieldKind,
  opsFor,
  type Rule,
  type RuleField,
  type RuleOp,
  type RuleSet,
} from "../lib/smartRules";
import {
  listFacetValues,
  type DjTrack,
  type FacetValue,
  type PlaylistFacet,
} from "../lib/djPlaylists";

function Modal({
  title,
  icon,
  width = 460,
  onClose,
  children,
  footer,
}: {
  title: string;
  icon?: React.ReactNode;
  width?: number;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <Card className="flex max-h-[85vh] flex-col overflow-hidden" >
        <div style={{ width }} className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center justify-between gap-4 border-b px-5 py-3.5">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              {icon} {title}
            </h2>
            <button className="text-muted-foreground hover:text-foreground" onClick={onClose} aria-label="Close">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex items-center justify-end gap-2 border-t px-5 py-3">{footer}</div>}
        </div>
      </Card>
    </div>
  );
}

/** One text field: new playlist / folder, rename, duplicate. */
export function NameDialog({
  title,
  label,
  initial,
  confirmLabel = "OK",
  onSubmit,
  onCancel,
}: {
  title: string;
  label?: string;
  initial: string;
  confirmLabel?: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial);
  const ok = name.trim().length > 0;
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" disabled={!ok} onClick={() => onSubmit(name.trim())}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {label && <p className="mb-2 text-xs text-muted-foreground">{label}</p>}
      <input
        autoFocus
        className={inputClass}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key === "Enter" && ok) onSubmit(name.trim());
          if (e.key === "Escape") onCancel();
        }}
      />
    </Modal>
  );
}

/** Tracks that didn't map across (count in the header, the list here). */
export function UnmatchedDialog({
  title,
  intro,
  paths,
  onClose,
}: {
  title: string;
  intro: string;
  paths: string[];
  onClose: () => void;
}) {
  return (
    <Modal title={title} width={640} onClose={onClose} footer={<Button size="sm" onClick={onClose}>Close</Button>}>
      <p className="mb-3 text-xs text-muted-foreground">{intro}</p>
      <ul className="max-h-80 overflow-y-auto rounded-md border bg-background/50 p-2 font-mono text-[11px] leading-5">
        {paths.slice(0, 500).map((p, i) => (
          <li key={i} className="truncate" title={p}>
            {p}
          </li>
        ))}
        {paths.length > 500 && <li className="text-muted-foreground">…and {paths.length - 500} more</li>}
      </ul>
      <Button
        variant="outline"
        size="sm"
        className="mt-3"
        onClick={() => void navigator.clipboard?.writeText(paths.join("\n"))}
      >
        Copy list
      </Button>
    </Modal>
  );
}

const defaultRule = (): Rule => ({ field: "genre", op: "is", value: "" });

/** Rules editor with a live match count over `tracks`. */
export function RuleEditorDialog({
  title,
  initialName,
  initialRules,
  tracks,
  nameEditable,
  onSave,
  onCancel,
}: {
  title: string;
  initialName: string;
  initialRules: RuleSet | null;
  tracks: DjTrack[];
  nameEditable: boolean;
  onSave: (name: string, rules: RuleSet) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [match, setMatch] = useState<"all" | "any">(initialRules?.match ?? "all");
  const [rules, setRules] = useState<Rule[]>(initialRules?.rules.length ? initialRules.rules : [defaultRule()]);
  const set: RuleSet = useMemo(() => ({ match, rules }), [match, rules]);
  const deferred = useDeferredValue(set);
  // Live preview over the whole library; deferred so typing in a value box
  // never waits on a 5,000-track scan.
  const hits = useMemo(() => evaluateRuleSet(deferred, tracks), [deferred, tracks]);
  const patch = (i: number, p: Partial<Rule>) => setRules((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const canSave = name.trim().length > 0 && rules.length > 0 && rules.every((r) => r.op === "empty" || r.op === "notEmpty" || r.value.trim() !== "");

  return (
    <Modal
      title={title}
      icon={<Sparkles className="h-4 w-4" />}
      width={680}
      onClose={onCancel}
      footer={
        <>
          <span className="mr-auto text-xs text-muted-foreground">
            {hits.length.toLocaleString()} matching track{hits.length === 1 ? "" : "s"}
          </span>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" disabled={!canSave} onClick={() => onSave(name.trim(), set)}>
            Save
          </Button>
        </>
      }
    >
      {nameEditable && (
        <input className={cn(inputClass, "mb-3")} placeholder="Playlist name" value={name} onChange={(e) => setName(e.target.value)} />
      )}
      <div className="mb-3 flex items-center gap-2 text-sm">
        Match
        <select className={selectClass} value={match} onChange={(e) => setMatch(e.target.value as "all" | "any")}>
          <option value="all">all</option>
          <option value="any">any</option>
        </select>
        of the following rules
      </div>
      <div className="space-y-2">
        {rules.map((r, i) => {
          const kind = fieldKind(r.field);
          const ops = opsFor(kind);
          const noValue = r.op === "empty" || r.op === "notEmpty";
          return (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <select
                className={cn(selectClass, "w-36")}
                value={r.field}
                onChange={(e) => {
                  const field = e.target.value as RuleField;
                  const allowed = opsFor(fieldKind(field));
                  patch(i, { field, op: allowed.includes(r.op) ? r.op : allowed[0], value: "", value2: undefined });
                }}
              >
                {FIELDS.map((f) => (
                  <option key={f.field} value={f.field}>
                    {f.label}
                  </option>
                ))}
              </select>
              <select className={cn(selectClass, "w-44")} value={r.op} onChange={(e) => patch(i, { op: e.target.value as RuleOp })}>
                {ops.map((o) => (
                  <option key={o} value={o}>
                    {OP_LABELS[o]}
                  </option>
                ))}
              </select>
              {!noValue && (
                <input
                  className={cn(inputClass, "w-40 flex-1")}
                  value={r.value}
                  placeholder={kind === "key" ? "e.g. 8A or Am" : kind === "date" && r.op !== "inLast" ? "YYYY-MM-DD" : ""}
                  onChange={(e) => patch(i, { value: e.target.value })}
                />
              )}
              {r.op === "between" && (
                <>
                  <span className="text-xs text-muted-foreground">and</span>
                  <input className={cn(inputClass, "w-24")} value={r.value2 ?? ""} onChange={(e) => patch(i, { value2: e.target.value })} />
                </>
              )}
              <button
                className="text-muted-foreground hover:text-destructive disabled:opacity-30"
                disabled={rules.length === 1}
                onClick={() => setRules((rs) => rs.filter((_, j) => j !== i))}
                aria-label="Remove rule"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          );
        })}
      </div>
      <Button variant="outline" size="sm" className="mt-3" onClick={() => setRules((rs) => [...rs, defaultRule()])}>
        <Plus /> Add rule
      </Button>
      {hits.length > 0 && (
        <div className="mt-4 rounded-md border bg-background/50 p-2 text-xs text-muted-foreground">
          {hits.slice(0, 6).map((t) => `${t.artist ? t.artist + " - " : ""}${t.title}`).join(" · ")}
          {hits.length > 6 && " …"}
        </div>
      )}
    </Modal>
  );
}

export type FacetTargets = { mtc: boolean; mixxx: boolean; rekordbox: boolean };

/**
 * "Create smart playlists from genres / albums / languages": one checkbox per
 * value, target programs, destination folder. Re-running updates what is
 * already there (the caller upserts by name).
 */
export function FacetExportDialog({
  tracks,
  mixxxAvailable,
  mixxxRunning,
  onRun,
  onCancel,
}: {
  tracks: DjTrack[];
  mixxxAvailable: boolean;
  mixxxRunning: boolean;
  onRun: (opts: { facet: PlaylistFacet; values: FacetValue[]; folder: string; targets: FacetTargets }) => void;
  onCancel: () => void;
}) {
  const [facet, setFacet] = useState<PlaylistFacet>("genre");
  const [folder, setFolder] = useState("MTC Genres");
  const [query, setQuery] = useState("");
  const [targets, setTargets] = useState<FacetTargets>({ mtc: true, mixxx: false, rekordbox: false });
  const all = useMemo(() => listFacetValues(tracks, facet), [tracks, facet]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? all.filter((v) => v.name.toLowerCase().includes(q)) : all;
  }, [all, query]);
  const chosen = all.filter((v) => picked.has(v.value));
  const toggle = (v: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(v)) n.delete(v);
      else n.add(v);
      return n;
    });
  const defaultFolder = { genre: "MTC Genres", album: "MTC Albums", language: "MTC Languages" } as const;
  const noTarget = !targets.mtc && !targets.mixxx && !targets.rekordbox;

  return (
    <Modal
      title="Create smart playlists from your library"
      icon={<Sparkles className="h-4 w-4" />}
      width={620}
      onClose={onCancel}
      footer={
        <>
          <span className="mr-auto text-xs text-muted-foreground">{chosen.length} selected</span>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!chosen.length || noTarget || !folder.trim()}
            onClick={() => onRun({ facet, values: chosen, folder: folder.trim(), targets })}
          >
            Create {chosen.length || ""} playlist{chosen.length === 1 ? "" : "s"}
          </Button>
        </>
      }
    >
      <div className="mb-3 flex gap-1">
        {(["genre", "album", "language"] as PlaylistFacet[]).map((f) => (
          <Button
            key={f}
            size="sm"
            variant={facet === f ? "default" : "outline"}
            onClick={() => {
              if (folder === defaultFolder[facet]) setFolder(defaultFolder[f]);
              setFacet(f);
              setPicked(new Set());
            }}
          >
            {f === "genre" ? "Genres" : f === "album" ? "Albums" : "Languages"}
          </Button>
        ))}
      </div>

      <div className="mb-2 flex items-center gap-2">
        <input className={inputClass} placeholder="Filter…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <Button variant="outline" size="sm" onClick={() => setPicked(new Set([...picked, ...shown.map((v) => v.value)]))}>
          All
        </Button>
        <Button variant="outline" size="sm" onClick={() => setPicked(new Set())}>
          None
        </Button>
      </div>
      <div className="flex h-56 flex-col rounded-md border bg-background/50">
        {shown.length === 0 ? (
          <p className="p-3 text-xs text-muted-foreground">Nothing to list. Index your library first (Settings).</p>
        ) : (
          <VirtualList
            count={shown.length}
            rowHeight={28}
            resetKey={facet + query}
            renderRow={(i) => {
              const v = shown[i];
              return (
                <label key={v.value} className="flex h-7 cursor-pointer items-center gap-2 px-2 text-sm hover:bg-accent">
                  <input type="checkbox" className="accent-[var(--primary)]" checked={picked.has(v.value)} onChange={() => toggle(v.value)} />
                  <span className="min-w-0 flex-1 truncate">{v.name}</span>
                  <span className="text-xs tabular-nums text-muted-foreground">{v.count}</span>
                </label>
              );
            }}
          />
        )}
      </div>

      <div className="mt-4 space-y-1.5 text-sm">
        <div className="text-xs font-medium text-muted-foreground">Create in</div>
        <label className="flex items-center gap-2">
          <input type="checkbox" className="accent-[var(--primary)]" checked={targets.mtc} onChange={(e) => setTargets({ ...targets, mtc: e.target.checked })} />
          Music Tag Cleaner (smart playlists, keep their rules)
        </label>
        <label className={cn("flex items-center gap-2", !mixxxAvailable && "opacity-50")}>
          <input
            type="checkbox"
            className="accent-[var(--primary)]"
            disabled={!mixxxAvailable}
            checked={targets.mixxx}
            onChange={(e) => setTargets({ ...targets, mixxx: e.target.checked })}
          />
          Mixxx (static crates named “[smart] …”, rebuilt each time)
          {mixxxRunning && <span className="text-xs text-amber-500">Mixxx is open: close it first</span>}
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" className="accent-[var(--primary)]" checked={targets.rekordbox} onChange={(e) => setTargets({ ...targets, rekordbox: e.target.checked })} />
          Rekordbox (a rekordbox.xml to import; playlists arrive as static lists)
        </label>
      </div>
      <div className="mt-3">
        <div className="mb-1 text-xs font-medium text-muted-foreground">Folder</div>
        <input className={inputClass} value={folder} onChange={(e) => setFolder(e.target.value)} />
        <p className="mt-1 text-[11px] text-muted-foreground">
          Running this again updates the playlists that already exist instead of adding duplicates. Mixxx has no
          folders, so its crates are just prefixed “[smart]”.
        </p>
      </div>
    </Modal>
  );
}
