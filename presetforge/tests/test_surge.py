import os
import struct
from pathlib import Path

import pytest

from presetforge.readers import surge
from presetforge.readers.surge import SurgeError

DEFAULT_SURGE = r"C:\Users\PashchenkoS\Desktop\claude\preset-spikes\surge\resources\data\patches_factory"
SURGE_FIXTURES = Path(os.environ.get("PRESETFORGE_SURGE_FIXTURES", DEFAULT_SURGE))
needs_surge = pytest.mark.skipif(not SURGE_FIXTURES.is_dir(), reason="Surge factory patches not available")


def param(name, value, kind=2, routes=()):
    inner = "".join(f'<modrouting source="{s}" depth="{d}" />' for s, d in routes)
    return f'<{name} type="{kind}" value="{value}">{inner}</{name}>' if routes else \
        f'<{name} type="{kind}" value="{value}" />'


def build_fxp(params, name="Synthetic", wt=None, category="Test", extra_xml=""):
    """A minimal Surge XT .fxp built in code (header layout from Surge's PatchFileHeaderStructs.h)."""
    xml = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><patch revision="20">'
           f'<meta name="{name}" category="{category}" comment="" author="tester" />'
           f'<parameters>{"".join(params)}</parameters>{extra_xml}</patch>').encode()
    wtsize = [0] * 6
    blob = b""
    if wt is not None:
        frames, n = wt
        blob = b"vawt" + struct.pack("<IHH", n, len(frames), 4) + b"".join(
            struct.pack(f"<{n}h", *[int(x * 16384) for x in fr]) for fr in frames)
        wtsize[0] = len(blob)
    chunk = b"sub3" + struct.pack("<I", len(xml)) + struct.pack("<6I", *wtsize) + xml + blob
    prg = name.encode().ljust(28, b"\0")[:28]
    body = b"FPCh" + struct.pack(">iiii", 1, int.from_bytes(b"cjs3", "big"), 1, 1) + prg + \
        struct.pack(">i", len(chunk)) + chunk
    return b"CcnK" + struct.pack(">i", len(body)) + body


def basic_params():
    return [
        param("scene_active", 0, 0), param("scenemode", 0, 0), param("polylimit", 8, 0),
        param("a_octave", 0, 0), param("a_pitch", 0.0),
        param("a_osc1_type", 0, 0), param("a_osc1_octave", -1, 0), param("a_osc1_pitch", 7.0),
        param("a_osc1_param0", 0.0), param("a_osc1_param5", 0.1), param("a_osc1_param6", 3, 0),
        param("a_level_o1", 1.0), param("a_mute_o1", 0, 0), param("a_route_o1", 1, 0),
        param("a_osc2_type", 1, 0), param("a_level_o2", 0.5), param("a_mute_o2", 0, 0),
        param("a_route_o2", 1, 0), param("a_osc2_octave", 1, 0),
        param("a_filter1_type", 2, 0), param("a_filter1_cutoff", 12.0, 2, routes=[(6, 24.0)]),
        param("a_filter1_resonance", 0.4), param("a_filter1_envmod", 36.0), param("a_filter1_keytrack", 0.5),
        param("a_env1_attack", -2.0), param("a_env1_decay", 1.0), param("a_env1_sustain", 0.5),
        param("a_env1_release", -1.0), param("a_env2_attack", -4.0), param("a_env2_decay", -1.0),
        param("a_env2_sustain", 0.0), param("a_env2_release", -2.0),
        param("fx1_type", 2, 0), param("fx1_p3", 2.0), param("fx1_p2", 0.6), param("fx1_p9", 0.35),
        param("fx2_type", 4, 0),
    ]


def test_parse_and_map_synthetic_patch():
    data = build_fxp(basic_params())
    assert surge.looks_like_surge(data[:64]) and surge.program_name(data[:64]) == "Synthetic"
    sf = surge.parse_fxp(data)
    p = surge.to_patch(sf)
    assert p.meta.name == "Synthetic" and p.meta.author == "tester"
    assert len(p.oscillators) == 2
    o1, o2 = p.oscillators
    assert o1.shape == "saw" and o1.transpose == pytest.approx(-12 + 7) and o1.unison_voices == 3
    assert o1.unison_detune_cents == pytest.approx(10.0)
    assert o2.shape == "sine" and o2.transpose == 12
    assert o1.level + o2.level == pytest.approx(1.0)               # scaled to sum 1 (1.0 + 0.125 -> /1.125)
    f = p.filters[0]
    assert (f.mode, f.slope_db) == ("lp", 24) and f.cutoff_hz == pytest.approx(440 * 2 ** (12 / 12))
    assert f.keytrack == 0.5 and f.resonance == pytest.approx(0.4)
    assert p.envelopes[0].attack == pytest.approx(0.25) and p.envelopes[0].sustain == 0.5
    assert p.envelopes[1].decay == pytest.approx(0.5)
    srcs = {(r.source, r.dest): r for r in p.mod_matrix}
    assert srcs[("env_2", "filter_1_cutoff")].semitones == 36.0
    assert srcs[("mod_wheel", "filter_1_cutoff")].semitones == 24.0
    assert [fx.kind for fx in p.fx] == ["reverb"]
    assert p.fx[0].params["decay_s"] == pytest.approx(4.0) and p.fx[0].mix == pytest.approx(0.35)
    assert any("rotary" in d["note"] for d in p.report.dropped)       # fx2 rotary speaker dropped


def test_wavetable_osc_keeps_frames():
    import numpy as np
    fr = [np.sin(2 * np.pi * np.arange(64) / 64 * (k + 1)) * 0.9 for k in range(4)]
    params = [param("scene_active", 0, 0), param("scenemode", 0, 0), param("a_osc1_type", 2, 0),
              param("a_osc1_param0", 0.5), param("a_level_o1", 1.0), param("a_mute_o1", 0, 0),
              param("a_route_o1", 0, 0), param("a_filter1_type", 1, 0)]
    p = surge.to_patch(surge.parse_fxp(build_fxp(params, wt=(fr, 64))))
    o = p.oscillators[0]
    assert len(o.frames) == 4 and len(o.frames[0]) == 64 and o.frame_pos == 0.5
    assert o.frames[1][8] == pytest.approx(fr[1][8], abs=1e-3)


def test_scene_b_and_layer_notes():
    layer = [param("scenemode", 2, 0)] + basic_params()[2:]
    p = surge.to_patch(surge.parse_fxp(build_fxp(layer)))
    assert any(d["field"] == "scene B" for d in p.report.dropped)
    b_only = [param("scenemode", 0, 0), param("scene_active", 1, 0)] + \
        [x.replace("<a_", "<b_").replace("</a_", "</b_") for x in basic_params()[2:]]
    p = surge.to_patch(surge.parse_fxp(build_fxp(b_only)))
    assert len(p.oscillators) == 2 and any("scene B" in a["note"] for a in p.report.approximated)


def test_bad_files():
    with pytest.raises(SurgeError):
        surge.parse_fxp(b"CcnK" + b"\0" * 100)
    good = build_fxp(basic_params())
    with pytest.raises(SurgeError):
        surge.parse_fxp(good[:100])
    evil = build_fxp(basic_params(), extra_xml="<!DOCTYPE x [<!ENTITY a 'b'>]>")
    with pytest.raises(SurgeError):
        surge.parse_fxp(evil)
    with pytest.raises(SurgeError):                       # nothing audible
        surge.to_patch(surge.parse_fxp(build_fxp([param("a_osc1_type", 0, 0), param("a_mute_o1", 1, 0)])))


def test_synthetic_patch_loads_in_vita(tmp_path):
    vita = pytest.importorskip("vita")
    from presetforge.vital_writer import write_vital
    p = surge.to_patch(surge.parse_fxp(build_fxp(basic_params())))
    path = tmp_path / "s.vital"
    write_vital(p, path)
    assert vita.Synth().load_preset(str(path)) is True


@needs_surge
def test_factory_patches_convert_and_load(tmp_path):
    vita = pytest.importorskip("vita")
    np = pytest.importorskip("numpy")
    from presetforge.vital_writer import write_vital
    files = sorted(SURGE_FIXTURES.rglob("*.fxp"))[:60]
    assert files
    synth = vita.Synth()
    failed = silent = 0
    for f in files:
        try:
            p = surge.to_patch(surge.parse_fxp(f.read_bytes()), str(f))
        except SurgeError:
            failed += 1                                    # noise/ring-mod only patches
            continue
        out = tmp_path / "x.vital"
        write_vital(p, out)
        assert synth.load_preset(str(out)) is True, f.name
        audio = synth.render(48, 0.8, 0.5, 1.0)
        assert not np.isnan(audio).any(), f.name
        silent += int(np.abs(audio).max() < 1e-4)
    assert failed <= len(files) // 10 and silent == 0
