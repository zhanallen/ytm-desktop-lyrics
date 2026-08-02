import React, { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, emit } from '@tauri-apps/api/event';
import { parseLrc, getActiveLyricIndex, LyricLine } from './utils/lrcParser';
import { fetchLyrics } from './services/lrclib';
import { ControlPanel } from './components/ControlPanel';
import { LyricsViewer } from './components/LyricsViewer';
import { SettingsPage } from './components/SettingsPage';

interface TrackPayload {
  title: string;
  artist: string;
  albumArt?: string;
  currentTime: number;
  duration: number;
  isPaused: boolean;
  timestamp: number;
}

export const App: React.FC = () => {
  // Check if current window route is the settings window
  const isSettingsRoute =
    window.location.search.includes('window=settings') ||
    window.location.hash.includes('settings') ||
    window.location.href.includes('window=settings');

  if (isSettingsRoute) {
    return <SettingsPage />;
  }

  return <MainWidgetApp />;
};

const MainWidgetApp: React.FC = () => {
  const [track, setTrack] = useState<TrackPayload | null>(null);
  const [lyrics, setLyrics] = useState<LyricLine[]>([]);
  const [isLoadingLyrics, setIsLoadingLyrics] = useState<boolean>(false);
  const [offset, setOffset] = useState<number>(0);
  const [isClickThrough, setIsClickThrough] = useState<boolean>(false);
  const [showLyrics, setShowLyrics] = useState<boolean>(true);

  const currentSongRef = useRef<string>('');
  const latestTrackRef = useRef<TrackPayload | null>(null);
  const isClickThroughRef = useRef<boolean>(false);
  const showLyricsRef = useRef<boolean>(true);
  const offsetRef = useRef<number>(0);
  
  // Real-time Memory for Expanded Window Height in Physical Pixels (Default 560px)
  const savedExpandedHeightRef = useRef<number>(560);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    isClickThroughRef.current = isClickThrough;
  }, [isClickThrough]);

  useEffect(() => {
    showLyricsRef.current = showLyrics;
  }, [showLyrics]);

  useEffect(() => {
    offsetRef.current = offset;
  }, [offset]);

  const lastMinHeightRef = useRef<number>(0);
  const isInitialMountRef = useRef<boolean>(true);

  // Broadcast current state to Settings window whenever it asks
  const broadcastStateToSettings = () => {
    emit('sync-settings-state', {
      offset: offsetRef.current,
      isClickThrough: isClickThroughRef.current,
      showLyrics: showLyricsRef.current,
    });
  };

  // Continuously update savedExpandedHeightRef using Math.floor
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

  // Synchronize live DOM header height directly with Win32 WM_SIZING hook (Original Guard Unchanged)
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

  // Clean single-send command dispatch
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

  // Toggle lyrics using Math.floor (無條件捨去) for guaranteed subpixel stability
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

  // Handle incoming track payload with Instant Real-Time Re-alignment
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

  const handleOpenSettingsWindow = async () => {
    try {
      await invoke('open_settings_window');
    } catch (err) {
      console.warn('Open settings window error:', err);
    }
  };

  useEffect(() => {
    let unlistenUpdate: (() => void) | null = null;
    let unlistenShortcut: (() => void) | null = null;
    let unlistenToggleLyrics: (() => void) | null = null;
    let unlistenReqState: (() => void) | null = null;
    let unlistenOffsetDelta: (() => void) | null = null;
    let unlistenResetOffset: (() => void) | null = null;
    let unlistenClickThroughCmd: (() => void) | null = null;
    let unlistenLyricsCmd: (() => void) | null = null;

    const setupTauriListeners = async () => {
      try {
        unlistenUpdate = await listen<string>('yt-music-update', (event) => {
          try {
            const data: TrackPayload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
            handleUpdatePayload(data);
          } catch (e) {}
        });

        unlistenShortcut = await listen('toggle-click-through', () => {
          toggleClickThrough();
        });

        unlistenToggleLyrics = await listen('toggle-lyrics-visibility', () => {
          handleToggleLyrics();
        });

        // Listen for requests & commands from Secondary Settings Window
        unlistenReqState = await listen('request-settings-state', () => {
          broadcastStateToSettings();
        });

        unlistenOffsetDelta = await listen<number>('change-offset-delta', (event) => {
          setOffset((prev) => {
            const next = Math.round((prev + event.payload) * 10) / 10;
            return next;
          });
        });

        unlistenResetOffset = await listen('reset-offset', () => {
          setOffset(0);
        });

        unlistenClickThroughCmd = await listen('toggle-click-through-cmd', () => {
          toggleClickThrough();
        });

        unlistenLyricsCmd = await listen('toggle-lyrics-cmd', () => {
          handleToggleLyrics();
        });
      } catch (e) {}
    };

    const connectDirectWs = () => {
      try {
        const ws = new WebSocket('ws://127.0.0.1:27890');
        wsRef.current = ws;

        ws.onmessage = (msg) => {
          try {
            const data = JSON.parse(msg.data);
            if (data.title) {
              handleUpdatePayload(data);
            }
          } catch (err) {}
        };
        ws.onclose = () => {
          setTimeout(connectDirectWs, 2000);
        };
      } catch (err) {
        setTimeout(connectDirectWs, 2000);
      }
    };

    setupTauriListeners();
    connectDirectWs();

    return () => {
      if (unlistenUpdate) unlistenUpdate();
      if (unlistenShortcut) unlistenShortcut();
      if (unlistenToggleLyrics) unlistenToggleLyrics();
      if (unlistenReqState) unlistenReqState();
      if (unlistenOffsetDelta) unlistenOffsetDelta();
      if (unlistenResetOffset) unlistenResetOffset();
      if (unlistenClickThroughCmd) unlistenClickThroughCmd();
      if (unlistenLyricsCmd) unlistenLyricsCmd();
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  const handleOffsetChange = (delta: number) => {
    setOffset((prev) => Math.round((prev + delta) * 10) / 10);
  };

  const handleOffsetReset = () => {
    setOffset(0);
  };

  // Compute active lyric line index
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
        />
      )}
    </div>
  );
};

export default App;
