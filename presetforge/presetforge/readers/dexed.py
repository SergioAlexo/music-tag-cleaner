"""Dexed / Yamaha DX7 reader (PLAN 8.5).

Reads DX7 SysEx: a 32-voice bulk dump (4104 bytes: F0 43 0n 09 20 00, 32 x 128 packed bytes,
checksum, F7; a bare 4096-byte packed bank is also accepted) or a single-voice VCED dump
(F0 43 0n 00 01 1B, 155 bytes, checksum, F7).

Mapping to Vital (3 oscillators, FM from one other oscillator):
  * the 32 algorithm topologies come from Dexed's fm_core.cc operator flags, evaluated here to
    "who modulates whom" (the numbers are facts about the DX7, no code is copied);
  * operators with output level 0 are inactive; up to 3 active operators map directly
    (carriers -> audible sine oscillators, modulators -> silent sine oscillators that FM their
    target); with more, the weakest operators are removed (a removed modulator's own modulators
    are re-routed to its targets) and everything removed is reported;
  * each operator's amplitude uses Dexed's level table (0.75 dB per output-level step), the
    modulation index of the loudest modulator setting is 4*pi rad (Dexed's convention), and
    Vital's FM depth is looked up from the vita-measured table in vital_writer;
  * envelopes: Dexed's rate -> units-per-block increments and level table -> seconds, see
    `stage_seconds`. A DX7 envelope is 4 rates/4 levels (L4 start, R1->L1, R2->L2, R3->L3 held,
    R4->L4 on release); it becomes Vital attack/decay/sustain/release. The curve shape differs
    (DX7 is linear in dB), so envelopes are always reported as approximated.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from ..upm import Envelope, Lfo, ModRoute, Osc, Patch

BULK_HEADER = bytes([0xF0, 0x43, 0x00, 0x09, 0x20, 0x00])
BULK_SIZE = 4104
SINGLE_SIZE = 163
VCED_SIZE = 155
PACKED_SIZE = 128

# Dexed fm_core.cc: one flag byte per operator (index 0 = OP6). Low bits 0-1 output bus
# (0 = audio out), bit 2 add, bits 4-5 input bus, bit 6/7 feedback in/out.
_ALGORITHMS = [
    (0xc1, 0x11, 0x11, 0x14, 0x01, 0x14), (0x01, 0x11, 0x11, 0x14, 0xc1, 0x14),
    (0xc1, 0x11, 0x14, 0x01, 0x11, 0x14), (0xc1, 0x11, 0x94, 0x01, 0x11, 0x14),
    (0xc1, 0x14, 0x01, 0x14, 0x01, 0x14), (0xc1, 0x94, 0x01, 0x14, 0x01, 0x14),
    (0xc1, 0x11, 0x05, 0x14, 0x01, 0x14), (0x01, 0x11, 0xc5, 0x14, 0x01, 0x14),
    (0x01, 0x11, 0x05, 0x14, 0xc1, 0x14), (0x01, 0x05, 0x14, 0xc1, 0x11, 0x14),
    (0xc1, 0x05, 0x14, 0x01, 0x11, 0x14), (0x01, 0x05, 0x05, 0x14, 0xc1, 0x14),
    (0xc1, 0x05, 0x05, 0x14, 0x01, 0x14), (0xc1, 0x05, 0x11, 0x14, 0x01, 0x14),
    (0x01, 0x05, 0x11, 0x14, 0xc1, 0x14), (0xc1, 0x11, 0x02, 0x25, 0x05, 0x14),
    (0x01, 0x11, 0x02, 0x25, 0xc5, 0x14), (0x01, 0x11, 0x11, 0xc5, 0x05, 0x14),
    (0xc1, 0x14, 0x14, 0x01, 0x11, 0x14), (0x01, 0x05, 0x14, 0xc1, 0x14, 0x14),
    (0x01, 0x14, 0x14, 0xc1, 0x14, 0x14), (0xc1, 0x14, 0x14, 0x14, 0x01, 0x14),
    (0xc1, 0x14, 0x14, 0x01, 0x14, 0x04), (0xc1, 0x14, 0x14, 0x14, 0x04, 0x04),
    (0xc1, 0x14, 0x14, 0x04, 0x04, 0x04), (0xc1, 0x05, 0x14, 0x01, 0x14, 0x04),
    (0x01, 0x05, 0x14, 0xc1, 0x14, 0x04), (0x04, 0xc1, 0x11, 0x14, 0x01, 0x14),
    (0xc1, 0x14, 0x01, 0x14, 0x04, 0x04), (0x04, 0xc1, 0x11, 0x14, 0x04, 0x04),
    (0xc1, 0x14, 0x04, 0x04, 0x04, 0x04), (0xc4, 0x04, 0x04, 0x04, 0x04, 0x04),
]

# Dexed env.cc levellut / scaleoutlevel, lfo.cc lfoSource (Hz), dx7note.cc pitchmodsenstab.
_LEVEL_LUT = [0, 5, 9, 13, 17, 20, 23, 25, 27, 29, 31, 33, 35, 37, 39, 41, 42, 43, 45, 46]
_LFO_HZ = [
    0.062541, 0.125031, 0.312393, 0.43712, 0.62461, 0.750694, 0.93633, 1.125302, 1.249609,
    1.436782, 1.560915, 1.752081, 1.875117, 2.062494, 2.247191, 2.374451, 2.560492, 2.686728,
    2.873976, 2.99895, 3.188013, 3.36984, 3.500175, 3.682224, 3.812065, 4.0008, 4.186202,
    4.310716, 4.50126, 4.623209, 4.814636, 4.93048, 5.121901, 5.315191, 5.434783, 5.617346,
    5.750431, 5.946717, 6.062811, 6.248438, 6.431695, 6.564264, 6.74946, 6.868132, 7.052186,
    7.25058, 7.375719, 7.556294, 7.687577, 7.877738, 7.993605, 8.181967, 8.372405, 8.504848,
    8.685079, 8.810573, 8.986341, 9.122423, 9.300595, 9.500285, 9.607994, 9.798158, 9.950249,
    10.117361, 11.251125, 11.384335, 12.562814, 13.676149, 13.904338, 15.092062, 16.366612,
    16.638935, 17.869907, 19.193858, 19.425019, 20.833333, 21.034918, 22.50225, 24.003841,
    24.260068, 25.746653, 27.173913, 27.578599, 29.052876, 30.693677, 31.191516, 32.658393,
    34.31709, 34.674064, 36.416606, 38.197097, 38.550501, 40.387722, 40.749796, 42.625746,
    44.326241, 44.883303, 46.772685, 48.590865, 49.261084,
]
_PITCH_MOD_SENS = [0, 10, 20, 33, 55, 92, 153, 255]
_LFO_SHAPES = ["triangle", "saw", "saw", "square", "sine", None]   # last: sample & hold
_BLOCK_S = 64 / 44100.0     # Dexed envelope update period (N = 64 samples at 44.1 kHz)
_PEAK_UNITS = 3840          # level units at output level 99 / env level 99 (256 units = 1 octave of amplitude)
_MAX_BETA = 4 * math.pi     # modulation index at full level (Dexed convention)


class DexedError(ValueError):
    pass


@dataclass
class Operator:
    rates: list[int]
    levels: list[int]
    break_point: int = 0
    left_depth: int = 0
    right_depth: int = 0
    left_curve: int = 0
    right_curve: int = 0
    rate_scaling: int = 0
    amp_mod_sens: int = 0
    key_vel_sens: int = 0
    output_level: int = 0
    fixed: bool = False
    coarse: int = 1
    fine: int = 0
    detune: int = 7


@dataclass
class DxVoice:
    name: str
    ops: list[Operator]            # index 0 = OP1 ... 5 = OP6 (the dump stores OP6 first)
    pitch_rates: list[int]
    pitch_levels: list[int]
    algorithm: int = 0             # 0..31
    feedback: int = 0
    osc_sync: int = 1
    lfo_speed: int = 0
    lfo_delay: int = 0
    lfo_pmd: int = 0
    lfo_amd: int = 0
    lfo_sync: int = 0
    lfo_wave: int = 0
    lfo_pms: int = 0
    transpose: int = 24


# --------------------------------------------------------------------------- SysEx parsing

def _checksum(data: bytes) -> int:
    return (-sum(data)) & 0x7F


def unpack_voice(p: bytes) -> list[int]:
    """128 packed bytes -> 155-byte VCED parameter list."""
    if len(p) != PACKED_SIZE:
        raise DexedError("packed voice must be 128 bytes")
    u = [0] * VCED_SIZE
    for i in range(6):
        o, b = i * 17, i * 21
        u[b:b + 11] = p[o:o + 11]
        u[b + 11] = p[o + 11] & 3
        u[b + 12] = (p[o + 11] >> 2) & 3
        u[b + 13] = p[o + 12] & 7
        u[b + 20] = (p[o + 12] >> 3) & 15
        u[b + 14] = p[o + 13] & 3
        u[b + 15] = (p[o + 13] >> 2) & 7
        u[b + 16] = p[o + 14]
        u[b + 17] = p[o + 15] & 1
        u[b + 18] = (p[o + 15] >> 1) & 31
        u[b + 19] = p[o + 16]
    u[126:134] = p[102:110]
    u[134] = p[110]
    u[135] = p[111] & 7
    u[136] = (p[111] >> 3) & 1
    u[137:141] = p[112:116]
    u[141] = p[116] & 1
    u[142] = (p[116] >> 1) & 7
    u[143] = (p[116] >> 4) & 7
    u[144] = p[117]
    u[145:155] = p[118:128]
    return u


def pack_voice(u: list[int]) -> bytes:
    """155-byte VCED list -> 128 packed bytes (inverse of unpack_voice)."""
    if len(u) != VCED_SIZE:
        raise DexedError("VCED voice must be 155 bytes")
    p = bytearray(PACKED_SIZE)
    for i in range(6):
        o, b = i * 17, i * 21
        p[o:o + 11] = bytes(u[b:b + 11])
        p[o + 11] = (u[b + 11] & 3) | ((u[b + 12] & 3) << 2)
        p[o + 12] = (u[b + 13] & 7) | ((u[b + 20] & 15) << 3)
        p[o + 13] = (u[b + 14] & 3) | ((u[b + 15] & 7) << 2)
        p[o + 14] = u[b + 16]
        p[o + 15] = (u[b + 17] & 1) | ((u[b + 18] & 31) << 1)
        p[o + 16] = u[b + 19]
    p[102:110] = bytes(u[126:134])
    p[110] = u[134]
    p[111] = (u[135] & 7) | ((u[136] & 1) << 3)
    p[112:116] = bytes(u[137:141])
    p[116] = (u[141] & 1) | ((u[142] & 7) << 1) | ((u[143] & 7) << 4)
    p[117] = u[144]
    p[118:128] = bytes(u[145:155])
    return bytes(p)


def bulk_dump(voices: list[list[int]], channel: int = 0) -> bytes:
    """32 VCED lists -> a bulk dump (fewer are padded with copies of the last one)."""
    voices = list(voices)[:32]
    while len(voices) < 32:
        voices.append(voices[-1])
    body = b"".join(pack_voice(v) for v in voices)
    head = bytes([0xF0, 0x43, channel & 15, 0x09, 0x20, 0x00])
    return head + body + bytes([_checksum(body), 0xF7])


def single_dump(vced: list[int], channel: int = 0) -> bytes:
    body = bytes(vced)
    head = bytes([0xF0, 0x43, channel & 15, 0x00, 0x01, 0x1B])
    return head + body + bytes([_checksum(body), 0xF7])


def _voice_from_vced(u: list[int]) -> DxVoice:
    ops = []
    for i in range(6):
        b = i * 21
        ops.append(Operator(
            rates=list(u[b:b + 4]), levels=list(u[b + 4:b + 8]), break_point=u[b + 8],
            left_depth=u[b + 9], right_depth=u[b + 10], left_curve=u[b + 11], right_curve=u[b + 12],
            rate_scaling=u[b + 13], amp_mod_sens=u[b + 14], key_vel_sens=u[b + 15],
            output_level=u[b + 16], fixed=bool(u[b + 17]), coarse=u[b + 18], fine=u[b + 19],
            detune=u[b + 20]))
    ops.reverse()   # dump order is OP6..OP1
    name = "".join(chr(c) if 32 <= c < 127 else " " for c in u[145:155]).strip()
    return DxVoice(
        name=name, ops=ops, pitch_rates=list(u[126:130]), pitch_levels=list(u[130:134]),
        algorithm=min(u[134], 31), feedback=u[135], osc_sync=u[136], lfo_speed=u[137],
        lfo_delay=u[138], lfo_pmd=u[139], lfo_amd=u[140], lfo_sync=u[141], lfo_wave=min(u[142], 5),
        lfo_pms=u[143], transpose=u[144])


def looks_like_dx7(data: bytes) -> str | None:
    """'bulk' | 'single' | None, by header (cheap enough to run on a 64-byte prefix + size)."""
    if len(data) >= 6 and data[0] == 0xF0 and data[1] == 0x43:
        if data[3] == 0x09 and data[4] == 0x20 and data[5] == 0x00:
            return "bulk"
        if data[3] == 0x00 and data[4] == 0x01 and data[5] == 0x1B:
            return "single"
    return None


def parse_syx(data: bytes) -> tuple[list[DxVoice], list[str]]:
    """Parse a DX7 dump into voices. Returns (voices, warnings). Raises DexedError."""
    warnings: list[str] = []
    kind = looks_like_dx7(data)
    if kind == "bulk":
        if len(data) < BULK_SIZE:
            raise DexedError(f"bulk dump is {len(data)} bytes, expected {BULK_SIZE}")
        body = data[6:6 + 4096]
        if data[6 + 4096] != _checksum(body):
            warnings.append("bank checksum mismatch (file may be damaged); voices read anyway")
        voices = [_voice_from_vced(unpack_voice(body[i * 128:(i + 1) * 128])) for i in range(32)]
        return voices, warnings
    if kind == "single":
        if len(data) < SINGLE_SIZE:
            raise DexedError(f"single-voice dump is {len(data)} bytes, expected {SINGLE_SIZE}")
        body = data[6:6 + VCED_SIZE]
        if data[6 + VCED_SIZE] != _checksum(body):
            warnings.append("voice checksum mismatch; read anyway")
        return [_voice_from_vced(list(body))], warnings
    if len(data) == 4096:   # headerless packed bank
        return [_voice_from_vced(unpack_voice(data[i * 128:(i + 1) * 128])) for i in range(32)], \
            ["no SysEx header; read as a raw 32-voice packed bank"]
    raise DexedError("not a DX7 SysEx dump")


# --------------------------------------------------------------------------- DX7 maths

def algorithm_topology(algorithm: int) -> tuple[list[int], dict[int, list[int]], int | None]:
    """(carriers, modulators-per-op, feedback op), operators numbered 1..6.

    Evaluates Dexed's operator flags in processing order OP6..OP1 over its two modulation buses.
    """
    flags = _ALGORITHMS[algorithm]
    buses: dict[int, list[int]] = {1: [], 2: []}
    carriers: list[int] = []
    mods: dict[int, list[int]] = {n: [] for n in range(1, 7)}
    fb_op = None
    for idx, f in enumerate(flags):
        op = 6 - idx
        inbus, outbus, add = (f >> 4) & 3, f & 3, bool(f & 4)
        if inbus:
            mods[op] = list(buses[inbus])
        if (f & 0xc0) == 0xc0:
            fb_op = op
        if outbus == 0:
            carriers.append(op)
        elif add and buses[outbus]:
            buses[outbus].append(op)
        else:
            buses[outbus] = [op]
    return carriers, mods, fb_op


def scale_level(v: int) -> int:
    return 28 + v if v >= 20 else _LEVEL_LUT[v]


def _abs_units(level: int, out_level: int) -> float:
    """Envelope level in Dexed's log units (256 per octave of amplitude), floor 16."""
    u = ((scale_level(level) >> 1) << 6) + (scale_level(out_level) << 5) - 4256
    return max(u, 16)


def gain(level: int, out_level: int) -> float:
    """Linear amplitude (1.0 = output level 99, env level 99)."""
    u = _abs_units(level, out_level)
    return 0.0 if u <= 16 else 2.0 ** ((u - _PEAK_UNITS) / 256.0)


def stage_seconds(rate: int, start: float, end: float) -> float:
    """Seconds for one envelope stage between two unit levels at DX7 rate `rate` (0..99)."""
    q = min(63, (rate * 41) >> 6)
    per_block = ((4 + (q & 3)) << (2 + 6 + (q >> 2))) / 65536.0     # units per 64-sample block
    if end < start:                                                  # falling: linear in log units
        return (start - end) / per_block * _BLOCK_S
    if end > start:                                                  # rising: faster at low level
        a = max(start, 1716.0)
        if end <= a:
            return 0.0
        return 256.0 * _BLOCK_S / per_block * math.log((17 - a / 256) / max(17 - end / 256, 0.5))
    return 0.0


def op_envelope(op: Operator) -> tuple[Envelope, float]:
    """(Vital-style DAHDSR normalised to peak 1, peak linear gain including output level)."""
    lv = [_abs_units(l, op.output_level) for l in op.levels]
    gains = [gain(l, op.output_level) for l in op.levels]
    peak = max(gains[:3])
    if peak <= 0:
        return Envelope(attack=0, decay=0.01, sustain=0.0, release=0.01), 0.0
    r = op.rates
    attack = stage_seconds(r[0], lv[3], lv[0])
    decay = stage_seconds(r[1], lv[0], lv[1]) + stage_seconds(r[2], lv[1], lv[2])
    sustain = gains[2] / peak
    release = stage_seconds(r[3], lv[2], lv[3])
    return Envelope(attack=attack, decay=max(decay, 0.0), sustain=min(sustain, 1.0), release=release), peak


def _flat_static(op: Operator, env: Envelope) -> bool:
    return op.levels[0] == op.levels[1] == op.levels[2] and env.attack < 0.005


def op_semitones(op: Operator, transpose: int) -> tuple[float, bool]:
    """(semitone offset relative to the played note, is_fixed_pitch)."""
    if op.fixed:
        hz = 10 ** ((op.coarse & 3) + op.fine / 100.0)
        return 12 * math.log2(hz / 130.8128), True       # Vital's untracked base is C3
    ratio = (op.coarse if op.coarse else 0.5) * (1 + op.fine * 0.01)
    # Dexed dx7note.cc: detune step ~0.0209*exp(-0.396*log2 f)/7 * log2 f octaves; ~1.2 cents at C4
    cents = (op.detune - 7) * 1.2
    return 12 * math.log2(ratio) + cents / 100.0 + (transpose - 24), False


# --------------------------------------------------------------------------- conversion

def to_patch(v: DxVoice, source_file: str = "") -> Patch:
    p = Patch()
    rep = p.report
    p.meta.name = v.name or "DX7 voice"
    p.meta.source = {"synth": "dexed", "version": "DX7", "file": source_file}
    p.meta.comments = f"Converted from DX7 voice, algorithm {v.algorithm + 1}"
    carriers, mods, fb_op = algorithm_topology(v.algorithm)

    env: dict[int, Envelope] = {}
    peak: dict[int, float] = {}
    for n in range(1, 7):
        env[n], peak[n] = op_envelope(v.ops[n - 1])
    active = {n for n in range(1, 7) if peak[n] > 0.003 and v.ops[n - 1].output_level > 0}
    carriers_a = [c for c in carriers if c in active]
    if not carriers_a:
        raise DexedError("no audible carrier operator (every carrier has output level 0)")
    # edges s -> t over active operators only (a silent operator in a chain is skipped over)
    edges = {(s, t) for t, srcs in mods.items() for s in srcs if s in active and t in active}

    def is_carrier(n):
        return n in carriers_a

    # ---- choose <= 3 operators: brute force over subsets, carriers count fully, FM links 0.6
    def links_for(S):
        """Direct links between members of S, following paths through removed operators."""
        out = set()
        for s in S:
            stack, seen = [s], {s}
            while stack:
                x = stack.pop()
                for (a_, b_) in edges:
                    if a_ == x and b_ not in seen:
                        seen.add(b_)
                        if b_ in S:
                            out.add((s, b_))
                        else:
                            stack.append(b_)
        return out

    from itertools import combinations
    best_set, best_score = set(), -1.0
    act = sorted(active)
    for k in range(1, min(3, len(act)) + 1):
        for S in combinations(act, k):
            Ss = set(S)
            if not any(is_carrier(n) for n in Ss):
                continue
            lk = links_for(Ss)
            score = sum(peak[n] for n in Ss if is_carrier(n)) + 0.6 * sum(peak[s] for s, _ in lk)
            if score > best_score + 1e-9:
                best_set, best_score = Ss, score
    cur = best_set
    direct = {(s, t) for (s, t) in edges if s in cur and t in cur}
    m: dict[int, list[int]] = {n: [] for n in cur}
    for (s, t) in sorted(links_for(cur)):
        m[t].append(s)
        if (s, t) not in direct:
            rep.approx(f"operator {s}", f"modulates operator {t} through removed operators; re-routed directly")
    for n in sorted(active - cur):
        if is_carrier(n):
            rep.drop(f"operator {n}", "carrier removed: Vital has only 3 oscillators")
        else:
            rep.drop(f"operator {n}", "modulator removed: Vital has only 3 oscillators")

    # ---- one modulator per target (Vital: FM from a single oscillator)
    fm_src: dict[int, int] = {}
    for t in cur:
        srcs = sorted(m.get(t, []), key=lambda s: peak[s], reverse=True)
        if not srcs:
            continue
        fm_src[t] = srcs[0]
        for s in srcs[1:]:
            rep.drop(f"operator {s}", f"also modulates operator {t}; Vital's FM takes one source, kept "
                     f"operator {srcs[0]}")
    used = set(fm_src.values())
    for n in list(cur):
        if not is_carrier(n) and n not in used:
            cur.discard(n)
    # chains in Vital: osc order carriers first, then modulators by depth
    order = sorted((n for n in cur if is_carrier(n)), key=lambda n: peak[n], reverse=True)
    order += sorted((n for n in cur if not is_carrier(n)), key=lambda n: -peak[n])
    idx = {n: i for i, n in enumerate(order)}

    # ---- carriers: levels and the amp envelope (Vital env 1)
    total = sum(peak[c] for c in order if is_carrier(c)) or 1.0
    scale = 1.0 / total if total > 1.0 else 1.0
    amp_env_src = order[0] if order and is_carrier(order[0]) else None
    if amp_env_src is not None:
        p.envelopes.append(env[amp_env_src])
        rep.approx("amp envelope", "DX7 4-rate/4-level envelope -> Vital attack/decay/sustain/release "
                   "(times from Dexed's rate table; curve shape differs)")
    else:
        p.envelopes.append(Envelope())
    for c in order:
        if is_carrier(c) and c != amp_env_src:
            e = env[c]
            e0 = env[amp_env_src]
            if abs(e.sustain - e0.sustain) > 0.1 or abs(e.decay - e0.decay) > 0.5 * max(e0.decay, 0.2) \
                    or abs(e.release - e0.release) > 0.5 * max(e0.release, 0.2):
                rep.approx(f"operator {c} envelope", f"uses the amp envelope of operator {amp_env_src} "
                           "(Vital has one amplitude envelope)")

    # ---- oscillators
    fixed_ops = []
    for n in order:
        op = v.ops[n - 1]
        semis, fixed = op_semitones(op, v.transpose)
        shape = "sine"
        if n == fb_op and v.feedback >= 5:
            shape = "saw"
            rep.approx(f"operator {n} feedback", f"feedback {v.feedback} approximated by a saw wave")
        elif n == fb_op and v.feedback > 0:
            rep.drop(f"operator {n} feedback", f"feedback {v.feedback} (weak) has no Vital equivalent")
        o = Osc(shape=shape, transpose=max(-48.0, min(48.0, semis)), random_phase=False, keytrack=not fixed,
                level=(peak[n] * scale) if is_carrier(n) else 0.0, destination="filters")
        if abs(semis) > 48.0:
            rep.approx(f"operator {n} frequency", f"{semis:+.1f} semitones outside Vital's +-48 range, clamped")
        else:
            rep.exact(f"operator {n} frequency")
        if fixed:
            fixed_ops.append(n)
        if n in fm_src:
            o.fm_from = idx[fm_src[n]]
            src = fm_src[n]
            o.fm_index = _MAX_BETA * peak[src]
            if not _flat_static(v.ops[src - 1], env[src]):
                p.envelopes.append(env[src])
                o.fm_envelope = len(p.envelopes) - 1
                rep.approx(f"operator {src} envelope", "modulation-index envelope approximated with a Vital envelope")
        p.oscillators.append(o)
        if v.ops[n - 1].detune != 7 and not fixed:
            rep.approx(f"operator {n} detune", "operator detune converted at ~1.2 cents per step (measured at C4)")
    if fixed_ops:
        rep.approx("fixed frequency", f"operators {fixed_ops} use fixed pitch; Vital's untracked oscillator "
                   "pitch is relative to C3, so the value is approximate")

    # ---- LFO -> pitch
    if v.lfo_pmd > 0 and v.lfo_pms > 0 and p.oscillators:
        shape = _LFO_SHAPES[v.lfo_wave]
        if shape is None:
            rep.drop("lfo", "sample & hold LFO wave has no Vital LFO equivalent")
        else:
            p.lfos.append(Lfo(shape=shape, rate_hz=_LFO_HZ[v.lfo_speed]))
            semis = 12.0 * (v.lfo_pmd / 99.0) * (_PITCH_MOD_SENS[v.lfo_pms] / 255.0)
            amount = semis / 2.0     # Vital osc tune spans +-1 (= +-1 semitone per unit)
            if amount > 1.0:
                rep.approx("lfo pitch depth", f"pitch modulation of +-{semis:.1f} semitones limited to +-2 "
                           "(Vital's tune range)")
            for i in range(len(p.oscillators)):
                p.mod_matrix.append(ModRoute("lfo_1", f"osc_{i + 1}_tune", amount=min(amount, 1.0), bipolar=True))
            rep.approx("lfo", "DX7 LFO pitch modulation -> Vital LFO on oscillator tune")
    if v.lfo_delay > 0 and v.lfo_pmd > 0:
        rep.drop("lfo delay", "LFO onset delay not mapped")

    # ---- things with no mapping
    if any(l != 50 for l in v.pitch_levels):
        rep.drop("pitch envelope", "DX7 pitch EG is not flat; Vital has no pitch envelope mapping here")
    if v.lfo_amd > 0 and any(o.amp_mod_sens > 0 for o in v.ops):
        rep.drop("lfo amplitude modulation", "amplitude mod sensitivity not mapped")
    if any(o.key_vel_sens > 0 for o in v.ops):
        rep.drop("velocity sensitivity", "operator key-velocity sensitivity not mapped")
    if any(o.left_depth or o.right_depth for o in v.ops):
        rep.drop("keyboard level scaling", "operator level scaling not mapped")
    if any(o.rate_scaling for o in v.ops):
        rep.drop("keyboard rate scaling", "operator rate scaling not mapped")
    p.foreign = {"dx7": {"algorithm": v.algorithm + 1, "feedback": v.feedback, "transpose": v.transpose}}
    return p


def patches_from_file(path: str) -> tuple[list[Patch], list[str]]:
    with open(path, "rb") as fh:
        data = fh.read()
    voices, warnings = parse_syx(data)
    return [to_patch(v, path) for v in voices], warnings
