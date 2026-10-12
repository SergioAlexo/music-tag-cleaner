import { useCallback, useEffect, useMemo, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, ArrowLeftRight, Loader2, RefreshCw, X } from "lucide-react";
import { Button, Card, cn, selectClass } from "./ui";
import { VirtualList } from "./VirtualList";
import type { Notify } from "../hooks/useFiles";
import type { Settings } from "../types";
import {
  describeValue,
  finalize,
  GROUP_LABEL,
  listDetail,
  noSelection,
  summarize,
  SYNC_GROUPS,
  type Dir,
  type Side,
  type SyncGroup,
  type SyncSettings,
} from "../lib/djSync";
import {
  applyPlan,
  describeReport,
  normalizeSettings,
  planFromRaw,
  readRaw,
  wantsXml,
  type RawSync,
} from "../lib/djSyncRun";
import { invoke } from "@tauri-apps/api/core";

const DIR_LABEL: Record<Dir, string> = {
  off: "Off",
  rb2mx: "Rekordbox → Mixxx",
  mx2rb: "Mixxx → Rekordbox",
  both: "Both ways",
};

interface Props {
  settings: Settings;
  savePatch: (p: Partial<Settings>) => void;
  notify: Notify;
  onClose: () => void;
}

export function DjSyncDialog({ settings, savePatch, notify, onClose }: Props) {
  const [raw, setRaw] = useState<RawSync | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [skipGroups, setSkipGroups] = useState<Set<SyncGroup>>(new Set());
  const [skipIds, setSkipIds] = useState<Set<string>>(new Set());
  const [picks, setPicks] = useState<Record<string, Side | "skip">>({});
  const [open, setOpen] = useState<SyncGroup | "conflicts" | null>(null);
  const [running, setRunning] = useState<{ mixxx: boolean; rekordbox: boolean }>({ mixxx: false, rekordbox: false });
  const sync = useMemo(() => normalizeSettings(settings.djSync), [settings.djSync]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await readRaw();
      setRaw(r);
      setRunning({ mixxx: r.mx.snapshot.running, rekordbox: r.rb.snapshot.running });
      setSkipGroups(new Set());
      setSkipIds(new Set());
      setPicks({});
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => void load(), [load]);

  const loaded = useMemo(() => (raw ? planFromRaw(raw, sync) : null), [raw, sync]);
  const plan = loaded?.plan ?? null;
  const summary = useMemo(() => (plan ? summarize(plan) : []), [plan]);
  const sel = useMemo(() => ({ ...noSelection(), skipGroups, skipIds, picks }), [skipGroups, skipIds, picks]);
  const out = useMemo(() => (plan ? finalize(plan, sel, sync.relocate) : null), [plan, sel, sync.relocate]);

  const setSync = (patch: Partial<SyncSettings>) => savePatch({ djSync: { ...sync, ...patch } });
  const setDir = (g: SyncGroup, d: Dir) => setSync({ dirs: { ...sync.dirs, [g]: d } });
  const toggle = <T,>(set: Set<T>, v: T) => {
    const n = new Set(set);
    if (n.has(v)) n.delete(v);
    else n.add(v);
    return n;
  };

  const pendingConflicts = plan ? plan.conflicts.filter((c) => !picks[c.id] || picks[c.id] === "skip").length : 0;
  const nothing = !!out && !out.mixxxOps.length && !out.mixxxMeta.length && !out.relocations.length && !wantsXml(out);

  const apply = async () => {
    if (!loaded || !out) return;
    setApplying(true);
    try {
      let xmlDest: string | null = null;
      if (wantsXml(out)) {
        xmlDest = await saveDialog({
          title: "Save rekordbox.xml for Rekordbox",
          defaultPath: `mixxx-to-rekordbox-${new Date().toISOString().slice(0, 10)}.xml`,
          filters: [{ name: "Rekordbox XML", extensions: ["xml"] }],
        });
        if (!xmlDest) {
          setApplying(false);
          return; // cancelled: nothing was written
        }
      }
      const r = await applyPlan(loaded, sel, xmlDest);
      notify(`Sync done. ${describeReport(r)}`, "success");
      await load();
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setApplying(false);
    }
  };

  const resetHistory = async () => {
    await invoke("dj_sync_state_reset");
    notify("Sync history cleared. The next sync compares both libraries from scratch (it never deletes on a first sync).", "info");
    await load();
  };

  const listRows = plan ? plan.lists : [];
  const metaRows = (g: SyncGroup) => (plan ? plan.meta.filter((m) => m.field === g) : []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <Card className="flex max-h-[90vh] w-[860px] max-w-full flex-col overflow-hidden">
        <div className="flex items-center justify-between gap-4 border-b px-5 py-3.5">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <ArrowLeftRight className="h-4 w-4" /> Sync Rekordbox ⇄ Mixxx
          </h2>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => void load()} disabled={loading || applying} title="Read both libraries again">
              <RefreshCw className={cn(loading && "animate-spin")} /> Refresh
            </Button>
            <button className="text-muted-foreground hover:text-foreground" onClick={onClose} aria-label="Close">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4 text-sm">
          <p className="text-xs text-muted-foreground">
            Rekordbox is never written to. Changes for Mixxx are applied directly (Mixxx must be closed; its database is backed up
            first). Changes for Rekordbox are saved as a <b>rekordbox.xml</b> that you import in Rekordbox yourself, and they keep
            showing here until Rekordbox has them. Beat grids and cues are not synced.
          </p>

          {loading && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Reading both libraries…
            </div>
          )}
          {error && <div className="rounded-md border border-destructive/40 p-3 text-destructive">{error}</div>}

          {raw && plan && (
            <>
              {(running.mixxx || running.rekordbox) && (
                <div className="flex items-start gap-2 rounded-md border border-amber-500/40 p-3 text-xs text-amber-500">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    {running.mixxx && "Mixxx is open: you can preview, but Applying changes to Mixxx is disabled until you close it. "}
                    {running.rekordbox && "Rekordbox is open: what is shown is what it last saved to disk."}
                  </span>
                </div>
              )}
              {plan.firstSync && (
                <div className="rounded-md border p-3 text-xs text-muted-foreground">
                  First sync (no history yet). Nothing is deleted. Lists that exist on only one side are copied across; where both sides
                  have a value and there is no history, the master ({sync.master === "rekordbox" ? "Rekordbox" : "Mixxx"}) wins and blanks
                  are filled from the other side.
                </div>
              )}
              {loaded && (loaded.rb.skipped.length > 0 || plan.onlyOneSide > 0 || plan.gridLocked > 0) && (
                <div className="text-xs text-muted-foreground">
                  {plan.onlyOneSide > 0 && <span>{plan.onlyOneSide} tracks are in only one library (their metadata is not compared). </span>}
                  {plan.gridLocked > 0 && <span>{plan.gridLocked} BPMs are owned by a Mixxx beat grid and left alone. </span>}
                  {loaded.rb.skipped.length > 0 && <span>{loaded.rb.skipped.length} Rekordbox smart playlists use rules that can’t be evaluated here and are skipped. </span>}
                </div>
              )}

              <div className="rounded-md border">
                <div className="grid grid-cols-[1.2fr_1.2fr_70px_70px_70px] items-center gap-2 border-b bg-muted/30 px-3 py-2 text-xs font-medium text-muted-foreground">
                  <span>Item</span>
                  <span>Direction</span>
                  <span className="text-right">→ Mixxx</span>
                  <span className="text-right">→ Rekordbox</span>
                  <span className="text-right">Conflicts</span>
                </div>
                {SYNC_GROUPS.map((g) => {
                  const row = summary.find((s) => s.group === g);
                  const off = sync.dirs[g] === "off";
                  return (
                    <div key={g} className="border-b last:border-0">
                      <div className="grid grid-cols-[1.2fr_1.2fr_70px_70px_70px] items-center gap-2 px-3 py-1.5">
                        <label className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            disabled={off}
                            checked={!off && !skipGroups.has(g)}
                            onChange={() => setSkipGroups((s) => toggle(s, g))}
                            title="Include in this run"
                          />
                          <button className={cn("text-left", row && "underline decoration-dotted")} onClick={() => row && setOpen(open === g ? null : g)}>
                            {GROUP_LABEL[g]}
                          </button>
                        </label>
                        <select className={cn(selectClass, "h-7")} value={sync.dirs[g]} onChange={(e) => setDir(g, e.target.value as Dir)}>
                          {(Object.keys(DIR_LABEL) as Dir[]).map((d) => (
                            <option key={d} value={d}>{DIR_LABEL[d]}</option>
                          ))}
                        </select>
                        <span className="text-right tabular-nums">{off ? "" : row?.toMixxx ?? 0}</span>
                        <span className="text-right tabular-nums">{off ? "" : row?.toRekordbox ?? 0}</span>
                        <span className={cn("text-right tabular-nums", !!row?.conflicts && "text-amber-500")}>{off ? "" : row?.conflicts ?? 0}</span>
                      </div>
                      {open === g && (
                        <div className="border-t bg-muted/20 px-3 py-2">
                          {g === "playlists" ? (
                            <VirtualList
                              count={listRows.length}
                              rowHeight={26}
                              className="max-h-56"
                              renderRow={(i) => {
                                const e = listRows[i];
                                return (
                                  <label key={e.id} className="flex h-[26px] items-center gap-2 text-xs">
                                    <input type="checkbox" checked={!skipIds.has(e.id)} onChange={() => setSkipIds((s) => toggle(s, e.id))} />
                                    <span className="w-24 shrink-0 text-muted-foreground">
                                      {e.action} → {e.target === "mixxx" ? "Mixxx" : "Rekordbox"}
                                    </span>
                                    <span className="truncate">{e.name}</span>
                                    <span className="ml-auto shrink-0 text-muted-foreground">{listDetail(e)}</span>
                                  </label>
                                );
                              }}
                            />
                          ) : (
                            <VirtualList
                              count={metaRows(g).length}
                              rowHeight={22}
                              className="max-h-56"
                              renderRow={(i) => {
                                const m = metaRows(g)[i];
                                const t = loaded!.rb.info[m.key] ?? loaded!.mx.info[m.key];
                                return (
                                  <div key={`${m.key}`} className="flex h-[22px] items-center gap-2 text-xs">
                                    <span className="truncate">{t ? `${t.artist ? t.artist + " - " : ""}${t.title}` : m.key}</span>
                                    <span className="ml-auto shrink-0 text-muted-foreground">
                                      {describeValue(m.field, m.from)} → {describeValue(m.field, m.to)} ({m.target === "mixxx" ? "Mixxx" : "Rekordbox"}
                                      {m.auto ? `, ${m.auto}` : ""})
                                    </span>
                                  </div>
                                );
                              }}
                            />
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {plan.conflicts.length > 0 && (
                <div className="rounded-md border">
                  <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-3 py-2 text-xs">
                    <span className="font-medium">
                      {plan.conflicts.length} conflicts (both sides changed since the last sync) — {pendingConflicts} undecided, left alone
                    </span>
                    <span className="ml-auto flex gap-1">
                      <Button size="sm" variant="outline" onClick={() => setPicks(Object.fromEntries(plan.conflicts.map((c) => [c.id, "rekordbox" as const])))}>Rekordbox wins all</Button>
                      <Button size="sm" variant="outline" onClick={() => setPicks(Object.fromEntries(plan.conflicts.map((c) => [c.id, "mixxx" as const])))}>Mixxx wins all</Button>
                      <Button size="sm" variant="ghost" onClick={() => setPicks({})}>Clear</Button>
                    </span>
                  </div>
                  <VirtualList
                    count={plan.conflicts.length}
                    rowHeight={30}
                    className="max-h-52"
                    renderRow={(i) => {
                      const c = plan.conflicts[i];
                      const v = picks[c.id] ?? "skip";
                      return (
                        <div key={c.id} className="flex h-[30px] items-center gap-3 px-3 text-xs">
                          <span className="w-40 shrink-0 truncate" title={c.label}>{GROUP_LABEL[c.group]}: {c.label}</span>
                          {(["rekordbox", "mixxx", "skip"] as const).map((s) => (
                            <label key={s} className="flex items-center gap-1">
                              <input type="radio" checked={v === s} onChange={() => setPicks((p) => ({ ...p, [c.id]: s }))} />
                              {s === "skip" ? "Leave" : s === "rekordbox" ? `Rekordbox: ${c.rekordbox}` : `Mixxx: ${c.mixxx}`}
                            </label>
                          ))}
                        </div>
                      );
                    }}
                  />
                </div>
              )}

              <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
                <label className="flex items-center justify-between gap-2">
                  Playlists in Mixxx become
                  <select className={cn(selectClass, "h-7 w-40")} value={sync.mixxxTarget} onChange={(e) => setSync({ mixxxTarget: e.target.value as SyncSettings["mixxxTarget"] })}>
                    <option value="playlist">Playlists (ordered)</option>
                    <option value="crate">Crates (unordered)</option>
                  </select>
                </label>
                <label className="flex items-center justify-between gap-2">
                  Master when both differ with no history
                  <select className={cn(selectClass, "h-7 w-40")} value={sync.master} onChange={(e) => setSync({ master: e.target.value as Side })}>
                    <option value="rekordbox">Rekordbox</option>
                    <option value="mixxx">Mixxx</option>
                  </select>
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={sync.relocate} onChange={(e) => setSync({ relocate: e.target.checked })} />
                  Point Mixxx at files moved by “Move to collection” ({out?.counts.relocations ?? 0} now)
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={sync.onStart} onChange={(e) => setSync({ onStart: e.target.checked })} />
                  Check for changes when the app starts (never applies by itself)
                </label>
              </div>
            </>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t px-5 py-3">
          <Button size="sm" variant="ghost" onClick={() => void resetHistory()} disabled={applying || loading} title="Forget what was last synced">
            Forget sync history
          </Button>
          <div className="flex items-center gap-3">
            {out && !nothing && (
              <span className="text-xs text-muted-foreground">
                Mixxx: {out.counts.mixxxLists} lists, {out.counts.mixxxTracks} tracks · Rekordbox xml: {out.counts.rekordboxLists} lists, {out.counts.rekordboxTracks} tracks
              </span>
            )}
            <Button variant="outline" onClick={onClose}>Close</Button>
            <Button onClick={() => void apply()} disabled={loading || applying || nothing || (running.mixxx && !!out && (out.mixxxOps.length > 0 || out.mixxxMeta.length > 0 || out.relocations.length > 0))}>
              {applying ? <Loader2 className="animate-spin" /> : null} Apply
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
