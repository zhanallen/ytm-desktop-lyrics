/**
 * Core Tauri Backend Module (lib.rs)
 * Implements Win32 native subclassing, dynamic physical DPI window resizing,
 * system tray context menu i18n, global keyboard hotkeys, and WebSocket server runtime initialization.
 */

mod ws_server;

use tauri::{Emitter, Manager};
use tauri::menu::{MenuBuilder, MenuItem, MenuItemBuilder};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use std::sync::atomic::{AtomicI32, Ordering};

/**
 * Global Atomic I32 storing the locked minimum physical window height in physical pixels.
 * When > 0, Win32 WM_SIZING hook strictly clamps window height to this exact value.
 * When 0, Win32 WM_SIZING dynamically calculates min height based on responsive album cover ratio.
 */
pub static DYNAMIC_MIN_PHYS_HEIGHT: AtomicI32 = AtomicI32::new(0);

/**
 * State struct storing handles to System Tray Context Menu Items.
 * Allows real-time dynamic text updating when user switches language preferences between Traditional Chinese and English.
 */
pub struct TrayMenuItems {
    pub toggle: MenuItem<tauri::Wry>,
    pub settings: MenuItem<tauri::Wry>,
    pub quit: MenuItem<tauri::Wry>,
}

/**
 * Tauri Command: Updates system tray menu item text based on active language choice.
 */
#[tauri::command]
fn update_tray_language(app_handle: tauri::AppHandle, is_english: bool) -> Result<(), String> {
    if let Some(tray_items) = app_handle.try_state::<TrayMenuItems>() {
        if is_english {
            let _ = tray_items.toggle.set_text("Toggle Lyrics");
            let _ = tray_items.settings.set_text("Preferences");
            let _ = tray_items.quit.set_text("Quit");
        } else {
            let _ = tray_items.toggle.set_text("顯示/隱藏歌詞");
            let _ = tray_items.settings.set_text("偏好設定");
            let _ = tray_items.quit.set_text("結束程式");
        }
    }
    Ok(())
}

/**
 * Tauri Command: Toggles window mouse cursor click-through mode.
 */
#[tauri::command]
fn set_ignore_cursor_events(window: tauri::Window, ignore: bool) -> Result<(), String> {
    window.set_ignore_cursor_events(ignore).map_err(|e| e.to_string())
}

/**
 * Tauri Command: Initiates native window dragging from custom frontend DOM region.
 */
#[tauri::command]
fn start_drag(window: tauri::Window) -> Result<(), String> {
    window.start_dragging().map_err(|e| e.to_string())
}

/**
 * Tauri Command: Broadcasts player control commands (playPause, next, previous) to WebSocket clients.
 */
#[tauri::command]
fn send_player_command(command: String) -> Result<(), String> {
    let payload = serde_json::json!({ "command": command }).to_string();
    ws_server::broadcast_message(payload);
    Ok(())
}

/**
 * Tauri Command: Resizes physical window dimensions with physical pixel subpixel precision.
 */
#[tauri::command]
fn resize_physical_window(window: tauri::Window, width: u32, height: u32) -> Result<(), String> {
    let _ = window.set_min_size(Some(tauri::Size::Logical(tauri::LogicalSize::new(295.0, 86.0))));
    let _ = window.set_max_size(Option::<tauri::Size>::None);
    window.set_size(tauri::Size::Physical(tauri::PhysicalSize::new(width, height))).map_err(|e| e.to_string())
}

/**
 * Tauri Command: Updates locked minimum physical height atomically in DYNAMIC_MIN_PHYS_HEIGHT.
 */
#[tauri::command]
fn set_min_height_only(window: tauri::Window, height: u32) -> Result<(), String> {
    DYNAMIC_MIN_PHYS_HEIGHT.store(height as i32, Ordering::SeqCst);
    let _ = window.set_min_size(Some(tauri::Size::Logical(tauri::LogicalSize::new(295.0, 86.0))));
    Ok(())
}

/**
 * Tauri Command: Locks or unlocks physical window height when expanding/collapsing lyrics view.
 * Prevents subpixel incremental drift by using exact physical pixel values.
 */
#[tauri::command]
fn lock_window_height(window: tauri::Window, width: u32, height: u32, is_locked: bool) -> Result<(), String> {
    if is_locked {
        DYNAMIC_MIN_PHYS_HEIGHT.store(height as i32, Ordering::SeqCst);
    } else {
        DYNAMIC_MIN_PHYS_HEIGHT.store(0, Ordering::SeqCst);
    }
    let _ = window.set_min_size(Some(tauri::Size::Logical(tauri::LogicalSize::new(295.0, 86.0))));
    let _ = window.set_max_size(Option::<tauri::Size>::None);
    
    let current_width = window.outer_size().map(|s| s.width).unwrap_or(width);
    let target_width = if current_width > 0 { current_width } else { width };

    window.set_size(tauri::Size::Physical(tauri::PhysicalSize::new(target_width, height))).map_err(|e| e.to_string())
}

/**
 * Tauri Command: Emits event to frontend to toggle lyrics visibility.
 */
#[tauri::command]
fn toggle_lyrics_visibility(app_handle: tauri::AppHandle) -> Result<(), String> {
    let _ = app_handle.emit("toggle-lyrics-visibility", ());
    Ok(())
}

/**
 * Tauri Command: Opens or focuses the native secondary preferences window (360x420, standard window level).
 */
#[tauri::command]
fn open_settings_window(app_handle: tauri::AppHandle) -> Result<(), String> {
    if let Some(existing) = app_handle.get_webview_window("settings") {
        let _ = existing.show();
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        let _ = existing.emit("request-settings-state", ());
        return Ok(());
    }

    let _settings_window = tauri::WebviewWindowBuilder::new(
        &app_handle,
        "settings",
        tauri::WebviewUrl::App("index.html?window=settings".into()),
    )
    .title("偏好設定 - YT Music Lyrics")
    .inner_size(360.0, 420.0)
    .resizable(false)
    .maximizable(false)
    .decorations(true)
    .transparent(false)
    .always_on_top(false)
    .center()
    .build();

    Ok(())
}

/**
 * Win32 Subclassing Module for Windows OS.
 * Intercepts low-level WM_SIZING and WM_GETMINMAXINFO window messages to enforce smooth real-time physical aspect ratio limits.
 */
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

    /**
     * Subclass Procedure Function.
     * Intercepts window resizing events to dynamically calculate DPI scaling factor and enforce minimum physical height.
     */
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

    /** Attaches Win32 window subclassing hook to target HWND. */
    pub fn setup_win32_subclass(hwnd_val: isize) {
        unsafe {
            SetWindowSubclass(hwnd_val as HWND, Some(subclass_proc), SUBCLASS_ID, 0);
        }
    }
}

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

const CREATE_NO_WINDOW: u32 = 0x08000000;

/**
 * Windows Registry Protocol Auto-Registration Function.
 * Automatically registers or updates the `ytm-lyrics://` custom URL scheme in Windows User Registry (HKCU).
 * Binds the protocol handler to the exact current executable path of this app without requiring Admin privileges (UAC).
 * Uses CREATE_NO_WINDOW (0x08000000) creation_flags to prevent flashing console/CMD windows on startup.
 */
#[cfg(target_os = "windows")]
fn auto_register_windows_protocol() {
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_str) = exe_path.to_str() {
            let sanitized_exe = exe_str.replace("\"", "\\\"");
            let cmd_val = format!("\"{}\" \"%1\"", sanitized_exe);
            let _ = std::process::Command::new("reg")
                .creation_flags(CREATE_NO_WINDOW)
                .args(&["add", "HKCU\\Software\\Classes\\ytm-lyrics", "/ve", "/d", "URL:YTM Desktop Lyrics Protocol", "/f"])
                .output();
            let _ = std::process::Command::new("reg")
                .creation_flags(CREATE_NO_WINDOW)
                .args(&["add", "HKCU\\Software\\Classes\\ytm-lyrics", "/v", "URL Protocol", "/d", "", "/f"])
                .output();
            let _ = std::process::Command::new("reg")
                .creation_flags(CREATE_NO_WINDOW)
                .args(&["add", "HKCU\\Software\\Classes\\ytm-lyrics\\shell\\open\\command", "/ve", "/d", &cmd_val, "/f"])
                .output();
        }
    }
}

/**
 * Main Application Runner.
 * Sets up global shortcuts, system tray context menus, Tokio WebSocket task, and registers Tauri command handlers.
 */
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Automatically register/update Windows Custom URL Scheme (ytm-lyrics://) for current executable
    #[cfg(target_os = "windows")]
    auto_register_windows_protocol();

    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            let app_handle = app.handle().clone();

            // Setup System Tray Icon & Context Menu
            let toggle_item = MenuItemBuilder::with_id("toggle", "顯示/隱藏歌詞").build(app)?;
            let settings_item = MenuItemBuilder::with_id("settings", "偏好設定").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "結束程式").build(app)?;

            // Manage TrayMenuItems state for real-time i18n updates
            app.manage(TrayMenuItems {
                toggle: toggle_item.clone(),
                settings: settings_item.clone(),
                quit: quit_item.clone(),
            });

            let tray_menu = MenuBuilder::new(app)
                .items(&[&toggle_item, &settings_item, &quit_item])
                .build()?;

            let icon = app.default_window_icon().cloned();
            let mut tray_builder = TrayIconBuilder::new().menu(&tray_menu);
            if let Some(ic) = icon {
                tray_builder = tray_builder.icon(ic);
            }

            let _tray = tray_builder
                .on_menu_event(|app_handle, event| {
                    match event.id().as_ref() {
                        "toggle" => {
                            let _ = app_handle.emit("toggle-lyrics-visibility", ());
                        }
                        "settings" => {
                            let _ = open_settings_window(app_handle.clone());
                        }
                        "quit" => {
                            app_handle.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, .. } = event {
                        let app_handle = tray.app_handle();
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            // Prevent settings window destruction on close (hide window instead)
            if let Some(settings_win) = app.get_webview_window("settings") {
                let settings_win_clone = settings_win.clone();
                settings_win.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = settings_win_clone.hide();
                    }
                });
            }

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
            toggle_lyrics_visibility,
            open_settings_window,
            update_tray_language
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
