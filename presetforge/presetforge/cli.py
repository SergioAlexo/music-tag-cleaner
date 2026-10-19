"""presetforge CLI: `presetforge <cmd> --json ...`. stdout = JSON lines only."""

from __future__ import annotations

import argparse
from pathlib import Path

from . import FORMATS, __version__
from .protocol import make_emitter


class _Fatal(Exception):
    def __init__(self, message, code=1):
        super().__init__(message)
        self.code = code


class _Parser(argparse.ArgumentParser):
    def error(self, message):  # fatal: error line on stdout, exit 2
        raise _Fatal(message, 2)


def build_parser() -> argparse.ArgumentParser:
    p = _Parser(prog="presetforge")
    sub = p.add_subparsers(dest="cmd", required=True, parser_class=_Parser)

    def common(sp):
        sp.add_argument("--json", action="store_true", help="accepted; output is always JSON lines")
        return sp

    common(sub.add_parser("version"))
    common(sub.add_parser("scan")).add_argument("paths", nargs="+")
    sp = common(sub.add_parser("convert"))
    sp.add_argument("files", nargs="+")
    sp.add_argument("--out-dir", required=True)
    sp.add_argument("--serum-root")
    sp.add_argument("--max-frames", type=int)
    common(sub.add_parser("verify")).add_argument("files", nargs="+")
    return p


def cmd_version(args, out):
    out.result({"name": "presetforge", "version": __version__, "formats": FORMATS})


def cmd_scan(args, out):
    from .scan import expand, scan_item

    files, missing = expand(args.paths)
    for m in missing:
        out.warning("path not found", m)
    items = []
    for i, f in enumerate(files, 1):
        items.append(scan_item(f))
        if i % 50 == 0 or i == len(files):
            out.progress(i, len(files), str(f))
    out.result({"items": items})


def cmd_convert(args, out):
    from .convert import convert_one, make_options
    from .scan import expand

    if args.serum_root and not Path(args.serum_root).is_dir():
        raise _Fatal(f"--serum-root {args.serum_root} is not a directory", 2)
    if args.max_frames is not None and args.max_frames < 1:
        raise _Fatal("--max-frames must be >= 1", 2)
    out_dir = Path(args.out_dir)
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise _Fatal(f"cannot create out-dir: {exc}", 2)
    files, missing = expand(args.files)
    for m in missing:
        out.warning("path not found", m)
    options = make_options(args.serum_root, args.max_frames)
    cache: dict = {}
    claimed: set[str] = set()
    items = []
    for i, f in enumerate(files, 1):
        items.append(convert_one(f, out_dir, claimed, options, cache))
        out.progress(i, len(files), str(f))
    out.result({"items": items})


def cmd_verify(args, out):
    from .verify import VerifyUnavailable, make_synth, verify_one

    try:
        synth = make_synth()
    except VerifyUnavailable as exc:
        raise _Fatal(str(exc), 3)
    items = []
    for i, f in enumerate(args.files, 1):
        items.append(verify_one(synth, str(f)))
        out.progress(i, len(args.files), str(f))
    out.result({"items": items})


COMMANDS = {"version": cmd_version, "scan": cmd_scan, "convert": cmd_convert, "verify": cmd_verify}


def main(argv: list[str] | None = None) -> int:
    out = make_emitter()
    try:
        args = build_parser().parse_args(argv)
        COMMANDS[args.cmd](args, out)
        return 0
    except _Fatal as exc:
        out.error(str(exc))
        return exc.code
    except SystemExit as exc:
        return int(exc.code or 0)
    except Exception as exc:
        out.error(f"{type(exc).__name__}: {exc}")
        return 1
