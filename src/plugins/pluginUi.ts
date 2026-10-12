/**
 * What running plugins contribute to the UI (D2), as a tiny external store so
 * TrackTable / the toolbar can read it without prop threading through App.
 * `usePlugins` (the only writer) keeps it in sync with the PluginManager.
 */
import { useSyncExternalStore } from "react";
import type { UiColumn, UiItem } from "./host";

export interface PluginUiState {
  version: number;
  buttons: UiItem[];
  menuItems: UiItem[];
  columns: UiColumn[];
  /** Runs a toolbar button / menu item for the given selection. */
  run: (kind: "button" | "menu", pluginId: string, itemId: string, paths: string[]) => void;
  getSelection: () => string[];
}

const EMPTY: PluginUiState = {
  version: 0,
  buttons: [],
  menuItems: [],
  columns: [],
  run: () => {},
  getSelection: () => [],
};

let state: PluginUiState = EMPTY;
const listeners = new Set<() => void>();

export function setPluginUi(next: Omit<PluginUiState, "version">) {
  state = { ...next, version: state.version + 1 };
  listeners.forEach((l) => l());
}

export function usePluginUi(): PluginUiState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
  );
}

/** Computed column values: columnId -> path -> text. Filled by `usePlugins`. */
const columnData = new Map<string, Map<string, string>>();
export function setPluginColumnData(columnId: string, values: Map<string, string>) {
  columnData.set(columnId, values);
}
export function clearPluginColumnData(keep: Set<string>) {
  for (const k of [...columnData.keys()]) if (!keep.has(k)) columnData.delete(k);
}
export function pluginColumnValue(columnId: string, path: string): string {
  return columnData.get(columnId)?.get(path) ?? "";
}
