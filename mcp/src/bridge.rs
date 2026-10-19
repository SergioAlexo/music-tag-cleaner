//! Client for the app's local AI-control bridge (see src-tauri/src/bridge).
//!
//! The app writes `bridge.json` ({port, token}) to its data dir while
//! "AI control" is on; every request here re-reads it, so the helper keeps
//! working across app restarts (new port, new token).

use std::path::PathBuf;
use std::time::Duration;

use serde_json::{json, Value};

const IDENTIFIER: &str = "com.sopas.musictagcleaner";

#[derive(Debug, Clone)]
pub struct Connection {
    pub port: u16,
    pub token: String,
}

#[derive(Debug)]
pub enum BridgeError {
    /// App not running / AI control off / file unreadable. Message says how to fix it.
    NotConnected(String),
    /// Bridge answered but the request failed (HTTP status, bad JSON).
    Http(String),
    /// The action itself reported an error.
    Action(String),
}

impl std::fmt::Display for BridgeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BridgeError::NotConnected(m) | BridgeError::Http(m) | BridgeError::Action(m) => f.write_str(m),
        }
    }
}

/// Where the app keeps bridge.json. `MTC_BRIDGE_FILE` overrides (tests, portable setups).
pub fn bridge_file_path() -> PathBuf {
    if let Ok(p) = std::env::var("MTC_BRIDGE_FILE") {
        return PathBuf::from(p);
    }
    let base = if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from)
    } else if cfg!(target_os = "macos") {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support"))
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
    };
    base.unwrap_or_default().join(IDENTIFIER).join("bridge.json")
}

pub fn read_connection(path: &std::path::Path) -> Result<Connection, BridgeError> {
    let hint = "Open Vatra Wave and tick Settings -> AI control -> Allow AI control.";
    let text = std::fs::read_to_string(path)
        .map_err(|_| BridgeError::NotConnected(format!("Vatra Wave's AI control is not running ({} not found). {hint}", path.display())))?;
    parse_connection(&text).map_err(|e| BridgeError::NotConnected(format!("{e}. {hint}")))
}

pub fn parse_connection(text: &str) -> Result<Connection, String> {
    let v: Value = serde_json::from_str(text).map_err(|e| format!("bridge.json is not valid JSON: {e}"))?;
    let port = v["port"].as_u64().and_then(|p| u16::try_from(p).ok()).ok_or("bridge.json has no port")?;
    let token = v["token"].as_str().filter(|t| !t.is_empty()).ok_or("bridge.json has no token")?.to_string();
    Ok(Connection { port, token })
}

pub struct Bridge {
    file: PathBuf,
}

impl Bridge {
    pub fn new(file: PathBuf) -> Self {
        Bridge { file }
    }

    fn request(&self, method: &str, path: &str, body: Option<Value>, timeout: Duration) -> Result<Value, BridgeError> {
        let conn = read_connection(&self.file)?;
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(timeout))
            .http_status_as_error(false)
            // Loopback only; never follow a redirect to somewhere else.
            .max_redirects(0)
            .build()
            .into();
        let url = format!("http://127.0.0.1:{}{}", conn.port, path);
        let auth = format!("Bearer {}", conn.token);
        let sent = match (method, body) {
            ("POST", Some(b)) => agent.post(&url).header("Authorization", &auth).send_json(b),
            _ => agent.get(&url).header("Authorization", &auth).call(),
        };
        let mut resp = sent.map_err(|e| {
            BridgeError::NotConnected(format!(
                "Could not reach Vatra Wave on 127.0.0.1:{} ({e}). Is the app running with AI control on?",
                conn.port
            ))
        })?;
        let status = resp.status().as_u16();
        let json: Value = resp
            .body_mut()
            .read_json()
            .map_err(|e| BridgeError::Http(format!("bridge sent unreadable data (HTTP {status}): {e}")))?;
        if status == 401 {
            return Err(BridgeError::NotConnected(
                "The app rejected the key in bridge.json (it was restarted?). Try again.".into(),
            ));
        }
        if status != 200 {
            let msg = json["error"].as_str().unwrap_or("request failed");
            return Err(BridgeError::Http(format!("HTTP {status}: {msg}")));
        }
        Ok(json)
    }

    /// Every registered action with its JSON Schema.
    pub fn actions(&self) -> Result<Vec<Value>, BridgeError> {
        let v = self.request("GET", "/actions", None, Duration::from_secs(20))?;
        Ok(v["actions"].as_array().cloned().unwrap_or_default())
    }

    pub fn call(&self, action: &str, params: Value) -> Result<Value, BridgeError> {
        // Long: a call may wait for a person to click Allow, or run a conversion.
        let v = self.request(
            "POST",
            "/call",
            Some(json!({"action": action, "params": params})),
            Duration::from_secs(16 * 60),
        )?;
        if v["ok"].as_bool() == Some(true) {
            Ok(v["result"].clone())
        } else {
            Err(BridgeError::Action(v["error"].as_str().unwrap_or("action failed").to_string()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn parses_bridge_json_and_rejects_bad_ones() {
        let c = parse_connection(r#"{"port": 5123, "token": "abc", "pid": 4}"#).unwrap();
        assert_eq!((c.port, c.token.as_str()), (5123, "abc"));
        assert!(parse_connection(r#"{"port": 5123}"#).is_err());
        assert!(parse_connection(r#"{"port": 70000, "token": "x"}"#).is_err());
        assert!(parse_connection(r#"{"port": 1, "token": ""}"#).is_err());
        assert!(parse_connection("nope").is_err());
    }

    #[test]
    fn missing_file_says_how_to_fix() {
        let e = read_connection(std::path::Path::new("Z:/definitely/missing/bridge.json")).unwrap_err();
        assert!(e.to_string().contains("AI control"));
    }

    /// One-shot fake bridge: captures the request text, answers `body` with `status`.
    fn fake(status: u16, body: &'static str) -> (u16, std::thread::JoinHandle<String>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let h = std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let mut buf = vec![0u8; 8192];
            let mut got = Vec::new();
            loop {
                let n = s.read(&mut buf).unwrap();
                got.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&got).to_string();
                if let Some(i) = text.find("\r\n\r\n") {
                    let len = text
                        .lines()
                        .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
                        .unwrap_or(0);
                    if got.len() >= i + 4 + len {
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
            write!(s, "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            String::from_utf8_lossy(&got).to_string()
        });
        (port, h)
    }

    fn bridge_for(port: u16, dir: &tempfile_dir::Dir) -> Bridge {
        let f = dir.0.join("bridge.json");
        std::fs::write(&f, format!(r#"{{"port":{port},"token":"tok123"}}"#)).unwrap();
        Bridge::new(f)
    }

    mod tempfile_dir {
        pub struct Dir(pub std::path::PathBuf);
        impl Dir {
            pub fn new(tag: &str) -> Self {
                let p = std::env::temp_dir().join(format!("mtc-mcp-test-{tag}-{}", std::process::id()));
                std::fs::create_dir_all(&p).unwrap();
                Dir(p)
            }
        }
        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    #[test]
    fn actions_sends_the_bearer_token_and_unwraps_the_list() {
        let (port, h) = fake(200, r#"{"ok":true,"actions":[{"id":"session.list"}]}"#);
        let dir = tempfile_dir::Dir::new("actions");
        let list = bridge_for(port, &dir).actions().unwrap();
        assert_eq!(list[0]["id"], "session.list");
        let req = h.join().unwrap();
        assert!(req.starts_with("GET /actions"));
        assert!(req.to_ascii_lowercase().contains("authorization: bearer tok123"));
    }

    #[test]
    fn call_posts_json_and_maps_ok_false_to_action_error() {
        let (port, h) = fake(200, r#"{"ok":true,"result":{"n":2}}"#);
        let dir = tempfile_dir::Dir::new("call-ok");
        let out = bridge_for(port, &dir).call("demo.echo", json!({"a": 1})).unwrap();
        assert_eq!(out["n"], 2);
        let req = h.join().unwrap();
        assert!(req.starts_with("POST /call"));
        assert!(req.contains("\"action\": \"demo.echo\""), "{req}");

        let (port, h) = fake(200, r#"{"ok":false,"error":"nope"}"#);
        let dir2 = tempfile_dir::Dir::new("call-err");
        let err = bridge_for(port, &dir2).call("x.y", json!({})).unwrap_err();
        assert!(matches!(err, BridgeError::Action(ref m) if m == "nope"));
        h.join().unwrap();
    }

    #[test]
    fn a_401_is_reported_as_not_connected() {
        let (port, h) = fake(401, r#"{"ok":false,"error":"missing or wrong bearer token"}"#);
        let dir = tempfile_dir::Dir::new("401");
        let err = bridge_for(port, &dir).actions().unwrap_err();
        assert!(matches!(err, BridgeError::NotConnected(_)));
        h.join().unwrap();
    }
}
