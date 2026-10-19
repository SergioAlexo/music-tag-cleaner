"""scan: classify files (recursing folders)."""

from __future__ import annotations

import os
from pathlib import Path

from .detect import detect

PRESET_EXTENSIONS = {".fxp", ".serumpreset", ".vital"}


def expand(paths: list[str]) -> tuple[list[Path], list[str]]:
    """Expand folders into preset-like files. Explicit files are always kept.
    Returns (files, missing)."""
    files: list[Path] = []
    missing: list[str] = []
    seen: set[str] = set()

    def add(p: Path) -> None:
        key = os.path.normcase(os.path.abspath(p))
        if key not in seen:
            seen.add(key)
            files.append(p)

    for raw in paths:
        p = Path(raw)
        if p.is_dir():
            for root, dirs, names in os.walk(p):
                dirs.sort()
                for n in sorted(names):
                    if n.startswith("._"):  # macOS AppleDouble sidecars
                        continue
                    if Path(n).suffix.lower() in PRESET_EXTENSIONS:
                        add(Path(root) / n)
        elif p.is_file():
            add(p)
        else:
            missing.append(raw)
    return files, missing


def scan_item(path: Path) -> dict:
    d = detect(path)
    item = {"path": str(path), "synth": d.synth, "name": d.name, "supported": d.supported}
    if d.reason:
        item["reason"] = d.reason
    return item
