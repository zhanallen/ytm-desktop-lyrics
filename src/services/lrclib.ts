import { toTraditional, toSimplified, countTraditionalFeatures } from '../utils/chineseConverter.js';

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
 * Common Chinese <-> English artist alias mapping dictionary
 */
const ARTIST_ALIASES: [string, string][] = [
  ['周興哲', 'eric chou'],
  ['周杰倫', 'jay chou'],
  ['鄧紫棋', 'g.e.m.'],
  ['gem鄧紫棋', 'g.e.m.'],
  ['王嘉爾', 'jackson wang'],
  ['五月天', 'mayday'],
  ['阿信', 'ashin'],
  ['蔡依林', 'jolin tsai'],
  ['張惠妹', 'amei'],
  ['林俊傑', 'jj lin'],
  ['陳奕迅', 'eason chan'],
  ['田馥甄', 'hebe tien'],
  ['楊丞琳', 'rainie yang'],
  ['王心凌', 'cyndi wang'],
  ['蕭敬騰', 'jam hsiao'],
  ['韋禮安', 'weibird'],
  ['告五人', 'accusefive'],
  ['草東沒有派對', 'no party for cao dong'],
  ['茄子蛋', 'eggplantegg'],
  ['落日飛車', 'sunset rollercoaster'],
  ['冰球樂團', 'icyball'],
];

/**
 * Recursively strip inner and outer brackets of all forms:
 * (), （）, [], 【】, 〔〕, 《》, ［］
 */
function stripAllBrackets(text: string): string {
  if (!text) return '';
  let s = text;
  let prev = '';
  while (s !== prev) {
    prev = s;
    s = s.replace(/[\(\（【〔《［][^\(\（【〔《［\)\】〕》］]*[\)\】〕》］]/g, '').trim();
  }
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Clean track title from video tags & collaboration descriptors like (合作演出：...), (feat. ...), etc.
 */
function sanitizeTrackTitle(title: string): string {
  if (!title) return '';
  const cleaned = title
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
    .replace(/\(合作演出.*?\)/gi, '')
    .replace(/\[合作演出.*?\]/gi, '')
    .replace(/\(feat\..*?\)/gi, '')
    .replace(/\[feat\..*?\]/gi, '')
    .replace(/\(ft\..*?\)/gi, '')
    .replace(/\[ft\..*?\]/gi, '')
    .replace(/\(with.*?\)/gi, '')
    .replace(/\[with.*?\]/gi, '')
    .replace(/\(prod\..*?\)/gi, '')
    .replace(/\[prod\..*?\]/gi, '')
    .replace(/\s+feat\..*$/gi, '')
    .replace(/\s+ft\..*$/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return stripAllBrackets(cleaned);
}

/**
 * Clean primary artist name
 */
function sanitizeArtistName(artist: string): string {
  if (!artist) return '';
  return artist
    .split('|')[0]
    .split('丨')[0]
    .split(',')[0]
    .split('&')[0]
    .split(' 和 ')[0]
    .split(' 與 ')[0]
    .split(' 及 ')[0]
    .split(' / ')[0]
    .replace(/\(feat\..*?\)/gi, '')
    .replace(/feat\..*$/gi, '')
    .trim();
}

/**
 * Check if targetArtist and itemArtist are alias matches (e.g. 周興哲 <-> Eric Chou)
 */
function isArtistAliasMatch(targetArtist: string, itemArtist: string): boolean {
  if (!targetArtist || !itemArtist) return false;
  const t = targetArtist.toLowerCase();
  const i = itemArtist.toLowerCase();

  for (const [zh, en] of ARTIST_ALIASES) {
    if ((t.includes(zh) || zh.includes(t)) && (i.includes(en) || en.includes(i))) return true;
    if ((i.includes(zh) || zh.includes(i)) && (t.includes(en) || en.includes(t))) return true;
  }
  return false;
}

/**
 * Score & pick the best matching candidate from LRCLIB search results
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

  const pureTrack = stripAllBrackets(cleanTrack);

  const targetTrack = cleanTrack.toLowerCase();
  const targetPureTrack = pureTrack.toLowerCase();
  const targetArtist = cleanArtist.toLowerCase();

  const targetTrackSimp = toSimplified(targetTrack);
  const targetPureTrackSimp = toSimplified(targetPureTrack);
  const targetArtistSimp = toSimplified(targetArtist);

  for (const item of results) {
    if (!item.syncedLyrics && !item.plainLyrics) continue;

    const itemTrack = (item.trackName || '').toLowerCase();
    const itemArtist = (item.artistName || '').toLowerCase();
    const itemTrackSimp = toSimplified(itemTrack);
    const itemArtistSimp = toSimplified(itemArtist);

    const norm = (s: string) => s.toLowerCase().replace(/[^\w\u4e00-\u9fa5]/g, '');
    const targetNorm = norm(cleanTrack);
    const targetPureNorm = norm(pureTrack);
    const itemNorm = norm(itemTrack);
    const itemSimpNorm = norm(itemTrackSimp);

    // Calculate title match with normalization
    const trackExact = itemNorm === targetNorm || itemNorm === targetPureNorm ||
                       itemSimpNorm === norm(targetTrackSimp) || itemSimpNorm === norm(targetPureTrackSimp);

    // Partial title match requires lenRatio >= 0.7
    const lenRatio = itemNorm.length > 0 && targetPureNorm.length > 0
      ? Math.min(itemNorm.length, targetPureNorm.length) / Math.max(itemNorm.length, targetPureNorm.length)
      : 0;

    const trackPartial = !trackExact && lenRatio >= 0.7 && (
      itemNorm.includes(targetNorm) || targetNorm.includes(itemNorm) ||
      itemNorm.includes(targetPureNorm) || targetPureNorm.includes(itemNorm) ||
      itemSimpNorm.includes(norm(targetTrackSimp)) || itemSimpNorm.includes(norm(targetPureTrackSimp))
    );
    
    // Calculate artist match (including cross S2T and Chinese/English aliases like 周興哲 vs Eric Chou)
    const aliasMatch = isArtistAliasMatch(targetArtist, itemArtist);

    const artistExact = aliasMatch || (targetArtist && itemArtist && (
      itemArtist === targetArtist || itemArtistSimp === targetArtistSimp ||
      toTraditional(itemArtist) === toTraditional(targetArtist) ||
      (itemArtist.includes(targetArtist) && targetArtist.length >= 2) ||
      (targetArtist.includes(itemArtist) && itemArtist.length >= 2)
    ));

    const artistPartial = aliasMatch || (targetArtist && itemArtist && (
      itemArtist.includes(targetArtist) || targetArtist.includes(itemArtist) ||
      itemArtistSimp.includes(targetArtistSimp) || targetArtistSimp.includes(itemArtistSimp) ||
      toTraditional(itemArtist).includes(toTraditional(targetArtist)) ||
      toTraditional(targetArtist).includes(toTraditional(itemArtist))
    ));

    // If duration differs by >35 seconds AND title/artist don't match well, skip
    if (duration && duration > 0 && item.duration && item.duration > 0) {
      const diff = Math.abs(item.duration - duration);
      if (diff > 35 && !trackExact) {
        continue;
      }
    }

    let score = 0;

    // 1. High priority for synced lyrics
    if (item.syncedLyrics) {
      score += 100;
    }

    // 2. Traditional Chinese Bonus (+60 pts) & Cantonese Penalty (-150 pts for Mandarin target)
    const lyricsText = item.syncedLyrics || item.plainLyrics || '';
    if (countTraditionalFeatures(lyricsText) > 2) {
      score += 60;
    }
    const cantoneseRegex = /[喺咗哋唔睇諗冇啱啲乜詎翻嗰嘅説]/;
    if (cantoneseRegex.test(lyricsText)) {
      score -= 150;
    }

    // 3. Artist match score & mismatch penalty
    if (targetArtist && itemArtist) {
      if (artistExact) {
        score += 100;
      } else if (artistPartial) {
        score += 70;
      } else {
        // Severe penalty (-1000) if candidate artist is completely unrelated to target artist
        score -= 1000;
      }
    }

    // 4. Track name match score
    if (itemTrack && targetTrack) {
      if (trackExact) {
        score += 300;
      } else if (trackPartial) {
        score += 100;
      } else {
        // Heavy penalty (-1000) if candidate song title does not match target song title at all
        score -= 1000;
      }
    }

    // 5. Duration proximity score
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

  if (bestScore >= 50) {
    return bestItem;
  }
  return null;
}

/**
 * Fetches lyrics from LRCLIB API with multi-query concurrent parallel requests
 */
export async function fetchLyrics(trackName: string, artistName: string, duration?: number): Promise<LrclibResponse | null> {
  if (!trackName) return null;

  const cleanTrack = sanitizeTrackTitle(trackName);
  const pureTrack = stripAllBrackets(cleanTrack);
  const cleanArtist = sanitizeArtistName(artistName);

  const cacheKey = `${cleanTrack.toLowerCase()}__${cleanArtist.toLowerCase()}__${Math.round(duration || 0)}`;
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey) || null;
  }

  try {
    const params = new URLSearchParams({
      track_name: pureTrack || cleanTrack,
      artist_name: cleanArtist,
    });
    if (duration && duration > 0) {
      params.append('duration', Math.round(duration).toString());
    }

    const getUrl = `https://lrclib.net/api/get?${params.toString()}`;
    
    const searchUrls: string[] = [
      getUrl,
      `https://lrclib.net/api/search?q=${encodeURIComponent(`${cleanTrack} ${cleanArtist}`.trim())}`,
      `https://lrclib.net/api/search?q=${encodeURIComponent(cleanTrack)}`,
    ];

    if (pureTrack && pureTrack !== cleanTrack) {
      searchUrls.push(`https://lrclib.net/api/search?q=${encodeURIComponent(`${pureTrack} ${cleanArtist}`.trim())}`);
      searchUrls.push(`https://lrclib.net/api/search?q=${encodeURIComponent(pureTrack)}`);
    }

    // English artist alias queries (e.g. 周興哲 -> Eric Chou)
    for (const [zh, en] of ARTIST_ALIASES) {
      if (cleanArtist.toLowerCase().includes(zh)) {
        searchUrls.push(`https://lrclib.net/api/search?q=${encodeURIComponent(`${pureTrack} ${en}`)}`);
      }
    }

    // Simplified Chinese queries
    const simpTrack = toSimplified(cleanTrack);
    const simpPureTrack = toSimplified(pureTrack);
    const simpArtist = toSimplified(cleanArtist);

    searchUrls.push(`https://lrclib.net/api/search?q=${encodeURIComponent(`${simpTrack} ${simpArtist}`.trim())}`);
    searchUrls.push(`https://lrclib.net/api/search?q=${encodeURIComponent(simpTrack)}`);

    if (simpPureTrack && simpPureTrack !== simpTrack) {
      searchUrls.push(`https://lrclib.net/api/search?q=${encodeURIComponent(`${simpPureTrack} ${simpArtist}`.trim())}`);
      searchUrls.push(`https://lrclib.net/api/search?q=${encodeURIComponent(simpPureTrack)}`);
    }

    // Traditional variant query (e.g. 温嵐 -> 溫嵐)
    const tradArtist = toTraditional(cleanArtist);
    if (tradArtist !== cleanArtist) {
      searchUrls.push(`https://lrclib.net/api/search?q=${encodeURIComponent(`${pureTrack} ${tradArtist}`.trim())}`);
    }

    // Fire all endpoints concurrently for maximum speed and recall
    const results = await Promise.allSettled(searchUrls.map(url => fetch(url)));

    const candidatePool: LrclibResponse[] = [];
    const seenIds = new Set<number>();

    for (const res of results) {
      if (res.status === 'fulfilled' && res.value.ok) {
        try {
          const json = await res.value.json();
          if (Array.isArray(json)) {
            for (const item of json) {
              if (item && item.id && !seenIds.has(item.id)) {
                seenIds.add(item.id);
                candidatePool.push(item);
              }
            }
          } else if (json && (json.syncedLyrics || json.plainLyrics)) {
            if (json.id && !seenIds.has(json.id)) {
              seenIds.add(json.id);
              candidatePool.push(json);
            } else if (!json.id) {
              candidatePool.push(json);
            }
          }
        } catch (e) {}
      }
    }

    if (candidatePool.length > 0) {
      const best = findBestMatch(candidatePool, cleanTrack, cleanArtist, duration);
      if (best) {
        // Convert lyrics to Traditional Chinese (Taiwan standard) before returning
        const convertedBest: LrclibResponse = {
          ...best,
          syncedLyrics: best.syncedLyrics ? toTraditional(best.syncedLyrics) : null,
          plainLyrics: best.plainLyrics ? toTraditional(best.plainLyrics) : null,
        };
        cache.set(cacheKey, convertedBest);
        return convertedBest;
      }
    }
  } catch (err) {
    console.error('[LRCLIB] Fetch lyrics error:', err);
  }

  cache.set(cacheKey, null);
  return null;
}
