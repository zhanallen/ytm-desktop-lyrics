// YT Music Lyrics Sync - Content Script (Hybrid Millisecond-Precision Calibration Engine)
(function () {
  const WS_URLS = ['ws://127.0.0.1:27890', 'ws://localhost:27890'];
  let currentWsIndex = 0;
  let socket = null;
  let reconnectTimer = null;
  let updateInterval = null;
  let statusBadge = null;
  let domObserver = null;

  let lastTrackTitle = '';
  let mseBaseOffset = 0; // Calibration base offset between video.currentTime and DOM relative song time

  let desktopAppVersion = '';
  let latestVersionTag = '';
  let updateDownloadUrl = '';
  let hasUpdateAvailable = false;

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

  async function checkDesktopAppUpdate(currentVersion) {
    if (!currentVersion) return;
    try {
      const res = await fetch('https://api.github.com/repos/zhanallen/ytm-desktop-lyrics/releases/latest');
      if (!res.ok) return;
      const data = await res.json();
      const latestTag = (data.tag_name || '').trim();
      const htmlUrl = data.html_url || 'https://github.com/zhanallen/ytm-desktop-lyrics/releases/latest';

      if (latestTag && compareSemver(currentVersion, latestTag) < 0) {
        hasUpdateAvailable = true;
        latestVersionTag = latestTag;
        updateDownloadUrl = htmlUrl;

        updateBadgeStatus(true);

        const promptKey = 'ytm_update_prompted_' + latestTag;
        if (!sessionStorage.getItem(promptKey)) {
          sessionStorage.setItem(promptKey, 'true');
          setTimeout(() => {
            if (confirm(`🎉 發現 YTM Desktop Lyrics 桌面軟體有新版本 (最新：${latestTag}，目前：v${currentVersion})！\n\n是否前往 GitHub 下載最新版本？`)) {
              window.open(htmlUrl, '_blank');
            }
          }, 800);
        }
      }
    } catch (e) {}
  }

  function handleBadgeClick() {
    if (socket && socket.readyState === WebSocket.OPEN) {
      if (hasUpdateAvailable && latestVersionTag) {
        if (confirm(`🎉 發現桌面軟體新版本 ${latestVersionTag} (目前版本：v${desktopAppVersion})！\n\n點擊【確定】前往 GitHub 下載頁面更新，點擊【取消】開啟/聚焦目前的桌面視窗。`)) {
          window.open(updateDownloadUrl || 'https://github.com/zhanallen/ytm-desktop-lyrics/releases/latest', '_blank');
          return;
        }
      }
      try {
        socket.send(JSON.stringify({ command: 'focusWindow' }));
      } catch (e) {}
      return;
    }

    // Ask user to open the desktop app
    if (confirm('是否開啟 YTM Desktop Lyrics 桌面歌詞軟體？')) {
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

      // Fallback: If still not connected after 2.5 seconds, prompt to download
      setTimeout(() => {
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          if (confirm('尚未偵測到桌面軟體連線。是否前往下載安裝 YTM Desktop Lyrics？')) {
            window.open('https://github.com/zhanallen/ytm-desktop-lyrics/releases', '_blank');
          }
        }
      }, 2500);
    }
  }

  function createStatusBadge() {
    let existing = document.getElementById('ytm-lyrics-sync-badge');
    if (existing) {
      statusBadge = existing;
    } else {
      statusBadge = document.createElement('div');
      statusBadge.id = 'ytm-lyrics-sync-badge';
      statusBadge.title = '點擊即可自動開啟 YTM Desktop Lyrics 桌面軟體';
      statusBadge.innerHTML = `
        <div class="ytm-sync-dot"></div>
        <span class="ytm-sync-text">尚未連線（點擊開啟桌面軟體）</span>
      `;
      statusBadge.addEventListener('click', handleBadgeClick);
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

  function updateBadgeStatus(connected, text) {
    if (!statusBadge) createStatusBadge();
    if (!statusBadge) return;
    const dot = statusBadge.querySelector('.ytm-sync-dot');
    const label = statusBadge.querySelector('.ytm-sync-text');
    if (connected) {
      if (hasUpdateAvailable && latestVersionTag) {
        if (dot) {
          dot.style.background = '#FFA726';
          dot.style.boxShadow = '0 0 8px #FFA726';
        }
        if (label) label.textContent = text || `已連線 (可更新 ${latestVersionTag})`;
        statusBadge.title = `發現桌面軟體新版本 ${latestVersionTag} (目前：v${desktopAppVersion})！點擊前往 GitHub 下載`;
      } else {
        if (dot) {
          dot.style.background = '#4CAF50';
          dot.style.boxShadow = '0 0 8px #4CAF50';
        }
        if (label) label.textContent = text || '已連線到桌面軟體';
        statusBadge.title = '已連線至桌面歌詞軟體 (點擊喚醒/聚焦視窗)';
      }
    } else {
      if (dot) {
        dot.style.background = '#FF5252';
        dot.style.boxShadow = '0 0 8px #FF5252';
      }
      if (label) label.textContent = text || '尚未連線（點擊開啟桌面軟體）';
      statusBadge.title = '點擊即可自動開啟 YTM Desktop Lyrics 桌面軟體';
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
        updateBadgeStatus(true, '已連線到桌面軟體');
        if (reconnectTimer) {
          clearInterval(reconnectTimer);
          reconnectTimer = null;
        }
      };

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data && data.type === 'hello' && data.version) {
            desktopAppVersion = data.version;
            checkDesktopAppUpdate(data.version);
            return;
          }
          handleIncomingCommand(data);
        } catch (e) {}
      };

      socket.onclose = () => {
        updateBadgeStatus(false, '尚未連線（點擊開啟桌面軟體）');
        currentWsIndex = (currentWsIndex + 1) % WS_URLS.length;
        scheduleReconnect();
      };

      socket.onerror = () => {
        updateBadgeStatus(false, '尚未連線（點擊開啟桌面軟體）');
      };
    } catch (e) {
      updateBadgeStatus(false, '尚未連線（點擊開啟桌面軟體）');
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
