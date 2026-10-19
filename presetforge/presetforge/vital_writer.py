"""Generic UPM -> Vital writer (PLAN 3.3).

Starts from Vital's own init preset (data/vital_init.json, generated from vita) and overwrites
only the keys the Patch sets. Key names and ranges come from vita itself
(data/vital_ranges.json, see dev/gen_vital_data.py). Curves, all checked against
`vita.get_control_text`:
  envelope time  seconds = value ** 4            lfo / delay / chorus rate  Hz = 2 ** value
  filter cutoff  MIDI note, Hz = 440*2^((n-69)/12)   oscillator level  amplitude = value ** 2
  oscillator tune  value*100 cents                unison detune  cents = value ** 2
  reverb decay / glide  seconds = 2 ** value
"""

from __future__ import annotations

import base64
import copy
import functools
import json
import math
from importlib import resources
from pathlib import Path

import numpy as np

from .upm import ModRoute, Patch

WAVE_SIZE = 2048
SHAPES = ("sine", "saw", "square", "triangle")

# Vital's FM depth is not the textbook modulation index. Measured with vita (see
# dev/calibrate_fm.py): (osc_distortion_amount, equivalent peak phase-modulation index in rad).
FM_AMOUNT_TO_BETA: list[tuple[float, float]] = [
    (0.0, 0.0), (0.05, 0.1), (0.1, 0.4), (0.15, 0.85), (0.2, 1.5), (0.25, 2.35), (0.3, 3.4),
    (0.35, 4.65), (0.4, 6.05), (0.5, 9.45), (0.6, 13.6), (0.8, 27.3), (1.0, 40.0)]  # 1.0 extrapolated

FILTER_MODELS = ("analog", "dirty", "ladder", "digital", "diode", "formant", "comb", "phaser")


@functools.lru_cache(maxsize=1)
def _init_json() -> dict:
    return json.loads(resources.files("presetforge.data").joinpath("vital_init.json").read_text("utf-8"))


@functools.lru_cache(maxsize=1)
def _ranges() -> dict:
    return json.loads(resources.files("presetforge.data").joinpath("vital_ranges.json").read_text("utf-8"))


def wave_data(shape: str) -> str:
    """One 2048-sample float32 cycle, base64 (Vital's wave_data encoding)."""
    x = np.arange(WAVE_SIZE) / WAVE_SIZE
    if shape == "sine":
        w = np.sin(2 * np.pi * x)
    elif shape == "saw":
        w = 2 * x - 1
    elif shape == "square":
        w = np.where(x < 0.5, 1.0, -1.0)
    elif shape == "triangle":
        w = 2 * np.abs(2 * x - 1) - 1
    else:
        raise ValueError(f"unknown shape {shape}")
    return base64.b64encode(w.astype("<f4").tobytes()).decode("ascii")


def fm_index_to_amount(beta: float) -> float:
    """Phase-modulation index (radians) -> Vital FM depth, by interpolating the measured table."""
    pts = FM_AMOUNT_TO_BETA
    if beta <= 0:
        return 0.0
    if beta >= pts[-1][1]:
        return pts[-1][0]
    for (a0, b0), (a1, b1) in zip(pts, pts[1:]):
        if b0 <= beta <= b1:
            return a0 + (a1 - a0) * (beta - b0) / (b1 - b0) if b1 > b0 else a0
    return pts[-1][0]


def hz_to_note(hz: float) -> float:
    return 69 + 12 * math.log2(max(hz, 1e-3) / 440.0)


class _Settings:
    def __init__(self, settings: dict, patch: Patch):
        self.s = settings
        self.patch = patch

    def set(self, key: str, value: float, label: str | None = None) -> None:
        rng = _ranges().get(key)
        if rng is None or key not in self.s:
            raise KeyError(f"not a Vital control: {key}")
        lo, hi, discrete, _ = rng
        v = float(value)
        if discrete:
            v = float(round(v))
        if v < lo - 1e-9 or v > hi + 1e-9:
            clamped = min(max(v, lo), hi)
            self.patch.report.approx(label or key, f"{key}={value:.4g} outside Vital's range, clamped to {clamped:.4g}")
            v = clamped
        self.s[key] = v

    def option(self, key: str, name: str) -> None:
        opts = [o.lower() for o in _ranges()[key][3]]
        self.set(key, opts.index(name.lower()))


def _time_value(seconds: float) -> float:
    return max(seconds, 0.0) ** 0.25


def _lfo_points(shape: str) -> dict:
    if shape == "sine":
        return {"num_points": 5, "points": [0, .5, .25, 1, .5, .5, .75, 0, 1, .5], "powers": [0] * 5, "smooth": True}
    if shape == "saw":
        return {"num_points": 2, "points": [0, 1, 1, 0], "powers": [0, 0], "smooth": False}
    if shape == "square":
        return {"num_points": 4, "points": [0, 1, .5, 1, .5, 0, 1, 0], "powers": [0] * 4, "smooth": False}
    return {"num_points": 3, "points": [0, 1, .5, 0, 1, 1], "powers": [0, 0, 0], "smooth": False}


def build_vital(patch: Patch) -> dict:
    """Return the full Vital preset dict for `patch`."""
    doc = copy.deepcopy(_init_json())
    st = doc["settings"]
    S = _Settings(st, patch)
    rep = patch.report
    m = patch.meta
    doc["preset_name"] = m.name
    doc["author"] = m.author
    doc["preset_style"] = m.category
    doc["comments"] = m.comments

    # --- filters first (oscillator routing depends on them)
    filters = patch.filters[:2]
    if len(patch.filters) > 2:
        rep.drop("filters", f"{len(patch.filters) - 2} extra filter(s) beyond Vital's 2")
    for k in (1, 2):
        S.set(f"filter_{k}_on", 0)
    for i, f in enumerate(filters, 1):
        p = f"filter_{i}_"
        S.set(p + "on", 1 if f.on else 0)
        S.set(p + "model", FILTER_MODELS.index(f.model))
        blend = {"lp": 0.0, "bp": 1.0, "hp": 2.0, "notch": 1.0}[f.mode]
        style = 0 if f.slope_db <= 12 else 1
        if f.mode == "notch":
            style = 2   # Notch Blend
        S.set(p + "style", style)
        S.set(p + "blend", blend)
        S.set(p + "cutoff", hz_to_note(f.cutoff_hz), f"filter {i} cutoff")
        S.set(p + "resonance", f.resonance)
        S.set(p + "drive", f.drive_db)
        S.set(p + "keytrack", f.keytrack)

    # --- oscillators
    oscs = patch.oscillators[:3]
    if len(patch.oscillators) > 3:
        rep.drop("oscillators", f"{len(patch.oscillators) - 3} extra oscillator(s) beyond Vital's 3")
    for n in (1, 2, 3):
        S.set(f"osc_{n}_on", 0)
    fm_sources = {1: (2, 3), 2: (1, 3), 3: (1, 2)}
    extra_routes: list[ModRoute] = []
    for n, o in enumerate(oscs, 1):
        p = f"osc_{n}_"
        wt = st["wavetables"][n - 1]
        wt["name"] = o.shape.capitalize()
        wt["groups"][0]["components"][0]["keyframes"][0]["wave_data"] = wave_data(o.shape)
        S.set(p + "on", 1 if o.on else 0)
        whole = int(round(o.transpose))
        S.set(p + "transpose", whole)
        S.set(p + "tune", o.transpose - whole)   # Vital tune: +-1 = +-100 cents
        S.set(p + "level", math.sqrt(max(o.level, 0.0)))
        S.set(p + "pan", o.pan)
        S.set(p + "unison_voices", max(1, o.unison_voices))
        S.set(p + "unison_detune", math.sqrt(max(o.unison_detune_cents, 0.0)))
        S.set(p + "phase", (o.phase_deg % 360.0) / 360.0)
        S.set(p + "random_phase", 1.0 if o.random_phase else 0.0)
        S.set(p + "midi_track", 1 if o.keytrack else 0)
        dest = 4 if o.destination == "direct" else 0
        if o.destination != "direct" and filters:
            f1 = (n - 1) in filters[0].inputs
            f2 = len(filters) > 1 and (n - 1) in filters[1].inputs
            dest = 2 if (f1 and f2) else 1 if f2 else 0
        S.set(p + "destination", dest)
        if o.fm_from is not None and o.fm_from < len(oscs) and o.fm_from != n - 1:
            slot = fm_sources[n].index(o.fm_from + 1)
            S.set(p + "distortion_type", 7 + slot)
            amt = fm_index_to_amount(o.fm_index)
            if o.fm_envelope is not None:
                S.set(p + "distortion_amount", 0.0)
                extra_routes.append(ModRoute(f"env_{o.fm_envelope + 1}", p + "distortion_amount", amt))
            else:
                S.set(p + "distortion_amount", amt)

    # --- envelopes / lfos
    for i, e in enumerate(patch.envelopes[:6], 1):
        p = f"env_{i}_"
        S.set(p + "delay", _time_value(e.delay), f"envelope {i} delay")
        S.set(p + "attack", _time_value(e.attack), f"envelope {i} attack")
        S.set(p + "hold", _time_value(e.hold), f"envelope {i} hold")
        S.set(p + "decay", _time_value(e.decay), f"envelope {i} decay")
        S.set(p + "sustain", e.sustain, f"envelope {i} sustain")
        S.set(p + "release", _time_value(e.release), f"envelope {i} release")
    if len(patch.envelopes) > 6:
        rep.drop("envelopes", f"{len(patch.envelopes) - 6} extra envelope(s) beyond Vital's 6")
    for i, l in enumerate(patch.lfos[:8], 1):
        st["lfos"][i - 1].update({"name": l.shape.capitalize(), **_lfo_points(l.shape)})
        S.set(f"lfo_{i}_sync", 0)
        S.set(f"lfo_{i}_frequency", math.log2(max(l.rate_hz, 1e-3)), f"lfo {i} rate")
        S.set(f"lfo_{i}_phase", l.phase)
    if len(patch.lfos) > 8:
        rep.drop("lfos", f"{len(patch.lfos) - 8} extra LFO(s) beyond Vital's 8")

    # --- effects
    for fx in patch.fx:
        _write_fx(S, fx)

    # --- voice
    v = patch.voice
    if v.polyphony:
        S.set("polyphony", v.polyphony)
    if v.bend_range is not None:
        S.set("pitch_bend_range", v.bend_range)
    if v.glide_s > 0:
        S.set("portamento_time", math.log2(v.glide_s), "glide")

    # --- mod matrix
    routes = list(patch.mod_matrix) + extra_routes
    for k, r in enumerate(routes[:64]):
        rng = _ranges().get(r.dest)
        if rng is None:
            raise KeyError(f"not a Vital control: {r.dest}")
        amount = r.amount if r.semitones is None else r.semitones / (rng[1] - rng[0])
        st["modulations"][k] = {"source": r.source, "destination": r.dest}
        st[f"modulation_{k + 1}_amount"] = max(-1.0, min(1.0, amount))
        st[f"modulation_{k + 1}_bipolar"] = 1.0 if r.bipolar else 0.0
    if len(routes) > 64:
        rep.drop("modulation", f"{len(routes) - 64} route(s) beyond Vital's 64 slots")
    return doc


def _write_fx(S: _Settings, fx) -> None:
    k, pr = fx.kind, fx.params
    if k == "chorus":
        S.set("chorus_on", 1)
        S.set("chorus_dry_wet", fx.mix)
        S.set("chorus_sync", 0)
        if "rate_hz" in pr:
            S.set("chorus_frequency", math.log2(max(pr["rate_hz"], 1e-3)))
        for a, b in (("depth", "chorus_mod_depth"), ("feedback", "chorus_feedback"), ("voices", "chorus_voices")):
            if a in pr:
                S.set(b, pr[a])
    elif k == "delay":
        S.set("delay_on", 1)
        S.set("delay_dry_wet", fx.mix)
        S.set("delay_sync", 0)
        if "time_s" in pr:
            S.set("delay_frequency", -math.log2(max(pr["time_s"], 1e-3)))
        if "feedback" in pr:
            S.set("delay_feedback", pr["feedback"])
        if "style" in pr:
            S.option("delay_style", pr["style"])
    elif k == "reverb":
        S.set("reverb_on", 1)
        S.set("reverb_dry_wet", fx.mix)
        if "decay_s" in pr:
            S.set("reverb_decay_time", math.log2(max(pr["decay_s"], 1e-3)))
        if "size" in pr:
            S.set("reverb_size", pr["size"])
    elif k == "distortion":
        S.set("distortion_on", 1)
        S.set("distortion_mix", fx.mix)
        if "type" in pr:
            S.option("distortion_type", pr["type"])
        if "drive_db" in pr:
            S.set("distortion_drive", pr["drive_db"])
    elif k in ("phaser", "flanger"):
        S.set(f"{k}_on", 1)
        S.set(f"{k}_dry_wet", fx.mix)
        S.set(f"{k}_sync", 0)
        if "rate_hz" in pr:
            S.set(f"{k}_frequency", math.log2(max(pr["rate_hz"], 1e-3)))
        for a, b in (("depth", f"{k}_mod_depth"), ("feedback", f"{k}_feedback")):
            if a in pr:
                S.set(b, pr[a])
    else:
        S.patch.report.drop(f"fx {k}", "effect type not supported by the writer")


def write_vital(patch: Patch, path: str | Path) -> None:
    doc = build_vital(patch)
    Path(path).write_text(json.dumps(doc, separators=(",", ":")), encoding="utf-8")
