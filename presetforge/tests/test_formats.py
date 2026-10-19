"""CLI-level tests for the Surge XT and Dexed/DX7 paths (fixtures generated in code)."""
import json
import subprocess
import sys

import pytest

from dexed_fixtures import eplano, sine_bank, six_op_stack, two_op
from presetforge.readers import dexed
from test_surge import SURGE_FIXTURES, basic_params, build_fxp, needs_surge


def run(*args):
    proc = subprocess.run([sys.executable, "-m", "presetforge", *args, "--json"],
                          capture_output=True, text=True, encoding="utf-8")
    lines = [json.loads(line) for line in proc.stdout.splitlines()]
    results = [l for l in lines if l["event"] == "result"]
    assert len(results) == 1, proc.stderr
    return results[0]["data"]


@pytest.fixture
def folder(tmp_path):
    d = tmp_path / "in"
    d.mkdir()
    (d / "bank.syx").write_bytes(sine_bank()[0])
    (d / "ep.syx").write_bytes(dexed.single_dump(eplano()))
    (d / "stack.syx").write_bytes(dexed.single_dump(six_op_stack()))
    (d / "bad.syx").write_bytes(b"\xF0\x43\x00\x09\x20\x00" + b"\0" * 20 + b"\xF7")
    (d / "surge.fxp").write_bytes(build_fxp(basic_params(), name="Synth Bass"))
    return d


def test_scan_detects_new_formats(folder):
    items = {i["path"].rsplit("\\", 1)[-1].rsplit("/", 1)[-1]: i for i in run("scan", str(folder))["items"]}
    assert items["bank.syx"]["synth"] == "dexed" and items["bank.syx"]["supported"]
    assert items["ep.syx"]["synth"] == "dexed" and items["ep.syx"]["name"] == "E.PIANO 1"
    assert items["surge.fxp"]["synth"] == "surge" and items["surge.fxp"]["name"] == "Synth Bass"
    assert items["bad.syx"]["synth"] == "unknown" and not items["bad.syx"]["supported"]


def test_convert_bank_single_surge_and_verify(folder, tmp_path):
    pytest.importorskip("vita")
    out = tmp_path / "out"
    data = run("convert", str(folder / "bank.syx"), str(folder / "ep.syx"), str(folder / "stack.syx"),
               str(folder / "surge.fxp"), str(folder / "bad.syx"), "--out-dir", str(out))
    items = data["items"]
    bank = [i for i in items if i["source"].endswith("bank.syx")]
    assert len(bank) == 32 and all(i["status"] in ("ok", "approx") for i in bank)
    assert bank[0]["name"] == "VOICE 00" and (out / "VOICE 00.vital").exists()
    by = {i["source"].rsplit("\\", 1)[-1].rsplit("/", 1)[-1]: i for i in items if "voice" not in i}
    assert by["ep.syx"]["status"] == "approx" and by["ep.syx"]["output"].endswith("E.PIANO 1.vital")
    assert by["stack.syx"]["report"]["dropped"]
    assert by["surge.fxp"]["output"].endswith("Synth Bass.vital")
    assert by["bad.syx"]["status"] == "failed" and by["bad.syx"]["error"]
    outputs = [i["output"] for i in items if "output" in i]
    ver = run("verify", *outputs)["items"]
    assert all(v["loaded"] and not v["nan"] for v in ver)


@needs_surge
def test_surge_factory_status_counts(tmp_path):
    pytest.importorskip("vita")
    files = [str(p) for p in sorted(SURGE_FIXTURES.rglob("*.fxp"))[:40]]
    data = run("convert", *files, "--out-dir", str(tmp_path))
    counts = {}
    for i in data["items"]:
        counts[i["status"]] = counts.get(i["status"], 0) + 1
    assert counts.get("approx", 0) + counts.get("ok", 0) >= 0.9 * len(files)


def test_non_ascii_names_survive_the_protocol(tmp_path):
    src = tmp_path / "in.fxp"
    src.write_bytes(build_fxp(basic_params(), name="Привіт ♪"))
    data = run("convert", str(src), "--out-dir", str(tmp_path / "o"))
    assert data["items"][0]["output"].endswith("Привіт ♪.vital")
