/**
 * LyricsViewer Component
 * Renders hardware-accelerated dynamic lyrics with automatic line-by-line DOM height centering,
 * mouse wheel manual scrolling preview, and smooth auto-snap back functionality.
 */

import React, { useLayoutEffect, useEffect, useRef, useState } from 'react';
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

export const LyricsViewer: React.FC<LyricsViewerProps> = React.memo(({
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
  const containerRef = useRef<HTMLDivElement | null>(null);

  /** Calculated Y-axis translation offset to keep active line centered. */
  const [translateY, setTranslateY] = useState<number>(0);

  /** Manual Y-axis offset added via mouse wheel scrolling. */
  const [manualOffset, setManualOffset] = useState<number>(0);
  const [isUserScrolling, setIsUserScrolling] = useState<boolean>(false);

  /** Timer ref for snapping manual scroll offset back to 0 after inactivity. */
  const userScrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const prevLyricsRef = useRef<LyricLine[]>(lyrics);

  /**
   * Visual Debounce Mechanism:
   * Protects against transition-period micro-jitter and backward twitches during CSS 0.4s animations,
   * while guaranteeing 0ms instant response on normal forward advancement and manual seeks.
   */
  const [displayIndex, setDisplayIndex] = useState<number>(activeIndex);
  const lastAdvanceTimeRef = useRef<number>(0);
  const displayIndexRef = useRef<number>(activeIndex);
  displayIndexRef.current = displayIndex;

  useEffect(() => {
    const cur = displayIndexRef.current;
    if (activeIndex > cur) {
      // 正常向前推進：0ms 立即響應，並記錄前進時間戳
      setDisplayIndex(activeIndex);
      lastAdvanceTimeRef.current = Date.now();
    } else if (activeIndex < cur) {
      const now = Date.now();
      // 若為相鄰單行回退且距上次向前未滿 350ms（過渡動畫期間微抖動）：忽略瞬態回退
      if (cur - activeIndex === 1 && now - lastAdvanceTimeRef.current < 350) {
        return;
      }
      // 使用者主動 Seek 倒退或跨行：0ms 立即同步
      setDisplayIndex(activeIndex);
    }
  }, [activeIndex]);

  /**
   * Resets manual scroll state when track lyrics change and updates the centered line translation
   * in a single unified layout pass to eliminate forced double reflows.
   */
  useLayoutEffect(() => {
    if (prevLyricsRef.current !== lyrics) {
      prevLyricsRef.current = lyrics;
      setManualOffset(0);
      setIsUserScrolling(false);
      setDisplayIndex(activeIndex >= 0 ? activeIndex : 0);
      lastAdvanceTimeRef.current = 0;
    }

    if (!lyrics || lyrics.length === 0) return;
    const targetIdx = displayIndex >= 0 ? Math.min(displayIndex, lyrics.length - 1) : 0;
    const targetEl = lineRefs.current[targetIdx];
    if (targetEl) {
      const lineCenter = targetEl.offsetTop + targetEl.offsetHeight / 2;
      setTranslateY(-lineCenter);
    }
  }, [displayIndex, lyrics]);

  /**
   * Auto-realign lyrics vertical center when window is resized.
   */
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      if (!lyrics || lyrics.length === 0) return;
      const curIdx = displayIndexRef.current;
      const targetIdx = curIdx >= 0 ? Math.min(curIdx, lyrics.length - 1) : 0;
      const targetEl = lineRefs.current[targetIdx];
      if (targetEl) {
        const lineCenter = targetEl.offsetTop + targetEl.offsetHeight / 2;
        setTranslateY(-lineCenter);
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [lyrics]);

  // Clean up auto-snap timer on unmount
  useEffect(() => {
    return () => {
      if (userScrollTimeoutRef.current) {
        clearTimeout(userScrollTimeoutRef.current);
      }
    };
  }, []);

  /**
   * Handles mouse wheel scrolling for manual lyrics inspection.
   * Clamps offset between first and last lyric bounds plus elastic overscroll margin.
   * Schedules auto-snap back after 3 seconds of inactivity.
   */
  const handleWheel = (e: React.WheelEvent) => {
    if (!lyrics || lyrics.length === 0) return;
    setIsUserScrolling(true);

    setManualOffset((prev) => {
      const delta = -e.deltaY * 0.6;
      const nextOffset = prev + delta;

      const targetIdx = displayIndex >= 0 ? Math.min(displayIndex, lyrics.length - 1) : 0;
      const targetEl = lineRefs.current[targetIdx];
      const firstEl = lineRefs.current[0];
      const lastEl = lineRefs.current[lyrics.length - 1];

      if (targetEl && firstEl && lastEl) {
        const lineCenter = targetEl.offsetTop + targetEl.offsetHeight / 2;
        const firstCenter = firstEl.offsetTop + firstEl.offsetHeight / 2;
        const lastCenter = lastEl.offsetTop + lastEl.offsetHeight / 2;
        const overscrollMargin = 100; // Elastic overscroll margin in pixels

        const minOffset = (lineCenter - lastCenter) - overscrollMargin;
        const maxOffset = (lineCenter - firstCenter) + overscrollMargin;

        return Math.min(Math.max(nextOffset, minOffset), maxOffset);
      }

      return nextOffset;
    });

    if (userScrollTimeoutRef.current) {
      clearTimeout(userScrollTimeoutRef.current);
    }

    // Smoothly snap back to 0 manual offset after 3 seconds of inactivity
    userScrollTimeoutRef.current = setTimeout(() => {
      setManualOffset(0);
      setIsUserScrolling(false);
    }, 3000);
  };

  /* Render Status State: Searching for Lyrics */
  if (isLoading) {
    return (
      <div className="lyrics-canvas" role="region" aria-label={t.searchingLyrics} aria-live="polite" data-tauri-drag-region>
        <div className="status-state" data-tauri-drag-region>
          <div className="pulse-dot" data-tauri-drag-region />
          <span data-tauri-drag-region>{t.searchingLyrics}</span>
        </div>
      </div>
    );
  }

  /* Render Status State: Waiting for YouTube Music Playback */
  if (!hasTrack) {
    return (
      <div className="lyrics-canvas" role="region" aria-label={t.pleasePlayYtMusic} aria-live="polite" data-tauri-drag-region>
        <div className="status-state" data-tauri-drag-region>
          <span data-tauri-drag-region>{t.pleasePlayYtMusic}</span>
        </div>
      </div>
    );
  }

  /* Render Status State: Instrumental Track or Lyrics Not Found */
  if (!lyrics || lyrics.length === 0) {
    return (
      <div className="lyrics-canvas" role="region" aria-label={t.noLyricsFound} aria-live="polite" data-tauri-drag-region>
        <div className="status-state" data-tauri-drag-region>
          <span data-tauri-drag-region>{t.noLyricsFound}</span>
        </div>
      </div>
    );
  }

  /** Total combined vertical transform including active line centering and manual mouse wheel offset. */
  const finalTranslateY = translateY + manualOffset;

  return (
    <div ref={containerRef} className="lyrics-canvas" role="region" aria-label="Synced Lyrics" onWheel={handleWheel} data-tauri-drag-region>
      <div
        className={`lyrics-wrapper ${isUserScrolling ? 'is-manual-scrolling' : ''}`}
        style={{
          transform: `translate3d(0, ${finalTranslateY}px, 0)`,
        }}
        data-tauri-drag-region
      >
        {lyrics.map((line, index) => {
          const isActive = index === displayIndex;
          const isPast = index < displayIndex;

          return (
            <div
              key={`${index}__${line.time}`}
              ref={(el) => {
                lineRefs.current[index] = el;
              }}
              className={`ytm-lyric-line ${isActive ? 'active' : isPast ? 'past' : 'future'}`}
              aria-current={isActive ? 'true' : undefined}
              data-tauri-drag-region
            >
              {line.text}
            </div>
          );
        })}
      </div>
    </div>
  );
});
