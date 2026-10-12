// Computes the column text for each row ({ path, tags }) inside the sandbox.
mtc.addColumn({ id: "range", label: "BPM range", width: 110 }, (row) => {
  const bpm = parseFloat(row.tags && row.tags.bpm);
  if (!isFinite(bpm) || bpm <= 0) return "";
  const step = Math.max(1, Number(mtc.settings.get("step")) || 10);
  const low = Math.floor(bpm / step) * step;
  return `${low}-${low + step - 1}`;
});
