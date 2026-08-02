use futures_util::{SinkExt, StreamExt};
use std::net::SocketAddr;
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, Manager};
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use tokio_tungstenite::accept_async;

static BROADCAST_TX: OnceLock<broadcast::Sender<String>> = OnceLock::new();

pub fn broadcast_message(msg: String) {
    if let Some(tx) = BROADCAST_TX.get() {
        let _ = tx.send(msg);
    }
}

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
        let tx_clone = tx.clone();
        let mut rx = tx.subscribe();

        tokio::spawn(async move {
            if let Ok(ws_stream) = accept_async(stream).await {
                let (mut write, mut read) = ws_stream.split();

                // Send initial app version info
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
                                        if !text.is_empty() {
                                            if text.contains("\"focusWindow\"") || text.contains("'focusWindow'") {
                                                if let Some(window) = handle.get_webview_window("main") {
                                                    let _ = window.unminimize();
                                                    let _ = window.show();
                                                    let _ = window.set_focus();
                                                }
                                            }
                                            let _ = handle.emit("yt-music-update", text);
                                            let _ = tx_clone.send(text.to_string());
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
