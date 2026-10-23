"""convert: Serum 1/2 -> Vital via serum2vital's in-process API."""

from __future__ import annotations

import re
from pathlib import Path

from .detect import detect

_FIELD_RE = re.compile(
    r"^(osc [A-Z]|oscillator \w+|filter ?\d?|lfo ?\d+|env(?:elope)? ?\d+|modulation|"
    r"macro ?\d*|reverb|delay|chorus|flanger|phaser|distortion|compressor|eq|"
    r"effect order|effect|unison|sub|noise|voicing|arp|sample|wavetable)\b",
    re.IGNORECASE,
)

# serum2vital notes look like "<class>: message". "unsupported"/"conflict" mean the
# thing was dropped; everything else (approximation, unknown, ...) counts as approximated.
_DROPPED = ("unsupported", "conflict")


def classify_notes(notes: list[str]) -> tuple[list[dict], list[dict]]:
    """Split serum2vital notes into (approximated, dropped) lists of {field, note}."""
    approx: list[dict] = []
    dropped: list[dict] = []
    for raw in notes:
        head, sep, rest = raw.partition(":")
        kind = head.strip().lower() if sep else ""
        text = rest.strip() if sep else raw.strip()
        m = _FIELD_RE.match(text)
        field = m.group(1) if m else "preset"
        entry = {"field": field, "note": text}
        if kind in _DROPPED or "dropped" in raw.lower() or "left off" in raw.lower():
            dropped.append(entry)
        else:
            approx.append(entry)
    return approx, dropped


def unique_output(out_dir: Path, stem: str, claimed: set[str]) -> Path:
    safe = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", stem).strip(" .") or "preset"
    n = 1
    while True:
        name = f"{safe}.vital" if n == 1 else f"{safe} ({n}).vital"
        if name.lower() not in claimed and not (out_dir / name).exists():
            claimed.add(name.lower())
            return out_dir / name
        n += 1


def convert_one(source: Path, out_dir: Path, claimed: set[str], options, cache: dict) -> dict:
    from serum2vital.convert import convert_file
    from serum2vital.writer import write

    item: dict = {"source": str(source), "status": "failed",
                  "report": {"exact": 0, "approximated": [], "dropped": []}}
    try:
        d = detect(source)
        if d.synth not in ("serum1", "serum2"):
            item["error"] = d.reason or f"unsupported source format: {d.synth}"
            return item
        conv = convert_file(source, options, cache)
        approx, dropped = classify_notes(list(conv.notes))
        target = unique_output(out_dir, source.stem, claimed)
        write(conv, target)
        item["output"] = str(target)
        item["report"] = {"exact": 0, "approximated": approx, "dropped": dropped}
        item["status"] = "approx" if (approx or dropped) else "ok"
    except Exception as exc:  # per-file failure stays inside the item
        item["status"] = "failed"
        item["error"] = f"{type(exc).__name__}: {exc}"
    return item


def _convert_foreign(source: Path, d, out_dir: Path, claimed: set[str]) -> list[dict]:
    """Surge / Dexed: read to UPM patches, write each through the generic Vital writer."""
    from .vital_writer import write_vital

    items: list[dict] = []
    base = {"source": str(source), "status": "failed", "report": {"exact": 0, "approximated": [], "dropped": []}}
    try:
        if d.synth == "surge":
            from .readers import surge
            patches, warnings = surge.patches_from_file(str(source))
            errors: list[str | None] = [None] * len(patches)
        else:
            from .readers import dexed
            patches, warnings, errors = dexed.patches_from_file_lenient(str(source))
    except Exception as exc:
        item = dict(base, error=f"{type(exc).__name__}: {exc}")
        item["report"] = dict(base["report"])
        return [item]
    bank = len(patches) > 1
    for i, (patch, err) in enumerate(zip(patches, errors), 1):
        item = {"source": str(source), "status": "failed",
                "report": {"exact": 0, "approximated": [], "dropped": []}}
        if bank:
            item["voice"] = i
        if err is not None:
            item["error"] = err
            items.append(item)
            continue
        try:
            for w in warnings:
                patch.report.approx("file", w)
            target = unique_output(out_dir, patch.meta.name or source.stem, claimed)
            write_vital(patch, target)
            item["output"] = str(target)
            item["report"] = patch.report.as_item()
            item["status"] = patch.report.status
            if bank:
                item["name"] = patch.meta.name
        except Exception as exc:
            item["error"] = f"{type(exc).__name__}: {exc}"
        items.append(item)
    return items


def convert_many(source: Path, out_dir: Path, claimed: set[str], options, cache: dict) -> list[dict]:
    """One ConvertItem per output preset (a DX7 bank gives up to 32 items sharing `source`)."""
    try:
        d = detect(source)
    except Exception as exc:
        return [{"source": str(source), "status": "failed", "error": f"{type(exc).__name__}: {exc}",
                 "report": {"exact": 0, "approximated": [], "dropped": []}}]
    if d.synth in ("surge", "dexed"):
        return _convert_foreign(source, d, out_dir, claimed)
    return [convert_one(source, out_dir, claimed, options, cache)]


def make_options(serum_root: str | None, max_frames: int | None):
    from serum2vital.convert import Options
    from serum2vital.wavetables import DEFAULT_FRAME_LIMIT

    return Options(
        serum_root=Path(serum_root) if serum_root else None,
        max_frames=max_frames if max_frames else DEFAULT_FRAME_LIMIT,
    )
