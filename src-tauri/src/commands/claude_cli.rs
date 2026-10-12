//! The Claude Code CLI as an AI backend (v0.13).
//!
//! AI Clean already had two backends: Ollama (local, free, weaker) and
//! manual (paste the prompt into whatever you like, then paste the answer
//! back). This adds a third that is neither: drive the `claude` CLI that is
//! already installed and already signed in, so cleaning a few hundred tracks
//! needs no copy/paste *and* no separate API key or bill — it runs on the
//! Claude subscription the machine already has.
//!
//! The whole integration is `claude --print`, its documented non-interactive
//! mode. The same prompt builders and the same tolerant response parsers the
//! other two backends use are reused verbatim (`ai::build_clean_prompt`,
//! `ai::parse_cleaned`, …) — a second copy of the rules would drift, and
//! "the AI answered differently depending on which backend you picked" is a
//! very unpleasant bug to chase.
//!
//! Two things about detection are worth knowing before changing this:
//!
//! 1. **Being installed is not the same as being usable.** The copy bundled
//!    inside the Claude desktop app authenticates through the app's own
//!    session, so invoking it standalone returns `{"is_error": true,
//!    "result": "Not logged in · Please run /login"}` — a perfectly healthy
//!    binary that cannot answer. The probe therefore checks *login*, not
//!    just presence, and the UI says which of the two is wrong.
//! 2. **The envelope reports failure in the body, not the exit code.** A
//!    refusal, a rate limit and a login problem all come back as valid JSON
//!    with `is_error: true`, so the error text has to be read out of
//!    `result`.

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::commands::ai;
use crate::commands::ai_playlist;
use crate::commands::ffmpeg::hide_console;
use crate::models::{CleanedTrack, PlaylistAiResult, PlaylistSetSpec, PlaylistTrackInput, TrackInput};

#[cfg(target_os = "windows")]
const CLAUDE_EXE: &str = "claude.exe";
#[cfg(not(target_os = "windows"))]
const CLAUDE_EXE: &str = "claude";

/// `claude --version` is a local call; if it takes this long something is wrong.
const VERSION_TIMEOUT: Duration = Duration::from_secs(10);

/// Longest prompt passed as a command-line argument. Windows caps a whole
/// command line at 32,767 UTF-16 units, and an AI-playlist prompt for a
/// 600-track pool runs to twice that — `CreateProcess` refused it outright
/// (os error 206). Anything longer is piped through stdin instead, which
/// `claude --print` reads as the prompt when none is given on the line.
const MAX_ARG_PROMPT_UNITS: usize = 8_000;
/// The Settings "is it usable?" ping — one trivial prompt.
const PING_TIMEOUT: Duration = Duration::from_secs(30);
/// Real batches: a base cost plus a per-track allowance, capped so a huge
/// batch can't hold the UI hostage for more than a few minutes.
const BATCH_BASE_SECS: u64 = 60;
const BATCH_PER_TRACK_SECS: u64 = 5;
const BATCH_MAX_SECS: u64 = 300;
/// Fast reachability probe before any real prompt (offline => fail in ~3 s
/// instead of the CLI retrying with backoff for minutes, or forever).
const CONNECT_HOST: &str = "api.anthropic.com";
const CONNECT_PORT: u16 = 443;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);

const OFFLINE_MESSAGE: &str = "No internet connection — the Claude CLI needs to reach \
    Anthropic. Check your connection and try again.";
const NOT_SIGNED_IN_MESSAGE: &str = "The Claude CLI is installed but not signed in. Run \
    `claude` once in a terminal and log in, then try again.";

/// Why a call failed, so Settings can say "offline" rather than "not signed in".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ErrorKind {
    Offline,
    Timeout,
    NotLoggedIn,
    Other,
}

impl ErrorKind {
    fn as_str(self) -> &'static str {
        match self {
            ErrorKind::Offline => "offline",
            ErrorKind::Timeout => "timeout",
            ErrorKind::NotLoggedIn => "not_logged_in",
            ErrorKind::Other => "other",
        }
    }
}

#[derive(Debug, Clone)]
struct CliError {
    kind: ErrorKind,
    message: String,
}

impl CliError {
    fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into() }
    }
    fn other(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Other, message)
    }
    fn offline() -> Self {
        Self::new(ErrorKind::Offline, OFFLINE_MESSAGE)
    }
    fn timeout(limit: Duration) -> Self {
        Self::new(
            ErrorKind::Timeout,
            format!(
                "The Claude CLI didn't respond within {} s — check your internet connection, \
                 or try a smaller batch.",
                limit.as_secs()
            ),
        )
    }
}

/// Time allowed for a real batch of `tracks` items: `60 s + 5 s × tracks`,
/// capped at 5 minutes.
fn batch_timeout(tracks: usize) -> Duration {
    let secs = BATCH_BASE_SECS.saturating_add(BATCH_PER_TRACK_SECS.saturating_mul(tracks as u64));
    Duration::from_secs(secs.min(BATCH_MAX_SECS))
}

/// Offline CLI runs surface as Node/fetch errors in stderr or in the
/// envelope's `result`, not as a distinct exit code.
fn looks_like_network_error(text: &str) -> bool {
    let t = text.to_ascii_lowercase();
    ["enotfound", "econnrefused", "etimedout", "econnreset", "getaddrinfo", "connection error", "fetch failed"]
        .iter()
        .any(|p| t.contains(p))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCliInfo {
    /// A `claude` binary was found.
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    /// It answered a trivial prompt — i.e. it is signed in and usable.
    /// `found && !logged_in` is the desktop-app-bundled case.
    pub logged_in: bool,
    /// Why it isn't usable, when it isn't.
    pub error: Option<String>,
    /// `"offline" | "timeout" | "not_logged_in" | "other"` when `error` is set.
    pub error_kind: Option<String>,
}

fn on_path() -> Option<PathBuf> {
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let p = dir.join(CLAUDE_EXE);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    // A GUI app launched from Finder/Dock/the Windows shell doesn't inherit a
    // shell PATH, so the two places `claude` actually gets installed to are
    // checked directly rather than relying on PATH alone.
    //
    // 1. npm's global bin (`npm i -g @anthropic-ai/claude-code`).
    // 2. The native installer (`irm https://claude.ai/install.ps1 | iex` on
    //    Windows, the equivalent curl script on macOS/Linux), which drops
    //    `claude` in `~/.local/bin` and tells the user to add that to PATH
    //    themselves — a step it's easy to skip, so this app shouldn't
    //    require it.
    #[cfg(target_os = "macos")]
    for dir in ["/opt/homebrew/bin", "/usr/local/bin"] {
        let p = PathBuf::from(dir).join(CLAUDE_EXE);
        if p.is_file() {
            return Some(p);
        }
    }
    #[cfg(target_os = "windows")]
    if let Ok(appdata) = std::env::var("APPDATA") {
        let npm_dir = PathBuf::from(&appdata).join("npm");
        // `claude.cmd` is a one-line shim that just execs the real binary
        // below. Resolve straight to that binary instead of the shim: Rust's
        // Command hardens batch-file (.bat/.cmd) argument handling (the
        // CVE-2024-24576 fix) and outright refuses some arguments — notably
        // an empty string, which `run_prompt` passes for `--allowedTools` —
        // with "batch file arguments are invalid". Spawning the real .exe
        // sidesteps that entirely and avoids cmd.exe re-parsing our args.
        let bundled = npm_dir
            .join("node_modules")
            .join("@anthropic-ai")
            .join("claude-code")
            .join("bin")
            .join("claude.exe");
        if bundled.is_file() {
            return Some(bundled);
        }
        for name in ["claude.cmd", "claude.exe"] {
            let p = npm_dir.join(name);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    #[cfg(target_os = "windows")]
    if let Ok(profile) = std::env::var("USERPROFILE") {
        let p = PathBuf::from(&profile).join(".local").join("bin").join(CLAUDE_EXE);
        if p.is_file() {
            return Some(p);
        }
    }
    #[cfg(unix)]
    if let Ok(home) = std::env::var("HOME") {
        let p = PathBuf::from(&home).join(".local").join("bin").join(CLAUDE_EXE);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// The copy the Claude desktop app ships, under a version-named folder.
///
/// Used only as a fallback: it is frequently *not* signed in for standalone
/// use (its credentials belong to the app session), so a real CLI install on
/// `PATH` is always preferred. Picking the highest version string keeps this
/// working after the app updates itself.
#[cfg(target_os = "windows")]
fn bundled_with_desktop_app() -> Option<PathBuf> {
    let appdata = std::env::var("APPDATA").ok()?;
    let root = PathBuf::from(appdata).join("Claude").join("claude-code");
    let mut versions: Vec<PathBuf> = std::fs::read_dir(&root)
        .ok()?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.join(CLAUDE_EXE).is_file())
        .collect();
    versions.sort();
    versions.pop().map(|p| p.join(CLAUDE_EXE))
}

#[cfg(target_os = "macos")]
fn bundled_with_desktop_app() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    let root = PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join("Claude")
        .join("claude-code");
    let mut versions: Vec<PathBuf> = std::fs::read_dir(&root)
        .ok()?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.join(CLAUDE_EXE).is_file())
        .collect();
    versions.sort();
    versions.pop().map(|p| p.join(CLAUDE_EXE))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn bundled_with_desktop_app() -> Option<PathBuf> {
    None
}

pub fn find_claude() -> Option<PathBuf> {
    on_path().or_else(bundled_with_desktop_app)
}

fn version_of(exe: &PathBuf) -> Option<String> {
    let mut cmd = Command::new(exe);
    cmd.arg("--version");
    hide_console(&mut cmd);
    let out = run_with_timeout(cmd, VERSION_TIMEOUT, None).ok()?;
    let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!v.is_empty()).then_some(v)
}

/// Whether Anthropic's API host is reachable right now. DNS resolution has no
/// timeout of its own, so the whole probe runs on a helper thread that the
/// caller stops waiting for after a few seconds.
fn anthropic_reachable() -> bool {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let ok = (CONNECT_HOST, CONNECT_PORT)
            .to_socket_addrs()
            .map(|mut addrs| addrs.any(|a| TcpStream::connect_timeout(&a, CONNECT_TIMEOUT).is_ok()))
            .unwrap_or(false);
        let _ = tx.send(ok);
    });
    rx.recv_timeout(CONNECT_TIMEOUT + Duration::from_secs(1)).unwrap_or(false)
}

/// Kills `pid` and everything it started. `claude` can be a node shim, and a
/// plain `Child::kill` would orphan the `node.exe` doing the actual work.
fn kill_tree(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("taskkill");
        cmd.args(["/T", "/F", "/PID", &pid.to_string()]);
        hide_console(&mut cmd);
        let _ = cmd.stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = pid; // `Child::kill` right after covers the native binary.
    }
}

fn drain<R: Read + Send + 'static>(mut pipe: R) -> mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = pipe.read_to_end(&mut buf);
        let _ = tx.send(buf);
    });
    rx
}

/// `Command::output` with a deadline. Both pipes are drained on helper
/// threads (a full pipe would otherwise stall the child), the child is polled
/// until `limit`, and on expiry the whole process tree is killed. The
/// offline CLI retries with backoff and may never exit by itself, which is
/// what made AI Clean and the Settings check spin forever.
///
/// `input`, when given, is written to the child's stdin on its own thread
/// (so a child that is busy filling stdout can't deadlock against the write)
/// and stdin is closed afterwards.
fn run_with_timeout(
    mut cmd: Command,
    limit: Duration,
    input: Option<String>,
) -> Result<Output, CliError> {
    let mut child = cmd
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| CliError::other(format!("Could not run the Claude CLI: {e}")))?;
    if let (Some(text), Some(mut stdin)) = (input, child.stdin.take()) {
        std::thread::spawn(move || {
            let _ = stdin.write_all(text.as_bytes());
            // Dropping `stdin` here closes the pipe: the CLI's end-of-input.
        });
    }
    let out_rx = drain(child.stdout.take().expect("piped stdout"));
    let err_rx = drain(child.stderr.take().expect("piped stderr"));

    let deadline = Instant::now() + limit;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) if Instant::now() >= deadline => {
                kill_tree(child.id());
                let _ = child.kill();
                let _ = child.wait();
                return Err(CliError::timeout(limit));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => return Err(CliError::other(format!("Could not run the Claude CLI: {e}"))),
        }
    };
    // A surviving grandchild could keep a pipe open; don't wait on it forever.
    let grab = |rx: mpsc::Receiver<Vec<u8>>| rx.recv_timeout(Duration::from_secs(2)).unwrap_or_default();
    Ok(Output { status, stdout: grab(out_rx), stderr: grab(err_rx) })
}

/// Turns the CLI's JSON envelope into the answer text or a classified error.
/// Pure so the message mapping can be tested without spawning the binary.
fn interpret_envelope(envelope: &Value) -> Result<String, CliError> {
    let text = envelope["result"].as_str().unwrap_or("").to_string();
    if envelope["is_error"].as_bool().unwrap_or(false) {
        let msg = if text.is_empty() { "unknown error".to_string() } else { text };
        return Err(if msg.contains("Not logged in") {
            CliError::new(ErrorKind::NotLoggedIn, NOT_SIGNED_IN_MESSAGE)
        } else if looks_like_network_error(&msg) {
            CliError::offline()
        } else {
            CliError::other(format!("Claude CLI: {msg}"))
        });
    }
    if text.trim().is_empty() {
        return Err(CliError::other("The Claude CLI returned an empty response"));
    }
    Ok(text)
}

/// Message for output that wasn't a JSON envelope at all: the last line of
/// stderr, or the offline message when stderr names a network failure.
fn interpret_unparseable(stderr: &str) -> CliError {
    if looks_like_network_error(stderr) {
        return CliError::offline();
    }
    let detail = stderr
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("no output")
        .trim();
    CliError::other(format!("The Claude CLI returned something unexpected: {detail}"))
}

/// Runs one non-interactive prompt and returns the assistant's text.
///
/// `--print` with `--output-format json` gives a single JSON envelope whose
/// `result` field holds the answer — or, when `is_error` is set, the reason
/// there isn't one. The CLI exits non-zero in that case too, but the body is
/// still valid JSON and carries the only useful message, so the body is
/// parsed first and the exit code is only a fallback.
///
/// Fails fast when Anthropic is unreachable and gives up after `limit`, so a
/// dead network is an error message rather than an endless spinner.
fn run_prompt(
    exe: &PathBuf,
    prompt: &str,
    model: Option<&str>,
    effort: Option<&str>,
    limit: Duration,
) -> Result<(String, Value), CliError> {
    if !anthropic_reachable() {
        return Err(CliError::offline());
    }
    let via_stdin = prompt.encode_utf16().count() > MAX_ARG_PROMPT_UNITS;
    let mut cmd = Command::new(exe);
    cmd.arg("--print");
    if !via_stdin {
        cmd.arg(prompt);
    }
    cmd.arg("--output-format")
        .arg("json")
        // Tag work is pure text transformation: no file access, no shell, no
        // network. Denying the tools outright means a prompt built from
        // someone's tag data can never talk the CLI into touching the disk.
        .arg("--allowedTools")
        .arg("")
        .arg("--append-system-prompt")
        .arg("Return only the requested JSON. Do not use any tools.");
    if let Some(m) = model.filter(|m| !m.trim().is_empty()) {
        cmd.arg("--model").arg(m);
    }
    if let Some(e) = effort.filter(|e| !e.trim().is_empty()) {
        cmd.arg("--effort").arg(e);
    }
    hide_console(&mut cmd);

    let out = run_with_timeout(cmd, limit, via_stdin.then(|| prompt.to_string()))?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();

    let envelope: Value = serde_json::from_str(stdout.trim())
        .map_err(|_| interpret_unparseable(&String::from_utf8_lossy(&out.stderr)))?;
    let text = interpret_envelope(&envelope)?;
    Ok((text, envelope))
}

/// Reports usage the same way the Ollama path does, so the usage dashboard
/// counts every backend rather than silently under-reporting this one.
///
/// Field names must match `AiUsage` (`model`, `prompt_eval_count`,
/// `eval_count`, `tracks`, camel-cased by serde) — the frontend's `ai-usage`
/// listener destructures those names, so an envelope with different keys
/// here is silently dropped (undefined fields, not an error).
///
/// `modelUsage` can list a small helper model (e.g. Haiku) alongside the
/// main one that did the actual work; the entry with the most output
/// tokens is the one that matters, not whichever key happens to come first.
fn emit_usage(app: &AppHandle, envelope: &Value, tracks: usize) {
    let usage = &envelope["usage"];
    // The CLI's per-model entries have been observed in both snake_case
    // (mirroring the top-level `usage` object) and camelCase; accept either.
    fn tokens(v: &Value, snake: &str, camel: &str) -> u64 {
        v[snake].as_u64().or_else(|| v[camel].as_u64()).unwrap_or(0)
    }
    let model_usage = envelope["modelUsage"].as_object();
    let main_entry = model_usage.and_then(|m| {
        m.iter().max_by_key(|(_, v)| tokens(v, "output_tokens", "outputTokens"))
    });
    let model = main_entry
        .map(|(k, _)| k.clone())
        .unwrap_or_else(|| "claude-cli".to_string());
    let (prompt_tokens, completion_tokens) = match main_entry {
        Some((_, v)) => (
            tokens(v, "input_tokens", "inputTokens"),
            tokens(v, "output_tokens", "outputTokens"),
        ),
        None => (
            usage["input_tokens"].as_u64().unwrap_or(0),
            usage["output_tokens"].as_u64().unwrap_or(0),
        ),
    };
    let _ = app.emit(
        "ai-usage",
        crate::models::AiUsage {
            model,
            prompt_eval_count: prompt_tokens,
            eval_count: completion_tokens,
            tracks,
        },
    );
}

/// Runs the official installer non-interactively (`irm .../install.ps1 | iex`
/// on Windows, the equivalent curl script elsewhere). This is the same
/// installer documented for manual setup — it drops `claude` into
/// `~/.local/bin` (`%USERPROFILE%\.local\bin` on Windows), which
/// `find_claude()` already checks, so a re-check right after this succeeds
/// picks it up with no PATH edits needed. It never signs the user in — that
/// step is inherently interactive (opens a browser), see `open_claude_login`.
#[tauri::command]
pub async fn install_claude_cli() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        #[cfg(target_os = "windows")]
        let mut cmd = {
            let mut c = Command::new("powershell");
            c.args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                "irm https://claude.ai/install.ps1 | iex",
            ]);
            c
        };
        #[cfg(not(target_os = "windows"))]
        let mut cmd = {
            let mut c = Command::new("sh");
            c.arg("-c").arg("curl -fsSL https://claude.ai/install.sh | bash");
            c
        };
        hide_console(&mut cmd);
        let out = cmd
            .output()
            .map_err(|e| format!("Could not run the installer: {e}"))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let detail = stderr
                .lines()
                .rev()
                .find(|l| !l.trim().is_empty())
                .unwrap_or("unknown error")
                .trim()
                .to_string();
            return Err(format!("Install failed: {detail}"));
        }
        Ok(())
    })
    .await
    .map_err(|_| "The installer task panicked".to_string())?
}

/// Opens a normal, visible terminal running the `claude` binary so the user
/// can complete the interactive `/login` flow (it opens a browser for
/// OAuth) — that step can't be driven headlessly from here.
#[tauri::command]
pub async fn open_claude_login() -> Result<(), String> {
    let exe = find_claude()
        .ok_or_else(|| "No Claude CLI found — install it first.".to_string())?;
    open_terminal_running(&exe)
}

#[cfg(target_os = "windows")]
fn open_terminal_running(exe: &PathBuf) -> Result<(), String> {
    // A plain `cmd /K <exe>` always gets its own console window (this app
    // has no console of its own), and `/K` keeps it open after `claude`
    // exits so any login error stays readable instead of flashing shut.
    Command::new("cmd")
        .arg("/K")
        .arg(exe)
        .spawn()
        .map_err(|e| format!("Could not open a terminal: {e}"))?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn open_terminal_running(exe: &PathBuf) -> Result<(), String> {
    let escaped = exe.to_string_lossy().replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!("tell application \"Terminal\" to do script \"{escaped}\"");
    Command::new("osascript")
        .arg("-e")
        .arg(script)
        .spawn()
        .map_err(|e| format!("Could not open a terminal: {e}"))?;
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_terminal_running(exe: &PathBuf) -> Result<(), String> {
    Command::new("x-terminal-emulator")
        .arg("-e")
        .arg(exe)
        .spawn()
        .map_err(|e| format!("Could not open a terminal: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn claude_cli_info() -> ClaudeCliInfo {
    tauri::async_runtime::spawn_blocking(|| {
        let Some(exe) = find_claude() else {
            return ClaudeCliInfo {
                found: false,
                path: None,
                version: None,
                logged_in: false,
                error: Some(
                    "No Claude CLI found. Install it with `npm i -g @anthropic-ai/claude-code`."
                        .to_string(),
                ),
                error_kind: Some(ErrorKind::Other.as_str().to_string()),
            };
        };
        let version = version_of(&exe);
        // The cheapest possible real call: it costs a handful of tokens and
        // is the only way to tell "installed" from "actually usable".
        let (logged_in, error) =
            match run_prompt(&exe, "Reply with exactly: OK", None, None, PING_TIMEOUT) {
                Ok(_) => (true, None),
                Err(e) => (false, Some(e)),
            };
        ClaudeCliInfo {
            found: true,
            path: Some(exe.to_string_lossy().to_string()),
            version,
            logged_in,
            error_kind: error.as_ref().map(|e| e.kind.as_str().to_string()),
            error: error.map(|e| e.message),
        }
    })
    .await
    .unwrap_or(ClaudeCliInfo {
        found: false,
        path: None,
        version: None,
        logged_in: false,
        error: Some("The Claude CLI probe failed unexpectedly".to_string()),
        error_kind: Some(ErrorKind::Other.as_str().to_string()),
    })
}

#[tauri::command]
pub async fn claude_clean_batch(
    app: AppHandle,
    tracks: Vec<TrackInput>,
    transliterate_scripts: Vec<String>,
    model: Option<String>,
    effort: Option<String>,
) -> Result<Vec<CleanedTrack>, String> {
    let count = tracks.len();
    let prompt = ai::build_clean_prompt(&tracks, &transliterate_scripts)?;
    let (text, envelope) = tauri::async_runtime::spawn_blocking(move || {
        let exe = find_claude().ok_or_else(|| {
            "No Claude CLI found — install it, or switch the AI backend in Settings.".to_string()
        })?;
        run_prompt(&exe, &prompt, model.as_deref(), effort.as_deref(), batch_timeout(count))
            .map_err(|e| e.message)
    })
    .await
    .map_err(|_| "The Claude CLI task panicked".to_string())??;

    emit_usage(&app, &envelope, count);
    ai::parse_cleaned(&text)
}

/// Generic text generation through the Claude CLI (D2 "New button"): one
/// prompt in, the answer out. Same offline check, tool denial and timeout as
/// the tag batches.
#[tauri::command]
pub async fn claude_generate_text(
    prompt: String,
    model: Option<String>,
    effort: Option<String>,
) -> Result<String, String> {
    let (text, _envelope) = tauri::async_runtime::spawn_blocking(move || {
        let exe = find_claude().ok_or_else(|| {
            "No Claude CLI found — install it, or switch the AI backend in Settings.".to_string()
        })?;
        run_prompt(&exe, &prompt, model.as_deref(), effort.as_deref(), Duration::from_secs(180))
            .map_err(|e| e.message)
    })
    .await
    .map_err(|_| "The Claude CLI task panicked".to_string())??;
    Ok(text)
}

/// AI playlists (D5) through the Claude CLI backend, using workstream F's
/// `claudeTasks.playlist` model/effort pair rather than the Clean task's.
#[tauri::command]
pub async fn claude_playlist_batch(
    app: AppHandle,
    pool: Vec<PlaylistTrackInput>,
    instructions: String,
    sets: Vec<PlaylistSetSpec>,
    model: Option<String>,
    effort: Option<String>,
) -> Result<PlaylistAiResult, String> {
    let pool_ids: Vec<u32> = pool.iter().map(|t| t.id).collect();
    let prompt = ai_playlist::build_playlist_prompt(&pool, &instructions, &sets)?;
    let timeout = batch_timeout(pool_ids.len());
    let (text, envelope) = tauri::async_runtime::spawn_blocking(move || {
        let exe = find_claude().ok_or_else(|| {
            "No Claude CLI found — install it, or switch the AI backend in Settings.".to_string()
        })?;
        run_prompt(
            &exe,
            &prompt,
            model.as_deref(),
            effort.as_deref(),
            timeout,
        )
        .map_err(|e| e.message)
    })
    .await
    .map_err(|_| "The Claude CLI task panicked".to_string())??;

    emit_usage(&app, &envelope, pool_ids.len());
    Ok(ai_playlist::parse_playlist_response(&text, &pool_ids))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The exact envelope the real CLI returns when it is installed but its
    /// credentials belong to the desktop app rather than a standalone login.
    /// Captured from a real run, because guessing this shape is how you ship
    /// a backend that reports "unexpected output" for the one failure every
    /// new user hits first.
    fn not_logged_in_envelope() -> Value {
        json!({
            "type": "result",
            "subtype": "success",
            "is_error": true,
            "result": "Not logged in · Please run /login",
            "usage": { "input_tokens": 0, "output_tokens": 0 },
            "total_cost_usd": 0
        })
    }

    /// Exercises the real `interpret_envelope`, flattened to the message.
    fn interpret(envelope: &Value) -> Result<String, String> {
        interpret_envelope(envelope).map_err(|e| e.message)
    }

    #[test]
    fn a_not_logged_in_envelope_becomes_actionable_advice() {
        let err = interpret(&not_logged_in_envelope()).unwrap_err();
        assert!(err.contains("not signed in"), "got: {err}");
        assert!(err.contains("claude"), "should say how to fix it: {err}");
    }

    #[test]
    fn an_error_envelope_surfaces_the_reason_rather_than_an_exit_code() {
        let v = json!({ "is_error": true, "result": "Rate limit exceeded" });
        assert_eq!(interpret(&v).unwrap_err(), "Claude CLI: Rate limit exceeded");
    }

    #[test]
    fn a_successful_envelope_yields_its_result_text() {
        let v = json!({ "is_error": false, "result": "[{\"index\":1,\"genre\":\"Techno\"}]" });
        assert_eq!(interpret(&v).unwrap(), "[{\"index\":1,\"genre\":\"Techno\"}]");
    }

    /// `is_error` absent must not be read as an error — the field is only
    /// present on some envelopes.
    #[test]
    fn a_missing_is_error_field_is_not_a_failure() {
        let v = json!({ "result": "OK" });
        assert_eq!(interpret(&v).unwrap(), "OK");
    }

    #[test]
    fn an_empty_result_is_an_error_not_an_empty_parse() {
        let v = json!({ "is_error": false, "result": "   " });
        assert!(interpret(&v).is_err());
    }

    /// Mirrors `run_prompt`'s flag-building so the empty-vs-set behaviour for
    /// both `--model` and `--effort` can be checked without spawning the CLI.
    fn build_args(model: Option<&str>, effort: Option<&str>) -> Vec<String> {
        let mut args = Vec::new();
        if let Some(m) = model.filter(|m| !m.trim().is_empty()) {
            args.push("--model".to_string());
            args.push(m.to_string());
        }
        if let Some(e) = effort.filter(|e| !e.trim().is_empty()) {
            args.push("--effort".to_string());
            args.push(e.to_string());
        }
        args
    }

    #[test]
    fn empty_model_and_effort_add_no_flags() {
        assert_eq!(build_args(None, None), Vec::<String>::new());
        assert_eq!(build_args(Some(""), Some("")), Vec::<String>::new());
    }

    #[test]
    fn a_set_model_and_effort_each_add_their_flag() {
        assert_eq!(
            build_args(Some("sonnet"), Some("low")),
            vec!["--model", "sonnet", "--effort", "low"]
        );
    }

    #[test]
    fn only_effort_set_omits_the_model_flag() {
        assert_eq!(build_args(None, Some("medium")), vec!["--effort", "medium"]);
    }

    #[test]
    fn usage_picks_the_model_with_the_most_output_tokens_not_the_first_key() {
        let envelope = json!({
            "modelUsage": {
                "claude-haiku-4-5": { "input_tokens": 50, "output_tokens": 10 },
                "claude-sonnet-5": { "input_tokens": 500, "output_tokens": 900 },
            },
            "usage": { "input_tokens": 0, "output_tokens": 0 },
        });
        fn tokens(v: &Value, snake: &str, camel: &str) -> u64 {
            v[snake].as_u64().or_else(|| v[camel].as_u64()).unwrap_or(0)
        }
        let model_usage = envelope["modelUsage"].as_object().unwrap();
        let (main_model, main_entry) = model_usage
            .iter()
            .max_by_key(|(_, v)| tokens(v, "output_tokens", "outputTokens"))
            .unwrap();
        assert_eq!(main_model, "claude-sonnet-5");
        assert_eq!(tokens(main_entry, "output_tokens", "outputTokens"), 900);
    }

    /// The CLI's own response is fed to the same parser the Ollama and manual
    /// backends use, so all three must accept the same shapes — including a
    /// fenced block, which is what a chat-tuned model tends to return.
    #[test]
    fn the_shared_parser_accepts_what_the_cli_typically_returns() {
        let fenced = "```json\n[{\"index\":1,\"artist\":\"Boris Brejcha\",\"title\":\"Gravity\"}]\n```";
        let parsed = ai::parse_cleaned(fenced).expect("fenced JSON should parse");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].artist.as_deref(), Some("Boris Brejcha"));
    }

    #[test]
    fn batch_timeout_scales_with_tracks_and_is_capped() {
        assert_eq!(batch_timeout(0), Duration::from_secs(60));
        assert_eq!(batch_timeout(10), Duration::from_secs(110));
        assert_eq!(batch_timeout(48), Duration::from_secs(300));
        assert_eq!(batch_timeout(10_000), Duration::from_secs(300));
    }

    #[test]
    fn network_phrases_are_recognised_case_insensitively() {
        for t in [
            "getaddrinfo ENOTFOUND api.anthropic.com",
            "connect ECONNREFUSED 1.2.3.4:443",
            "ETIMEDOUT",
            "API Error: Connection error.",
            "TypeError: fetch failed",
        ] {
            assert!(looks_like_network_error(t), "should match: {t}");
        }
        assert!(!looks_like_network_error("Rate limit exceeded"));
    }

    #[test]
    fn a_network_failure_envelope_maps_to_the_offline_error() {
        let v = json!({ "is_error": true, "result": "API Error: Connection error." });
        let e = interpret_envelope(&v).unwrap_err();
        assert_eq!(e.kind, ErrorKind::Offline);
        assert_eq!(e.message, OFFLINE_MESSAGE);
    }

    #[test]
    fn not_logged_in_keeps_its_own_kind() {
        let e = interpret_envelope(&not_logged_in_envelope()).unwrap_err();
        assert_eq!(e.kind, ErrorKind::NotLoggedIn);
    }

    #[test]
    fn unparseable_output_with_network_stderr_is_offline() {
        let e = interpret_unparseable("warn\nError: getaddrinfo ENOTFOUND api.anthropic.com\n");
        assert_eq!(e.kind, ErrorKind::Offline);
        let e = interpret_unparseable("something odd\n\n");
        assert_eq!(e.kind, ErrorKind::Other);
        assert!(e.message.ends_with("something odd"), "got: {}", e.message);
    }

    #[test]
    fn the_timeout_message_names_the_limit() {
        let e = CliError::timeout(Duration::from_secs(90));
        assert_eq!(e.kind, ErrorKind::Timeout);
        assert!(e.message.contains("90 s"), "got: {}", e.message);
        assert!(e.message.contains("smaller batch"));
    }
}
