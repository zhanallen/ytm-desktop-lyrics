/**
 * LyricsViewer Component
 * Renders hardware-accelerated dynamic lyrics with automatic line-by-line DOM height centering,
 * mouse wheel manual scrolling preview, and smooth auto-snap back functionality.
 */

import React, { useLayoutEffect, useRef, useState } from 'react';
import { LyricLine } from '../utils/lrcParser';
import { LanguageMode, getTranslation } from '../i18n';

/** Interface defining props required by LyricsViewer. */
interface LyricsViewerProps {
  lyrics: LyricLine[];
  activeIndex: number;
  isLoading: boolean;
  hasTrack: boolean;
  langMode: LanguageMode;
}

export const LyricsViewer: React.FC<LyricsViewerProps> = ({
  lyrics,
  activeIndex,
  isLoading,
  hasTrack,
  langMode,
}) => {
  /** Translation dictionary matching active language mode. */
  const t = getTranslation(langMode);

  /** Array of DOM references to individual lyric line elements. */
  const lineRefs = useRef<(HTMLDivElement | null)[]>([]);

  /** Calculated Y-axis translation offset to keep active line centered. */
  const [translateY, setTranslateY] = useState<number>(0);

  /** Manual Y-axis offset added via mouse wheel scrolling. */
  const [manualOffset, setManualOffset] = useState<number>(0);

  /** Timer ref for snapping manual scroll offset back to 0 after inactivity. */
  const userScrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Resets line references and manual scroll offset whenever a new track's lyrics are loaded.
   */
  useLayoutEffect(() => {
    lineRefs.current = [];
    setManualOffset(0);
  }, [lyrics]);

  /**
   * Dynamic DOM Line Height Measuring Engine:
   * Calculates the exact vertical midpoint of the currently active line (targetEl.offsetTop + targetEl.offsetHeight / 2)
   * and translates the wrapper so the active lyric is strictly centered in the viewport.
   */
  useLayoutEffect(() => {
    if (!lyrics || lyrics.length === 0) return;
    const targetIdx = activeIndex >= 0 ? activeIndex : 0;
    const targetEl = lineRefs.current[targetIdx];
    if (targetEl) {
      const lineCenter = targetEl.offsetTop + targetEl.offsetHeight / 2;
      setTranslateY(-lineCenter);
    }
  }, [activeIndex, lyrics]);

  /**
   * Handles mouse wheel scrolling for manual lyrics inspection.
   * Temporarily shifts manualOffset and schedules auto-snap back after 3 seconds of inactivity.
   */
  const handleWheel = (e: React.WheelEvent) => {
    setManualOffset((prev) => prev - e.deltaY * 0.6);

    if (userScrollTimeoutRef.current) {
      clearTimeout(userScrollTimeoutRef.current);
    }

    // Smoothly snap back to 0 manual offset after 3 seconds of inactivity
    userScrollTimeoutRef.current = setTimeout(() => {
      setManualOffset(0);
    }, 3000);
  };

  /* Render Status State: Searching for Lyrics */
  if (isLoading) {
    return (
      <div className="lyrics-canvas" data-tauri-drag-region>
        <div className="status-state">
          <div className="pulse-dot" />
          <span>{t.searchingLyrics}</span>
        </div>
      </div>
    );
  }

  /* Render Status State: Waiting for YouTube Music Playback */
  if (!hasTrack) {
    return (
      <div className="lyrics-canvas" data-tauri-drag-region>
        <div className="status-state">
          <span>{t.pleasePlayYtMusic}</span>
        </div>
      </div>
    );
  }

  /* Render Status State: Instrumental Track or Lyrics Not Found */
  if (!lyrics || lyrics.length === 0) {
    return (
      <div className="lyrics-canvas" data-tauri-drag-region>
        <div className="status-state">
          <span>{t.noLyricsFound}</span>
        </div>
      </div>
    );
  }

  /** Total combined vertical transform including active line centering and manual mouse wheel offset. */
  const finalTranslateY = translateY + manualOffset;
  const currentTargetIdx = activeIndex >= 0 ? activeIndex : 0;

  return (
    <div className="lyrics-canvas" onWheel={handleWheel} data-tauri-drag-region>
      <div
        className="lyrics-wrapper"
        style={{
          transform: `translate3d(0, ${finalTranslateY}px, 0)`,
        }}
        data-tauri-drag-region
      >
        {lyrics.map((line, index) => {
          const isActive = index === activeIndex;
          const isPast = index < activeIndex;

          return (
            <div
              key={`${index}__${line.time}`}
              ref={(el) => {
                lineRefs.current[index] = el;
                // Direct initial alignment when active target element mounts
                if (index === currentTargetIdx && el) {
                  const lineCenter = el.offsetTop + el.offsetHeight / 2;
                  setTranslateY(-lineCenter);
                }
              }}
              className={`ytm-lyric-line ${isActive ? 'active' : isPast ? 'past' : 'future'}`}
              data-tauri-drag-region
            >
              {line.text}
            </div>
          );
        })}
      </div>
    </div>
  );
};
