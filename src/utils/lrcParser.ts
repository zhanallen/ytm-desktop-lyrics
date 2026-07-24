export interface LyricLine {
  time: number; // in seconds
  text: string;
}

/**
 * Advanced Ultra-Robust LRC Parser
 * Supports:
 * - Single/multi-digit minutes/hours [1:23.45], [01:23.45], [01:02:03.45]
 * - Multi-timestamp per line [01:02.30][02:14.50]Chorus line
 * - File header offsets [offset:+500] or [offset:-300]
 * - Colon/dot fraction separators [01:23:45] / [01:23.45]
 * - Clean metadata tag filtering ([ti:], [ar:], etc.)
 */
export function parseLrc(lrcText: string): LyricLine[] {
  if (!lrcText) return [];

  const rawLines = lrcText.split(/\r?\n/);
  const result: LyricLine[] = [];
  let internalOffsetMs = 0;

  // Regex to extract [offset:+/-xxx]
  const offsetHeaderRegex = /^\[offset:\s*([+-]?\d+)\s*\]/i;
  // Regex to detect metadata tags like [ti:...], [ar:...], [al:...], [by:...]
  const metaHeaderRegex = /^\[(ti|ar|al|by|length|re|ve|creator):\s*.*\]/i;
  // Flexible timestamp regex: matches [hh:mm:ss.xxx] or [mm:ss.xxx] or [m:ss:xx] or [mm:ss]
  const timeRegex = /\[(?:(\d{1,2}):)?(\d{1,3}):(\d{2})(?:[:\.](\d{1,3}))?\]/g;

  for (const line of rawLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Check for [offset:+/-ms] header
    const offsetMatch = trimmed.match(offsetHeaderRegex);
    if (offsetMatch) {
      internalOffsetMs = parseInt(offsetMatch[1], 10) || 0;
      continue;
    }

    // Skip metadata headers like [ti:Song Title]
    if (metaHeaderRegex.test(trimmed)) {
      continue;
    }

    timeRegex.lastIndex = 0;
    const timestamps: number[] = [];
    let match: RegExpExecArray | null;
    let lastIndex = 0;

    while ((match = timeRegex.exec(trimmed)) !== null) {
      const hours = match[1] ? parseInt(match[1], 10) : 0;
      const minutes = parseInt(match[2], 10);
      const seconds = parseInt(match[3], 10);
      const fractionStr = match[4] || '0';

      let fraction = 0;
      if (fractionStr.length === 1) {
        fraction = parseInt(fractionStr, 10) / 10;
      } else if (fractionStr.length === 2) {
        fraction = parseInt(fractionStr, 10) / 100;
      } else {
        fraction = parseInt(fractionStr.padEnd(3, '0').slice(0, 3), 10) / 1000;
      }

      const totalSeconds = hours * 3600 + minutes * 60 + seconds + fraction;
      timestamps.push(totalSeconds);
      lastIndex = timeRegex.lastIndex;
    }

    const text = trimmed.slice(lastIndex).trim();

    // If valid text or timestamps exist
    if (timestamps.length > 0) {
      for (const t of timestamps) {
        // Apply internal file offset (convert ms to seconds)
        const finalTime = Math.max(0, t + internalOffsetMs / 1000);
        result.push({ time: finalTime, text: text || '♪' });
      }
    }
  }

  // Sort chronologically
  result.sort((a, b) => a.time - b.time);
  return result;
}

/**
 * Finds the active lyric line index given current time (in seconds)
 */
export function getActiveLyricIndex(lyrics: LyricLine[], currentTime: number, offset: number = 0): number {
  if (!lyrics || lyrics.length === 0) return -1;

  const adjustedTime = currentTime + offset;

  if (adjustedTime < lyrics[0].time) return 0;

  for (let i = 0; i < lyrics.length; i++) {
    const current = lyrics[i];
    const next = lyrics[i + 1];

    if (adjustedTime >= current.time && (!next || adjustedTime < next.time)) {
      return i;
    }
  }

  return lyrics.length - 1;
}
