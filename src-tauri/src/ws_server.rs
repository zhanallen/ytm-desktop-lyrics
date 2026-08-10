use futures_util::{SinkExt, StreamExt};
use std::net::SocketAddr;
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, Manager};
use tokio::net::TcpListener;
use tokio::sync::broadcast;
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

    while let Ok((stream, _)) = listener.accept().await {
        let handle = app_handle.clone();
        let mut rx = tx.subscribe();

        tokio::spawn(async move {
            let callback = |req: &Request, response: Response| -> Result<Response, ErrorResponse> {
                // 1. Origin Header Validation
                if let Some(origin_val) = req.headers().get("Origin") {
                    if let Ok(origin_str) = origin_val.to_str() {
                        let is_allowed = origin_str == "https://music.youtube.com"
                            || origin_str.starts_with("chrome-extension://")
                            || origin_str.starts_with("http://127.0.0.1")
                            || origin_str.starts_with("http://localhost")
                            || origin_str.starts_with("ws://127.0.0.1")
                            || origin_str.starts_with("ws://localhost");

                        if !is_allowed {
                            eprintln!("[Rust WS Server] Rejected untrusted Origin: {}", origin_str);
                            let err_resp = Response::builder()
                                .status(StatusCode::FORBIDDEN)
                                .body(Some("Forbidden: Untrusted Origin".to_string()))
                                .unwrap();
                            return Err(err_resp);
                        }
                    }
                }

                // 2. Auth Token Validation
                let query = req.uri().query().unwrap_or("");
                let token_header = req.headers().get("X-YTM-Token").and_then(|v| v.to_str().ok()).unwrap_or("");
                let has_token = query.contains(&format!("token={}", WS_AUTH_TOKEN)) || token_header == WS_AUTH_TOKEN;

                if !has_token {
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

                loop {
                    tokio::select! {
                        Some(msg_result) = read.next() => {
                            match msg_result {
                                Ok(msg) => {
                                    if msg.is_text() || msg.is_binary() {
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
                                Err(_) => break,
                            }
                        }
                        Ok(bmsg) = rx.recv() => {
                            if write.send(tokio_tungstenite::tungstenite::Message::Text(bmsg.into())).await.is_err() {
                                break;
                            }
                        }
                    }
                }
            }
        });
    }
}
