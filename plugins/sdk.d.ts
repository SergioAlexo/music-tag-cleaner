/**
 * Types for Music Tag Cleaner plugin authors (plugin API version 1).
 *
 * Your script runs in a sandbox with one global, `mtc`. Reference this file
 * from your editor with a triple-slash directive to get completion:
 *
 *   /// <reference path="../../plugins/sdk.d.ts" />
 *
 * See PLUGINS.md for the manifest format and permissions.
 */

/** The tags the app hands to column code and `track.get` (field names as shown in the Columns menu). */
interface MtcTags {
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  year?: string;
  genre?: string;
  trackNumber?: string;
  discNumber?: string;
  comment?: string;
  composer?: string;
  originalArtist?: string;
  trackId?: string;
  bpm?: string;
  key?: string;
  language?: string;
  [other: string]: unknown;
}

interface MtcButtonSpec {
  /** Letters and digits, unique within your plugin. */
  id: string;
  label: string;
  title?: string;
}

interface MtcColumnSpec {
  id: string;
  label: string;
  width?: number;
}

interface MtcFetchInit {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
}

interface MtcFetchResult {
  status: number;
  ok: boolean;
  /** Response text, truncated at 1,000,000 characters. */
  body: string;
}

interface Mtc {
  readonly apiVersion: 1;

  /**
   * Binds the handler of an action declared in `contributes.actions`. The action
   * is also callable by AI assistants (MCP) as `plugin.<id>.<actionId>`.
   */
  registerAction(id: string, handler: (params: any) => unknown | Promise<unknown>): Promise<true>;

  /**
   * Runs any app action by id (the same registry AI assistants use). Checked
   * against your manifest permissions; dangerous actions still ask the person.
   * Rejects with the reason when blocked.
   */
  call(action: string, params?: Record<string, unknown>): Promise<any>;

  /** A toolbar button added at runtime (no permission needed). */
  addToolbarButton(spec: MtcButtonSpec, onClick: () => unknown | Promise<unknown>): Promise<true>;
  /** A right-click menu item added at runtime. `paths` are the tracks the menu was opened on. */
  addContextMenuItem(spec: MtcButtonSpec, onClick: (arg: { paths: string[] }) => unknown | Promise<unknown>): Promise<true>;
  /** A table column. `compute` runs per row inside the sandbox. Needs the `read` permission. */
  addColumn(spec: MtcColumnSpec, compute: (row: { path: string; tags: MtcTags }) => string | number | null | undefined): Promise<true>;

  /** Needs `read`. */
  onSelectionChange(handler: (paths: string[]) => void): void;
  /** Currently selected track paths. Empty unless you hold `read`. */
  selection(): string[];

  /** Private to your plugin. Values are JSON, up to 256 KB each. */
  storage: {
    get(key: string): Promise<any>;
    set(key: string, value: unknown): Promise<true>;
    remove(key: string): Promise<true>;
  };

  /** Values of `contributes.settings`, editable by the person in Plugins. */
  settings: {
    get(key: string): any;
    all(): Record<string, any>;
  };

  ui: {
    notify(message: string, kind?: "success" | "error" | "info"): Promise<true>;
    /** Asks the person a yes/no question. */
    confirm(message: string): Promise<boolean>;
    /** Puts text on the clipboard. */
    copy(text: string): Promise<true>;
  };

  /** Only hosts listed as `network:<host>` permissions. */
  fetch(url: string, init?: MtcFetchInit): Promise<MtcFetchResult>;
}

declare const mtc: Mtc;
