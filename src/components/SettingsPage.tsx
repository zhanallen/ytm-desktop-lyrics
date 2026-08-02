import React, { useState, useEffect } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { RotateCcw, Clock, Keyboard, MousePointer } from 'lucide-react';

export const SettingsPage: React.FC = () => {
  const [offset, setOffset] = useState<number>(0);
  const [isClickThrough, setIsClickThrough] = useState<boolean>(false);
  const [showLyrics, setShowLyrics] = useState<boolean>(true);

  useEffect(() => {
    let unlistenSync: (() => void) | null = null;

    const setupSync = async () => {
      unlistenSync = await listen<{ offset: number; isClickThrough: boolean; showLyrics: boolean }>(
        'sync-settings-state',
        (event) => {
          if (event.payload) {
            setOffset(event.payload.offset);
            setIsClickThrough(event.payload.isClickThrough);
            setShowLyrics(event.payload.showLyrics);
          }
        }
      );
      // Ask main window for current state
      emit('request-settings-state');
    };

    setupSync();
    return () => {
      if (unlistenSync) unlistenSync();
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
              <span>歌詞時間軸微調 (Sync Offset)</span>
            </div>

            <div className="offset-display-row">
              <span className="offset-value">{formattedOffset}</span>
              <button className="control-btn offset-reset-btn" onClick={handleOffsetReset} title="重置為 0.0s">
                <RotateCcw size={11} /> 重置
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
              <span>懸浮窗狀態切換</span>
            </div>
            <div className="settings-toggle-row">
              <button
                className={`control-btn modal-toggle-btn ${isClickThrough ? 'active' : ''}`}
                onClick={handleToggleClickThrough}
              >
                <span>滑鼠點擊穿透</span>
                <span className="hotkey-badge">Alt+L</span>
              </button>

              <button
                className={`control-btn modal-toggle-btn ${showLyrics ? 'active' : 'btn-subtle-muted'}`}
                onClick={handleToggleLyrics}
              >
                <span>{showLyrics ? '歌詞顯示中' : '歌詞已隱藏'}</span>
                <span className="hotkey-badge">Alt+V</span>
              </button>
            </div>
          </div>

          {/* Section 3: Hotkeys Hint */}
          <div className="settings-section">
            <div className="settings-section-label">
              <Keyboard size={13} className="section-icon" />
              <span>全域快速鍵 (Global Hotkeys)</span>
            </div>
            <div className="hotkeys-grid">
              <div className="hotkey-item">
                <kbd>Alt + L</kbd>
                <span>切換滑鼠穿透模式</span>
              </div>
              <div className="hotkey-item">
                <kbd>Alt + V</kbd>
                <span>切換動態歌詞顯示</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
