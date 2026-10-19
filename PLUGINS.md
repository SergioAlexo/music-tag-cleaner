# Writing plugins for Vatra Wave

A plugin adds a toolbar button, a right-click item, a table column, a new
action (which AI assistants connected over MCP can call too) or a colour theme.
Plugins run in a sandbox and only do what the permissions you declare allow.
The person always sees the permissions and the code, and approves them, before
a plugin runs.

Working examples live in `plugins-examples/`: `hide-genre-button` (no code),
`copy-artist-title`, `bpm-range-column`, `neon-theme`. Type definitions for
editors: `plugins-examples/hide-genre-button/sdk.d.ts`.

## Where plugins live

`<app data>/plugins/<id>/manifest.json` plus the script it names. Plugins page
-> Installed -> **Open plugins folder**. Copying a folder in and pressing
**Rescan** shows it as "Needs review"; it does nothing until approved. Any
change to `manifest.json` or the script (an update, a hand edit) drops it back
to "Needs review".

## manifest.json

```json
{
  "id": "hide-genre",
  "name": "Hide Genre column",
  "version": "1.0.0",
  "author": "you",
  "description": "One sentence.",
  "apiVersion": 1,
  "kind": "plugin",
  "permissions": ["ui.control"],
  "entry": "index.js",
  "contributes": {
    "buttons":     [{ "id": "go", "label": "Hide Genre", "action": "table.setColumns", "params": { "hide": ["genre"] } }],
    "contextMenu": [{ "id": "copy", "label": "Copy as Artist - Title", "action": "copy", "pathsParam": "paths" }],
    "columns":     [{ "id": "bpmRange", "label": "BPM range", "width": 110 }],
    "actions":     [{ "id": "copy", "title": "Copy as Artist - Title", "params": { "type": "object", "properties": {} } }],
    "settings":    [{ "key": "step", "label": "Range size", "type": "number", "default": 10 }]
  }
}
```

- `id`: 2-40 chars, lowercase letters, digits, hyphens. It is the folder name.
- `kind`: `"plugin"` or `"theme"`. `apiVersion` is `1`.
- `entry` is optional. A **declarative** plugin (buttons calling an app action
  with fixed parameters) needs no code.
- A button/menu `action` is an app action id (contains a dot, e.g.
  `table.setColumns`, `tags.edit`; AI assistants can list them) or the id of
  one of this plugin's own `contributes.actions`.

## Permissions

| Permission | Allows |
|---|---|
| `read` | query actions (`session.list`, `library.search`, `track.get`, ...), selection, column values |
| `ui.control` | `table.select`, `table.setColumns`, `nav.goto`, `session.open`, `library.*` view actions |
| `tags.write` | `tags.edit`, `tags.editRaw`, `tags.setRating`, `tags.standardize`, `changes.apply`, `history.undo`, ... |
| `artwork.write` | `artwork.*` |
| `backup` | `backup.tags`, `backup.archive` |
| `files.move` | rename, organize, convert, stems |
| `files.delete` | `files.delete`, `duplicates.delete` (the app still asks each time) |
| `network:<host>` | `mtc.fetch` to that host only (`network:api.example.com`, `network:*.example.com`) |
| `action:<id>` | one specific action not covered above |

Plugins can never call `script.run` or `plugins.*`. Ask for the fewest
permissions that work: a plugin without `tags.write` cannot call a tag-writing
action even if its code tries.

## Script (index.js)

The script runs in a sandboxed iframe + Worker: no DOM, no `fetch`, no app
access. The one global is `mtc`; top-level `await` works. An error in one
plugin is contained and shown on its row.

```js
mtc.registerAction("copy", async ({ paths }) => { /* ... */ return anyJson; });
await mtc.call("tags.edit", { paths, field: "genre", value: "House" }); // permission-checked
mtc.addToolbarButton({ id, label, title }, async () => {});
mtc.addContextMenuItem({ id, label }, async ({ paths }) => {});
mtc.addColumn({ id, label, width }, (row) => String(row.tags.bpm)); // row = { path, tags }, needs "read"
mtc.onSelectionChange((paths) => {});                               // needs "read"
mtc.selection();                                                    // needs "read"
mtc.storage.get(key) / set(key, value) / remove(key)                // private, 256 KB per value
mtc.settings.get(key)                                               // contributes.settings values
mtc.ui.notify(message, "success" | "error" | "info");
await mtc.ui.confirm(message);
await mtc.ui.copy(text);
await mtc.fetch(url, { method, headers, body });                   // { status, ok, body }; granted hosts only
```

## Themes

`"kind": "theme"`, no `entry`, no permissions:

```json
"contributes": { "theme": {
  "mode": "dark",              // "dark" | "light" force it; "auto" follows the OS
  "radius": "0.5rem", "font": "Inter, sans-serif",
  "light": { "background": "#fff", "...": "..." },
  "dark":  { "background": "#000", "...": "..." }
} }
```

Tokens: `background foreground card card-foreground popover popover-foreground
primary primary-foreground secondary secondary-foreground muted
muted-foreground accent accent-foreground destructive destructive-foreground
border input ring violet`. Values are `#hex`, `hsl(...)` or `rgb(...)`; anything
else is ignored. Pick one in Settings -> Appearance or Plugins -> Themes.
"Follow OS" is the default.

## Making a button with AI

- In the app: Plugins -> Installed -> **New button with AI**, describe it. With
  the Manual AI backend the dialog gives you a prompt to paste into any AI and
  takes the answer back.
- From Claude Code or another MCP client: `plugins.docs` returns this guide's
  short form, then `plugins.create({manifest, code})`. It only *stages* the
  plugin; the person approves it in the app.

## Publishing to a store

A store is a static `index.json` anywhere reachable by https (a GitHub repo's
raw file is fine). Put its address in Plugins -> Store.

```json
{ "plugins": [
  { "manifest": { "...the plugin's manifest.json..." },
    "url": "packages/hide-genre-1.0.0.zip",
    "sha256": "<64 hex chars: sha256 of that zip>" }
] }
```

- The zip holds `manifest.json` and the entry script, at the root or inside one
  folder. Other files are ignored. Each file is limited to 512 KB.
- Compute the hash: `sha256sum hide-genre-1.0.0.zip` (Linux/macOS) or
  `Get-FileHash -Algorithm SHA256 hide-genre-1.0.0.zip` (PowerShell).
- `url` may be relative to the index. Raise `manifest.version` to ship an
  update; the Store tab shows an update badge and Update button.
- The app refuses a download whose SHA-256 differs from the index, then shows
  the same review dialog (permissions + code) as any other install. Free plugins
  only. `http://` is accepted for `localhost` testing only.
