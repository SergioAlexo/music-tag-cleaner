"""Measure Vital's FM depth (osc_distortion_amount) as an equivalent phase-modulation index.

Carrier osc1 and modulator osc2 are both sines at the same pitch, so harmonic m of the output
has magnitude |J_(m-1)(beta)|. beta is fitted per amount; paste the printed table into
vital_writer.FM_AMOUNT_TO_BETA. Needs vita + numpy.
"""
import numpy as np
import vita

from presetforge.upm import Osc, Patch
from presetforge.vital_writer import build_vital
import json

SR = 44100
F0 = 440 * 2 ** ((60 - 69) / 12)
T = np.arange(0, 30, 0.05)


def _model(beta, phi, n=8):
    x = np.arange(4096) / 4096
    y = np.sin(2 * np.pi * x + beta * np.sin(2 * np.pi * x + phi))
    sp = np.abs(np.fft.rfft(y))[1:n + 1]
    return sp / np.linalg.norm(sp)


PHIS = np.linspace(0, 2 * np.pi, 16, endpoint=False)
TAB = np.array([[_model(b, ph) for ph in PHIS] for b in T])   # (beta, phi, harmonic)


def measure(amount, mod_level=0.0):
    p = Patch()
    p.oscillators = [Osc(shape="sine", fm_from=1, fm_index=1.0, random_phase=False),
                     Osc(shape="sine", level=mod_level, random_phase=False)]
    doc = build_vital(p)
    doc["settings"]["osc_1_distortion_amount"] = amount
    doc["settings"]["env_1_attack"] = 0.0
    doc["settings"]["env_1_release"] = 0.0
    s = vita.Synth(); s.set_sample_rate(SR)
    assert s.load_json(json.dumps(doc))
    a = s.render(60, 1.0, 1.0, 1.5)[0]
    seg = a[int(0.5 * SR):int(1.3 * SR)]
    sp = np.abs(np.fft.rfft(seg * np.hanning(len(seg)))); fr = np.fft.rfftfreq(len(seg), 1 / SR)
    h = np.array([sp[np.argmin(abs(fr - F0 * k)) - 2:np.argmin(abs(fr - F0 * k)) + 3].max() for k in range(1, 9)])
    h = h / np.linalg.norm(h)
    e = ((TAB - h) ** 2).sum(2).min(1)
    return T[e.argmin()], e.min()


if __name__ == "__main__":
    for lvl in (0.0,):
        print("modulator level", lvl)
        for amt in (0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.6, 0.8, 1.0):
            b, err = measure(amt, lvl)
            print(f"  amount {amt:.1f} -> beta {b:.2f} (err {err:.3f})")
