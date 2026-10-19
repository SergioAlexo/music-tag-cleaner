/**
 * Shapes of the presetforge engine results, as the Rust `presets_*` commands
 * return them (PLAN-preset-translator.md §10), plus small pure helpers shared by
 * the Presets dialog and the `presets.*` actions.
 */
export type PresetSynth = "serum1" | "serum2" | "vital" | "unknown";

export interface ScanItem {
  path: string;
  synth: PresetSynth;
  name: string;
  supported: boolean;
  reason?: string;
}

export interface ConvertReport {
  exact: number;
  approximated: { field: string; note: string }[];
  dropped: { field: string; note: string }[];
}

export interface ConvertItem {
  source: string;
  output?: string;
  status: "ok" | "approx" | "failed";
  error?: string;
  report: ConvertReport;
}

export interface VerifyItem {
  file: string;
  loaded: boolean;
  peakDb?: number;
  rmsDb?: number;
  silent?: boolean;
  clips?: boolean;
  nan?: boolean;
}

export interface ApplyResult {
  written: string[];
  skipped: { source: string; reason: string }[];
}

export const SYNTH_LABEL: Record<PresetSynth, string> = {
  serum1: "Serum",
  serum2: "Serum 2",
  vital: "Vital",
  unknown: "Unknown",
};

export const NEEDS_PRESETS_PLUGIN = "Install the Preset Translator plugin (Plugins → Store)";

/** One-line verdict for a verify result (null = looks fine). */
export function verifyProblem(v: VerifyItem): string | null {
  if (!v.loaded) return "did not load";
  if (v.nan) return "produced NaN";
  if (v.silent) return "silent";
  if (v.clips) return "clips";
  return null;
}

/** The text of the "write presets?" confirmation (count null = every converted preset). */
export function applyConfirmText(outputDir: string, count: number | null): string {
  const what = count === null ? "the converted presets" : `${count} converted preset${count === 1 ? "" : "s"}`;
  return `Write ${what} to:\n${outputDir}\n\nNothing is overwritten (name clashes get " (2)"). Your original preset files are never touched.`;
}
