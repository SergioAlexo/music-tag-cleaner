import json
import math

import pytest

vita = pytest.importorskip("vita")
np = pytest.importorskip("numpy")

from presetforge.upm import (Envelope, Filter, Fx, Lfo, ModRoute, Osc, Patch, Voice)  # noqa: E402
from presetforge.vital_writer import build_vital, write_vital  # noqa: E402


def load(tmp_path, patch):
    path = tmp_path / "p.vital"
    write_vital(patch, path)
    synth = vita.Synth()
    assert synth.load_preset(str(path)) is True
    return synth, json.loads(synth.to_json())["settings"], path


def text(synth, key):
    return synth.get_control_text(key)


def full_patch():
    p = Patch()
    p.meta.name = "Writer Test"
    p.oscillators = [
        Osc(shape="saw", transpose=7.25, level=0.25, pan=-0.5, unison_voices=4, unison_detune_cents=25),
        Osc(shape="square", transpose=-12, level=1.0),
    ]
    p.filters = [Filter(mode="hp", slope_db=24, cutoff_hz=1000.0, resonance=0.4, drive_db=3, keytrack=0.5)]
    p.envelopes = [Envelope(attack=0.5, decay=2.0, sustain=0.6, release=1.5), Envelope(attack=0.01, decay=0.3, sustain=0.0)]
    p.lfos = [Lfo(shape="sine", rate_hz=4.0)]
    p.mod_matrix = [ModRoute("env_2", "filter_1_cutoff", semitones=36), ModRoute("lfo_1", "osc_1_tune", amount=0.25, bipolar=True)]
    p.fx = [Fx("reverb", 0.4, {"decay_s": 3.0, "size": 0.7}), Fx("delay", 0.3, {"time_s": 0.25, "feedback": 0.4}),
            Fx("chorus", 0.5, {"rate_hz": 2.0}), Fx("distortion", 0.5, {"type": "hard clip", "drive_db": 9})]
    p.voice = Voice(polyphony=6, glide_s=0.5, bend_range=12)
    return p


def test_full_patch_loads_and_reads_back(tmp_path):
    synth, st, _ = load(tmp_path, full_patch())
    assert st["osc_1_on"] == 1 and st["osc_2_on"] == 1 and st["osc_3_on"] == 0
    assert text(synth, "osc_1_transpose").startswith("7")
    assert float(text(synth, "osc_1_tune")) == pytest.approx(25, abs=0.5)
    assert float(text(synth, "osc_1_level").split()[0]) == pytest.approx(0.25, abs=0.01)
    assert float(text(synth, "osc_1_unison_detune").rstrip("%")) > 0
    assert st["osc_1_unison_voices"] == 4
    assert st["filter_1_on"] == 1 and st["filter_1_blend"] == 2 and st["filter_1_style"] == 1
    assert 440 * 2 ** ((st["filter_1_cutoff"] - 69) / 12) == pytest.approx(1000, rel=1e-3)
    assert float(text(synth, "env_1_attack").split()[0]) == pytest.approx(0.5, rel=1e-3)
    assert float(text(synth, "env_1_release").split()[0]) == pytest.approx(1.5, rel=1e-3)
    assert st["env_1_sustain"] == pytest.approx(0.6)
    assert float(text(synth, "lfo_1_frequency").split()[0]) == pytest.approx(0.25, rel=1e-3)  # period
    assert st["reverb_on"] == 1 and float(text(synth, "reverb_decay_time").split()[0]) == pytest.approx(3.0, rel=1e-3)
    assert st["delay_on"] == 1 and float(text(synth, "delay_frequency").split()[0]) == pytest.approx(0.25, rel=1e-3)
    assert st["chorus_on"] == 1 and st["distortion_on"] == 1 and st["distortion_type"] == 1
    assert st["polyphony"] == 6 and st["pitch_bend_range"] == 12
    assert float(text(synth, "portamento_time").split()[0]) == pytest.approx(0.5, rel=1e-3)
    mods = json.loads(synth.to_json())["settings"]["modulations"]
    assert mods[0] == {"source": "env_2", "destination": "filter_1_cutoff"}
    assert st["modulation_1_amount"] == pytest.approx(36 / 128)
    assert st["modulation_2_bipolar"] == 1


def test_untouched_keys_stay_at_init(tmp_path):
    base = vita.Synth()
    base.load_init_preset()
    init = json.loads(base.to_json())["settings"]
    p = Patch()
    p.oscillators = [Osc(shape="sine")]
    doc = build_vital(p)["settings"]
    touched = {k for k in doc if doc[k] != init.get(k)}
    assert not any(k.startswith(("chorus", "delay", "reverb", "eq_", "compressor", "env_2", "lfo_2")) for k in touched)


def test_out_of_range_is_clamped_and_reported(tmp_path):
    p = Patch()
    p.oscillators = [Osc()]
    p.envelopes = [Envelope(attack=500.0)]
    synth, st, _ = load(tmp_path, p)
    assert float(text(synth, "env_1_attack").split()[0]) < 40
    assert any("clamped" in a["note"] for a in p.report.approximated)


def test_unknown_control_is_an_error():
    p = Patch()
    p.mod_matrix = [ModRoute("env_2", "not_a_control", amount=1)]
    with pytest.raises(KeyError):
        build_vital(p)


@pytest.mark.parametrize("shape", ["sine", "saw", "square", "triangle"])
def test_shapes_render_audio(tmp_path, shape):
    p = Patch()
    p.oscillators = [Osc(shape=shape)]
    synth, _, _ = load(tmp_path, p)
    audio = synth.render(60, 0.8, 0.5, 1.0)
    assert not np.isnan(audio).any() and np.abs(audio).max() > 0.01
