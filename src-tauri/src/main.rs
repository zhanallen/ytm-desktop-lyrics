// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "windows")]
    {
        // Safe GPU hardware acceleration flags
        let gpu_args = "--enable-gpu-rasterization --ignore-gpu-blocklist --enable-zero-copy";

        // Bounded V8 Heap (64MB memory limit + optimize for size + expose-gc)
        let v8_args = "--js-flags=\"--max-old-space-size=64 --optimize-for-size --expose-gc\"";

        // Bloat reduction & telemetry disabling
        let bloat_args = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,TranslateUI,OptimizationHints \
                          --disable-background-networking --disable-component-update --disable-domain-reliability --disable-component-extensions-with-background-pages \
                          --disable-gpu-shader-disk-cache --disable-gpu-program-cache";

        let new_args = format!("{gpu_args} {v8_args} {bloat_args}");
        let existing = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
        let combined = if existing.is_empty() {
            new_args
        } else {
            format!("{existing} {new_args}")
        };
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", combined);
    }

    ytm_desktop_lyrics::run();
}
