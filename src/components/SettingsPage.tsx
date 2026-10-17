/**
 * SettingsPage Component
 * Dedicated secondary native window UI for managing lyrics sync offset, widget click-through,
 * lyrics display toggles, and language options with real-time Tauri IPC synchronization.
 */

import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { RotateCcw, Clock, Keyboard, MousePointer, Globe, Sparkles, X } from 'lucide-react';
import { LanguageMode, getTranslation } from '../i18n';

export type UITheme = 'default' | 'liquid-glass';
export type GlassQuality = 'native' | 'performance';

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

  /** Widget click-through state initialized from localStorage. */
  const [isClickThrough, setIsClickThrough] = useState<boolean>(() => {
    return localStorage.getItem('ytm_clickthrough') === 'true';
  });

  /** Widget lyrics visibility state initialized from localStorage. */
  const [showLyrics, setShowLyrics] = useState<boolean>(() => {
    const saved = localStorage.getItem('ytm_show_lyrics');
    return saved !== 'false';
  });

  /** Language mode preference initialized from localStorage with fallback to system default. */
  const [languageMode, setLanguageMode] = useState<LanguageMode>(() => {
    const saved = localStorage.getItem('ytm_lang');
    return saved === 'zh-TW' || saved === 'en' || saved === 'system' ? (saved as LanguageMode) : 'system';
  });

  /** UI Theme preference initialized from localStorage. */
  const [uiTheme, setUiTheme] = useState<UITheme>(() => {
    const saved = localStorage.getItem('ytm_ui_theme');
    return saved === 'liquid-glass' ? 'liquid-glass' : 'default';
  });

  /** Glass capture quality preference initialized from localStorage. */
  const [glassQuality, setGlassQuality] = useState<GlassQuality>(() => {
    const saved = localStorage.getItem('ytm_glass_quality');
    return saved === 'performance' ? 'performance' : 'native';
  });


  /** Resolved translation dictionary object for current language mode. */
  const t = getTranslation(languageMode);

  /** Helper for safe IPC event emission with robust exception catching */
  const safeEmit = async (event: string, payload?: unknown) => {
    try {
      await emit(event, payload);
    } catch (err) {
      console.warn(`Failed to emit ${event}:`, err);
    }
  };

  /** Handles closing the secondary native settings window safely by hiding it first */
  const handleCloseWindow = () => {
    try {
      getCurrentWindow().hide().catch((err) => {
        console.warn('Failed to hide settings window, falling back to close:', err);
        getCurrentWindow().close().catch(() => {});
      });
    } catch (err) {
      console.warn('Failed to get current window instance:', err);
    }
  };

  /** Handles closing the window on Escape key press */
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleCloseWindow();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

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
        glassQuality?: GlassQuality;
      }>('sync-settings-state', (event) => {
        if (!isMounted || !event.payload) return;
        setOffset(event.payload.offset);
        setIsClickThrough(event.payload.isClickThrough);
        setShowLyrics(event.payload.showLyrics);
        localStorage.setItem('ytm_clickthrough', String(event.payload.isClickThrough));
        localStorage.setItem('ytm_show_lyrics', String(event.payload.showLyrics));
        if (event.payload.languageMode) {
          setLanguageMode(event.payload.languageMode);
        }
        if (event.payload.uiTheme) {
          setUiTheme(event.payload.uiTheme);
        }
        if (event.payload.glassQuality) {
          setGlassQuality(event.payload.glassQuality);
        }
      });
      if (isMounted) unlistens.push(u1); else u1();

      // Request latest state snapshot from main widget window upon settings window creation
      safeEmit('request-settings-state');
    };

    setupSync();

    return () => {
      isMounted = false;
      unlistens.forEach((unlisten) => unlisten());
    };
  }, []);

  /** Emit settings-window-ready to notify host window to show smoothly */
  useEffect(() => {
    safeEmit('settings-window-ready');
  }, []);

  /** Window blur and 60-second idle memory optimization for settings window */
  useEffect(() => {
    let idleTimer: number | null = null;
    const triggerTrimAndGc = () => {
      invoke('trim_memory').catch(() => {});
      try {
        (window as any).gc?.();
      } catch {}
    };

    const resetIdleTimer = () => {
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = window.setTimeout(() => {
        triggerTrimAndGc();
        resetIdleTimer();
      }, 60000);
    };

    const handleBlur = () => {
      triggerTrimAndGc();
    };

    const handleActivity = () => {
      resetIdleTimer();
    };

    window.addEventListener('blur', handleBlur);
    window.addEventListener('mousemove', handleActivity, { passive: true });
    window.addEventListener('mousedown', handleActivity, { passive: true });
    window.addEventListener('keydown', handleActivity, { passive: true });

    resetIdleTimer();

    return () => {
      if (idleTimer !== null) clearTimeout(idleTimer);
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('mousemove', handleActivity);
      window.removeEventListener('mousedown', handleActivity);
      window.removeEventListener('keydown', handleActivity);
      triggerTrimAndGc();
    };
  }, []);

  /**
   * Handles lyric sync offset adjustments.
   * Updates local UI state instantly for 0ms latency and broadcasts change-offset-delta to main window.
   */
  const handleOffsetChange = (delta: number) => {
    const nextOffset = Math.round((offset + delta) * 10) / 10;
    setOffset(nextOffset);
    safeEmit('change-offset-delta', delta);
  };

  /** Resets lyric sync offset back to 0.0s and notifies main window. */
  const handleOffsetReset = () => {
    setOffset(0);
    safeEmit('reset-offset');
  };

  /** Toggles mouse click-through mode state and emits command to main window. */
  const handleToggleClickThrough = () => {
    const nextVal = !isClickThrough;
    setIsClickThrough(nextVal);
    localStorage.setItem('ytm_clickthrough', String(nextVal));
    safeEmit('toggle-click-through-cmd');
  };

  /** Toggles lyrics visibility state and emits command to main window. */
  const handleToggleLyrics = () => {
    const nextVal = !showLyrics;
    setShowLyrics(nextVal);
    localStorage.setItem('ytm_show_lyrics', String(nextVal));
    safeEmit('toggle-lyrics-cmd');
  };

  /** Updates language mode preference, saves to localStorage, and broadcasts to main window. */
  const handleLanguageChange = (mode: LanguageMode) => {
    setLanguageMode(mode);
    localStorage.setItem('ytm_lang', mode);
    safeEmit('change-language-cmd', mode);
  };

  /** Updates UI theme mode, saves to localStorage, and broadcasts to main window. */
  const handleUiThemeChange = (theme: UITheme) => {
    setUiTheme(theme);
    localStorage.setItem('ytm_ui_theme', theme);
    safeEmit('change-ui-theme-cmd', theme);
    if (theme === 'default') {
      invoke('trim_memory').catch(() => {});
      try {
        (window as any).gc?.();
      } catch {}
    }
  };

  /** Updates glass capture quality preference, saves to localStorage, and broadcasts to main window. */
  const handleGlassQualityChange = (quality: GlassQuality) => {
    setGlassQuality(quality);
    localStorage.setItem('ytm_glass_quality', quality);
    safeEmit('change-glass-quality-cmd', quality);
  };


  /** Formats offset number into readable string representation (e.g. +0.5s or -0.2s). */
  const numStr = Number(offset.toFixed(2)).toString();
  const formattedOffset = (offset >= 0 ? `+${numStr}` : numStr) + 's';

  return (
    <div className="settings-window-container">
      <div className="settings-modal-card">
        {/* In-App Native Header with Drag Region and Close Button */}
        <header className="settings-modal-header" data-tauri-drag-region>
          <div className="settings-header-title" data-tauri-drag-region>
            <Sparkles size={15} className="settings-header-icon" />
            <span>{t.preferencesTitle}</span>
          </div>
          <button
            className="settings-close-btn"
            onClick={handleCloseWindow}
            title={t.close}
            aria-label={t.close}
          >
            <X size={15} />
          </button>
        </header>

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

          {/* Section 3.5: Glass Background Quality
              Conditionally rendered exclusively when Liquid Glass theme is selected.
              When switching back to 'default', this sub-configuration section is unmounted from the DOM,
              while the user's glassQuality preference remains persisted in React state and localStorage. */}
          {uiTheme === 'liquid-glass' && (
            <div className="settings-subcard-reveal">
              <div className="settings-section settings-nested-section">
                <div className="settings-section-label">
                  <Sparkles size={13} className="section-icon" />
                  <span>{t.glassQualityTitle}</span>
                </div>
                <div className="settings-toggle-row">
                  <button
                    className={`control-btn modal-toggle-btn ${glassQuality === 'native' ? 'active' : ''}`}
                    onClick={() => handleGlassQualityChange('native')}
                  >
                    <span>{t.qualityNative}</span>
                  </button>
                  <button
                    className={`control-btn modal-toggle-btn ${glassQuality === 'performance' ? 'active' : ''}`}
                    onClick={() => handleGlassQualityChange('performance')}
                  >
                    <span>{t.qualityPerf}</span>
                  </button>
                </div>
              </div>
            </div>
          )}


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
