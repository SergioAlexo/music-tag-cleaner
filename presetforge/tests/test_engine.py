import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

DEFAULT_FIXTURES = r"C:\Users\PashchenkoS\Desktop\claude\preset-spikes\serum2vital\DebugPresets"
FIXTURES = Path(os.environ.get("PRESETFORGE_FIXTURES", DEFAULT_FIXTURES))

needs_fixtures = pytest.mark.skipif(not FIXTURES.is_dir(), reason="fixtures not available")


def run(*args):
    proc = subprocess.run([sys.executable, "-m", "presetforge", *args, "--json"],
                          capture_output=True, text=True, encoding="utf-8")
    lines = [json.loads(line) for line in proc.stdout.splitlines()]  # every line must be JSON
    return proc.returncode, lines


def one_result(lines):
    results = [l for l in lines if l["event"] == "result"]
    assert len(results) == 1
    return results[0]["data"]


def pick(folder, pattern, n=3):
    return [str(p) for p in sorted((FIXTURES / folder).glob(pattern))[:n]]


def test_version():
    rc, lines = run("version")
    assert rc == 0
    data = one_result(lines)
    assert data == {"name": "presetforge", "version": "0.1.0", "formats": ["serum1", "serum2", "vital"]}


def test_bad_args_fatal_error_line():
    proc = subprocess.run([sys.executable, "-m", "presetforge", "nope"], capture_output=True, text=True)
    assert proc.returncode != 0
    assert json.loads(proc.stdout.splitlines()[0])["event"] == "error"


def test_scan_detects_by_content(tmp_path):
    (tmp_path / "x.vital").write_text(json.dumps({"preset_name": "Hello", "settings": {}}))
    (tmp_path / "weird.fxp").write_bytes(b"not a preset at all")
    (tmp_path / "ignored.txt").write_text("hi")
    rc, lines = run("scan", str(tmp_path))
    assert rc == 0
    items = {Path(i["path"]).name: i for i in one_result(lines)["items"]}
    assert set(items) == {"x.vital", "weird.fxp"}
    assert items["x.vital"]["synth"] == "vital" and items["x.vital"]["name"] == "Hello"
    assert items["weird.fxp"]["synth"] == "unknown" and not items["weird.fxp"]["supported"]
    assert items["weird.fxp"]["reason"]


@needs_fixtures
def test_scan_serum_files():
    files = pick("serum1", "*.fxp") + pick("crafted/serum2", "*.SerumPreset")
    assert len(files) >= 2
    rc, lines = run("scan", *files)
    items = one_result(lines)["items"]
    assert len(items) == len(files)
    for it in items:
        assert it["synth"] in ("serum1", "serum2") and it["supported"] and it["name"]


@needs_fixtures
def test_convert_and_verify(tmp_path):
    files = pick("serum1", "*.fxp") + pick("crafted/serum2", "*.SerumPreset")
    rc, lines = run("convert", *files, "--out-dir", str(tmp_path))
    assert rc == 0
    assert any(l["event"] == "progress" for l in lines)
    items = one_result(lines)["items"]
    assert len(items) == len(files)
    for it in items:
        assert it["status"] in ("ok", "approx"), it
        assert Path(it["output"]).is_file()
        rep = it["report"]
        assert isinstance(rep["exact"], int)
        for e in rep["approximated"] + rep["dropped"]:
            assert e["field"] and e["note"]
    outs = [it["output"] for it in items]
    assert len(set(outs)) == len(outs)

    vita = pytest.importorskip("vita")  # noqa: F841
    outs = [it["output"] for it in items]
    rc, lines = run("verify", *outs)
    assert rc == 0
    vitems = one_result(lines)["items"]
    assert len(vitems) == len(outs)
    for v in vitems:
        assert v["loaded"] is True
        assert isinstance(v["peakDb"], float) and isinstance(v["rmsDb"], float)
        assert isinstance(v["silent"], bool) and isinstance(v["clips"], bool) and v["nan"] is False


def test_convert_non_serum_fails_in_item(tmp_path):
    src = tmp_path / "x.vital"
    src.write_text(json.dumps({"settings": {}}))
    rc, lines = run("convert", str(src), "--out-dir", str(tmp_path / "out"))
    assert rc == 0
    it = one_result(lines)["items"][0]
    assert it["status"] == "failed" and it["error"]


def test_verify_bad_file(tmp_path):
    pytest.importorskip("vita")
    bad = tmp_path / "bad.vital"
    bad.write_text("garbage")
    rc, lines = run("verify", str(bad))
    assert rc == 0
    assert one_result(lines)["items"][0]["loaded"] is False


def test_classify_notes():
    from presetforge.convert import classify_notes

    a, d = classify_notes([
        "approximation: osc A unison stack 'x' -> Vital style 2",
        "unsupported: modulation source 'Foo' has no Vital counterpart; routing dropped",
        "conflict: more than 64 modulations; extra routings dropped",
    ])
    assert len(a) == 1 and a[0]["field"] == "osc A"
    assert len(d) == 2 and d[0]["field"] == "modulation"


@needs_fixtures
def test_output_name_dedup(tmp_path):
    import shutil

    src = pick("serum1", "*.fxp", 1)[0]
    a, b = tmp_path / "a" / "same.fxp", tmp_path / "b" / "same.fxp"
    for d in (a, b):
        d.parent.mkdir()
        shutil.copy(src, d)
    rc, lines = run("convert", str(a), str(b), "--out-dir", str(tmp_path / "out"))
    names = sorted(Path(i["output"]).name for i in one_result(lines)["items"])
    assert names == ["same (2).vital", "same.vital"]
