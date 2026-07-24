mod ws_server;

use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

#[tauri::command]
fn set_ignore_cursor_events(window: tauri::Window, ignore: bool) -> Result<(), String> {
    window.set_ignore_cursor_events(ignore).map_err(|e| e.to_string())
}

#[tauri::command]
fn start_drag(window: tauri::Window) -> Result<(), String> {
    window.start_dragging().map_err(|e| e.to_string())
}

#[tauri::command]
fn send_player_command(command: String) -> Result<(), String> {
    let payload = serde_json::json!({ "command": command }).to_string();
    ws_server::broadcast_message(payload);
    Ok(())
}

use std::sync::atomic::{AtomicI32, Ordering};

pub static DYNAMIC_MIN_PHYS_HEIGHT: AtomicI32 = AtomicI32::new(0);

#[tauri::command]
fn resize_physical_window(window: tauri::Window, width: u32, height: u32) -> Result<(), String> {
    let _ = window.set_min_size(Some(tauri::Size::Logical(tauri::LogicalSize::new(295.0, 86.0))));
    let _ = window.set_max_size(Option::<tauri::Size>::None);
    window.set_size(tauri::Size::Physical(tauri::PhysicalSize::new(width, height))).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_min_height_only(window: tauri::Window, height: u32) -> Result<(), String> {
    DYNAMIC_MIN_PHYS_HEIGHT.store(height as i32, Ordering::SeqCst);
    let _ = window.set_min_size(Some(tauri::Size::Logical(tauri::LogicalSize::new(295.0, 86.0))));
    Ok(())
}

#[tauri::command]
fn lock_window_height(window: tauri::Window, width: u32, height: u32, is_locked: bool) -> Result<(), String> {
    // Only update minimum height limit when collapsing (is_locked: true). Never lock expanded lyrics height (450px) as min height!
    if is_locked {
        DYNAMIC_MIN_PHYS_HEIGHT.store(height as i32, Ordering::SeqCst);
    }
    let _ = window.set_min_size(Some(tauri::Size::Logical(tauri::LogicalSize::new(295.0, 86.0))));
    let _ = window.set_max_size(Option::<tauri::Size>::None);
    
    // Always preserve current physical width to prevent DPI scaling cumulative expansion
    let current_width = window.outer_size().map(|s| s.width).unwrap_or(width);
    let target_width = if current_width > 0 { current_width } else { width };

    window.set_size(tauri::Size::Physical(tauri::PhysicalSize::new(target_width, height))).map_err(|e| e.to_string())
}

#[tauri::command]
fn toggle_lyrics_visibility(app_handle: tauri::AppHandle) -> Result<(), String> {
    let _ = app_handle.emit("toggle-lyrics-visibility", ());
    Ok(())
}

#[cfg(target_os = "windows")]
mod win32_subclass {
    use super::DYNAMIC_MIN_PHYS_HEIGHT;
    use std::sync::atomic::Ordering;
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
    use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        MINMAXINFO, WM_DESTROY, WM_GETMINMAXINFO, WM_SIZING,
    };

    const SUBCLASS_ID: usize = 1001;

    unsafe extern "system" fn subclass_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _uidsubclass: usize,
        _dwrefdata: usize,
    ) -> LRESULT {
        match msg {
            WM_SIZING => {
                let rect = &mut *(lparam as *mut RECT);
                let dpi = GetDpiForWindow(hwnd);
                let scale_factor: f64 = if dpi > 0 { dpi as f64 / 96.0 } else { 1.0 };

                let target_min = DYNAMIC_MIN_PHYS_HEIGHT.load(Ordering::SeqCst);
                let min_phys_height = if target_min > 0 {
                    target_min
                } else {
                    let phys_width = (rect.right - rect.left) as f64;
                    let logical_width = phys_width / scale_factor;
                    let album_width = (0.35 * logical_width - 39.25).clamp(64.0, 280.0);
                    ((album_width + 22.0) * scale_factor).ceil() as i32
                };

                let current_height = rect.bottom - rect.top;
                if current_height < min_phys_height {
                    rect.bottom = rect.top + min_phys_height;
                }
            }
            WM_GETMINMAXINFO => {
                let info = &mut *(lparam as *mut MINMAXINFO);
                let dpi = GetDpiForWindow(hwnd);
                let scale_factor: f64 = if dpi > 0 { dpi as f64 / 96.0 } else { 1.0 };

                let min_phys_width = (295.0 * scale_factor).ceil() as i32;
                let min_phys_height = (86.0 * scale_factor).ceil() as i32;

                info.ptMinTrackSize.x = min_phys_width;
                info.ptMinTrackSize.y = min_phys_height;
            }
            WM_DESTROY => {
                RemoveWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID);
            }
            _ => {}
        }
        DefSubclassProc(hwnd, msg, wparam, lparam)
    }

    pub fn setup_win32_subclass(hwnd_val: isize) {
        unsafe {
            SetWindowSubclass(hwnd_val as HWND, Some(subclass_proc), SUBCLASS_ID, 0);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            let app_handle = app.handle().clone();

            // Disable Maximizable, set initial size 295x163, position top 200px / right 100px & attach Win32 Subclass
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_maximizable(false);
                let _ = window.set_min_size(Some(tauri::Size::Logical(tauri::LogicalSize::new(295.0, 86.0))));
                let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(295.0, 163.0)));

                if let Ok(Some(monitor)) = window.primary_monitor() {
                    let monitor_size = monitor.size();
                    let scale_factor = monitor.scale_factor();
                    
                    let win_phys_width = (295.0 * scale_factor).ceil() as i32;
                    let x = monitor_size.width as i32 - win_phys_width - (100.0 * scale_factor).ceil() as i32;
                    let y = (200.0 * scale_factor).ceil() as i32;

                    let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(x, y)));
                }

                #[cfg(target_os = "windows")]
                if let Ok(hwnd) = window.hwnd() {
                    win32_subclass::setup_win32_subclass(hwnd.0 as isize);
                }
            }

            // Spawn Tokio WebSocket Server Task
            tauri::async_runtime::spawn(async move {
                ws_server::start_ws_server(app_handle).await;
            });

            // Register Global Hotkey Alt+L for Click-Through Toggle
            let shortcut_clickthrough = Shortcut::new(Some(Modifiers::ALT), Code::KeyL);
            let _ = app.global_shortcut().on_shortcut(shortcut_clickthrough, move |app_handle, _shortcut, event| {
                if event.state() == ShortcutState::Pressed {
                    let _ = app_handle.emit("toggle-click-through", ());
                }
            });

            // Register Global Hotkey Alt+V for Lyrics Collapse Toggle
            let shortcut_lyrics = Shortcut::new(Some(Modifiers::ALT), Code::KeyV);
            let _ = app.global_shortcut().on_shortcut(shortcut_lyrics, move |app_handle, _shortcut, event| {
                if event.state() == ShortcutState::Pressed {
                    let _ = app_handle.emit("toggle-lyrics-visibility", ());
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_ignore_cursor_events,
            start_drag,
            send_player_command,
            resize_physical_window,
            set_min_height_only,
            lock_window_height,
            toggle_lyrics_visibility
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
