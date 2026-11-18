"""Minimal Universal Patch Model (PLAN 3.1).

Everything is in physical units (Hz, seconds, dB, semitones, cents); readers convert from
their own knob curves and the Vital writer converts into Vital's. Only the parts the current
readers need exist; fields are added as readers need them. Anything a reader cannot express
goes into `foreign` (verbatim) and into the report.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class Report:
    """Per-field outcome: exact count, approximated and dropped lists of {field, note}."""
    exact_count: int = 0
    approximated: list[dict] = field(default_factory=list)
    dropped: list[dict] = field(default_factory=list)

    def exact(self, _field: str = "") -> None:
        self.exact_count += 1

    def approx(self, field_: str, note: str) -> None:
        self.approximated.append({"field": field_, "note": note})

    def drop(self, field_: str, note: str) -> None:
        self.dropped.append({"field": field_, "note": note})

    def as_item(self) -> dict:
        return {"exact": self.exact_count, "approximated": list(self.approximated),
                "dropped": list(self.dropped)}

    @property
    def status(self) -> str:
        return "approx" if (self.approximated or self.dropped) else "ok"


@dataclass
class Meta:
    name: str = ""
    author: str = ""
    category: str = ""
    comments: str = ""
    source: dict = field(default_factory=dict)  # {synth, version, file}


@dataclass
class Osc:
    """One oscillator. `shape` is a basic single-cycle shape written as a Vital wavetable."""
    on: bool = True
    shape: str = "sine"              # sine | saw | square | triangle
    transpose: float = 0.0           # semitones (split into Vital transpose + tune by the writer)
    level: float = 1.0               # linear amplitude 0..1 (Vital level = sqrt of this)
    pan: float = 0.0                 # -1..1
    unison_voices: int = 1
    unison_detune_cents: float = 0.0
    phase_deg: float = 0.0
    random_phase: bool = True
    keytrack: bool = True            # False: fixed pitch (Vital 'midi track' off)
    destination: str = "filters"     # filters | direct
    fm_from: int | None = None       # index into Patch.oscillators of the FM modulator
    fm_index: float = 0.0            # peak phase-modulation index in radians (writer converts)
    fm_envelope: int | None = None   # Patch.envelopes index that scales fm_index (None = static)
    frames: list | None = None       # wavetable: list of single-cycle frames (any length each)
    frame_pos: float = 0.0           # 0..1 position across `frames`
    wt_name: str = ""


@dataclass
class Filter:
    on: bool = True
    model: str = "analog"            # analog|dirty|ladder|digital|diode|formant|comb|phaser
    mode: str = "lp"                 # lp | bp | hp | notch
    slope_db: int = 12               # 12 | 24
    cutoff_hz: float = 20000.0
    resonance: float = 0.0           # 0..1
    drive_db: float = 0.0
    keytrack: float = 0.0            # -1..1
    inputs: tuple[int, ...] = (0, 1, 2)   # oscillator indexes feeding it
    after: int | None = None         # serial: takes the output of filters[after]


@dataclass
class Envelope:
    """DAHDSR in seconds; sustain is linear 0..1."""
    delay: float = 0.0
    attack: float = 0.0
    hold: float = 0.0
    decay: float = 1.0
    sustain: float = 1.0
    release: float = 0.1


@dataclass
class Lfo:
    shape: str = "triangle"          # sine | triangle | saw | square
    rate_hz: float = 1.0
    phase: float = 0.0               # 0..1


@dataclass
class ModRoute:
    """source: env_N | lfo_N | velocity | note | mod_wheel (1-based N, as in Vital).
    dest: a Vital control name. amount: -1..1 as Vital stores it, unless `semitones` is set
    (filter cutoff routes), which the writer divides by the cutoff range."""
    source: str
    dest: str
    amount: float = 0.0
    semitones: float | None = None
    bipolar: bool = False


@dataclass
class Fx:
    kind: str                        # chorus|delay|reverb|distortion|phaser|flanger
    mix: float = 0.3                 # 0..1 wet
    params: dict[str, Any] = field(default_factory=dict)


@dataclass
class Voice:
    polyphony: int | None = None
    glide_s: float = 0.0
    bend_range: int | None = None


@dataclass
class Patch:
    meta: Meta = field(default_factory=Meta)
    oscillators: list[Osc] = field(default_factory=list)
    filters: list[Filter] = field(default_factory=list)
    envelopes: list[Envelope] = field(default_factory=list)   # [0] is the amp envelope
    lfos: list[Lfo] = field(default_factory=list)
    mod_matrix: list[ModRoute] = field(default_factory=list)
    fx: list[Fx] = field(default_factory=list)
    voice: Voice = field(default_factory=Voice)
    foreign: dict[str, Any] = field(default_factory=dict)
    report: Report = field(default_factory=Report)
