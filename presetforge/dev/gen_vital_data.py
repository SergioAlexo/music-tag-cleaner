"""Regenerate presetforge/data/*.json from vita (dev-only; needs `pip install vita`).

vital_init.json   Vital's own init preset (Vital is GPL-3, same as this package).
vital_ranges.json {control: [min, max, is_discrete, [option names]]} for every control.
"""
import json
from pathlib import Path

import vita

out = Path(__file__).resolve().parent.parent / "presetforge" / "data"
s = vita.Synth()
s.load_init_preset()
(out / "vital_init.json").write_text(s.to_json(), encoding="utf-8")
ranges = {}
for name in sorted(s.get_controls()):
    d = s.get_control_details(name)
    ranges[name] = [d.min, d.max, bool(d.is_discrete), list(d.options)]
(out / "vital_ranges.json").write_text(json.dumps(ranges, separators=(",", ":")), encoding="utf-8")
print(len(ranges), "controls")
