/**
 * Main Application Module (App.tsx)
 * Serves as the primary entry point and state management engine for the YTM Desktop Lyrics Widget.
 * Handles window route branching, WebSocket/Tauri track synchronization, subpixel DPI window height locking,
 * persistent localStorage state retention, and cross-window settings broadcasting.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, emit } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { parseLrc, getActiveLyricIndex, LyricLine } from './utils/lrcParser';
import { fetchLyrics } from './services/lrclib';
import { ControlPanel } from './components/ControlPanel';
import { LyricsViewer } from './components/LyricsViewer';
import type { UITheme, GlassQuality } from './components/SettingsPage';
import { SettingsPage } from './components/SettingsPage';
import { LiquidGlassCanvas } from './components/LiquidGlassCanvas';
import { LanguageMode, detectLanguage } from './i18n';
import { memoryManager } from './services/memoryManager';

declare global {
  namespace NodeJS {
    type Timeout = ReturnType<typeof setTimeout>;
  }
}

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

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class SettingsErrorBoundary extends React.Component<{ children: React.ReactNode }, ErrorBoundaryState> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Settings window caught error:', error, errorInfo);
  }

  handleClose = () => {
    getCurrentWindow().close().catch(() => {});
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="settings-window-container" style={{ padding: '24px', color: '#fff', textAlign: 'center' }}>
          <h3 style={{ marginTop: '40px', color: '#ff6b6b' }}>設定頁面載入異常</h3>
          <p style={{ fontSize: '12px', color: 'rgba(255,255,255,0.7)', margin: '16px 0' }}>
            {this.state.error?.message || '發生未預期的渲染錯誤'}
          </p>
          <button
            className="control-btn modal-action-btn"
            style={{ margin: '0 auto', padding: '8px 24px' }}
            onClick={this.handleClose}
          >
            關閉視窗
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * Main Entry Component.
 * Branches execution based on URL search query or hash (`window=settings`) to render either
 * the secondary native SettingsPage or the primary desktop MainWidgetApp.
 */
export const App: React.FC = () => {
  // Track B Memory Optimization: 60-second idle memory governance listener
  useEffect(() => {
    let idleTimer: number | null = null;

    const performTrimAndGc = () => {
      invoke('trim_memory').catch(() => {});
      try {
        (window as any).gc?.();
      } catch {}
    };

    const resetIdleTimer = () => {
      if (idleTimer !== null) {
        window.clearTimeout(idleTimer);
      }
      idleTimer = window.setTimeout(() => {
        performTrimAndGc();
        resetIdleTimer();
      }, 60000);
    };

    const handleActivity = () => {
      resetIdleTimer();
    };

    window.addEventListener('mousemove', handleActivity, { passive: true });
    window.addEventListener('mousedown', handleActivity, { passive: true });
    window.addEventListener('keydown', handleActivity, { passive: true });
    window.addEventListener('wheel', handleActivity, { passive: true });
    window.addEventListener('touchstart', handleActivity, { passive: true });

    // Initial 60-second idle countdown
    resetIdleTimer();

    return () => {
      if (idleTimer !== null) {
        window.clearTimeout(idleTimer);
      }
      window.removeEventListener('mousemove', handleActivity);
      window.removeEventListener('mousedown', handleActivity);
      window.removeEventListener('keydown', handleActivity);
      window.removeEventListener('wheel', handleActivity);
      window.removeEventListener('touchstart', handleActivity);
    };
  }, []);

  // Deterministic Route Branching: Check if current window route is settings
  const isSettingsWindow = (() => {
    try {
      return getCurrentWindow().label === 'settings';
    } catch {
      return false;
    }
  })();
  const searchParams = new URLSearchParams(window.location.search);
  const isSettingsRoute =
    isSettingsWindow ||
    searchParams.get('window') === 'settings' ||
    window.location.hash.includes('settings');

  if (isSettingsRoute) {
    return (
      <SettingsErrorBoundary>
        <SettingsPage />
      </SettingsErrorBoundary>
    );
  }

  return <MainWidgetApp />;
};

/**
 * Main Widget Application Component.
 * Contains state for track metadata, synced lyrics, lyric time offset, click-through,
 * lyrics display collapse state, and language preference.
 */
const MainWidgetApp: React.FC = () => {
  /** Active playing track metadata (defaults to null before connection). */
  const [track, setTrack] = useState<TrackPayload | null>(null);

  /** Parsed LRC lyric lines array (defaults to empty array before connection). */
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

  /** Mouse click-through state (ignore cursor events), initialized from localStorage. */
  const [isClickThrough, setIsClickThrough] = useState<boolean>(() => {
    return localStorage.getItem('ytm_clickthrough') === 'true';
  });

  /** Lyrics display visibility toggle state, initialized from localStorage. */
  const [showLyrics, setShowLyrics] = useState<boolean>(() => {
    const saved = localStorage.getItem('ytm_show_lyrics');
    return saved !== 'false';
  });

  /** Language preference mode ('system', 'zh-TW', or 'en'), initialized from localStorage with system auto default. */
  const [languageMode, setLanguageMode] = useState<LanguageMode>(() => {
    const saved = localStorage.getItem('ytm_lang');
    return saved === 'zh-TW' || saved === 'en' || saved === 'system' ? (saved as LanguageMode) : 'system';
  });

  /** UI Theme style preference ('default' for classic v1.2.0 glassmorphism, 'liquid-glass' for WebGL optical glass). */
  const [uiTheme, setUiTheme] = useState<UITheme>(() => {
    const saved = localStorage.getItem('ytm_ui_theme');
    return saved === 'liquid-glass' ? 'liquid-glass' : 'default';
  });


  /* Mutable References for Stable Subpixel Calculations and Async Event Guards */
  const currentSongRef = useRef<string>('');
  const latestTrackRef = useRef<TrackPayload | null>(null);
  const isClickThroughRef = useRef<boolean>(isClickThrough);
  const showLyricsRef = useRef<boolean>(showLyrics);
  const offsetRef = useRef<number>(0);
  const languageModeRef = useRef<LanguageMode>('system');
  const uiThemeRef = useRef<UITheme>('default');
  const retryTimerRef = useRef<NodeJS.Timeout | null>(null);
  
  /** Real-time memory for expanded window physical height (default 560px), stored using Math.floor. */
  const savedExpandedHeightRef = useRef<number>(560);

  /** Keep click-through ref in sync with state and persist. */
  useEffect(() => {
    isClickThroughRef.current = isClickThrough;
    localStorage.setItem('ytm_clickthrough', String(isClickThrough));
    broadcastStateToSettings();
  }, [isClickThrough]);

  /** Keep show-lyrics ref in sync with state and persist. */
  useEffect(() => {
    showLyricsRef.current = showLyrics;
    localStorage.setItem('ytm_show_lyrics', String(showLyrics));
    broadcastStateToSettings();
  }, [showLyrics]);

  /** Keep UI theme ref in sync with state. */
  useEffect(() => {
    uiThemeRef.current = uiTheme;
    localStorage.setItem('ytm_ui_theme', uiTheme);
    broadcastStateToSettings();
  }, [uiTheme]);


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

  /** Initialize capture quality on mount from localStorage */
  useEffect(() => {
    const savedQuality = localStorage.getItem('ytm_glass_quality');
    invoke('set_capture_quality', { isNative: savedQuality !== 'performance' }).catch(() => {});
  }, []);

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

    const storedTheme = localStorage.getItem('ytm_ui_theme');
    const activeTheme = storedTheme === 'liquid-glass' ? 'liquid-glass' : 'default';

    const storedQuality = localStorage.getItem('ytm_glass_quality');
    const activeQuality = storedQuality === 'performance' ? 'performance' : 'native';

    emit('sync-settings-state', {
      offset: offsetRef.current,
      isClickThrough: isClickThroughRef.current,
      showLyrics: showLyricsRef.current,
      languageMode: activeMode,
      uiTheme: activeTheme,
      glassQuality: activeQuality,
    }).catch((err) => console.warn('sync-settings-state broadcast warning:', err));
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
   * Dispatches playback control commands (playPause, next, previous) via Tauri command.
   */
  const sendPlayerCommand = useCallback(async (cmd: 'playPause' | 'next' | 'previous') => {
    try {
      await invoke('send_player_command', { command: cmd });
    } catch (err) {
      console.warn('send_player_command error:', err);
    }
  }, []);

  /**
   * Toggles lyrics display visibility with 0-frame flickering prevention and Math.floor subpixel stability.
   */
  const handleToggleLyrics = useCallback(async () => {
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
        localStorage.setItem('ytm_show_lyrics', 'false');

        // Collapse to compact mode using Math.floor
        const headerHeight = headerEl
          ? (headerEl.getBoundingClientRect().height > 0
              ? headerEl.getBoundingClientRect().height
              : (headerEl.scrollHeight > 0 ? headerEl.scrollHeight : 60))
          : 60;
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
        localStorage.setItem('ytm_show_lyrics', 'true');

        // Directly restore savedExpandedHeightRef with Math.floor calculation
        const physWidth = Math.floor(currentWidth * factor);
        const targetPhysHeight = Math.max(
          Math.floor(savedExpandedHeightRef.current),
          Math.floor(170 * factor)
        );

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
  }, []);

  /**
   * Processes incoming YouTube Music track metadata payload.
   * Triggers LRCLIB API search when song changes and parses returned LRC format synced lyrics.
   */
  const handleUpdatePayload = useCallback(async (payload: TrackPayload) => {
    if (!payload || !payload.title) return;

    latestTrackRef.current = payload;

    const songKey = `${payload.title.toLowerCase().trim()}__${payload.artist.toLowerCase().trim()}`;
    if (songKey !== currentSongRef.current) {
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }

      currentSongRef.current = songKey;
      setTrack({ ...payload, currentTime: 0 });
      setLyrics([]);
      setIsLoadingLyrics(true);

      const res = await fetchLyrics(payload.title, payload.artist, payload.duration);

      if (songKey === currentSongRef.current) {
        if (res && res.syncedLyrics) {
          const parsed = parseLrc(res.syncedLyrics);
          setLyrics(parsed);
          retryTimerRef.current = null;
        } else {
          setLyrics([]);
          retryTimerRef.current = setTimeout(async () => {
            if (currentSongRef.current !== songKey) return;
            try {
              const retryRes = await fetchLyrics(payload.title, payload.artist, payload.duration);
              if (currentSongRef.current === songKey && retryRes && retryRes.syncedLyrics) {
                const parsed = parseLrc(retryRes.syncedLyrics);
                setLyrics(parsed);
                memoryManager.triggerProactiveGc('song-change');
              }
            } catch (err) {
              console.warn('[LRCLIB] Self-healing retry error:', err);
            } finally {
              if (currentSongRef.current === songKey) {
                retryTimerRef.current = null;
              }
            }
          }, 4500);
        }
        setIsLoadingLyrics(false);
        if (latestTrackRef.current) {
          setTrack({ ...latestTrackRef.current });
        }
        memoryManager.triggerProactiveGc('song-change');
      }
    } else {
      setTrack(payload);
    }
  }, []);

  /** Toggles mouse cursor click-through mode. */
  const toggleClickThrough = useCallback(async (targetState?: boolean) => {
    const nextState = targetState !== undefined ? targetState : !isClickThroughRef.current;
    setIsClickThrough(nextState);
    isClickThroughRef.current = nextState;
    localStorage.setItem('ytm_clickthrough', String(nextState));

    if (document.activeElement && (document.activeElement as HTMLElement).blur) {
      (document.activeElement as HTMLElement).blur();
    }

    try {
      await invoke('set_ignore_cursor_events', { ignore: nextState });
      broadcastStateToSettings();
    } catch (err) {
      console.warn('Click-through invoke warning:', err);
    }
  }, []);

  /** Opens or focuses the native secondary settings window. */
  const handleOpenSettingsWindow = useCallback(async () => {
    try {
      await invoke('open_settings_window');
    } catch (err) {
      console.warn('Open settings window error:', err);
    }
  }, []);

  /**
   * Lifecycle Effect Hook for registering Tauri IPC event listeners.
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
          if (typeof event.payload === 'number' && Number.isFinite(event.payload)) {
            setOffset((prev) => {
              const next = Math.round((prev + event.payload) * 10) / 10;
              localStorage.setItem('ytm_offset', next.toString());
              return next;
            });
          }
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

        const u10 = await listen<UITheme>('change-ui-theme-cmd', (event) => {
          if (!isMounted) return;
          if (event.payload === 'default' || event.payload === 'liquid-glass') {
            setUiTheme(event.payload);
            localStorage.setItem('ytm_ui_theme', event.payload);
            if (event.payload === 'default') {
              invoke('trim_memory').catch(() => {});
              try {
                (window as any).gc?.();
              } catch {}
            }
          }
        });
        if (isMounted) unlistens.push(u10); else u10();

        const u11 = await listen<GlassQuality>('change-glass-quality-cmd', (event) => {
          if (!isMounted) return;
          const quality = event.payload === 'performance' ? 'performance' : 'native';
          localStorage.setItem('ytm_glass_quality', quality);
          invoke('set_capture_quality', { isNative: quality === 'native' }).catch(() => {});
          broadcastStateToSettings();
        });
        if (isMounted) unlistens.push(u11); else u11();

      } catch (e) {}
    };

    setupTauriListeners();

    return () => {
      isMounted = false;
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      unlistens.forEach((unlisten) => unlisten());
    };
  }, [handleUpdatePayload, toggleClickThrough, handleToggleLyrics]);

  // Clean up retry timer on unmount
  useEffect(() => {
    return () => {
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, []);

  /** Adjusts offset by delta and persists to localStorage. */
  const handleOffsetChange = useCallback((delta: number) => {
    setOffset((prev) => {
      const next = Math.round((prev + delta) * 10) / 10;
      localStorage.setItem('ytm_offset', next.toString());
      return next;
    });
  }, []);

  /** Resets offset to 0 and persists to localStorage. */
  const handleOffsetReset = useCallback(() => {
    setOffset(0);
    localStorage.setItem('ytm_offset', '0');
  }, []);

  const handlePlayPause = useCallback(() => {
    // Optimistic UI state toggle: instant 0ms tactile feedback
    setTrack(prev => {
      if (!prev) return prev;
      const nextState = { ...prev, isPaused: !prev.isPaused };
      latestTrackRef.current = nextState;
      return nextState;
    });
    sendPlayerCommand('playPause');
  }, [sendPlayerCommand]);
  const handleNext = useCallback(() => sendPlayerCommand('next'), [sendPlayerCommand]);
  const handlePrevious = useCallback(() => sendPlayerCommand('previous'), [sendPlayerCommand]);
  const handleToggleClickThrough = useCallback(() => toggleClickThrough(), [toggleClickThrough]);

  /** Computes index of currently highlighted lyric line based on track playback time and sync offset. */
  const activeIndex = getActiveLyricIndex(lyrics, track?.currentTime || 0, offset);

  return (
    <div
      className={`widget-container theme-${uiTheme} ${!showLyrics ? 'lyrics-hidden' : ''} ${isClickThrough ? 'is-clickthrough' : ''}`}
      data-tauri-drag-region
    >
      {uiTheme === 'liquid-glass' && <LiquidGlassCanvas albumArtUrl={track?.albumArt} />}

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
        onToggleClickThrough={handleToggleClickThrough}
        showLyrics={showLyrics}
        onToggleLyrics={handleToggleLyrics}
        onOpenSettingsWindow={handleOpenSettingsWindow}
        onPlayPause={handlePlayPause}
        onNext={handleNext}
        onPrevious={handlePrevious}
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
