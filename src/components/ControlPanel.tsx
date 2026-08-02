import React from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Unlock, Eye, EyeOff, Settings, Play, Pause, SkipBack, SkipForward, Music } from 'lucide-react';

interface ControlPanelProps {
  title: string;
  artist: string;
  albumArt?: string;
  isPaused: boolean;
  offset: number;
  onOffsetChange: (delta: number) => void;
  onOffsetReset: () => void;
  isClickThrough: boolean;
  onToggleClickThrough: () => void;
  showLyrics: boolean;
  onToggleLyrics: () => void;
  onOpenSettingsWindow: () => void;
  onPlayPause: () => void;
  onNext: () => void;
  onPrevious: () => void;
}

export const ControlPanel: React.FC<ControlPanelProps> = ({
  title,
  artist,
  albumArt,
  isPaused,
  offset,
  onOffsetChange,
  onOffsetReset,
  isClickThrough,
  onToggleClickThrough,
  showLyrics,
  onToggleLyrics,
  onOpenSettingsWindow,
  onPlayPause,
  onNext,
  onPrevious,
}) => {
  const numStr = Number(offset.toFixed(2)).toString();
  const formattedOffset = (offset >= 0 ? `+${numStr}` : numStr) + 's';

  const handleStartDrag = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('button') || target.closest('.control-btn')) {
      return;
    }
    e.preventDefault();
    try {
      const appWindow = getCurrentWindow();
      appWindow.startDragging();
    } catch (err) {
      console.warn('Start dragging error:', err);
    }
  };

  return (
    <div
      className="header-bar"
      onMouseDown={handleStartDrag}
      data-tauri-drag-region
    >
      {/* Left Column: 1:1 Square Album Cover */}
      <div className="mini-cover-col" data-tauri-drag-region>
        {albumArt ? (
          <img src={albumArt} alt={title} className="album-cover" />
        ) : (
          <div className="album-cover-placeholder">
            <Music size={24} />
          </div>
        )}
      </div>

      {/* Right Column: Track Details (Top) + Single Row Controls (Bottom) */}
      <div className="mini-content-col" data-tauri-drag-region>
        {/* Track Title & Artist */}
        <div className="track-details" data-tauri-drag-region>
          <span className="track-title" title={title}>
            {title || 'YouTube Music'}
          </span>
          <span className="track-artist" title={artist}>
            {artist || '未在播放'}
          </span>
        </div>

        {/* Single Row Controls: Playback Buttons + Utility Controls */}
        <div className="controls-single-row" data-tauri-drag-region>
          {/* Left: Playback Controls */}
          <div className="playback-controls-group">
            <div className="button-group">
              <button className="control-btn playback-btn" onClick={onPrevious} title="上一首">
                <SkipBack size={13} />
              </button>
              <button className="control-btn playback-btn active" onClick={onPlayPause} title={isPaused ? '播放' : '暫停'}>
                {isPaused ? <Play size={13} fill="currentColor" /> : <Pause size={13} fill="currentColor" />}
              </button>
              <button className="control-btn playback-btn" onClick={onNext} title="下一首">
                <SkipForward size={13} />
              </button>
            </div>
          </div>

          {/* Right: Utility Controls & Native Secondary Window Settings Trigger */}
          <div className="utility-controls-group">
            <button
              className="control-btn"
              onClick={onOpenSettingsWindow}
              title={`開啟獨立偏好設定視窗 (${formattedOffset})`}
            >
              <Settings size={12} />
            </button>

            <button
              className={`control-btn ${!showLyrics ? 'btn-subtle-muted' : ''}`}
              onClick={onToggleLyrics}
              title={showLyrics ? '隱藏動態歌詞 (保留播放器與封面)' : '顯示動態歌詞'}
            >
              {showLyrics ? <Eye size={12} /> : <EyeOff size={12} />}
            </button>

            <button
              className={`control-btn ${isClickThrough ? 'active lock-active-text' : ''}`}
              onClick={onToggleClickThrough}
              title={isClickThrough ? '滑鼠穿透中 (按 Alt+L 解鎖)' : '開啟滑鼠穿透 (快捷鍵 Alt+L)'}
            >
              {isClickThrough ? (
                <span className="lock-btn-text">Alt+L</span>
              ) : (
                <Unlock size={12} />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
