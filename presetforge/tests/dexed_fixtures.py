"""Build DX7 SysEx fixtures in code from the documented packed format (no vendor files)."""
from presetforge.readers import dexed


def make_vced(name="TEST", algorithm=1, ops=None, feedback=0, lfo=(0, 0, 0, 0, 0, 0, 0), transpose=24):
    """ops: {op number 1..6: dict of overrides}. Unlisted operators are silent (output level 0)."""
    ops = ops or {}
    u = []
    for n in (6, 5, 4, 3, 2, 1):                       # the dump stores OP6 first
        o = {"rates": [99, 99, 99, 99], "levels": [99, 99, 99, 0], "bp": 39, "ld": 0, "rd": 0,
             "lc": 0, "rc": 0, "rs": 0, "ams": 0, "kvs": 0, "ol": 0, "mode": 0, "coarse": 1,
             "fine": 0, "det": 7}
        o.update(ops.get(n, {}))
        u += o["rates"] + o["levels"] + [o["bp"], o["ld"], o["rd"], o["lc"], o["rc"], o["rs"],
                                         o["ams"], o["kvs"], o["ol"], o["mode"], o["coarse"],
                                         o["fine"], o["det"]]
    u += [99, 99, 99, 99, 50, 50, 50, 50]              # pitch EG, flat
    speed, delay, pmd, amd, sync, wave, pms = lfo
    u += [algorithm - 1, feedback, 1, speed, delay, pmd, amd, sync, wave, pms, transpose]
    u += [ord(c) for c in name.ljust(10)[:10]]
    assert len(u) == dexed.VCED_SIZE
    return u


def eplano():
    """Algorithm 5: three carriers each with one modulator (2->1, 4->3, 6->5)."""
    return make_vced("E.PIANO 1", 5, {
        1: {"ol": 99, "levels": [99, 85, 80, 0], "rates": [95, 40, 30, 55]},
        2: {"ol": 78, "coarse": 1, "levels": [99, 60, 40, 0], "rates": [95, 50, 30, 60]},
        3: {"ol": 90, "coarse": 2, "det": 9},
        4: {"ol": 70, "coarse": 14},
        5: {"ol": 85, "coarse": 1},
        6: {"ol": 60, "coarse": 1},
    }, feedback=4, lfo=(30, 0, 20, 0, 0, 4, 3))


def two_op():
    return make_vced("BELL 2OP", 5, {1: {"ol": 99}, 2: {"ol": 85, "coarse": 3}})


def six_op_stack():
    return make_vced("STACK 6", 1, {n: {"ol": 90 - 3 * n, "coarse": n} for n in range(1, 7)}, feedback=7)


def sine_bank():
    names = [f"VOICE {i:02d}" for i in range(32)]
    voices = [make_vced(n, 1 + (i % 32), {1: {"ol": 99}, 2: {"ol": 70}, 3: {"ol": 80}, 4: {"ol": 60}})
              for i, n in enumerate(names)]
    return dexed.bulk_dump(voices), names
