document.addEventListener('DOMContentLoaded', () => {
  // 1. Play / Pause Button Toggle
  const playPauseBtn = document.querySelector('.playback-btn.active');
  let isPaused = false;

  if (playPauseBtn) {
    playPauseBtn.addEventListener('click', () => {
      isPaused = !isPaused;
      if (isPaused) {
        playPauseBtn.classList.remove('active');
        playPauseBtn.setAttribute('title', '播放');
        playPauseBtn.innerHTML = `
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="5 3 19 12 5 21 5 3"></polygon>
          </svg>
        `;
      } else {
        playPauseBtn.classList.add('active');
        playPauseBtn.setAttribute('title', '暫停');
        playPauseBtn.innerHTML = `
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="6" y="4" width="4" height="16"></rect>
            <rect x="14" y="4" width="4" height="16"></rect>
          </svg>
        `;
      }
    });
  }

  // 2. Settings Gear Button -> Toggle Offset Adjust Panel
  const settingsBtn = document.querySelector('.btn-settings');
  const offsetPanel = document.querySelector('.offset-panel');

  if (settingsBtn && offsetPanel) {
    settingsBtn.addEventListener('click', () => {
      const isHidden = offsetPanel.style.display === 'none';
      if (isHidden) {
        offsetPanel.style.display = 'flex';
        settingsBtn.classList.add('active');
      } else {
        offsetPanel.style.display = 'none';
        settingsBtn.classList.remove('active');
      }
    });
  }

  // 3. Offset Fine-Tuning Calculations
  let currentOffset = 0.0;
  const offsetButtons = offsetPanel ? offsetPanel.querySelectorAll('.offset-btn') : [];
  const offsetDisplayBtn = document.querySelector('.offset-reset-btn');

  const updateOffsetDisplay = () => {
    if (offsetDisplayBtn) {
      const numStr = Number(currentOffset.toFixed(2)).toString();
      const formatted = (currentOffset >= 0 ? `+${numStr}` : numStr) + 's';
      offsetDisplayBtn.textContent = formatted;
      if (settingsBtn) {
        settingsBtn.setAttribute('title', `歌詞延遲微調 (${formatted})`);
      }
    }
  };

  offsetButtons.forEach((btn, index) => {
    btn.addEventListener('click', () => {
      if (index === 0) currentOffset -= 0.5;
      else if (index === 1) currentOffset -= 0.1;
      else if (index === 2) currentOffset = 0.0;
      else if (index === 3) currentOffset += 0.1;
      else if (index === 4) currentOffset += 0.5;
      updateOffsetDisplay();
    });
  });

  // 4. Toggle Lyrics Visibility
  const toggleLyricsBtn = document.querySelector('.btn-lyrics-toggle');
  const lyricsCanvas = document.querySelector('.lyrics-canvas');
  const widgetContainer = document.querySelector('.widget-container');
  let lyricsVisible = true;

  if (toggleLyricsBtn && lyricsCanvas && widgetContainer) {
    toggleLyricsBtn.addEventListener('click', () => {
      lyricsVisible = !lyricsVisible;
      if (!lyricsVisible) {
        lyricsCanvas.style.display = 'none';
        widgetContainer.classList.add('lyrics-hidden');
        toggleLyricsBtn.classList.add('btn-subtle-muted');
        toggleLyricsBtn.setAttribute('title', '顯示動態歌詞');
      } else {
        lyricsCanvas.style.display = 'flex';
        widgetContainer.classList.remove('lyrics-hidden');
        toggleLyricsBtn.classList.remove('btn-subtle-muted');
        toggleLyricsBtn.setAttribute('title', '隱藏動態歌詞');
      }
    });
  }

  // 5. Toggle Click-through / Lock State
  const lockBtn = document.querySelector('.btn-lock-toggle');
  let isClickThrough = false;

  if (lockBtn) {
    lockBtn.addEventListener('click', () => {
      isClickThrough = !isClickThrough;
      if (isClickThrough) {
        lockBtn.classList.add('active', 'lock-active-text');
        lockBtn.innerHTML = '<span class="lock-btn-text">Alt+L</span>';
        lockBtn.setAttribute('title', '滑鼠穿透中 (按 Alt+L 解鎖)');
        widgetContainer.classList.add('is-clickthrough');
      } else {
        lockBtn.classList.remove('active', 'lock-active-text');
        lockBtn.innerHTML = `
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
            <path d="M7 11V7a5 5 0 0 1 9.9-1"></path>
          </svg>
        `;
        lockBtn.setAttribute('title', '開啟滑鼠穿透 (快捷鍵 Alt+L)');
        widgetContainer.classList.remove('is-clickthrough');
      }
    });
  }

  // 6. Interactive Lyric Line Selection
  const lyricLines = document.querySelectorAll('.ytm-lyric-line');
  const lyricsWrapper = document.querySelector('.lyrics-wrapper');

  lyricLines.forEach((line, idx) => {
    line.addEventListener('click', () => {
      lyricLines.forEach((l, i) => {
        l.classList.remove('active', 'past', 'future');
        if (i < idx) l.classList.add('past');
        else if (i === idx) l.classList.add('active');
        else l.classList.add('future');
      });

      const lineCenter = line.offsetTop + line.offsetHeight / 2;
      if (lyricsWrapper) {
        lyricsWrapper.style.transform = `translate3d(0, ${-lineCenter}px, 0)`;
      }
    });
  });
});
