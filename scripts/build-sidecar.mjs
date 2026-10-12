// Builds the `mtc-mcp` MCP server (mcp/, its own crate) and copies it to
// src-tauri/binaries/mtc-mcp-<target-triple>[.exe], the name Tauri's
// `bundle.externalBin` expects. Tauri then ships it next to the app exe as
// plain `mtc-mcp[.exe]` (which is where bridge::mcp_exe_path looks).
//
// Run from beforeDevCommand / beforeBuildCommand (see tauri.conf.json).
//   node scripts/build-sidecar.mjs            release build (default)
//   node scripts/build-sidecar.mjs --debug    faster compile, for `tauri dev`
//
// Target triple: TAURI_ENV_TARGET_TRIPLE (set by `tauri build --target ...`),
// else the host triple from `rustc -vV`. cargo is incremental, so when
// nothing changed this is a ~1 s no-op; the copy is skipped if bytes match.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const debug = process.argv.includes("--debug");

let triple = process.env.TAURI_ENV_TARGET_TRIPLE;
const explicitTarget = Boolean(triple);
if (!triple) {
  const m = /^host:\s*(\S+)/m.exec(execFileSync("rustc", ["-vV"], { encoding: "utf8" }));
  if (!m) throw new Error("could not read host triple from `rustc -vV`");
  triple = m[1];
}
const exe = triple.includes("windows") ? ".exe" : "";

const args = ["build", "--locked", "--manifest-path", join(root, "mcp", "Cargo.toml")];
if (!debug) args.push("--release");
if (explicitTarget) args.push("--target", triple);
console.log(`[sidecar] cargo ${args.join(" ")}`);
const r = spawnSync("cargo", args, { stdio: "inherit", cwd: root });
if (r.status !== 0) {
  console.error("[sidecar] building mtc-mcp failed");
  process.exit(r.status ?? 1);
}

const outDir = join(root, "mcp", "target", ...(explicitTarget ? [triple] : []), debug ? "debug" : "release");
const built = join(outDir, `mtc-mcp${exe}`);
if (!existsSync(built)) throw new Error(`expected build output missing: ${built}`);

const destDir = join(root, "src-tauri", "binaries");
mkdirSync(destDir, { recursive: true });
const dest = join(destDir, `mtc-mcp-${triple}${exe}`);
// build.rs may have left an empty placeholder here; real bytes always win.
const same =
  existsSync(dest) &&
  statSync(dest).size === statSync(built).size &&
  readFileSync(dest).equals(readFileSync(built));
if (same) {
  console.log(`[sidecar] up to date: ${dest}`);
} else {
  copyFileSync(built, dest);
  console.log(`[sidecar] copied -> ${dest}`);
}
