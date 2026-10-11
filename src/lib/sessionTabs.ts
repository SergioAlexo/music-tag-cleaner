/**
 * Pure rules for the Library's session source, genre clicks and session tabs.
 * Kept out of the hooks so the decision tree is unit-testable without React
 * or Tauri.
 */
import { facetLabel, type FacetPick } from "./facets";

/** How the current batch was built. */
export type SessionSource =
  | { kind: "empty" }
  | ({ kind: "facet" } & FacetPick) // a genre / album loaded from the library sidebar
  | { kind: "manual" }; // folder / files / drop / Open with / YouTube "Add to batch"

export const EMPTY_SOURCE: SessionSource = { kind: "empty" };
export const MANUAL_SOURCE: SessionSource = { kind: "manual" };

/**
 * Source after files are added by hand. Always `manual`: the user has now
 * built the batch themselves, so a genre session that gets an extra file
 * dropped on it no longer counts as "just a genre" and must not be replaced
 * silently by the next genre click.
 */
export function afterManualAdd(_prev: SessionSource): SessionSource {
  return MANUAL_SOURCE;
}

/** What a click on a sidebar genre / album does in a hand-built batch (`settings.genreClickInManualSession`). */
export type GenreClickChoice = "ask" | "newTab" | "replace" | "filter";

/** What a click on a library genre should do. */
export type GenreClickAction =
  /** Swap the batch to the genre right away. */
  | "load"
  /** Same, but an unapplied preview would be discarded, so confirm first. */
  | "confirm-load"
  /** A hand-built batch and no remembered choice: show the session dialog. */
  | "ask"
  | "new-tab"
  | "replace"
  /** Old behaviour: narrow the loaded files to the genre. */
  | "filter";

export function decideGenreClick(opts: {
  source: SessionSource;
  /** An AI/Standardize/Clear preview that hasn't been applied or cancelled. */
  hasUnappliedPreview: boolean;
  /** The remembered answer to the session dialog; `ask` (or unset) shows it. */
  manualChoice?: GenreClickChoice;
}): GenreClickAction {
  if (opts.source.kind === "manual") {
    switch (opts.manualChoice) {
      case "newTab":
        return "new-tab";
      case "replace":
        return "replace";
      case "filter":
        return "filter";
      default:
        return "ask";
    }
  }
  return opts.hasUnappliedPreview ? "confirm-load" : "load";
}

const SEP = /[/\\]/;

/** The name of `p`'s parent folder, or null when `p` has none. */
function parentName(p: string): string | null {
  const parts = p.split(SEP).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : null;
}

/**
 * Tab label for a session: a genre / album tab is its name; a manual tab is the
 * folder its files share (the usual "opened one folder" case) or "Files"
 * when they come from several places; an empty tab is "New tab".
 */
export function tabTitle(source: SessionSource, paths: string[]): string {
  if (source.kind === "facet") return facetLabel(source);
  if (source.kind === "empty" || paths.length === 0) return "New tab";
  const folders = new Set(paths.map((p) => parentName(p)));
  const only = folders.size === 1 ? [...folders][0] : null;
  return only ?? "Files";
}

/** Everything one inactive tab needs to come back exactly as it was left. */
export interface SessionSnapshot<File, Hist> {
  source: SessionSource;
  files: File[];
  selected: string[];
  history: Hist;
}

export interface SessionTabState<File, Hist> {
  id: string;
  /** Null for the active tab: its state is live in the hooks, not stored here. */
  snapshot: SessionSnapshot<File, Hist> | null;
  /** Title frozen when the tab was last left; the active tab's is derived live. */
  title: string;
}

/**
 * Tabs and the active id after closing `id`. Closing the active tab moves to
 * its right neighbour (or the left one at the end); closing the last tab
 * leaves a single fresh one, so there's always something to work in.
 * `restore` is the tab whose state must be loaded into the live hooks, set
 * only when the active tab was the one closed.
 */
export function closeTab<T extends { id: string }>(
  tabs: T[],
  activeId: string,
  id: string,
  makeEmpty: () => T,
): { tabs: T[]; activeId: string; restore: T | null } {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx < 0) return { tabs, activeId, restore: null };
  const rest = tabs.filter((t) => t.id !== id);
  if (rest.length === 0) {
    const fresh = makeEmpty();
    return { tabs: [fresh], activeId: fresh.id, restore: fresh };
  }
  if (id !== activeId) return { tabs: rest, activeId, restore: null };
  const target = rest[Math.min(idx, rest.length - 1)];
  return { tabs: rest, activeId: target.id, restore: target };
}
