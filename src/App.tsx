/**
 * Main Application Module (App.tsx)
 * Serves as the primary entry point and state management engine for the YTM Desktop Lyrics Widget.
 * Handles window route branching, WebSocket/Tauri track synchronization, subpixel DPI window height locking,
 * persistent localStorage state retention, and cross-window settings broadcasting.
 */

import React, { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, emit } from '@tauri-apps/api/event';
import { parseLrc, getActiveLyricIndex, LyricLine } from './utils/lrcParser';
import { fetchLyrics } from './services/lrclib';
import { ControlPanel } from './components/ControlPanel';
import { LyricsViewer } from './components/LyricsViewer';
import { SettingsPage } from './components/SettingsPage';
import { LanguageMode, detectLanguage } from './i18n';

/** Interface defining YouTube Music track data payload received via IPC / WebSocket. */
interface TrackPayload {
  title: string;
  artist: string;
  albumArt?: string;
  currentTime: number;
  duration: number;
  isPaused: boolean;
  timestamp: number;
}

/**
 * Main Entry Component.
 * Branches execution based on URL search query or hash (`window=settings`) to render either
 * the secondary native SettingsPage or the primary desktop MainWidgetApp.
 */
export const App: React.FC = () => {
  // Check if current window route is the settings window using URLSearchParams
  const searchParams = new URLSearchParams(window.location.search);
  const isSettingsRoute =
    searchParams.get('window') === 'settings' ||
    window.location.hash.includes('settings');

  if (isSettingsRoute) {
    return <SettingsPage />;
  }

  return <MainWidgetApp />;
};

/**
 * Main Widget Application Component.
 * Contains state for track metadata, synced lyrics, lyric time offset, click-through,
 * lyrics display collapse state, and language preference.
 */
const MainWidgetApp: React.FC = () => {
  /** Active playing track metadata. */
  const [track, setTrack] = useState<TrackPayload | null>(null);

  /** Parsed LRC lyric lines array. */
  const [lyrics, setLyrics] = useState<LyricLine[]>([]);

  /** Loading indicator state for LRCLIB API fetching. */
  const [isLoadingLyrics, setIsLoadingLyrics] = useState<boolean>(false);

  /** Lyric time synchronization offset in seconds, initialized from localStorage. */
  const [offset, setOffset] = useState<number>(() => {
    const saved = localStorage.getItem('ytm_offset');
    if (saved !== null) {
      const parsed = parseFloat(saved);
      if (!isNaN(parsed)) return parsed;
    }
    return 0;
  });

  /** Mouse click-through state (ignore cursor events). */
  const [isClickThrough, setIsClickThrough] = useState<boolean>(false);

  /** Lyrics display visibility toggle state. */
  const [showLyrics, setShowLyrics] = useState<boolean>(true);

  /** Language preference mode ('system', 'zh-TW', or 'en'), initialized from localStorage with system auto default. */
  const [languageMode, setLanguageMode] = useState<LanguageMode>(() => {
    const saved = localStorage.getItem('ytm_lang');
    return saved === 'zh-TW' || saved === 'en' || saved === 'system' ? (saved as LanguageMode) : 'system';
  });

  /* Mutable References for Stable Subpixel Calculations and Async Event Guards */
  const currentSongRef = useRef<string>('');
  const latestTrackRef = useRef<TrackPayload | null>(null);
  const isClickThroughRef = useRef<boolean>(false);
  const showLyricsRef = useRef<boolean>(true);
  const offsetRef = useRef<number>(0);
  const languageModeRef = useRef<LanguageMode>('system');
  
  /** Real-time memory for expanded window physical height (default 560px), stored using Math.floor. */
  const savedExpandedHeightRef = useRef<number>(560);

  /** WebSocket connection handle for direct browser extension messaging. */
  const wsRef = useRef<WebSocket | null>(null);

  /** Keep click-through ref in sync with state. */
  useEffect(() => {
    isClickThroughRef.current = isClickThrough;
  }, [isClickThrough]);

  /** Keep show-lyrics ref in sync with state. */
  useEffect(() => {
    showLyricsRef.current = showLyrics;
  }, [showLyrics]);

  /**
   * Persists offset changes to localStorage and broadcasts updated state to settings window.
   */
  useEffect(() => {
    offsetRef.current = offset;
    localStorage.setItem('ytm_offset', offset.toString());
    broadcastStateToSettings();
  }, [offset]);

  /**
   * Updates language mode ref and triggers native system tray context menu text update via Rust IPC.
   */
  useEffect(() => {
    languageModeRef.current = languageMode;
    const activeLang = detectLanguage(languageMode);
    invoke('update_tray_language', { isEnglish: activeLang === 'en' }).catch(() => {});
  }, [languageMode]);

  const lastMinHeightRef = useRef<number>(0);
  const isInitialMountRef = useRef<boolean>(true);

  /**
   * Broadcasts current widget configuration state snapshot to secondary settings window via Tauri IPC event.
   */
  const broadcastStateToSettings = () => {
    const storedLang = localStorage.getItem('ytm_lang');
    const activeMode = storedLang === 'zh-TW' || storedLang === 'en' || storedLang === 'system'
      ? (storedLang as LanguageMode)
      : languageModeRef.current || 'system';

    emit('sync-settings-state', {
      offset: offsetRef.current,
      isClickThrough: isClickThroughRef.current,
      showLyrics: showLyricsRef.current,
      languageMode: activeMode,
    });
  };

  /**
   * Continuously monitors window resizing in expanded mode and records physical height using Math.floor for DPI stability.
   */
  useEffect(() => {
    const handleWindowResize = () => {
      if (showLyricsRef.current) {
        const container = document.querySelector('.widget-container') as HTMLElement;
        if (container) {
          const factor = window.devicePixelRatio || 1;
          const currentPhysHeight = Math.floor(container.getBoundingClientRect().height * factor);
          
          if (currentPhysHeight >= Math.floor(170 * factor)) {
            savedExpandedHeightRef.current = currentPhysHeight;
          }
        }
      }
    };

    window.addEventListener('resize', handleWindowResize);
    return () => window.removeEventListener('resize', handleWindowResize);
  }, []);

  /**
   * Synchronizes DOM header element height with Win32 WM_SIZING hook for dynamic minimum window height clamping.
   */
  useEffect(() => {
    const headerEl = document.querySelector('.header-bar') as HTMLElement;
    if (!headerEl) return;

    const syncMinHeight = () => {
      const factor = window.devicePixelRatio || 1;
      const headerHeight = headerEl.scrollHeight > 0 ? headerEl.scrollHeight : 84;
      const lyricsExtra = showLyrics ? 116 : 0;
      const minPhysHeight = Math.floor((headerHeight + 2 + lyricsExtra) * factor);

      if (Math.abs(minPhysHeight - lastMinHeightRef.current) >= 1) {
        lastMinHeightRef.current = minPhysHeight;
        invoke('set_min_height_only', { height: minPhysHeight }).catch(() => {});

        if (isInitialMountRef.current) {
          isInitialMountRef.current = false;
          invoke('resize_physical_window', {
            width: Math.floor(295 * factor),
            height: minPhysHeight,
          }).catch(() => {});
        }
      }
    };

    syncMinHeight();

    const observer = new ResizeObserver(() => {
      syncMinHeight();
    });

    observer.observe(headerEl);

    return () => {
      observer.disconnect();
    };
  }, [showLyrics, track?.title]);

  /**
   * Dispatches playback control commands (playPause, next, previous) via Tauri command or WebSocket fallback.
   */
  const sendPlayerCommand = async (cmd: 'playPause' | 'next' | 'previous') => {
    try {
      await invoke('send_player_command', { command: cmd });
    } catch (err) {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        try {
          wsRef.current.send(JSON.stringify({ command: cmd }));
        } catch (e) {}
      }
    }
  };

  /**
   * Toggles lyrics display visibility with 0-frame flickering prevention and Math.floor subpixel stability.
   */
  const handleToggleLyrics = async () => {
    const nextShowLyrics = !showLyricsRef.current;

    try {
      const factor = window.devicePixelRatio || 1;
      const container = document.querySelector('.widget-container') as HTMLElement;
      const headerEl = document.querySelector('.header-bar') as HTMLElement;
      const currentWidth = container ? container.getBoundingClientRect().width : 640;

      if (!nextShowLyrics) {
        // Record physical height using Math.floor before collapsing
        if (container) {
          const currentPhysHeight = Math.floor(container.getBoundingClientRect().height * factor);
          if (currentPhysHeight >= Math.floor(170 * factor)) {
            savedExpandedHeightRef.current = currentPhysHeight;
          }
        }

        setShowLyrics(false);

        // Collapse to compact mode using Math.floor
        const headerHeight = headerEl ? (headerEl.scrollHeight > 0 ? headerEl.scrollHeight : 84) : 84;
        const physWidth = Math.floor(currentWidth * factor);
        const physHeight = Math.floor((headerHeight + 2) * factor);

        await invoke('lock_window_height', {
          width: physWidth,
          height: physHeight,
          isLocked: true,
        });
        broadcastStateToSettings();
      } else {
        setShowLyrics(true);

        // Directly restore savedExpandedHeightRef with Math.floor calculation
        const physWidth = Math.floor(currentWidth * factor);
        const targetPhysHeight = Math.floor(savedExpandedHeightRef.current);

        await invoke('lock_window_height', {
          width: physWidth,
          height: targetPhysHeight,
          isLocked: false,
        });
        broadcastStateToSettings();
      }
    } catch (err) {
      console.warn('Physical window resize on toggle lyrics error:', err);
    }
  };

  /**
   * Processes incoming YouTube Music track metadata payload.
   * Triggers LRCLIB API search when song changes and parses returned LRC format synced lyrics.
   */
  const handleUpdatePayload = async (payload: TrackPayload) => {
    if (!payload || !payload.title) return;

    latestTrackRef.current = payload;

    const songKey = `${payload.title.toLowerCase().trim()}__${payload.artist.toLowerCase().trim()}`;
    if (songKey !== currentSongRef.current) {
      currentSongRef.current = songKey;
      setTrack({ ...payload, currentTime: 0 });
      setLyrics([]);
      setIsLoadingLyrics(true);

      const res = await fetchLyrics(payload.title, payload.artist, payload.duration);

      if (songKey === currentSongRef.current) {
        if (res && res.syncedLyrics) {
          const parsed = parseLrc(res.syncedLyrics);
          setLyrics(parsed);
        } else {
          setLyrics([]);
        }
        setIsLoadingLyrics(false);
        if (latestTrackRef.current) {
          setTrack({ ...latestTrackRef.current });
        }
      }
    } else {
      setTrack(payload);
    }
  };

  /** Toggles mouse cursor click-through mode. */
  const toggleClickThrough = async (targetState?: boolean) => {
    const nextState = targetState !== undefined ? targetState : !isClickThroughRef.current;
    setIsClickThrough(nextState);

    try {
      await invoke('set_ignore_cursor_events', { ignore: nextState });
      broadcastStateToSettings();
    } catch (err) {
      console.warn('Click-through invoke warning:', err);
    }
  };

  /** Opens or focuses the native secondary settings window. */
  const handleOpenSettingsWindow = async () => {
    try {
      await invoke('open_settings_window');
    } catch (err) {
      console.warn('Open settings window error:', err);
    }
  };

  /**
   * Lifecycle Effect Hook for registering Tauri IPC event listeners and WebSocket server connection.
   * Includes strict isMounted lifecycle guards and unlisten cleanup array to guarantee zero duplicate listeners.
   */
  useEffect(() => {
    let isMounted = true;
    const unlistens: (() => void)[] = [];

    const setupTauriListeners = async () => {
      try {
        const u1 = await listen<string>('yt-music-update', (event) => {
          if (!isMounted) return;
          try {
            const data: TrackPayload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
            handleUpdatePayload(data);
          } catch (e) {}
        });
        if (isMounted) unlistens.push(u1); else u1();

        const u2 = await listen('toggle-click-through', () => {
          if (!isMounted) return;
          toggleClickThrough();
        });
        if (isMounted) unlistens.push(u2); else u2();

        const u3 = await listen('toggle-lyrics-visibility', () => {
          if (!isMounted) return;
          handleToggleLyrics();
        });
        if (isMounted) unlistens.push(u3); else u3();

        const u4 = await listen('request-settings-state', () => {
          if (!isMounted) return;
          broadcastStateToSettings();
        });
        if (isMounted) unlistens.push(u4); else u4();

        const u5 = await listen<number>('change-offset-delta', (event) => {
          if (!isMounted) return;
          setOffset((prev) => {
            const next = Math.round((prev + event.payload) * 10) / 10;
            localStorage.setItem('ytm_offset', next.toString());
            return next;
          });
        });
        if (isMounted) unlistens.push(u5); else u5();

        const u6 = await listen('reset-offset', () => {
          if (!isMounted) return;
          setOffset(0);
          localStorage.setItem('ytm_offset', '0');
        });
        if (isMounted) unlistens.push(u6); else u6();

        const u7 = await listen('toggle-click-through-cmd', () => {
          if (!isMounted) return;
          toggleClickThrough();
        });
        if (isMounted) unlistens.push(u7); else u7();

        const u8 = await listen('toggle-lyrics-cmd', () => {
          if (!isMounted) return;
          handleToggleLyrics();
        });
        if (isMounted) unlistens.push(u8); else u8();

        const u9 = await listen<LanguageMode>('change-language-cmd', (event) => {
          if (!isMounted) return;
          if (event.payload) {
            setLanguageMode(event.payload);
            localStorage.setItem('ytm_lang', event.payload);
            const activeLang = detectLanguage(event.payload);
            invoke('update_tray_language', { isEnglish: activeLang === 'en' }).catch(() => {});
          }
        });
        if (isMounted) unlistens.push(u9); else u9();
      } catch (e) {}
    };

    const connectDirectWs = () => {
      try {
        const ws = new WebSocket('ws://127.0.0.1:27890?token=ytm_sync_sec_8f9a2b7c4d5e');
        wsRef.current = ws;

        ws.onmessage = (msg) => {
          if (!isMounted) return;
          try {
            const data = JSON.parse(msg.data);
            if (data.title) {
              handleUpdatePayload(data);
            }
          } catch (err) {}
        };
        ws.onclose = () => {
          if (isMounted) setTimeout(connectDirectWs, 2000);
        };
      } catch (err) {
        if (isMounted) setTimeout(connectDirectWs, 2000);
      }
    };

    setupTauriListeners();
    connectDirectWs();

    return () => {
      isMounted = false;
      unlistens.forEach((unlisten) => unlisten());
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  /** Adjusts offset by delta and persists to localStorage. */
  const handleOffsetChange = (delta: number) => {
    setOffset((prev) => {
      const next = Math.round((prev + delta) * 10) / 10;
      localStorage.setItem('ytm_offset', next.toString());
      return next;
    });
  };

  /** Resets offset to 0 and persists to localStorage. */
  const handleOffsetReset = () => {
    setOffset(0);
    localStorage.setItem('ytm_offset', '0');
  };

  /** Computes index of currently highlighted lyric line based on track playback time and sync offset. */
  const activeIndex = getActiveLyricIndex(lyrics, track?.currentTime || 0, offset);

  return (
    <div
      className={`widget-container ${!showLyrics ? 'lyrics-hidden' : ''} ${isClickThrough ? 'is-clickthrough' : ''}`}
      data-tauri-drag-region
    >
      <ControlPanel
        title={track?.title || ''}
        artist={track?.artist || ''}
        albumArt={track?.albumArt}
        isPaused={track?.isPaused ?? true}
        offset={offset}
        langMode={languageMode}
        onOffsetChange={handleOffsetChange}
        onOffsetReset={handleOffsetReset}
        isClickThrough={isClickThrough}
        onToggleClickThrough={() => toggleClickThrough()}
        showLyrics={showLyrics}
        onToggleLyrics={handleToggleLyrics}
        onOpenSettingsWindow={handleOpenSettingsWindow}
        onPlayPause={() => sendPlayerCommand('playPause')}
        onNext={() => sendPlayerCommand('next')}
        onPrevious={() => sendPlayerCommand('previous')}
      />

      {showLyrics && (
        <LyricsViewer
          lyrics={lyrics}
          activeIndex={activeIndex}
          isLoading={isLoadingLyrics}
          hasTrack={!!track && !!track.title}
          langMode={languageMode}
        />
      )}
    </div>
  );
};

export default App;
