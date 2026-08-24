// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "windows")]
    {
        // Safe GPU hardware acceleration flags without breaking WebView2 transparent window DirectComposition
        let gpu_args = "--enable-gpu-rasterization --ignore-gpu-blocklist --enable-zero-copy";
        let existing = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
        let combined = if existing.is_empty() {
            gpu_args.to_string()
        } else {
            format!("{} {}", existing, gpu_args)
        };
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", combined);
    }

    ytm_desktop_lyrics::run();
}
