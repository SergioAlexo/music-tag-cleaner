import { describe, expect, it } from "vitest";
import { artGroupSortKey, type ArtGroup } from "./useArtGroups";

describe("artGroupSortKey", () => {
  it("keeps each picture together, biggest groups first, then unique covers, then no art", () => {
    const rows: [string, ArtGroup | undefined][] = [
      ["none", undefined],
      ["solo", { group: "solo:x", size: 1 }],
      ["b1", { group: "b", size: 2 }],
      ["a1", { group: "a", size: 5 }],
      ["b2", { group: "b", size: 2 }],
      ["c1", { group: "c", size: 2 }],
      ["a2", { group: "a", size: 5 }],
    ];
    const order = rows
      .map(([id, g]) => ({ id, k: artGroupSortKey(g) }))
      .sort((x, y) => x.k.localeCompare(y.k, undefined, { numeric: true }))
      .map((x) => x.id);
    expect(order).toEqual(["a1", "a2", "b1", "b2", "c1", "solo", "none"]);
  });
});
