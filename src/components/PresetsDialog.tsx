import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { confirm, open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  CheckCircle2,
  CircleSlash,
  FileMusic,
  FolderOpen,
  Loader2,
  ShieldCheck,
  Wand2,
  X,
  XCircle,
} from "lucide-react";
import { useVirtualRows } from "../hooks/useVirtualRows";
import {
  NEEDS_PRESETS_PLUGIN,
  SYNTH_LABEL,
  applyConfirmText,
  verifyProblem,
  type ApplyResult,
  type ConvertItem,
  type ScanItem,
  type VerifyItem,
} from "../lib/presets";
import { basename } from "../types";
import type { Notify } from "../hooks/useFiles";
import { Badge, Button, cn } from "./ui";

const PRESET_EXTENSIONS = ["fxp", "SerumPreset", "vital"];
const ROW_H = 32;

type Busy = null | "scan" | "convert" | "verify" | "apply";

/**
 * Synth preset translator dialog (opened by the `presets.open` action).
 *
 * Flow: pick files/folder -> scan list -> tick -> Convert -> status table with a
 * report drawer -> optional Verify -> Apply to an output folder. Converting only
 * stages files in the engine's temp area; nothing reaches a folder you chose
 * until Apply, which asks every time. Clicking a row selects it (shows its
 * report); the checkbox ticks it. No drag gestures anywhere.
 */
export function PresetsDialog({
  initialFolder,
  available,
  onClose,
  notify,
}: {
  initialFolder?: string;
  /** False when no enabled plugin requires the engine: show the install hint only. */
  available: boolean;
  onClose: () => void;
  notify: Notify;
}) {
  const [items, setItems] = useState<ScanItem[]>([]);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number; file: string } | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [converted, setConverted] = useState<Record<string, ConvertItem>>({});
  const [verified, setVerified] = useState<Record<string, VerifyItem>>({});
  const [applied, setApplied] = useState<ApplyResult | null>(null);
  const batchRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Progress is relayed from the engine by the Rust side. The batch id is only
  // known once convert returns, so every event is accepted while busy.
  useEffect(() => {
    const un = listen<{ batchId: string; done: number; total: number; file: string }>("presets-progress", (e) =>
      setProgress({ done: e.payload.done, total: e.payload.total, file: e.payload.file }),
    );
    return () => void un.then((f) => f());
  }, []);

  // Drop the staging folder when the dialog goes away.
  useEffect(
    () => () => {
      if (batchRef.current) void invoke("presets_discard", { batchId: batchRef.current }).catch(() => {});
    },
    [],
  );

  const run = async <T,>(kind: Exclude<Busy, null>, fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(kind);
    setError("");
    setProgress(null);
    try {
      return await fn();
    } catch (e) {
      setError(String(e));
      return undefined;
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  const discardBatch = () => {
    if (batchRef.current) void invoke("presets_discard", { batchId: batchRef.current }).catch(() => {});
    batchRef.current = null;
    setBatchId(null);
    setConverted({});
    setVerified({});
    setApplied(null);
  };

  const scan = async (paths: string[]) => {
    const out = await run("scan", () => invoke<ScanItem[]>("presets_scan", { paths }));
    if (!out) return;
    discardBatch();
    setItems(out);
    setSelected(null);
    setTicked(new Set(out.filter((i) => i.supported).map((i) => i.path)));
  };

  useEffect(() => {
    if (available && initialFolder) void scan([initialFolder]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickFiles = async () => {
    const p = await openDialog({
      multiple: true,
      title: "Choose preset files",
      filters: [{ name: "Synth presets", extensions: PRESET_EXTENSIONS }],
    });
    if (Array.isArray(p) && p.length) void scan(p);
  };
  const pickFolder = async () => {
    const p = await openDialog({ directory: true, multiple: false, title: "Choose a folder of presets" });
    if (typeof p === "string") void scan([p]);
  };

  const convertible = items.filter((i) => i.supported);
  const tickedConvertible = convertible.filter((i) => ticked.has(i.path));

  const convert = async () => {
    const paths = tickedConvertible.map((i) => i.path);
    if (!paths.length) return;
    discardBatch();
    const out = await run("convert", () =>
      invoke<{ batchId: string; items: ConvertItem[] }>("presets_convert", { paths }),
    );
    if (!out) return;
    batchRef.current = out.batchId;
    setBatchId(out.batchId);
    setConverted(Object.fromEntries(out.items.map((c) => [c.source, c])));
    const bad = out.items.filter((c) => c.status === "failed").length;
    notify(
      `Converted ${out.items.length - bad} of ${out.items.length} presets${bad ? ` (${bad} failed)` : ""}`,
      bad ? "info" : "success",
    );
  };

  const verify = async () => {
    if (!batchId) return;
    const out = await run("verify", () => invoke<VerifyItem[]>("presets_verify", { batchId }));
    if (out) setVerified(Object.fromEntries(out.map((v) => [v.file, v])));
  };

  const goodSources = items
    .filter((i) => ticked.has(i.path) && converted[i.path] && converted[i.path].status !== "failed")
    .map((i) => i.path);

  const apply = async () => {
    if (!batchId || !goodSources.length) return;
    const dir = await openDialog({ directory: true, multiple: false, title: "Write converted presets into..." });
    if (typeof dir !== "string") return;
    const ok = await confirm(applyConfirmText(dir, goodSources.length), { title: "Write presets", kind: "info" });
    if (!ok) return;
    const out = await run("apply", () =>
      invoke<ApplyResult>("presets_apply", { batchId, outputDir: dir, include: goodSources }),
    );
    if (out) {
      setApplied(out);
      notify(`Wrote ${out.written.length} preset${out.written.length === 1 ? "" : "s"} to ${dir}`, "success");
    }
  };

  // ---- list ------------------------------------------------------------------
  const virtual = useVirtualRows(scrollRef, items.length, { estimateRowHeight: ROW_H, enabled: items.length > 60 });
  const visible = useMemo(() => items.slice(virtual.start, virtual.end), [items, virtual.start, virtual.end]);
  const sel = selected ? items.find((i) => i.path === selected) : undefined;
  const selConv = sel ? converted[sel.path] : undefined;
  const selVerify = selConv?.output ? verified[selConv.output] : undefined;
  const hasConverted = batchId !== null;

  const toggle = (path: string) =>
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const allTicked = convertible.length > 0 && tickedConvertible.length === convertible.length;
  const toggleAll = () => setTicked(allTicked ? new Set() : new Set(convertible.map((i) => i.path)));

  const statusCell = (i: ScanItem) => {
    const c = converted[i.path];
    if (!c)
      return i.supported ? (
        <span className="text-muted-foreground">ready</span>
      ) : (
        <span className="flex items-center gap-1 text-muted-foreground" title={i.reason}>
          <CircleSlash className="h-3.5 w-3.5" /> not supported
        </span>
      );
    if (c.status === "ok")
      return (
        <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 className="h-3.5 w-3.5" /> exact
        </span>
      );
    if (c.status === "approx")
      return (
        <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
          <AlertTriangle className="h-3.5 w-3.5" /> approximate
        </span>
      );
    return (
      <span className="flex items-center gap-1 text-destructive" title={c.error}>
        <XCircle className="h-3.5 w-3.5" /> failed
      </span>
    );
  };
  const verifyCell = (i: ScanItem) => {
    const out = converted[i.path]?.output;
    const v = out ? verified[out] : undefined;
    if (!v) return null;
    const problem = verifyProblem(v);
    return problem ? (
      <Badge className="bg-destructive/15 text-destructive">{problem}</Badge>
    ) : (
      <Badge className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
        {v.peakDb !== undefined ? `${v.peakDb.toFixed(1)} dB` : "ok"}
      </Badge>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6">
      <div className="flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-xl border bg-card shadow-xl">
        <div className="flex items-center justify-between border-b px-5 py-3">
          <div className="flex items-center gap-2">
            <FileMusic className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-bold">Synth presets to Vital</h2>
          </div>
          <button
            onClick={onClose}
            disabled={busy !== null}
            aria-label="Close"
            className="text-muted-foreground hover:text-foreground disabled:opacity-30"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {!available ? (
          <div className="px-5 py-10 text-center text-sm">
            <p className="font-medium">{NEEDS_PRESETS_PLUGIN}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              The converter ships as a plugin plus a downloadable engine. Install and approve the plugin, then reopen
              this dialog.
            </p>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 border-b px-5 py-3">
              <Button variant="outline" size="sm" onClick={pickFiles} disabled={busy !== null}>
                <FileMusic className="h-3.5 w-3.5" /> Choose files
              </Button>
              <Button variant="outline" size="sm" onClick={pickFolder} disabled={busy !== null}>
                <FolderOpen className="h-3.5 w-3.5" /> Choose folder
              </Button>
              <span className="ml-auto text-xs text-muted-foreground">
                {items.length ? `${tickedConvertible.length} of ${convertible.length} ticked` : "Pick presets to scan"}
              </span>
            </div>

            {error && (
              <div className="flex items-start gap-2 border-b bg-destructive/10 px-5 py-2 text-xs text-destructive">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span className="select-text break-words">{error}</span>
              </div>
            )}

            <div className="flex min-h-0 flex-1">
              <div ref={scrollRef} className="min-h-[16rem] min-w-0 flex-1 overflow-auto">
                {items.length === 0 ? (
                  <div className="flex h-full items-center justify-center p-8 text-xs text-muted-foreground">
                    {busy === "scan" ? (
                      <span className="flex items-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin" /> Scanning...
                      </span>
                    ) : (
                      "Serum, Serum 2 and Vital presets are supported. Nothing is written until you press Apply."
                    )}
                  </div>
                ) : (
                  <table className="w-full table-fixed text-xs">
                    <thead className="sticky top-0 z-10 bg-card text-left text-muted-foreground">
                      <tr className="h-8">
                        <th className="w-9 pl-4">
                          <input
                            type="checkbox"
                            checked={allTicked}
                            onChange={toggleAll}
                            aria-label="Tick all"
                            disabled={busy !== null}
                          />
                        </th>
                        <th>Name</th>
                        <th className="w-24">Synth</th>
                        <th className="w-32">Status</th>
                        <th className="w-24">Verify</th>
                      </tr>
                    </thead>
                    <tbody>
                      {virtual.padTop > 0 && (
                        <tr aria-hidden>
                          <td colSpan={5} style={{ height: virtual.padTop, padding: 0, border: 0 }} />
                        </tr>
                      )}
                      {visible.map((i) => (
                        <tr
                          key={i.path}
                          data-path={i.path}
                          onClick={() => setSelected(i.path)}
                          style={{ height: ROW_H }}
                          className={cn("cursor-pointer border-t hover:bg-accent/40", selected === i.path && "bg-accent/60")}
                        >
                          <td className="pl-4" onClick={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={ticked.has(i.path)}
                              disabled={busy !== null || (!i.supported && !converted[i.path])}
                              onChange={() => toggle(i.path)}
                              aria-label={`Tick ${i.name}`}
                            />
                          </td>
                          <td className="truncate pr-2" title={i.path}>
                            {i.name || basename(i.path)}
                          </td>
                          <td>{SYNTH_LABEL[i.synth]}</td>
                          <td>{statusCell(i)}</td>
                          <td>{verifyCell(i)}</td>
                        </tr>
                      ))}
                      {virtual.padBottom > 0 && (
                        <tr aria-hidden>
                          <td colSpan={5} style={{ height: virtual.padBottom, padding: 0, border: 0 }} />
                        </tr>
                      )}
                    </tbody>
                  </table>
                )}
              </div>

              {sel && (
                <aside className="w-72 shrink-0 space-y-3 overflow-y-auto border-l px-4 py-3 text-xs">
                  <div>
                    <div className="select-text break-words text-sm font-semibold">{sel.name || basename(sel.path)}</div>
                    <div className="select-text break-all text-muted-foreground">{sel.path}</div>
                  </div>
                  {!sel.supported && (
                    <p className="text-muted-foreground">{sel.reason ?? "This preset cannot be converted."}</p>
                  )}
                  {selConv?.status === "failed" && (
                    <p className="select-text text-destructive">{selConv.error ?? "Conversion failed"}</p>
                  )}
                  {selConv && selConv.status !== "failed" && (
                    <div className="space-y-2">
                      <div>
                        <span className="font-semibold">{selConv.report.exact}</span> parameter
                        {selConv.report.exact === 1 ? "" : "s"} exact
                      </div>
                      <ReportList
                        title="Approximated"
                        tone="text-amber-600 dark:text-amber-400"
                        rows={selConv.report.approximated}
                      />
                      <ReportList title="Dropped" tone="text-destructive" rows={selConv.report.dropped} />
                    </div>
                  )}
                  {selVerify && (
                    <div className="space-y-0.5">
                      <div className="font-semibold">Verify</div>
                      <div>{verifyProblem(selVerify) ?? "Loads and makes sound"}</div>
                      {selVerify.peakDb !== undefined && (
                        <div className="text-muted-foreground">
                          peak {selVerify.peakDb.toFixed(1)} dB, rms {selVerify.rmsDb?.toFixed(1) ?? "?"} dB
                        </div>
                      )}
                    </div>
                  )}
                </aside>
              )}
            </div>

            {applied && (
              <div className="select-text border-t px-5 py-2 text-xs">
                Wrote {applied.written.length}
                {applied.skipped.length > 0 &&
                  `, skipped ${applied.skipped.length}: ${applied.skipped
                    .map((s) => `${basename(s.source)} (${s.reason})`)
                    .join("; ")}`}
              </div>
            )}

            <div className="flex items-center gap-2 border-t px-5 py-3">
              <div className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {busy && progress
                  ? `${progress.done} / ${progress.total} - ${basename(progress.file)}`
                  : busy
                    ? "Working..."
                    : hasConverted
                      ? "Staged only - nothing is written until Apply"
                      : ""}
              </div>
              <Button variant="outline" onClick={verify} disabled={!hasConverted || busy !== null}>
                {busy === "verify" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}{" "}
                Verify
              </Button>
              <Button variant="outline" onClick={convert} disabled={tickedConvertible.length === 0 || busy !== null}>
                {busy === "convert" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}{" "}
                Convert {tickedConvertible.length || ""}
              </Button>
              <Button onClick={apply} disabled={!hasConverted || goodSources.length === 0 || busy !== null}>
                {busy === "apply" && <Loader2 className="h-4 w-4 animate-spin" />} Apply {goodSources.length || ""}...
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ReportList({ title, tone, rows }: { title: string; tone: string; rows: { field: string; note: string }[] }) {
  if (!rows.length) return null;
  return (
    <div>
      <div className={cn("font-semibold", tone)}>
        {title} ({rows.length})
      </div>
      <ul className="mt-0.5 space-y-0.5">
        {rows.map((r, n) => (
          <li key={n} className="select-text break-words">
            <span className="font-mono">{r.field}</span>
            {r.note ? <span className="text-muted-foreground"> - {r.note}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
