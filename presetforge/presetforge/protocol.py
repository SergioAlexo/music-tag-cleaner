"""JSON-lines protocol. stdout carries only these lines; everything else goes to stderr."""

from __future__ import annotations

import json
import sys


class Emitter:
    def __init__(self, stream):
        self._stream = stream

    def _emit(self, obj: dict) -> None:
        self._stream.write(json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n")
        self._stream.flush()

    def progress(self, done: int, total: int, file: str) -> None:
        self._emit({"event": "progress", "done": done, "total": total, "file": file})

    def warning(self, message: str, file: str | None = None) -> None:
        obj = {"event": "warning", "message": message}
        if file is not None:
            obj["file"] = file
        self._emit(obj)

    def result(self, data: dict) -> None:
        self._emit({"event": "result", "data": data})

    def error(self, message: str) -> None:
        self._emit({"event": "error", "message": message})


def make_emitter() -> Emitter:
    """Capture the real stdout, then point sys.stdout at stderr so stray library prints
    cannot corrupt the protocol."""
    emitter = Emitter(sys.stdout)
    sys.stdout = sys.stderr
    return emitter
