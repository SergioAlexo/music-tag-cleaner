"""Surge XT reader (PLAN 8.2).

File layout (read from Surge's source, src/common/PatchFileHeaderStructs.h and SurgePatch.cpp):

  VST2 program file, big-endian:
    'CcnK' | byteSize | 'FPCh' | version | fxID 'cjs3' | fxVersion | numPrograms
    | programName[28] | chunkSize | chunk[chunkSize]
  chunk, little-endian:
    'sub3' | xmlSize u32 | wtSize[2][3] u32 | patch XML (xmlSize bytes)
    | for each scene/oscillator with wtSize != 0: wt_header (tag 'vawt', n_samples u32,
      n_tables u16, flags u16) + frames (int16 if flags&4, else float32)

The XML holds every parameter as `<a_osc1_type type="0" value="2"/>` in natural units (semitones,
log2 seconds, dB ...), with `a_` = scene A and `b_` = scene B, and optional `<modrouting>` children
with depths in the parameter's own units. Unit conversions below were checked against
Parameter.cpp. Only scene A (or B when it is the sole active scene) is converted.
"""

from __future__ import annotations

import math
import re
import struct
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field

import numpy as np

from ..upm import Envelope, Filter, Fx, Lfo, ModRoute, Osc, Patch, Voice

SURGE_ID = b"cjs3"


class SurgeError(ValueError):
    pass


@dataclass
class SurgeFile:
    name: str
    xml: ET.Element
    revision: int
    wavetables: dict[tuple[int, int], tuple[int, list[np.ndarray]]] = field(default_factory=dict)


def looks_like_surge(head: bytes) -> bool:
    return head[:4] == b"CcnK" and head[8:12] == b"FPCh" and head[16:20] == SURGE_ID


def program_name(head: bytes) -> str:
    return head[28:56].split(b"\0", 1)[0].decode("latin-1").strip()


def parse_fxp(data: bytes) -> SurgeFile:
    if len(data) < 60 or not looks_like_surge(data):
        raise SurgeError("not a Surge XT .fxp (VST2 FPCh program with plugin id cjs3)")
    chunk_size = struct.unpack(">i", data[56:60])[0]
    chunk = data[60:60 + chunk_size] if 0 < chunk_size <= len(data) - 60 else data[60:]
    if len(chunk) < 32 or chunk[:4] != b"sub3":
        raise SurgeError("unknown Surge patch chunk (expected 'sub3' header)")
    xml_size = struct.unpack("<I", chunk[4:8])[0]
    wt_sizes = struct.unpack("<6I", chunk[8:32])
    if xml_size > len(chunk) - 32:
        raise SurgeError("patch XML is truncated")
    raw = chunk[32:32 + xml_size]
    if b"<!DOCTYPE" in raw or b"<!ENTITY" in raw:
        raise SurgeError("patch XML contains a DTD, refusing to parse")
    try:
        root = ET.fromstring(raw.decode("utf-8", "replace"))
    except ET.ParseError as exc:
        raise SurgeError(f"patch XML is not valid: {exc}") from exc
    if root.tag != "patch":
        raise SurgeError("patch XML has no <patch> root")
    rev = int(root.get("revision", "0") or 0)
    meta = root.find("meta")
    name = (meta.get("name") if meta is not None else None) or program_name(data) or "Surge patch"
    sf = SurgeFile(name=name, xml=root, revision=rev)
    pos = 32 + xml_size
    for i, size in enumerate(wt_sizes):
        if not size:
            continue
        sc, osc = divmod(i, 3)
        blob = chunk[pos:pos + size]
        pos += size
        frames = _parse_wt(blob)
        if frames:
            sf.wavetables[(sc, osc)] = frames
    return sf


def _parse_wt(blob: bytes) -> tuple[int, list[np.ndarray]] | None:
    if len(blob) < 12 or blob[:4] != b"vawt":
        return None
    n_samples, n_tables, flags = struct.unpack("<IHH", blob[4:12])
    if n_samples < 2 or n_tables < 1:
        return None
    count = n_samples * n_tables
    body = blob[12:]
    if flags & 4:
        if len(body) < count * 2:
            return None
        a = np.frombuffer(body, dtype="<i2", count=count).astype(np.float64)
        a /= 32768.0 if flags & 8 else 16384.0
    else:
        if len(body) < count * 4:
            return None
        a = np.frombuffer(body, dtype="<f4", count=count).astype(np.float64)
    return flags, [a[i * n_samples:(i + 1) * n_samples] for i in range(n_tables)]


class _Params:
    """Typed access to the <parameters> values of one file."""

    def __init__(self, root: ET.Element):
        self.el: dict[str, ET.Element] = {}
        params = root.find("parameters")
        if params is not None:
            for e in params:
                self.el[e.tag] = e

    def f(self, name: str, default: float = 0.0) -> float:
        e = self.el.get(name)
        if e is None:
            return default
        try:
            v = float(e.get("value", default))
        except ValueError:
            return default
        return v if math.isfinite(v) else default

    def i(self, name: str, default: int = 0) -> int:
        return int(round(self.f(name, default)))

    def routes(self, name: str) -> list[tuple[int, float]]:
        e = self.el.get(name)
        out = []
        if e is not None:
            for mr in e.findall("modrouting"):
                if mr.get("muted") == "1":
                    continue
                try:
                    out.append((int(mr.get("source", "-1")), float(mr.get("depth", "0"))))
                except ValueError:
                    pass
        return out


# modsources enum (ModulationSource.h)
MS_VELOCITY, MS_KEYTRACK, MS_AFTERTOUCH, MS_MODWHEEL = 1, 2, 4, 6
MS_AMPEG, MS_FILTEREG, MS_LFO1, MS_LFO_LAST = 15, 16, 17, 28

OSC_NAMES = {0: "classic", 1: "sine", 2: "wavetable", 3: "sample & hold noise", 4: "audio input", 5: "FM3",
             6: "FM2", 7: "window", 8: "modern", 9: "string", 10: "twist", 11: "alias"}

# filter type (sv14 enum; later additions appended): (vital model, mode, slope_db, exact?)
_FILTERS = {
    1: ("analog", "lp", 12, True), 2: ("analog", "lp", 24, True), 3: ("ladder", "lp", 24, False),
    4: ("analog", "hp", 12, True), 5: ("analog", "hp", 24, True), 6: ("analog", "bp", 12, True),
    7: ("analog", "notch", 12, True), 8: ("comb", "lp", 12, False), 10: ("ladder", "lp", 24, False),
    11: ("analog", "lp", 12, False), 12: ("ladder", "lp", 24, False), 13: ("dirty", "lp", 24, False),
    14: ("dirty", "hp", 24, False), 15: ("diode", "lp", 24, False), 16: ("dirty", "lp", 24, False),
    17: ("dirty", "hp", 24, False), 18: ("dirty", "notch", 24, False), 19: ("dirty", "bp", 24, False),
    20: ("analog", "hp", 12, False), 21: ("analog", "notch", 12, False), 22: ("analog", "bp", 12, False),
    23: ("analog", "bp", 24, False), 24: ("analog", "notch", 24, False), 25: ("comb", "lp", 12, False),
    27: ("dirty", "lp", 24, False), 28: ("dirty", "hp", 24, False), 29: ("dirty", "notch", 24, False),
    30: ("dirty", "bp", 24, False),
}
_FILTER_NAMES = {9: "sample & hold", 26: "all-pass", 31: "tri-pole"}

_LFO_SHAPES = {0: "sine", 1: "triangle", 2: "square", 3: "saw"}
_LFO_OTHER = {4: "noise", 5: "sample & hold", 6: "envelope", 7: "step sequencer", 8: "MSEG", 9: "formula"}

_FX_ORDER = (0, 1, 8, 9, 4, 5, 12, 13, 6, 7, 14, 15)    # 0-based fx slots: A inserts, sends, globals
_FX_NAMES = {1: "delay", 2: "reverb", 3: "phaser", 4: "rotary speaker", 5: "distortion", 6: "eq",
             7: "frequency shifter", 8: "conditioner", 9: "chorus", 10: "vocoder", 11: "reverb",
             12: "flanger", 13: "ring modulator", 14: "airwindows", 15: "neuron", 16: "graphic eq",
             17: "resonator", 18: "chow", 19: "exciter", 20: "ensemble", 21: "combulator", 22: "nimbus",
             23: "tape", 24: "treemonster", 25: "waveshaper", 26: "mid-side tool", 27: "spring reverb",
             28: "bonsai", 29: "audio input", 30: "floaty delay", 31: "convolution"}


def _classic_shape(v: float) -> str:
    if v <= -0.5:
        return "square"
    if v >= 0.5:
        return "triangle"
    return "saw"


def to_patch(sf: SurgeFile, source_file: str = "") -> Patch:
    p = Patch()
    rep = p.report
    P = _Params(sf.xml)
    meta = sf.xml.find("meta")
    p.meta.name = sf.name
    if meta is not None:
        p.meta.author = meta.get("author", "") or ""
        p.meta.category = meta.get("category", "") or ""
        p.meta.comments = meta.get("comment", "") or ""
    p.meta.source = {"synth": "surge", "version": f"patch revision {sf.revision}", "file": source_file}

    # ---- scenes
    mode = P.i("scenemode")
    active = P.i("scene_active")
    sc = 0
    if mode == 0:
        sc = 1 if active == 1 else 0
        if sc == 1:
            rep.approx("scene", "only scene B is active in this single-scene patch; scene B was converted")
    else:
        names = {1: "split", 2: "layer", 3: "channel split"}
        rep.drop("scene B", f"{names.get(mode, 'multi-scene')} patch: scene B is not converted (scene A only)")
    pre = "ab"[sc] + "_"

    # ---- oscillators
    scene_semis = 12 * P.i(pre + "octave") + P.f(pre + "pitch")
    levels: list[float] = []
    osc_idx: dict[int, int] = {}      # surge osc number -> index in p.oscillators
    routes: list[int] = []
    for n in (1, 2, 3):
        k = f"{pre}osc{n}_"
        typ = P.i(k + "type")
        lvl = P.f(f"{pre}level_o{n}", 1.0)
        if f"{pre}level_o{n}" not in P.el or P.i(f"{pre}mute_o{n}") or lvl <= 1e-4:
            continue
        o = Osc(random_phase=True)
        o.level = lvl ** 3
        o.transpose = scene_semis + 12 * P.i(k + "octave") + P.f(k + "pitch")
        o.keytrack = bool(P.i(k + "keytrack", 1))
        label = f"oscillator {n}"
        if typ in (0, 1, 2, 7, 8):
            o.unison_voices = max(1, min(16, P.i(k + "param6", 1)))
            if o.unison_voices > 1:
                o.unison_detune_cents = 100.0 * max(0.0, P.f(k + "param5"))
                rep.approx(label + " unison", "Surge unison detune spread converted at 100 cents per unit; "
                           "Vital's spread law differs")
        if typ == 0:
            o.shape = _classic_shape(P.f(k + "param0"))
            rep.approx(label, f"classic oscillator shape/width/sub/sync approximated by a basic {o.shape} wave")
        elif typ == 1:
            o.shape = "sine"
            rep.exact(label)
        elif typ in (2, 7):
            wt = sf.wavetables.get((sc, n - 1))
            if wt is None:
                o.shape = "saw"
                rep.approx(label, "wavetable is not embedded in the patch (factory table by name); "
                           "replaced by a saw wave")
            else:
                o.frames = wt[1]
                o.frame_pos = max(0.0, min(1.0, P.f(k + "param0")))
                o.wt_name = "Surge wavetable"
                if typ == 2:
                    rep.exact(label)
                else:
                    rep.approx(label, "window oscillator rendered as its raw wavetable (window synthesis differs)")
        elif typ == 8:
            o.shape = "saw"
            rep.approx(label, "modern oscillator approximated by a saw wave")
        elif typ in (5, 6):
            o.shape = "sine"
            rep.approx(label, f"{OSC_NAMES[typ]} oscillator approximated by a sine; its FM is not mapped")
        elif typ in (9, 10, 11):
            o.shape = "saw"
            rep.approx(label, f"{OSC_NAMES[typ]} oscillator approximated by a saw wave")
        else:
            rep.drop(label, f"{OSC_NAMES.get(typ, 'unknown')} oscillator has no Vital equivalent")
            continue
        osc_idx[n] = len(p.oscillators)
        routes.append(P.i(f"{pre}route_o{n}", 1))
        p.oscillators.append(o)
        levels.append(o.level)
        if len(p.oscillators) == 3:
            break
    total = sum(levels)
    if total > 1.0:
        for o in p.oscillators:
            o.level /= total
        rep.approx("oscillator levels", "levels scaled down together so the oscillator sum does not exceed 1.0")
    for what, lv, rt in (("noise", f"{pre}level_noise", f"{pre}route_noise"),
                         ("ring modulator 1x2", f"{pre}level_ring12", None),
                         ("ring modulator 2x3", f"{pre}level_ring23", None)):
        if P.f(lv) > 1e-4 and not P.i(lv.replace("level", "mute")):
            rep.drop(what, f"{what} source is audible in the patch but Vital has no matching source")
    if P.i(pre + "fm_switch"):
        rep.drop("FM", "oscillator FM routing (1>2>3) is not mapped")
    if P.f(pre + "feedback") != 0:
        rep.drop("filter feedback", "filter feedback has no Vital equivalent")
    if not p.oscillators:
        raise SurgeError("no audible oscillator in the active scene (noise-only and ring-mod-only patches are not supported)")

    # ---- filters
    cfg = P.i(pre + "fb_config")
    for f_i in (1, 2):
        k = f"{pre}filter{f_i}_"
        typ = P.i(k + "type")
        if typ == 0:
            continue
        spec = _FILTERS.get(typ)
        if spec is None:
            rep.drop(f"filter {f_i}", f"filter type {_FILTER_NAMES.get(typ, typ)} has no Vital equivalent")
            continue
        model, mode_, slope, exact = spec
        fl = Filter(model=model, mode=mode_, slope_db=slope,
                    cutoff_hz=440.0 * 2 ** (P.f(k + "cutoff", 3.0) / 12.0),
                    resonance=max(0.0, min(1.0, P.f(k + "resonance"))),
                    keytrack=max(-1.0, min(1.0, P.f(k + "keytrack"))))
        fl.inputs = tuple(range(len(p.oscillators)))
        fi = len(p.filters)
        if f_i == 1:
            fl.inputs = tuple(i for i, r in enumerate(routes) if r in (0, 1))
        else:
            if cfg in (0, 1, 2):
                fl.after = 0 if p.filters else None
                fl.inputs = ()
            else:
                fl.inputs = tuple(i for i, r in enumerate(routes) if r in (1, 2))
        if f_i == 2 and not p.filters:
            fl.inputs = tuple(range(len(p.oscillators)))
        p.filters.append(fl)
        if exact:
            rep.exact(f"filter {f_i} type")
        else:
            rep.approx(f"filter {f_i} type", f"filter type {typ} approximated by Vital's {model} {mode_} "
                       f"{slope} dB model")
        rep.approx(f"filter {f_i} resonance", "resonance 0..1 copied as is; the response curves differ")
        em = P.f(k + "envmod")
        if abs(em) > 1e-6:
            p.mod_matrix.append(ModRoute("env_2", f"filter_{len(p.filters)}_cutoff", semitones=em))
            rep.exact(f"filter {f_i} envelope amount")
    if len(p.filters) == 2 and P.i(pre + "f2_cf_is_offset"):
        rep.approx("filter 2", "cutoff offset mode (relative to filter 1) treated as absolute cutoff")
    if P.i(pre + "ws_type"):
        rep.drop("waveshaper", "the per-voice waveshaper is not mapped")

    # ---- envelopes: Surge env 1 = amp, env 2 = filter
    for e_i in (1, 2):
        k = f"{pre}env{e_i}_"
        p.envelopes.append(Envelope(
            attack=2 ** P.f(k + "attack", -8.0), decay=2 ** P.f(k + "decay", 0.0),
            sustain=max(0.0, min(1.0, P.f(k + "sustain", 1.0))), release=2 ** P.f(k + "release", -3.0)))
    rep.approx("envelopes", "Surge ADSR (times 2^value s) copied to Vital; segment curve shapes are not mapped")

    # ---- modulation routings
    lfo_map: dict[int, int] = {}

    def vital_source(src: int) -> str | None:
        if src == MS_VELOCITY:
            return "velocity"
        if src == MS_KEYTRACK:
            return "note"
        if src == MS_AFTERTOUCH:
            return "aftertouch"
        if src == MS_MODWHEEL:
            return "mod_wheel"
        if src == MS_FILTEREG:
            return "env_2"
        if src == MS_AMPEG:
            return "env_1"
        if MS_LFO1 <= src <= MS_LFO_LAST:
            idx = src - MS_LFO1
            if idx not in lfo_map:
                if len(lfo_map) >= 8:
                    return None
                shape = int(round(P.f(f"{pre}lfo{idx}_shape")))
                if shape not in _LFO_SHAPES:
                    rep.drop(f"lfo {idx + 1}", f"{_LFO_OTHER.get(shape, 'unknown')} LFO shape has no Vital equivalent")
                    lfo_map[idx] = -1
                    return None
                p.lfos.append(Lfo(shape=_LFO_SHAPES[shape], rate_hz=2 ** P.f(f"{pre}lfo{idx}_rate"),
                                  phase=P.f(f"{pre}lfo{idx}_phase") % 1.0))
                lfo_map[idx] = len(p.lfos)
                if sf.xml.find("parameters") is not None and \
                        (P.el.get(f"{pre}lfo{idx}_rate") is not None and P.el[f"{pre}lfo{idx}_rate"].get("temposync") == "1"):
                    rep.approx(f"lfo {idx + 1}", "tempo-synced rate treated as free-running Hz")
            return f"lfo_{lfo_map[idx]}" if lfo_map[idx] > 0 else None
        return None

    unmapped = 0
    targets: list[tuple[str, str, str]] = []     # (surge param, vital dest, kind)
    for fi, fl in enumerate(p.filters):
        s_idx = 1 if fi == 0 else 2
        targets.append((f"{pre}filter{s_idx}_cutoff", f"filter_{fi + 1}_cutoff", "semitones"))
        targets.append((f"{pre}filter{s_idx}_resonance", f"filter_{fi + 1}_resonance", "amount"))
    for n, vi in osc_idx.items():
        targets.append((f"{pre}osc{n}_pitch", f"osc_{vi + 1}_tune", "tune"))
    seen_targets = set()
    for sname, dest, kind in targets:
        seen_targets.add(sname)
        for src, depth in P.routes(sname):
            vs = vital_source(src)
            if vs is None:
                unmapped += 1
                continue
            bip = vs.startswith("lfo_") and not P.i(f"{pre}lfo{src - MS_LFO1}_unipolar")
            if kind == "semitones":
                p.mod_matrix.append(ModRoute(vs, dest, semitones=depth, bipolar=bip))
            elif kind == "tune":
                amt = depth / 2.0
                if abs(amt) > 1.0:
                    rep.approx("pitch modulation", "oscillator pitch modulation limited to +-2 semitones (Vital tune range)")
                p.mod_matrix.append(ModRoute(vs, dest, amount=max(-1.0, min(1.0, amt)), bipolar=bip))
            else:
                p.mod_matrix.append(ModRoute(vs, dest, amount=max(-1.0, min(1.0, depth)), bipolar=bip))
    for name, e in P.el.items():
        if name.startswith(pre) and name not in seen_targets and e.find("modrouting") is not None:
            unmapped += len(P.routes(name))
    if unmapped:
        rep.drop("modulation", f"{unmapped} modulation routing(s) to other parameters or from other sources "
                 "(macros, MIDI controllers, ...) were not mapped")
    if p.mod_matrix:
        rep.approx("modulation", "depths copied in the destination's native units; curves may differ")

    # ---- voice
    pm = P.i(pre + "polymode")
    pl = P.i("polylimit", 8)
    if pm in (1, 2, 3, 5):
        p.voice.polyphony = 1
    elif pl > 0:
        p.voice.polyphony = max(1, min(32, pl))
    port = P.f(pre + "portamento", -8.0)
    if port > -7.0:
        p.voice.glide_s = 2 ** port
    bu = P.i(pre + "pbrange_up", 2)
    p.voice.bend_range = max(0, min(48, bu))
    if P.i(pre + "pbrange_dn", 2) != bu:
        rep.approx("pitch bend", "separate up/down ranges collapsed to the up range")

    # ---- effects (scene A inserts, sends, globals; scene B inserts dropped)
    kinds_done: set[str] = set()
    n_dropped_fx = 0
    for slot in _FX_ORDER:
        if slot in (2, 3, 10, 11) and sc == 0:
            continue
        t = P.i(f"fx{slot + 1}_type")
        if t == 0:
            continue
        if slot in (4, 5, 12, 13):
            send = P.f(f"{pre}send_fx_{1 + (slot in (5, 13))}")
            if send <= 1e-4:
                continue
        fx = _convert_fx(P, slot + 1, t)
        if fx is None:
            rep.drop(f"fx {slot + 1}", f"{_FX_NAMES.get(t, t)} effect has no Vital equivalent")
            n_dropped_fx += 1
            continue
        if fx.kind in kinds_done:
            rep.drop(f"fx {slot + 1}", f"second {fx.kind} effect (Vital has one of each)")
            continue
        kinds_done.add(fx.kind)
        p.fx.append(fx)
        rep.approx(f"fx {slot + 1}", f"{_FX_NAMES.get(t, t)} parameters mapped by name, not by curve")
    if any(P.i(f"fx{s + 1}_type") for s in (2, 3, 10, 11)) and sc == 0:
        rep.drop("scene B effects", "scene B insert effects are not converted")
    if P.i("fx_bypass"):
        rep.approx("effects", "Surge FX bypass setting is ignored")
    return p


def _pct(v: float) -> float:
    return max(0.0, min(1.0, v))


def _convert_fx(P: _Params, n: int, t: int) -> Fx | None:
    g = lambda i, d=0.0: P.f(f"fx{n}_p{i}", d)   # noqa: E731
    if t == 1:      # delay: time L, feedback, mix
        return Fx("delay", _pct(g(10, 0.3)), {"time_s": 2 ** g(0, -1.0), "feedback": _pct(g(2, 0.4))})
    if t == 2:      # reverb 1
        return Fx("reverb", _pct(g(9, 0.3)), {"decay_s": max(0.1, 2 ** g(3, 0.0)), "size": _pct(g(2, 0.5))})
    if t == 11:     # reverb 2
        return Fx("reverb", _pct(g(9, 0.3)), {"decay_s": max(0.1, 2 ** g(2, 0.0)), "size": _pct((g(1, 0.0) + 1) / 2)})
    if t == 9:      # chorus
        return Fx("chorus", _pct(g(6, 0.5)), {"rate_hz": 2 ** g(1, -1.0), "depth": _pct(g(2, 0.5)),
                                               "feedback": _pct(g(3, 0.0))})
    if t == 3:      # phaser
        return Fx("phaser", _pct(g(6, 0.5)), {"rate_hz": 2 ** g(3, -1.0), "depth": _pct(g(4, 0.5)),
                                               "feedback": _pct(abs(g(1, 0.0)))})
    if t == 12:     # flanger (mix is bipolar)
        return Fx("flanger", _pct(abs(g(10, 0.5))), {"rate_hz": 2 ** g(2, -1.0), "depth": _pct(g(3, 0.5)),
                                                      "feedback": _pct(g(7, 0.0))})
    if t == 5:      # distortion
        model = int(round(g(11, 0)))
        typ = {0: "soft clip", 1: "hard clip", 2: "soft clip", 3: "sine fold", 4: "bit crush"}.get(model, "soft clip")
        return Fx("distortion", 1.0, {"type": typ, "drive_db": max(0.0, min(30.0, g(4, 0.0)))})
    return None


def patches_from_file(path: str) -> tuple[list[Patch], list[str]]:
    with open(path, "rb") as fh:
        data = fh.read()
    sf = parse_fxp(data)
    return [to_patch(sf, path)], []
