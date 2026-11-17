import { useState } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import type { AudioFile } from "../types";
import type { useFiles } from "./useFiles";
import { EMPTY_HISTORY, type HistorySnapshot, type useHistory } from "./useHistory";
import {
  closeTab,
  EMPTY_SOURCE,
  insertAfter,
  MANUAL_SOURCE,
  splitOff,
  tabTitle,
  type SessionTabState,
} from "../lib/sessionTabs";

type Tab = SessionTabState<AudioFile, HistorySnapshot>;

/** What the tab strip renders for each tab. */
export interface SessionTabView {
  id: string;
  title: string;
  fileCount: number;
  /** Applied undo steps that closing this tab would forget. */
  undoSteps: number;
}

interface Deps {
  filesApi: ReturnType<typeof useFiles>;
  history: ReturnType<typeof useHistory>;
  /** Stops an in-flight genre load so it can't land its rows in the next tab. */
  cancelGenreLoad: () => void;
  /** Resolves false when an unapplied preview exists and the user keeps it. */
  releasePreview: () => Promise<boolean>;
}

let tabSeq = 0;
const emptyTab = (): Tab => ({ id: `tab-${++tabSeq}`, title: "New tab", snapshot: null });

/**
 * In-app session tabs, as snapshot-and-swap rather than N live copies of the
 * app: only the active tab lives in `useFiles` / `useHistory`; leaving a tab
 * parks its batch, selection, source and undo stacks here, and entering one
 * puts them back. Nothing else in App has to know tabs exist.
 *
 * The tag cache (`libraryTags`) is deliberately not part of a snapshot. It is
 * keyed by path, so one copy stays correct for every tab — an edit made in one
 * tab shows up in another that holds the same file — and the table's reader
 * re-fills whatever a restored tab is missing.
 */
export function useSessionTabs({ filesApi, history, cancelGenreLoad, releasePreview }: Deps) {
  const [state, setState] = useState(() => {
    const first = emptyTab();
    return { tabs: [first], activeId: first.id };
  });
  const { tabs, activeId } = state;

  const liveTitle = () =>
    tabTitle(filesApi.source, filesApi.files.map((f) => f.path));

  const views: SessionTabView[] = tabs.map((t) =>
    t.id === activeId
      ? {
          id: t.id,
          title: liveTitle(),
          fileCount: filesApi.files.length,
          undoSteps: history.index + 1,
        }
      : {
          id: t.id,
          title: t.title,
          fileCount: t.snapshot?.files.length ?? 0,
          undoSteps: t.snapshot?.history.history.length ?? 0,
        },
  );

  /** `tabs` with the active tab's live state written into its slot. */
  const parkActive = (): Tab[] =>
    tabs.map((t) =>
      t.id === activeId
        ? { ...t, title: liveTitle(), snapshot: { ...filesApi.snapshot(), history: history.snapshot() } }
        : t,
    );

  /** Puts `tab` into the live hooks (an empty one for a tab never left). */
  const load = (tab: Tab) => {
    cancelGenreLoad();
    const s = tab.snapshot;
    filesApi.restore(s ?? { files: [], selected: [], source: EMPTY_SOURCE });
    history.restore(s?.history ?? EMPTY_HISTORY);
  };

  /** The loaded tab's slot holds no snapshot: its state is live. */
  const activate = (list: Tab[], id: string): Tab[] =>
    list.map((t) => (t.id === id ? { ...t, snapshot: null } : t));

  const switchTo = async (id: string) => {
    if (id === activeId || !(await releasePreview())) return;
    const parked = parkActive();
    const target = parked.find((t) => t.id === id);
    if (!target) return;
    load(target);
    setState({ tabs: activate(parked, id), activeId: id });
  };

  /** Opens an empty tab next to the others and switches to it. */
  const openNewTab = async (): Promise<boolean> => {
    if (!(await releasePreview())) return false;
    const parked = parkActive();
    const fresh = emptyTab();
    load(fresh);
    setState({ tabs: [...parked, fresh], activeId: fresh.id });
    return true;
  };

  /**
   * "Open / Move to new tab": a new tab, right after the current one, holding
   * `paths` from the current tab, all ticked so the next action applies to
   * them. `move` also takes them out of the current tab (only the tab's list:
   * files on disk are untouched, and its undo history stays as it was). The
   * files travel as they are, so tracks that aren't in the library index move
   * just the same.
   */
  const openSelectionInNewTab = async (paths: string[], move: boolean): Promise<boolean> => {
    const { taken, kept } = splitOff(filesApi.files, paths);
    if (!taken.length || !(await releasePreview())) return false;
    const takenPaths = new Set(taken.map((f) => f.path));
    const parked = parkActive().map((t) => {
      if (!move || t.id !== activeId || !t.snapshot) return t;
      const snapshot = { ...t.snapshot, files: kept, selected: t.snapshot.selected.filter((p) => !takenPaths.has(p)) };
      return { ...t, snapshot, title: tabTitle(snapshot.source, kept.map((f) => f.path)) };
    });
    const fresh: Tab = {
      ...emptyTab(),
      snapshot: {
        files: taken,
        selected: [...takenPaths],
        source: MANUAL_SOURCE,
        history: EMPTY_HISTORY,
      },
    };
    load(fresh);
    setState({ tabs: activate(insertAfter(parked, activeId, fresh), fresh.id), activeId: fresh.id });
    return true;
  };

  /** Closes a tab, asking first when it holds undo history that would be lost. */
  const requestClose = async (id: string) => {
    const view = views.find((v) => v.id === id);
    if (view && view.undoSteps > 0) {
      const ok = await confirm(
        `"${view.title}" has ${view.undoSteps} undo step${view.undoSteps === 1 ? "" : "s"}. ` +
          "Closing it forgets them; edits already written to your files stay.",
        { title: "Close tab", kind: "warning" },
      );
      if (!ok) return;
    }
    if (id === activeId && !(await releasePreview())) return;
    const res = closeTab(tabs, activeId, id, emptyTab);
    if (res.restore) {
      load(res.restore);
      setState({ tabs: activate(res.tabs, res.activeId), activeId: res.activeId });
    } else {
      setState({ tabs: res.tabs, activeId });
    }
  };

  /** Forgets the active tab's undo history (its files are replaced by the caller). */
  const resetHistory = () => history.restore(EMPTY_HISTORY);

  return { views, activeId, switchTo, openNewTab, openSelectionInNewTab, requestClose, resetHistory };
}
