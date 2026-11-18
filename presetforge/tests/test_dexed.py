import math

import pytest

from dexed_fixtures import eplano, make_vced, sine_bank, six_op_stack, two_op
from presetforge.readers import dexed
from presetforge.readers.dexed import DexedError


def test_pack_unpack_round_trip():
    u = eplano()
    assert dexed.unpack_voice(dexed.pack_voice(u)) == u


def test_bulk_dump_shape_and_names():
    data, names = sine_bank()
    assert len(data) == 4104 and data[:6] == bytes([0xF0, 0x43, 0, 0x09, 0x20, 0x00]) and data[-1] == 0xF7
    voices, warnings = dexed.parse_syx(data)
    assert warnings == [] and [v.name for v in voices] == names
    assert voices[3].algorithm == 3 and voices[0].ops[0].output_level == 99


def test_single_voice_and_bad_input():
    data = dexed.single_dump(eplano())
    assert len(data) == 163
    voices, warnings = dexed.parse_syx(data)
    assert len(voices) == 1 and voices[0].name == "E.PIANO 1" and warnings == []
    bad = bytearray(data)
    bad[-2] ^= 0x7F
    assert "checksum" in dexed.parse_syx(bytes(bad))[1][0]
    with pytest.raises(DexedError):
        dexed.parse_syx(b"\xF0\x43\x00\x09\x20\x00" + b"\0" * 10)
    with pytest.raises(DexedError):
        dexed.parse_syx(b"hello")


def test_algorithm_topologies_match_the_dx7_chart():
    c, m, fb = dexed.algorithm_topology(0)           # algorithm 1: 2>1, 6>5>4>3 with 6 feedback
    assert sorted(c) == [1, 3] and m[1] == [2] and m[3] == [4] and m[4] == [5] and m[5] == [6] and fb == 6
    c, m, fb = dexed.algorithm_topology(4)           # algorithm 5: three pairs
    assert sorted(c) == [1, 3, 5] and m[1] == [2] and m[3] == [4] and m[5] == [6]
    c, m, fb = dexed.algorithm_topology(31)          # algorithm 32: six carriers
    assert sorted(c) == [1, 2, 3, 4, 5, 6] and all(not v for v in m.values()) and fb == 6
    c, m, _ = dexed.algorithm_topology(15)           # algorithm 16: 2, 3 and 5 feed op 1; 6 feeds 5
    assert c == [1] and sorted(m[1]) == [2, 3, 5] and m[5] == [6]


def test_envelope_times_and_levels():
    assert dexed.stage_seconds(99, 0, 3840) < 0.05
    assert dexed.stage_seconds(0, 3840, 16) > 100
    assert dexed.stage_seconds(50, 3840, 16) > dexed.stage_seconds(70, 3840, 16)
    assert dexed.gain(99, 99) == pytest.approx(1.0)
    assert 20 * math.log10(dexed.gain(99, 98)) == pytest.approx(-0.75, abs=0.01)   # 0.75 dB per step


def test_two_operator_voice_maps_to_fm():
    v = dexed.parse_syx(dexed.single_dump(two_op()))[0][0]
    p = dexed.to_patch(v)
    assert len(p.oscillators) == 2
    car, mod = p.oscillators
    assert car.level == pytest.approx(1.0) and car.fm_from == 1 and mod.level == 0.0
    assert mod.transpose == pytest.approx(12 * math.log2(3))
    assert car.fm_index == pytest.approx(4 * math.pi * dexed.gain(99, 85), rel=1e-3)
    assert not p.report.dropped


def test_six_operator_voice_is_reduced_and_reported():
    v = dexed.parse_syx(dexed.single_dump(six_op_stack()))[0][0]
    p = dexed.to_patch(v)
    assert len(p.oscillators) <= 3 and p.report.dropped and p.report.status == "approx"


def test_feedback_on_a_kept_carrier_becomes_a_saw():
    u = make_vced("FB SAW", 32, {6: {"ol": 99}}, feedback=7)
    p = dexed.to_patch(dexed.parse_syx(dexed.single_dump(u))[0][0])
    assert p.oscillators[0].shape == "saw"
    assert any("feedback" in a["field"] for a in p.report.approximated)


def test_silent_voice_is_an_error():
    v = dexed.parse_syx(dexed.single_dump(make_vced("SILENT", 1, {})))[0][0]
    with pytest.raises(DexedError):
        dexed.to_patch(v)


def test_all_bank_voices_load_in_vita(tmp_path):
    vita = pytest.importorskip("vita")
    from presetforge.vital_writer import write_vital
    data, names = sine_bank()
    voices, _ = dexed.parse_syx(data)
    synth = vita.Synth()
    for i, v in enumerate(voices):
        p = dexed.to_patch(v)
        path = tmp_path / f"{i}.vital"
        write_vital(p, path)
        assert synth.load_preset(str(path)) is True


def _spectrum(vita, np, path, note=60):
    s = vita.Synth()
    s.set_sample_rate(44100)
    assert s.load_preset(str(path))
    a = s.render(note, 1.0, 1.0, 1.5)[0][22050:50000]
    return np.abs(np.fft.rfft(a * np.hanning(len(a)))), np.fft.rfftfreq(len(a), 1 / 44100)


def test_fm_renders_sidebands(tmp_path):
    vita = pytest.importorskip("vita")
    np = pytest.importorskip("numpy")
    from presetforge.vital_writer import write_vital
    u = make_vced("FM1", 5, {1: {"ol": 99}, 2: {"ol": 80}})        # ratio 1:1
    p = dexed.to_patch(dexed.parse_syx(dexed.single_dump(u))[0][0])
    path = tmp_path / "fm.vital"
    write_vital(p, path)
    sp, fr = _spectrum(vita, np, path)
    mag = [sp[np.argmin(abs(fr - 261.6256 * k))] for k in (1, 2, 3)]
    assert mag[1] / mag[0] > 0.1 and mag[2] / mag[0] > 0.02   # a pure sine would show ~0


def test_chain_modulator_source_slot(tmp_path):
    """Osc 2 modulated by osc 3 uses FM slot 'type 8' (osc 2's sources are osc 1, osc 3)."""
    vita = pytest.importorskip("vita")
    np = pytest.importorskip("numpy")
    from presetforge.upm import Osc, Patch
    from presetforge.vital_writer import write_vital
    p = Patch()
    p.oscillators = [Osc(shape="sine", level=0.0), Osc(shape="sine", fm_from=2, fm_index=6.0),
                     Osc(shape="sine", level=0.0)]
    path = tmp_path / "slot.vital"
    write_vital(p, path)
    sp, fr = _spectrum(vita, np, path)
    assert sp[np.argmin(abs(fr - 261.6256 * 2))] / sp[np.argmin(abs(fr - 261.6256))] > 0.1


def test_eplano_loads_and_renders(tmp_path):
    vita = pytest.importorskip("vita")
    np = pytest.importorskip("numpy")
    from presetforge.vital_writer import write_vital
    p = dexed.to_patch(dexed.parse_syx(dexed.single_dump(eplano()))[0][0])
    path = tmp_path / "ep.vital"
    write_vital(p, path)
    s = vita.Synth()
    assert s.load_preset(str(path))
    audio = s.render(60, 0.8, 1.0, 2.0)
    assert not np.isnan(audio).any() and np.abs(audio).max() > 0.01
    assert p.lfos and any(r.source == "lfo_1" for r in p.mod_matrix)
