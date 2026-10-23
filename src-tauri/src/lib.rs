/**
 * Core Tauri Backend Module (lib.rs)
 * Implements Win32 native subclassing, dynamic physical DPI window resizing,
 * system tray context menu i18n, global keyboard hotkeys, and WebSocket server runtime initialization.
 */

mod ws_server;
#[cfg(target_os = "windows")]
mod dxgi_capture;

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
 * Global atomic flag for desktop background capture quality: true = 1:1 Native Crisp, false = 0.5x Performance.
 */
pub static IS_NATIVE_CAPTURE_QUALITY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

/**
 * Tauri Command: Sets desktop background capture quality mode (true = 1:1 Native, false = 0.5x Performance).
 */
#[tauri::command]
fn set_capture_quality(is_native: bool) {
    IS_NATIVE_CAPTURE_QUALITY.store(is_native, std::sync::atomic::Ordering::SeqCst);
}

/**
 * State struct storing handles to System Tray Context Menu Items.
 * Allows real-time dynamic text updating when user switches language preferences between Traditional Chinese and English.
 */
pub struct TrayMenuItems {
    pub toggle: MenuItem<tauri::Wry>,
    pub clickthrough: MenuItem<tauri::Wry>,
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
            let _ = tray_items.toggle.set_text("Toggle Lyrics (Alt+V)");
            let _ = tray_items.clickthrough.set_text("Toggle Click-Through (Alt+L)");
            let _ = tray_items.settings.set_text("Preferences");
            let _ = tray_items.quit.set_text("Quit");
        } else {
            let _ = tray_items.toggle.set_text("顯示/隱藏歌詞 (Alt+V)");
            let _ = tray_items.clickthrough.set_text("切換滑鼠穿透 (Alt+L)");
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
    let clamped_w = width.clamp(200, 7680);
    let clamped_h = height.clamp(80, 4320);
    let _ = window.set_min_size(Some(tauri::Size::Logical(tauri::LogicalSize::new(295.0, 86.0))));
    let _ = window.set_max_size(Option::<tauri::Size>::None);
    window.set_size(tauri::Size::Physical(tauri::PhysicalSize::new(clamped_w, clamped_h))).map_err(|e| e.to_string())
}

/**
 * Tauri Command: Updates locked minimum physical height atomically in DYNAMIC_MIN_PHYS_HEIGHT.
 */
#[tauri::command]
fn set_min_height_only(window: tauri::Window, height: u32) -> Result<(), String> {
    DYNAMIC_MIN_PHYS_HEIGHT.store(height as i32, Ordering::SeqCst);
    let scale_factor = window.scale_factor().unwrap_or(1.0);
    let logical_height = (height as f64) / scale_factor;
    let _ = window.set_min_size(Some(tauri::Size::Logical(tauri::LogicalSize::new(280.0, logical_height))));
    Ok(())
}

/**
 * Tauri Command: Locks or unlocks physical window height when expanding/collapsing lyrics view.
 * Prevents subpixel incremental drift by using exact physical pixel values.
 */
#[tauri::command]
fn lock_window_height(window: tauri::Window, width: u32, height: u32, is_locked: bool) -> Result<(), String> {
    if is_locked {
        let scale_factor = window.scale_factor().unwrap_or(1.0);
        let logical_height = (height as f64) / scale_factor;
        let _ = window.set_min_size(Some(tauri::Size::Logical(tauri::LogicalSize::new(280.0, logical_height))));
        DYNAMIC_MIN_PHYS_HEIGHT.store(height as i32, Ordering::SeqCst);
    } else {
        DYNAMIC_MIN_PHYS_HEIGHT.store(0, Ordering::SeqCst);
        let _ = window.set_min_size(Some(tauri::Size::Logical(tauri::LogicalSize::new(280.0, 86.0))));
    }
    let _ = window.set_max_size(Option::<tauri::Size>::None);
    
    let current_width = window.outer_size().map(|s| s.width).unwrap_or(width);
    let target_width = if current_width > 0 { current_width } else { width };

    window.set_size(tauri::Size::Physical(tauri::PhysicalSize::new(target_width, height))).map_err(|e| e.to_string())
}

#[cfg(target_os = "windows")]
struct GdiCapturePool {
    hdc_screen: isize,
    hdc_mem: isize,
    hbm: isize,
    default_hbm: isize,
    bits_ptr: *mut u8,
    cap_w: i32,
    cap_h: i32,
}

// Safety: GdiCapturePool raw pointers are strictly guarded by std::sync::Mutex across threads
#[cfg(target_os = "windows")]
unsafe impl Send for GdiCapturePool {}

#[cfg(target_os = "windows")]
impl GdiCapturePool {
    fn new() -> Self {
        Self {
            hdc_screen: 0,
            hdc_mem: 0,
            hbm: 0,
            default_hbm: 0,
            bits_ptr: core::ptr::null_mut(),
            cap_w: 0,
            cap_h: 0,
        }
    }

    unsafe fn ensure_capacity(&mut self, width: i32, height: i32) {
        use windows_sys::Win32::Graphics::Gdi::*;
        if self.hdc_screen == 0 {
            self.hdc_screen = GetDC(0 as _) as isize;
        }
        if self.hdc_mem == 0 && self.hdc_screen != 0 {
            self.hdc_mem = CreateCompatibleDC(self.hdc_screen as _) as isize;
        }
        if width > self.cap_w || height > self.cap_h || self.hbm == 0 {
            // Align dimensions to 64-pixel blocks to minimize GDI bitmap allocations during dynamic resizing
            let target_w = (((width + 63) / 64) * 64).max(self.cap_w).max(448).min(7680);
            let target_h = (((height + 63) / 64) * 64).max(self.cap_h).max(320).min(4320);

            let mut bmi: BITMAPINFO = std::mem::zeroed();
            bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
            bmi.bmiHeader.biWidth = target_w;
            bmi.bmiHeader.biHeight = -target_h; // Top-down DIB
            bmi.bmiHeader.biPlanes = 1;
            bmi.bmiHeader.biBitCount = 32;
            bmi.bmiHeader.biCompression = BI_RGB as u32;

            let mut bits: *mut core::ffi::c_void = core::ptr::null_mut();
            let new_hbm = CreateDIBSection(
                self.hdc_mem as _,
                &bmi as *const _,
                DIB_RGB_COLORS,
                &mut bits as *mut _,
                core::ptr::null_mut(),
                0,
            ) as isize;

            if new_hbm != 0 {
                self.cap_w = target_w;
                self.cap_h = target_h;
                let old_selected = SelectObject(self.hdc_mem as _, new_hbm as _) as isize;
                // Save original default 1x1 bitmap handle on first selection
                if self.default_hbm == 0 && old_selected != 0 {
                    self.default_hbm = old_selected;
                }
                // Safely delete previous DIBSection that has now been unselected
                if self.hbm != 0 {
                    DeleteObject(self.hbm as _);
                }
                self.hbm = new_hbm;
                self.bits_ptr = bits as *mut u8;
            }
        }
    }
}

#[cfg(target_os = "windows")]
impl Drop for GdiCapturePool {
    fn drop(&mut self) {
        use windows_sys::Win32::Graphics::Gdi::*;
        unsafe {
            // Restore default bitmap first so that self.hbm is unselected from DC
            if self.hdc_mem != 0 && self.default_hbm != 0 {
                SelectObject(self.hdc_mem as _, self.default_hbm as _);
                self.default_hbm = 0;
            }
            if self.hbm != 0 {
                DeleteObject(self.hbm as _);
                self.hbm = 0;
                self.bits_ptr = core::ptr::null_mut();
            }
            if self.hdc_mem != 0 {
                DeleteDC(self.hdc_mem as _);
                self.hdc_mem = 0;
            }
            if self.hdc_screen != 0 {
                ReleaseDC(0 as _, self.hdc_screen as _);
                self.hdc_screen = 0;
            }
        }
    }
}

#[cfg(target_os = "windows")]
pub enum GdiCaptureResult {
    Unchanged,
    Captured(usize),
    Failed,
}

#[cfg(target_os = "windows")]
#[derive(Clone, Copy)]
struct GdiLastFrameState {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    sample_hash: u64,
}

#[cfg(target_os = "windows")]
static GDI_ENGINE: std::sync::Mutex<Option<GdiCapturePool>> = std::sync::Mutex::new(None);
#[cfg(target_os = "windows")]
static GDI_LAST_FRAME: std::sync::Mutex<Option<GdiLastFrameState>> = std::sync::Mutex::new(None);
pub(crate) static GLOBAL_PERSISTENT_BUFFER: std::sync::Mutex<Vec<u8>> = std::sync::Mutex::new(Vec::new());

#[cfg(target_os = "windows")]
pub fn clear_gdi_last_frame() {
    if let Ok(mut guard) = GDI_LAST_FRAME.lock() {
        *guard = None;
    }
}

#[cfg(not(target_os = "windows"))]
pub fn clear_gdi_last_frame() {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GdiAabb {
    pub req_x: i32,
    pub req_y: i32,
    pub req_w: i32,
    pub req_h: i32,
    pub src_x: i32,
    pub src_y: i32,
    pub dst_x: i32,
    pub dst_y: i32,
    pub copy_w: i32,
    pub copy_h: i32,
    pub cap_width: i32,
    pub cap_height: i32,
}

pub fn compute_gdi_capture_aabb(
    x: i32,
    y: i32,
    clamped_w: i32,
    clamped_h: i32,
    v_x: i32,
    v_y: i32,
    v_w: i32,
    v_h: i32,
) -> GdiAabb {
    let padding = 64i32;
    let req_x = x.saturating_sub(padding);
    let req_y = y.saturating_sub(padding);
    let req_w = clamped_w.saturating_add(padding * 2);
    let req_h = clamped_h.saturating_add(padding * 2);

    let v_right = v_x.saturating_add(v_w);
    let v_bottom = v_y.saturating_add(v_h);

    let intersect_left = req_x.max(v_x);
    let intersect_top = req_y.max(v_y);
    let intersect_right = (req_x.saturating_add(req_w)).min(v_right);
    let intersect_bottom = (req_y.saturating_add(req_h)).min(v_bottom);

    let copy_w = (intersect_right.saturating_sub(intersect_left)).max(0);
    let copy_h = (intersect_bottom.saturating_sub(intersect_top)).max(0);

    let src_x = intersect_left;
    let src_y = intersect_top;
    let dst_x = (intersect_left.saturating_sub(req_x)).max(0);
    let dst_y = (intersect_top.saturating_sub(req_y)).max(0);

    let cap_width = req_w.max(1);
    let cap_height = req_h.max(1);

    GdiAabb {
        req_x,
        req_y,
        req_w,
        req_h,
        src_x,
        src_y,
        dst_x,
        dst_y,
        copy_w,
        copy_h,
        cap_width,
        cap_height,
    }
}

#[cfg(target_os = "windows")]
pub fn capture_desktop_background_gdi_native(x: i32, y: i32, width: i32, height: i32, force_capture: bool) -> GdiCaptureResult {
    use windows_sys::Win32::Graphics::Gdi::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
    };

    if width <= 0 || height <= 0 {
        return GdiCaptureResult::Failed;
    }

    let clamped_w = width.min(7680);
    let clamped_h = height.min(4320);

    unsafe {
        let (v_x, v_y, v_w, v_h) = (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
        );

        let padding = 64i32;
        let aabb = compute_gdi_capture_aabb(x, y, clamped_w, clamped_h, v_x, v_y, v_w, v_h);
        let req_w = aabb.req_w;
        let req_h = aabb.req_h;
        let copy_w = aabb.copy_w;
        let copy_h = aabb.copy_h;
        let src_x = aabb.src_x;
        let src_y = aabb.src_y;
        let dst_x = aabb.dst_x;
        let dst_y = aabb.dst_y;
        let cap_width = aabb.cap_width;
        let cap_height = aabb.cap_height;

        if copy_w == 0 || copy_h == 0 {
            return GdiCaptureResult::Failed;
        }

        let is_native = IS_NATIVE_CAPTURE_QUALITY.load(std::sync::atomic::Ordering::SeqCst);
        let (tex_w, tex_h) = if is_native {
            (cap_width as u16, cap_height as u16)
        } else {
            (((cap_width + 1) / 2) as u16, ((cap_height + 1) / 2) as u16)
        };
        let buffer_size = (tex_w as usize) * (tex_h as usize) * 4;
        let total_len = 32usize + buffer_size;

        let mut engine_guard = match GDI_ENGINE.lock() {
            Ok(g) => g,
            Err(_) => return GdiCaptureResult::Failed,
        };

        if engine_guard.is_none() {
            *engine_guard = Some(GdiCapturePool::new());
        }
        let pool = engine_guard.as_mut().unwrap();
        pool.ensure_capacity(tex_w as i32, tex_h as i32);

        if pool.hdc_screen == 0 || pool.hdc_mem == 0 || pool.hbm == 0 || pool.bits_ptr.is_null() {
            return GdiCaptureResult::Failed;
        }

        if (tex_w as i32) > pool.cap_w || (tex_h as i32) > pool.cap_h {
            return GdiCaptureResult::Failed;
        }

        PatBlt(pool.hdc_mem as _, 0, 0, tex_w as i32, tex_h as i32, BLACKNESS as _);

        let blt_res = if is_native {
            BitBlt(
                pool.hdc_mem as _,
                dst_x,
                dst_y,
                copy_w,
                copy_h,
                pool.hdc_screen as _,
                src_x,
                src_y,
                SRCCOPY,
            )
        } else {
            let dst_x_scaled = (dst_x * (tex_w as i32)) / req_w.max(1);
            let dst_y_scaled = (dst_y * (tex_h as i32)) / req_h.max(1);
            let copy_w_scaled = (copy_w * (tex_w as i32)) / req_w.max(1);
            let copy_h_scaled = (copy_h * (tex_h as i32)) / req_h.max(1);

            // High-speed 0.5x Hardware StretchBlt with COLORONCOLOR
            SetStretchBltMode(pool.hdc_mem as _, COLORONCOLOR as _);
            StretchBlt(
                pool.hdc_mem as _,
                dst_x_scaled,
                dst_y_scaled,
                copy_w_scaled,
                copy_h_scaled,
                pool.hdc_screen as _,
                src_x,
                src_y,
                copy_w,
                copy_h,
                SRCCOPY,
            )
        };

        if blt_res == 0 {
            return GdiCaptureResult::Failed;
        }

        // Fast 64-bit Sampling Hash Dirty Check on downsampled buffer (< 0.01ms)
        let mut hash: u64 = 0xcbf29ce484222325; // FNV-1a 64-bit offset
        let src_ptr = pool.bits_ptr;
        let src_stride = (pool.cap_w as usize) * 4;
        let h = tex_h as usize;
        let w = tex_w as usize;
        let mut has_non_zero = false;

        for r in (0..h).step_by(2) {
            let row_ptr = src_ptr.add(r * src_stride) as *const u32;
            for c in (0..w).step_by(4) {
                let px = *row_ptr.add(c);
                if (px & 0x00ffffff) != 0 {
                    has_non_zero = true;
                }
                hash = (hash ^ (px as u64)).wrapping_mul(0x100000001b3);
            }
        }

        if !has_non_zero && !(copy_w > 0 && copy_h > 0 && blt_res != 0) {
            return GdiCaptureResult::Failed;
        }

        let is_unchanged = if force_capture {
            if let Ok(mut last_frame_guard) = GDI_LAST_FRAME.lock() {
                *last_frame_guard = Some(GdiLastFrameState {
                    x,
                    y,
                    width: clamped_w,
                    height: clamped_h,
                    sample_hash: hash,
                });
            }
            false
        } else if let Ok(mut last_frame_guard) = GDI_LAST_FRAME.lock() {
            if let Some(prev) = *last_frame_guard {
                if prev.x == x && prev.y == y && prev.width == clamped_w && prev.height == clamped_h && prev.sample_hash == hash {
                    true
                } else {
                    *last_frame_guard = Some(GdiLastFrameState {
                        x,
                        y,
                        width: clamped_w,
                        height: clamped_h,
                        sample_hash: hash,
                    });
                    false
                }
            } else {
                *last_frame_guard = Some(GdiLastFrameState {
                    x,
                    y,
                    width: clamped_w,
                    height: clamped_h,
                    sample_hash: hash,
                });
                false
            }
        } else {
            false
        };

        if is_unchanged {
            return GdiCaptureResult::Unchanged;
        }

        let mut buf_guard = match GLOBAL_PERSISTENT_BUFFER.lock() {
            Ok(b) => b,
            Err(_) => return GdiCaptureResult::Failed,
        };

        if buf_guard.len() < total_len {
            buf_guard.resize(total_len, 0);
        }

        let w_bytes = (clamped_w as u32).to_le_bytes();
        let h_bytes = (clamped_h as u32).to_le_bytes();
        let x_bytes = x.to_le_bytes();
        let y_bytes = y.to_le_bytes();
        let pad_bytes = (padding as u32).to_le_bytes();
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs_f64() * 1000.0)
            .unwrap_or(0.0);
        let ts_bytes = now_ms.to_le_bytes();
        let tex_w_bytes = tex_w.to_le_bytes();
        let tex_h_bytes = tex_h.to_le_bytes();

        buf_guard[0..4].copy_from_slice(&w_bytes);
        buf_guard[4..8].copy_from_slice(&h_bytes);
        buf_guard[8..12].copy_from_slice(&x_bytes);
        buf_guard[12..16].copy_from_slice(&y_bytes);
        buf_guard[16..20].copy_from_slice(&pad_bytes);
        buf_guard[20..28].copy_from_slice(&ts_bytes);
        buf_guard[28..30].copy_from_slice(&tex_w_bytes);
        buf_guard[30..32].copy_from_slice(&tex_h_bytes);

        let dst_stride = (tex_w as usize) * 4;
        let dst_ptr = buf_guard[32..total_len].as_mut_ptr();

        for r in 0..h {
            let src_row = src_ptr.add(r * src_stride);
            let dst_row = dst_ptr.add(r * dst_stride);
            std::ptr::copy_nonoverlapping(src_row, dst_row, dst_stride);
        }

        GdiCaptureResult::Captured(total_len)
    }
}

/**
 * Captures native desktop background pixels as raw byte vector for zero-copy streaming.
 * Returns 1-byte [0x00] signal if window is moving or background is unchanged.
 */
#[cfg(target_os = "windows")]
pub fn capture_desktop_background_bytes(x: i32, y: i32, width: i32, height: i32, force_refresh: bool) -> Vec<u8> {
    if win32_subclass::IS_WINDOW_MOVING.load(std::sync::atomic::Ordering::SeqCst) && !force_refresh {
        return vec![0x00];
    }

    if width <= 0 || height <= 0 {
        return vec![0x00];
    }

    // 1. Try DXGI hardware capture (protected by 60s cooldown latch)
    match dxgi_capture::capture_dxgi(x, y, width, height) {
        dxgi_capture::DxgiCaptureResult::Unchanged => {
            if force_refresh {
                match capture_desktop_background_gdi_native(x, y, width, height, true) {
                    GdiCaptureResult::Captured(actual_len) => {
                        if let Ok(buf) = GLOBAL_PERSISTENT_BUFFER.lock() {
                            buf[0..actual_len.min(buf.len())].to_vec()
                        } else {
                            vec![0x00]
                        }
                    }
                    _ => vec![0x00],
                }
            } else {
                vec![0x00]
            }
        }
        dxgi_capture::DxgiCaptureResult::Captured(len) => {
            if let Ok(buf) = GLOBAL_PERSISTENT_BUFFER.lock() {
                buf[0..len.min(buf.len())].to_vec()
            } else {
                vec![0x00]
            }
        }
        dxgi_capture::DxgiCaptureResult::OutOfBounds | dxgi_capture::DxgiCaptureResult::Failed => {
            // Anti-congestion valve for GDI fallback:
            // Throttle GDI polling to at most 30 FPS (~33.3ms) unless force_refresh is requested
            static LAST_GDI_POLL: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);
            if !force_refresh {
                if let Ok(mut last_poll) = LAST_GDI_POLL.lock() {
                    if let Some(t) = *last_poll {
                        if t.elapsed() < std::time::Duration::from_millis(33) {
                            return vec![0x00];
                        }
                    }
                    *last_poll = Some(std::time::Instant::now());
                }
            }

            // 2. Fallback to GDI CreateDIBSection with 0.5x downsampling and 64-bit sampling hash
            match capture_desktop_background_gdi_native(x, y, width, height, force_refresh) {
                GdiCaptureResult::Unchanged => vec![0x00],
                GdiCaptureResult::Captured(actual_len) => {
                    if let Ok(buf) = GLOBAL_PERSISTENT_BUFFER.lock() {
                        buf[0..actual_len.min(buf.len())].to_vec()
                    } else {
                        vec![0x00]
                    }
                }
                GdiCaptureResult::Failed => vec![0x00],
            }
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn capture_desktop_background_bytes(_x: i32, _y: i32, _width: i32, _height: i32, _force_refresh: bool) -> Vec<u8> {
    vec![0x00]
}

/**
 * Tauri Command: Captures native desktop background pixels within the specified physical rect.
 * Returns zero-copy binary Response for ultra-low latency without JSON serialization.
 */
#[tauri::command]
fn capture_desktop_background(x: i32, y: i32, width: i32, height: i32) -> tauri::ipc::Response {
    let bytes = capture_desktop_background_bytes(x, y, width, height, false);
    tauri::ipc::Response::new(bytes)
}

/**
 * Tauri Command: Provides high-entropy dynamic authentication token and initial physical window coordinates for internal liquid glass WebSocket streaming.
 */
#[tauri::command]
fn get_glass_ws_auth(app_handle: tauri::AppHandle) -> serde_json::Value {
    let (x, y, w, h) = if let Some(win) = app_handle.get_webview_window("main") {
        let pos = win.outer_position().unwrap_or(tauri::PhysicalPosition::new(0, 0));
        let size = win.outer_size().unwrap_or(tauri::PhysicalSize::new(300, 200));
        (pos.x, pos.y, size.width as i32, size.height as i32)
    } else {
        (0, 0, 300, 200)
    };

    serde_json::json!({
        "token": ws_server::get_glass_token(),
        "port": 27890,
        "x": x,
        "y": y,
        "w": w,
        "h": h
    })
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
 * Tauri Command: Opens or focuses the native secondary preferences window (360x480, standard window level).
 * Shows, unminimizes, sets always on top, focuses, and emits the request-settings-state event.
 */
#[tauri::command]
fn open_settings_window(app_handle: tauri::AppHandle) -> Result<(), String> {
    if let Some(existing) = app_handle.get_webview_window("settings") {
        let _ = existing.show();
        let _ = existing.unminimize();
        let _ = existing.set_always_on_top(true);
        let _ = existing.set_focus();
        let _ = app_handle.emit("request-settings-state", ());
    }
    Ok(())
}

/**
 * Trims the process working set of the host application and all child WebView2 processes.
 * Pages unreferenced physical memory out to the Windows page file, freeing RAM immediately.
 */
#[cfg(target_os = "windows")]
pub fn trim_process_working_set() {
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, GetCurrentProcessId, OpenProcess, SetProcessWorkingSetSize,
        PROCESS_QUERY_INFORMATION, PROCESS_SET_QUOTA,
    };
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32First, Process32Next, PROCESSENTRY32, TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};

    unsafe {
        // 1. Trim current host process
        SetProcessWorkingSetSize(GetCurrentProcess(), usize::MAX, usize::MAX);

        // 2. Enumerate child WebView2 processes and trim their working set
        let current_pid = GetCurrentProcessId();
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot != 0 as _ && snapshot != INVALID_HANDLE_VALUE {
            let mut entry: PROCESSENTRY32 = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32>() as u32;

            if Process32First(snapshot, &mut entry) != 0 {
                loop {
                    if entry.th32ParentProcessID == current_pid {
                        let handle = OpenProcess(
                            PROCESS_SET_QUOTA | PROCESS_QUERY_INFORMATION,
                            0,
                            entry.th32ProcessID,
                        );
                        if handle != 0 as _ {
                            SetProcessWorkingSetSize(handle, usize::MAX, usize::MAX);
                            CloseHandle(handle);
                        }
                    }
                    if Process32Next(snapshot, &mut entry) == 0 {
                        break;
                    }
                }
            }
            CloseHandle(snapshot);
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn trim_process_working_set() {}

/**
 * Tauri Command: Trims the working set of the host process and all child WebView2 processes.
 */
#[tauri::command]
fn trim_memory() {
    trim_process_working_set();
}

/**
 * Win32 Subclassing Module for Windows OS.
 * Intercepts low-level WM_SIZING, WM_ENTERSIZEMOVE, WM_EXITSIZEMOVE, and WM_GETMINMAXINFO window messages.
 * Enforces smooth real-time physical aspect ratio limits and coordinates zero-stall desktop background captures.
 */
#[cfg(target_os = "windows")]
pub mod win32_subclass {
    use super::DYNAMIC_MIN_PHYS_HEIGHT;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::OnceLock;
    use tauri::Emitter;
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
    use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        MINMAXINFO, WM_DESTROY, WM_ENTERSIZEMOVE, WM_EXITSIZEMOVE, WM_GETMINMAXINFO, WM_SIZING,
    };

    /**
     * Global atomic flag indicating whether the window is currently in an active Win32 drag or resize operation.
     * When true, GDI desktop background captures are bypassed to eliminate GDI BitBlt IPC thread stalls.
     */
    pub static IS_WINDOW_MOVING: AtomicBool = AtomicBool::new(false);
    static GLOBAL_APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

    const SUBCLASS_ID: usize = 1001;

    /**
     * Subclass Procedure Function.
     * Enforces dynamic minimum physical height with pure integer math and manages drag lifecycle events.
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
            WM_ENTERSIZEMOVE => {
                IS_WINDOW_MOVING.store(true, Ordering::SeqCst);
                if let Some(app) = GLOBAL_APP_HANDLE.get() {
                    let _ = app.emit("window-drag-started", ());
                }
            }
            WM_EXITSIZEMOVE => {
                IS_WINDOW_MOVING.store(false, Ordering::SeqCst);
                super::clear_gdi_last_frame();
                if let Some(app) = GLOBAL_APP_HANDLE.get() {
                    let _ = app.emit("window-drag-ended", ());
                }
            }
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
                    match wparam {
                        3 | 4 | 5 => {
                            rect.top = rect.bottom.saturating_sub(min_phys_height);
                        }
                        _ => {
                            rect.bottom = rect.top.saturating_add(min_phys_height);
                        }
                    }
                }
            }
            WM_GETMINMAXINFO => {
                let info = &mut *(lparam as *mut MINMAXINFO);
                let dpi = GetDpiForWindow(hwnd);
                let scale_factor: f64 = if dpi > 0 { dpi as f64 / 96.0 } else { 1.0 };

                let min_phys_width = (280.0 * scale_factor).ceil() as i32;
                let target_min = DYNAMIC_MIN_PHYS_HEIGHT.load(Ordering::SeqCst);
                let min_phys_height = if target_min > 0 {
                    target_min
                } else {
                    (86.0 * scale_factor).ceil() as i32
                };

                info.ptMinTrackSize.x = min_phys_width;
                info.ptMinTrackSize.y = min_phys_height;
                return 0;
            }
            WM_DESTROY => {
                RemoveWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID);
            }
            _ => {}
        }
        DefSubclassProc(hwnd, msg, wparam, lparam)
    }

    /** Attaches Win32 window subclassing hook to target HWND and registers global app handle for drag-ended notifications. */
    pub fn setup_win32_subclass(hwnd_val: isize, app_handle: tauri::AppHandle) {
        let _ = GLOBAL_APP_HANDLE.set(app_handle);
        unsafe {
            SetWindowSubclass(hwnd_val as HWND, Some(subclass_proc), SUBCLASS_ID, 0);
        }
    }
}

/**
 * Windows Registry Protocol Auto-Registration Function.
 * Automatically registers or updates the `ytm-lyrics://` custom URL scheme in Windows User Registry (HKCU).
 * Binds the protocol handler to the exact current executable path of this app without requiring Admin privileges (UAC).
 * Uses pure Win32 Registry API (RegCreateKeyExW / RegSetValueExW) to eliminate external process spawning and command injection vulnerabilities.
 */
#[cfg(target_os = "windows")]
fn auto_register_windows_protocol() {
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, REG_SZ,
    };
    use core::ptr::{null, null_mut};

    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_str) = exe_path.to_str() {
            let cmd_val = format!("\"{}\" \"%1\"", exe_str);

            let to_wide = |s: &str| -> Vec<u16> {
                s.encode_utf16().chain(std::iter::once(0)).collect()
            };

            unsafe {
                // 1. HKCU\Software\Classes\ytm-lyrics
                let mut hkey: HKEY = null_mut();
                let subkey = to_wide("Software\\Classes\\ytm-lyrics");
                if RegCreateKeyW(
                    HKEY_CURRENT_USER,
                    subkey.as_ptr(),
                    &mut hkey,
                ) == 0 {
                    let desc = to_wide("URL:YTM Desktop Lyrics Protocol");
                    let _ = RegSetValueExW(
                        hkey,
                        null(), // Default value
                        0,
                        REG_SZ,
                        desc.as_ptr() as *const u8,
                        (desc.len() * 2) as u32,
                    );

                    let proto_name = to_wide("URL Protocol");
                    let empty = to_wide("");
                    let _ = RegSetValueExW(
                        hkey,
                        proto_name.as_ptr(),
                        0,
                        REG_SZ,
                        empty.as_ptr() as *const u8,
                        (empty.len() * 2) as u32,
                    );

                    RegCloseKey(hkey);
                }

                // 2. HKCU\Software\Classes\ytm-lyrics\shell\open\command
                let mut hkey_cmd: HKEY = null_mut();
                let cmd_subkey = to_wide("Software\\Classes\\ytm-lyrics\\shell\\open\\command");
                if RegCreateKeyW(
                    HKEY_CURRENT_USER,
                    cmd_subkey.as_ptr(),
                    &mut hkey_cmd,
                ) == 0 {
                    let cmd_wide = to_wide(&cmd_val);
                    let _ = RegSetValueExW(
                        hkey_cmd,
                        null(), // Default value
                        0,
                        REG_SZ,
                        cmd_wide.as_ptr() as *const u8,
                        (cmd_wide.len() * 2) as u32,
                    );

                    RegCloseKey(hkey_cmd);
                }
            }
        }
    }
}

/**
 * Main Application Runner.
 * Sets up global shortcuts, system tray context menus, Tokio WebSocket task, and registers Tauri command handlers.
 */
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Safe GPU hardware acceleration flags on Windows (fallback / entrypoint safety)
    #[cfg(target_os = "windows")]
    {
        let gpu_args = "--enable-gpu-rasterization --ignore-gpu-blocklist --enable-zero-copy";
        let existing = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
        if !existing.contains("--ignore-gpu-blocklist") {
            let combined = if existing.is_empty() {
                gpu_args.to_string()
            } else {
                format!("{} {}", existing, gpu_args)
            };
            std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", combined);
        }
    }

    // Automatically register/update Windows Custom URL Scheme (ytm-lyrics://) for current executable
    #[cfg(target_os = "windows")]
    auto_register_windows_protocol();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // When user triggers ytm-lyrics:// or launches a second instance, focus existing main window
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            let app_handle = app.handle().clone();

            // Setup System Tray Icon & Context Menu (with rescue click-through toggle)
            let toggle_item = MenuItemBuilder::with_id("toggle", "顯示/隱藏歌詞 (Alt+V)").build(app)?;
            let clickthrough_item = MenuItemBuilder::with_id("clickthrough", "切換滑鼠穿透 (Alt+L)").build(app)?;
            let settings_item = MenuItemBuilder::with_id("settings", "偏好設定").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "結束程式").build(app)?;

            // Manage TrayMenuItems state for real-time i18n updates
            app.manage(TrayMenuItems {
                toggle: toggle_item.clone(),
                clickthrough: clickthrough_item.clone(),
                settings: settings_item.clone(),
                quit: quit_item.clone(),
            });

            let tray_menu = MenuBuilder::new(app)
                .items(&[&toggle_item, &clickthrough_item, &settings_item, &quit_item])
                .build()?;

            let icon = app.default_window_icon().cloned();
            let mut tray_builder = TrayIconBuilder::with_id("main-tray")
                .menu(&tray_menu)
                .show_menu_on_left_click(true);
            if let Some(ic) = icon {
                tray_builder = tray_builder.icon(ic);
            }

            let _tray = tray_builder
                .on_menu_event(|app_handle, event| {
                    match event.id().as_ref() {
                        "toggle" => {
                            let _ = app_handle.emit("toggle-lyrics-visibility", ());
                        }
                        "clickthrough" => {
                            let _ = app_handle.emit("toggle-click-through", ());
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
                    if let TrayIconEvent::DoubleClick { button: tauri::tray::MouseButton::Left, .. } = event {
                        let app_handle = tray.app_handle();
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;


            // Disable Maximizable, set initial size 295x163, position top 200px / right 100px & attach Win32 Subclass
            if let Some(window) = app.get_webview_window("main") {
                let win_clone = window.clone();
                let last_moved_time = std::sync::Arc::new(std::sync::Mutex::new(
                    std::time::Instant::now() - std::time::Duration::from_millis(100)
                ));
                let last_moved_time_clone = last_moved_time.clone();
                let last_resized_time = std::sync::Arc::new(std::sync::Mutex::new(
                    std::time::Instant::now() - std::time::Duration::from_millis(100)
                ));
                let last_resized_time_clone = last_resized_time.clone();

                window.on_window_event(move |event| {
                    match event {
                        tauri::WindowEvent::Moved(pos) => {
                            let mut last = last_moved_time_clone.lock().unwrap();
                            let now = std::time::Instant::now();
                            if now.duration_since(*last).as_millis() >= 10 {
                                *last = now;
                                let _ = win_clone.emit("desktop-window-moved", serde_json::json!({ "x": pos.x, "y": pos.y }));
                            }
                        }
                        tauri::WindowEvent::Resized(size) => {
                            let mut last = last_resized_time_clone.lock().unwrap();
                            let now = std::time::Instant::now();
                            if now.duration_since(*last).as_millis() >= 10 {
                                *last = now;
                                let _ = win_clone.emit("desktop-window-moved", serde_json::json!({ "w": size.width, "h": size.height }));
                            }
                        }
                        _ => {}
                    }
                });

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
                    win32_subclass::setup_win32_subclass(hwnd.0 as isize, app_handle.clone());
                    unsafe {
                        extern "system" {
                            fn SetWindowDisplayAffinity(hWnd: *mut std::ffi::c_void, dwAffinity: u32) -> i32;
                        }
                        // 0x00000011 = WDA_EXCLUDEFROMCAPTURE (Excludes window, album art & lyrics from BitBlt screen capture)
                        SetWindowDisplayAffinity(hwnd.0 as _, 0x00000011);
                    }
                }
            }

            // Intercept close requests on settings window to hide instead of destroy
            if let Some(settings_win) = app.get_webview_window("settings") {
                let settings_win_clone = settings_win.clone();
                settings_win.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = settings_win_clone.hide();
                        trim_process_working_set();
                    }
                });
            }

            // Spawn Tokio WebSocket Server Task
            tauri::async_runtime::spawn(async move {
                ws_server::start_ws_server(app_handle).await;
            });

            // Spawn Background Working Set Trimming Task
            tauri::async_runtime::spawn(async {
                // Initial trim 6 seconds after boot (after WebGL / WebView2 initialization)
                tokio::time::sleep(tokio::time::Duration::from_secs(6)).await;
                trim_process_working_set();
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
            update_tray_language,
            capture_desktop_background,
            get_glass_ws_auth,
            set_capture_quality,
            trim_memory
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_aabb_inside_screen() {
        // Inside screen (zero offset, dst_x = 0, dst_y = 0)
        let v_x = 0;
        let v_y = 0;
        let v_w = 1920;
        let v_h = 1080;
        let x = 200;
        let y = 200;
        let width = 300;
        let height = 150;

        let aabb = compute_gdi_capture_aabb(x, y, width, height, v_x, v_y, v_w, v_h);

        assert_eq!(aabb.dst_x, 0, "Destination x offset must be 0 when fully inside screen");
        assert_eq!(aabb.dst_y, 0, "Destination y offset must be 0 when fully inside screen");
        assert_eq!(aabb.src_x, aabb.req_x, "Source x must match requested x");
        assert_eq!(aabb.src_y, aabb.req_y, "Source y must match requested y");
        assert_eq!(aabb.copy_w, aabb.req_w, "Full requested width must be copied");
        assert_eq!(aabb.copy_h, aabb.req_h, "Full requested height must be copied");
    }

    #[test]
    fn test_aabb_left_edge() {
        // Left edge (x = 10, v_x = 0, padding = 64 -> dst_x = 54, src_x = 0)
        let v_x = 0;
        let v_y = 0;
        let v_w = 1920;
        let v_h = 1080;
        let x = 10;
        let y = 100;
        let width = 300;
        let height = 150;

        let aabb = compute_gdi_capture_aabb(x, y, width, height, v_x, v_y, v_w, v_h);

        assert_eq!(aabb.src_x, 0, "Source x must clamp to virtual screen left (0)");
        assert_eq!(aabb.dst_x, 54, "Destination x must offset by 54 pixels (padding 64 - 10)");
        assert_eq!(aabb.copy_w, 374, "Copy width must be req_w (428) - 54");
        assert_eq!(aabb.dst_x + aabb.copy_w, aabb.req_w, "dst_x + copy_w must equal req_w");
    }

    #[test]
    fn test_aabb_top_edge() {
        // Top edge (y = 10, v_y = 0, padding = 64 -> dst_y = 54, src_y = 0)
        let v_x = 0;
        let v_y = 0;
        let v_w = 1920;
        let v_h = 1080;
        let x = 100;
        let y = 10;
        let width = 300;
        let height = 150;

        let aabb = compute_gdi_capture_aabb(x, y, width, height, v_x, v_y, v_w, v_h);

        assert_eq!(aabb.src_y, 0, "Source y must clamp to virtual screen top (0)");
        assert_eq!(aabb.dst_y, 54, "Destination y must offset by 54 pixels (padding 64 - 10)");
        assert_eq!(aabb.copy_h, 224, "Copy height must be req_h (278) - 54");
        assert_eq!(aabb.dst_y + aabb.copy_h, aabb.req_h, "dst_y + copy_h must equal req_h");
    }

    #[test]
    fn test_aabb_right_edge() {
        // Right edge (x = 1880, width = 280, v_w = 1920 -> dst_x = 0, copy_w < req_w)
        let v_x = 0;
        let v_y = 0;
        let v_w = 1920;
        let v_h = 1080;
        let x = 1880;
        let y = 100;
        let width = 280;
        let height = 150;

        let aabb = compute_gdi_capture_aabb(x, y, width, height, v_x, v_y, v_w, v_h);

        assert_eq!(aabb.dst_x, 0, "Destination x must be 0 at right screen boundary");
        assert_eq!(aabb.src_x, 1816, "Source x must start at req_x (1880 - 64)");
        assert!(aabb.copy_w < aabb.req_w, "Copy width ({}) must be less than req_w ({})", aabb.copy_w, aabb.req_w);
        assert_eq!(aabb.copy_w, 104, "Copy width must be 1920 - 1816 = 104");
    }

    #[test]
    fn test_aabb_bottom_edge() {
        // Bottom edge (y = 1040, height = 200, v_h = 1080 -> dst_y = 0, copy_h < req_h)
        let v_x = 0;
        let v_y = 0;
        let v_w = 1920;
        let v_h = 1080;
        let x = 100;
        let y = 1040;
        let width = 300;
        let height = 200;

        let aabb = compute_gdi_capture_aabb(x, y, width, height, v_x, v_y, v_w, v_h);

        assert_eq!(aabb.dst_y, 0, "Destination y must be 0 at bottom screen boundary");
        assert_eq!(aabb.src_y, 976, "Source y must start at req_y (1040 - 64)");
        assert!(aabb.copy_h < aabb.req_h, "Copy height ({}) must be less than req_h ({})", aabb.copy_h, aabb.req_h);
        assert_eq!(aabb.copy_h, 104, "Copy height must be 1080 - 976 = 104");
    }

    #[test]
    fn test_aabb_multi_monitor_negative_coordinates() {
        // Multi-monitor negative coordinate (v_x = -1920, x = -1900)
        let v_x = -1920;
        let v_y = 0;
        let v_w = 3840; // Dual monitor setup [-1920, 1920]
        let v_h = 1080;
        let x = -1900;
        let y = 200;
        let width = 200;
        let height = 100;

        let aabb = compute_gdi_capture_aabb(x, y, width, height, v_x, v_y, v_w, v_h);

        assert_eq!(aabb.src_x, -1920, "Source x must clamp to virtual screen left (-1920)");
        assert_eq!(aabb.dst_x, 44, "Destination x must offset by 44 (-1920 - (-1964))");
        assert_eq!(aabb.copy_w, 284, "Copy width must be 284");
        assert_eq!(aabb.dst_x + aabb.copy_w, aabb.req_w, "dst_x + copy_w must equal req_w (328)");
    }

    #[test]
    fn test_aabb_completely_off_screen() {
        // Completely off-screen (copy_w == 0 || copy_h == 0)
        let v_x = 0;
        let v_y = 0;
        let v_w = 1920;
        let v_h = 1080;

        // Completely to the right
        let aabb_right = compute_gdi_capture_aabb(3000, 100, 200, 100, v_x, v_y, v_w, v_h);
        assert_eq!(aabb_right.copy_w, 0, "copy_w must be 0 when completely off-screen to the right");

        // Completely to the left
        let aabb_left = compute_gdi_capture_aabb(-1000, 100, 200, 100, v_x, v_y, v_w, v_h);
        assert_eq!(aabb_left.copy_w, 0, "copy_w must be 0 when completely off-screen to the left");

        // Completely below
        let aabb_below = compute_gdi_capture_aabb(100, 3000, 200, 100, v_x, v_y, v_w, v_h);
        assert_eq!(aabb_below.copy_h, 0, "copy_h must be 0 when completely off-screen below");

        // Completely above
        let aabb_above = compute_gdi_capture_aabb(100, -1000, 200, 100, v_x, v_y, v_w, v_h);
        assert_eq!(aabb_above.copy_h, 0, "copy_h must be 0 when completely off-screen above");
    }
}


