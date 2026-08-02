import React from 'react';
import { X, RotateCcw, Clock, Keyboard, MousePointer } from 'lucide-react';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  offset: number;
  onOffsetChange: (delta: number) => void;
  onOffsetReset: () => void;
  isClickThrough: boolean;
  onToggleClickThrough: () => void;
  showLyrics: boolean;
  onToggleLyrics: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  offset,
  onOffsetChange,
  onOffsetReset,
  isClickThrough,
  onToggleClickThrough,
  showLyrics,
  onToggleLyrics,
}) => {
  if (!isOpen) return null;

  const numStr = Number(offset.toFixed(2)).toString();
  const formattedOffset = (offset >= 0 ? `+${numStr}` : numStr) + 's';

  return (
    <div className="settings-modal-backdrop" onClick={onClose}>
      <div className="settings-modal-card" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="settings-modal-header">
          <span className="settings-modal-title">偏好設定</span>
          <button className="settings-close-btn" onClick={onClose} title="關閉">
            <X size={14} />
          </button>
        </div>

        {/* Body Content */}
        <div className="settings-modal-body">
          {/* Section 1: Lyric Offset Adjustment */}
          <div className="settings-section">
            <div className="settings-section-label">
              <Clock size={13} className="section-icon" />
              <span>歌詞時間軸微調 (Sync Offset)</span>
            </div>

            <div className="offset-display-row">
              <span className="offset-value">{formattedOffset}</span>
              <button className="control-btn offset-reset-btn" onClick={onOffsetReset} title="重置為 0.0s">
                <RotateCcw size={11} /> 重置
              </button>
            </div>

            <div className="offset-btn-group">
              <button className="control-btn modal-action-btn" onClick={() => onOffsetChange(-0.5)}>-0.5s</button>
              <button className="control-btn modal-action-btn" onClick={() => onOffsetChange(-0.1)}>-0.1s</button>
              <button className="control-btn modal-action-btn" onClick={() => onOffsetChange(0.1)}>+0.1s</button>
              <button className="control-btn modal-action-btn" onClick={() => onOffsetChange(0.5)}>+0.5s</button>
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
                onClick={onToggleClickThrough}
              >
                <span>滑鼠點擊穿透</span>
                <span className="hotkey-badge">Alt+L</span>
              </button>

              <button
                className={`control-btn modal-toggle-btn ${showLyrics ? 'active' : 'btn-subtle-muted'}`}
                onClick={onToggleLyrics}
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
