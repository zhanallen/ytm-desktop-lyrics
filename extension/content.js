// YT Music Lyrics Sync - Content Script (Hybrid Millisecond-Precision Calibration Engine)
(function () {
  const WS_URLS = ['ws://127.0.0.1:27890', 'ws://localhost:27890'];
  let currentWsIndex = 0;
  let socket = null;
  let reconnectTimer = null;
  let updateInterval = null;
  let statusBadge = null;
  let badgeResetTimer = null;
  let domObserver = null;

  let lastTrackTitle = '';
  let mseBaseOffset = 0; // Calibration base offset between video.currentTime and DOM relative song time

  function createStatusBadge() {
    if (document.getElementById('ytm-lyrics-sync-badge')) {
      statusBadge = document.getElementById('ytm-lyrics-sync-badge');
      return;
    }

    statusBadge = document.createElement('div');
    statusBadge.id = 'ytm-lyrics-sync-badge';
    statusBadge.innerHTML = `
      <div class="ytm-sync-dot"></div>
      <span class="ytm-sync-text">Lyrics Sync: Connecting...</span>
    `;
    (document.body || document.documentElement).appendChild(statusBadge);
  }

  function updateBadgeStatus(connected, text) {
    if (!statusBadge) createStatusBadge();
    if (!statusBadge) return;
    const dot = statusBadge.querySelector('.ytm-sync-dot');
    const label = statusBadge.querySelector('.ytm-sync-text');
    if (connected) {
      if (dot) {
        dot.style.background = '#4CAF50';
        dot.style.boxShadow = '0 0 8px #4CAF50';
      }
      if (label) label.textContent = text || 'Lyrics Sync: Active';
    } else {
      if (dot) {
        dot.style.background = '#FF5252';
        dot.style.boxShadow = '0 0 8px #FF5252';
      }
      if (label) label.textContent = text || 'Lyrics Sync: Disconnected';
    }
  }

  function showReceivedFeedback(cmdName) {
    updateBadgeStatus(true, `Lyrics Sync: [${cmdName}]`);
    if (badgeResetTimer) clearTimeout(badgeResetTimer);
    badgeResetTimer = setTimeout(() => {
      updateBadgeStatus(true, 'Lyrics Sync: Active');
    }, 1200);
  }

  // Convert time string "1:23 / 3:45" to relative seconds
  function parseTimeText(text) {
    if (!text) return null;
    const parts = text.split('/');
    if (parts.length < 2) return null;

    function timeStrToSeconds(str) {
      const clean = str.trim();
      const p = clean.split(':').map(n => parseInt(n, 10));
      if (p.length === 2 && !isNaN(p[0]) && !isNaN(p[1])) return p[0] * 60 + p[1];
      if (p.length === 3 && !isNaN(p[0]) && !isNaN(p[1]) && !isNaN(p[2])) return p[0] * 3600 + p[1] * 60 + p[2];
      return null;
    }

    const currSec = timeStrToSeconds(parts[0]);
    const durSec = timeStrToSeconds(parts[1]);

    if (currSec !== null && durSec !== null) {
      return { currentTime: currSec, duration: durSec };
    }
    return null;
  }

  // Find the exact active playing <video> element on YouTube Music
  function getActiveVideoElement() {
    const videos = Array.from(document.querySelectorAll('video'));
    if (videos.length === 0) return null;
    return videos.find(v => !v.paused && v.currentTime > 0) ||
           videos.find(v => v.src && v.duration > 0) ||
           videos[0];
  }

  // Convert low-res Google CDN thumbnail URLs to HD 512x512 Crisp Artwork
  function getHighResArtworkUrl(url) {
    if (!url) return '';
    return url
      .replace(/=w\d+-h\d+/, '=w512-h512')
      .replace(/=s\d+/, '=s512')
      .replace(/=w\d+/, '=w512')
      .replace(/\/s\d+-c\//, '/s512-c/')
      .replace(/\/s\d+\//, '/s512/');
  }

  // Clean Single-Channel Player Control Engine
  function handleIncomingCommand(data) {
    if (!data || !data.command) return;

    console.log('[YT Music Sync] Executing single-channel command:', data.command);
    showReceivedFeedback(data.command);

    if (data.command === 'playPause') {
      const playBtn = document.querySelector('ytmusic-player-bar #play-pause-button') ||
                      document.querySelector('#play-pause-button') ||
                      document.querySelector('.play-pause-button');
      if (playBtn) {
        const btn = playBtn.querySelector('button') || playBtn.querySelector('tp-yt-paper-icon-button') || playBtn;
        if (typeof btn.click === 'function') {
          btn.click();
          return;
        }
      }

      const v = getActiveVideoElement();
      if (v) {
        if (v.paused) {
          v.play().catch(() => {});
        } else {
          v.pause();
        }
      }

    } else if (data.command === 'next') {
      const nextBtn = document.querySelector('ytmusic-player-bar #next-button') ||
                      document.querySelector('#next-button') ||
                      document.querySelector('.next-button');
      if (nextBtn) {
        const btn = nextBtn.querySelector('button') || nextBtn.querySelector('tp-yt-paper-icon-button') || nextBtn;
        if (typeof btn.click === 'function') {
          btn.click();
          return;
        }
      }

    } else if (data.command === 'previous') {
      const prevBtn = document.querySelector('ytmusic-player-bar #previous-button') ||
                      document.querySelector('#previous-button') ||
                      document.querySelector('.previous-button');
      if (prevBtn) {
        const btn = prevBtn.querySelector('button') || prevBtn.querySelector('tp-yt-paper-icon-button') || prevBtn;
        if (typeof btn.click === 'function') {
          btn.click();
          return;
        }
      }
    }
  }

  // Connect to Tauri WebSocket Server
  function connectWebSocket() {
    if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
      return;
    }

    const wsUrl = WS_URLS[currentWsIndex];

    try {
      socket = new WebSocket(wsUrl);

      socket.onopen = () => {
        console.log('[YT Music Sync] Connected to Desktop Widget on', wsUrl);
        updateBadgeStatus(true, 'Lyrics Sync: Connected');
        if (reconnectTimer) {
          clearInterval(reconnectTimer);
          reconnectTimer = null;
        }
      };

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          handleIncomingCommand(data);
        } catch (e) {}
      };

      socket.onclose = () => {
        updateBadgeStatus(false, 'Lyrics Sync: Reconnecting...');
        currentWsIndex = (currentWsIndex + 1) % WS_URLS.length;
        scheduleReconnect();
      };

      socket.onerror = () => {
        updateBadgeStatus(false, 'Lyrics Sync: Error');
      };
    } catch (e) {
      updateBadgeStatus(false, 'Lyrics Sync: Error');
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    if (!reconnectTimer) {
      reconnectTimer = setInterval(() => {
        connectWebSocket();
      }, 2000);
    }
  }

  // Extract track data with Hybrid Millisecond-Precision Calibration Engine
  function extractTrackData() {
    const video = getActiveVideoElement();
    if (!video) return null;

    let title = '';
    let artist = '';
    let albumArt = '';

    // Direct DOM extraction
    const titleEl = document.querySelector('ytmusic-player-bar .title') ||
                    document.querySelector('.title.ytmusic-player-bar') ||
                    document.querySelector('ytmusic-player-bar .middle-controls .title');
    if (titleEl) {
      title = (titleEl.textContent || titleEl.getAttribute('title') || '').trim();
    }

    const bylineEl = document.querySelector('ytmusic-player-bar .byline') ||
                     document.querySelector('.byline.ytmusic-player-bar') ||
                     document.querySelector('ytmusic-player-bar .subtitle');
    if (bylineEl) {
      const artistLinks = bylineEl.querySelectorAll('a');
      if (artistLinks.length > 0) {
        artist = Array.from(artistLinks).map(a => a.textContent.trim()).filter(Boolean).join(', ');
      } else {
        artist = bylineEl.textContent.trim().split('•')[0].trim();
      }
    }

    // MediaSession fallback
    if (!title && navigator.mediaSession && navigator.mediaSession.metadata) {
      title = navigator.mediaSession.metadata.title || '';
    }
    if (!artist && navigator.mediaSession && navigator.mediaSession.metadata) {
      artist = navigator.mediaSession.metadata.artist || '';
    }

    // Album Art
    if (navigator.mediaSession && navigator.mediaSession.metadata && navigator.mediaSession.metadata.artwork) {
      const artList = navigator.mediaSession.metadata.artwork;
      if (artList.length > 0) {
        albumArt = artList[artList.length - 1].src || '';
      }
    }
    if (!albumArt) {
      const imgEl = document.querySelector('ytmusic-player-bar img#img') ||
                    document.querySelector('ytmusic-player-bar img.image');
      albumArt = imgEl ? (imgEl.src || '') : '';
    }

    albumArt = getHighResArtworkUrl(albumArt);

    const videoSec = video.currentTime || 0;
    let duration = video.duration || 0;

    // Read DOM relative time text (e.g. "1:23 / 3:45")
    const timeInfoEl = document.querySelector('ytmusic-player-bar .time-info') ||
                       document.querySelector('.time-info.ytmusic-player-bar') ||
                       document.querySelector('#time-info');
    const parsedTime = timeInfoEl ? parseTimeText(timeInfoEl.textContent) : null;

    // Detect Song Switch or Seek Calibration:
    if (title && title !== lastTrackTitle) {
      lastTrackTitle = title;
      const domSec = parsedTime ? parsedTime.currentTime : 0;
      mseBaseOffset = videoSec - domSec;
    } else if (parsedTime) {
      duration = parsedTime.duration || duration;
      const currentCalculated = videoSec - mseBaseOffset;
      // If user manually seeked (drift > 2 seconds), recalibrate base offset instantly
      if (Math.abs(currentCalculated - parsedTime.currentTime) > 2) {
        mseBaseOffset = videoSec - parsedTime.currentTime;
      }
    }

    // High-Precision Millisecond Progress = video.currentTime - calibrated MSE offset
    let highPrecisionTime = Math.max(0, videoSec - mseBaseOffset);

    // If duration exists, clamp to duration
    if (duration > 0 && highPrecisionTime > duration) {
      highPrecisionTime = duration;
    }

    return {
      title: title || '',
      artist: artist || '',
      albumArt: albumArt,
      currentTime: highPrecisionTime,
      duration: duration,
      isPaused: video.paused,
      timestamp: Date.now()
    };
  }

  function sendUpdate() {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;

    const data = extractTrackData();
    if (!data || !data.title) return;

    try {
      socket.send(JSON.stringify(data));
    } catch (e) {}
  }

  // Setup DOM MutationObserver on ytmusic-player-bar
  function setupDOMObserver() {
    if (domObserver) return;

    const targetNode = document.querySelector('ytmusic-player-bar');
    if (!targetNode) {
      setTimeout(setupDOMObserver, 1000);
      return;
    }

    domObserver = new MutationObserver(() => {
      sendUpdate();
    });

    domObserver.observe(targetNode, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true
    });
  }

  function init() {
    createStatusBadge();
    connectWebSocket();
    setupDOMObserver();

    // Broadcast track progress every 100ms
    if (updateInterval) clearInterval(updateInterval);
    updateInterval = setInterval(sendUpdate, 100);

    document.addEventListener('play', sendUpdate, true);
    document.addEventListener('pause', sendUpdate, true);
    document.addEventListener('seeked', sendUpdate, true);
    document.addEventListener('timeupdate', sendUpdate, true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
