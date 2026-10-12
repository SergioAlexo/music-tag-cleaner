/**
 * Short authoring guide for plugin code, shared by the `plugins.docs` action
 * (so an AI connected over MCP can write a valid plugin) and the in-app "New
 * button" prompt. The longer human guide is PLUGINS.md at the repo root.
 */
export const AUTHORING_GUIDE = `
A plugin is a manifest (JSON) plus, optionally, one script. The person reviews the
permissions and code before anything runs, so ask for the fewest permissions needed.

MANIFEST
{
  "id": "hide-genre",              // 2-40 chars: lowercase letters, digits, hyphens
  "name": "Hide Genre column",
  "version": "1.0.0",
  "author": "me",
  "description": "One sentence.",
  "apiVersion": 1,
  "kind": "plugin",
  "permissions": ["ui.control"],
  "entry": "index.js",             // omit for a declarative plugin (no code)
  "contributes": {
    "buttons":     [{ "id": "go", "label": "Hide Genre", "title": "tooltip", "action": "table.setColumns", "params": { "hide": ["genre"] } }],
    "contextMenu": [{ "id": "copy", "label": "Copy as Artist - Title", "action": "copy", "pathsParam": "paths" }],
    "columns":     [{ "id": "bpmRange", "label": "BPM range", "width": 110 }],
    "actions":     [{ "id": "copy", "title": "Copy as Artist - Title", "params": { "type": "object", "properties": {} } }],
    "settings":    [{ "key": "step", "label": "Range size", "type": "number", "default": 10 }]
  }
}

A button/menu "action" is either a registry action id (contains a dot, e.g. table.setColumns,
tags.edit; use the app's actions list) or the id of one of this plugin's own contributes.actions.
Declarative plugins (buttons that call registry actions with fixed params) need no code at all.

PERMISSIONS
  read           query actions (session.list, library.search, track.get, ...), selection, column values
  ui.control     table.select, table.setColumns, nav.goto, session.open, library.* view actions
  tags.write     tags.edit / tags.editRaw / tags.setRating / tags.standardize / changes.apply / history.undo ...
  artwork.write  artwork.*
  backup         backup.tags, backup.archive
  files.move     files.rename, organize, convert, stems
  files.delete   files.delete, duplicates.delete (the app still asks each time)
  network:<host> mtc.fetch to that host only, e.g. network:api.example.com or network:*.example.com
  action:<id>    one specific registry action not covered above
Plugins can never call script.run or plugins.*.

SCRIPT (index.js). It runs in a sandbox: no DOM, no fetch/XMLHttpRequest, no app access. The only
global is \`mtc\`; top-level await works.
  mtc.registerAction("copy", async (params) => { ... return anyJson; })   // id declared in contributes.actions
  mtc.call("tags.edit", { paths: [...], field: "genre", value: "House" }) // checked against permissions; returns a promise
  mtc.addToolbarButton({ id, label, title }, async () => {...})            // dynamic alternative to contributes.buttons
  mtc.addContextMenuItem({ id, label }, async ({ paths }) => {...})
  mtc.addColumn({ id, label, width }, (row) => string)                    // row = { path, tags }, needs "read"
  mtc.onSelectionChange((paths) => {...})                                  // needs "read"
  mtc.selection()                                                          // current selected paths ("read")
  mtc.storage.get(key) / set(key, value) / remove(key)                     // private to the plugin, 256 KB per value
  mtc.settings.get(key)                                                    // values of contributes.settings
  mtc.ui.notify(message, "success"|"error"|"info") / await mtc.ui.confirm(message) / await mtc.ui.copy(text)
  await mtc.fetch(url, { method, headers, body })  -> { status, ok, body } // only hosts granted by network:<host>

THEMES are plugins with "kind": "theme", no entry and no permissions:
  "contributes": { "theme": { "mode": "auto"|"light"|"dark", "light": { "background": "#fff", ... }, "dark": { ... },
                              "radius": "0.5rem", "font": "Inter, sans-serif" } }
Tokens: background foreground card card-foreground popover popover-foreground primary primary-foreground
secondary secondary-foreground muted muted-foreground accent accent-foreground destructive
destructive-foreground border input ring violet. Values: #hex, hsl(...) or rgb(...).
`.trim();
