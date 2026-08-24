use futures_util::{SinkExt, StreamExt};
use std::net::SocketAddr;
use std::sync::{Arc, OnceLock};
use tauri::{AppHandle, Emitter, Manager};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, Semaphore};
use tokio_tungstenite::accept_hdr_async;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;

static BROADCAST_TX: OnceLock<broadcast::Sender<String>> = OnceLock::new();

const WS_AUTH_TOKEN: &str = "ytm_sync_sec_8f9a2b7c4d5e";

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

            let callback = |req: &Request, response: Response| -> Result<Response, ErrorResponse> {
                // 1. Strict Origin Validation (Default Deny)
                let is_allowed_origin = match req.headers().get("Origin").and_then(|v| v.to_str().ok()) {
                    Some(origin_str) => {
                        origin_str == "https://music.youtube.com"
                            || origin_str.starts_with("chrome-extension://")
                            || origin_str == "http://127.0.0.1:14280"
                            || origin_str == "http://localhost:14280"
                            || origin_str == "http://127.0.0.1:27890"
                            || origin_str == "http://localhost:27890"
                            || origin_str == "tauri://localhost"
                    }
                    None => false, // Reject connections with missing Origin header (protects against unauthorized local scripts)
                };

                if !is_allowed_origin {
                    eprintln!("[Rust WS Server] Rejected untrusted or missing Origin");
                    let err_resp = Response::builder()
                        .status(StatusCode::FORBIDDEN)
                        .body(Some("Forbidden: Untrusted Origin".to_string()))
                        .unwrap();
                    return Err(err_resp);
                }

                // 2. Auth Token Validation (Key=Value matching or Header)
                let query = req.uri().query().unwrap_or("");
                let token_in_query = query.split('&').any(|pair| {
                    let mut parts = pair.split('=');
                    parts.next() == Some("token") && parts.next() == Some(WS_AUTH_TOKEN)
                });
                let token_in_header = req.headers().get("X-YTM-Token").and_then(|v| v.to_str().ok()) == Some(WS_AUTH_TOKEN);

                if !token_in_query && !token_in_header {
                    eprintln!("[Rust WS Server] Rejected connection: Missing or invalid Auth Token");
                    let err_resp = Response::builder()
                        .status(StatusCode::UNAUTHORIZED)
                        .body(Some("Unauthorized: Invalid Auth Token".to_string()))
                        .unwrap();
                    return Err(err_resp);
                }

                Ok(response)
            };

            if let Ok(ws_stream) = accept_hdr_async(stream, callback).await {
                let (mut write, mut read) = ws_stream.split();

                // Handshake Payload: Sends initial app version info to Chrome Extension for version checking
                let hello_info = serde_json::json!({
                    "type": "hello",
                    "version": env!("CARGO_PKG_VERSION")
                }).to_string();
                let _ = write.send(tokio_tungstenite::tungstenite::Message::Text(hello_info.into())).await;

                let mut last_msg_time = tokio::time::Instant::now() - tokio::time::Duration::from_millis(30);

                loop {
                    tokio::select! {
                        msg_result = read.next() => {
                            match msg_result {
                                Some(Ok(msg)) => {
                                    if msg.is_close() {
                                        break;
                                    }
                                    if msg.is_text() || msg.is_binary() {
                                        // Inbound message rate limiting (30ms interval between processed incoming messages)
                                        let now = tokio::time::Instant::now();
                                        if now.duration_since(last_msg_time) < tokio::time::Duration::from_millis(30) {
                                            continue;
                                        }
                                        last_msg_time = now;

                                        let text = msg.to_text().unwrap_or("");
                                        if !text.is_empty() && text.len() <= 65536 {
                                            // Focus Command Handler: Precise JSON command check to prevent song titles from triggering window focus
                                            if let Ok(val) = serde_json::from_str::<serde_json::Value>(text) {
                                                if val.get("command").and_then(|c| c.as_str()) == Some("focusWindow") {
                                                    if let Some(window) = handle.get_webview_window("main") {
                                                        let _ = window.unminimize();
                                                        let _ = window.show();
                                                        let _ = window.set_focus();
                                                    }
                                                }
                                            }
                                            // Emit progress payload exclusively to local Tauri IPC (Do NOT broadcast back out to WS clients)
                                            let _ = handle.emit("yt-music-update", text);
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
            }
        });
    }
}
