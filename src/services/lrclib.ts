export interface LrclibResponse {
  id?: number;
  trackName?: string;
  artistName?: string;
  albumName?: string;
  duration?: number;
  syncedLyrics?: string | null;
  plainLyrics?: string | null;
}

const cache = new Map<string, LrclibResponse | null>();

/**
 * Clean track title from pure video tags like (Official Video), [MV], etc.
 * Preserves musical descriptors like Remix, Live, Acoustic, Version.
 */
function sanitizeTrackTitle(title: string): string {
  if (!title) return '';
  return title
    .replace(/\(Official (Video|Audio|Music Video)\)/gi, '')
    .replace(/\[Official (Video|Audio|Music Video)\]/gi, '')
    .replace(/\(Official\)/gi, '')
    .replace(/\[Official\]/gi, '')
    .replace(/\(MV\)/gi, '')
    .replace(/\[MV\]/gi, '')
    .replace(/\(Audio\)/gi, '')
    .replace(/\[Audio\]/gi, '')
    .replace(/\[HD\]/gi, '')
    .replace(/\[4K\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Clean primary artist name
 */
function sanitizeArtistName(artist: string): string {
  if (!artist) return '';
  return artist
    .split(',')[0]
    .split('&')[0]
    .split(' 和 ')[0]
    .split(' 與 ')[0]
    .split(' 及 ')[0]
    .split(' / ')[0]
    .replace(/\(feat\..*?\)/gi, '')
    .trim();
}

/**
 * Score & pick the best matching candidate from LRCLIB search results
 * Accommodates YouTube Music video intros/outros (up to 35s difference)
 */
function findBestMatch(
  results: LrclibResponse[],
  cleanTrack: string,
  cleanArtist: string,
  duration?: number
): LrclibResponse | null {
  if (!results || results.length === 0) return null;

  let bestItem: LrclibResponse | null = null;
  let bestScore = -Infinity;

  const targetTrack = cleanTrack.toLowerCase();
  const targetArtist = cleanArtist.toLowerCase();

  for (const item of results) {
    if (!item.syncedLyrics && !item.plainLyrics) continue;

    const itemTrack = (item.trackName || '').toLowerCase();
    const itemArtist = (item.artistName || '').toLowerCase();

    // Calculate title and artist match
    const trackExact = itemTrack === targetTrack;
    const trackPartial = itemTrack.includes(targetTrack) || targetTrack.includes(itemTrack);
    const artistPartial = targetArtist && itemArtist && (itemArtist.includes(targetArtist) || targetArtist.includes(itemArtist));

    // If duration differs by >35 seconds AND title/artist don't match well, skip
    if (duration && duration > 0 && item.duration && item.duration > 0) {
      const diff = Math.abs(item.duration - duration);
      if (diff > 35 && !trackExact) {
        continue;
      }
    }

    let score = 0;

    // 1. Prefer synced lyrics
    if (item.syncedLyrics) score += 50;

    // 2. Artist match score
    if (targetArtist && itemArtist) {
      if (itemArtist === targetArtist) {
        score += 100;
      } else if (artistPartial) {
        score += 70;
      }
    }

    // 3. Track name match score
    if (itemTrack && targetTrack) {
      if (trackExact) {
        score += 100;
      } else if (trackPartial) {
        score += 50;
      }
    }

    // 4. Duration proximity score
    if (duration && duration > 0 && item.duration && item.duration > 0) {
      const diff = Math.abs(item.duration - duration);
      if (diff <= 3) score += 80;
      else if (diff <= 8) score += 50;
      else if (diff <= 20) score += 20;
      else score -= Math.min(40, diff * 1.5);
    }

    if (score > bestScore) {
      bestScore = score;
      bestItem = item;
    }
  }

  return bestItem;
}

/**
 * Fetches lyrics from LRCLIB API with concurrent parallel requests (<500ms response)
 */
export async function fetchLyrics(trackName: string, artistName: string, duration?: number): Promise<LrclibResponse | null> {
  if (!trackName) return null;

  const cleanTrack = sanitizeTrackTitle(trackName);
  const cleanArtist = sanitizeArtistName(artistName);

  const cacheKey = `${cleanTrack.toLowerCase()}__${cleanArtist.toLowerCase()}__${Math.round(duration || 0)}`;
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey) || null;
  }

  try {
    const params = new URLSearchParams({
      track_name: cleanTrack,
      artist_name: cleanArtist,
    });
    if (duration && duration > 0) {
      params.append('duration', Math.round(duration).toString());
    }

    const getUrl = `https://lrclib.net/api/get?${params.toString()}`;
    const searchQuery = `${cleanTrack} ${cleanArtist}`.trim();
    const searchUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(searchQuery)}`;

    // Fire exact /api/get and /api/search concurrently for sub-second speed
    const [getRes, searchRes] = await Promise.allSettled([
      fetch(getUrl),
      fetch(searchUrl)
    ]);

    // Check exact get result first
    if (getRes.status === 'fulfilled' && getRes.value.ok) {
      const data: LrclibResponse = await getRes.value.json();
      if (data && (data.syncedLyrics || data.plainLyrics)) {
        cache.set(cacheKey, data);
        return data;
      }
    }

    // Check search result
    if (searchRes.status === 'fulfilled' && searchRes.value.ok) {
      const searchResults: LrclibResponse[] = await searchRes.value.json();
      if (Array.isArray(searchResults) && searchResults.length > 0) {
        const best = findBestMatch(searchResults, cleanTrack, cleanArtist, duration);
        if (best) {
          cache.set(cacheKey, best);
          return best;
        }
      }
    }

    // Fallback search by title alone
    if (cleanTrack.length > 1) {
      const titleOnlyUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(cleanTrack)}`;
      const titleRes = await fetch(titleOnlyUrl);
      if (titleRes.ok) {
        const titleResults: LrclibResponse[] = await titleRes.json();
        if (Array.isArray(titleResults) && titleResults.length > 0) {
          const best = findBestMatch(titleResults, cleanTrack, cleanArtist, duration);
          if (best) {
            cache.set(cacheKey, best);
            return best;
          }
        }
      }
    }
  } catch (err) {
    console.error('[LRCLIB] Fetch lyrics error:', err);
  }

  cache.set(cacheKey, null);
  return null;
}
