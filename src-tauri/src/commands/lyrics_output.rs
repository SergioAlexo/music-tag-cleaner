//! The "Lyrics output" window (projector / second screen / OBS overlay).
//!
//! The window is created and steered from Rust so the JS side needs no window
//! permissions at all: the capability for the `lyrics-out` label (see
//! `capabilities/lyrics-output.json`) only allows events. The window has no
//! logic of its own; the main window sends it lines and the playback position
//! over events, so it keeps running while the main window is busy.

use serde::Serialize;
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

pub const LABEL: &str = "lyrics-out";

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    pub index: usize,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
    pub primary: bool,
}

/// "Monitor 2 (1920x1080)" style label when the OS gives no name.
pub fn monitor_label(index: usize, name: Option<&str>, w: u32, h: u32) -> String {
    match name.map(str::trim).filter(|n| !n.is_empty()) {
        Some(n) => format!("{} ({}x{})", n, w, h),
        None => format!("Monitor {} ({}x{})", index + 1, w, h),
    }
}

/// Where to put a window on `mon` so it is clearly inside it (and fullscreen
/// picks that monitor): a little in from the top-left corner, never larger
/// than the monitor.
pub fn placement_on(mon: &MonitorInfo) -> (i32, i32, u32, u32) {
    let w = (mon.width * 2 / 3).clamp(320, mon.width.max(320));
    let h = (mon.height * 2 / 3).clamp(200, mon.height.max(200));
    (mon.x + 40, mon.y + 40, w, h)
}

fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(LABEL)
}

// The commands that create or move the window are `async` on purpose: Tauri
// runs a synchronous command on the main thread, and on Windows building a
// webview window from there deadlocks inside WebView2 (see the "Known issues"
// on `WebviewWindowBuilder::new`) - the whole app would freeze on "Open".

#[tauri::command]
pub async fn lyrics_output_open(app: AppHandle) -> Result<(), String> {
    if let Some(w) = window(&app) {
        let _ = w.show();
        w.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("index.html?view=lyrics-out".into()))
        .title("Lyrics output")
        .inner_size(960.0, 540.0)
        .min_inner_size(320.0, 200.0)
        // Transparent so the OBS/overlay background option can show through;
        // the opaque presets paint their own background.
        .transparent(true)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn lyrics_output_close(app: AppHandle) -> Result<(), String> {
    close(&app)
}

/// Also called when the main window closes: on its own the output window has
/// nothing to show (its lines come from the main window), and left open it
/// kept the app running - often fullscreen on a projector.
pub fn close(app: &AppHandle) -> Result<(), String> {
    if let Some(w) = window(app) {
        w.destroy().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn lyrics_output_is_open(app: AppHandle) -> bool {
    window(&app).is_some()
}

#[tauri::command]
pub async fn lyrics_output_monitors(app: AppHandle) -> Result<Vec<MonitorInfo>, String> {
    monitors(&app)
}

fn monitors(app: &AppHandle) -> Result<Vec<MonitorInfo>, String> {
    let w = window(app).ok_or("The lyrics output window is not open")?;
    let primary = w.primary_monitor().ok().flatten().map(|m| *m.position());
    let list = w.available_monitors().map_err(|e| e.to_string())?;
    Ok(list
        .iter()
        .enumerate()
        .map(|(i, m)| MonitorInfo {
            index: i,
            name: monitor_label(i, m.name().map(|s| s.as_str()), m.size().width, m.size().height),
            width: m.size().width,
            height: m.size().height,
            x: m.position().x,
            y: m.position().y,
            primary: primary.as_ref() == Some(m.position()),
        })
        .collect())
}

/// Moves the window onto monitor `index` and (optionally) makes it fullscreen there.
#[tauri::command]
pub async fn lyrics_output_place(app: AppHandle, index: usize, fullscreen: bool) -> Result<(), String> {
    let w = window(&app).ok_or("The lyrics output window is not open")?;
    let monitors = monitors(&app)?;
    let mon = monitors.get(index).ok_or("That monitor is no longer connected")?;
    // Leave fullscreen first: a fullscreen window cannot be moved to another screen.
    let _ = w.set_fullscreen(false);
    let (x, y, cw, ch) = placement_on(mon);
    w.set_size(PhysicalSize::new(cw, ch)).map_err(|e| e.to_string())?;
    w.set_position(PhysicalPosition::new(x, y)).map_err(|e| e.to_string())?;
    if fullscreen {
        w.set_fullscreen(true).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn lyrics_output_fullscreen(app: AppHandle, on: bool) -> Result<(), String> {
    let w = window(&app).ok_or("The lyrics output window is not open")?;
    w.set_fullscreen(on).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn lyrics_output_is_fullscreen(app: AppHandle) -> bool {
    window(&app).and_then(|w| w.is_fullscreen().ok()).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mon(x: i32, w: u32) -> MonitorInfo {
        MonitorInfo { index: 1, name: "M".into(), width: w, height: 1080, x, y: 0, primary: false }
    }

    #[test]
    fn label_falls_back_to_a_number() {
        assert_eq!(monitor_label(1, None, 1920, 1080), "Monitor 2 (1920x1080)");
        assert_eq!(monitor_label(0, Some("  "), 800, 600), "Monitor 1 (800x600)");
        assert_eq!(monitor_label(0, Some("DELL U2720Q"), 3840, 2160), "DELL U2720Q (3840x2160)");
    }

    #[test]
    fn placement_stays_inside_the_monitor_including_negative_origins() {
        let (x, y, w, h) = placement_on(&mon(-1920, 1920));
        assert_eq!((x, y), (-1880, 40));
        assert!(w <= 1920 && h <= 1080 && w >= 320);
        // A tiny monitor never yields a window below the minimum size.
        let (_, _, w, _) = placement_on(&mon(0, 200));
        assert_eq!(w, 320);
    }
}
