//! Local AI-control bridge (D1).
//!
//! A tiny HTTP server that lets a local helper (the `mtc-mcp` MCP server, or
//! anything else holding the token) drive the app. It is a *relay*: the list
//! of actions and their behaviour live in the frontend action registry
//! (`src/lib/actions.ts`); this module only authenticates requests, forwards
//! them to the webview as `bridge-request` events and returns what
//! `bridge_respond` sends back. New actions therefore need no Rust change.
//!
//! Security model (all of it covered by tests below):
//! * binds `127.0.0.1` only - the address is built from a constant, there is no
//!   setting that can make it listen elsewhere;
//! * every route needs `Authorization: Bearer <token>`; the token is 256 random
//!   bits generated on each start and written to `bridge.json` in the app data
//!   dir (readable only by the user account that runs the app);
//! * requests carrying an `Origin` header (a browser page) are refused, and the
//!   `Host` header must be a loopback name:port, which blocks DNS-rebinding;
//! * off by default: nothing listens until Settings -> AI control is ticked.

use std::collections::HashMap;
use std::io::Read;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

pub const BRIDGE_FILE: &str = "bridge.json";
const MAX_BODY: u64 = 4 * 1024 * 1024;
/// A call can wait on a person (confirm dialog) or a long job (convert).
const CALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const LIST_TIMEOUT: Duration = Duration::from_secs(15);

// ---- pure request handling (unit-tested without Tauri or sockets) ----------

#[derive(Debug)]
pub enum RelayError {
    /// The action ran (or was refused) and reported this message.
    Action(String),
    /// The app could not be reached / did not answer in time.
    Transport(String),
}

pub trait Relay: Send + Sync {
    fn list(&self) -> Result<Value, RelayError>;
    fn call(&self, action: &str, params: Value) -> Result<Value, RelayError>;
}

#[derive(Debug, Default, Clone)]
pub struct Headers {
    pub authorization: Option<String>,
    pub host: Option<String>,
    pub origin: Option<String>,
}

#[derive(Debug, PartialEq)]
pub struct Reply {
    pub status: u16,
    pub body: Value,
}

fn reply(status: u16, body: Value) -> Reply {
    Reply { status, body }
}

/// The only address the server ever binds. Loopback by construction.
pub fn bind_addr(port: u16) -> SocketAddr {
    SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port)
}

/// Constant-time comparison so a wrong token leaks nothing through timing.
pub fn tokens_equal(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    let mut diff = (a.len() ^ b.len()) as u8;
    for i in 0..a.len().max(b.len()) {
        diff |= a.get(i).copied().unwrap_or(0) ^ b.get(i).copied().unwrap_or(0);
    }
    diff == 0
}

pub fn bearer_ok(header: Option<&str>, token: &str) -> bool {
    match header.and_then(|h| h.strip_prefix("Bearer ")) {
        Some(given) if !token.is_empty() => tokens_equal(given.trim(), token),
        _ => false,
    }
}

fn host_ok(host: Option<&str>, port: u16) -> bool {
    match host {
        Some(h) => {
            let h = h.trim().to_ascii_lowercase();
            h == format!("127.0.0.1:{port}") || h == format!("localhost:{port}") || h == format!("[::1]:{port}")
        }
        None => false,
    }
}

/// Routes one request. `token` is the live bearer token.
pub fn route(
    method: &str,
    path: &str,
    headers: &Headers,
    body: &[u8],
    token: &str,
    port: u16,
    relay: &dyn Relay,
) -> Reply {
    // Auth first, so an unauthenticated caller learns nothing (not even which
    // paths exist). Browsers always send Origin on cross-site requests.
    if headers.origin.is_some() {
        return reply(403, json!({"ok": false, "error": "browser origins are not allowed"}));
    }
    if !host_ok(headers.host.as_deref(), port) {
        return reply(403, json!({"ok": false, "error": "bad Host header"}));
    }
    if !bearer_ok(headers.authorization.as_deref(), token) {
        return reply(401, json!({"ok": false, "error": "missing or wrong bearer token"}));
    }
    let path = path.split('?').next().unwrap_or("");
    match (method, path) {
        ("GET", "/health") => reply(200, json!({"ok": true, "app": "music-tag-cleaner", "version": env!("CARGO_PKG_VERSION")})),
        ("GET", "/actions") => match relay.list() {
            Ok(v) => reply(200, json!({"ok": true, "actions": v})),
            Err(e) => relay_error(e),
        },
        ("POST", "/call") => {
            #[derive(Deserialize)]
            struct Call {
                action: String,
                #[serde(default)]
                params: Value,
            }
            let call: Call = match serde_json::from_slice(body) {
                Ok(c) => c,
                Err(e) => return reply(400, json!({"ok": false, "error": format!("bad JSON body: {e}")})),
            };
            match relay.call(&call.action, if call.params.is_null() { json!({}) } else { call.params }) {
                Ok(v) => reply(200, json!({"ok": true, "result": v})),
                Err(e) => relay_error(e),
            }
        }
        _ => reply(404, json!({"ok": false, "error": "not found"})),
    }
}

fn relay_error(e: RelayError) -> Reply {
    match e {
        // 200: the bridge worked, the action said no. Clients read `ok`.
        RelayError::Action(m) => reply(200, json!({"ok": false, "error": m})),
        RelayError::Transport(m) => reply(504, json!({"ok": false, "error": m})),
    }
}

pub fn new_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("OS random source unavailable");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ---- Tauri side ----------------------------------------------------------

type Answer = Result<Value, String>;

#[derive(Default)]
pub struct Pending {
    next: AtomicU64,
    waiting: Mutex<HashMap<u64, Sender<Answer>>>,
}

struct Running {
    server: Arc<tiny_http::Server>,
    port: u16,
    file: PathBuf,
}

#[derive(Default)]
pub struct BridgeState {
    running: Mutex<Option<Running>>,
    pending: Arc<Pending>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStatus {
    running: bool,
    port: Option<u16>,
    bridge_json_path: String,
    mcp_exe: String,
    mcp_exe_exists: bool,
}

struct TauriRelay {
    app: AppHandle,
    pending: Arc<Pending>,
}

impl TauriRelay {
    fn ask(&self, mut req: Value, timeout: Duration) -> Result<Value, RelayError> {
        let id = self.pending.next.fetch_add(1, Ordering::SeqCst) + 1;
        let (tx, rx) = mpsc::channel();
        self.pending.waiting.lock().unwrap_or_else(|e| e.into_inner()).insert(id, tx);
        req["id"] = json!(id);
        if let Err(e) = self.app.emit_to("main", "bridge-request", req) {
            self.pending.waiting.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
            return Err(RelayError::Transport(format!("could not reach the app window: {e}")));
        }
        let got = rx.recv_timeout(timeout);
        self.pending.waiting.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
        match got {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(m)) => Err(RelayError::Action(m)),
            Err(_) => Err(RelayError::Transport("the app did not answer in time".into())),
        }
    }
}

impl Relay for TauriRelay {
    fn list(&self) -> Result<Value, RelayError> {
        self.ask(json!({"kind": "list"}), LIST_TIMEOUT)
    }
    fn call(&self, action: &str, params: Value) -> Result<Value, RelayError> {
        self.ask(json!({"kind": "call", "action": action, "params": params}), CALL_TIMEOUT)
    }
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn mcp_exe_path() -> PathBuf {
    let name = if cfg!(windows) { "mtc-mcp.exe" } else { "mtc-mcp" };
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join(name)))
        .unwrap_or_else(|| PathBuf::from(name))
}

fn status(app: &AppHandle, state: &BridgeState) -> BridgeStatus {
    let run = state.running.lock().unwrap_or_else(|e| e.into_inner());
    let exe = mcp_exe_path();
    BridgeStatus {
        running: run.is_some(),
        port: run.as_ref().map(|r| r.port),
        bridge_json_path: data_dir(app).map(|d| d.join(BRIDGE_FILE).display().to_string()).unwrap_or_default(),
        mcp_exe: exe.display().to_string(),
        mcp_exe_exists: exe.exists(),
    }
}

fn start(app: &AppHandle, state: &BridgeState) -> Result<(), String> {
    let mut slot = state.running.lock().unwrap_or_else(|e| e.into_inner());
    if slot.is_some() {
        return Ok(());
    }
    let server = tiny_http::Server::http(bind_addr(0)).map_err(|e| format!("could not start the AI bridge: {e}"))?;
    let port = server.server_addr().to_ip().map(|a| a.port()).ok_or("no port")?;
    let token = new_token();
    let file = data_dir(app)?.join(BRIDGE_FILE);
    write_bridge_file(&file, port, &token)?;
    let server = Arc::new(server);
    let relay: Arc<dyn Relay> = Arc::new(TauriRelay { app: app.clone(), pending: state.pending.clone() });
    let srv = server.clone();
    std::thread::spawn(move || {
        for request in srv.incoming_requests() {
            let relay = relay.clone();
            let token = token.clone();
            // One thread per request: a call may block for minutes.
            std::thread::spawn(move || serve(request, &token, port, relay.as_ref()));
        }
    });
    *slot = Some(Running { server, port, file });
    Ok(())
}

fn stop(state: &BridgeState) {
    let run = state.running.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(r) = run {
        r.server.unblock();
        let _ = std::fs::remove_file(&r.file);
    }
    // Release anyone still waiting.
    let mut w = state.pending.waiting.lock().unwrap_or_else(|e| e.into_inner());
    for (_, tx) in w.drain() {
        let _ = tx.send(Err("AI control was turned off".into()));
    }
}

/// Called on window close so a stale `bridge.json` (token of a dead server) is not left behind.
pub fn shutdown(app: &AppHandle) {
    if let Some(state) = app.try_state::<BridgeState>() {
        stop(&state);
    }
}

fn write_bridge_file(path: &Path, port: u16, token: &str) -> Result<(), String> {
    let body = serde_json::to_vec_pretty(&json!({"port": port, "token": token, "pid": std::process::id(), "version": 1}))
        .map_err(|e| e.to_string())?;
    std::fs::write(path, body).map_err(|e| format!("could not write {}: {e}", path.display()))
}

fn serve(mut request: tiny_http::Request, token: &str, port: u16, relay: &dyn Relay) {
    let header = |name: &str| {
        request
            .headers()
            .iter()
            .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
            .map(|h| h.value.as_str().to_string())
    };
    let headers = Headers { authorization: header("Authorization"), host: header("Host"), origin: header("Origin") };
    // Belt and braces: a loopback-bound socket only ever sees loopback peers,
    // but refuse anything else outright.
    let peer_ok = request.remote_addr().map(|a| a.ip().is_loopback()).unwrap_or(false);
    let method = request.method().as_str().to_string();
    let url = request.url().to_string();
    let mut body = Vec::new();
    // Only read a body from a caller that already authenticated.
    let authed = bearer_ok(headers.authorization.as_deref(), token);
    if peer_ok && authed {
        let _ = request.as_reader().take(MAX_BODY).read_to_end(&mut body);
    }
    let out = if peer_ok {
        route(&method, &url, &headers, &body, token, port, relay)
    } else {
        reply(403, json!({"ok": false, "error": "loopback only"}))
    };
    let data = serde_json::to_vec(&out.body).unwrap_or_default();
    let mut resp = tiny_http::Response::from_data(data).with_status_code(out.status);
    if let Ok(h) = tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]) {
        resp = resp.with_header(h);
    }
    let _ = request.respond(resp);
}

// ---- commands ------------------------------------------------------------

#[tauri::command]
pub fn bridge_set_enabled(app: AppHandle, state: State<BridgeState>, enabled: bool) -> Result<BridgeStatus, String> {
    if enabled {
        start(&app, &state)?;
    } else {
        stop(&state);
    }
    Ok(status(&app, &state))
}

#[tauri::command]
pub fn bridge_status(app: AppHandle, state: State<BridgeState>) -> BridgeStatus {
    status(&app, &state)
}

/// The frontend's answer to a `bridge-request` event.
#[tauri::command]
pub fn bridge_respond(state: State<BridgeState>, id: u64, ok: bool, payload: Value) {
    let tx = state.pending.waiting.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    if let Some(tx) = tx {
        let _ = tx.send(if ok {
            Ok(payload)
        } else {
            Err(payload.as_str().map(str::to_string).unwrap_or_else(|| payload.to_string()))
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fake;
    impl Relay for Fake {
        fn list(&self) -> Result<Value, RelayError> {
            Ok(json!([{"id": "demo.echo"}]))
        }
        fn call(&self, action: &str, params: Value) -> Result<Value, RelayError> {
            match action {
                "demo.echo" => Ok(params),
                "demo.slow" => Err(RelayError::Transport("timeout".into())),
                _ => Err(RelayError::Action(format!("Unknown action \"{action}\""))),
            }
        }
    }

    const TOKEN: &str = "s3cret-token";
    fn headers(auth: Option<&str>) -> Headers {
        Headers { authorization: auth.map(String::from), host: Some("127.0.0.1:5000".into()), origin: None }
    }
    fn go(method: &str, path: &str, h: &Headers, body: &str) -> Reply {
        route(method, path, h, body.as_bytes(), TOKEN, 5000, &Fake)
    }

    #[test]
    fn missing_or_wrong_token_is_rejected_on_every_route() {
        for path in ["/health", "/actions", "/call", "/nope"] {
            assert_eq!(go("GET", path, &headers(None), "").status, 401, "{path} without token");
            assert_eq!(go("GET", path, &headers(Some("Bearer wrong")), "").status, 401, "{path} wrong");
            assert_eq!(go("GET", path, &headers(Some("s3cret-token")), "").status, 401, "{path} no scheme");
            assert_eq!(go("GET", path, &headers(Some("Bearer ")), "").status, 401, "{path} empty");
        }
    }

    #[test]
    fn empty_server_token_never_authenticates() {
        assert!(!bearer_ok(Some("Bearer "), ""));
        assert!(!bearer_ok(Some("Bearer x"), ""));
    }

    #[test]
    fn right_token_is_accepted() {
        let h = headers(Some("Bearer s3cret-token"));
        assert_eq!(go("GET", "/health", &h, "").status, 200);
        let r = go("GET", "/actions", &h, "");
        assert_eq!(r.body["actions"][0]["id"], "demo.echo");
        let r = go("POST", "/call", &h, r#"{"action":"demo.echo","params":{"a":1}}"#);
        assert_eq!(r.body, json!({"ok": true, "result": {"a": 1}}));
    }

    #[test]
    fn action_errors_are_200_ok_false_and_transport_errors_are_504() {
        let h = headers(Some("Bearer s3cret-token"));
        let r = go("POST", "/call", &h, r#"{"action":"x.y"}"#);
        assert_eq!((r.status, r.body["ok"].as_bool()), (200, Some(false)));
        assert_eq!(go("POST", "/call", &h, r#"{"action":"demo.slow"}"#).status, 504);
        assert_eq!(go("POST", "/call", &h, "not json").status, 400);
        assert_eq!(go("GET", "/nope", &h, "").status, 404);
    }

    #[test]
    fn browser_origins_and_foreign_hosts_are_refused_even_with_the_token() {
        let mut h = headers(Some("Bearer s3cret-token"));
        h.origin = Some("https://evil.example".into());
        assert_eq!(go("GET", "/health", &h, "").status, 403);
        let mut h = headers(Some("Bearer s3cret-token"));
        h.host = Some("evil.example:5000".into());
        assert_eq!(go("GET", "/health", &h, "").status, 403);
        h.host = None;
        assert_eq!(go("GET", "/health", &h, "").status, 403);
        h.host = Some("localhost:5000".into());
        assert_eq!(go("GET", "/health", &h, "").status, 200);
    }

    #[test]
    fn bind_address_is_always_loopback() {
        for port in [0u16, 80, 5000, 65535] {
            let a = bind_addr(port);
            assert!(a.ip().is_loopback());
            assert_eq!(a.ip(), IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)));
        }
    }

    #[test]
    fn tokens_are_long_random_and_compare_constant_time_correctly() {
        let (a, b) = (new_token(), new_token());
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
        assert!(tokens_equal(&a, &a));
        assert!(!tokens_equal(&a, &b));
        assert!(!tokens_equal("abc", "abcd"));
    }

    /// Real socket: the server binds loopback and enforces the token end to end.
    #[test]
    fn live_server_enforces_auth_over_a_real_socket() {
        let server = Arc::new(tiny_http::Server::http(bind_addr(0)).unwrap());
        let addr = server.server_addr().to_ip().unwrap();
        assert!(addr.ip().is_loopback());
        let port = addr.port();
        let srv = server.clone();
        std::thread::spawn(move || {
            for req in srv.incoming_requests() {
                serve(req, TOKEN, port, &Fake);
            }
        });
        let get = |auth: Option<&str>| -> String {
            use std::io::Write;
            let mut s = std::net::TcpStream::connect(addr).unwrap();
            let a = auth.map(|a| format!("Authorization: {a}\r\n")).unwrap_or_default();
            write!(s, "GET /actions HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{a}Connection: close\r\n\r\n").unwrap();
            let mut out = String::new();
            s.read_to_string(&mut out).unwrap();
            out
        };
        assert!(get(None).starts_with("HTTP/1.1 401"));
        assert!(get(Some("Bearer nope")).starts_with("HTTP/1.1 401"));
        let ok = get(Some("Bearer s3cret-token"));
        assert!(ok.starts_with("HTTP/1.1 200"), "{ok}");
        assert!(ok.contains("demo.echo"));
        server.unblock();
    }
}
