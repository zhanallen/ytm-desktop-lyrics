/**
 * ControlPanel Component
 * Displays current track metadata (album cover with auto-retry, title, artist), playback controls (play/pause, next, previous),
 * and utility action triggers (opening secondary settings window, lyrics collapse toggle, click-through mode toggle).
 */

import React, { useState, useEffect, useRef } from 'react';
import { Unlock, Eye, EyeOff, Settings, Play, Pause, SkipBack, SkipForward, Music } from 'lucide-react';
import { LanguageMode, getTranslation } from '../i18n';

/** Interface defining props required by ControlPanel. */
interface ControlPanelProps {
  title: string;
  artist: string;
  albumArt?: string;
  isPaused: boolean;
  offset: number;
  langMode: LanguageMode;
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

function isValidImageUrl(url: string): boolean {
  if (!url) return false;
  return url.startsWith('https://') || url.startsWith('data:image/') || url.startsWith('blob:') || url.startsWith('http://127.0.0.1');
}

/**
 * SmartAlbumCover Sub-Component
 * Handles album artwork rendering with automatic network retry (up to 3 attempts),
 * progressive low-res fallback (=w120-h120) for weak network connections, and smooth placeholder handling.
 */
const SmartAlbumCover: React.FC<{ albumArt: string; title: string }> = React.memo(({ albumArt, title }) => {
  const [imgSrc, setImgSrc] = useState<string>(albumArt);
  const [hasFailed, setHasFailed] = useState<boolean>(!isValidImageUrl(albumArt));
  const retryCountRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset image state whenever track albumArt changes
  useEffect(() => {
    if (isValidImageUrl(albumArt)) {
      setImgSrc(albumArt);
      setHasFailed(false);
    } else {
      setHasFailed(true);
    }
    retryCountRef.current = 0;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, [albumArt]);

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  /**
   * Handles image load error:
   * Attempt 1 (1s): Retry original URL with cache-buster query parameter.
   * Attempt 2 (1s): Fallback from high-res (=w512-h512) to low-res (=w120-h120) for weak networks.
   * Attempt 3 (1s): Retry low-res URL with timestamp parameter.
   * If all fail: Render fallback placeholder icon.
   */
  const handleError = () => {
    if (retryCountRef.current < 3) {
      retryCountRef.current += 1;
      const attempt = retryCountRef.current;

      timerRef.current = setTimeout(() => {
        if (attempt === 1) {
          // Retry 1: Append timestamp query parameter to bypass cache/stall
          setImgSrc(`${albumArt}${albumArt.includes('?') ? '&' : '?'}retry=${Date.now()}`);
        } else if (attempt === 2) {
          // Retry 2: Fallback from high-res (=w512-h512) to low-res (=w120-h120) for weak networks
          const lowResUrl = albumArt
            .replace(/=w512-h512/, '=w120-h120')
            .replace(/=s512/, '=s120')
            .replace(/=w512/, '=w120')
            .replace(/\/s512-c\//, '/s120-c/')
            .replace(/\/s512\//, '/s120/');
          setImgSrc(lowResUrl);
        } else {
          // Retry 3: Retry low-res URL with timestamp parameter
          const lowResUrl = albumArt
            .replace(/=w512-h512/, '=w120-h120')
            .replace(/=s512/, '=s120')
            .replace(/=w512/, '=w120')
            .replace(/\/s512-c\//, '/s120-c/')
            .replace(/\/s512\//, '/s120/');
          setImgSrc(`${lowResUrl}${lowResUrl.includes('?') ? '&' : '?'}retry=${Date.now()}`);
        }
      }, 1000);
    } else {
      // All 3 retries failed, show fallback placeholder icon
      setHasFailed(true);
    }
  };

  if (hasFailed || !imgSrc) {
    return (
      <div className="album-cover-placeholder" aria-label="No Album Art" data-tauri-drag-region>
        <Music size={24} data-tauri-drag-region />
      </div>
    );
  }

  return (
    <img
      src={imgSrc}
      alt={title}
      className="album-cover"
      onError={handleError}
      draggable={false}
      data-tauri-drag-region
    />
  );
});

export const ControlPanel: React.FC<ControlPanelProps> = React.memo(({
  title,
  artist,
  albumArt,
  isPaused,
  offset,
  langMode,
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
  /** Translation dictionary matching active language mode. */
  const t = getTranslation(langMode);

  /** Formatted offset text for tooltip displays. */
  const numStr = Number(offset.toFixed(2)).toString();
  const formattedOffset = (offset >= 0 ? `+${numStr}` : numStr) + 's';
  const isOffsetActive = Math.abs(offset) > 0.05;

  return (
    <div className="header-bar" data-tauri-drag-region>
      {/* Left Column: 1:1 Square Album Cover with Auto-Retry */}
      <div className="mini-cover-col" data-tauri-drag-region>
        {albumArt ? (
          <SmartAlbumCover albumArt={albumArt} title={title} />
        ) : (
          <div className="album-cover-placeholder" aria-label="No Album Art" data-tauri-drag-region>
            <Music size={24} data-tauri-drag-region />
          </div>
        )}
      </div>

      {/* Right Column: Track Details (Top) + Single Row Controls (Bottom) */}
      <div className="mini-content-col" data-tauri-drag-region>
        {/* Track Title & Artist */}
        <div className="track-details" data-tauri-drag-region>
          <span className="track-title" title={title} data-tauri-drag-region>
            {title || t.ytMusic}
          </span>
          <span className="track-artist" title={artist} data-tauri-drag-region>
            {artist || t.notPlaying}
          </span>
        </div>

        {/* Single Row Controls: Playback Buttons + Utility Controls */}
        <div className="controls-single-row" data-tauri-drag-region>
          {/* Left: Playback Controls */}
          <div className="playback-controls-group" data-tauri-drag-region>
            <div className="button-group" role="group" aria-label="Playback Controls" data-tauri-drag-region>
              <button
                className="control-btn playback-btn"
                onClick={onPrevious}
                title={t.prevSong}
                aria-label={t.prevSong}
              >
                <SkipBack size={11} />
              </button>
              <button
                className="control-btn playback-btn active"
                onClick={onPlayPause}
                title={isPaused ? t.play : t.pause}
                aria-label={isPaused ? t.play : t.pause}
                aria-pressed={!isPaused}
              >
                {isPaused ? <Play size={11} fill="currentColor" /> : <Pause size={11} fill="currentColor" />}
              </button>
              <button
                className="control-btn playback-btn"
                onClick={onNext}
                title={t.nextSong}
                aria-label={t.nextSong}
              >
                <SkipForward size={11} />
              </button>
            </div>
          </div>

          {/* Right: Utility Controls & Native Secondary Window Settings Trigger */}
          <div className="utility-controls-group" role="group" aria-label="Utility Controls" data-tauri-drag-region>
            <button
              className={`control-btn ${isOffsetActive ? 'has-offset-active' : ''}`}
              onClick={onOpenSettingsWindow}
              title={`${t.openSettingsNative} (${formattedOffset})`}
              aria-label={`${t.openSettingsNative} (${formattedOffset})`}
            >
              <Settings size={11} />
              {isOffsetActive && <span className="offset-indicator-dot" />}
            </button>

            <button
              className={`control-btn ${!showLyrics ? 'btn-subtle-muted' : ''}`}
              onClick={onToggleLyrics}
              title={showLyrics ? t.hideLyrics : t.showLyrics}
              aria-label={showLyrics ? t.hideLyrics : t.showLyrics}
              aria-pressed={showLyrics}
            >
              {showLyrics ? <Eye size={11} /> : <EyeOff size={11} />}
            </button>

            <button
              className={`control-btn ${isClickThrough ? 'active lock-active-text' : ''}`}
              onClick={onToggleClickThrough}
              title={isClickThrough ? t.clickThroughActive : t.clickThroughInactive}
              aria-label={isClickThrough ? t.clickThroughActive : t.clickThroughInactive}
              aria-pressed={isClickThrough}
            >
              {isClickThrough ? (
                <span className="lock-btn-text">Alt+L</span>
              ) : (
                <Unlock size={11} />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});
