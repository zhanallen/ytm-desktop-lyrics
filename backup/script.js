/**
 * Standalone UI Interactive Controller for YTM Desktop Lyrics
 * Replicates the exact React + Tauri state logic, auto-centering, wheel scrolling,
 * settings modal, translations, and dynamic visual response behaviors.
 */

document.addEventListener('DOMContentLoaded', () => {
  // ==========================================================================
  // 1. DATA & STATE STORE
  // ==========================================================================
  
  /** Sample Track Library with LRC Synced Lyrics */
  const demoTracks = [
    {
      title: "Never Gonna Give You Up",
      artist: "Rick Astley",
      albumArt: "https://lh3.googleusercontent.com/u/0/d/1_cover_rick",
      lyrics: [
        "We've known each other for so long",
        "Your heart's been aching, but you're too shy to say it",
        "Never gonna give you up",
        "Never gonna let you down",
        "Never gonna run around and desert you",
        "Never gonna make you cry",
        "Never gonna say goodbye",
        "Never gonna tell a lie and hurt you"
      ],
      activeIndex: 2
    },
    {
      title: "晴天 (Sunny Day)",
      artist: "周杰倫 (Jay Chou)",
      albumArt: "https://lh3.googleusercontent.com/u/0/d/2_cover_jay",
      lyrics: [
        "故事的小黃花 從出生那年就飄著",
        "童年的蕩鞦韆 隨記憶一直晃到現在",
        "Re So So Si Do Si La",
        "So La Si Si Si Si La Si La So",
        "吹著前奏望著天空 我想試著貼近平靜",
        "為你颳風散雨 的那一天 消失的下雨天",
        "好想再下一次 雨看你是否 依然在晴天",
        "颳風這天 我試過握著妳手"
      ],
      activeIndex: 4
    },
    {
      title: "Bohemian Rhapsody",
      artist: "Queen",
      albumArt: "https://lh3.googleusercontent.com/u/0/d/3_cover_queen",
      lyrics: [
        "Is this the real life? Is this just fantasy?",
        "Caught in a landslide, no escape from reality",
        "Open your eyes, look up to the skies and see",
        "I'm just a poor boy, I need no sympathy",
        "Because I'm easy come, easy go, little high, little low",
        "Any way the wind blows doesn't really matter to me, to me"
      ],
      activeIndex: 1
    }
  ];

  /** Translations Dictionary */
  const translations = {
    'zh-TW': {
      ytMusic: 'YouTube Music',
      notPlaying: '未在播放',
      prevSong: '上一首',
      play: '播放',
      pause: '暫停',
      nextSong: '下一首',
      hideLyrics: '隱藏動態歌詞 (保留播放器與封面)',
      showLyrics: '顯示動態歌詞',
      clickThroughActive: '滑鼠穿透中 (按 Alt+L 解鎖)',
      clickThroughInactive: '開啟滑鼠穿透 (快捷鍵 Alt+L)',
      searchingLyrics: '搜尋動態歌詞中...',
      noLyricsFound: '暫無動態歌詞',
      pleasePlayYtMusic: '請在 YouTube Music 播放歌曲',
      preferencesTitle: '偏好設定',
      close: '關閉',
      syncOffsetTitle: '歌詞時間軸微調 (Sync Offset)',
      reset: '重置',
      resetToZero: '重置為 0.0s',
      widgetTogglesTitle: '懸浮窗狀態切換',
      clickThroughMode: '滑鼠點擊穿透',
      lyricsShown: '歌詞顯示中',
      lyricsHidden: '歌詞已隱藏',
      languageSettingsTitle: '語言設定 (Language)',
      systemDefault: '系統預設',
      zhTW: '繁體中文',
      enUS: 'English',
      globalHotkeysTitle: '全域快速鍵 (Global Hotkeys)',
      hotkeyClickThrough: '切換滑鼠穿透模式',
      hotkeyLyricsToggle: '切換動態歌詞顯示',
    },
    'en': {
      ytMusic: 'YouTube Music',
      notPlaying: 'Not Playing',
      prevSong: 'Previous',
      play: 'Play',
      pause: 'Pause',
      nextSong: 'Next',
      hideLyrics: 'Hide Lyrics (Keep Player & Cover)',
      showLyrics: 'Show Lyrics',
      clickThroughActive: 'Click-Through Active (Alt+L)',
      clickThroughInactive: 'Enable Click-Through (Alt+L)',
      searchingLyrics: 'Searching for synced lyrics...',
      noLyricsFound: 'No synced lyrics available',
      pleasePlayYtMusic: 'Please play music on YouTube Music',
      preferencesTitle: 'Preferences',
      close: 'Close',
      syncOffsetTitle: 'Lyric Sync Offset',
      reset: 'Reset',
      resetToZero: 'Reset to 0.0s',
      widgetTogglesTitle: 'Widget Toggles',
      clickThroughMode: 'Click-Through',
      lyricsShown: 'Lyrics Shown',
      lyricsHidden: 'Lyrics Hidden',
      languageSettingsTitle: 'Language',
      systemDefault: 'System Auto',
      zhTW: '繁體中文',
      enUS: 'English',
      globalHotkeysTitle: 'Global Hotkeys',
      hotkeyClickThrough: 'Toggle Click-Through Mode',
      hotkeyLyricsToggle: 'Toggle Lyrics Display',
    }
  };

  /** Current UI App State */
  const state = {
    currentTrackIndex: 0,
    isPaused: false,
    showLyrics: true,
    isClickThrough: false,
    offset: 0.0,
    langMode: 'zh-TW',
    uiState: 'normal', // 'normal' | 'searching' | 'waiting' | 'nolyrics'
    translateY: 0,
    manualOffset: 0
  };

  let userScrollTimeout = null;

  // ==========================================================================
  // 2. DOM ELEMENTS SELECTION
  // ==========================================================================
  const container = document.querySelector('.widget-container');
  const trackTitle = document.querySelector('.track-title');
  const trackArtist = document.querySelector('.track-artist');
  const playPauseBtn = document.querySelector('.playback-btn.active');
  const prevBtn = document.querySelectorAll('.playback-btn')[0];
  const nextBtn = document.querySelectorAll('.playback-btn')[2];
  const settingsBtn = document.querySelector('.btn-settings');
  const toggleLyricsBtn = document.querySelector('.btn-lyrics-toggle');
  const lockBtn = document.querySelector('.btn-lock-toggle');
  const lyricsCanvas = document.querySelector('.lyrics-canvas');
  const lyricsWrapper = document.querySelector('.lyrics-wrapper');

  // Modal elements
  const modalBackdrop = document.querySelector('.settings-modal-backdrop');
  const modalCloseBtn = document.querySelector('.settings-close-btn');
  const modalOffsetVal = document.querySelector('.offset-value');
  const modalOffsetResetBtn = document.querySelector('.offset-reset-btn');
  const modalOffsetActionBtns = document.querySelectorAll('.modal-action-btn');
  const modalClickThroughBtn = document.querySelectorAll('.modal-toggle-btn')[0];
  const modalLyricsToggleBtn = document.querySelectorAll('.modal-toggle-btn')[1];
  const modalLangBtns = document.querySelectorAll('.settings-section')[2]?.querySelectorAll('.modal-toggle-btn');

  // ==========================================================================
  // 3. MATERIAL SPOTLIGHT / CAUSTIC LIGHT TRACKING
  // ==========================================================================
  if (container) {
    container.addEventListener('mousemove', (e) => {
      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      container.style.setProperty('--mouse-x', `${x}px`);
      container.style.setProperty('--mouse-y', `${y}px`);
    });
  }

  // ==========================================================================
  // 4. RENDERING & UI SYNC ENGINE
  // ==========================================================================

  /** Returns translation string object for active language mode */
  function getT() {
    return translations[state.langMode] || translations['zh-TW'];
  }

  /** Render Track Meta (Title, Artist, Covers) */
  function renderTrackMeta() {
    const track = demoTracks[state.currentTrackIndex];
    if (trackTitle) {
      trackTitle.textContent = track.title;
      trackTitle.setAttribute('title', track.title);
    }
    if (trackArtist) {
      trackArtist.textContent = track.artist;
      trackArtist.setAttribute('title', track.artist);
    }
  }

  /** Render Lyrics Lines & Handle Auto Centering */
  function renderLyrics() {
    if (!lyricsCanvas || !lyricsWrapper) return;

    const t = getT();

    if (state.uiState === 'searching') {
      lyricsCanvas.innerHTML = `
        <div class="status-state">
          <div class="pulse-dot"></div>
          <span>${t.searchingLyrics}</span>
        </div>
      `;
      return;
    }

    if (state.uiState === 'waiting') {
      lyricsCanvas.innerHTML = `
        <div class="status-state">
          <span>${t.pleasePlayYtMusic}</span>
        </div>
      `;
      return;
    }

    if (state.uiState === 'nolyrics') {
      lyricsCanvas.innerHTML = `
        <div class="status-state">
          <span>${t.noLyricsFound}</span>
        </div>
      `;
      return;
    }

    // Normal State: Render lyrics wrapper
    const track = demoTracks[state.currentTrackIndex];
    lyricsCanvas.innerHTML = '';
    const wrapper = document.createElement('div');
    wrapper.className = 'lyrics-wrapper';
    
    track.lyrics.forEach((lineText, idx) => {
      const lineEl = document.createElement('div');
      const isActive = idx === track.activeIndex;
      const isPast = idx < track.activeIndex;
      
      lineEl.className = `ytm-lyric-line ${isActive ? 'active' : isPast ? 'past' : 'future'}`;
      lineEl.textContent = lineText;

      lineEl.addEventListener('click', () => {
        track.activeIndex = idx;
        state.manualOffset = 0;
        renderLyrics();
      });

      wrapper.appendChild(lineEl);
    });

    lyricsCanvas.appendChild(wrapper);

    // Dynamic Line Height Midpoint Calculation & Vertical Translation
    requestAnimationFrame(() => {
      const lines = wrapper.querySelectorAll('.ytm-lyric-line');
      const activeEl = lines[track.activeIndex];
      if (activeEl) {
        const lineCenter = activeEl.offsetTop + activeEl.offsetHeight / 2;
        state.translateY = -lineCenter;
        applyTransform(wrapper);
      }
    });
  }

  /** Applies combined translateY + manualScrollOffset */
  function applyTransform(targetWrapper) {
    const wrapper = targetWrapper || lyricsCanvas?.querySelector('.lyrics-wrapper');
    if (wrapper) {
      const totalY = state.translateY + state.manualOffset;
      wrapper.style.transform = `translate3d(0, ${totalY}px, 0)`;
    }
  }

  /** Update Play/Pause Button Icon and State */
  function updatePlayPauseUI() {
    if (!playPauseBtn) return;
    const t = getT();

    if (state.isPaused) {
      playPauseBtn.classList.remove('active');
      playPauseBtn.setAttribute('title', t.play);
      playPauseBtn.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="5 3 19 12 5 21 5 3"></polygon>
        </svg>
      `;
    } else {
      playPauseBtn.classList.add('active');
      playPauseBtn.setAttribute('title', t.pause);
      playPauseBtn.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="6" y="4" width="4" height="16"></rect>
          <rect x="14" y="4" width="4" height="16"></rect>
        </svg>
      `;
    }
  }

  /** Update Lyrics Display Visibility & Compact Mode Height */
  function updateLyricsVisibilityUI() {
    if (!container || !toggleLyricsBtn || !lyricsCanvas) return;
    const t = getT();

    if (!state.showLyrics) {
      container.classList.add('lyrics-hidden');
      toggleLyricsBtn.classList.add('btn-subtle-muted');
      toggleLyricsBtn.setAttribute('title', t.showLyrics);
      toggleLyricsBtn.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
          <line x1="1" y1="1" x2="23" y2="23"></line>
        </svg>
      `;
    } else {
      container.classList.remove('lyrics-hidden');
      toggleLyricsBtn.classList.remove('btn-subtle-muted');
      toggleLyricsBtn.setAttribute('title', t.hideLyrics);
      toggleLyricsBtn.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
          <circle cx="12" cy="12" r="3"></circle>
        </svg>
      `;
    }
  }

  /** Update Click-Through Mode Class & Button State */
  function updateClickThroughUI() {
    if (!container || !lockBtn) return;
    const t = getT();

    if (state.isClickThrough) {
      container.classList.add('is-clickthrough');
      lockBtn.classList.add('active', 'lock-active-text');
      lockBtn.innerHTML = '<span class="lock-btn-text">Alt+L</span>';
      lockBtn.setAttribute('title', t.clickThroughActive);
    } else {
      container.classList.remove('is-clickthrough');
      lockBtn.classList.remove('active', 'lock-active-text');
      lockBtn.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
          <path d="M7 11V7a5 5 0 0 1 9.9-1"></path>
        </svg>
      `;
      lockBtn.setAttribute('title', t.clickThroughInactive);
    }
  }

  /** Update Offset String Format & Tooltip */
  function updateOffsetUI() {
    const numStr = Number(state.offset.toFixed(2)).toString();
    const formatted = (state.offset >= 0 ? `+${numStr}` : numStr) + 's';
    
    if (modalOffsetVal) modalOffsetVal.textContent = formatted;
    if (settingsBtn) settingsBtn.setAttribute('title', `歌詞延遲微調 (${formatted})`);
  }

  /** Refresh Modal Controls to match App State */
  function updateModalUI() {
    updateOffsetUI();
    const t = getT();

    if (modalClickThroughBtn) {
      modalClickThroughBtn.classList.toggle('active', state.isClickThrough);
    }
    if (modalLyricsToggleBtn) {
      modalLyricsToggleBtn.classList.toggle('active', state.showLyrics);
      modalLyricsToggleBtn.classList.toggle('btn-subtle-muted', !state.showLyrics);
      const label = modalLyricsToggleBtn.querySelector('span:first-child');
      if (label) label.textContent = state.showLyrics ? t.lyricsShown : t.lyricsHidden;
    }

    if (modalLangBtns) {
      modalLangBtns[0]?.classList.toggle('active', state.langMode === 'system');
      modalLangBtns[1]?.classList.toggle('active', state.langMode === 'zh-TW');
      modalLangBtns[2]?.classList.toggle('active', state.langMode === 'en');
    }
  }

  // ==========================================================================
  // 5. MOUSE WHEEL MANUAL SCROLLING & AUTO SNAP BACK
  // ==========================================================================
  if (lyricsCanvas) {
    lyricsCanvas.addEventListener('wheel', (e) => {
      if (state.uiState !== 'normal') return;
      state.manualOffset -= e.deltaY * 0.6;
      applyTransform();

      if (userScrollTimeout) clearTimeout(userScrollTimeout);

      // Auto snap back to 0 manual offset after 3s of inactivity
      userScrollTimeout = setTimeout(() => {
        state.manualOffset = 0;
        applyTransform();
      }, 3000);
    });
  }

  // ==========================================================================
  // 6. EVENT LISTENERS & CONTROL HANDLERS
  // ==========================================================================

  // Play / Pause Button
  if (playPauseBtn) {
    playPauseBtn.addEventListener('click', () => {
      state.isPaused = !state.isPaused;
      updatePlayPauseUI();
    });
  }

  // Previous Song
  if (prevBtn) {
    prevBtn.addEventListener('click', () => {
      state.currentTrackIndex = (state.currentTrackIndex - 1 + demoTracks.length) % demoTracks.length;
      state.manualOffset = 0;
      renderTrackMeta();
      renderLyrics();
    });
  }

  // Next Song
  if (nextBtn) {
    nextBtn.addEventListener('click', () => {
      state.currentTrackIndex = (state.currentTrackIndex + 1) % demoTracks.length;
      state.manualOffset = 0;
      renderTrackMeta();
      renderLyrics();
    });
  }

  // Toggle Lyrics Display
  if (toggleLyricsBtn) {
    toggleLyricsBtn.addEventListener('click', () => {
      state.showLyrics = !state.showLyrics;
      updateLyricsVisibilityUI();
      updateModalUI();
    });
  }

  // Toggle Click-Through Mode
  if (lockBtn) {
    lockBtn.addEventListener('click', () => {
      state.isClickThrough = !state.isClickThrough;
      updateClickThroughUI();
      updateModalUI();
    });
  }

  // Settings Gear Button -> Open Settings Modal
  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
      if (modalBackdrop) {
        updateModalUI();
        modalBackdrop.classList.add('open');
      }
    });
  }

  // Close Settings Modal
  if (modalCloseBtn) {
    modalCloseBtn.addEventListener('click', () => {
      if (modalBackdrop) modalBackdrop.classList.remove('open');
    });
  }
  if (modalBackdrop) {
    modalBackdrop.addEventListener('click', (e) => {
      if (e.target === modalBackdrop) modalBackdrop.classList.remove('open');
    });
  }

  // Offset Adjustments inside Modal
  if (modalOffsetResetBtn) {
    modalOffsetResetBtn.addEventListener('click', () => {
      state.offset = 0.0;
      updateOffsetUI();
    });
  }

  if (modalOffsetActionBtns) {
    const deltas = [-0.5, -0.1, 0.1, 0.5];
    modalOffsetActionBtns.forEach((btn, idx) => {
      btn.addEventListener('click', () => {
        state.offset = Math.round((state.offset + deltas[idx]) * 10) / 10;
        updateOffsetUI();
      });
    });
  }

  // Modal Toggle Click-Through & Lyrics
  if (modalClickThroughBtn) {
    modalClickThroughBtn.addEventListener('click', () => {
      state.isClickThrough = !state.isClickThrough;
      updateClickThroughUI();
      updateModalUI();
    });
  }
  if (modalLyricsToggleBtn) {
    modalLyricsToggleBtn.addEventListener('click', () => {
      state.showLyrics = !state.showLyrics;
      updateLyricsVisibilityUI();
      updateModalUI();
    });
  }

  // Modal Language Switcher
  if (modalLangBtns) {
    const modes = ['system', 'zh-TW', 'en'];
    modalLangBtns.forEach((btn, idx) => {
      btn.addEventListener('click', () => {
        state.langMode = modes[idx];
        renderTrackMeta();
        renderLyrics();
        updatePlayPauseUI();
        updateLyricsVisibilityUI();
        updateClickThroughUI();
        updateModalUI();
      });
    });
  }

  // Global Hotkeys (Alt+L & Alt+V)
  window.addEventListener('keydown', (e) => {
    if (e.altKey && (e.key === 'l' || e.key === 'L')) {
      e.preventDefault();
      state.isClickThrough = !state.isClickThrough;
      updateClickThroughUI();
      updateModalUI();
    } else if (e.altKey && (e.key === 'v' || e.key === 'V')) {
      e.preventDefault();
      state.showLyrics = !state.showLyrics;
      updateLyricsVisibilityUI();
      updateModalUI();
    } else if (e.key === 'Escape') {
      if (modalBackdrop) modalBackdrop.classList.remove('open');
    }
  });

  // ==========================================================================
  // 7. UI TEST DOCK CONTROLS (FOR VISUAL TESTING & ADJUSTMENTS)
  // ==========================================================================
  const dockSongBtns = document.querySelectorAll('[data-dock-song]');
  const dockStateBtns = document.querySelectorAll('[data-dock-state]');
  const dockLangBtns = document.querySelectorAll('[data-dock-lang]');

  dockSongBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      dockSongBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.currentTrackIndex = parseInt(btn.getAttribute('data-dock-song'), 10);
      state.manualOffset = 0;
      renderTrackMeta();
      renderLyrics();
    });
  });

  dockStateBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      dockStateBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.uiState = btn.getAttribute('data-dock-state');
      renderLyrics();
    });
  });

  dockLangBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      dockLangBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.langMode = btn.getAttribute('data-dock-lang');
      renderTrackMeta();
      renderLyrics();
      updatePlayPauseUI();
      updateLyricsVisibilityUI();
      updateClickThroughUI();
      updateModalUI();
    });
  });

  // ==========================================================================
  // 8. INITIAL MOUNT DISPATCH
  // ==========================================================================
  renderTrackMeta();
  renderLyrics();
  updatePlayPauseUI();
  updateLyricsVisibilityUI();
  updateClickThroughUI();
  updateOffsetUI();
});
