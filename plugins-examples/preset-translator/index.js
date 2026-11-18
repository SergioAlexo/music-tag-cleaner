// Converts a folder of Serum / Serum 2 presets to Vital through the presets.* host
// actions. The heavy lifting happens in the presetforge engine; this plugin only
// wires settings to the actions and opens the dialog, where the user reviews and applies.
mtc.registerAction("convertFolder", async ({ folder }) => {
  if (!folder) throw new Error("Pick a folder to convert");
  const found = await mtc.call("presets.scan", { paths: [folder] });
  const items = (found && found.items) || found || [];
  const supported = items.filter((i) => i.supported);
  if (!supported.length) {
    mtc.ui.notify("No convertible presets found in that folder", "info");
    await mtc.call("presets.open", { folder });
    return { scanned: items.length, converted: 0 };
  }
  const params = { paths: supported.map((i) => i.path) };
  const serumRoot = mtc.settings.get("serumRoot");
  if (serumRoot) params.serumRoot = serumRoot;
  const maxFrames = Number(mtc.settings.get("maxFrames"));
  if (maxFrames > 0) params.maxFrames = maxFrames;
  const batch = await mtc.call("presets.convert", params);
  if (mtc.settings.get("autoVerify")) await mtc.call("presets.verify", { batchId: batch.batchId });
  // Nothing is written to disk until the user confirms Apply in the dialog.
  await mtc.call("presets.open", { folder });
  return { scanned: items.length, converted: supported.length, batchId: batch.batchId };
});

mtc.registerAction("makeFromPrompt", async () => {
  throw new Error("Prompt → Preset arrives in a later version");
});
