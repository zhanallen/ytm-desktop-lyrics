// YT Music Lyrics Sync - Content Script (Hybrid Millisecond-Precision Calibration Engine)
(function () {
  // WebSocket endpoints for connecting to the Tauri desktop app
  const WS_URLS = ['ws://127.0.0.1:27890?token=ytm_sync_sec_8f9a2b7c4d5e', 'ws://localhost:27890?token=ytm_sync_sec_8f9a2b7c4d5e'];
  let currentWsIndex = 0;
  let socket = null;
  let reconnectTimer = null;
  let updateInterval = null;
  let statusBadge = null;
  let domObserver = null;

  let lastTrackTitle = '';
  let mseBaseOffset = 0; // Calibration base offset between video.currentTime and DOM relative song time

  // State variables for desktop software version detection and GitHub update checking
  let desktopAppVersion = '';
  let latestVersionTag = '';
  let updateDownloadUrl = '';
  let hasUpdateAvailable = false;

  // Internationalization (i18n) Engine: Detects user browser/system language (defaults to Traditional Chinese)
  const userLang = (navigator.language || navigator.userLanguage || 'zh-TW').toLowerCase();
  const isEn = userLang.startsWith('en');

  let launchAttempted = false;

  // Translation dictionary providing localized UI strings and interactive dialog prompts
  const t = {
    notConnected: isEn ? 'Not Connected (Click to Open)' : '尚未連線（點擊開啟桌面軟體）',
    connected: isEn ? 'Connected to Desktop App' : '已連線到桌面軟體',
    connecting: isEn ? 'Connecting...' : '正在連線...',
    downloadApp: isEn ? 'Desktop App Not Found (Click to Download)' : '未偵測到桌面軟體（點擊下載）',
    updateAvailable: (tag) => isEn ? `Connected (Update ${tag})` : `已連線 (可更新 ${tag})`,
    titleNotConnected: isEn ? 'Click to open YTM Desktop Lyrics' : '點擊即可自動開啟 YTM Desktop Lyrics 桌面軟體',
    titleConnected: isEn ? 'Connected to YTM Desktop Lyrics (Click to focus window)' : '已連線至桌面歌詞軟體 (點擊喚醒/聚焦視窗)',
    titleUpdate: (tag, cur) => isEn ? `New version ${tag} available (Current: v${cur})! Click to update` : `發現桌面軟體新版本 ${tag} (目前：v${cur})！點擊前往 GitHub 下載`,
    titleDownload: isEn ? 'Desktop app not connected. Click to visit the GitHub download page.' : '未連線到桌面軟體，點擊前往 GitHub 下載頁面',
  };

  /**
   * Helper function: Compares two semantic version strings (e.g. "1.0.1" vs "v1.1.0").
   * Returns -1 if v1 < v2, 1 if v1 > v2, and 0 if equal.
   */
  function compareSemver(v1, v2) {
    const p1 = (v1 || '').replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
    const p2 = (v2 || '').replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
      const num1 = p1[i] || 0;
      const num2 = p2[i] || 0;
      if (num1 < num2) return -1;
      if (num1 > num2) return 1;
    }
    return 0;
  }

  /**
   * Async Function: Queries GitHub Releases API to check if a newer desktop software version exists.
   * Throttled to once every 12 hours via localStorage to prevent GitHub API rate limiting (CWE-770).
   */
  async function checkDesktopAppUpdate(currentVersion) {
    if (!currentVersion) return;

    const CACHE_KEY_TIME = 'ytm_update_last_check';
    const CACHE_KEY_TAG = 'ytm_update_latest_tag';
    const CACHE_KEY_URL = 'ytm_update_download_url';
    const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

    const lastCheck = parseInt(localStorage.getItem(CACHE_KEY_TIME) || '0', 10);
    const cachedTag = localStorage.getItem(CACHE_KEY_TAG) || '';
    const cachedUrl = localStorage.getItem(CACHE_KEY_URL) || '';

    // If checked within 12 hours, use cached update state
    if (Date.now() - lastCheck < TWELVE_HOURS_MS && cachedTag) {
      if (compareSemver(currentVersion, cachedTag) < 0) {
        hasUpdateAvailable = true;
        latestVersionTag = cachedTag;
        updateDownloadUrl = cachedUrl || 'https://github.com/zhanallen/ytm-desktop-lyrics/releases/latest';
        updateBadgeStatus(true);
      }
      return;
    }

    try {
      const res = await fetch('https://api.github.com/repos/zhanallen/ytm-desktop-lyrics/releases/latest');
      if (!res.ok) return;
      const data = await res.json();
      const latestTag = (data.tag_name || '').trim();
      const rawHtmlUrl = (data.html_url || '').trim();
      const OFFICIAL_REPO_URL = 'https://github.com/zhanallen/ytm-desktop-lyrics';
      const htmlUrl = rawHtmlUrl.startsWith(OFFICIAL_REPO_URL) ? rawHtmlUrl : `${OFFICIAL_REPO_URL}/releases/latest`;

      localStorage.setItem(CACHE_KEY_TIME, Date.now().toString());
      if (latestTag) {
        localStorage.setItem(CACHE_KEY_TAG, latestTag);
        localStorage.setItem(CACHE_KEY_URL, htmlUrl);
      }

      if (latestTag && compareSemver(currentVersion, latestTag) < 0) {
        hasUpdateAvailable = true;
        latestVersionTag = latestTag;
        updateDownloadUrl = htmlUrl;

        updateBadgeStatus(true);
      }
    } catch (e) {}
  }

  /**
   * Event Handler: Processes click interactions on the header status badge.
   * - If an update is available: navigates directly to GitHub release download.
   * - If connected: sends focusWindow command over WebSocket to bring desktop app to front.
   * - If disconnected: launches desktop app via hidden iframe (custom ytm-lyrics:// protocol) and polls for connection.
   */
  function handleBadgeClick() {
    if (socket && socket.readyState === WebSocket.OPEN) {
      if (hasUpdateAvailable && latestVersionTag) {
        window.open(updateDownloadUrl || 'https://github.com/zhanallen/ytm-desktop-lyrics/releases/latest', '_blank', 'noopener,noreferrer');
        return;
      }
      try {
        socket.send(JSON.stringify({ command: 'focusWindow' }));
      } catch (e) {}
      return;
    }

    if (launchAttempted && (!socket || socket.readyState !== WebSocket.OPEN)) {
      window.open('https://github.com/zhanallen/ytm-desktop-lyrics/releases', '_blank', 'noopener,noreferrer');
      launchAttempted = false;
      return;
    }

    launchAttempted = true;
    updateBadgeStatus(false, t.connecting);

    // Launch desktop app via hidden iframe (avoids page navigation / "Leave site" warning)
    try {
      const iframe = document.createElement('iframe');
      iframe.style.display = 'none';
      iframe.src = 'ytm-lyrics://open';
      (document.body || document.documentElement).appendChild(iframe);
      setTimeout(() => {
        try { iframe.remove(); } catch (e) {}
      }, 2000);
    } catch (e) {}

    // Immediately attempt WebSocket connection and start fast polling while app launches
    connectWebSocket();
    const fastConnectTimer = setInterval(() => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        clearInterval(fastConnectTimer);
      } else {
        connectWebSocket();
      }
    }, 300);

    setTimeout(() => clearInterval(fastConnectTimer), 4000);

    // Fallback: If still not connected after 4 seconds, update badge to prompt download directly
    setTimeout(() => {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        updateBadgeStatus(false, t.downloadApp);
        if (statusBadge) {
          statusBadge.title = t.titleDownload;
        }
      }
    }, 4000);
  }

  /**
   * DOM Function: Creates the status badge element and inserts it into YouTube Music top navigation header.
   * Places the badge in `ytmusic-nav-bar #right-content` before the settings/avatar button, or falls back to body fixed position.
   */
  function createStatusBadge() {
    let existing = document.getElementById('ytm-lyrics-sync-badge');
    if (existing) {
      statusBadge = existing;
    } else {
      statusBadge = document.createElement('div');
      statusBadge.id = 'ytm-lyrics-sync-badge';
      statusBadge.title = t.titleNotConnected;
      statusBadge.setAttribute('tabindex', '0');
      statusBadge.setAttribute('role', 'button');
      statusBadge.setAttribute('aria-label', t.titleNotConnected);

      const dotEl = document.createElement('div');
      dotEl.className = 'ytm-sync-dot';

      const textEl = document.createElement('span');
      textEl.className = 'ytm-sync-text';
      textEl.textContent = t.notConnected;

      statusBadge.appendChild(dotEl);
      statusBadge.appendChild(textEl);
      statusBadge.addEventListener('click', handleBadgeClick);
      statusBadge.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleBadgeClick();
        }
      });
    }

    // Attach to YouTube Music top right header navigation bar (next to account avatar)
    const navRight = document.querySelector('ytmusic-nav-bar #right-content') ||
                     document.querySelector('ytmusic-nav-bar .right-content') ||
                     document.querySelector('#right-content') ||
                     document.querySelector('ytmusic-nav-bar');

    if (navRight) {
      if (statusBadge.parentElement !== navRight) {
        const avatarOrSettings = navRight.querySelector('ytmusic-settings-button') ||
                                 navRight.querySelector('#avatar-btn') ||
                                 navRight.querySelector('.ytmusic-settings-button');
        if (avatarOrSettings) {
          navRight.insertBefore(statusBadge, avatarOrSettings);
        } else {
          navRight.appendChild(statusBadge);
        }
      }
    } else if (!statusBadge.parentElement) {
      (document.body || document.documentElement).appendChild(statusBadge);
    }
  }

  /**
   * UI Function: Updates the status badge visual indicators (text label, tooltip, and dot indicator color).
   * - Connected (Up-to-date): Green dot (#4CAF50)
   * - Connected (Update available): Orange/Gold dot (#FFA726)
   * - Disconnected: Red dot (#FF5252)
   */
  function updateBadgeStatus(connected, text) {
    if (!statusBadge) createStatusBadge();
    if (!statusBadge) return;
    const dot = statusBadge.querySelector('.ytm-sync-dot');
    const label = statusBadge.querySelector('.ytm-sync-text');
    if (connected) {
      launchAttempted = false;
      if (hasUpdateAvailable && latestVersionTag) {
        if (dot) {
          dot.style.background = '#FFA726';
          dot.style.boxShadow = '0 0 8px #FFA726';
        }
        if (label) label.textContent = t.updateAvailable(latestVersionTag);
        const titleStr = t.titleUpdate(latestVersionTag, desktopAppVersion);
        statusBadge.title = titleStr;
        statusBadge.setAttribute('aria-label', titleStr);
      } else {
        if (dot) {
          dot.style.background = '#4CAF50';
          dot.style.boxShadow = '0 0 8px #4CAF50';
        }
        if (label) label.textContent = text || t.connected;
        statusBadge.title = t.titleConnected;
        statusBadge.setAttribute('aria-label', t.titleConnected);
      }
    } else {
      if (dot) {
        dot.style.background = '#FF5252';
        dot.style.boxShadow = '0 0 8px #FF5252';
      }
      if (label) label.textContent = text || t.notConnected;
      const titleStr = text ? text : t.titleNotConnected;
      statusBadge.title = titleStr;
      statusBadge.setAttribute('aria-label', titleStr);
    }
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

  /**
   * Network Function: Establishes a WebSocket connection to the Tauri desktop application.
   * Handles handshake messages (`type: "hello"`) containing app version, triggers update check, and manages fallback timers for legacy v1.0.1 desktop software.
   */
  function connectWebSocket() {
    if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
      return;
    }

    desktopAppVersion = '';
    latestVersionTag = '';
    updateDownloadUrl = '';
    hasUpdateAvailable = false;

    const wsUrl = WS_URLS[currentWsIndex];

    try {
      socket = new WebSocket(wsUrl);

      let helloTimeoutTimer = null;

      socket.onopen = () => {
        console.log('[YT Music Sync] Connected to Desktop Widget on', wsUrl);
        updateBadgeStatus(true);
        if (reconnectTimer) {
          clearInterval(reconnectTimer);
          reconnectTimer = null;
        }

        // Fallback for legacy v1.0.1 desktop software which doesn't send "hello" handshake
        if (helloTimeoutTimer) clearTimeout(helloTimeoutTimer);
        helloTimeoutTimer = setTimeout(() => {
          if (!desktopAppVersion) {
            desktopAppVersion = '1.0.1';
            checkDesktopAppUpdate('1.0.1');
          }
        }, 3000);
      };

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data && data.type === 'hello' && data.version) {
            if (helloTimeoutTimer) clearTimeout(helloTimeoutTimer);
            desktopAppVersion = data.version;
            checkDesktopAppUpdate(data.version);
            return;
          }
          handleIncomingCommand(data);
        } catch (e) {}
      };

      socket.onclose = () => {
        updateBadgeStatus(false);
        currentWsIndex = (currentWsIndex + 1) % WS_URLS.length;
        scheduleReconnect();
      };

      socket.onerror = () => {
        updateBadgeStatus(false);
      };
    } catch (e) {
      updateBadgeStatus(false);
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

  let lastSentData = null;
  let lastSentTime = 0;

  function sendUpdate() {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;

    const data = extractTrackData();
    if (!data || !data.title) return;

    const now = Date.now();
    // If paused and track/time haven't changed, throttle transmission to once every 1000ms
    if (
      data.isPaused &&
      lastSentData &&
      lastSentData.isPaused &&
      lastSentData.title === data.title &&
      lastSentData.artist === data.artist &&
      Math.abs(lastSentData.currentTime - data.currentTime) < 0.05 &&
      now - lastSentTime < 1000
    ) {
      return;
    }

    try {
      socket.send(JSON.stringify(data));
      lastSentData = data;
      lastSentTime = now;
    } catch (e) {}
  }

  // Setup DOM MutationObserver on ytmusic-player-bar & header
  function setupDOMObserver() {
    if (domObserver) return;

    const targetNode = document.body;

    domObserver = new MutationObserver(() => {
      createStatusBadge();
      sendUpdate();
    });

    domObserver.observe(targetNode, {
      childList: true,
      subtree: true
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
