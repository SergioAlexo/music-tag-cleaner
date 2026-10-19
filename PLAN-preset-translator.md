# Plan — Preset Translator add-on (any synth → Vital, plus Prompt → Preset)

Status: **plan + research only, nothing built.** Written 2026-10-19.

Hand-off plan for an implementing agent. Read `CLAUDE.md` first (stack, commands,
hard-won rules). Do **not** read ROADMAP.md whole — grep its headings.

The owner mostly works in **Vital**, so Vital is the hub output. Every other synth
is first an *input* format. Writing back into other synths is a later bonus.

The owner's rules for this feature (same spirit as the rest of the app):
- **Never touch the source preset.** Output always goes to a separate folder, and
  nothing is written until the user confirms a preview. This is the same as the
  tag-cleaner's confirm-before-write and backup rules.
- **No silent guessing.** Every converted preset gets a report listing which
  parameters mapped exactly, which were approximated (and how), and which were
  dropped. A preset that is "close" never pretends to be exact.
- **Never redistribute vendor content.** Factory wavetables and samples are read
  from the user's own install at conversion time and are never bundled or uploaded.

---

## 1. Research findings (checked 2026-10-19, don't re-derive)

### 1.1 An open-source Serum → Vital converter already exists: `serum2vital`
<https://github.com/btesser/serum2vital>. This is the biggest finding.
- Python 3.9+ CLI. **GPL-3.0-or-later, which is the same licence as this app**, so it
  can be vendored or depended on. Its licence is GPL because it ships a parameter
  table generated from Vital's GPL source.
- It reads **Serum 1 `.fxp`** (both LFO layouts) and **Serum 2 `.SerumPreset`**, and
  writes `.vital`. Serum 1 uses only the standard library. Serum 2 needs
  `zstandard` and `cbor2`.
- **Mapping:** menu orders and unit curves were read back from Serum itself and
  are fitted in closed form, e.g. env time `t = 32·n⁵` s and LFO rate `100·n⁴` Hz.
  It also has a 96-entry filter catalog. `tools/calibrate.py` runs the parameter
  sweeps the curves were fitted from.
- **Wavetables:** it reads the user's Serum `Tables/` and `Noises/` folders
  (`--serum-root`) and embeds the tables in the `.vital` file. `--max-frames`
  defaults to 64; 16 frames gives roughly a quarter of the file size.
- **Validation:** it renders through both synths headlessly (DawDreamer hosts Serum,
  pedalboard hosts Vital). It scores level, 1/6-octave spectral distance, envelope
  correlation and FX checks (echo times, tail decay, crest factor, stereo width).
  Results over 645 presets (v0.6.0): median spectral distance 8 dB, envelope
  correlation 0.73, most presets within 3 dB.
- **What it does not convert:** Serum 2's granular, spectral and multisample engines,
  the arpeggiator, clips, macros 5–8, LFOs 9–10, buses, convolution and splitters.
  Flip/Mirror/Remap warps, Ring Mod and SampHold filters, and Plate reverb are
  dropped. Hyper/Dimension is approximated with Vital's chorus. Its README calls the
  output "a structurally faithful starting point, not a bit-exact clone".
- **Maturity:** very new. 0.1.0 shipped 2026-09-08 and 0.6.1 on 2026-09-11. It has
  one author, 20 commits and about 60 stars.
- **Decision:** build on it, don't rewrite it. Pin a commit, wrap it behind our
  reader interface, and send fixes upstream.

### 1.2 Format-by-format status

| Synth | File | What's inside | Existing tooling | Tier |
|---|---|---|---|---|
| **Vital** | `.vital`, `.vitalbank` | JSON. Settings are human-readable. Wavetables and samples are base64 blobs (`wave_data`, `samples`), duplicated per oscillator. A bank is a collection of presets plus their wavetables, samples and LFO shapes. | Vital source is GPL-3. `vita` gives Python bindings to the real engine (`load_preset`, `load_json`, `to_json`, render). | **A — hub (read + write)** |
| **Serum 1** | `.fxp` | VST2 `CcnK`/`FPCh` container, plugin ID `XfsX`, with a zlib-compressed opaque chunk. Params are LE float32 at about 0x3460 (about 290 of them). A second zlib stream holds the wavetable (2048-sample frames). | serum2vital, `demberto/fxp`, 0xdevalias' Kaitai sketch | **A** (via serum2vital) |
| **Serum 2** | `.SerumPreset` | `XferJson` magic + JSON metadata header, then a zstd blob containing CBOR. Has Oscillator0-4, Env0-3, LFO*, ModSlot0-63, FXRack0. Every key is present and unchanged values are stored as `"default"`. | serum2vital, `serum-preset-packager` (Py), `node-serum2-preset-packager` (TS). Repacked files load in Serum 2. | **A** (via serum2vital) |
| **Surge XT** | `.fxp` | VST2 container whose chunk is **XML**. Surge is open source (GPL-3), so every parameter and curve is in the source. | Surge source | **A** (needs our own reader) |
| **u-he** Diva / Hive / Zebra / Repro | `.h2p` | Plain text: a meta comment block, then sections of `name=value` lines. Parameter names are short codes; no public map. | none for parameter meaning | **B** (easy to parse, needs per-synth calibration) |
| **Dexed / DX7** | `.syx` | Fully documented SysEx. | many | **B** (FM → Vital FM is an approximation) |
| **Sylenth1** | `.fxp` / `.fxb` | VST2 container; the version byte sits at offset 64 (fxp) or 164 (fxb). Unknown whether it stores a float param list or an opaque chunk. | community hex notes only | **B?** (verify in spike S3) |
| **Massive** | `.nmsv` (old `.ksd`) | Undocumented NI container. `ni-file` handles NI containers but doesn't claim `.nmsv`. | `ni-file` (partial) | **C** |
| **Massive X** | `.nksf` | RIFF with NISI/NICA/PLID chunks in MessagePack. The **PCHK** chunk is the plugin's opaque state. **Since v1.7 every parameter is exposed to the host**, so host capture is viable. | community notes only | **C+** (host capture) |
| **Phase Plant** | `.phaseplant` | **v2.2+: JSON inside a ZIP.** Older versions use a binary format. | `synthahol-phase-plant` (Rust, reads/writes the old binary format; its README says the new format isn't supported) | **B** (upgraded 2026-10-19) |
| **Pigments** | `.pgtx` (bank/export) | Undocumented. It can be very large and may embed samples, or reference sample packs the user doesn't own. | none found | **C** |

**Tier A**: the format is known and the mapping exists or is derivable from source.
**Tier B**: easy to read, but each synth's parameter meanings must be calibrated.
**Tier C**: closed format; uses the *host-capture* and *audio-match* fallbacks (§3.4).

### 1.3 Prompt → preset: prior art
- **Prompt2Patch** (<https://prompt2patch.com/>): commercial, text → `.vital`.
- **A Vital-forum student project**: generative model trained to make Vital presets by
  sound type and genre.
- **MicroMusic** (<https://micromusic.tech/>): audio sample → Vital preset.
- **serum-mcp** (<https://github.com/Celian-mrc/serum-mcp>): natural language → Serum 2
  presets over MCP. It documents a confidence level per parameter.
- **centrifuge** (<https://github.com/OneStopSlopShop/centrifuge>): text or reference
  audio → `.SerumPreset` using two Claude agents.
- **Syntheon** (<https://github.com/gudgud96/syntheon>): audio → synth params, discussed
  for Vital.
- **Vinetics** (<https://github.com/SlavaCat118/Vinetics>): genetic "breeding" of Vital
  presets.
- **Research:** InverSynth (CNN param estimation), FlowSynth (VAE + normalizing flows,
  because parameter loss tracks perceived sound badly), DAFx-24 (spectrogram
  transformer trained on Massive), CTAG (text → 78-param synth via CLAP scoring).
- **Takeaway:** for an LLM, Vital is the easiest target because its presets are
  readable text. Raw LLM output is unreliable, though. The working projects all
  **constrain the model to a schema** and/or **check the result by ear (rendering)**.
  That is the design in §4.

### 1.4 Rendering / hosting (needed for Verify & Fix)
- **`vita`** (GPL-3, <https://github.com/dbraun/vita>): Vital's engine as a Python
  module. It renders a `.vital` with **no Vital install needed**. This is the
  cheapest way to listen to our own output.
- **DawDreamer** (JUCE + pybind11): hosts VST2/VST3, loads `.fxp`, renders offline.
  serum2vital uses it to render Serum.
- **pedalboard** (Spotify): loads VST3 and renders. serum2vital uses it for Vital.
- **Rust** (`vst3-host` 0.5): save/load state works, but no offline-render API is
  documented. Known headless-host pitfalls: some plugins render silence without a
  message loop, and VST3 wants state calls on the message thread. **Conclusion:**
  render from Python, not from the Rust side of the app.

---

## 2. How it fits Music Tag Cleaner

*Reworked 2026-10-19 for the plugin SDK (v0.19, `PLUGINS.md`, `plugins/sdk.d.ts`,
`src/plugins/*`). It replaces the earlier "Components page add-on" design.*

**The person gets it as a plugin:** a free **"Preset Translator"** entry in
Plugins → Store. They install it, review its permissions and code in the usual
dialog, and it appears. The tag cleaner stays the same for anyone who doesn't
install it.

### 2.1 Why the plugin can't be the whole thing
The v1 SDK is deliberately locked down, and the translator needs things it forbids:

| Translator needs | SDK v1 allows | Consequence |
|---|---|---|
| Read preset files, wavetables, Serum's `Tables/` | No file access; plugins see tracks only via `read` actions | Preset I/O must be a **host action** |
| Run the Python engine (serum2vital, vita) | Sandboxed iframe + Worker: no process spawn, `script.run` never reachable | The engine is a **host-managed binary** |
| Ship tens of MB of engine | Store zip: manifest + one script only, 512 KB per file, other files ignored | The engine is **downloaded by the host**, not inside the plugin zip |
| A preset list with preview/report | Buttons, context menu, columns on the *track* table, notify/confirm | The list is a **host dialog** opened by an action, like `convert.open` / `stems.open` |
| Write `.vital` files | Write permissions cover tags, artwork and moving audio files only | Needs a **new, narrow permission** |

So the design has three layers. Each one is a small, reviewable change.

```
┌─ Plugin "preset-translator" (store zip, ~5 KB, free) ─────────────────────────┐
│ manifest: permissions ["presets", "ui.control"], requires {engine: presetforge}│
│ buttons:  "Presets" → presets.open                                            │
│ actions:  convertFolder, makeFromPrompt (thin wrappers, also MCP-callable as  │
│           plugin.preset-translator.*)                                         │
│ settings: output folder, Serum data folder, max frames, auto-verify           │
└──────────────────────────────┬────────────────────────────────────────────────┘
                               │ mtc.call("presets.*")  (permission-checked)
┌─ Host (MTC core) ────────────▼────────────────────────────────────────────────┐
│ src/lib/appActions.ts  presets.open / scan / convert / verify / generate /    │
│                        edit / report     → also visible to AI over mtc-mcp    │
│ src/plugins/permissions.ts  "presets.*" → "presets"                          │
│ commands/presets.rs   spawn engine, stream JSON lines, enforce write rules   │
│ commands/engines.rs   install/verify/update engines (reuses plugin_store.rs  │
│                       SHA-256 verify + zip unpack)                           │
│ PresetsDialog.tsx     list + preview + report (opened by presets.open)       │
└──────────────────────────────┬────────────────────────────────────────────────┘
                               │ stdin/stdout JSON lines, no port
┌─ Engine "presetforge" (own repo, GPL-3, PyInstaller one-folder) ─────────────▼┐
│ readers/ ir/ (UPM) writers/ verify/ fix/ prompt/   (§3–§4)                    │
└────────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Host changes (MTC core, one PR)
1. **Actions** in `src/lib/appActions.ts`, implemented in `commands/presets.rs`:

   | Action | Does | Writes? |
   |---|---|---|
   | `presets.open` | Opens the Presets dialog, optionally on a folder | no |
   | `presets.scan` | Lists preset files under a folder: format, synth, name, status | no |
   | `presets.convert` | Converts to `.vital` and returns a **pending** result (files staged in a temp dir, plus a per-preset report). Nothing lands in the output folder yet. | staging only |
   | `presets.verify` | Renders and returns match scores and fix proposals (§3.6) | no |
   | `presets.generate` | Prompt → staged `.vital` (§4), using the host AI backends | staging only |
   | `presets.edit` | Edit ops on an existing Vital preset → staged result | staging only |
   | `presets.apply` | Moves staged results into the output folder after the person confirms | yes |
   | `presets.report` | Returns the report JSON for a staged or applied batch | no |

   The split between staging and `presets.apply` mirrors `changes.get` → `changes.apply`
   for tags: **AI assistants and plugins can propose, but only a confirm writes.**
2. **Permission `presets`** in `src/plugins/permissions.ts` (`presets.*` → `presets`) and
   in the PLUGINS.md table. It may read preset/wavetable files the person picked and
   write **only** into the configured output folder: never over a source file, never
   outside that folder. This is enforced in Rust, not trusted from the caller.
   `presets.apply` additionally asks every time, like `files.delete`.
3. **Engines: a small SDK extension, `requires.engines`.** The manifest declares, e.g.,
   `"requires": {"engines": [{"id": "presetforge", "version": ">=0.1"}]}`. The host keeps
   an **allowlisted engine index** (id → https URL + SHA-256 + size, compiled into the
   app or signed). Plugins can never supply their own URL. The review dialog shows
   "This plugin needs the presetforge engine (≈N MB) from <host>". Install, verify and
   update reuse `plugin_store.rs` (SHA-256 check, zip unpack). Binaries live in
   `<app data>/engines/<id>/<version>/`. This is generic, so future heavy plugins (stems
   models, etc.) can reuse it. If the SDK extension is rejected, the fallback is a
   Components-page entry, which was the old design.
4. **`PresetsDialog.tsx`**: a host-rendered dialog following the app's rules (virtualized
   list, selecting separate from ticking, preview before write, buttons and no drag
   gestures). Columns: name, source synth, status ✓/≈/✗, match score, size. A
   report drawer lists exact / approximated / dropped. It is opened only through
   `presets.open`, so it is invisible unless something calls it.
5. **Settings** live in the plugin's `contributes.settings`, not the app's
   settings blob, so no `CURRENT_SETTINGS_VERSION` bump is needed. The plugin reads
   them with `mtc.settings.get` and passes them as `presets.*` parameters; the dialog
   gets them the same way through `presets.open`. Settings: output
   folder, Vital user folder (default `Documents\Vital\User\Presets`), Serum data
   folder, max frames, auto-verify.
6. **Without the plugin**, `presets.*` actions still exist (so MCP can discover them)
   but return "Install the Preset Translator plugin" and do nothing. One switch,
   no dead UI.

### 2.3 The plugin itself
- **No logic of its own**, by design. It is the opt-in switch, the button, the settings,
  and two convenience actions:
  - `convertFolder({folder})`: `presets.scan` → `presets.convert` → `presets.open` on the
    result.
  - `makeFromPrompt({prompt, base?})`: `presets.generate` → `presets.open`.
- **Free, as the store requires.** Paid parts (cloud AI for Prompt → Preset) are gated
  host-side by the v1.0 entitlements, never by plugin code.
- Lives in `plugins-examples/preset-translator/` for development, then publishes to the
  store index (zip + SHA-256 as in PLUGINS.md).

### 2.4 What this unlocks for free
- **AI control:** `presets.*` are registry actions, so Claude Code and other MCP clients
  can call them through `mtc-mcp`. For example: "make me 5 reese basses and convert my
  Downloads/Serum folder". Prompt → Preset gets a second front end at no extra cost.
- **User macros:** "New button with AI" can build buttons on top of `presets.*`, such as
  "convert this folder with 16 frames".

### 2.5 Engine packaging (unchanged in substance)
- **The engine lives in its own repo** (working name `presetforge`). It is Python
  because serum2vital, vita, DawDreamer and pedalboard are all Python. It also works
  as a standalone CLI, which is how it gets tested.
- **Core plus render in one build:** the PyInstaller one-folder build includes `vita`,
  because S4 showed vita installs and renders headless on Windows/Python 3.13, so
  Verify & Fix of the *Vital side* needs no Python on the person's machine.
  Rendering the *source* synth (DawDreamer/pedalboard plus the person's own plugins)
  is an optional second engine, `presetforge-host`, listed under the same
  `requires.engines` mechanism.
- **Protocol:** `presetforge <cmd> --json` emits one JSON object per line, as
  `{"event":"progress"|"result"|"warning"|"error", ...}`. `presets.rs` relays progress
  as Tauri events to the dialog. No HTTP server and no port.
- **Licensing:** the app, serum2vital, vita and Surge are all GPL-3, so they are
  compatible. Pricing tier (Pro vs Studio) is an open question (§7).

---

## 3. The translator

### 3.1 Universal Patch Model (UPM)
One internal JSON schema between readers and writers, so each new synth costs one
reader instead of one converter per pair. It is modelled on Vital's feature set
(the hub), plus a `foreign` bag for anything Vital can't express, so nothing is lost
silently.

```
Patch
  meta        name, author, category, tags, source {synth, version, file}
  oscillators[ ] type (wavetable|sample|noise|fm|subtractive-shape),
                 wavetable {frames[][], frame_size, source_ref}, position,
                 pitch {oct, semi, cents}, level, pan, unison {voices, detune,
                 blend, spread}, phase {start, random}, warp {kind, amount}
  filters[ ]  model (canonical family: ladder/svf/comb/formant/…), mode,
              cutoff_hz, resonance, drive, keytrack, routing
  envelopes[ ] delay/attack/hold/decay/sustain/release in SECONDS, curve per stage
  lfos[ ]     shape (points), rate {hz | sync division}, mode, phase, smooth
  macros[ ]   name, value
  mod_matrix[ ] source, dest, amount, bipolar, curve
  fx[ ]       chorus, delay, reverb, distortion, eq, compressor, phaser, flanger
  voice       polyphony, glide, legato, pitch-bend range, master level
  foreign     {unmapped source params, verbatim}
  report      per-field: exact | approximated(how) | dropped(why)
```

All values are stored in **physical units** (Hz, seconds, dB, semitones), never as
0–1 knob positions. Each reader converts from its knob curve, and the Vital writer
converts into Vital's curves. That way a curve is only fitted once per synth.

### 3.2 Readers (input) — order of work
1. **Serum 1 + Serum 2**: wrap serum2vital. It goes directly to Vital today, so add
   a thin adapter that exposes its intermediate data as UPM (or, in phase 1, let it
   write Vital directly and mark the report from its known-dropped list).
2. **Vital**: needed for Vital → Vital "fix" passes, bank cleanup (§5) and prompt
   retrieval (§4).
3. **Surge XT**: XML parse; the curves are taken from Surge's source.
4. **u-he `.h2p`**: a generic text parser plus a calibrated map per synth (Diva,
   Hive, Zebra 2, Repro). Calibration uses the serum2vital method: save single-change
   fixtures, sweep each parameter in the host, fit curves (`calibrate` tool, §3.5).
5. **Dexed / DX7 `.syx`**: maps to Vital's FM between oscillators. Expect an
   approximation, since a 6-operator DX7 doesn't fit 3 oscillators. Report which
   operators were collapsed.
6. **Sylenth1**: depends on spike S3. If the `.fxp` holds a float param list, the
   names come from the plugin's own parameter list via a host, and it becomes tier B.
7. **Massive / Massive X / Pigments**: tier C, see §3.4. Phase Plant moved to tier B.
   §8 has a full spec for each converter and supersedes this ordering.

### 3.3 Vital writer
- Start from a known-good Vital init preset embedded in the engine, and overwrite
  only what the UPM sets. That way any key we don't know stays at Vital's default.
- Wavetables: frames are resampled to Vital's frame size. One copy is embedded per
  oscillator because Vital duplicates them anyway. `max_frames` reduction is
  optional, with the file-size estimate shown in the UI.
- Parameters Vital can't express go into the report. They are not written as
  comments, since Vital strips them.
- **Must be validated against Vital's own loader**: every output goes through `vita`
  `load_preset` → `to_json` in CI, and the test fails if Vital rejects or rewrites
  a field.

### 3.4 Closed formats (tier C): two fallbacks
1. **Host capture (parameter dump).** Load the preset into the *real* plugin through
   DawDreamer/pedalboard, then read every exposed parameter's **name, normalized
   value and display text** (e.g. "Cutoff: 1.2 kHz"). The display text gives physical
   units without knowing the curve. This only works if the user owns the synth, and
   only as far as the plugin exposes parameters to the host. Spike S5 measures this
   per synth. If loading a vendor preset file through a host isn't possible, the
   user saves it from their DAW as a `.fxp`/`.vstpreset` first; the UI explains how.
2. **Audio match (sound-alike).** Render the source preset through the real plugin
   on a fixed set of probe notes. Then search for a Vital patch that sounds the same
   (§3.6 optimizer), starting from the host-capture result if one exists, otherwise
   from the closest preset in the user's Vital library (§4.3). The report always
   labels this result **"sound-alike, not a translation"**.

Neither fallback needs the file format to be cracked, which is why tier C is
reachable at all. Native readers for C formats are optional later work.

### 3.5 Calibration tooling (dev-only, in the engine repo)
- `presetforge calibrate <plugin> <param>`: sweeps a parameter through the host,
  measures the result (pitch, cutoff via spectral tilt, envelope time via onset
  detection), and fits a curve. Writes `curves/<synth>.json`.
- **Fixture rule:** for every synth, keep a folder of single-change presets
  (init + one knob moved) with expected UPM values. These double as regression tests.
- **Never commit vendor factory presets or wavetables.** Fixtures are the developer's
  own single-knob saves.

### 3.6 Verify & Fix ("fix in case it needs to")
Runs after conversion, per preset. It is optional (it needs rendering).

**Static fixes (always on, no audio needed):**
- Clamp out-of-range values and record each clamp in the report.
- **Gain staging:** estimate the peak from oscillator levels × unison × filter
  resonance × drive, and trim master level when it would clip. The final check is
  by render when Verify is available.
- **Missing wavetable** (Serum data folder not set or the table isn't found):
  use a placeholder, mark the preset ⚠ in the list, and add a "set Serum folder"
  action.
- Dead mod routes (a route to a disabled module) are removed and reported.
- Polyphony/glide/legato sanity checks; pitch-bend range is carried over.

**Audio verification:**
- Render source (if the plugin is installed) and output (via `vita`) using the
  probe set: C2/C3/C4 for 2 s plus release, velocities 64 and 127, mod wheel at
  0 and 1, and a short chord.
- Metrics are reused from serum2vital: level offset, 1/6-octave spectral distance,
  envelope correlation, plus FX checks. Combine them into one **match score 0–100**,
  shown as a column in the preview table.

**Auto-fix optimizer (only when the score is below a threshold):**
- Choose a **small** set of sensitive parameters: master level, filter cutoff and
  resonance, drive, envelope A/D/S/R, unison detune, FX mixes. Don't search all
  ~800 Vital parameters.
- Use a derivative-free optimizer (CMA-ES or Nelder-Mead) on the combined distance,
  with a time budget per preset (e.g. 20 s) and a cap on iterations.
- Keep a change only if the score improves **and** the user approves it in the
  preview, where the before/after scores and the parameters changed are shown.
  This is the same model as the AI Clean preview.
- serum2vital's own result (324 closer / 252 further / 69 unchanged in one round of
  fixes) shows naive fixes can make things worse. The optimizer must never overwrite
  a better-scoring version.

---

## 4. Prompt → Preset

Type "dark detuned reese bass, slow filter wobble, 140 bpm", get a `.vital`.

### 4.1 Pipeline
```
prompt ─▶ LLM (existing backends) ─▶ PatchSpec JSON ─▶ validate ─▶ compile ─▶ .vital
                ▲                         (schema)       (clamp,     (UPM →
   retrieval: nearest presets             repair)       Vital writer)
   from the user's own Vital library                         │
                                                 optional: render via vita,
                                                 describe, compare, refine ◀┘
```

- **Backends:** reuse the app's existing AI layer (`src-tauri/src/commands/ai.rs`,
  `claude_cli.rs`, `antigravity_cli.rs`, `useAI.ts`): Ollama, Claude CLI,
  Antigravity, API, and the **Manual copy/paste** window. Same rule as AI Clean:
  the prompt builder and response parser live in one place, so manual mode can't
  drift from the others.
- **The LLM never writes raw Vital JSON.** It writes a small **PatchSpec**: the UPM
  restricted to semantic fields (osc shape family + harmonics recipe, filter family +
  cutoff in Hz, envelope times in ms, LFO → destination with an amount, FX choices).
  This is easy to validate, and models handle it far better than 800 opaque keys.
  The parser is defensive in the way `ai.rs` already is (strips `<think>` blocks,
  handles fences and wrapped objects).
- **Wavetables from a spec**, never from vendor content:
  - Basic shapes (saw/square/tri/sine/pulse-width).
  - **Additive recipes** (harmonic amplitudes per frame, so the model can describe
    "hollow, odd harmonics, brightens with position").
  - Simple morph sequences (saw → square across frames).
  These are generated procedurally in the engine.

### 4.2 Modes
- **Create:** prompt → new preset.
- **Edit:** select an existing Vital preset, then type "brighter, shorter release,
  more stereo". The LLM returns **edit ops** (`set`, `scale`, `add_mod`, `remove_fx`)
  against the preset's UPM instead of a whole new patch, shown as a diff in the
  preview table.
- **Variations:** "give me 8 variations". Either LLM sampling, or mutate/breed
  around one preset (Vinetics-style) with parameter jitter inside safe ranges.
- **From audio (later):** drop a WAV of a sound and it becomes an audio-match target
  (§3.4, fallback 2) with no source preset at all.

### 4.3 Grounding in the owner's own sounds (retrieval)
- Index the user's Vital library (same idea as the app's own library index: sqlite,
  incremental on mtime+size). For each preset, store its UPM summary plus audio
  descriptors from a short `vita` render: brightness/centroid, attack time, sustain
  level, stereo width, pitch stability, noisiness.
- Give the LLM the 3–5 nearest presets (by tags and descriptors) as **few-shot
  examples**. Optionally start from the nearest one and edit it. Results come out
  in the owner's own style, not generic.

### 4.4 Listening check (optional, needs vita)
- Render the result, compute the same descriptors, and turn them back into words
  ("bright, fast attack, wide"). Ask the LLM whether this matches the prompt. If it
  doesn't, apply one refinement round as edit ops, at most 2 rounds.
- Later upgrade: score the render against the prompt with a CLAP audio–text model,
  as CTAG does. Keep it out of v1 because it's heavy.

---

## 5. Preset library cleaner (the "tag cleaner" angle)

This is the most natural fit for the app, and it reuses its existing ideas almost
one-to-one:
- **Names:** strip pack prefixes and junk ("[PK] BS - Reese 01 (Copy)") using the
  same casing rules as Capitalization.
- **Category and tags:** inferred from the audio descriptors and/or AI (Bass / Lead /
  Pad / Pluck / FX / Keys …), with the same preview as AI Clean.
- **Duplicates:** an audio fingerprint of the render, plus a UPM diff. This catches
  "same sound, different name" (the pattern from `duplicates.rs`).
- **Bank tools:** build or split `.vitalbank` files, and shrink presets by
  de-duplicating wavetable data (the forum complaint about tables saved 3× per file).

---

## 6. Phases

| Phase | Deliverable | Done when |
|---|---|---|
| **S — Spikes** (§6.1) | Answers to the unknowns | Each spike has a written yes/no and numbers |
| **1 — Serum → Vital in the app** | Engine repo with serum2vital wrapped; Vital reader/writer; CLI JSON protocol; host `presets.*` actions + `presets` permission + `requires.engines` + Presets dialog (§2.2); the `preset-translator` plugin (§2.3) | The owner converts a real Serum folder; every output loads in Vital; report is shown |
| **2 — More inputs** | Surge XT, u-he (Diva + Hive first), Dexed; calibration tool + fixtures | Each synth has fixture tests passing in CI |
| **3 — Verify & Fix** | Render + metrics + match score column; static fixes; optimizer with approve-to-keep | Median score on the owner's set goes up and no preset gets worse |
| **4 — Prompt → Preset** | PatchSpec schema, compiler, procedural wavetables, Create/Edit/Variations, all AI backends incl. Manual | 20 test prompts produce loadable presets the owner rates as usable |
| **5 — Closed formats** | Host capture + audio match for Massive, Massive X, Phase Plant, Pigments (and Sylenth1 if it's not tier B) | Each synth the owner owns produces a labelled sound-alike |
| **6 — Library cleaner** | Names, tags, dupes, bank tools | Runs on the owner's whole Vital folder with a preview |
| **7 — Reverse (optional)** | Vital → Serum 2 writer (packager exists), Vital → Surge | Round-trip fixtures load |

### 6.1 Spikes to run first (cheap, settle the risky unknowns)
- **S1:** Run serum2vital as-is on a sample of the owner's Serum 1 and Serum 2
  presets. Note crashes, scores, and which dropped features actually matter.
  - **Partial result, 2026-10-19.** Run on a secondary PC with no Serum and no
    owner presets, so it used serum2vital's own 524 fixtures (Serum 1 `.fxp` and Serum 2
    `.SerumPreset`, in `DebugPresets/`). Setup is in `Desktop\claude\preset-spikes`
    (venv, Python 3.13, serum2vital @ `b67d9d3`, checker `scripts/validate_vital.py`).
    - The install is clean on Windows. 296 tests pass; 9 are skipped (they need Serum
      hosted).
    - **524/524 converted, with no crashes.** **524/524 loaded in Vital's real engine
      (vita)**. None rendered silent and none produced NaN.
    - **31 of 524 peak above 0 dBFS** (up to +6.4 dB). Almost all are compressor/gain
      fixtures that are loud on purpose. It's unknown whether Serum is equally hot,
      because Serum isn't installed to compare. This feeds the gain-staging fix in §3.6.
    - On load, Vital drops `custom_warps`, `osc_N_spectral_morph_phase` and
      `random_values` from every file. These are probably keys from a newer Vital that
      this vita build doesn't know. Check them against the owner's Vital in S2.
    - The `volume` "rewrite" is only float32 rounding and not a bug.
    - Without `--serum-root`, **every oscillator becomes a placeholder sine**. Real
      fidelity needs Serum's `Tables/` and `Noises/` folders.
    - **Parked:** the owner has no Serum presets, so a run on a real library waits
      until there are some (free packs are fine, kept local). Then A/B renders against
      Serum (`[hosts]` extra).
- **S2:** Dump the real key list from a `.vital` saved by the owner's Vital version,
  and check it against Vital's source. Vital wasn't installed on the PC used for S1,
  so do this on a machine with Vital (it's free).
- **S3:** Find out whether Sylenth1's `.fxp` holds a float param list or an opaque chunk.
- **S4:** Check whether `vita`, DawDreamer and pedalboard install cleanly on Windows
  Python 3.12/3.13, and whether vita renders headless without a GUI loop.
  **vita: yes.** It installs from pip on Windows/Python 3.13 and renders headless.
  The API: `load_preset`, `load_json`, `to_json`, `render(note, vel, dur, len)`,
  `get_control_text`. DawDreamer and pedalboard are not tested yet.
- **S5:** Host capture: for each closed synth the owner owns, load it in DawDreamer,
  count the exposed parameters, and check whether display text has units. This
  decides how good tier C can be.
- **S6:** Prompt quality: hand-write PatchSpecs for 10 prompts, compile them, and
  listen. Fix the schema before any LLM work.

---

## 7. Open questions for the owner
1. ~~Which synths do you own?~~ Answered: none, but support them all (§8.12–8.13).
6. **SDK extension `requires.engines` (§2.2.3):** OK to add it to plugin API v1 as an
   optional field, or should it wait for an `apiVersion: 2`? The alternative is an
   engine entry on the Components page.
7. **Store listing:** publish Preset Translator in the official store index, or keep
   it local-install only until phase 3?
2. **Engine as a separate public GPL repo** (`presetforge`) that the app downloads,
   or a folder inside this repo? A separate repo is recommended; it can also be a
   standalone CLI.
3. **Pricing tier:** is translation free or Pro? Prompt → Preset through cloud AI
   fits Studio and cloud credits, like Claude AI Clean.
4. **Use serum2vital as a pinned dependency or vendor a fork?** Pinned plus upstream
   PRs is recommended while it is moving fast; fork only if it goes quiet.
5. **Default wavetable frames:** 64 (fidelity) or 16 (about 4× smaller files)?

---

## 8. Per-converter specs (added 2026-10-19)

The owner has no Serum presets on hand, so the S1 run on real presets is parked.
Serum stays the reference implementation because serum2vital exists, but it no
longer blocks the other converters. Every converter below follows the same recipe,
so each one is a self-contained work item.

### 8.0 The shared recipe (applies to every converter)
1. **Container:** parse the file into raw `{param_id: value}` plus any blobs
   (wavetables, samples, curves).
2. **Map:** a per-synth `map/<synth>.toml` maps each raw parameter to a UPM field,
   a unit curve id, and an approximation note if one is needed. Data, not code,
   so a mapping fix is a one-line edit.
3. **Curves:** `curves/<synth>.json` comes from the `calibrate` tool (§3.5), or from
   source code where the synth is open source (Surge, Dexed, Vital).
4. **Architecture adapter (code):** the one piece that can't be data. It covers
   things like collapsing 6 DX7 operators into 3 Vital oscillators, Sylenth's
   A/B parts, or Phase Plant's unlimited generators.
5. **Fixtures:** an init preset plus single-knob saves, made by the developer and
   never vendor files. Each one has expected UPM values. Golden tests run in CI.
6. **Acceptance:** 100% of fixtures load in vita. No silent or NaN renders. A per-synth
   match score is recorded on the owner's real presets wherever the source plugin
   is installed, and published in the ROADMAP entry.

**Shared building blocks** (build once, before any converter beyond Serum):
- **`fxp.py`**: a VST2 `CcnK` container reader for both the `FxCk` param-list and
  `FPCh` opaque-chunk forms, plus `.fxb` banks. Serum 1, Surge XT and Sylenth1 use it.
- **`hostcap.py`**: host capture. It loads a plugin plus a state in
  DawDreamer/pedalboard, then dumps `(index, name, normalized, display_text)` for
  every parameter. Massive, Massive X, Pigments and the Sylenth fallback use it,
  and so does calibration for every synth.
- **`display_units.py`**: parses display text such as "1.20 kHz", "350 ms", "-6.0 dB",
  "+7 st", "1/16 D" or "Off" into physical units. This turns host capture into
  calibrated values without fitting curves.
- **`vital_arch.py`**: what Vital can hold. That is 3 oscillators (wavetable, plus
  FM/RM/sync "warp" from another oscillator), a sampler, 2 filters plus an FX
  filter, 6 envelopes, 8 LFOs, 4 macros, 4 random generators, a 64-slot mod matrix,
  and 9 FX. Every adapter asks it "does this fit?" and logs overflow to the report.
  The exact counts must be confirmed against Vital's source in S2.

---

### 8.1 Vital reader (prerequisite)
- **Why:** needed for Vital → Vital fix passes, the library cleaner (§5), prompt
  retrieval (§4.3), and round-trip tests for the writer.
- **How:** JSON → UPM, using vita's `get_controls()` and `get_control_details()` for
  ranges and display, so curves come from the engine itself instead of guesses.
- **Effort:** S.

### 8.2 Surge XT → Vital
- **File:** `.fxp` (VST2 `FPCh`) whose chunk holds a small binary patch header,
  the patch **XML**, then optional per-oscillator wavetable data. The exact header
  layout is to be read from Surge's source (`SurgePatch` load/save). Verify it, don't
  assume it.
- **Map:** everything is in the open source: parameter names, ranges and the
  value-to-display functions. **No calibration sweeps are needed.** Generate
  `map/surge.toml` from the source's parameter table, the same way serum2vital
  generates its table from Vital's source.
- **Architecture:** Surge has 2 scenes (A/B) of 3 oscillators each, 2 filters per
  scene with 8 routing configs, a waveshaper, 12 LFOs per scene, and a 4-slot FX
  chain per bus.
  - One scene maps cleanly. **Two-scene patches** (layer/split) don't fit, because
    Vital has 3 oscillators. Default to converting scene A only and logging B as
    dropped. Offer "scene B as a second preset" for splits and layers.
  - Oscillator types: wavetable and window are direct. Classic, Modern and Sine are
    rendered to a wavetable. FM2/FM3 become Vital FM-from-osc where possible, else
    are baked. String, Twist, Alias and S&H are baked into a single-frame or swept
    table and marked approximated.
  - Filters: map by family. Surge's large filter catalogue needs a catalogue map
    like serum2vital's `filter_map.py`. Unknown types fall back to the nearest family
    with a note.
  - FX: Surge has more FX than Vital. Reverb, delay, chorus, phaser, flanger, EQ,
    distortion and compressor map. Vocoder, rotary, nimbus, etc. are dropped.
- **Fixtures:** Surge XT is free, so install it here and generate fixtures plus
  calibration renders on this PC.
- **Effort:** M. **Fidelity expected:** high for single-scene patches.

### 8.3 u-he (Diva, Hive, Zebra 2 / Zebralette, Repro) → Vital
- **File:** `.h2p` text. A `/*@Meta … */` block (bank, author, description,
  categories, which become tags for free), then `#cm=<MODULE>` sections of
  `Key=Value` lines. Hive and Zebra end with a compressed binary section (`$$$$`)
  holding wavetables and curve shapes.
- **Parser:** one generic `h2p.py` for all u-he synths. It returns
  `{module: {key: value}}` plus the raw binary tail. Decoding the tail is spike S7.
  Without it, Hive and Zebra wavetables become placeholders.
- **Map:** u-he keys are short codes (e.g. `Cut`, `Res`, `Atk`). Build a map per synth
  by **diffing single-knob fixture saves**: init versus one knob moved shows which
  key moved. Values are mostly in display units already (cutoff is pitch-like 0–150,
  times are 0–100 on a curve), so calibration sweeps are still needed per curve.
- **Per synth:**
  - **Diva:** VA, 3 osc and 2 filters (ladder, cascade, Moog-style). It maps well
    to Vital's analog filter. The oscillator models (Triple VCO, DCO, Dual VCO
    Eco …) become basic shapes. Expect a good match on structure and a weaker one
    on analog character; the drift/"accuracy" settings are dropped.
  - **Hive:** 3 osc (wavetable plus classic), 2 filters, 12 mod slots and an
    architecture close to Vital's. This is the best u-he match.
  - **Zebra 2:** modular grid, 4 osc, FM, comb, spectral effects. It is the
    hardest; convert the main signal path only and report the rest. Zebra 3, if the
    owner has it, is a separate spike.
  - **Repro-1/5:** Prophet-style VA. It maps well.
- **Effort:** S for the parser. M per synth for maps and fixtures. Order them by
  which ones the owner owns.

### 8.4 Sylenth1 → Vital
- **File:** `.fxp`/`.fxb` (VST2). Spike S3 decides whether it is an `FxCk` param list
  (normalized floats in parameter order) or an `FPCh` chunk.
  - **If param list:** the parameter names come from the plugin's own list via
    `hostcap.py` (one-time dump, saved as `map/sylenth1_params.json`). Values are
    normalized, and the display text from a host dump gives the curves.
  - **If chunk:** reverse the chunk with single-knob fixtures; fall back to
    host capture.
- **Architecture:** 4 osc in 2 parts (A/B), each part with its own filter, plus
  a main filter, 2 amp envelopes, 2 mod envelopes, 2 LFOs, an 8-slot mod matrix and
  an arp, with VA waveforms.
  - Sylenth's oscillators are **not wavetables**, so every waveform becomes a basic
    Vital shape (plus voices and detune into Vital unison).
  - **4 oscillators → 3:** fold the quietest or duplicate oscillator into unison.
    If all 4 are distinct, drop the quietest and report it.
  - Two parts with separate filters map to Vital's filter 1 and filter 2 with
    osc → filter routing. That fits.
  - The arp is dropped (Vital has none); export the arp settings as a note.
- **Fidelity expected:** high. Sylenth is a straightforward VA, the easiest
  non-Serum target.
- **Effort:** S–M after S3.

### 8.5 Dexed / DX7 (`.syx`) → Vital
- **File:** a fully documented 32-voice bulk dump: 4104 bytes = 6-byte header +
  32 × 128-byte packed voices + checksum + `F7`. A single-voice (VCED, 155 bytes)
  dump is also supported. Dexed's source (GPL) holds the exact envelope/level
  tables, so no calibration is needed.
- **Architecture:** 6 sine operators in 32 algorithms, with per-operator 4-rate/4-level
  envelopes, keyboard scaling, feedback on one operator, and one LFO.
  - Vital has 3 oscillators with FM-from-osc, so **≤3-operator algorithms
    (e.g. a single carrier with 2 modulators)** map directly.
  - **For 4–6 operators**, collapse a modulator chain into a **baked wavetable**:
    render that sub-chain as a set of frames across the modulation index, then have
    a Vital envelope sweep the wavetable position. This approximates the index
    envelope. Mark it approximated.
  - DX envelopes (rate/level) → Vital envelopes with multi-stage approximation;
    Vital has fewer stages.
- **Fidelity expected:** medium for complex algorithms, high for simple
  e-piano/bass/bell patches.
- **Effort:** M. It's free to test, since Dexed is free and DX7 banks are public
  domain-ish. Fixture generation is still done by us.

### 8.6 Phase Plant → Vital
- **File:** v2.2+ is **JSON inside a ZIP**, so it is readable directly. The
  pre-2.2 binary format can be read with the `synthahol-phase-plant` Rust crate
  (port it, or call a tiny compiled helper). The schema comes from unzipping fixtures.
- **Architecture:** modular. Unlimited generators (wavetable, analog, sample,
  noise, granular, mix and filter routing), unlimited modulators, lanes of
  snapins (FX).
  - It is **closest to Vital in spirit**: wavetables, a flexible mod matrix, LFO
    shapes and envelopes all map well.
  - **Generator overflow:** more than 3 sound generators need priority plus a report.
    Pick the loudest 3, and bake extra wavetable generators into a combined table
    when they share pitch.
  - Generator-level filters and mixers → Vital filter 1/2 routing. A deep tree is
    flattened and reported.
  - Snapins: Kilohearts FX map by type (reverb, delay, chorus, phaser, flanger,
    distortion, EQ, compressor). Multipass and Snap Heap containers are flattened
    or dropped, as the crate also flags.
  - Wavetables are embedded in the ZIP and copied over.
- **Fidelity expected:** medium–high.
- **Effort:** M. It is a high-value target for a Vital user.

### 8.7 Massive (classic) → Vital
- **File:** `.nmsv`. A native reader is out of scope for v1. **Host capture is the
  path:** the VST3 build exposes about 212 parameters (per user reports; the VST2
  macros reportedly vanish in some hosts). Load the preset by its state and dump.
- **Loading a `.nmsv` in a headless host** is the risk (spike S5). Fallback: the
  owner opens it in Massive in any DAW and saves a VST state (`.fxp`/`.vstpreset`),
  which `hostcap.py` can load. The UI shows a one-time guide for this.
- **Architecture:** 3 wavetable osc + noise + feedback, 2 filters (serial/parallel
  blend), 4 envelopes, 4 LFO/performers, 2 stepper slots, macros, 3 insert + 2 master
  FX.
  - Massive wavetables are not accessible as files. Use **resynthesis**: render
    single notes at several wavetable positions via the host, extract one cycle
    per position, and build a Vital wavetable. This is approximated, but usually
    close.
  - Performers and steppers → Vital LFO shapes (step shapes are drawn as LFO points).
- **Fidelity expected:** medium.
- **Effort:** L (resynthesis plus the host-capture risk).

### 8.8 Massive X → Vital
- **File:** `.nksf` RIFF. NISI (metadata: name, author, tags, which become Vital
  tags), NICA and PLID are MessagePack, so they are easy to read. **PCHK** is opaque.
- **Path:** host capture, now viable because **v1.7 exposes all parameters to the
  host**. Load PCHK as the plugin state, then dump. Display text gives units.
- **Architecture:** 2 wavetable osc with many modes, 4 phase modulation oscillators,
  noise, a routing graph, 3 FX inserts, a performer and tracker modulation system.
  - Wavetables → resynthesis as for Massive.
  - Phase modulation oscillators → Vital FM-from-osc on the available third
    oscillator. Extras are dropped and reported.
  - The routing graph is flattened to Vital's fixed signal path, with loss reported.
- **Fidelity expected:** low–medium. This is where the **audio-match fallback**
  (§3.4) earns its keep: start from the host-capture translation, then optimize.
- **Effort:** L.

### 8.9 Pigments → Vital
- **File:** individual presets live under `ProgramData\Arturia\Presets\Pigments\User`,
  plus a `db.db3` SQLite library database. Arturia staff say it's "not encrypted",
  so metadata and tags can be read from it. `.pgtx` is the export/bank format. The
  preset body format is unknown (spike S8: inspect a user preset and a `.pgtx`).
- **Path:** host capture first (Pigments exposes many parameters to the host).
  Read metadata from the db.
- **Architecture:** 3 engines (wavetable, virtual analog, sample, granular, harmonic,
  modal, utility), 2 filters, deep mod (functions, random, combinate), sequencer,
  3 FX buses.
  - Wavetable and VA engines map. Sample engine → Vital sampler, if the samples are
    the owner's. Arturia factory samples are **never** embedded; they are flagged
    missing. Granular, harmonic and modal engines → resynthesis or dropped.
  - "Functions" (multi-point envelopes) → Vital LFO shapes in envelope mode.
- **Fidelity expected:** medium for wavetable/VA presets, low for granular/modal.
- **Effort:** L.

### 8.10 Priority order (Vital user, value per effort)
1. **Vital reader** (prereq) + shared blocks (`fxp.py`, `hostcap.py`, `display_units.py`)
2. **Surge XT**: free, so fully testable on this PC with no owner files needed
3. **Phase Plant**: readable JSON, closest architecture to Vital
4. **Sylenth1**: simple VA, high fidelity, after S3
5. **u-he** in the order the owner owns them (Hive first if owned)
6. **Dexed/DX7**: free and testable here
7. **Massive X** → **Massive** → **Pigments**: host capture + resynthesis + audio match

### 8.11 New spikes from this pass
- **S7:** decode u-he's `$$$$` binary tail (Hive/Zebra wavetables).
- **S8:** Pigments user-preset body plus `.pgtx` layout; read the `db.db3` schema.
- **S9:** Phase Plant v2.2+ ZIP/JSON schema from fixtures. Check whether
  `synthahol-phase-plant` has since added the new format.
- **S10:** confirm Vital's exact capacity numbers for `vital_arch.py` from source.

### 8.12 Owner's answer (2026-10-19)
The owner doesn't own any of these synths but wants all of them supported. §8.13
is the strategy for that. **No paid licences are needed to build any converter.**

### 8.13 Supporting synths the owner doesn't own
Two separate needs, kept apart:
- **Dev time** (we build the map): we need to know what each stored value *means*.
- **Run time** (an end user converts their presets): ideally needs **only the
  preset file**, not the source plugin.

**Where the meaning comes from, without a licence:**
1. **Open source:** Surge XT, Dexed and Vital. The map is generated from source.
2. **Existing community work:** Serum 1/2. serum2vital's curves were already
   measured against real Serum, so we inherit them. Serum is only needed to improve them.
3. **Free demos driven through a host.** The key insight: **calibration doesn't
   need saving.** `calibrate` sets parameters through the host, renders, and reads
   display text, and a demo can do all of that. Saving is only needed for "single-knob
   fixture files", and the host can usually produce those itself (next point).
4. **Differential state decoding** (new technique, spike S11): with a demo in a host,
   set one parameter, call `getState()` (the plugin's own preset chunk, the same
   bytes a DAW project stores), and diff it against the init state. Repeat for every
   parameter. This decodes a closed chunk format **without the vendor's save button**,
   and produces a native reader that works at run time with no plugin installed.
   S11 must confirm that demos return real state through `getState()` even when
   their UI save is disabled.
5. **Free preset packs as test inputs.** Many free packs are published for each synth.
   They are used only as local test inputs: never committed, never redistributed
   (same rule as vendor content). Downloading them is the owner's call, per pack.

| Synth | Free route for dev time | Demo limits that matter | Run time needs plugin? |
|---|---|---|---|
| Vital | open source + vita | none | no |
| Surge XT | open source, free | none | no |
| Dexed / DX7 | open source, free | none | no |
| Serum 1/2 | serum2vital's measured tables; Splice 3-day trial only for improving them | no standing demo | no |
| u-he Diva / Hive / Zebra 2 / Repro | **full demos, saving works.** Diva/Hive play crackle every ~30 s; Zebra plays wrong notes after ~15 min. | Calibration renders must detect and discard crackle bursts and reload the plugin regularly; Zebra sweeps restart the plugin every ~10 min. | no (`.h2p` is text) |
| Sylenth1 | demo (v3.073) | **No saving or export, half the mod options disabled**, plus a reminder sample about every 60 s. Calibrate via host and decode via S11. The modulation half must be decoded from free preset packs. | no, if `.fxp` decodes (S3/S11) |
| Phase Plant | trial (current length unknown) + free packs (v2.2+ is JSON in ZIP) | unknown | no |
| Massive X | full demo from NI (presets are a separate download); free Massive X Player is too limited | time limit unknown | **yes until S11 decodes PCHK**, then no |
| Massive | possibly an NI demo (check S5) | unknown | **yes until decoded**, else host capture |
| Pigments | demo: 20-minute sessions, no saving (2020 terms, recheck); free Pigments Play | sessions must restart; the S11 diff must fit in 20 minutes | **yes until decoded** |

**Rules that come out of this:**
- **The goal for every synth is a native reader** that needs only the file. Host
  capture at run time is a stopgap for tier C, and the UI says so ("needs Massive X
  installed until native support lands").
- **Calibration data is versioned per plugin version** (`curves/<synth>@<version>.json`).
  Demos update, and a curve fitted on demo 3.07 is tagged as 3.07.
- **EULA check before each demo is used for decoding.** Many EULAs forbid reverse
  engineering. Interoperability exceptions exist in some jurisdictions (EU software
  directive, Canada's Copyright Act s.30.61) but not universally. This is the owner's
  call per vendor, so record the decision in this file. Format readers built only
  from public packs plus display text are the low-risk path.
- **Demo artefacts never land in the repo.** No crackle-contaminated renders, no
  demo-exported presets. Only derived curve numbers and maps are committed.

### 8.14 Spike added
- **S11:** differential state decoding. Start with **Surge XT** (free, so the result
  can be checked against its open-source format), then try a u-he demo (the result
  can be checked against `.h2p` text). Only then try the closed ones (Sylenth1,
  Massive X, Pigments). Done when the decoded values from the Surge run match its XML.

---

## 9. Sources
- Demo terms: u-he <https://u-he.com/support/faq/licenses/demos/>; Sylenth1 <https://lennardigital.com/downloads>; Pigments <https://bedroomproducersblog.com/2020/03/30/arturia-pigments-free/>, Pigments Play <https://musictech.com/news/gear/arturia-pigments-play/>; Serum 2 trial via Splice <https://support.splice.com/en/articles/10553623-serum-2-faq>; Massive X demo <https://www.native-instruments.com/zh/pages/product-downloads/massive-x>, Player <https://create.routenote.com/blog/native-instruments-massive-x-player-free/>
- Phase Plant reader: <https://github.com/softdevca/synthahol-phase-plant>, <https://crates.io/crates/synthahol-phase-plant>
- Massive X 1.7 exposes all params: <https://synthanatomy.com/2026/03/native-instruments-massive-x-out-now.html>, <https://rekkerd.org/native-instruments-updates-massive-x-synthesizer-to-v1-7/>, pre-1.7 limits <https://community.native-instruments.com/discussion/47350/list-of-predefined-midi-cc-in-massive-x>
- Massive VST3 parameter list reports: <https://community.native-instruments.com/discussion/comment/131767>, <https://forum.renoise.com/t/some-massive-vst3-automation-parameters-disappear-easy-to-replicate/71613>
- Pigments preset locations and db: <https://forum.arturia.com/t/how-to-backup-created-presets/3241>, <https://forum.arturia.com/t/are-there-txt-files-of-presets-for-pigments/3966>, <https://forum.arturia.com/t/installing-presets-please-help/3967>
- DX7 bulk dump size: <https://yamahamusicians.com/forum/threads/yamaha-dx-7-ii-fd-sysex-issue.10382/post-61587>
- Surge XT patches and folders: <https://www.kvraudio.com/forum/viewtopic.php?p=9208352>
- serum2vital: <https://github.com/btesser/serum2vital>, releases <https://github.com/btesser/serum2vital/releases>
- Serum format notes (0xdevalias): <https://gist.github.com/0xdevalias/135a18e979ac8e302ebbc700a50a8d74>
- AI patch-generation notes (0xdevalias): <https://gist.github.com/0xdevalias/5a06349b376d01b2a76ad27a86b08c1b>
- serum-preset-packager: <https://github.com/KennethWussmann/serum-preset-packager>; TS port <https://github.com/CharlesBT/node-serum2-preset-packager>; serum2-preset-loader <https://pypi.org/project/serum2-preset-loader/0.1.3/>
- serum-mcp: <https://github.com/Celian-mrc/serum-mcp>
- fxp parser: <https://pypi.org/project/fxp/>
- vita (Vital Python bindings): <https://pypi.org/project/vita/>
- DawDreamer: <https://pypi.org/project/dawdreamer/0.6.9/>, paper <https://arxiv.org/abs/2111.09931>
- Vital format discussions: <https://forum.vital.audio/t/optimization-for-vital-files/11535>, <https://www.kvraudio.com/forum/viewtopic.php?p=7971251>, <https://fileinfo.com/extension/vitalbank>
- Vital AI generator thread: <https://forum.vital.audio/t/we-made-an-ai-preset-generator-for-vital/15666>; Prompt2Patch <https://prompt2patch.com/>
- Wavetable import between Vital and Serum: <https://forum.vital.audio/t/can-vital-export-a-wavetable-that-serum-can-import/4305>, <https://www.kvraudio.com/forum/viewtopic.php?p=7265332>
- Massive `.nmsv`: <https://fileinfo.com/extension/nmsv>, <https://github.com/gitter-badger/ni-file>; NKS `.nksf`: <https://community.native-instruments.com/discussion/comment/72870>
- u-he `.h2p`: <https://www.kvraudio.com/forum/viewtopic.php?p=9248542>
- Sylenth1 version byte: <https://www.kvraudio.com/forum/viewtopic.php?p=5430227>
- Pigments `.pgtx`: <https://forum.arturia.com/t/preset-containing-external-audio-sample/7037>
- Sound matching research: InverSynth <https://arxiv.org/pdf/1812.06349>, DAFx-24 <https://dafx.de/paper-archive/2024/papers/DAFx24_paper_95.pdf>
- Rust VST3 hosting: <https://docs.rs/crate/vst3-host/0.5.0>; headless-host pitfalls <https://forum.juce.com/t/headless-vst3-host-some-plugins-render-silence/58169>

---

## 10. Phase 1 contract (frozen 2026-10-19, built by parallel agents)

Decisions taken so phase 1 isn't blocked (both reversible):
- **The engine lives in this repo for now**, as `presetforge/` (a Python package, like
  `mcp/` is a Rust crate here). It can be split into its own repo later.
- **`requires.engines` is an optional field in plugin API v1**, so `apiVersion` stays 1.

Out of scope for phase 1: `presets.generate` and `presets.edit` (phase 4), the full UPM
(phase 2), PyInstaller release builds, and a published engine index (the compiled-in
index starts **empty**, so installs come later and dev uses the override).

### 10.1 Engine CLI (`presetforge/`, Python ≥3.11)
`python -m presetforge <cmd> --json [...]` (the console script is `presetforge`).
stdout carries **only** JSON lines; stderr is free text for logs.
```
version                                   -> result {"name":"presetforge","version":"0.1.0","formats":["serum1","serum2","vital"]}
scan <path>...                            -> result {"items":[ScanItem]}   (paths may be files or folders; recurse folders)
convert <file>... --out-dir D [--serum-root R] [--max-frames N]
                                          -> progress per file, then result {"items":[ConvertItem]}
verify <file.vital>...                    -> progress per file, then result {"items":[VerifyItem]}   (needs extra [verify] = vita, numpy)
```
Line shapes: `{"event":"progress","done":3,"total":10,"file":"…"}`,
`{"event":"warning","message":"…","file":"…"?}`, `{"event":"result","data":{…}}`,
`{"event":"error","message":"…"}`. One `result` per run. Per-file failures go inside
items (`status:"failed"`), and the exit code stays 0. A non-zero exit means fatal only
(bad args, missing dependency), with an `error` line first.
```
ScanItem    {path, synth:"serum1"|"serum2"|"vital"|"unknown", name, supported:bool, reason?:string}
ConvertItem {source, output?:string, status:"ok"|"approx"|"failed", error?:string,
             report:{exact:int, approximated:[{field,note}], dropped:[{field,note}]}}
VerifyItem  {file, loaded:bool, peakDb?:number, rmsDb?:number, silent?:bool, clips?:bool, nan?:bool}
```
`output` file names = source stem + `.vital`, de-duplicated with ` (2)` etc. inside the out-dir.

### 10.2 Tauri commands (Rust: `commands/presets.rs`, `commands/engines.rs`)
JS calls them with camelCase args (Tauri maps them to snake_case).
```
engines_status()                         -> [{id, installedVersion?, path?, devOverride:bool, available?:{version,size}}]
engine_install(id)                       -> {id, version, path}         emits "engine-progress" {id, phase, downloaded, total}
presets_scan(paths)                      -> ScanItem[]
presets_convert(paths, serumRoot?, maxFrames?) -> {batchId, items:ConvertItem[]}   emits "presets-progress" {batchId, done, total, file}
presets_verify(batchId)                  -> VerifyItem[]
presets_apply(batchId, outputDir, include?: string[] /*sources*/) -> {written:string[], skipped:[{source,reason}]}
presets_report(batchId)                  -> {batchId, items:ConvertItem[]}
presets_discard(batchId)                 -> null
```
- **Engine discovery:** env `MTC_PRESETFORGE` (an executable or `.cmd`/`.bat` path, i.e. the
  dev override), else `<app_data>/engines/presetforge/<highest version>/presetforge(.exe)`.
  Missing → `Err("The presetforge engine is not installed")`.
- **Engine index:** `src-tauri/engines.json`, compiled in with `include_str!`:
  `[{id, version, url, sha256, size}]`, initially `[]`. Install = download (reuse
  `plugin_store::url_allowed` + `sha256_hex`), verify, unzip into the versioned folder.
  The engine zip extractor is separate from the plugin one, because it allows binaries
  and large files, but it refuses `..`, absolute paths and symlinks.
- **Staging:** `<app_data>/presets-staging/<batchId>/`. batchId = timestamp + random hex.
- **Apply rules (enforced in Rust):** `outputDir` must exist and be a directory. Only
  files from that batch's staging dir are copied in. Never overwrite: on a name clash,
  write `name (2).vital`. Never write outside `outputDir` (canonicalize both and check
  the prefix). Never touch source paths.

### 10.3 App actions + SDK (TypeScript)
- `src/lib/appActions.ts` registers `presets.open {folder?}`, `presets.scan {paths}`,
  `presets.convert {paths, serumRoot?, maxFrames?}`, `presets.verify {batchId}`,
  `presets.apply {batchId, outputDir, include?}`, `presets.report {batchId}`. These are
  thin wrappers over the commands above. `presets.apply` asks for confirmation every
  time (same mechanism as `files.delete`).
- **Gating:** every `presets.*` action except `presets.open` checks that some
  **enabled, approved plugin declares `requires.engines` containing `presetforge`**.
  Otherwise it rejects with "Install the Preset Translator plugin (Plugins → Store)".
  `presets.open` without the plugin shows that message in the dialog.
- `src/plugins/permissions.ts`: `presets.*` → `"presets"`. `src/plugins/manifest.ts`:
  add `presets` to `PERMISSION_INFO` (label "Read synth presets and write converted
  presets to your output folder", risk `medium`). Optional `requires: {engines:
  [{id, version}]}` is validated (id like plugin ids; version a string like `>=0.1`)
  and shown in `PluginReviewDialog.tsx`, including the engine's install state.
- `src/components/PresetsDialog.tsx`: opened by `presets.open`. Pick files/folder → scan
  list (virtualized) → tick → Convert → table with status ✓/≈/✗ and a report drawer →
  optional Verify → Apply to an output folder (picker). Follows CLAUDE.md UI rules: no
  drag, selecting separate from ticking, nothing written before Apply.
- `PLUGINS.md` and `plugins/sdk.d.ts` document `presets` and `requires.engines`
  (wave 2).

### 10.4 Waves
- **Wave 1 (parallel):** A = engine (`presetforge/` only). B1 = TypeScript side
  (`src/` + PLUGINS.md table row). B2 = Rust side (`src-tauri/` only).
- **Wave 2:** C = `plugins-examples/preset-translator/` + docs + ROADMAP entry + a dev
  shim `presetforge/dev/presetforge.cmd`. D = phase-2 engine readers (Surge XT, Dexed).
