# presetforge

Synth preset conversion engine for Music Tag Cleaner. Converts Serum 1 (`.fxp`) and
Serum 2 (`.SerumPreset`) presets to Vital (`.vital`) by calling
[serum2vital](https://github.com/btesser/serum2vital) in-process, and can render-check the
results with [vita](https://pypi.org/project/vita/) (Vital's engine).

## Install

```
pip install -e presetforge             # engine + serum2vital
pip install -e "presetforge[verify]"   # adds vita + numpy for `verify`
```

Python 3.11 or newer. The console script is `presetforge`; `python -m presetforge` works too.

## Usage

```
presetforge version --json
presetforge scan <path>... --json
presetforge convert <file>... --out-dir D [--serum-root R] [--max-frames N] --json
presetforge verify <file.vital>... --json
```

- `scan` accepts files or folders (folders are searched recursively for `.fxp`,
  `.SerumPreset` and `.vital`). The synth is detected from file content: Serum 1 is a VST2
  `CcnK`/`FPCh` file with plugin id `XfsX`, Serum 2 starts with `XferJson`, Vital is JSON with
  a `settings` object. Vital is recognised but `supported:false` (it is a target, not a source).
- `convert` writes `<source stem>.vital` into `--out-dir`, adding ` (2)`, ` (3)` ... on a name clash.
- `verify` loads each file in Vital's engine and renders note 48 (velocity 0.8, 1 s hold,
  2.5 s total). `silent` means peak below -80 dB, `clips` means peak above 0 dB.

## Protocol

stdout carries only JSON lines (stray library prints are redirected to stderr); stderr is free text.

```
{"event":"progress","done":3,"total":10,"file":"..."}
{"event":"warning","message":"...","file":"..."}
{"event":"result","data":{...}}        exactly one per successful run
{"event":"error","message":"..."}      fatal only; the exit code is then non-zero
```

Per-file failures never abort a run: they appear inside the items (`status:"failed"`, `error`)
and the exit code stays 0. Fatal errors (bad arguments, unreadable `--serum-root`, missing
`vita` for `verify`: `verify needs: pip install presetforge[verify]`) emit an `error` line and
exit non-zero.

Item shapes:

```
ScanItem    {path, synth:"serum1"|"serum2"|"vital"|"unknown", name, supported, reason?}
ConvertItem {source, output?, status:"ok"|"approx"|"failed", error?,
             report:{exact, approximated:[{field,note}], dropped:[{field,note}]}}
VerifyItem  {file, loaded, peakDb?, rmsDb?, silent?, clips?, nan?}
```

Report mapping from serum2vital's notes: `unsupported:` and `conflict:` notes (and anything
saying a routing was dropped or left off) go to `dropped`; `approximation:`, `unknown:` and
other notes go to `approximated`. `field` is a best-effort label parsed from the note text
(`osc A`, `filter`, `modulation`, ... or `preset`). `status` is `approx` if either list is
non-empty. **`exact` is always 0**: serum2vital does not expose a count of cleanly mapped
parameters.

## Tests

```
pip install -e "presetforge[dev]"
pytest presetforge
```

Tests read preset fixtures from the folder named by `PRESETFORGE_FIXTURES` (default: a local
`serum2vital/DebugPresets` checkout; expects `serum1/` and `crafted/serum2/` inside) and skip
when it is missing. Fixtures are never copied into this repository.

## Licence

GPL-3.0-or-later. serum2vital (GPL-3) is imported in-process, so the combined work is GPL-3.
Do not bundle vendor presets or wavetables with this package.
