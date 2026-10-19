/**
 * Pure helpers for the Playlists page: the shared snapshot model (mirrors
 * `dj_playlists.rs`), tree flattening, track mapping between sources,
 * facet -> playlist planning (the "genre -> smart playlists" action) and
 * rekordbox.xml generation for importing playlists into Rekordbox.
 */
import { languageName, normalizeLanguageCode } from "./language";
import { escapeXmlAttr, pathToLocation } from "./rekordboxExport";
import {
  evaluateRuleSet,
  parseRekordboxSmartList,
  parseRuleSet,
  type RuleSet,
  type RuleTrack,
} from "./smartRules";

export type DjSource = "rekordbox" | "mixxx" | "mtc";
export type NodeKind = "folder" | "playlist" | "smart" | "crate";

export interface DjNode {
  id: string;
  parentId: string | null;
  name: string;
  kind: NodeKind;
  seq: number;
  count: number;
  smartXml: string | null;
  rulesJson: string | null;
}

export interface DjTrack extends RuleTrack {
  id: string;
  path: string;
  duration: number;
}

export interface DjSnapshot {
  source: DjSource;
  dbPath: string | null;
  nodes: DjNode[];
  tracks: DjTrack[];
  members: Record<string, string[]>;
  running: boolean;
}

export type DjOp =
  | { op: "create"; parentId?: string | null; name: string; kind: NodeKind; paths?: string[]; rulesJson?: string | null }
  | { op: "upsert"; parentId?: string | null; name: string; kind: NodeKind; paths?: string[]; rulesJson?: string | null }
  | { op: "setTracks"; id: string; paths: string[] }
  | { op: "rename"; id: string; name: string }
  | { op: "delete"; id: string }
  | { op: "setRules"; id: string; rulesJson: string };

export interface OpResult {
  id: string | null;
  created: boolean;
  matched: number;
  unmatched: string[];
}

export const SOURCE_LABEL: Record<DjSource, string> = {
  rekordbox: "Rekordbox",
  mixxx: "Mixxx",
  mtc: "Vatra Wave",
};

/**
 * The key paths are compared by across sources. Mirrors `path_key` in
 * `dj_playlists.rs`: forward slashes, `file://localhost/` stripped and
 * percent-decoded, case-folded (the owner's platforms are case-insensitive).
 */
export function pathKey(p: string): string {
  let s = p.trim().replace(/\\/g, "/");
  const m = /^file:\/\/(?:localhost)?\/(.*)$/i.exec(s);
  if (m) {
    try {
      s = decodeURIComponent(m[1]);
    } catch {
      s = m[1];
    }
  }
  return s.toLowerCase();
}

// --- tree -----------------------------------------------------------------

export interface FlatRow {
  node: DjNode;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
}

/** Folders first, then by Rekordbox/DB order, then name. */
function byOrder(a: DjNode, b: DjNode): number {
  const fa = a.kind === "folder" ? 0 : 1;
  const fb = b.kind === "folder" ? 0 : 1;
  if (fa !== fb) return fa - fb;
  return a.seq - b.seq || a.name.localeCompare(b.name);
}

export function childrenMap(nodes: DjNode[]): Map<string | null, DjNode[]> {
  const ids = new Set(nodes.map((n) => n.id));
  const m = new Map<string | null, DjNode[]>();
  for (const n of nodes) {
    // A parent that isn't in the list (deleted folder) must not hide its children.
    const key = n.parentId && ids.has(n.parentId) ? n.parentId : null;
    const arr = m.get(key) ?? [];
    arr.push(n);
    m.set(key, arr);
  }
  for (const arr of m.values()) arr.sort(byOrder);
  return m;
}

/**
 * The visible rows of the tree. While `filter` is non-empty every folder is
 * opened and only matching playlists (and the folders leading to them) show.
 */
export function flattenTree(nodes: DjNode[], expanded: Set<string>, filter = ""): FlatRow[] {
  const kids = childrenMap(nodes);
  const q = filter.trim().toLowerCase();
  const matches = (n: DjNode): boolean => {
    if (!q) return true;
    if (n.kind !== "folder") return n.name.toLowerCase().includes(q);
    return (kids.get(n.id) ?? []).some(matches);
  };
  const out: FlatRow[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const n of kids.get(parent) ?? []) {
      if (!matches(n)) continue;
      const has = (kids.get(n.id) ?? []).length > 0;
      const open = n.kind === "folder" && (q ? true : expanded.has(n.id));
      out.push({ node: n, depth, hasChildren: has, expanded: open });
      if (open) walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** Folder path (names) of a node, for XML export. */
export function nodePath(nodes: DjNode[], id: string): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const names: string[] = [];
  let cur = byId.get(id);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    names.unshift(cur.name);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return names;
}

// --- members --------------------------------------------------------------

export function nodeRuleSet(node: DjNode): RuleSet | null {
  if (node.kind !== "smart") return null;
  return parseRuleSet(node.rulesJson) ?? parseRekordboxSmartList(node.smartXml);
}

export interface NodeTracks {
  tracks: DjTrack[];
  /** Smart: the rules the list was evaluated with. */
  rules: RuleSet | null;
  /** Smart list the rules of which can't be fully evaluated (unsupported rules). */
  partial: boolean;
  /** Static members whose id isn't in the track table (deleted/missing in the source). */
  missing: number;
}

export function tracksOfNode(snap: DjSnapshot, node: DjNode, now = Date.now()): NodeTracks {
  if (node.kind === "folder") return { tracks: [], rules: null, partial: false, missing: 0 };
  const byId = new Map(snap.tracks.map((t) => [t.id, t]));
  const rules = nodeRuleSet(node);
  // Rekordbox smart lists have no stored members; Mixxx `[smart]` crates and
  // MTC smart lists do (the last regeneration), which is what the other
  // program shows too.
  const stored = snap.members[node.id];
  if (node.kind === "smart" && rules && (snap.source === "rekordbox" || !stored?.length)) {
    return {
      tracks: evaluateRuleSet(rules, snap.tracks, now),
      rules,
      partial: !!rules.unsupported?.length,
      missing: 0,
    };
  }
  const ids = stored ?? [];
  const tracks: DjTrack[] = [];
  let missing = 0;
  for (const id of ids) {
    const t = byId.get(id);
    if (t) tracks.push(t);
    // MTC lists hold bare paths, so a file the index no longer lists still shows.
    else if (snap.source === "mtc") tracks.push(placeholderTrack(id));
    else missing++;
  }
  return { tracks, rules, partial: false, missing };
}

/** MTC members are paths that may no longer be in the index; show them anyway. */
export function placeholderTrack(path: string): DjTrack {
  const name = path.replace(/\\/g, "/").split("/").pop() ?? path;
  return {
    id: path, path, title: name, artist: "", album: "", genre: "", key: "", bpm: 0, rating: 0, year: "",
    comment: "", dateAdded: "", language: "", duration: 0,
  };
}

/** How many of `paths` the target library has (by path key), and the ones it lacks. */
export function mapPaths(paths: string[], target: DjTrack[]): { matched: string[]; unmatched: string[] } {
  const have = new Set(target.map((t) => pathKey(t.path)));
  const matched: string[] = [];
  const unmatched: string[] = [];
  for (const p of paths) (have.has(pathKey(p)) ? matched : unmatched).push(p);
  return { matched, unmatched };
}

/** Remove / reorder helpers over an ordered path list (the page uses buttons, no drag). */
export function movePaths(paths: string[], indexes: number[], delta: -1 | 1): { paths: string[]; indexes: number[] } {
  const out = paths.slice();
  const order = [...new Set(indexes)].sort((a, b) => (delta < 0 ? a - b : b - a));
  const next = new Set<number>();
  for (const i of order) {
    const j = i + delta;
    // Blocked by the edge, or by a selected row that already stopped there.
    if (j < 0 || j >= out.length || next.has(j)) {
      next.add(i);
      continue;
    }
    [out[i], out[j]] = [out[j], out[i]];
    next.add(j);
  }
  return { paths: out, indexes: [...next].sort((a, b) => a - b) };
}

export function removeIndexes(paths: string[], indexes: number[]): string[] {
  const sel = new Set(indexes);
  return paths.filter((_, i) => !sel.has(i));
}

// --- facet -> playlists ---------------------------------------------------

export type PlaylistFacet = "genre" | "album" | "language";

export interface FacetValue {
  /** Display name. */
  name: string;
  count: number;
  /** The rule value (language: the 3-letter code). */
  value: string;
}

function foldKey(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

function facetRaw(t: RuleTrack, facet: PlaylistFacet): string {
  if (facet === "language") return normalizeLanguageCode(t.language) ?? t.language.trim();
  return (facet === "genre" ? t.genre : t.album).trim();
}

/** Distinct values with counts, biggest first. Spelling variants ("house"/"House") merge. */
export function listFacetValues(tracks: RuleTrack[], facet: PlaylistFacet): FacetValue[] {
  const groups = new Map<string, { spell: Map<string, number>; count: number }>();
  for (const t of tracks) {
    const raw = facetRaw(t, facet);
    if (!raw) continue;
    const k = foldKey(raw);
    const g = groups.get(k) ?? { spell: new Map(), count: 0 };
    g.count++;
    g.spell.set(raw, (g.spell.get(raw) ?? 0) + 1);
    groups.set(k, g);
  }
  return [...groups.values()]
    .map((g) => {
      const best = [...g.spell.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0][0];
      return { name: facet === "language" ? languageName(best) : best, value: best, count: g.count };
    })
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export interface FacetPlan {
  name: string;
  facet: PlaylistFacet;
  rules: RuleSet;
  paths: string[];
}

/** Characters Rekordbox/Windows dislike in playlist names, plus surrounding blanks. */
export function safePlaylistName(s: string): string {
  return s.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 80);
}

/**
 * One smart playlist per chosen value. Deterministic (same input, same output)
 * and keyed by name, so re-running the export updates instead of duplicating.
 */
export function planFacetPlaylists(tracks: DjTrack[], facet: PlaylistFacet, values: FacetValue[]): FacetPlan[] {
  const used = new Set<string>();
  const plans: FacetPlan[] = [];
  for (const v of values) {
    const rules: RuleSet = { match: "all", rules: [{ field: facet, op: "is", value: v.value }] };
    const name = safePlaylistName(v.name) || "Untitled";
    if (used.has(name.toLowerCase())) continue;
    used.add(name.toLowerCase());
    plans.push({ name, facet, rules, paths: evaluateRuleSet(rules, tracks).map((t) => t.path) });
  }
  return plans;
}

// --- rekordbox.xml --------------------------------------------------------

/** Extra per-track attributes for the sync export (rating is 0-5 stars). */
export interface XmlOptions {
  extras?: Map<string, { rating?: number; plays?: number; color?: string }>;
  extraPaths?: string[];
}

export type XmlNode =
  | { type: "folder"; name: string; children: XmlNode[] }
  | { type: "playlist"; name: string; paths: string[] };

const KIND_LABELS: Record<string, string> = {
  mp3: "MP3 File", flac: "FLAC File", wav: "WAV File", aiff: "AIFF File", aif: "AIFF File",
  m4a: "M4A File", aac: "AAC File", ogg: "OGG File",
};

function collectPaths(nodes: XmlNode[], out: string[], seen: Set<string>) {
  for (const n of nodes) {
    if (n.type === "folder") collectPaths(n.children, out, seen);
    else
      for (const p of n.paths) {
        const k = pathKey(p);
        if (!seen.has(k)) {
          seen.add(k);
          out.push(p);
        }
      }
  }
}

function nodeCount(n: XmlNode): number {
  return n.type === "folder" ? n.children.length : n.paths.length;
}

/**
 * A `rekordbox.xml` with a `<COLLECTION>` of every referenced track and a
 * `<PLAYLISTS>` tree (folders and static playlists). Rekordbox's XML format
 * has no smart-playlist element, so smart lists must arrive here already
 * evaluated to their current members. Same schema as `buildRekordboxPlaylistXml`
 * (which `rekordbox_import.rs` reads back), extended with folders and the
 * metadata a re-import should keep (genre, BPM, key).
 */
export function buildRekordboxTreeXml(nodes: XmlNode[], tracks: DjTrack[], opts: XmlOptions = {}): string {
  const byKey = new Map(tracks.map((t) => [pathKey(t.path), t]));
  const paths: string[] = [];
  const seen = new Set<string>();
  collectPaths(nodes, paths, seen);
  // Tracks that carry metadata but belong to no exported playlist (C2 sync).
  for (const p of opts.extraPaths ?? []) {
    const k = pathKey(p);
    if (!seen.has(k)) {
      seen.add(k);
      paths.push(p);
    }
  }
  const ids = new Map<string, number>();
  const collection = paths.map((p, i) => {
    const id = i + 1;
    ids.set(pathKey(p), id);
    const t = byKey.get(pathKey(p)) ?? null;
    const x = opts.extras?.get(pathKey(p));
    const file = p.replace(/\\/g, "/").split("/").pop() ?? p;
    const ext = file.includes(".") ? file.split(".").pop()!.toLowerCase() : "";
    const attrs = [
      `TrackID="${id}"`,
      `Name="${escapeXmlAttr(t?.title?.trim() || file)}"`,
      t?.artist?.trim() ? `Artist="${escapeXmlAttr(t.artist.trim())}"` : "",
      t?.album?.trim() ? `Album="${escapeXmlAttr(t.album.trim())}"` : "",
      t?.genre?.trim() ? `Genre="${escapeXmlAttr(t.genre.trim())}"` : "",
      ext ? `Kind="${escapeXmlAttr(KIND_LABELS[ext] ?? `${ext.toUpperCase()} File`)}"` : "",
      t?.duration ? `TotalTime="${Math.round(t.duration)}"` : "",
      t?.year && /^\d{4}$/.test(t.year) ? `Year="${t.year}"` : "",
      t?.bpm ? `AverageBpm="${t.bpm.toFixed(2)}"` : "",
      t?.key ? `Tonality="${escapeXmlAttr(t.key)}"` : "",
      t?.comment?.trim() ? `Comments="${escapeXmlAttr(t.comment.trim())}"` : "",
      x?.rating !== undefined ? `Rating="${Math.round(x.rating) * 51}"` : "",
      x?.plays !== undefined ? `PlayCount="${Math.max(0, Math.round(x.plays))}"` : "",
      x?.color ? `Colour="0x${x.color.replace(/^#/, "").toUpperCase()}"` : "",
      `Location="${escapeXmlAttr(pathToLocation(p))}"`,
    ]
      .filter(Boolean)
      .join(" ");
    return `    <TRACK ${attrs}/>`;
  });

  const render = (n: XmlNode, indent: string): string => {
    if (n.type === "folder") {
      return (
        `${indent}<NODE Type="0" Name="${escapeXmlAttr(n.name)}" Count="${nodeCount(n)}">\n` +
        n.children.map((c) => render(c, indent + "  ")).join("\n") +
        `\n${indent}</NODE>`
      );
    }
    const keys = n.paths.map((p) => ids.get(pathKey(p))).filter((x): x is number => x !== undefined);
    return (
      `${indent}<NODE Name="${escapeXmlAttr(n.name)}" Type="1" KeyType="0" Entries="${keys.length}">\n` +
      keys.map((k) => `${indent}  <TRACK Key="${k}"/>`).join("\n") +
      (keys.length ? "\n" : "") +
      `${indent}</NODE>`
    );
  };

  return `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="Vatra Wave" Version="1.0" Company=""/>
  <COLLECTION Entries="${collection.length}">
${collection.join("\n")}
  </COLLECTION>
  <PLAYLISTS>
    <NODE Type="0" Name="ROOT" Count="${nodes.length}">
${nodes.map((n) => render(n, "      ")).join("\n")}
    </NODE>
  </PLAYLISTS>
</DJ_PLAYLISTS>
`;
}

/** Export tree for one node of a snapshot: a playlist alone, or a folder with everything under it. */
export function xmlTreeForNode(snap: DjSnapshot, node: DjNode, now = Date.now()): XmlNode | null {
  if (node.kind === "folder") {
    const kids = childrenMap(snap.nodes).get(node.id) ?? [];
    return {
      type: "folder",
      name: node.name,
      children: kids.flatMap((k) => xmlTreeForNode(snap, k, now) ?? []),
    };
  }
  const { tracks } = tracksOfNode(snap, node, now);
  // MTC members are bare paths; tracksOfNode only resolves ids that are tracks,
  // which for MTC are the paths themselves.
  return { type: "playlist", name: node.name, paths: tracks.map((t) => t.path) };
}

// --- copying ----------------------------------------------------------------

export interface CopyItem {
  name: string;
  kind: "folder" | "playlist" | "smart";
  /** Index of the parent item in the same list, or null for the copied node itself. */
  parent: number | null;
  paths: string[];
  /** Smart lists: rules to keep when the target can store them (MTC). */
  rules: RuleSet | null;
  /** Skipped on purpose (rules we can't evaluate); shown to the user. */
  skipped?: string;
}

/** Depth-first list of what "Copy to..." would create for `node` (folders before their children). */
export function flattenForCopy(snap: DjSnapshot, node: DjNode, now = Date.now()): CopyItem[] {
  const out: CopyItem[] = [];
  const kids = childrenMap(snap.nodes);
  const walk = (n: DjNode, parent: number | null) => {
    if (n.kind === "folder") {
      const idx = out.push({ name: n.name, kind: "folder", parent, paths: [], rules: null }) - 1;
      for (const k of kids.get(n.id) ?? []) walk(k, idx);
      return;
    }
    const r = tracksOfNode(snap, n, now);
    if (n.kind === "smart" && r.partial) {
      out.push({ name: n.name, kind: "smart", parent, paths: [], rules: null, skipped: "uses a rule that can't be evaluated here" });
      return;
    }
    out.push({
      name: n.name,
      kind: n.kind === "smart" && r.rules ? "smart" : "playlist",
      parent,
      paths: r.tracks.map((t) => t.path),
      rules: n.kind === "smart" ? r.rules : null,
    });
  };
  walk(node, null);
  return out;
}

/** `name`, or `name (2)`, `name (3)`... when taken (compared case-insensitively). */
export function uniqueName(name: string, taken: Iterable<string>): string {
  const have = new Set([...taken].map((s) => s.toLowerCase()));
  if (!have.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) {
    const c = `${name} (${i})`;
    if (!have.has(c.toLowerCase())) return c;
  }
}

/** Stored form of a rule set: no `unsupported` entries (they can't be evaluated). */
export function rulesToJson(r: RuleSet): string {
  return JSON.stringify({ match: r.match, rules: r.rules });
}
