/**
 * DXGI Desktop Duplication Module (dxgi_capture.rs)
 * High-performance hardware desktop capture using DirectX Graphics Infrastructure (DXGI 1.2+).
 * Multi-GPU / Multi-Monitor Session Pool with dynamic spatial routing,
 * dirty-rectangle spatial filtering, 0.5x stride downsampling,
 * and zero-waiting non-blocking frame acquisition.
 */

use std::sync::Mutex;
use windows::core::Interface;
use windows::Win32::Foundation::{HMODULE, RECT};
use windows::Win32::Graphics::Direct3D::{
    D3D_DRIVER_TYPE_UNKNOWN, D3D_FEATURE_LEVEL_10_0, D3D_FEATURE_LEVEL_10_1,
    D3D_FEATURE_LEVEL_11_0,
};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, D3D11_BOX,
    D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAPPED_SUBRESOURCE,
    D3D11_MAP_READ, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIFactory1, IDXGIOutput1, IDXGIOutputDuplication,
    IDXGIResource, DXGI_ERROR_WAIT_TIMEOUT, DXGI_OUTDUPL_FRAME_INFO,
};
use crate::GLOBAL_PERSISTENT_BUFFER;

/** Result of DXGI Desktop Capture Attempt */
pub enum DxgiCaptureResult {
    /// Desktop has no updates or dirty rects do not intersect with lyrics window (0% copy overhead)
    Unchanged,
    /// Frame pixels successfully captured and written to PERSISTENT_BUFFER
    Captured(usize),
    /// Window is outside the primary DXGI Output bounds (e.g. on secondary monitor or spanning monitors).
    /// Triggers GDI fallback without destroying the D3D11 device or triggering cooldown.
    OutOfBounds,
    /// Hardware error / Access lost / Unsupported -> triggers GDI CreateDIBSection fallback
    Failed,
}

/**
 * RAII Guard ensuring ReleaseFrame() is guaranteed to execute on every exit branch,
 * preventing desktop duplication starvation or GPU frame locks.
 */
struct FrameGuard(IDXGIOutputDuplication, bool);

impl FrameGuard {
    fn new(dupl: &IDXGIOutputDuplication) -> Self {
        Self(dupl.clone(), true)
    }

    fn release(mut self) {
        if self.1 {
            unsafe {
                let _ = self.0.ReleaseFrame();
            }
            self.1 = false;
        }
    }
}

impl Drop for FrameGuard {
    fn drop(&mut self) {
        if self.1 {
            unsafe {
                let _ = self.0.ReleaseFrame();
            }
            self.1 = false;
        }
    }
}

/**
 * RAII Guard ensuring Unmap() is guaranteed to execute on every exit branch,
 * preventing staging texture locks.
 */
struct TextureMapGuard<'a> {
    context: &'a ID3D11DeviceContext,
    resource: &'a ID3D11Texture2D,
    subresource: u32,
    active: bool,
}

impl<'a> TextureMapGuard<'a> {
    fn new(context: &'a ID3D11DeviceContext, resource: &'a ID3D11Texture2D, subresource: u32) -> Self {
        Self {
            context,
            resource,
            subresource,
            active: true,
        }
    }
}

impl<'a> Drop for TextureMapGuard<'a> {
    fn drop(&mut self) {
        if self.active {
            unsafe {
                self.context.Unmap(self.resource, self.subresource);
            }
            self.active = false;
        }
    }
}

/**
 * Dedicated DXGI Desktop Duplication Session for a specific monitor output on a specific GPU adapter.
 */
#[allow(dead_code)]
pub struct DxgiOutputSession {
    pub adapter_name: String,
    pub output_name: String,
    pub desktop_rect: RECT,
    pub device: ID3D11Device,
    pub context: ID3D11DeviceContext,
    pub dupl: IDXGIOutputDuplication,
    pub staging_tex: Option<ID3D11Texture2D>,
    pub staging_w: u32,
    pub staging_h: u32,
}

impl DxgiOutputSession {
    pub fn ensure_staging_texture(
        &mut self,
        width: u32,
        height: u32,
    ) -> windows::core::Result<&ID3D11Texture2D> {
        if self.staging_tex.is_none() || self.staging_w < width || self.staging_h < height {
            let alloc_w = (((width + 63) / 64) * 64).max(self.staging_w).max(448);
            let alloc_h = (((height + 63) / 64) * 64).max(self.staging_h).max(320);

            let desc = D3D11_TEXTURE2D_DESC {
                Width: alloc_w,
                Height: alloc_h,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC {
                    Count: 1,
                    Quality: 0,
                },
                Usage: D3D11_USAGE_STAGING,
                BindFlags: 0,
                CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                MiscFlags: 0,
            };

            let mut tex = None;
            unsafe {
                self.device.CreateTexture2D(&desc, None, Some(&mut tex))?;
            }
            self.staging_tex = tex;
            self.staging_w = alloc_w;
            self.staging_h = alloc_h;
        }
        Ok(self.staging_tex.as_ref().unwrap())
    }
}

/**
 * Multi-Monitor, Multi-GPU DXGI Desktop Duplication Engine.
 * Manages an array of DxgiOutputSessions and routes captures dynamically based on window coordinates.
 */
pub struct DxgiCapture {
    sessions: Vec<DxgiOutputSession>,
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
unsafe fn downsample_row_avx2(src: *const u32, dst: *mut u32, dst_count: usize) {
    use std::arch::x86_64::*;
    let mut i = 0;
    while i + 8 <= dst_count {
        let v0 = _mm256_loadu_si256(src.add(i * 2) as *const __m256i);
        let v1 = _mm256_loadu_si256(src.add(i * 2 + 8) as *const __m256i);
        let idx = _mm256_setr_epi32(0, 2, 4, 6, 0, 2, 4, 6);
        let p0 = _mm256_permutevar8x32_epi32(v0, idx);
        let p1 = _mm256_permutevar8x32_epi32(v1, idx);
        let res = _mm256_permute2x128_si256(p0, p1, 0x20);
        _mm256_storeu_si256(dst.add(i) as *mut __m256i, res);
        i += 8;
    }
    while i < dst_count {
        *dst.add(i) = *src.add(i * 2);
        i += 1;
    }
}

impl DxgiCapture {
    pub fn new() -> windows::core::Result<Self> {
        let factory = unsafe { CreateDXGIFactory1::<IDXGIFactory1>()? };
        let mut sessions = Vec::new();

        let mut a_idx = 0;
        while let Ok(adapter) = unsafe { factory.EnumAdapters1(a_idx) } {
            let desc = unsafe { adapter.GetDesc1()? };
            let adapter_name = String::from_utf16_lossy(&desc.Description)
                .trim_matches(char::from(0))
                .to_string();

            let mut o_idx = 0;
            while let Ok(output) = unsafe { adapter.EnumOutputs(o_idx) } {
                let out_desc = unsafe { output.GetDesc()? };
                if out_desc.AttachedToDesktop.0 != 0 {
                    let output_name = String::from_utf16_lossy(&out_desc.DeviceName)
                        .trim_matches(char::from(0))
                        .to_string();

                    // Create D3D11 device specifically on this adapter for hardware output duplication
                    let mut device: Option<ID3D11Device> = None;
                    let mut context: Option<ID3D11DeviceContext> = None;
                    let mut feature_level = D3D_FEATURE_LEVEL_11_0;

                    let hr = unsafe {
                        D3D11CreateDevice(
                            &adapter,
                            D3D_DRIVER_TYPE_UNKNOWN,
                            HMODULE(core::ptr::null_mut()),
                            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                            Some(&[
                                D3D_FEATURE_LEVEL_11_0,
                                D3D_FEATURE_LEVEL_10_1,
                                D3D_FEATURE_LEVEL_10_0,
                            ]),
                            D3D11_SDK_VERSION,
                            Some(&mut device),
                            Some(&mut feature_level),
                            Some(&mut context),
                        )
                    };

                    if let (Ok(()), Some(dev), Some(ctx)) = (hr, device, context) {
                        if let Ok(output1) = output.cast::<IDXGIOutput1>() {
                            if let Ok(dupl) = unsafe { output1.DuplicateOutput(&dev) } {
                                sessions.push(DxgiOutputSession {
                                    adapter_name: adapter_name.clone(),
                                    output_name,
                                    desktop_rect: out_desc.DesktopCoordinates,
                                    device: dev,
                                    context: ctx,
                                    dupl,
                                    staging_tex: None,
                                    staging_w: 0,
                                    staging_h: 0,
                                });
                            }
                        }
                    }
                }
                o_idx += 1;
            }
            a_idx += 1;
        }

        if sessions.is_empty() {
            return Err(windows::core::Error::from_hresult(windows::core::HRESULT(-1)));
        }

        Ok(Self { sessions })
    }

    pub fn capture_frame(
        &mut self,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
    ) -> DxgiCaptureResult {
        if width <= 0 || height <= 0 {
            return DxgiCaptureResult::Failed;
        }

        let cx = x + width / 2;
        let cy = y + height / 2;

        // 1. Spatial Routing: Find output session whose desktop rect contains window center
        let session = match self.sessions.iter_mut().find(|s| {
            cx >= s.desktop_rect.left
                && cx < s.desktop_rect.right
                && cy >= s.desktop_rect.top
                && cy < s.desktop_rect.bottom
        }) {
            Some(s) => s,
            None => return DxgiCaptureResult::OutOfBounds,
        };

        let padding = 64i32;
        let win_l = x - padding;
        let win_t = y - padding;
        let win_r = x + width + padding;
        let win_b = y + height + padding;

        // 2. Multi-Monitor Bounds Check:
        // If window extends outside this monitor's bounds, delegate seamlessly to GDI
        if win_l < session.desktop_rect.left
            || win_r > session.desktop_rect.right
            || win_t < session.desktop_rect.top
            || win_b > session.desktop_rect.bottom
        {
            return DxgiCaptureResult::OutOfBounds;
        }

        // 3. Local coordinate transformation:
        // DXGI output surface is 0-indexed relative to desktop_rect.left and desktop_rect.top
        let local_l = (win_l - session.desktop_rect.left) as u32;
        let local_t = (win_t - session.desktop_rect.top) as u32;
        let local_r = (win_r - session.desktop_rect.left) as u32;
        let local_b = (win_b - session.desktop_rect.top) as u32;

        let mut frame_info = DXGI_OUTDUPL_FRAME_INFO::default();
        let mut desktop_resource: Option<IDXGIResource> = None;

        // 4. Acquire next desktop frame with non-blocking 0ms wait timeout
        let acquire_res = unsafe {
            session
                .dupl
                .AcquireNextFrame(0, &mut frame_info, &mut desktop_resource)
        };

        match acquire_res {
            Ok(()) => {}
            Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => {
                return DxgiCaptureResult::Unchanged;
            }
            Err(_) => {
                return DxgiCaptureResult::Failed;
            }
        }

        let guard = FrameGuard::new(&session.dupl);

        // 5. Query Dirty Rectangles (evaluated in output-local space)
        let mut dirty_rects_bytes: u32 = 0;
        let _ = unsafe {
            session
                .dupl
                .GetFrameDirtyRects(0, core::ptr::null_mut(), &mut dirty_rects_bytes)
        };
        let count = (dirty_rects_bytes as usize) / std::mem::size_of::<RECT>();

        if count > 0 {
            let mut dirty_rects = vec![RECT::default(); count];
            let _ = unsafe {
                session.dupl.GetFrameDirtyRects(
                    dirty_rects_bytes,
                    dirty_rects.as_mut_ptr(),
                    &mut dirty_rects_bytes,
                )
            };

            let mut intersects = false;
            for rect in &dirty_rects {
                if rect.left < local_r as i32
                    && rect.right > local_l as i32
                    && rect.top < local_b as i32
                    && rect.bottom > local_t as i32
                {
                    intersects = true;
                    break;
                }
            }

            if !intersects {
                guard.release();
                return DxgiCaptureResult::Unchanged;
            }
        } else if frame_info.LastPresentTime == 0 {
            guard.release();
            return DxgiCaptureResult::Unchanged;
        }

        // 6. Copy window subresource region
        let res = match desktop_resource {
            Some(r) => r,
            None => {
                guard.release();
                return DxgiCaptureResult::Unchanged;
            }
        };

        let desktop_tex: ID3D11Texture2D = match res.cast() {
            Ok(t) => t,
            Err(_) => {
                guard.release();
                return DxgiCaptureResult::Failed;
            }
        };

        let clamped_w = width.min(7680);
        let clamped_h = height.min(4320);
        let cap_w = (clamped_w + padding * 2) as u32;
        let cap_h = (clamped_h + padding * 2) as u32;

        if session.ensure_staging_texture(cap_w, cap_h).is_err() {
            guard.release();
            return DxgiCaptureResult::Failed;
        }

        let src_box = D3D11_BOX {
            left: local_l,
            top: local_t,
            front: 0,
            right: local_r,
            bottom: local_b,
            back: 1,
        };

        unsafe {
            session.context.CopySubresourceRegion(
                session.staging_tex.as_ref().unwrap(),
                0,
                0,
                0,
                0,
                &desktop_tex,
                0,
                Some(&src_box as *const _),
            );
        }

        // 7. Map staging texture to CPU memory and extract 0.5x stride downsampled pixels
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        let map_res = unsafe {
            session.context.Map(
                session.staging_tex.as_ref().unwrap(),
                0,
                D3D11_MAP_READ,
                0,
                Some(&mut mapped),
            )
        };

        if map_res.is_err() {
            drop(desktop_tex);
            drop(res);
            guard.release();
            return DxgiCaptureResult::Failed;
        }

        let map_guard = TextureMapGuard::new(&session.context, session.staging_tex.as_ref().unwrap(), 0);

        let is_native = crate::IS_NATIVE_CAPTURE_QUALITY.load(std::sync::atomic::Ordering::SeqCst);
        let (tex_w, tex_h, total_len) = if is_native {
            let tw = cap_w as usize;
            let th = cap_h as usize;
            (tw as u16, th as u16, 32usize + tw * th * 4)
        } else {
            let down_w = (((clamped_w + padding * 2) + 1) / 2) as usize;
            let down_h = (((clamped_h + padding * 2) + 1) / 2) as usize;
            (down_w as u16, down_h as u16, 32usize + down_w * down_h * 4)
        };

        let copy_ok = if let Ok(mut buf) = GLOBAL_PERSISTENT_BUFFER.lock() {
            if buf.len() < total_len {
                buf.resize(total_len, 0);
            }

            // 32-byte header matching frontend LiquidGlassCanvas DataView specification
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

            buf[0..4].copy_from_slice(&w_bytes);
            buf[4..8].copy_from_slice(&h_bytes);
            buf[8..12].copy_from_slice(&x_bytes);
            buf[12..16].copy_from_slice(&y_bytes);
            buf[16..20].copy_from_slice(&pad_bytes);
            buf[20..28].copy_from_slice(&ts_bytes);
            buf[28..30].copy_from_slice(&tex_w_bytes);
            buf[30..32].copy_from_slice(&tex_h_bytes);

            let src_ptr = mapped.pData as *const u8;
            let row_pitch = mapped.RowPitch as usize;

            if is_native {
                let tw = tex_w as usize;
                let th = tex_h as usize;
                if th > session.staging_h as usize || tw * 4 > row_pitch {
                    drop(map_guard);
                    guard.release();
                    return DxgiCaptureResult::Failed;
                }

                let dst_ptr = buf[32..total_len].as_mut_ptr();
                let row_bytes = tw * 4;
                unsafe {
                    for r in 0..th {
                        let src_row = src_ptr.add(r * row_pitch);
                        let dst_row = dst_ptr.add(r * row_bytes);
                        std::ptr::copy_nonoverlapping(src_row, dst_row, row_bytes);
                    }
                }
            } else {
                let down_w = tex_w as usize;
                let down_h = tex_h as usize;
                if (down_h * 2) > session.staging_h as usize || (down_w * 2) * 4 > row_pitch {
                    drop(map_guard);
                    guard.release();
                    return DxgiCaptureResult::Failed;
                }

                let dst_ptr = buf[32..total_len].as_mut_ptr() as *mut u32;

                #[cfg(target_arch = "x86_64")]
                let has_avx2 = is_x86_feature_detected!("avx2");
                #[cfg(not(target_arch = "x86_64"))]
                let has_avx2 = false;

                unsafe {
                    for r in 0..down_h {
                        let src_row = src_ptr.add(r * 2 * row_pitch) as *const u32;
                        let dst_row = dst_ptr.add(r * down_w);
                        #[cfg(target_arch = "x86_64")]
                        if has_avx2 {
                            downsample_row_avx2(src_row, dst_row, down_w);
                            continue;
                        }
                        for c in 0..down_w {
                            *dst_row.add(c) = *src_row.add(c * 2);
                        }
                    }
                }
            }
            true
        } else {
            false
        };

        drop(map_guard);
        drop(desktop_tex);
        drop(res);
        guard.release();

        if !copy_ok {
            return DxgiCaptureResult::Failed;
        }
        DxgiCaptureResult::Captured(total_len)
    }
}

static DXGI_CAPTURE: Mutex<Option<DxgiCapture>> = Mutex::new(None);
static LAST_DXGI_FAIL: Mutex<Option<std::time::Instant>> = Mutex::new(None);
const DXGI_FAIL_COOLDOWN: std::time::Duration = std::time::Duration::from_secs(2);

/**
 * Attempts DXGI Desktop Duplication capture with dynamic multi-monitor routing.
 * Automatically handles initialization, error reset, and RAII cleanup.
 * Includes a 2-second cooldown latch upon failure to prevent churn.
 */
pub fn capture_dxgi(x: i32, y: i32, width: i32, height: i32) -> DxgiCaptureResult {
    if width <= 0 || height <= 0 {
        return DxgiCaptureResult::Failed;
    }

    let mut guard = match DXGI_CAPTURE.lock() {
        Ok(g) => g,
        Err(_) => return DxgiCaptureResult::Failed,
    };

    if guard.is_none() {
        // Cooldown latch: Do not retry if failed within the last 60 seconds
        if let Ok(mut fail_guard) = LAST_DXGI_FAIL.lock() {
            if let Some(last_time) = *fail_guard {
                if last_time.elapsed() < DXGI_FAIL_COOLDOWN {
                    return DxgiCaptureResult::Failed;
                }
            }

            match DxgiCapture::new() {
                Ok(cap) => {
                    *fail_guard = None;
                    *guard = Some(cap);
                }
                Err(_) => {
                    *fail_guard = Some(std::time::Instant::now());
                    return DxgiCaptureResult::Failed;
                }
            }
        } else {
            return DxgiCaptureResult::Failed;
        }
    }

    let capture = guard.as_mut().unwrap();
    match capture.capture_frame(x, y, width, height) {
        DxgiCaptureResult::Failed => {
            *guard = None;
            if let Ok(mut fail_guard) = LAST_DXGI_FAIL.lock() {
                *fail_guard = Some(std::time::Instant::now());
            }
            DxgiCaptureResult::Failed
        }
        DxgiCaptureResult::OutOfBounds => DxgiCaptureResult::OutOfBounds,
        res => res,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_dxgi_runtime() {
        println!("\n--- Starting DXGI Multi-Output Duplication Runtime Test ---");

        // Diagnostic: Enumerate all DXGI adapters and outputs
        if let Ok(factory) = unsafe { CreateDXGIFactory1::<IDXGIFactory1>() } {
            let mut i = 0;
            while let Ok(adapter) = unsafe { factory.EnumAdapters1(i) } {
                if let Ok(desc) = unsafe { adapter.GetDesc1() } {
                    let name = String::from_utf16_lossy(&desc.Description);
                    println!("Adapter {}: {}", i, name.trim_matches(char::from(0)));

                    let mut j = 0;
                    while let Ok(output) = unsafe { adapter.EnumOutputs(j) } {
                        if let Ok(out_desc) = unsafe { output.GetDesc() } {
                            let out_name = String::from_utf16_lossy(&out_desc.DeviceName);
                            println!(
                                "  Output {}: {}, Attached: {}, Desktop: [{}, {}, {}, {}]",
                                j,
                                out_name.trim_matches(char::from(0)),
                                out_desc.AttachedToDesktop.0,
                                out_desc.DesktopCoordinates.left,
                                out_desc.DesktopCoordinates.top,
                                out_desc.DesktopCoordinates.right,
                                out_desc.DesktopCoordinates.bottom
                            );

                            let mut dev: Option<ID3D11Device> = None;
                            let mut ctx: Option<ID3D11DeviceContext> = None;
                            let mut fl = D3D_FEATURE_LEVEL_11_0;
                            let hr = unsafe {
                                D3D11CreateDevice(
                                    &adapter,
                                    D3D_DRIVER_TYPE_UNKNOWN,
                                    HMODULE(core::ptr::null_mut()),
                                    D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                                    Some(&[D3D_FEATURE_LEVEL_11_0]),
                                    D3D11_SDK_VERSION,
                                    Some(&mut dev),
                                    Some(&mut fl),
                                    Some(&mut ctx),
                                )
                            };
                            println!("    D3D11CreateDevice on adapter {}: {:?}", i, hr);
                            if let (Ok(()), Some(d)) = (hr, dev) {
                                if let Ok(output1) = output.cast::<IDXGIOutput1>() {
                                    let dup_res = unsafe { output1.DuplicateOutput(&d) };
                                    println!("    DuplicateOutput on adapter {} output {}: {:?}", i, j, dup_res.is_ok());
                                    if let Err(e) = dup_res {
                                        println!("      Error: {:?} (0x{:08X})", e, e.code().0 as u32);
                                    }
                                }
                            }
                        }
                        j += 1;
                    }
                }
                i += 1;
            }
        }

        println!("\nCalling capture_dxgi 10 times:");
        for i in 1..=10 {
            let res = capture_dxgi(100, 100, 400, 300);
            match res {
                DxgiCaptureResult::Unchanged => {
                    println!("[Iteration {:02}] Result: Unchanged (Dirty rects skipped / 0% overhead)", i);
                }
                DxgiCaptureResult::Captured(len) => {
                    println!("[Iteration {:02}] Result: Captured({} bytes)", i, len);
                }
                DxgiCaptureResult::OutOfBounds => {
                    println!("[Iteration {:02}] Result: OutOfBounds (Window outside primary monitor)", i);
                }
                DxgiCaptureResult::Failed => {
                    println!("[Iteration {:02}] Result: Failed (Hardware error or access lost)", i);
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        println!("\nTesting GDI DIBSection fallback with 64-bit sampling hash:");
        let gdi_res1 = crate::capture_desktop_background_gdi_native(100, 100, 400, 300, false);
        match gdi_res1 {
            crate::GdiCaptureResult::Captured(len) => {
                println!("  Call 1 (initial capture): Captured {} bytes", len);
                assert!(len > 0);

                let gdi_res2 = crate::capture_desktop_background_gdi_native(100, 100, 400, 300, false);
                match gdi_res2 {
                    crate::GdiCaptureResult::Unchanged => {
                        println!("  Call 2 (static screen): Unchanged (0% copy, 64-bit sampling hash matched!)");
                    }
                    crate::GdiCaptureResult::Captured(_) => {
                        println!("  Call 2: Captured (desktop content changed during test)");
                    }
                    crate::GdiCaptureResult::Failed => panic!("GDI capture failed on second call"),
                }
            }
            crate::GdiCaptureResult::Failed => {
                println!("  GDI capture unavailable in non-interactive/locked session (desktop access prohibited)");
            }
            crate::GdiCaptureResult::Unchanged => {}
        }

        println!("--- Completed DXGI Desktop Duplication Runtime Test ---\n");
    }
}
