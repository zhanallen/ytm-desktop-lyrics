use futures_util::{SinkExt, StreamExt};
use std::net::SocketAddr;
use std::sync::{Arc, OnceLock};
use tauri::{AppHandle, Emitter, Manager};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, Semaphore};
use tokio_tungstenite::accept_hdr_async_with_config;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;

static BROADCAST_TX: OnceLock<broadcast::Sender<String>> = OnceLock::new();
static GLASS_DYNAMIC_TOKEN: OnceLock<String> = OnceLock::new();
static ACTIVE_GLASS_CONNECTION: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

const WS_AUTH_TOKEN: &str = "ytm_sync_sec_8f9a2b7c4d5e";

/// Returns dynamic high-entropy 256-bit session token generated via Windows CSPRNG on app startup for internal liquid glass channel.
pub fn get_glass_token() -> &'static str {
    GLASS_DYNAMIC_TOKEN.get_or_init(|| {
        let mut random_bytes = [0u8; 32];
        #[cfg(target_os = "windows")]
        {
            #[link(name = "bcrypt")]
            extern "system" {
                fn BCryptGenRandom(
                    hAlgorithm: *mut core::ffi::c_void,
                    pbBuffer: *mut u8,
                    cbBuffer: u32,
                    dwFlags: u32,
                ) -> i32;
            }
            const BCRYPT_USE_SYSTEM_PREFERRED_RNG: u32 = 0x00000002;
            unsafe {
                let status = BCryptGenRandom(
                    core::ptr::null_mut(),
                    random_bytes.as_mut_ptr(),
                    32,
                    BCRYPT_USE_SYSTEM_PREFERRED_RNG,
                );
                if status != 0 {
                    // Fallback in the rare event of CSPRNG failure
                    let nanos = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_nanos())
                        .unwrap_or(0);
                    return format!("glass_fallback_{:x}_{:x}", nanos, std::process::id());
                }
            }
        }

        let hex_str: String = random_bytes.iter().map(|b| format!("{:02x}", b)).collect();
        format!("glass_sec_{}", hex_str)
    })
}

/// Constant-time string equality check with compiler optimization fence (CWE-208) to prevent timing side-channel attacks.
fn constant_time_eq(a: &str, b: &str) -> bool {
    let a_bytes = a.as_bytes();
    let b_bytes = b.as_bytes();
    if a_bytes.len() != b_bytes.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&b1, &b2) in a_bytes.iter().zip(b_bytes.iter()) {
        diff |= b1 ^ b2;
    }
    core::hint::black_box(diff) == 0
}

struct GlassGuard;
impl Drop for GlassGuard {
    fn drop(&mut self) {
        ACTIVE_GLASS_CONNECTION.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Broadcasts player control payloads to connected WebSocket clients (Server -> Extension).
pub fn broadcast_message(msg: String) {
    if let Some(tx) = BROADCAST_TX.get() {
        let _ = tx.send(msg);
    }
}

/// Asynchronous Task: Starts local WebSocket server on port 27890 for bidirectional communication with the Chrome extension.
pub async fn start_ws_server(app_handle: AppHandle) {
    let addr: SocketAddr = "127.0.0.1:27890".parse().unwrap();
    let listener = match TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[Rust WS Server] Failed to bind to 127.0.0.1:27890: {}", e);
            return;
        }
    };

    println!("[Rust WS Server] Listening on ws://{}", addr);

    let (tx, _) = broadcast::channel::<String>(100);
    let _ = BROADCAST_TX.set(tx.clone());

    // Semaphore limiting concurrent WebSocket connections to a maximum of 5
    let connection_limiter = Arc::new(Semaphore::new(5));

    while let Ok((stream, _)) = listener.accept().await {
        let _ = stream.set_nodelay(true);
        let permit = match connection_limiter.clone().try_acquire_owned() {
            Ok(p) => p,
            Err(_) => {
                eprintln!("[Rust WS Server] Max concurrent connections (5) reached. Dropping new connection.");
                continue;
            }
        };

        let handle = app_handle.clone();
        let mut rx = tx.subscribe();

        tokio::spawn(async move {
            let _permit = permit;

            let is_glass = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let is_glass_cb = is_glass.clone();

            let callback = move |req: &Request, response: Response| -> Result<Response, ErrorResponse> {
                let origin = match req.headers().get("Origin").and_then(|v| v.to_str().ok()) {
                    Some(o) => o,
                    None => {
                        eprintln!("[Rust WS Server] Rejected connection: Missing Origin header");
                        let err_resp = Response::builder()
                            .status(StatusCode::FORBIDDEN)
                            .body(Some("Forbidden: Missing Origin".to_string()))
                            .unwrap();
                        return Err(err_resp);
                    }
                };

                let query = req.uri().query().unwrap_or("");
                let is_glass_role = query.split('&').any(|pair| pair == "role=glass");

                let extracted_token = query.split('&').find_map(|pair| {
                    let mut parts = pair.split('=');
                    if parts.next() == Some("token") {
                        parts.next()
                    } else {
                        None
                    }
                }).or_else(|| {
                    req.headers().get("X-YTM-Token").and_then(|v| v.to_str().ok())
                });

                let token = match extracted_token {
                    Some(t) => t,
                    None => {
                        eprintln!("[Rust WS Server] Rejected connection: Missing Auth Token");
                        let err_resp = Response::builder()
                            .status(StatusCode::UNAUTHORIZED)
                            .body(Some("Unauthorized: Missing Auth Token".to_string()))
                            .unwrap();
                        return Err(err_resp);
                    }
                };

                if is_glass_role {
                    // 1. Role-Origin Mutual Binding for Liquid Glass (strictly internal Tauri origins)
                    let is_valid_glass_origin = origin == "tauri://localhost"
                        || origin == "http://tauri.localhost"
                        || origin == "http://127.0.0.1:1420"
                        || origin == "http://localhost:1420"
                        || origin == "http://127.0.0.1:14280"
                        || origin == "http://localhost:14280";

                    if !is_valid_glass_origin {
                        eprintln!("[Rust WS Server] Rejected glass connection from untrusted origin: {}", origin);
                        let err_resp = Response::builder()
                            .status(StatusCode::FORBIDDEN)
                            .body(Some("Forbidden: Untrusted Glass Origin".to_string()))
                            .unwrap();
                        return Err(err_resp);
                    }

                    // 2. Constant-time token verification for dynamic glass token
                    if !constant_time_eq(token, get_glass_token()) {
                        eprintln!("[Rust WS Server] Rejected glass connection: Invalid Dynamic Token");
                        let err_resp = Response::builder()
                            .status(StatusCode::UNAUTHORIZED)
                            .body(Some("Unauthorized: Invalid Glass Token".to_string()))
                            .unwrap();
                        return Err(err_resp);
                    }

                    // 3. Limit to max 1 concurrent glass connection
                    if ACTIVE_GLASS_CONNECTION.compare_exchange(
                        false,
                        true,
                        std::sync::atomic::Ordering::SeqCst,
                        std::sync::atomic::Ordering::SeqCst,
                    ).is_err() {
                        eprintln!("[Rust WS Server] Rejected: Glass connection already active");
                        let err_resp = Response::builder()
                            .status(StatusCode::TOO_MANY_REQUESTS)
                            .body(Some("Too Many Requests: Glass already connected".to_string()))
                            .unwrap();
                        return Err(err_resp);
                    }

                    is_glass_cb.store(true, std::sync::atomic::Ordering::SeqCst);
                } else {
                    // General Chrome Extension Client (strictly YouTube Music)
                    let is_valid_extension_origin = origin == "https://music.youtube.com";

                    if !is_valid_extension_origin {
                        eprintln!("[Rust WS Server] Rejected general client from untrusted origin: {}", origin);
                        let err_resp = Response::builder()
                            .status(StatusCode::FORBIDDEN)
                            .body(Some("Forbidden: Untrusted Client Origin".to_string()))
                            .unwrap();
                        return Err(err_resp);
                    }

                    if !constant_time_eq(token, WS_AUTH_TOKEN) {
                        eprintln!("[Rust WS Server] Rejected general client: Invalid Auth Token");
                        let err_resp = Response::builder()
                            .status(StatusCode::UNAUTHORIZED)
                            .body(Some("Unauthorized: Invalid Client Token".to_string()))
                            .unwrap();
                        return Err(err_resp);
                    }
                }

                Ok(response)
            };

            let ws_config = WebSocketConfig {
                max_message_size: Some(1024 * 1024),
                max_frame_size: Some(1024 * 1024),
                ..Default::default()
            };

            let accept_res = tokio::time::timeout(
                tokio::time::Duration::from_secs(3),
                accept_hdr_async_with_config(stream, callback, Some(ws_config)),
            ).await;

            if let Ok(Ok(ws_stream)) = accept_res {
                let _glass_guard = if is_glass.load(std::sync::atomic::Ordering::SeqCst) {
                    Some(GlassGuard)
                } else {
                    None
                };

                let (mut write, mut read) = ws_stream.split();

                // Dedicated LiquidGlass binary streaming channel with proactive DWM Push stream:
                if is_glass.load(std::sync::atomic::Ordering::SeqCst) {
                    #[derive(Clone, Copy, Default)]
                    struct WatchRect {
                        x: i32,
                        y: i32,
                        w: i32,
                        h: i32,
                        active: bool,
                        force_refresh: bool,
                        last_sent_x: i32,
                        last_sent_y: i32,
                    }

                    let watch_rect = std::sync::Arc::new(std::sync::Mutex::new(WatchRect::default()));
                    let watch_rect_push = watch_rect.clone();

                    let (push_tx, mut push_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(2);
                    let cancel_flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
                    let cancel_push = cancel_flag.clone();

                    std::thread::spawn(move || {
                        let mut static_count: u32 = 0;
                        while !cancel_push.load(std::sync::atomic::Ordering::Relaxed) {
                            let (rect, is_force) = {
                                if let Ok(guard) = watch_rect_push.lock() {
                                    (*guard, guard.force_refresh)
                                } else {
                                    (WatchRect::default(), false)
                                }
                            };
                            if !rect.active || rect.w <= 0 || rect.h <= 0 {
                                std::thread::sleep(std::time::Duration::from_millis(20));
                                continue;
                            }

                            if is_force {
                                crate::clear_gdi_last_frame();
                            }

                            let bytes = crate::capture_desktop_background_bytes(rect.x, rect.y, rect.w, rect.h, is_force);
                            if bytes.len() > 32 {
                                static_count = 0;
                                let _ = push_tx.try_send(bytes);
                                if let Ok(mut g) = watch_rect_push.lock() {
                                    g.last_sent_x = rect.x;
                                    g.last_sent_y = rect.y;
                                    g.force_refresh = false;
                                }
                                // Dynamic active screen: paced at ~35.7 FPS (28ms) to cut ArrayBuffer allocation rate by 75%
                                std::thread::sleep(std::time::Duration::from_millis(28));
                            } else {
                                static_count = static_count.saturating_add(1);
                                if static_count > 20 {
                                    // Deep idle (>0.5s static): 10 FPS (100ms)
                                    std::thread::sleep(std::time::Duration::from_millis(100));
                                } else if static_count > 5 {
                                    // Short static: 30 FPS (33ms)
                                    std::thread::sleep(std::time::Duration::from_millis(33));
                                } else {
                                    // Initial static: 60 FPS (16ms)
                                    std::thread::sleep(std::time::Duration::from_millis(16));
                                }
                            }
                        }
                    });

                    loop {
                        tokio::select! {
                            msg_opt = read.next() => {
                                match msg_opt {
                                    Some(Ok(msg)) => {
                                        if msg.is_close() {
                                            break;
                                        }
                                        if let tokio_tungstenite::tungstenite::Message::Binary(data) = msg {
                                            // 17-byte binary watch command: [0x01, x (i32), y (i32), w (i32), h (i32)]
                                            if data.len() == 17 && data[0] == 0x01 {
                                                let x = i32::from_le_bytes(data[1..5].try_into().unwrap_or_default());
                                                let y = i32::from_le_bytes(data[5..9].try_into().unwrap_or_default());
                                                let w = i32::from_le_bytes(data[9..13].try_into().unwrap_or_default());
                                                let h = i32::from_le_bytes(data[13..17].try_into().unwrap_or_default());
                                                if let Ok(mut g) = watch_rect.lock() {
                                                    let changed = x != g.last_sent_x || y != g.last_sent_y;
                                                    *g = WatchRect {
                                                        x,
                                                        y,
                                                        w,
                                                        h,
                                                        active: true,
                                                        force_refresh: g.force_refresh || changed,
                                                        last_sent_x: g.last_sent_x,
                                                        last_sent_y: g.last_sent_y,
                                                    };
                                                }
                                            }
                                        } else if let Ok(text) = msg.to_text() {
                                            if let Ok(val) = serde_json::from_str::<serde_json::Value>(text) {
                                                if val.get("cmd").and_then(|c| c.as_str()) == Some("watch") {
                                                    let x = val.get("x").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
                                                    let y = val.get("y").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
                                                    let w = val.get("w").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
                                                    let h = val.get("h").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
                                                    if let Ok(mut g) = watch_rect.lock() {
                                                        let changed = x != g.last_sent_x || y != g.last_sent_y;
                                                        *g = WatchRect {
                                                            x,
                                                            y,
                                                            w,
                                                            h,
                                                            active: true,
                                                            force_refresh: g.force_refresh || changed,
                                                            last_sent_x: g.last_sent_x,
                                                            last_sent_y: g.last_sent_y,
                                                        };
                                                    }
                                                } else if val.get("cmd").and_then(|c| c.as_str()) == Some("cap") {
                                                    let x = val.get("x").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
                                                    let y = val.get("y").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
                                                    let w = val.get("w").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
                                                    let h = val.get("h").and_then(|v| v.as_i64()).unwrap_or(0) as i32;

                                                    let bytes = crate::capture_desktop_background_bytes(x, y, w, h, true);
                                                    if write.send(tokio_tungstenite::tungstenite::Message::Binary(bytes.into())).await.is_err() {
                                                        break;
                                                    }
                                                }
                                            }
                                        }
                                    }
                                    _ => break,
                                }
                            }
                            frame_opt = push_rx.recv() => {
                                match frame_opt {
                                    Some(frame) => {
                                        if write.send(tokio_tungstenite::tungstenite::Message::Binary(frame.into())).await.is_err() {
                                            break;
                                        }
                                    }
                                    None => break,
                                }
                            }
                        }
                    }

                    cancel_flag.store(true, std::sync::atomic::Ordering::Relaxed);
                    return;
                }

                // Handshake Payload: Sends initial app version info to Chrome Extension for version checking
                let hello_info = serde_json::json!({
                    "type": "hello",
                    "version": env!("CARGO_PKG_VERSION")
                }).to_string();
                let _ = write.send(tokio_tungstenite::tungstenite::Message::Text(hello_info.into())).await;

                let mut last_msg_time = tokio::time::Instant::now() - tokio::time::Duration::from_millis(250);
                let mut pending_update: Option<String> = None;
                let mut last_title: Option<String> = None;
                let trailing_sleep = tokio::time::sleep(tokio::time::Duration::from_millis(250));
                tokio::pin!(trailing_sleep);

                loop {
                    tokio::select! {
                        _ = &mut trailing_sleep, if pending_update.is_some() => {
                            if let Some(payload) = pending_update.take() {
                                last_msg_time = tokio::time::Instant::now();
                                let _ = handle.emit("yt-music-update", payload);
                            }
                        }
                        msg_result = read.next() => {
                            match msg_result {
                                Some(Ok(msg)) => {
                                    if msg.is_close() {
                                        break;
                                    }
                                    if msg.is_text() || msg.is_binary() {
                                        let text = msg.to_text().unwrap_or("");
                                        if !text.is_empty() && text.len() <= 65536 {
                                            if let Ok(val) = serde_json::from_str::<serde_json::Value>(text) {
                                                // Track 1: Command (e.g. focusWindow) - immediately allow and emit
                                                if let Some(cmd) = val.get("command").and_then(|c| c.as_str()) {
                                                    if cmd == "focusWindow" {
                                                        if let Some(window) = handle.get_webview_window("main") {
                                                            let _ = window.unminimize();
                                                            let _ = window.show();
                                                            let _ = window.set_focus();
                                                        }
                                                    }
                                                    let _ = handle.emit("yt-music-update", text);
                                                    continue;
                                                }

                                                // Track 2: Song switch (title change) - immediately clear pending_update and reset timer
                                                let current_title = val.get("title").and_then(|t| t.as_str()).map(|s| s.to_string());
                                                if current_title.is_some() && current_title != last_title {
                                                    last_title = current_title;
                                                    pending_update = None;
                                                    last_msg_time = tokio::time::Instant::now();
                                                    let _ = handle.emit("yt-music-update", text);
                                                    continue;
                                                }
                                            }

                                            // Progress update rate limiting (250ms interval) with Trailing-Edge Throttle
                                            let now = tokio::time::Instant::now();
                                            if now.duration_since(last_msg_time) >= tokio::time::Duration::from_millis(250) {
                                                last_msg_time = now;
                                                pending_update = None;
                                                let _ = handle.emit("yt-music-update", text);
                                            } else {
                                                pending_update = Some(text.to_string());
                                                trailing_sleep.as_mut().reset(last_msg_time + tokio::time::Duration::from_millis(250));
                                            }
                                        }
                                    }
                                }
                                Some(Err(_)) | None => {
                                    // Cleanly exit task loop on socket termination or error
                                    break;
                                }
                            }
                        }
                        recv_res = rx.recv() => {
                            match recv_res {
                                Ok(bmsg) => {
                                    if write.send(tokio_tungstenite::tungstenite::Message::Text(bmsg.into())).await.is_err() {
                                        break;
                                    }
                                }
                                Err(broadcast::error::RecvError::Lagged(_)) => {
                                    continue;
                                }
                                Err(broadcast::error::RecvError::Closed) => {
                                    break;
                                }
                            }
                        }
                    }
                }
            } else if is_glass.load(std::sync::atomic::Ordering::SeqCst) {
                ACTIVE_GLASS_CONNECTION.store(false, std::sync::atomic::Ordering::SeqCst);
            }
        });
    }
}
