import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirm, open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  ArrowLeftRight,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Copy,
  Disc3,
  FilePlus2,
  Folder,
  FolderOpen,
  FolderPlus,
  ListMusic,
  ListPlus,
  Loader2,
  Package,
  Pencil,
  PlayCircle,
  RefreshCw,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import type { Notify } from "../hooks/useFiles";
import type { KeyNotation, Settings } from "../types";
import { DjSyncDialog } from "../components/DjSyncDialog";
import { Button, Card, Badge, cn, inputClass } from "../components/ui";
import { VirtualList } from "../components/VirtualList";
import {
  FacetExportDialog,
  NameDialog,
  RuleEditorDialog,
  UnmatchedDialog,
  type FacetTargets,
} from "../components/PlaylistDialogs";
import {
  SOURCE_LABEL,
  buildRekordboxTreeXml,
  flattenForCopy,
  flattenTree,
  mapPaths,
  movePaths,
  pathKey,
  planFacetPlaylists,
  removeIndexes,
  rulesToJson,
  tracksOfNode,
  uniqueName,
  xmlTreeForNode,
  type DjNode,
  type DjOp,
  type DjSnapshot,
  type DjSource,
  type DjTrack,
  type FacetValue,
  type OpResult,
  type PlaylistFacet,
} from "../lib/djPlaylists";
import { describeRuleSet, evaluateRuleSet, type RuleSet } from "../lib/smartRules";
import { formatKey } from "../lib/keys";

interface DjStatus {
  rekordboxPath: string | null;
  rekordboxRunning: boolean;
  mixxxPath: string | null;
  mixxxRunning: boolean;
}

interface Props {
  notify: Notify;
  keyNotation: KeyNotation;
  settings: Settings;
  savePatch: (p: Partial<Settings>) => void;
  /** Opens `paths` (library paths) in a new Library session tab and switches to it. */
  onLoadSession: (paths: string[], title: string) => void;
}

const TABS: DjSource[] = ["rekordbox", "mixxx", "mtc"];
const ROW_H = 28;

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function lsSet(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the override just doesn't persist */
  }
}

function NodeIcon({ node, open }: { node: DjNode; open?: boolean }) {
  const cls = "h-4 w-4 shrink-0";
  switch (node.kind) {
    case "folder":
      return open ? <FolderOpen className={cn(cls, "text-amber-500")} /> : <Folder className={cn(cls, "text-amber-500")} />;
    case "smart":
      return <Sparkles className={cn(cls, "text-violet")} />;
    case "crate":
      return <Package className={cn(cls, "text-sky-500")} />;
    default:
      return <ListMusic className={cn(cls, "text-muted-foreground")} />;
  }
}

type Dialog =
  | { kind: "name"; title: string; label?: string; initial: string; confirmLabel?: string; onSubmit: (n: string) => void }
  | { kind: "rules"; title: string; initialName: string; rules: RuleSet | null; nameEditable: boolean; onSave: (n: string, r: RuleSet) => void }
  | { kind: "unmatched"; title: string; intro: string; paths: string[] }
  | { kind: "facets" }
  | { kind: "add" };

export function PlaylistsPage({ notify, keyNotation, settings, savePatch, onLoadSession }: Props) {
  const [syncOpen, setSyncOpen] = useState(false);
  const [source, setSource] = useState<DjSource>(() => (lsGet("playlists.source") as DjSource) || "mtc");
  const [snaps, setSnaps] = useState<Partial<Record<DjSource, DjSnapshot>>>({});
  const [loading, setLoading] = useState<DjSource | null>(null);
  const [loadError, setLoadError] = useState<Partial<Record<DjSource, string>>>({});
  const [status, setStatus] = useState<DjStatus | null>(null);
  const [selected, setSelected] = useState<Partial<Record<DjSource, string>>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [rowSel, setRowSel] = useState<number[]>([]);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [busy, setBusy] = useState(false);
  const mixxxConfirmed = useRef(false);

  const snap = snaps[source];
  const selId = selected[source] ?? null;
  const node = snap?.nodes.find((n) => n.id === selId) ?? null;

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(
        await invoke<DjStatus>("dj_status", {
          rekordboxPath: lsGet("playlists.path.rekordbox") ?? undefined,
          mixxxPath: lsGet("playlists.path.mixxx") ?? undefined,
        }),
      );
    } catch {
      /* status is advisory */
    }
  }, []);

  const load = useCallback(
    async (s: DjSource): Promise<DjSnapshot | null> => {
      setLoading(s);
      setLoadError((e) => ({ ...e, [s]: undefined }));
      try {
        const next = await invoke<DjSnapshot>("dj_load", { source: s, dbPath: lsGet(`playlists.path.${s}`) ?? undefined });
        setSnaps((p) => ({ ...p, [s]: next }));
        return next;
      } catch (e) {
        setLoadError((p) => ({ ...p, [s]: String(e) }));
        return null;
      } finally {
        setLoading((l) => (l === s ? null : l));
      }
    },
    [],
  );

  // Load the visible tab once; the others load when first opened (reading
  // Rekordbox means decrypting a 50 MB file, which isn't free).
  useEffect(() => {
    lsSet("playlists.source", source);
    if (!snaps[source] && loading !== source && !loadError[source]) void load(source);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);
  useEffect(() => {
    void refreshStatus();
    const onFocus = () => void refreshStatus();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshStatus]);
  useEffect(() => {
    setRowSel([]);
    setAnchor(null);
  }, [source, selId]);

  /** The Music Tag Cleaner snapshot doubles as "the library": mapping target for load-as-session and copies. */
  const mtc = snaps.mtc;
  const libraryKeys = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of mtc?.tracks ?? []) m.set(pathKey(t.path), t.path);
    return m;
  }, [mtc]);

  const ensureMtc = async (): Promise<DjSnapshot | null> => mtc ?? (await load("mtc"));

  const flat = useMemo(() => (snap ? flattenTree(snap.nodes, expanded, filter) : []), [snap, expanded, filter]);
  const content = useMemo(() => (snap && node ? tracksOfNode(snap, node) : null), [snap, node]);
  const tracks = content?.tracks ?? [];
  const notInLibrary = useMemo(
    () => (source === "mtc" ? [] : tracks.filter((t) => !libraryKeys.has(pathKey(t.path)))),
    [tracks, libraryKeys, source],
  );
  const notIndexedMtc = useMemo(
    () => (source === "mtc" ? tracks.filter((t) => !libraryKeys.has(pathKey(t.path))) : []),
    [tracks, libraryKeys, source],
  );

  const writable = source === "mtc" || (source === "mixxx" && !status?.mixxxRunning);
  const isStatic = !!node && (node.kind === "playlist" || node.kind === "crate");
  const canEditTracks = writable && isStatic;

  // --- writes -------------------------------------------------------------

  const apply = async (target: "mtc" | "mixxx", ops: DjOp[]): Promise<OpResult[] | null> => {
    if (target === "mixxx" && !mixxxConfirmed.current) {
      const ok = await confirm(
        "Mixxx must be closed while its library is changed. A backup copy of mixxxdb.sqlite is made next to it first, and all changes are applied in one step.",
        { title: "Change Mixxx's library", kind: "warning" },
      );
      if (!ok) return null;
      mixxxConfirmed.current = true;
    }
    try {
      const res = await invoke<OpResult[]>("dj_apply", { source: target, ops, dbPath: lsGet(`playlists.path.${target}`) ?? undefined });
      return res;
    } catch (e) {
      notify(String(e), "error");
      void refreshStatus();
      return null;
    }
  };

  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    if (busy) return undefined;
    setBusy(true);
    try {
      return await fn();
    } finally {
      setBusy(false);
    }
  };

  const reportUnmatched = (title: string, intro: string, paths: string[]) => {
    if (paths.length) setDialog({ kind: "unmatched", title, intro, paths });
  };

  const pathsOf = (n: DjNode) => (snap ? tracksOfNode(snap, n).tracks.map((t) => t.path) : []);

  const writeTracks = async (paths: string[], keepSelection?: number[]) => {
    if (!node) return;
    await run(async () => {
      const res = await apply(source as "mtc" | "mixxx", [{ op: "setTracks", id: node.id, paths }]);
      if (!res) return;
      await load(source);
      if (keepSelection) setRowSel(keepSelection);
    });
  };

  const removeSelected = async () => {
    if (!canEditTracks || !rowSel.length) return;
    await writeTracks(removeIndexes(pathsOf(node!), rowSel));
    setRowSel([]);
  };
  const moveSelected = async (delta: -1 | 1) => {
    if (!canEditTracks || !rowSel.length) return;
    const r = movePaths(pathsOf(node!), rowSel, delta);
    if (r.paths.join("\n") === pathsOf(node!).join("\n")) return;
    await writeTracks(r.paths, r.indexes);
  };

  const createPlain = (kind: "folder" | "playlist" | "crate") => {
    const target = source as "mtc" | "mixxx";
    const label = kind === "folder" ? "New folder" : kind === "crate" ? "New crate" : "New playlist";
    setDialog({
      kind: "name",
      title: label,
      initial: "",
      confirmLabel: "Create",
      onSubmit: (name) => {
        setDialog(null);
        void run(async () => {
          const parentId = target === "mtc" && node ? (node.kind === "folder" ? node.id : node.parentId) : null;
          const res = await apply(target, [{ op: "create", parentId, name, kind, paths: [] }]);
          if (!res) return;
          await load(target);
          if (res[0]?.id) setSelected((s) => ({ ...s, [target]: res[0].id! }));
          if (parentId) setExpanded((e) => new Set(e).add(parentId));
        });
      },
    });
  };

  const newSmart = async () => {
    const lib = await ensureMtc();
    if (!lib) return;
    setDialog({
      kind: "rules",
      title: "New smart playlist",
      initialName: "",
      rules: null,
      nameEditable: true,
      onSave: (name, rules) => {
        setDialog(null);
        void run(async () => {
          const paths = evaluateRuleSet(rules, lib.tracks).map((t) => t.path);
          const parentId = source === "mtc" && node ? (node.kind === "folder" ? node.id : node.parentId) : null;
          const res = await apply("mtc", [{ op: "create", parentId, name, kind: "smart", paths, rulesJson: rulesToJson(rules) }]);
          if (!res) return;
          setSource("mtc");
          await load("mtc");
          if (res[0]?.id) setSelected((s) => ({ ...s, mtc: res[0].id! }));
        });
      },
    });
  };

  const editRules = () => {
    if (!node || source !== "mtc" || !snap) return;
    const rules = content?.rules ?? null;
    setDialog({
      kind: "rules",
      title: `Rules: ${node.name}`,
      initialName: node.name,
      rules,
      nameEditable: true,
      onSave: (name, next) => {
        setDialog(null);
        void run(async () => {
          const ops: DjOp[] = [
            { op: "setRules", id: node.id, rulesJson: rulesToJson(next) },
            { op: "setTracks", id: node.id, paths: evaluateRuleSet(next, snap.tracks).map((t) => t.path) },
          ];
          if (name !== node.name) ops.push({ op: "rename", id: node.id, name });
          if (await apply("mtc", ops)) await load("mtc");
        });
      },
    });
  };

  /** Re-evaluates an MTC smart playlist against the current index. */
  const refreshSmart = async () => {
    if (!node || source !== "mtc" || !snap || !content?.rules) return;
    await run(async () => {
      const paths = evaluateRuleSet(content.rules!, snap.tracks).map((t) => t.path);
      if (await apply("mtc", [{ op: "setTracks", id: node.id, paths }])) {
        await load("mtc");
        notify(`“${node.name}” now has ${paths.length} track${paths.length === 1 ? "" : "s"}`, "success");
      }
    });
  };

  const renameNode = () => {
    if (!node || !writable) return;
    setDialog({
      kind: "name",
      title: "Rename",
      initial: node.name.replace(/^\[smart\] /, ""),
      confirmLabel: "Rename",
      onSubmit: (name) => {
        setDialog(null);
        void run(async () => {
          const final = source === "mixxx" && node.kind === "smart" && !name.startsWith("[smart] ") ? `[smart] ${name}` : name;
          if (await apply(source as "mtc" | "mixxx", [{ op: "rename", id: node.id, name: final }])) await load(source);
        });
      },
    });
  };

  const deleteNode = async () => {
    if (!node || !writable) return;
    const extra = node.kind === "folder" ? " and everything inside it" : "";
    const ok = await confirm(`Delete “${node.name}”${extra}? The tracks themselves are not touched.`, {
      title: "Delete",
      kind: "warning",
    });
    if (!ok) return;
    await run(async () => {
      if (await apply(source as "mtc" | "mixxx", [{ op: "delete", id: node.id }])) {
        setSelected((s) => ({ ...s, [source]: undefined }));
        await load(source);
      }
    });
  };

  // --- copy / duplicate / export -----------------------------------------

  /** Copies `node` (with children) into MTC or Mixxx. Returns unmatched paths. */
  const copyInto = async (target: "mtc" | "mixxx", asCrate = false, nameSuffix = ""): Promise<{ made: number; unmatched: string[]; skipped: string[] } | null> => {
    if (!snap || !node) return null;
    const lib = target === "mtc" ? await ensureMtc() : null;
    const items = flattenForCopy(snap, node);
    const ids: (string | null)[] = [];
    const unmatched: string[] = [];
    const skipped: string[] = [];
    let made = 0;
    const takenRoot = new Set((snaps[target]?.nodes ?? []).filter((n) => n.parentId === null).map((n) => n.name));
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.skipped) {
        skipped.push(`${it.name}: ${it.skipped}`);
        ids.push(null);
        continue;
      }
      if (target === "mixxx" && it.kind === "folder") {
        ids.push(null);
        continue; // Mixxx has no folders: children land at the top level
      }
      // MTC keeps paths exactly as the index spells them, so Load as session works later.
      const paths =
        target === "mtc"
          ? it.paths.map((p) => libraryKeys.get(pathKey(p)) ?? p)
          : it.paths;
      if (target === "mtc") for (const p of it.paths) if (!libraryKeys.has(pathKey(p))) unmatched.push(p);
      const parent = it.parent === null ? (target === "mtc" ? (node.parentId && source === "mtc" ? node.parentId : null) : null) : ids[it.parent];
      const siblings =
        target === "mtc" && it.parent === null
          ? new Set((snaps.mtc?.nodes ?? []).filter((n) => n.parentId === parent).map((n) => n.name))
          : it.parent === null
            ? takenRoot
            : new Set<string>();
      const base = it.parent === null ? it.name + nameSuffix : it.name;
      const name = it.parent === null ? uniqueName(base, siblings) : base;
      const kind = target === "mixxx" ? (it.kind === "smart" ? "smart" : asCrate ? "crate" : "playlist") : it.kind;
      const res = await apply(target, [
        {
          op: "create",
          parentId: parent,
          name,
          kind,
          paths,
          rulesJson: target === "mtc" && it.kind === "smart" && it.rules ? rulesToJson(it.rules) : null,
        },
      ]);
      if (!res) return null;
      ids.push(res[0]?.id ?? null);
      made++;
      if (target === "mixxx") unmatched.push(...res[0].unmatched);
    }
    void lib;
    await load(target);
    return { made, unmatched: [...new Set(unmatched)], skipped };
  };

  const finishCopy = (label: string, r: { made: number; unmatched: string[]; skipped: string[] } | null) => {
    if (!r) return;
    const parts = [`${r.made} list${r.made === 1 ? "" : "s"} created in ${label}`];
    if (r.unmatched.length) parts.push(`${r.unmatched.length} track${r.unmatched.length === 1 ? "" : "s"} not found there`);
    if (r.skipped.length) parts.push(`${r.skipped.length} skipped`);
    notify(parts.join(", "), r.unmatched.length || r.skipped.length ? "info" : "success");
    const lines = [...r.skipped.map((s) => `(skipped) ${s}`), ...r.unmatched];
    reportUnmatched(
      "Some tracks didn't carry over",
      `These weren't found in ${label}'s library (matched by file path), so they are missing from the copy. Nothing was dropped silently.`,
      lines,
    );
  };

  const copyTo = (target: "mtc" | "mixxx" | "mixxx-crate") => {
    void run(async () => {
      const t = target === "mtc" ? "mtc" : "mixxx";
      const r = await copyInto(t, target === "mixxx-crate");
      finishCopy(t === "mtc" ? "Music Tag Cleaner" : "Mixxx", r);
    });
  };

  const duplicate = () => {
    if (!node || source === "rekordbox" || !writable) return;
    void run(async () => {
      const r = await copyInto(source as "mtc" | "mixxx", node.kind === "crate", " copy");
      finishCopy(SOURCE_LABEL[source], r);
    });
  };

  const exportXml = async () => {
    if (!snap || !node) return;
    const tree = xmlTreeForNode(snap, node);
    if (!tree) return;
    const dest = await saveDialog({
      title: "Save rekordbox.xml",
      defaultPath: `${node.name.replace(/[\\/:*?"<>|]+/g, "-")}.xml`,
      filters: [{ name: "Rekordbox XML", extensions: ["xml"] }],
    });
    if (!dest) return;
    await run(async () => {
      try {
        // Smart lists are written as their current members: Rekordbox's XML has no rule element.
        await invoke("write_text_file", { path: dest, contents: buildRekordboxTreeXml([tree], snap.tracks) });
        notify(
          `Saved ${dest}. In Rekordbox: Preferences > Advanced > Database > rekordbox xml, then import from the “rekordbox xml” view. Smart playlists arrive as static lists.`,
          "success",
        );
      } catch (e) {
        notify(String(e), "error");
      }
    });
  };

  const loadAsSession = async () => {
    if (!snap || !node) return;
    const lib = await ensureMtc();
    if (!lib) return;
    const keys = new Map(lib.tracks.map((t) => [pathKey(t.path), t.path]));
    const have: string[] = [];
    const missing: string[] = [];
    for (const t of tracks) {
      const p = keys.get(pathKey(t.path));
      if (p) have.push(p);
      else missing.push(t.path);
    }
    if (!have.length) {
      notify("None of these tracks are in your Library, so there is nothing to open", "info");
      reportUnmatched("Not in your Library", "Add their folder to the Library (Settings) and index it, then try again.", missing);
      return;
    }
    onLoadSession(have, node.name);
    if (missing.length) notify(`${missing.length} track${missing.length === 1 ? " isn't" : "s aren't"} in your Library and were left out`, "info");
  };

  const addTracksToNode = (picked: DjTrack[]) => {
    if (!node || !canEditTracks) return;
    const have = new Set(pathsOf(node).map(pathKey));
    const add = picked.map((t) => t.path).filter((p) => !have.has(pathKey(p)));
    setDialog(null);
    if (!add.length) return notify("Those tracks are already in the playlist", "info");
    void writeTracks([...pathsOf(node), ...add]);
  };

  /** Re-evaluates every MTC smart playlist into Mixxx (`[smart]` crates), the manual "sync" step. */
  const pushSmartToMixxx = async () => {
    if (!mtc) return;
    const smart = mtc.nodes.filter((n) => n.kind === "smart");
    if (!smart.length) return notify("No smart playlists to push yet", "info");
    await run(async () => {
      const ops: DjOp[] = smart.map((n) => {
        const t = tracksOfNode({ ...mtc, tracks: mtc.tracks }, n);
        const paths = (t.rules ? evaluateRuleSet(t.rules, mtc.tracks) : t.tracks).map((x) => x.path);
        return { op: "upsert", name: n.name, kind: "smart", paths };
      });
      const res = await apply("mixxx", ops);
      if (!res) return;
      const miss = res.flatMap((r) => r.unmatched);
      notify(`Updated ${res.length} smart crate${res.length === 1 ? "" : "s"} in Mixxx${miss.length ? `, ${miss.length} tracks not in Mixxx` : ""}`, "success");
      reportUnmatched("Not in Mixxx's library", "These tracks match a smart playlist but Mixxx hasn't imported them yet.", [...new Set(miss)]);
      if (snaps.mixxx) void load("mixxx");
    });
  };

  const runFacetExport = async (opts: { facet: PlaylistFacet; values: FacetValue[]; folder: string; targets: FacetTargets }) => {
    setDialog(null);
    const lib = await ensureMtc();
    if (!lib) return;
    await run(async () => {
      const plans = planFacetPlaylists(lib.tracks, opts.facet, opts.values);
      const out: string[] = [];
      if (opts.targets.mtc) {
        const f = await apply("mtc", [{ op: "upsert", name: opts.folder, kind: "folder", parentId: null }]);
        if (!f) return;
        const folderId = f[0].id;
        const res = await apply(
          "mtc",
          plans.map((p) => ({ op: "upsert" as const, parentId: folderId, name: p.name, kind: "smart" as const, paths: p.paths, rulesJson: rulesToJson(p.rules) })),
        );
        if (!res) return;
        out.push(`MTC: ${res.filter((r) => r.created).length} new, ${res.filter((r) => !r.created).length} updated`);
        await load("mtc");
        if (folderId) setExpanded((e) => new Set(e).add(folderId));
      }
      if (opts.targets.mixxx) {
        const res = await apply(
          "mixxx",
          plans.map((p) => ({ op: "upsert" as const, name: p.name, kind: "smart" as const, paths: p.paths })),
        );
        if (res) {
          const miss = res.reduce((n, r) => n + r.unmatched.length, 0);
          out.push(`Mixxx: ${res.filter((r) => r.created).length} new, ${res.filter((r) => !r.created).length} updated${miss ? `, ${miss} track entries not in Mixxx` : ""}`);
          if (snaps.mixxx) void load("mixxx");
        }
      }
      if (opts.targets.rekordbox) {
        const dest = await saveDialog({
          title: "Save rekordbox.xml",
          defaultPath: `${opts.folder.replace(/[\\/:*?"<>|]+/g, "-")}.xml`,
          filters: [{ name: "Rekordbox XML", extensions: ["xml"] }],
        });
        if (dest) {
          const xml = buildRekordboxTreeXml(
            [{ type: "folder", name: opts.folder, children: plans.map((p) => ({ type: "playlist" as const, name: p.name, paths: p.paths })) }],
            lib.tracks,
          );
          try {
            await invoke("write_text_file", { path: dest, contents: xml });
            out.push("Rekordbox: xml saved (import it in Rekordbox; lists arrive as static playlists)");
          } catch (e) {
            notify(String(e), "error");
          }
        }
      }
      if (out.length) notify(`${plans.length} playlists. ${out.join(" · ")}`, "success");
    });
  };

  const pickPath = async (s: "rekordbox" | "mixxx") => {
    const p = await openDialog({
      title: s === "rekordbox" ? "Choose Rekordbox's master.db" : "Choose Mixxx's mixxxdb.sqlite",
      multiple: false,
      filters: [{ name: "Database", extensions: s === "rekordbox" ? ["db"] : ["sqlite"] }],
    });
    if (typeof p === "string") {
      lsSet(`playlists.path.${s}`, p);
      await refreshStatus();
      await load(s);
    }
  };

  // --- keyboard on the track list ----------------------------------------

  const onTrackKey = (e: React.KeyboardEvent) => {
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      void removeSelected();
    } else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      void moveSelected(e.key === "ArrowUp" ? -1 : 1);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setRowSel(tracks.map((_, i) => i));
    }
  };

  const clickRow = (i: number, e: React.MouseEvent) => {
    if (e.shiftKey && anchor !== null) {
      const [a, b] = anchor < i ? [anchor, i] : [i, anchor];
      setRowSel(Array.from({ length: b - a + 1 }, (_, k) => a + k));
    } else if (e.ctrlKey || e.metaKey) {
      setRowSel((s) => (s.includes(i) ? s.filter((x) => x !== i) : [...s, i]));
      setAnchor(i);
    } else {
      setRowSel([i]);
      setAnchor(i);
    }
  };

  // --- render --------------------------------------------------------------

  const running = source === "rekordbox" ? status?.rekordboxRunning : source === "mixxx" ? status?.mixxxRunning : false;
  const dbPath = source === "rekordbox" ? status?.rekordboxPath : source === "mixxx" ? status?.mixxxPath : null;
  const sel = new Set(rowSel);
  const deferredCount = useDeferredValue(tracks.length);
  const smartDesc = content?.rules ? describeRuleSet(content.rules) : null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Playlists</h1>
        <div className="flex gap-1 rounded-lg border bg-card p-1">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setSource(t)}
              className={cn(
                "rounded-md px-3 py-1 text-sm font-medium transition-colors",
                source === t ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {SOURCE_LABEL[t]}
            </button>
          ))}
        </div>
        <Button variant="outline" size="sm" onClick={() => void load(source)} disabled={loading === source}>
          {loading === source ? <Loader2 className="animate-spin" /> : <RefreshCw />} Reload
        </Button>
        <Button variant="outline" size="sm" onClick={() => setSyncOpen(true)} title="Keep playlists and track data in step between Rekordbox and Mixxx">
          <ArrowLeftRight /> Sync Rekordbox ⇄ Mixxx…
        </Button>
        <Button variant="outline" size="sm" onClick={() => setDialog({ kind: "facets" })} disabled={!mtc && loading === "mtc"} onMouseEnter={() => void (mtc ?? load("mtc"))}>
          <Sparkles /> Smart playlists from genres…
        </Button>
        {source === "mtc" && (
          <Button variant="outline" size="sm" onClick={() => void pushSmartToMixxx()} disabled={busy || !!status?.mixxxRunning || !status?.mixxxPath} title="Rebuild a “[smart]” crate in Mixxx for every smart playlist here">
            <Upload /> Push smart lists to Mixxx
          </Button>
        )}
      </div>

      {(source === "rekordbox" || source === "mixxx") && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span title={dbPath ?? undefined} className="max-w-[48ch] truncate">
            {dbPath ?? `${SOURCE_LABEL[source]} library not found`}
          </span>
          <button className="underline hover:text-foreground" onClick={() => void pickPath(source)}>
            Change…
          </button>
          {lsGet(`playlists.path.${source}`) && (
            <button
              className="underline hover:text-foreground"
              onClick={() => {
                lsSet(`playlists.path.${source}`, null);
                void refreshStatus().then(() => load(source));
              }}
            >
              Use default
            </button>
          )}
          {running && (
            <span className="inline-flex items-center gap-1 text-amber-500">
              <AlertTriangle className="h-3.5 w-3.5" />
              {source === "rekordbox" ? "Rekordbox is open: this is what it last saved to disk." : "Mixxx is open: changes are disabled until you close it."}
            </span>
          )}
          {source === "rekordbox" && (
            <span>Read-only here. Use Export to get a rekordbox.xml you import in Rekordbox.</span>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1 gap-4">
        {/* Tree */}
        <Card className="flex w-80 shrink-0 flex-col overflow-hidden">
          <div className="flex items-center gap-1 border-b p-2">
            <input className={cn(inputClass, "h-8 flex-1")} placeholder="Filter playlists…" value={filter} onChange={(e) => setFilter(e.target.value)} />
            {source === "mtc" && (
              <>
                <Button size="sm" variant="ghost" title="New folder" onClick={() => createPlain("folder")}>
                  <FolderPlus />
                </Button>
                <Button size="sm" variant="ghost" title="New playlist" onClick={() => createPlain("playlist")}>
                  <FilePlus2 />
                </Button>
                <Button size="sm" variant="ghost" title="New smart playlist" onClick={() => void newSmart()}>
                  <Sparkles />
                </Button>
              </>
            )}
            {source === "mixxx" && (
              <>
                <Button size="sm" variant="ghost" title="New playlist" disabled={!writable} onClick={() => createPlain("playlist")}>
                  <FilePlus2 />
                </Button>
                <Button size="sm" variant="ghost" title="New crate" disabled={!writable} onClick={() => createPlain("crate")}>
                  <Package />
                </Button>
              </>
            )}
          </div>
          {loading === source && !snap ? (
            <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Reading {SOURCE_LABEL[source]}…
            </div>
          ) : loadError[source] ? (
            <div className="space-y-2 p-4 text-sm">
              <p className="text-destructive">{loadError[source]}</p>
              <Button size="sm" variant="outline" onClick={() => void load(source)}>
                Try again
              </Button>
            </div>
          ) : snap && flat.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">{filter ? "No playlist matches." : "No playlists yet."}</p>
          ) : (
            <VirtualList
              count={flat.length}
              rowHeight={ROW_H}
              resetKey={source + filter}
              renderRow={(i) => {
                const r = flat[i];
                const active = r.node.id === selId;
                return (
                  <div
                    key={r.node.id}
                    style={{ height: ROW_H, paddingLeft: 8 + r.depth * 16 }}
                    className={cn(
                      "flex cursor-pointer items-center gap-1.5 pr-2 text-sm",
                      active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                    )}
                    onClick={() => {
                      setSelected((s) => ({ ...s, [source]: r.node.id }));
                      if (r.node.kind === "folder")
                        setExpanded((e) => {
                          const n = new Set(e);
                          if (n.has(r.node.id)) n.delete(r.node.id);
                          else n.add(r.node.id);
                          return n;
                        });
                    }}
                  >
                    {r.node.kind === "folder" ? (
                      r.expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                    ) : (
                      <span className="w-3.5 shrink-0" />
                    )}
                    <NodeIcon node={r.node} open={r.expanded} />
                    <span className="min-w-0 flex-1 truncate">{r.node.name}</span>
                    {r.node.kind !== "folder" && <span className="text-[10px] tabular-nums opacity-70">{r.node.count || ""}</span>}
                  </div>
                );
              }}
            />
          )}
        </Card>

        {/* Tracks */}
        <Card className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {!snap || !node ? (
            <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
              {snap ? "Pick a playlist on the left." : ""}
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
                <div className="mr-auto min-w-0">
                  <div className="flex items-center gap-2">
                    <NodeIcon node={node} open />
                    <h2 className="truncate text-sm font-semibold">{node.name}</h2>
                    {node.kind === "smart" && <Badge className="bg-violet/15 text-violet">smart</Badge>}
                    {node.kind === "crate" && <Badge>crate</Badge>}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {node.kind === "folder"
                      ? "Folder"
                      : `${deferredCount.toLocaleString()} track${deferredCount === 1 ? "" : "s"}`}
                    {notInLibrary.length > 0 && (
                      <button
                        className="ml-2 text-amber-500 underline"
                        onClick={() =>
                          reportUnmatched(
                            "Not in your Library",
                            "These tracks are in the playlist but not in your Music Tag Cleaner Library (matched by file path). Index their folder to make them editable here.",
                            notInLibrary.map((t) => t.path),
                          )
                        }
                      >
                        {notInLibrary.length} not in your Library
                      </button>
                    )}
                    {notIndexedMtc.length > 0 && (
                      <button
                        className="ml-2 text-amber-500 underline"
                        onClick={() =>
                          reportUnmatched("Not in the Library index", "These files are in this playlist but the index no longer lists them (moved or deleted?).", notIndexedMtc.map((t) => t.path))
                        }
                      >
                        {notIndexedMtc.length} not in the index
                      </button>
                    )}
                    {(content?.missing ?? 0) > 0 && <span className="ml-2 text-amber-500">{content!.missing} entries point at deleted tracks</span>}
                  </div>
                  {smartDesc && <div className="mt-0.5 truncate text-xs text-muted-foreground" title={smartDesc}>Rules: {smartDesc}</div>}
                  {content?.partial && (
                    <div className="mt-0.5 flex items-center gap-1 text-xs text-amber-500">
                      <AlertTriangle className="h-3 w-3" /> Has a rule Music Tag Cleaner can't evaluate (for example a My Tag), so the track list is incomplete.
                    </div>
                  )}
                  {source === "mixxx" && node.kind === "smart" && (
                    <div className="mt-0.5 text-xs text-muted-foreground">A static crate rebuilt from a Music Tag Cleaner smart playlist.</div>
                  )}
                </div>

                <Button size="sm" variant="secondary" onClick={() => void loadAsSession()} disabled={node.kind === "folder" || !tracks.length}>
                  <PlayCircle /> Load as session
                </Button>
                <CopyMenu source={source} onCopy={copyTo} onXml={() => void exportXml()} mixxxOk={!!status?.mixxxPath && !status?.mixxxRunning} disabled={busy} />
                {source !== "rekordbox" && (
                  <>
                    <Button size="sm" variant="outline" onClick={duplicate} disabled={!writable || busy}>
                      <Copy /> Duplicate
                    </Button>
                    <Button size="sm" variant="outline" onClick={renameNode} disabled={!writable || busy}>
                      <Pencil /> Rename
                    </Button>
                    {source === "mtc" && node.kind === "smart" && (
                      <>
                        <Button size="sm" variant="outline" onClick={editRules} disabled={busy}>
                          <Sparkles /> Rules
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => void refreshSmart()} disabled={busy} title="Re-evaluate against the current Library index">
                          <RefreshCw /> Refresh
                        </Button>
                      </>
                    )}
                    <Button size="sm" variant="outline" onClick={() => void deleteNode()} disabled={!writable || busy} className="text-destructive">
                      <Trash2 /> Delete
                    </Button>
                  </>
                )}
              </div>

              {node.kind === "folder" ? (
                <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
                  A folder. Copy or export it to take everything inside along.
                </div>
              ) : (
                <>
                  {canEditTracks && (
                    <div className="flex items-center gap-2 border-b px-4 py-2">
                      <Button size="sm" variant="outline" onClick={() => void (mtc ? setDialog({ kind: "add" }) : load("mtc").then(() => setDialog({ kind: "add" })))}>
                        <ListPlus /> Add tracks…
                      </Button>
                      <Button size="sm" variant="ghost" disabled={!rowSel.length || busy} onClick={() => void moveSelected(-1)} title="Move up (Alt+Up)">
                        <ArrowUp />
                      </Button>
                      <Button size="sm" variant="ghost" disabled={!rowSel.length || busy} onClick={() => void moveSelected(1)} title="Move down (Alt+Down)">
                        <ArrowDown />
                      </Button>
                      <Button size="sm" variant="ghost" disabled={!rowSel.length || busy} onClick={() => void removeSelected()} title="Remove from playlist (Delete)">
                        <Trash2 /> Remove
                      </Button>
                      <span className="text-xs text-muted-foreground">{rowSel.length ? `${rowSel.length} selected` : "Click rows to select; Shift/Ctrl extend."}</span>
                    </div>
                  )}
                  <div className="grid grid-cols-[2.5rem_minmax(0,2fr)_minmax(0,1.5fr)_minmax(0,1.5fr)_minmax(0,1fr)_3.5rem_3.5rem_2.5rem] gap-2 border-b px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    <span>#</span>
                    <span>Title</span>
                    <span>Artist</span>
                    <span>Album</span>
                    <span>Genre</span>
                    <span>BPM</span>
                    <span>Key</span>
                    <span>★</span>
                  </div>
                  <div className="flex min-h-0 flex-1 flex-col outline-none" tabIndex={0} onKeyDown={onTrackKey}>
                    {tracks.length === 0 ? (
                      <p className="p-6 text-sm text-muted-foreground">No tracks.</p>
                    ) : (
                      <VirtualList
                        count={tracks.length}
                        rowHeight={ROW_H}
                        resetKey={source + node.id}
                        renderRow={(i) => {
                          const t = tracks[i];
                          const lost = source === "mtc" ? !libraryKeys.has(pathKey(t.path)) : false;
                          return (
                            <div
                              key={`${i}-${t.id}`}
                              style={{ height: ROW_H }}
                              onClick={(e) => clickRow(i, e)}
                              className={cn(
                                "grid cursor-default select-none grid-cols-[2.5rem_minmax(0,2fr)_minmax(0,1.5fr)_minmax(0,1.5fr)_minmax(0,1fr)_3.5rem_3.5rem_2.5rem] items-center gap-2 px-3 text-sm",
                                sel.has(i) ? "bg-accent" : "hover:bg-accent/50",
                                lost && "text-muted-foreground italic",
                              )}
                              title={t.path}
                            >
                              <span className="text-xs tabular-nums text-muted-foreground">{i + 1}</span>
                              <span className="truncate">{t.title || "(untitled)"}</span>
                              <span className="truncate text-muted-foreground">{t.artist}</span>
                              <span className="truncate text-muted-foreground">{t.album}</span>
                              <span className="truncate text-muted-foreground">{t.genre}</span>
                              <span className="tabular-nums text-muted-foreground">{t.bpm ? t.bpm.toFixed(t.bpm % 1 ? 1 : 0) : ""}</span>
                              <span className="text-muted-foreground">{formatKey(t.key, keyNotation)}</span>
                              <span className="text-muted-foreground">{t.rating || ""}</span>
                            </div>
                          );
                        }}
                      />
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </Card>
      </div>

      {syncOpen && <DjSyncDialog settings={settings} savePatch={savePatch} notify={notify} onClose={() => { setSyncOpen(false); void refreshStatus(); }} />}
      {dialog?.kind === "name" && (
        <NameDialog title={dialog.title} label={dialog.label} initial={dialog.initial} confirmLabel={dialog.confirmLabel} onSubmit={dialog.onSubmit} onCancel={() => setDialog(null)} />
      )}
      {dialog?.kind === "rules" && mtc && (
        <RuleEditorDialog
          title={dialog.title}
          initialName={dialog.initialName}
          initialRules={dialog.rules}
          tracks={source === "rekordbox" || source === "mixxx" ? mtc.tracks : mtc.tracks}
          nameEditable={dialog.nameEditable}
          onSave={dialog.onSave}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "unmatched" && <UnmatchedDialog title={dialog.title} intro={dialog.intro} paths={dialog.paths} onClose={() => setDialog(null)} />}
      {dialog?.kind === "facets" && mtc && (
        <FacetExportDialog
          tracks={mtc.tracks}
          mixxxAvailable={!!status?.mixxxPath}
          mixxxRunning={!!status?.mixxxRunning}
          onRun={(o) => void runFacetExport(o)}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "add" && mtc && (
        <AddTracksDialog tracks={mtc.tracks} onAdd={addTracksToNode} onCancel={() => setDialog(null)} />
      )}
    </div>
  );
}

/** "Copy to" targets that make sense from `source`. */
function CopyMenu({
  source,
  onCopy,
  onXml,
  mixxxOk,
  disabled,
}: {
  source: DjSource;
  onCopy: (t: "mtc" | "mixxx" | "mixxx-crate") => void;
  onXml: () => void;
  mixxxOk: boolean;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const item = (label: string, hint: string, fn: () => void, off = false) => (
    <button
      key={label}
      disabled={off}
      onClick={() => {
        setOpen(false);
        fn();
      }}
      className="flex w-full flex-col items-start rounded-md px-3 py-1.5 text-left hover:bg-accent disabled:opacity-40"
    >
      <span className="text-sm">{label}</span>
      <span className="text-[11px] text-muted-foreground">{hint}</span>
    </button>
  );
  return (
    <div className="relative">
      <Button size="sm" variant="outline" disabled={disabled} onClick={() => setOpen((o) => !o)}>
        <Disc3 /> Copy to…
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-9 z-50 w-72 rounded-md border bg-popover p-1 shadow-lg">
            {source !== "mtc" && item("Music Tag Cleaner", "Keeps smart rules where it can", () => onCopy("mtc"))}
            {source !== "mixxx" && item("Mixxx playlist", mixxxOk ? "Needs Mixxx closed; backs up first" : "Mixxx not found or running", () => onCopy("mixxx"), !mixxxOk)}
            {source !== "mixxx" && item("Mixxx crate", mixxxOk ? "Unordered; smart lists become “[smart]” crates" : "Mixxx not found or running", () => onCopy("mixxx-crate"), !mixxxOk)}
            {item("Rekordbox (xml file)…", "Import it in Rekordbox. Smart lists become static", onXml)}
          </div>
        </>
      )}
    </div>
  );
}

function AddTracksDialog({ tracks, onAdd, onCancel }: { tracks: DjTrack[]; onAdd: (t: DjTrack[]) => void; onCancel: () => void }) {
  const [q, setQ] = useState("");
  const dq = useDeferredValue(q);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const hits = useMemo(() => {
    const words = dq.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const out: DjTrack[] = [];
    for (const t of tracks) {
      const hay = `${t.title} ${t.artist} ${t.album} ${t.genre}`.toLowerCase();
      if (words.every((w) => hay.includes(w))) {
        out.push(t);
        if (out.length >= 300) break;
      }
    }
    return out;
  }, [tracks, dq]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <Card className="flex max-h-[85vh] w-[640px] flex-col overflow-hidden">
        <div className="border-b px-5 py-3.5 text-sm font-semibold">Add tracks from your Library</div>
        <div className="p-4 pb-2">
          <input autoFocus className={inputClass} placeholder="Search title, artist, album, genre…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="flex h-72 flex-col px-2">
          {hits.length === 0 ? (
            <p className="p-3 text-xs text-muted-foreground">{q ? "No matches." : "Type to search the index."}</p>
          ) : (
            <VirtualList
              count={hits.length}
              rowHeight={ROW_H}
              resetKey={dq}
              renderRow={(i) => {
                const t = hits[i];
                return (
                  <label key={t.path} style={{ height: ROW_H }} className="flex cursor-pointer items-center gap-2 px-2 text-sm hover:bg-accent">
                    <input
                      type="checkbox"
                      className="accent-[var(--primary)]"
                      checked={picked.has(t.path)}
                      onChange={() =>
                        setPicked((p) => {
                          const n = new Set(p);
                          if (n.has(t.path)) n.delete(t.path);
                          else n.add(t.path);
                          return n;
                        })
                      }
                    />
                    <span className="min-w-0 flex-1 truncate">{t.artist ? `${t.artist} - ` : ""}{t.title}</span>
                    <span className="text-xs text-muted-foreground">{t.genre}</span>
                  </label>
                );
              }}
            />
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t px-5 py-3">
          <span className="mr-auto text-xs text-muted-foreground">{picked.size} selected</span>
          <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
          <Button size="sm" disabled={!picked.size} onClick={() => onAdd(tracks.filter((t) => picked.has(t.path)))}>
            Add {picked.size || ""}
          </Button>
        </div>
      </Card>
    </div>
  );
}

// Used by tests/other modules that need the empty-state helper without React.
export { mapPaths };
