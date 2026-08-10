/**
 * Internationalization (i18n) Module
 * Handles language detection, locale mapping, and string translations for Chinese (zh-TW) and English (en).
 */

/** Supported user language modes: System Auto, Traditional Chinese, or English. */
export type LanguageMode = 'system' | 'zh-TW' | 'en';

/** Resolved active language locale used for dictionary lookups. */
export type ActiveLanguage = 'zh-TW' | 'en';

/**
 * Detects the active language based on user configuration or OS locale settings.
 * If mode is 'system', inspects navigator.language to default to 'zh-TW' for Chinese locales, or 'en' for others.
 */
export function detectLanguage(mode: LanguageMode): ActiveLanguage {
  if (mode === 'zh-TW') return 'zh-TW';
  if (mode === 'en') return 'en';

  const sysLang = (navigator.language || (navigator.languages && navigator.languages[0]) || 'zh').toLowerCase();
  return sysLang.startsWith('zh') ? 'zh-TW' : 'en';
}

/** Translation dictionary containing all localized UI text for header controls, lyrics status, and settings window. */
export const translations = {
  'zh-TW': {
    ytMusic: 'YouTube Music',
    notPlaying: '未在播放',
    prevSong: '上一首',
    play: '播放',
    pause: '暫停',
    nextSong: '下一首',
    openSettings: '開啟偏好設定選單',
    openSettingsNative: '開啟獨立偏好設定視窗',
    hideLyrics: '隱藏動態歌詞 (保留播放器與封面)',
    showLyrics: '顯示動態歌詞',
    clickThroughActive: '滑鼠穿透中 (按 Alt+L 解鎖)',
    clickThroughInactive: '開啟滑鼠穿透 (快捷鍵 Alt+L)',

    searchingLyrics: '搜尋動態歌詞中...',
    noLyricsFound: '暫無動態歌詞',
    pleasePlayYtMusic: '請在 YouTube Music 播放歌曲',

    preferencesTitle: '偏好設定',
    close: '關閉',
    syncOffsetTitle: '歌詞時間軸微調 (Sync Offset)',
    reset: '重置',
    resetToZero: '重置為 0.0s',
    widgetTogglesTitle: '懸浮窗狀態切換',
    clickThroughMode: '滑鼠點擊穿透',
    lyricsShown: '歌詞顯示中',
    lyricsHidden: '歌詞已隱藏',
    languageSettingsTitle: '語言設定 (Language)',
    systemDefault: '系統預設',
    zhTW: '繁體中文',
    enUS: 'English',
    globalHotkeysTitle: '全域快速鍵 (Global Hotkeys)',
    hotkeyClickThrough: '切換滑鼠穿透模式',
    hotkeyLyricsToggle: '切換動態歌詞顯示',
  },
  'en': {
    ytMusic: 'YouTube Music',
    notPlaying: 'Not Playing',
    prevSong: 'Previous',
    play: 'Play',
    pause: 'Pause',
    nextSong: 'Next',
    openSettings: 'Open Preferences',
    openSettingsNative: 'Open Settings Window',
    hideLyrics: 'Hide Lyrics (Keep Player & Cover)',
    showLyrics: 'Show Lyrics',
    clickThroughActive: 'Click-Through Active (Alt+L)',
    clickThroughInactive: 'Enable Click-Through (Alt+L)',

    searchingLyrics: 'Searching for synced lyrics...',
    noLyricsFound: 'No synced lyrics available',
    pleasePlayYtMusic: 'Please play music on YouTube Music',

    preferencesTitle: 'Preferences',
    close: 'Close',
    syncOffsetTitle: 'Lyric Sync Offset',
    reset: 'Reset',
    resetToZero: 'Reset to 0.0s',
    widgetTogglesTitle: 'Widget Toggles',
    clickThroughMode: 'Click-Through',
    lyricsShown: 'Lyrics Shown',
    lyricsHidden: 'Lyrics Hidden',
    languageSettingsTitle: 'Language',
    systemDefault: 'System Auto',
    zhTW: '繁體中文',
    enUS: 'English',
    globalHotkeysTitle: 'Global Hotkeys',
    hotkeyClickThrough: 'Toggle Click-Through Mode',
    hotkeyLyricsToggle: 'Toggle Lyrics Display',
  },
};

/**
 * Retrieves the translation string object matching the given language mode.
 */
export function getTranslation(langMode: LanguageMode) {
  const activeLang = detectLanguage(langMode);
  return translations[activeLang];
}
