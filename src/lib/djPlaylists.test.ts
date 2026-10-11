import { describe, expect, it } from "vitest";
import {
  buildRekordboxTreeXml,
  flattenForCopy,
  uniqueName,
  flattenTree,
  listFacetValues,
  mapPaths,
  movePaths,
  nodePath,
  pathKey,
  planFacetPlaylists,
  removeIndexes,
  tracksOfNode,
  xmlTreeForNode,
  type DjNode,
  type DjSnapshot,
  type DjTrack,
} from "./djPlaylists";

const trk = (id: string, path: string, o: Partial<DjTrack> = {}): DjTrack => ({
  id, path, title: id, artist: "", album: "", genre: "", key: "", bpm: 0, rating: 0, year: "", comment: "",
  dateAdded: "", language: "", duration: 0, ...o,
});
const node = (id: string, name: string, kind: DjNode["kind"], parentId: string | null = null, seq = 0, o: Partial<DjNode> = {}): DjNode => ({
  id, name, kind, parentId, seq, count: 0, smartXml: null, rulesJson: null, ...o,
});

describe("pathKey", () => {
  it("makes every spelling of a path equal", () => {
    const a = pathKey("C:\\Users\\x\\Music\\Avicii - Levels.mp3");
    expect(pathKey("c:/users/x/music/avicii - levels.mp3")).toBe(a);
    expect(pathKey("file://localhost/C:/Users/x/Music/Avicii%20-%20Levels.mp3")).toBe(a);
  });
  it("leaves a bad escape alone", () => {
    expect(pathKey("file://localhost/C:/100%/x.mp3")).toBe("c:/100%/x.mp3");
  });
});

describe("tree", () => {
  const nodes = [
    node("f1", "Sets", "folder", null, 2),
    node("p1", "Warmup", "playlist", "f1", 1),
    node("p2", "Peak", "playlist", "f1", 2),
    node("p3", "Loose", "playlist", null, 1),
    node("s1", "Russian", "smart", null, 3),
    node("orphan", "Orphan", "playlist", "gone", 9),
  ];
  it("lists folders first and honours expansion", () => {
    expect(flattenTree(nodes, new Set()).map((r) => r.node.id)).toEqual(["f1", "p3", "s1", "orphan"]);
    const open = flattenTree(nodes, new Set(["f1"]));
    expect(open.map((r) => [r.node.id, r.depth])).toEqual([["f1", 0], ["p1", 1], ["p2", 1], ["p3", 0], ["s1", 0], ["orphan", 0]]);
  });
  it("filters through folders", () => {
    expect(flattenTree(nodes, new Set(), "peak").map((r) => r.node.id)).toEqual(["f1", "p2"]);
    expect(flattenTree(nodes, new Set(), "zzz")).toEqual([]);
  });
  it("builds folder paths", () => {
    expect(nodePath(nodes, "p2")).toEqual(["Sets", "Peak"]);
  });
});

describe("tracksOfNode", () => {
  const tracks = [trk("1", "C:/a.mp3", { genre: "RU Pop" }), trk("2", "C:/b.mp3", { genre: "RU Drum And Bass" }), trk("3", "C:/c.mp3", { genre: "House" })];
  const rbXml =
    '<NODE Id="1" LogicalOperator="1" AutomaticUpdate="0"><CONDITION PropertyName="genre" Operator="8" ValueUnit="" ValueLeft="RU" ValueRight=""/><CONDITION PropertyName="genre" Operator="9" ValueUnit="" ValueLeft="Drum And Bass" ValueRight=""/></NODE>';
  it("evaluates a Rekordbox smart list from its XML", () => {
    const snap: DjSnapshot = { source: "rekordbox", dbPath: null, nodes: [], tracks, members: {}, running: false };
    const r = tracksOfNode(snap, node("s", "Russian", "smart", null, 0, { smartXml: rbXml }));
    expect(r.tracks.map((t) => t.id)).toEqual(["1"]);
    expect(r.partial).toBe(false);
  });
  it("flags lists with rules we can't evaluate", () => {
    const xml = '<NODE Id="1" LogicalOperator="1" AutomaticUpdate="0"><CONDITION PropertyName="myTag" Operator="8" ValueUnit="" ValueLeft="5" ValueRight=""/></NODE>';
    const snap: DjSnapshot = { source: "rekordbox", dbPath: null, nodes: [], tracks, members: {}, running: false };
    const r = tracksOfNode(snap, node("s", "Tagged", "smart", null, 0, { smartXml: xml }));
    expect(r.partial).toBe(true);
    expect(r.tracks).toEqual([]);
  });
  it("keeps static order, counts missing members, and shows MTC paths the index lost", () => {
    const snap: DjSnapshot = { source: "mixxx", dbPath: null, nodes: [], tracks, members: { "p:1": ["3", "1", "99"] }, running: false };
    const r = tracksOfNode(snap, node("p:1", "L", "playlist"));
    expect(r.tracks.map((t) => t.id)).toEqual(["3", "1"]);
    expect(r.missing).toBe(1);
    const mtc: DjSnapshot = { source: "mtc", dbPath: null, nodes: [], tracks: [], members: { "5": ["C:/gone/x.mp3"] }, running: false };
    expect(tracksOfNode(mtc, node("5", "M", "playlist")).tracks[0].title).toBe("x.mp3");
  });
});

describe("mapping and editing", () => {
  it("maps by path key and reports unmatched", () => {
    const r = mapPaths(["C:\\Music\\A.mp3", "D:/x.mp3"], [trk("1", "c:/music/a.mp3")]);
    expect(r.matched).toEqual(["C:\\Music\\A.mp3"]);
    expect(r.unmatched).toEqual(["D:/x.mp3"]);
  });
  it("moves a selection up and down without losing rows", () => {
    expect(movePaths(["a", "b", "c", "d"], [1, 2], -1)).toEqual({ paths: ["b", "c", "a", "d"], indexes: [0, 1] });
    expect(movePaths(["a", "b", "c", "d"], [0, 1], -1)).toEqual({ paths: ["a", "b", "c", "d"], indexes: [0, 1] });
    expect(movePaths(["a", "b", "c", "d"], [1], 1)).toEqual({ paths: ["a", "c", "b", "d"], indexes: [2] });
    expect(movePaths(["a", "b", "c", "d"], [2, 3], 1)).toEqual({ paths: ["a", "b", "c", "d"], indexes: [2, 3] });
  });
  it("removes by index", () => {
    expect(removeIndexes(["a", "b", "c"], [0, 2])).toEqual(["b"]);
  });
});

describe("facet playlists", () => {
  const tracks = [
    trk("1", "C:/1.mp3", { genre: "House", language: "spa" }),
    trk("2", "C:/2.mp3", { genre: "house", language: "es" }),
    trk("3", "C:/3.mp3", { genre: "Techno", language: "eng" }),
    trk("4", "C:/4.mp3", { genre: "", language: "" }),
    trk("5", "C:/5.mp3", { genre: "AC/DC: Live" }),
  ];
  it("merges spelling variants and ignores blanks", () => {
    const g = listFacetValues(tracks, "genre");
    expect(g.map((v) => [v.name, v.count])).toEqual([["House", 2], ["AC/DC: Live", 1], ["Techno", 1]]);
    const l = listFacetValues(tracks, "language");
    expect(l.map((v) => [v.name, v.count])).toEqual([["Spanish", 2], ["English", 1]]);
  });
  it("plans one deterministic smart playlist per value, with members", () => {
    const vals = listFacetValues(tracks, "genre");
    const a = planFacetPlaylists(tracks, "genre", vals);
    const b = planFacetPlaylists(tracks, "genre", vals);
    expect(a).toEqual(b); // re-running yields the same names, so an upsert updates in place
    const house = a.find((p) => p.name === "House")!;
    expect(house.paths).toEqual(["C:/1.mp3", "C:/2.mp3"]);
    expect(house.rules.rules[0]).toEqual({ field: "genre", op: "is", value: "House" });
    expect(a.find((p) => p.name.startsWith("AC"))!.name).toBe("AC-DC- Live");
    // Language rule uses the canonical code and finds both spellings.
    const lang = planFacetPlaylists(tracks, "language", listFacetValues(tracks, "language"));
    expect(lang[0].paths).toEqual(["C:/1.mp3", "C:/2.mp3"]);
  });
});

describe("rekordbox.xml", () => {
  it("writes folders, playlists and a de-duplicated collection", () => {
    const tracks = [
      trk("1", "C:\\Music\\A & B.mp3", { title: "A & B", artist: "X", genre: "House", bpm: 124, key: "8A", duration: 200.4 }),
      trk("2", "C:/Music/c.flac", { title: "C" }),
    ];
    const xml = buildRekordboxTreeXml(
      [
        { type: "folder", name: "MTC Genres", children: [{ type: "playlist", name: "House", paths: ["C:\\Music\\A & B.mp3", "c:/music/c.flac"] }] },
        { type: "playlist", name: "Again", paths: ["C:/Music/A & B.mp3"] },
      ],
      tracks,
    );
    expect(xml).toContain('<COLLECTION Entries="2">');
    expect(xml).toContain('Name="A &amp; B"');
    expect(xml).toContain('Genre="House"');
    expect(xml).toContain('AverageBpm="124.00"');
    expect(xml).toContain('Tonality="8A"');
    expect(xml).toContain("file://localhost/C:/Music/A%20%26%20B.mp3");
    expect(xml).toContain('<NODE Type="0" Name="ROOT" Count="2">');
    expect(xml).toContain('<NODE Type="0" Name="MTC Genres" Count="1">');
    expect(xml).toContain('<NODE Name="House" Type="1" KeyType="0" Entries="2">');
    expect(xml).toContain('<NODE Name="Again" Type="1" KeyType="0" Entries="1">');
    expect((xml.match(/<TRACK TrackID=/g) ?? []).length).toBe(2);
    expect(xml.includes("<NODE Name=\"Again\" Type=\"1\" KeyType=\"0\" Entries=\"1\">\n        <TRACK Key=\"1\"/>")).toBe(true);
  });
  it("exports a snapshot folder with smart lists evaluated to static members", () => {
    const tracks = [trk("1", "C:/a.mp3", { genre: "House" }), trk("2", "C:/b.mp3", { genre: "Techno" })];
    const snap: DjSnapshot = {
      source: "mtc", dbPath: null, tracks, running: false,
      nodes: [
        node("1", "Folder", "folder"),
        node("2", "Static", "playlist", "1", 1),
        node("3", "Smart", "smart", "1", 2, { rulesJson: JSON.stringify({ match: "all", rules: [{ field: "genre", op: "is", value: "techno" }] }) }),
      ],
      members: { "2": ["C:/a.mp3"] },
    };
    const x = xmlTreeForNode(snap, snap.nodes[0])!;
    expect(x).toEqual({
      type: "folder", name: "Folder",
      children: [{ type: "playlist", name: "Static", paths: ["C:/a.mp3"] }, { type: "playlist", name: "Smart", paths: ["C:/b.mp3"] }],
    });
  });
});

describe("copying", () => {
  const snap: DjSnapshot = {
    source: "rekordbox", dbPath: null, running: false,
    tracks: [trk("1", "C:/a.mp3", { genre: "House" }), trk("2", "C:/b.mp3", { genre: "Techno" })],
    nodes: [
      node("f", "Folder", "folder"),
      node("p", "Static", "playlist", "f", 1),
      node("s", "House", "smart", "f", 2, { smartXml: '<NODE Id="1" LogicalOperator="1" AutomaticUpdate="0"><CONDITION PropertyName="genre" Operator="1" ValueUnit="" ValueLeft="House" ValueRight=""/></NODE>' }),
      node("t", "Tagged", "smart", "f", 3, { smartXml: '<NODE Id="1" LogicalOperator="1" AutomaticUpdate="0"><CONDITION PropertyName="myTag" Operator="8" ValueUnit="" ValueLeft="5" ValueRight=""/></NODE>' }),
    ],
    members: { p: ["2"] },
  };
  it("lists folders before children, keeps rules, skips the unevaluable", () => {
    const items = flattenForCopy(snap, snap.nodes[0]);
    expect(items.map((i) => [i.name, i.kind, i.parent])).toEqual([
      ["Folder", "folder", null], ["Static", "playlist", 0], ["House", "smart", 0], ["Tagged", "smart", 0],
    ]);
    expect(items[2].paths).toEqual(["C:/a.mp3"]);
    expect(items[2].rules?.rules[0].value).toBe("House");
    expect(items[3].skipped).toBeTruthy();
  });
  it("makes names unique", () => {
    expect(uniqueName("A", ["b"])).toBe("A");
    expect(uniqueName("A", ["a", "A (2)"])).toBe("A (3)");
  });
});
