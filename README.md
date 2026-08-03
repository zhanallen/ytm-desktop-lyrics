# YTM Desktop Lyrics (YouTube Music 桌面即時歌詞同步工具)

一款專為 YouTube Music 設計的高質感桌面透明懸浮動態歌詞小組件。開啟 YouTube Music 網頁版播放音樂時，桌面小組件即會自動同步歌曲資訊、動態歌詞與專輯封面，並支援桌面端控制播放。

---

## ✨ 核心特色

- **磨砂玻璃透明懸浮視窗**：支援桌面置頂、高質感 Glassmorphic 介面與透明背景。
- **手機版動態歌詞體驗**：演唱句精準鎖定畫面正中央，具備彩虹發光高亮與 60 FPS GPU 流暢滾動。
- **專輯封面與雙向控制**：大尺寸專輯封面與 `⏮️ 上一首` `⏯️ 播放/暫停` `⏭️ 下一首` 即時操控。
- **全域滑鼠穿透 (Alt + L)**：支援快捷鍵切換鎖定，鎖定後滑鼠可直接穿透視窗，不影響日常電腦操作，且視窗會自動半透明化。
- **動態歌詞微調**：自動搜尋 LRCLIB 動態歌詞，並提供 `±0.1s` / `±0.5s` 時間延遲面板 (⚙️)。

---

## 💻 普通使用者快速安裝指南

本工具由 **桌面懸浮軟體** 與 **Chrome 擴充功能** 兩部分組成：

### 📌 步驟 1：下載並安裝桌面軟體
1. 前往右側 [Releases 最新發布頁面](https://github.com/zhanallen/ytm-desktop-lyrics/releases) 下載最新的 `ytm-desktop-lyrics_x.x.x_x64-setup.exe`。
2. 雙擊執行安裝檔完成安裝，啟動 **YTM Desktop Lyrics** 桌面應用程式。

### 📌 步驟 2：安裝 Chrome 擴充功能 (僅需設定一次)
1. 前往 Chrome 線上應用程式商店：👉 **[YTM Desktop Lyrics Sync (Chrome Web Store)](https://chromewebstore.google.com/detail/ytm-desktop-lyrics-sync/cgdbhodcjhibmnnfbegkklaphnmpkelo)**
2. 點擊右上角 **「加到 Chrome (Add to Chrome)」** 完成安裝。
3. 開啟 [YouTube Music 網頁](https://music.youtube.com) 播放歌曲，右上角帳戶頭像旁顯示 **`已連線到桌面軟體`** 即連線成功！

*(備註：如需離線安裝，也可從本專案源碼或 Releases 下載擴充功能資料夾解壓，至 `chrome://extensions` 開啟開發人員模式選擇「載入未封裝項目」)*

---

## 🎮 桌面操作說明

| 按鈕 / 快捷鍵 | 功能說明 |
| :--- | :--- |
| **Alt + L** | 全域快捷鍵：開啟 / 關閉滑鼠穿透（鎖定後視窗半透明，且滑鼠不會擋住下方畫面） |
| **✥ 移動區域** | 按住標頭空白處或封面拖拽移動懸浮視窗位置 |
| **⏯️ 播放 / 暫停** | 切換 YouTube Music 播放與暫停 |
| **⏮️ / ⏭️ 上下首** | 切換上一首 / 下一首歌曲 |
| **👁️ 眼睛圖示** | 隱藏 / 顯示動態歌詞（隱藏時視窗自動收合為迷你播放器） |
| **⚙️ 齒輪圖示** | 展開 / 收起歌詞時間延遲微調面板 (`-0.5s`, `+0.5s` 等) |

---

## 🛠️ 開發者自行編譯 (Developer Build Guide)

如果您希望從原始碼自行編譯打包：

```powershell
# 1. 克隆專案
git clone https://github.com/zhanallen/ytm-desktop-lyrics.git
cd ytm-desktop-lyrics

# 2. 安裝依賴
npm install

# 3. 開發模式啟動
npm run tauri dev

# 4. 打包可執行檔 (.exe)
npm run tauri build
```

---

## 🔒 隱私權政策 (Privacy Policy)

### Data Collection & Usage Disclosure
YTM Desktop Lyrics Sync does NOT collect, store, share, or transmit any user personal data, browsing history, credentials, or cookies. 

### Functionality & Local Processing
To enable real-time lyric synchronization and desktop widget playback controls:
- The Chrome extension reads non-personal playback metadata (song title, artist, album cover URL, current time, and pause state) strictly on `music.youtube.com`.
- All playback data is transmitted exclusively via a local WebSocket connection (`ws://127.0.0.1:27890`) directly to your own local desktop application on the same machine.
- No data is ever sent to or processed by any external cloud servers or third parties.

---

## ☕ 贊助與支持 (Support)

如果您覺得這個工具對您有所幫助，歡迎請我喝杯咖啡支持持續維護與開發！

[![Ko-Fi](https://img.shields.io/badge/Ko--fi-F16061?style=for-the-badge&logo=ko-fi&logoColor=white)](https://ko-fi.com/zhanallen)

