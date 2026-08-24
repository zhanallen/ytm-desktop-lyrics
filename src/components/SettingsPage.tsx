/**
 * SettingsPage Component
 * Dedicated secondary native window UI for managing lyrics sync offset, widget click-through,
 * lyrics display toggles, and language options with real-time Tauri IPC synchronization.
 */

import React, { useState, useEffect } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { RotateCcw, Clock, Keyboard, MousePointer, Globe, Sparkles } from 'lucide-react';
import { LanguageMode, getTranslation } from '../i18n';

export type UITheme = 'default' | 'liquid-glass';

export const SettingsPage: React.FC = () => {
  /** Local offset state initialized from localStorage with fallback to 0. */
  const [offset, setOffset] = useState<number>(() => {
    const saved = localStorage.getItem('ytm_offset');
    if (saved !== null) {
      const parsed = parseFloat(saved);
      if (!isNaN(parsed)) return parsed;
    }
    return 0;
  });

  /** Widget click-through state. */
  const [isClickThrough, setIsClickThrough] = useState<boolean>(false);

  /** Widget lyrics visibility state. */
  const [showLyrics, setShowLyrics] = useState<boolean>(true);

  /** Language mode preference initialized from localStorage with fallback to system default. */
  const [languageMode, setLanguageMode] = useState<LanguageMode>(() => {
    const saved = localStorage.getItem('ytm_lang');
    return saved === 'zh-TW' || saved === 'en' || saved === 'system' ? (saved as LanguageMode) : 'system';
  });

  /** UI Theme preference initialized from localStorage. */
  const [uiTheme, setUiTheme] = useState<UITheme>(() => {
    const saved = localStorage.getItem('ytm_ui_theme');
    return saved === 'default' ? 'default' : 'liquid-glass';
  });

  /** Resolved translation dictionary object for current language mode. */
  const t = getTranslation(languageMode);

  /**
   * Effect hook to subscribe to state synchronization events from the main widget application window.
   * Includes strict isMounted checks and cleanup array to prevent duplicate event listener memory leaks.
   */
  useEffect(() => {
    let isMounted = true;
    const unlistens: (() => void)[] = [];

    const setupSync = async () => {
      const u1 = await listen<{
        offset: number;
        isClickThrough: boolean;
        showLyrics: boolean;
        languageMode?: LanguageMode;
        uiTheme?: UITheme;
      }>('sync-settings-state', (event) => {
        if (!isMounted || !event.payload) return;
        setOffset(event.payload.offset);
        setIsClickThrough(event.payload.isClickThrough);
        setShowLyrics(event.payload.showLyrics);
        if (event.payload.languageMode) {
          setLanguageMode(event.payload.languageMode);
        }
        if (event.payload.uiTheme) {
          setUiTheme(event.payload.uiTheme);
        }
      });
      if (isMounted) unlistens.push(u1); else u1();

      // Request latest state snapshot from main widget window upon settings window creation
      emit('request-settings-state');
    };

    setupSync();

    return () => {
      isMounted = false;
      unlistens.forEach((unlisten) => unlisten());
    };
  }, []);

  /**
   * Handles lyric sync offset adjustments.
   * Updates local UI state instantly for 0ms latency and broadcasts change-offset-delta to main window.
   */
  const handleOffsetChange = (delta: number) => {
    const nextOffset = Math.round((offset + delta) * 10) / 10;
    setOffset(nextOffset);
    emit('change-offset-delta', delta);
  };

  /** Resets lyric sync offset back to 0.0s and notifies main window. */
  const handleOffsetReset = () => {
    setOffset(0);
    emit('reset-offset');
  };

  /** Toggles mouse click-through mode state and emits command to main window. */
  const handleToggleClickThrough = () => {
    setIsClickThrough(!isClickThrough);
    emit('toggle-click-through-cmd');
  };

  /** Toggles lyrics visibility state and emits command to main window. */
  const handleToggleLyrics = () => {
    setShowLyrics(!showLyrics);
    emit('toggle-lyrics-cmd');
  };

  /** Updates language mode preference, saves to localStorage, and broadcasts to main window. */
  const handleLanguageChange = (mode: LanguageMode) => {
    setLanguageMode(mode);
    localStorage.setItem('ytm_lang', mode);
    emit('change-language-cmd', mode);
  };

  /** Updates UI theme mode, saves to localStorage, and broadcasts to main window. */
  const handleUiThemeChange = (theme: UITheme) => {
    setUiTheme(theme);
    localStorage.setItem('ytm_ui_theme', theme);
    emit('change-ui-theme-cmd', theme);
  };

  /** Formats offset number into readable string representation (e.g. +0.5s or -0.2s). */
  const numStr = Number(offset.toFixed(2)).toString();
  const formattedOffset = (offset >= 0 ? `+${numStr}` : numStr) + 's';

  return (
    <div className="settings-window-container">
      <div className="settings-modal-card">
        {/* Native OS Window Body Content with Custom Scrollbar */}
        <div className="settings-modal-body">
          {/* Section 1: Lyric Offset Adjustment */}
          <div className="settings-section">
            <div className="settings-section-label">
              <Clock size={13} className="section-icon" />
              <span>{t.syncOffsetTitle}</span>
            </div>

            <div className="offset-display-row">
              <span className="offset-value">{formattedOffset}</span>
              <button className="control-btn offset-reset-btn" onClick={handleOffsetReset} title={t.resetToZero}>
                <RotateCcw size={11} /> {t.reset}
              </button>
            </div>

            <div className="offset-btn-group">
              <button className="control-btn modal-action-btn" onClick={() => handleOffsetChange(-0.5)}>-0.5s</button>
              <button className="control-btn modal-action-btn" onClick={() => handleOffsetChange(-0.1)}>-0.1s</button>
              <button className="control-btn modal-action-btn" onClick={() => handleOffsetChange(0.1)}>+0.1s</button>
              <button className="control-btn modal-action-btn" onClick={() => handleOffsetChange(0.5)}>+0.5s</button>
            </div>
          </div>

          {/* Section 2: Quick Toggles */}
          <div className="settings-section">
            <div className="settings-section-label">
              <MousePointer size={13} className="section-icon" />
              <span>{t.widgetTogglesTitle}</span>
            </div>
            <div className="settings-toggle-row">
              <button
                className={`control-btn modal-toggle-btn ${isClickThrough ? 'active' : ''}`}
                onClick={handleToggleClickThrough}
              >
                <span>{t.clickThroughMode}</span>
                <span className="hotkey-badge">Alt+L</span>
              </button>

              <button
                className={`control-btn modal-toggle-btn ${showLyrics ? 'active' : 'btn-subtle-muted'}`}
                onClick={handleToggleLyrics}
              >
                <span>{showLyrics ? t.lyricsShown : t.lyricsHidden}</span>
                <span className="hotkey-badge">Alt+V</span>
              </button>
            </div>
          </div>

          {/* Section 3: UI Theme / Style */}
          <div className="settings-section">
            <div className="settings-section-label">
              <Sparkles size={13} className="section-icon" />
              <span>{t.uiStyleTitle}</span>
            </div>
            <div className="settings-toggle-row">
              <button
                className={`control-btn modal-toggle-btn ${uiTheme === 'default' ? 'active' : ''}`}
                onClick={() => handleUiThemeChange('default')}
              >
                <span>{t.uiStyleDefault}</span>
              </button>

              <button
                className={`control-btn modal-toggle-btn ${uiTheme === 'liquid-glass' ? 'active' : ''}`}
                onClick={() => handleUiThemeChange('liquid-glass')}
              >
                <span>{t.uiStyleGlass}</span>
              </button>
            </div>
          </div>

          {/* Section 4: Language Settings */}
          <div className="settings-section">
            <div className="settings-section-label">
              <Globe size={13} className="section-icon" />
              <span>{t.languageSettingsTitle}</span>
            </div>
            <div className="settings-toggle-row">
              <button
                className={`control-btn modal-toggle-btn ${languageMode === 'system' ? 'active' : ''}`}
                onClick={() => handleLanguageChange('system')}
              >
                <span>{t.systemDefault}</span>
              </button>

              <button
                className={`control-btn modal-toggle-btn ${languageMode === 'zh-TW' ? 'active' : ''}`}
                onClick={() => handleLanguageChange('zh-TW')}
              >
                <span>{t.zhTW}</span>
              </button>

              <button
                className={`control-btn modal-toggle-btn ${languageMode === 'en' ? 'active' : ''}`}
                onClick={() => handleLanguageChange('en')}
              >
                <span>{t.enUS}</span>
              </button>
            </div>
          </div>

          {/* Section 5: Hotkeys Hint */}
          <div className="settings-section">
            <div className="settings-section-label">
              <Keyboard size={13} className="section-icon" />
              <span>{t.globalHotkeysTitle}</span>
            </div>
            <div className="hotkeys-grid">
              <div className="hotkey-item">
                <kbd>Alt + L</kbd>
                <span>{t.hotkeyClickThrough}</span>
              </div>
              <div className="hotkey-item">
                <kbd>Alt + V</kbd>
                <span>{t.hotkeyLyricsToggle}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
