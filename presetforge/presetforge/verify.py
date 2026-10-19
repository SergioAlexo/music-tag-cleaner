"""verify: load a .vital in the real Vital engine (vita) and render a probe note."""

from __future__ import annotations

import math

SILENT_DB = -80.0


class VerifyUnavailable(Exception):
    pass


def make_synth():
    try:
        import numpy  # noqa: F401
        import vita
    except ImportError as exc:
        raise VerifyUnavailable("verify needs: pip install presetforge[verify]") from exc
    synth = vita.Synth()
    synth.set_sample_rate(44100)
    return synth


def verify_one(synth, path: str) -> dict:
    import numpy as np

    item: dict = {"file": path, "loaded": False}
    try:
        if not synth.load_preset(path):
            return item
        item["loaded"] = True
        audio = synth.render(48, 0.8, 1.0, 2.5)
        item["nan"] = bool(np.isnan(audio).any())
        a = np.nan_to_num(audio)
        peak = float(np.abs(a).max()) if a.size else 0.0
        rms = math.sqrt(float((a ** 2).mean())) if a.size else 0.0
        peak_db = 20 * math.log10(max(peak, 1e-9))
        rms_db = 20 * math.log10(max(rms, 1e-9))
        item["peakDb"] = round(peak_db, 2)
        item["rmsDb"] = round(rms_db, 2)
        item["silent"] = peak_db < SILENT_DB
        item["clips"] = peak_db > 0.0
    except Exception:
        item["loaded"] = False
    return item
