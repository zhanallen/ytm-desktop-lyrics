import React, { useLayoutEffect, useRef, useState } from 'react';
import { LyricLine } from '../utils/lrcParser';
import { LanguageMode, getTranslation } from '../i18n';

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
  const t = getTranslation(langMode);
  const lineRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [translateY, setTranslateY] = useState<number>(0);
  const [manualOffset, setManualOffset] = useState<number>(0);
  const userScrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear lineRefs ONLY when lyrics array changes (new song loaded)
  useLayoutEffect(() => {
    lineRefs.current = [];
    setManualOffset(0);
  }, [lyrics]);

  // Direct Highlighting Follower Engine:
  // Scroll window strictly follows the center of the currently active highlighted line
  useLayoutEffect(() => {
    if (!lyrics || lyrics.length === 0) return;
    const targetIdx = activeIndex >= 0 ? activeIndex : 0;
    const targetEl = lineRefs.current[targetIdx];
    if (targetEl) {
      const lineCenter = targetEl.offsetTop + targetEl.offsetHeight / 2;
      setTranslateY(-lineCenter);
    }
  }, [activeIndex, lyrics]);

  // Handle manual mouse wheel scrolling
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

  if (!hasTrack) {
    return (
      <div className="lyrics-canvas" data-tauri-drag-region>
        <div className="status-state">
          <span>{t.pleasePlayYtMusic}</span>
        </div>
      </div>
    );
  }

  if (!lyrics || lyrics.length === 0) {
    return (
      <div className="lyrics-canvas" data-tauri-drag-region>
        <div className="status-state">
          <span>{t.noLyricsFound}</span>
        </div>
      </div>
    );
  }

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
