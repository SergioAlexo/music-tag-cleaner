"""Detect a preset's synth by content (not just extension)."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from .readers import dexed, surge

SERUM2_MAGIC = b"XferJson"
SERUM1_PLUGIN_ID = b"XfsX"


@dataclass
class Detected:
    synth: str  # serum1 | serum2 | surge | dexed | vital | unknown
    name: str
    supported: bool
    reason: str | None = None


def _serum_name(synth: str, path: Path, fallback: str) -> str:
    try:
        if synth == "serum1":
            from serum2vital import serum1
            return serum1.read(str(path)).name or fallback
        from serum2vital import serum2
        return serum2.read(str(path)).name or fallback
    except Exception:
        return fallback


def _detect_dx7(path: Path, stem: str, kind: str | None) -> Detected:
    try:
        data = path.read_bytes() if path.stat().st_size <= 1 << 20 else b""
        voices, _ = dexed.parse_syx(data)
    except (OSError, dexed.DexedError) as exc:
        return Detected("unknown", stem, False, f"not a readable DX7 SysEx dump: {exc}")
    return Detected("dexed", voices[0].name or stem if len(voices) == 1 else stem, True)


def detect(path: Path) -> Detected:
    stem = path.stem
    try:
        with open(path, "rb") as fh:
            head = fh.read(64)
    except OSError as exc:
        return Detected("unknown", stem, False, f"cannot read file: {exc.strerror or exc}")
    if not head:
        return Detected("unknown", stem, False, "file is empty")
    if head.startswith(SERUM2_MAGIC):
        return Detected("serum2", _serum_name("serum2", path, stem), True)
    if head[:4] == b"CcnK":
        if head[8:12] == b"FPCh" and head[16:20] == SERUM1_PLUGIN_ID:
            return Detected("serum1", _serum_name("serum1", path, stem), True)
        if surge.looks_like_surge(head):
            return Detected("surge", surge.program_name(head) or stem, True)
        return Detected("unknown", stem, False, "VST2 preset for a plugin other than Serum 1 or Surge XT")
    kind = dexed.looks_like_dx7(head)
    if kind or path.suffix.lower() == ".syx":
        return _detect_dx7(path, stem, kind)
    if head.lstrip()[:1] == b"{":
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return Detected("unknown", stem, False, "not valid JSON")
        if isinstance(doc, dict) and isinstance(doc.get("settings"), dict):
            name = doc.get("preset_name")
            return Detected("vital", name if isinstance(name, str) and name else stem, False,
                            "Vital presets are a conversion target, not a source")
        return Detected("unknown", stem, False, "JSON without a Vital 'settings' object")
    return Detected("unknown", stem, False, "unrecognised preset format")
