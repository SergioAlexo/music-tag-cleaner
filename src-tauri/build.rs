fn main() {
    ensure_sidecar_placeholder();
    tauri_build::build()
}

/// `bundle.externalBin` makes tauri-build fail when
/// `binaries/mtc-mcp-<target-triple>[.exe]` is missing, which would break a
/// bare `cargo test` / `cargo check` on a fresh clone (and the CI test job).
/// The real binary is produced by `scripts/build-sidecar.mjs` (run from
/// beforeDevCommand / beforeBuildCommand); here we only drop an EMPTY
/// placeholder if nothing is there yet, so those cargo-only flows compile.
/// A placeholder never ships: `tauri build` always runs the script first and
/// it overwrites any file whose bytes differ from the fresh build.
fn ensure_sidecar_placeholder() {
    let Ok(triple) = std::env::var("TARGET") else { return };
    let ext = if triple.contains("windows") { ".exe" } else { "" };
    let dir = std::path::Path::new("binaries");
    let path = dir.join(format!("mtc-mcp-{triple}{ext}"));
    println!("cargo:rerun-if-changed={}", path.display());
    if !path.exists() {
        let _ = std::fs::create_dir_all(dir);
        let _ = std::fs::write(&path, b"");
    }
}
