// Copies "Artist - Title" for each selected track to the clipboard.
mtc.registerAction("copy", async ({ paths }) => {
  const targets = paths && paths.length ? paths : mtc.selection();
  const lines = [];
  for (const path of targets) {
    const tags = await mtc.call("track.get", { path });
    lines.push(`${tags.artist || "?"} - ${tags.title || "?"}`);
  }
  await mtc.ui.copy(lines.join("\n"));
  mtc.ui.notify(`Copied ${lines.length} track(s)`, "success");
  return { copied: lines.length };
});
