import { useState } from "react";
import { Check, Pencil, X } from "lucide-react";
import { FACETS, facetKey, samePick, type Facet, type FacetCount, type FacetPick } from "../lib/facets";
import { cn } from "./ui";
import { VirtualList } from "./VirtualList";

const ROW_HEIGHT = 28;

/**
 * One facet's list (Genres, Albums...): the "none" bucket first, then the
 * values with counts. Written once for every facet; see lib/facets.ts.
 *
 * Renaming is inline and only offered when the list comes from the index,
 * because a rename retags every indexed track (it goes through `retag_field`
 * like the table's genre rename), which a tally of the loaded files can't see.
 */
export function SidebarFacetList({
  facet,
  items,
  query,
  active,
  canRename,
  emptyText,
  onPick,
  onRename,
}: {
  facet: Facet;
  /** Already arranged (sorted + filtered) by `arrangeFacet`. */
  items: FacetCount[];
  query: string;
  active: FacetPick | null;
  canRename: boolean;
  emptyText: string;
  onPick: (pick: FacetPick) => void;
  onRename: (pick: FacetPick, newName: string) => void;
}) {
  const meta = FACETS[facet];
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  if (items.length === 0) {
    return <p className="px-3 py-3 text-xs text-muted-foreground">{emptyText}</p>;
  }

  const commit = (pick: FacetPick) => {
    const next = draft.trim();
    setRenaming(null);
    if (next && next !== pick.name) onRename(pick, next);
  };

  return (
    <VirtualList
      count={items.length}
      rowHeight={ROW_HEIGHT}
      resetKey={`${facet}\u0001${query}`}
      className="p-1.5"
      renderRow={(i) => {
        const item = items[i];
        const pick: FacetPick = { facet, name: item.name, artist: item.artist };
        const key = facetKey(item.name, item.artist);
        const isNone = !item.name;
        const isActive = samePick(active, pick);

        if (renaming === key) {
          return (
            <div key={key} style={{ height: ROW_HEIGHT }} className="flex items-center gap-1 px-1">
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commit(pick);
                  else if (e.key === "Escape") setRenaming(null);
                }}
                className="min-w-0 flex-1 rounded border bg-background px-1.5 py-0.5 text-sm outline-none"
              />
              <button
                className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                title={`Rename on every track`}
                onClick={() => commit(pick)}
              >
                <Check className="h-3.5 w-3.5" />
              </button>
              <button
                className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                title="Cancel"
                onClick={() => setRenaming(null)}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        }

        return (
          <div
            key={key}
            style={{ height: ROW_HEIGHT }}
            className={cn(
              "group flex items-center rounded-md hover:bg-accent",
              isActive && "bg-accent font-medium",
            )}
          >
            <button
              onClick={() => onPick(pick)}
              className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-1.5 text-left text-sm"
              title={isNone ? `Tracks with no ${meta.singular}` : item.artist ? `${item.name} — ${item.artist}` : item.name}
            >
              <span className={cn("min-w-0 flex-1 truncate", isNone && "italic text-muted-foreground")}>
                {isNone ? meta.noneLabel : item.name}
                {item.artist && <span className="text-xs text-muted-foreground"> — {item.artist}</span>}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">{item.count}</span>
            </button>
            {canRename && !isNone && (
              <button
                className="mr-1 hidden shrink-0 rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground group-hover:block"
                title={`Rename this ${meta.singular} on every track`}
                onClick={() => {
                  setDraft(item.name);
                  setRenaming(key);
                }}
              >
                <Pencil className="h-3 w-3" />
              </button>
            )}
          </div>
        );
      }}
    />
  );
}
