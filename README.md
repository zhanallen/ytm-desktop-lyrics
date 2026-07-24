# YTM Desktop Lyrics (YouTube Music 桌面即時歌詞同步工具)

一款專為 YouTube Music 設計的跨平台桌面透明懸浮動態歌詞小組件，基於 **Tauri v2 + React + Rust** 開發，搭配 Chrome 擴充功能實現毫秒級即時同步與控制。

---

## 🎨 核心特色

- **磨砂玻璃透明懸浮視窗**：支援 Windows 桌面置頂、高質感 Glassmorphic 介面與透明背景。
- **YouTube Music App 手機版風格歌詞**：當前演唱句 100% 精準鎖定在畫面正中央，字體放大高亮、彩色漸層與霓虹發光，搭配 60 FPS GPU 硬體加速平滑滾動。
- **大尺寸專輯封面與播放控制**：提供雙排大封面樣式，專輯圖片與 `⏮️ 上一首` `⏯️ 播放/暫停` `⏭️ 下一首` 按鈕列 1:1 精確同寬對齊。
- **視窗動態自適應縮放**：點擊眼睛圖示 (👁️) 可隨時隱藏歌詞，視窗會自動縮小為迷你播放器卡牌；視窗寬高放大時，專輯封面與歌詞字體會同步流暢放大。
- **全域滑鼠穿透與解鎖 (Alt + L)**：支援全域快捷鍵解鎖/鎖定滑鼠點擊穿透。
- **LRCLIB 動態歌詞自動搜尋**：自動去除非歌名雜訊並匹配正版同步動態歌詞，支援時間延遲微調 (⚙️)。

---

## 🚀 自主啟動與安裝步驟

這套工具由 **兩個部分** 組成：
1. **Chrome 擴充功能 (`extension/`)**：負責擷取播放進度與傳送控制指令。
2. **Tauri 桌面懸浮小組件 (`src-tauri/`)**：桌面懸浮視窗。

---

## 📌 第一步：安裝 Chrome 擴充功能 (僅需設定一次)

1. 開啟 Chrome 瀏覽器，網址列輸入 **`chrome://extensions`**。
2. 開啟右上角的 **「開發人員模式 (Developer mode)」**。
3. 點擊 **「載入未封裝項目 (Load unpacked)」**。
4. 選擇本專案下的 **`extension`** 資料夾。
5. 開啟 [YouTube Music 網頁](https://music.youtube.com) 播放歌曲，右下角顯示 **`Lyrics Sync: Connected`** 即連線成功。

---

## 📌 第二步：啟動桌面懸浮小組件

### 方式 A：開發模式啟動 (CMD / PowerShell)

```powershell
# 1. 切換至本專案資料夾
cd d:\Code\AI\yt-muisc-tool

# 2. 啟動桌面小組件
npm run tauri dev
```

---

### 方式 B：打包為一鍵執行的 EXE 檔 (最推薦)

您可以將專案編譯為獨立的 `.exe` 執行檔，未來無需開啟文字視窗，直接雙擊即可使用：

```powershell
cd d:\Code\AI\yt-muisc-tool
npm run tauri build
```
打包完成後，檔案位於：
`src-tauri\target\release\ytm-desktop-lyrics.exe`

您可以將該 `.exe` 建立捷徑至桌面或設定開機自動啟動！

---

## 🎮 操作快捷鍵與功能說明

| 按鈕 / 快捷鍵 | 功能說明 |
| :--- | :--- |
| **Alt + L** | 全域快捷鍵：開啟 / 關閉滑鼠穿透（鎖定後滑鼠不擋視線） |
| **✥ 移動圖示** | 按住拖拽移動懸浮視窗位置 |
| **⏯️ 播放 / 暫停** | 切換 YouTube Music 播放與暫停 |
| **⏮️ / ⏭️ 上下首** | 切換上一首 / 下一首歌曲 |
| **👁️ 眼睛圖示** | 隱藏 / 顯示動態歌詞（隱藏時視窗自動收合為迷你播放器） |
| **⚙️ 齒輪圖示** | 展開 / 收起歌詞時間延遲微調面板 (`-0.5s`, `+0.5s` 等) |

---

## 🛠️ 技術架構

- **Frontend**: React 18, TypeScript, Vite, Lucide Icons, CSS3 Glassmorphism
- **Desktop Runtime**: Tauri v2, Rust (Tokio WebSocket, Global Shortcut plugin)
- **Chrome Extension**: Manifest V3, WebSockets API, MediaSession API
- **Lyrics API**: LRCLIB API Client
