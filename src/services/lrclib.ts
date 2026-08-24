import { toTraditional, toSimplified, countTraditionalFeatures, ensureChineseConverter } from '../utils/chineseConverter';

export interface LrclibResponse {
  id?: number;
  trackName?: string;
  artistName?: string;
  albumName?: string;
  duration?: number;
  syncedLyrics?: string | null;
  plainLyrics?: string | null;
}

const MAX_CACHE_SIZE = 200;
const cache = new Map<string, LrclibResponse | null>();
let activeAbortController: AbortController | null = null;

function getCacheItem(key: string): { found: boolean; value: LrclibResponse | null } {
  if (!cache.has(key)) return { found: false, value: null };
  const val = cache.get(key) ?? null;
  cache.delete(key);
  cache.set(key, val);
  return { found: true, value: val };
}

function setCacheItem(key: string, value: LrclibResponse | null) {
  if (cache.has(key)) {
    cache.delete(key);
  } else if (cache.size >= MAX_CACHE_SIZE) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(key, value);
}

/**
 * Common Chinese <-> English artist alias mapping dictionary
 * Includes C-Pop and popular Western/DJ Chinese translated names
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
  ['格里芬', 'gryffin'],
  ['艾利·杜赫', 'elley duhé'],
  ['艾利杜赫', 'elley duhe'],
  ['泰勒絲', 'taylor swift'],
  ['泰勒·斯威夫特', 'taylor swift'],
  ['艾德·希蘭', 'ed sheeran'],
  ['紅髮艾德', 'ed sheeran'],
  ['亞莉安娜', 'ariana grande'],
  ['亞莉安娜·格蘭德', 'ariana grande'],
  ['小賈斯汀', 'justin bieber'],
  ['賈斯汀·比伯', 'justin bieber'],
  ['艾倫·沃克', 'alan walker'],
  ['老菸槍雙人組', 'the chainsmokers'],
  ['卡爾文·哈里斯', 'calvin harris'],
  ['大衛·庫塔', 'david guetta'],
  ['瑪麗亞·凱莉', 'mariah carey'],
  ['火星人布魯諾', 'bruno mars'],
  ['杜娃·黎波', 'dua lipa'],
  ['比莉·艾利什', 'billie eilish'],
  ['怪奇比莉', 'billie eilish'],
  ['奧莉維亞·羅德里戈', 'olivia rodrigo'],
  ['謎幻樂團', 'imagine dragons'],
  ['酷玩樂團', 'coldplay'],
  ['魔力紅', 'maroon 5'],
  ['西城男孩', 'westlife'],
  ['後街男孩', 'backstreet boys'],
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
 * Check if targetArtist and itemArtist are alias matches (e.g. 周興哲 <-> Eric Chou, 格里芬 <-> Gryffin)
 */
function isArtistAliasMatch(targetArtist: string, itemArtist: string): boolean {
  if (!targetArtist || !itemArtist) return false;
  const t = targetArtist.toLowerCase().replace(/[\s\·\-\.]/g, '');
  const i = itemArtist.toLowerCase().replace(/[\s\·\-\.]/g, '');

  for (const [zh, en] of ARTIST_ALIASES) {
    const zhNorm = zh.toLowerCase().replace(/[\s\·\-\.]/g, '');
    const enNorm = en.toLowerCase().replace(/[\s\·\-\.]/g, '');
    if ((t.includes(zhNorm) || zhNorm.includes(t)) && (i.includes(enNorm) || enNorm.includes(i))) return true;
    if ((i.includes(zhNorm) || zhNorm.includes(i)) && (t.includes(enNorm) || enNorm.includes(t))) return true;
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
  const targetArtistTrad = toTraditional(targetArtist);

  for (const item of results) {
    if (!item.syncedLyrics && !item.plainLyrics) continue;

    const itemTrack = (item.trackName || '').toLowerCase();
    const itemArtist = (item.artistName || '').toLowerCase();
    const itemTrackSimp = toSimplified(itemTrack);
    const itemArtistSimp = toSimplified(itemArtist);
    const itemArtistTrad = toTraditional(itemArtist);

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
    
    // Calculate artist match (including cross S2T and Chinese/English aliases like 格里芬 vs Gryffin)
    const aliasMatch = isArtistAliasMatch(targetArtist, itemArtist);

    const artistExact = aliasMatch || (targetArtist && itemArtist && (
      itemArtist === targetArtist || itemArtistSimp === targetArtistSimp ||
      itemArtistTrad === targetArtistTrad ||
      (itemArtist.includes(targetArtist) && targetArtist.length >= 2) ||
      (targetArtist.includes(itemArtist) && itemArtist.length >= 2)
    ));

    const artistPartial = aliasMatch || (targetArtist && itemArtist && (
      itemArtist.includes(targetArtist) || targetArtist.includes(itemArtist) ||
      itemArtistSimp.includes(targetArtistSimp) || targetArtistSimp.includes(itemArtistSimp) ||
      itemArtistTrad.includes(targetArtistTrad) ||
      targetArtistTrad.includes(itemArtistTrad)
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

    // Check if targetArtist is Chinese while candidate artist is English/ASCII
    const targetIsChinese = /[\u4e00-\u9fa5]/.test(targetArtist);
    const itemIsEnglish = /^[\x00-\x7F]+$/.test(itemArtist);

    // 3. Artist match score & mismatch penalty
    if (targetArtist && itemArtist) {
      if (artistExact) {
        score += 100;
      } else if (artistPartial) {
        score += 70;
      } else if (trackExact && targetIsChinese && itemIsEnglish) {
        // Mild deduction (-50) if Chinese-translated artist name plays an exact English track title
        score -= 50;
      } else {
        // Severe penalty (-1000) if candidate artist is completely unrelated to target artist
        score -= 1000;
      }
    }

    // 4. Track name match score (Dominant bonus for exact title match; heavy penalty if title differs)
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
  if (!trackName || typeof trackName !== 'string') return null;

  // Lazily load opencc-js bundle on demand
  await ensureChineseConverter();

  // Sanitize control characters and clamp max string length to prevent forged query attacks
  const rawTrack = trackName.replace(/[\u0000-\u001F]/g, '').trim().slice(0, 200);
  const rawArtist = (artistName || '').replace(/[\u0000-\u001F]/g, '').trim().slice(0, 200);
  if (!rawTrack) return null;

  const cleanTrack = sanitizeTrackTitle(rawTrack);
  const pureTrack = stripAllBrackets(cleanTrack);
  const cleanArtist = sanitizeArtistName(rawArtist);

  const roundedDuration = typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? Math.round(duration) : 0;
  const cacheKey = `${cleanTrack.toLowerCase()}__${cleanArtist.toLowerCase()}__${roundedDuration}`;
  
  const cached = getCacheItem(cacheKey);
  if (cached.found) {
    return cached.value;
  }

  // Cancel in-flight request when tracks change rapidly
  if (activeAbortController) {
    activeAbortController.abort();
  }
  const currentController = new AbortController();
  activeAbortController = currentController;
  const signal = currentController.signal;

  try {
    const params = new URLSearchParams({
      track_name: pureTrack || cleanTrack,
      artist_name: cleanArtist,
    });
    if (roundedDuration > 0) {
      params.append('duration', roundedDuration.toString());
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

    // English artist alias queries (e.g. 周興哲 -> Eric Chou, 格里芬 -> Gryffin)
    const cleanArtistNorm = cleanArtist.toLowerCase().replace(/[\s\·\-\.]/g, '');
    for (const [zh, en] of ARTIST_ALIASES) {
      const zhNorm = zh.toLowerCase().replace(/[\s\·\-\.]/g, '');
      if (cleanArtistNorm.includes(zhNorm) || zhNorm.includes(cleanArtistNorm)) {
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

    // Deduplicate candidate URLs and limit max parallel requests to top 4 to prevent Rate Limiting (HTTP 429)
    const uniqueSearchUrls = Array.from(new Set(searchUrls)).slice(0, 4);

    // Fire deduplicated endpoints concurrently for maximum speed and recall
    const results = await Promise.allSettled(uniqueSearchUrls.map(url => fetch(url, { signal })));

    if (signal.aborted) {
      return null;
    }

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

    if (signal.aborted) {
      return null;
    }

    if (candidatePool.length > 0) {
      const best = findBestMatch(candidatePool, cleanTrack, cleanArtist, roundedDuration);
      if (best) {
        // Convert lyrics to Traditional Chinese (Taiwan standard) before returning
        const convertedBest: LrclibResponse = {
          ...best,
          syncedLyrics: best.syncedLyrics ? toTraditional(best.syncedLyrics) : null,
          plainLyrics: best.plainLyrics ? toTraditional(best.plainLyrics) : null,
        };
        setCacheItem(cacheKey, convertedBest);
        return convertedBest;
      }
    }
  } catch (err: any) {
    if (err?.name === 'AbortError' || signal.aborted) {
      return null;
    }
    console.error('[LRCLIB] Fetch lyrics error:', err);
  } finally {
    if (activeAbortController === currentController) {
      activeAbortController = null;
    }
  }

  if (!signal.aborted) {
    setCacheItem(cacheKey, null);
  }
  return null;
}
