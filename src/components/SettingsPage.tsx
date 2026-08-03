import React, { useState, useEffect } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { RotateCcw, Clock, Keyboard, MousePointer, Globe } from 'lucide-react';
import { LanguageMode, getTranslation } from '../i18n';

export const SettingsPage: React.FC = () => {
  const [offset, setOffset] = useState<number>(() => {
    const saved = localStorage.getItem('ytm_offset');
    if (saved !== null) {
      const parsed = parseFloat(saved);
      if (!isNaN(parsed)) return parsed;
    }
    return 0;
  });
  const [isClickThrough, setIsClickThrough] = useState<boolean>(false);
  const [showLyrics, setShowLyrics] = useState<boolean>(true);
  const [languageMode, setLanguageMode] = useState<LanguageMode>(() => {
    const saved = localStorage.getItem('ytm_lang');
    return saved === 'zh-TW' || saved === 'en' || saved === 'system' ? (saved as LanguageMode) : 'system';
  });

  const t = getTranslation(languageMode);

  useEffect(() => {
    let isMounted = true;
    const unlistens: (() => void)[] = [];

    const setupSync = async () => {
      const u1 = await listen<{
        offset: number;
        isClickThrough: boolean;
        showLyrics: boolean;
        languageMode?: LanguageMode;
      }>('sync-settings-state', (event) => {
        if (!isMounted || !event.payload) return;
        setOffset(event.payload.offset);
        setIsClickThrough(event.payload.isClickThrough);
        setShowLyrics(event.payload.showLyrics);
        if (event.payload.languageMode) {
          setLanguageMode(event.payload.languageMode);
        }
      });
      if (isMounted) unlistens.push(u1); else u1();

      // Ask main window for current state
      emit('request-settings-state');
    };

    setupSync();
    return () => {
      isMounted = false;
      unlistens.forEach((unlisten) => unlisten());
    };
  }, []);

  const handleOffsetChange = (delta: number) => {
    const nextOffset = Math.round((offset + delta) * 10) / 10;
    setOffset(nextOffset);
    emit('change-offset-delta', delta);
  };

  const handleOffsetReset = () => {
    setOffset(0);
    emit('reset-offset');
  };

  const handleToggleClickThrough = () => {
    setIsClickThrough(!isClickThrough);
    emit('toggle-click-through-cmd');
  };

  const handleToggleLyrics = () => {
    setShowLyrics(!showLyrics);
    emit('toggle-lyrics-cmd');
  };

  const handleLanguageChange = (mode: LanguageMode) => {
    setLanguageMode(mode);
    localStorage.setItem('ytm_lang', mode);
    emit('change-language-cmd', mode);
  };

  const numStr = Number(offset.toFixed(2)).toString();
  const formattedOffset = (offset >= 0 ? `+${numStr}` : numStr) + 's';

  return (
    <div className="settings-window-container">
      <div className="settings-modal-card">
        {/* Native OS Window Body Content */}
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

          {/* Section 3: Language Settings */}
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

          {/* Section 4: Hotkeys Hint */}
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
