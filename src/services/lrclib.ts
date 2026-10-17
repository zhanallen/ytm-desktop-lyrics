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
let circuitBreakerUntil = 0;
let consecutiveThrottleErrors = 0;

function isCircuitOpen(): boolean {
  return Date.now() < circuitBreakerUntil;
}

function recordResponseStatus(status: number): void {
  if (status === 429 || status === 503) {
    consecutiveThrottleErrors++;
    if (consecutiveThrottleErrors >= 3) {
      circuitBreakerUntil = Date.now() + 5000;
    }
  } else if (status !== 404 && status >= 200 && status < 400) {
    consecutiveThrottleErrors = 0;
  }
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = 6000,
  retryCount: number = 0
): Promise<Response> {
  const { signal: parentSignal, ...rest } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let onParentAbort: (() => void) | undefined;
  if (parentSignal) {
    if (parentSignal.aborted) {
      clearTimeout(timer);
      controller.abort();
    } else {
      onParentAbort = () => {
        clearTimeout(timer);
        controller.abort();
      };
      parentSignal.addEventListener('abort', onParentAbort);
    }
  }

  try {
    const response = await fetch(url, { ...rest, signal: controller.signal });

    if (
      (response.status === 503 || response.status === 429) &&
      retryCount < 1 &&
      (!parentSignal || !parentSignal.aborted)
    ) {
      const retryAfterHeader = response.headers.get('retry-after');
      let retryAfterSec = 1.0;
      if (retryAfterHeader) {
        const parsed = parseFloat(retryAfterHeader);
        if (!isNaN(parsed) && parsed > 0) {
          retryAfterSec = Math.min(Math.max(parsed, 0.5), 2.5);
        }
      }

      const jitterMs = Math.floor(Math.random() * 100) + 50;
      const delayMs = Math.round(retryAfterSec * 1000) + jitterMs;

      await new Promise<void>((resolve, reject) => {
        let delayTimer: ReturnType<typeof setTimeout> | null = null;
        let onDelayAbort: (() => void) | undefined;

        const cleanup = () => {
          if (delayTimer !== null) {
            clearTimeout(delayTimer);
            delayTimer = null;
          }
          if (parentSignal && onDelayAbort) {
            parentSignal.removeEventListener('abort', onDelayAbort);
          }
        };

        if (parentSignal) {
          if (parentSignal.aborted) {
            return reject(new DOMException('Aborted', 'AbortError'));
          }
          onDelayAbort = () => {
            cleanup();
            reject(new DOMException('Aborted', 'AbortError'));
          };
          parentSignal.addEventListener('abort', onDelayAbort);
        }

        delayTimer = setTimeout(() => {
          cleanup();
          resolve();
        }, delayMs);
      });

      if (!parentSignal || !parentSignal.aborted) {
        return await fetchWithTimeout(url, options, timeoutMs, retryCount + 1);
      }
    }

    return response;
  } finally {
    clearTimeout(timer);
    if (parentSignal && onParentAbort) {
      parentSignal.removeEventListener('abort', onParentAbort);
    }
  }
}

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
 * Includes C-Pop and popular Western/DJ/J-Pop Chinese translated names
 */
const ARTIST_ALIASES: [string, string][] = [
  // C-Pop
  ['張藝興', 'lay'],
  ['張藝興', 'lay zhang'],
  ['张艺兴', 'lay'],
  ['张艺兴', 'lay zhang'],
  ['周深', 'charlie zhou'],
  ['周深', 'zhou shen'],
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
  ['薛之謙', 'joker xue'],
  ['李榮浩', 'li ronghao'],
  ['李榮浩', 'ronghao li'],
  ['華晨宇', 'hua chenyu'],
  ['毛不易', 'mao buyi'],
  ['汪蘇瀧', 'silence wang'],
  ['許嵩', 'vae'],
  ['鹿晗', 'luhan'],
  ['黃子韜', 'z.tao'],
  ['易烊千璽', 'jackson yee'],
  ['王俊凱', 'karry wang'],
  ['王源', 'roy wang'],
  ['蔡徐坤', 'kun'],
  ['劉憲華', 'henry lau'],
  ['宋雨琦', 'yuqi'],
  ['葉舒華', 'shuhua'],
  ['徐明浩', 'the8'],
  ['文俊輝', 'jun'],
  ['王一博', 'wang yibo'],
  ['肖戰', 'xiao zhan'],
  ['許光漢', 'greg han'],
  ['梁靜茹', 'fish leong'],
  ['孫燕姿', 'stefanie sun'],
  ['莫文蔚', 'karen mok'],
  ['陶喆', 'david tao'],
  ['王力宏', 'leehom wang'],
  ['王力宏', 'wang leehom'],
  ['方大同', 'khalil fong'],
  ['盧廣仲', 'crowd lu'],
  ['持修', 'chih siou'],
  ['高爾宣', 'osn'],
  ['瘦子', 'e.so'],
  ['婁峻碩', 'shou lou'],
  ['婁峻碩', 'shou'],
  ['熊仔', 'kumachan'],
  ['黃宣', 'yellow'],
  ['孫盛希', 'shi shi'],
  ['吳卓源', 'julia wu'],
  ['陳芳語', 'kimberley chen'],
  ['美秀集團', 'amazing show'],
  ['血肉果汁機', 'flesh juicer'],
  ['滅火器', 'fire ex.'],
  ['珂拉琪', 'collage'],
  ['理想混蛋', 'bestards'],
  ['芒果醬', 'mango jump'],
  ['宇宙人', 'cosmospeople'],
  ['八三夭', '831'],
  ['動力火車', 'power station'],
  ['信樂團', 'shin'],
  ['蘇打綠', 'sodagreen'],
  ['魚丁糸', 'oaeen'],
  ['飛兒樂團', 'f.i.r.'],
  ['S.H.E', 'she'],

  // Western / International
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

  // J-Pop
  ['米津玄師', 'kenshi yonezu'],
  ['宇多田光', 'hikaru utada'],
  ['椎名林檎', 'sheena ringo'],
  ['星野源', 'gen hoshino'],
  ['藤井風', 'fujii kaze'],
  ['愛繆', 'aimyon'],
  ['優里', 'yuuri'],
  ['綠黃色社會', 'ryokuoushoku shakai'],
  ['ヨルシカ', 'yorushika'],
  ['ずっと真夜中でいいのに。', 'zutomayo'],
  ['ツユ', 'tuyu'],
  ['Official髭男dism', 'higedan'],
  ['King Gnu', 'king gnu'],
  ['Mrs. GREEN APPLE', 'mrs green apple'],
  ['RADWIMPS', 'radwimps'],
  ['ONE OK ROCK', 'one ok rock'],
  ['Aimer', 'aimer'],
  ['LiSA', 'lisa'],
  ['Eve', 'eve'],
  ['Vaundy', 'vaundy'],
];

/**
 * Recursively strip inner and outer brackets of all forms:
 * (), （）, [], 【】, 〔〕, 《》, ［］
 */
function stripAllBrackets(text: string): string {
  if (!text) return '';
  let s = text.length > 500 ? text.slice(0, 500) : text;
  let prev = '';
  let depth = 0;
  while (s !== prev && depth < 10) {
    depth++;
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
    .replace(/\(Official (Video|Audio|Music Video|Lyric Video)\)/gi, '')
    .replace(/\[Official (Video|Audio|Music Video|Lyric Video)\]/gi, '')
    .replace(/【Official (Video|Audio|Music Video|Lyric Video|MV)】/gi, '')
    .replace(/\((?:Official|MV|Audio|Visualizer|Lyric Video|Lyrics|Live|HD|4K|Remastered|20\d\d Remaster)\)/gi, '')
    .replace(/\[(?:Official|MV|Audio|Visualizer|Lyric Video|Lyrics|Live|HD|4K|Remastered|20\d\d Remaster)\]/gi, '')
    .replace(/【(?:Official|MV|Audio|Visualizer|Lyric Video|Lyrics|Live|官方|官方MV|歌詞)】/gi, '')
    .replace(/\(合作演出.*?\)/gi, '')
    .replace(/\[合作演出.*?\]/gi, '')
    .replace(/【合作演出.*?】/gi, '')
    .replace(/\((?:feat|ft|with|prod)\.?\s*.*?\)/gi, '')
    .replace(/\[(?:feat|ft|with|prod)\.?\s*.*?\]/gi, '')
    .replace(/【(?:feat|ft|with|prod)\.?\s*.*?】/gi, '')
    .replace(/\s+(?:feat|ft)\.?\s+.*$/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return stripAllBrackets(cleaned);
}

/**
 * Multi-artist parser supporting common separators (&, |, ,, 和, 與, feat, etc.)
 */
export function parseArtistList(raw: string): string[] {
  if (!raw) return [];
  return raw
    .split(/\s*(?:,|&|\||丨|\/|\\|和|與|及|\bx\b|\bfeat\.?|\bft\.?|×)\s*/gi)
    .map(s => s.replace(/[\(\（].*?[\)\）]/g, '').trim())
    .filter(s => s.length > 0);
}

/**
 * Resolves all known aliases for a given artist name from ARTIST_ALIASES
 */
function getArtistAliases(artist: string): string[] {
  if (!artist) return [];
  const norm = artist.toLowerCase().replace(/[\s\·\-\.]/g, '');
  const aliases: string[] = [];
  for (const [zh, en] of ARTIST_ALIASES) {
    const zhNorm = zh.toLowerCase().replace(/[\s\·\-\.]/g, '');
    const enNorm = en.toLowerCase().replace(/[\s\·\-\.]/g, '');
    if (norm === zhNorm || norm.includes(zhNorm) || zhNorm.includes(norm)) {
      if (!aliases.includes(en)) aliases.push(en);
    }
    if (norm === enNorm || norm.includes(enNorm) || enNorm.includes(norm)) {
      if (!aliases.includes(zh)) aliases.push(zh);
    }
  }
  return aliases;
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

function isArtistDirectOrAliasMatch(target: string, cand: string): boolean {
  if (!target || !cand) return false;
  if (isArtistAliasMatch(target, cand)) return true;

  const norm = (s: string) => s.toLowerCase().replace(/[^\w\u4e00-\u9fa5]/g, '');
  const tNorm = norm(target);
  const cNorm = norm(cand);
  if (tNorm && tNorm === cNorm) return true;

  const tSimp = norm(toSimplified(target));
  const cSimp = norm(toSimplified(cand));
  if (tSimp && tSimp === cSimp) return true;

  const tTrad = norm(toTraditional(target));
  const cTrad = norm(toTraditional(cand));
  if (tTrad && tTrad === cTrad) return true;

  if (tNorm.length >= 2 && cNorm.includes(tNorm)) return true;
  if (cNorm.length >= 2 && tNorm.includes(cNorm)) return true;
  if (tSimp.length >= 2 && cSimp.includes(tSimp)) return true;
  if (cSimp.length >= 2 && tSimp.includes(cSimp)) return true;

  return false;
}

/**
 * Score & pick the best matching candidate from LRCLIB search results
 */
function findBestMatch(
  results: LrclibResponse[],
  cleanTrack: string,
  targetArtistList: string[],
  duration?: number
): LrclibResponse | null {
  if (!results || results.length === 0) return null;

  let bestItem: LrclibResponse | null = null;
  let bestScore = -Infinity;

  const pureTrack = stripAllBrackets(cleanTrack);

  const targetTrack = cleanTrack.toLowerCase();
  const targetPureTrack = pureTrack.toLowerCase();
  const primaryArtist = targetArtistList[0] || '';
  const collabArtists = targetArtistList.slice(1);

  const targetTrackSimp = toSimplified(targetTrack);
  const targetPureTrackSimp = toSimplified(targetPureTrack);

  const norm = (s: string) => s.toLowerCase().replace(/[^\w\u4e00-\u9fa5]/g, '');
  const targetNorm = norm(cleanTrack);
  const targetPureNorm = norm(pureTrack);

  for (const item of results) {
    if (!item.syncedLyrics && !item.plainLyrics) continue;

    const itemTrack = (item.trackName || '').toLowerCase();
    const itemArtist = (item.artistName || '').toLowerCase();
    const itemTrackSimp = toSimplified(itemTrack);

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

    // If duration differs by >35 seconds AND title doesn't match well, skip
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

    // 3. Multi-artist matching
    const candidateArtistList = parseArtistList(item.artistName || '');
    if (candidateArtistList.length === 0 && item.artistName) {
      candidateArtistList.push(item.artistName.trim());
    }

    let hitPrimary = false;
    if (primaryArtist) {
      hitPrimary = candidateArtistList.some(cand => isArtistDirectOrAliasMatch(primaryArtist, cand)) ||
                   isArtistDirectOrAliasMatch(primaryArtist, item.artistName || '');
    }

    let hitCollab = false;
    if (collabArtists.length > 0) {
      hitCollab = collabArtists.some(collab =>
        candidateArtistList.some(cand => isArtistDirectOrAliasMatch(collab, cand)) ||
        isArtistDirectOrAliasMatch(collab, item.artistName || '')
      );
    }

    const hitBoth = hitPrimary && hitCollab;
    const hitAny = hitPrimary || hitCollab;

    if (targetArtistList.length > 0 && itemArtist) {
      if (hitBoth) {
        score += 150;
      } else if (hitPrimary) {
        score += 100;
      } else if (hitCollab) {
        score += 80;
      } else {
        const targetIsChinese = targetArtistList.some(a => /[\u4e00-\u9fa5]/.test(a));
        // Check if candidate artist has no CJK ideographs/kana/hangul
        const itemHasNoAsianChars = !/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/.test(item.artistName || '');
        if (trackExact && targetIsChinese && itemHasNoAsianChars) {
          // Mild deduction (-50) if Chinese-translated artist name plays an exact English track title
          score -= 50;
        } else {
          // Severe penalty (-1000) if candidate artist is completely unrelated to target artist
          score -= 1000;
        }
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
  if (isCircuitOpen()) return null;

  // Lazily load opencc-js bundle on demand
  await ensureChineseConverter();

  // Sanitize control characters and clamp max string length to prevent forged query attacks
  const rawTrack = trackName.replace(/[\u0000-\u001F]/g, '').trim().slice(0, 200);
  const rawArtist = (artistName || '').replace(/[\u0000-\u001F]/g, '').trim().slice(0, 200);
  if (!rawTrack) return null;

  const cleanTrack = sanitizeTrackTitle(rawTrack);
  const pureTrack = stripAllBrackets(cleanTrack);

  const artistList = parseArtistList(rawArtist);
  const primaryArtist = artistList[0] || '';
  const collabArtists = artistList.slice(1);
  const primaryAliases = getArtistAliases(primaryArtist);

  const roundedDuration = typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? Math.round(duration) : 0;
  const targetArtistListStr = artistList.length > 0 ? artistList.join(',').toLowerCase() : rawArtist.toLowerCase();
  const cacheKey = `${cleanTrack.toLowerCase()}__${targetArtistListStr}__${roundedDuration}`;
  
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

  let hasThrottleOrNetworkError = false;
  let allCompletedNormally = true;

  try {
    const searchUrls: string[] = [];

    // 1. Primary artist search
    if (primaryArtist) {
      searchUrls.push(`https://lrclib.net/api/search?q=${encodeURIComponent(`${cleanTrack} ${primaryArtist}`.trim())}`);
    }

    // 2. Primary alias search
    if (primaryAliases.length > 0) {
      searchUrls.push(`https://lrclib.net/api/search?q=${encodeURIComponent(`${cleanTrack} ${primaryAliases[0]}`.trim())}`);
    }

    // 3. Collab artist search
    if (collabArtists.length > 0) {
      searchUrls.push(`https://lrclib.net/api/search?q=${encodeURIComponent(`${cleanTrack} ${collabArtists[0]}`.trim())}`);
    }

    // 4. Primary alias + Collab artist search
    if (primaryAliases.length > 0 && collabArtists.length > 0) {
      searchUrls.push(`https://lrclib.net/api/search?q=${encodeURIComponent(`${cleanTrack} ${primaryAliases[0]} ${collabArtists[0]}`.trim())}`);
    }

    // 5. Pure track without brackets with primary artist/alias
    if (pureTrack && pureTrack !== cleanTrack) {
      if (primaryArtist) {
        searchUrls.push(`https://lrclib.net/api/search?q=${encodeURIComponent(`${pureTrack} ${primaryArtist}`.trim())}`);
      }
      if (primaryAliases.length > 0) {
        searchUrls.push(`https://lrclib.net/api/search?q=${encodeURIComponent(`${pureTrack} ${primaryAliases[0]}`.trim())}`);
      }
    }

    // 6. Simplified Chinese query if Chinese present
    const simpTrack = toSimplified(cleanTrack);
    const simpPrimary = toSimplified(primaryArtist);
    if (/[\u4e00-\u9fa5]/.test(cleanTrack) || /[\u4e00-\u9fa5]/.test(primaryArtist)) {
      searchUrls.push(`https://lrclib.net/api/search?q=${encodeURIComponent(`${simpTrack} ${simpPrimary}`.trim())}`);
    }

    // 7. Track title only fallback
    searchUrls.push(`https://lrclib.net/api/search?q=${encodeURIComponent(cleanTrack)}`);

    // Deduplicate candidate URLs and limit max parallel requests to top 5
    const uniqueSearchUrls = Array.from(new Set(searchUrls.filter(Boolean))).slice(0, 5);

    // Fire deduplicated search endpoints concurrently for maximum speed and recall
    const results = await Promise.allSettled(uniqueSearchUrls.map(url => fetchWithTimeout(url, { signal }, 6000)));

    if (signal.aborted) {
      return null;
    }

    const candidatePool: LrclibResponse[] = [];
    const seenIds = new Set<number>();

    for (const res of results) {
      if (candidatePool.length >= 30) break;
      if (res.status === 'fulfilled') {
        const response = res.value;
        recordResponseStatus(response.status);

        if (response.ok) {
          const contentLength = response.headers.get('content-length');
          if (contentLength && parseInt(contentLength, 10) > 256 * 1024) {
            continue;
          }

          try {
            const json = await response.json();
            if (Array.isArray(json)) {
              for (const item of json) {
                if (candidatePool.length >= 30) break;
                if (item && item.id && !seenIds.has(item.id)) {
                  seenIds.add(item.id);
                  candidatePool.push(item);
                }
              }
            } else if (json && (json.syncedLyrics || json.plainLyrics)) {
              if (json.id && !seenIds.has(json.id)) {
                seenIds.add(json.id);
                candidatePool.push(json);
              } else if (!json.id && candidatePool.length < 30) {
                candidatePool.push(json);
              }
            }
          } catch (e) {}
        } else {
          allCompletedNormally = false;
          if (response.status === 429 || response.status === 503) {
            hasThrottleOrNetworkError = true;
          }
        }
      } else {
        allCompletedNormally = false;
        hasThrottleOrNetworkError = true;
      }
    }

    if (signal.aborted) {
      return null;
    }

    if (candidatePool.length > 0) {
      const best = findBestMatch(candidatePool, cleanTrack, artistList, roundedDuration);
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

    // Only cache null if all queries completed normally with 200 and candidate pool yielded no match
    if (allCompletedNormally && !hasThrottleOrNetworkError && !signal.aborted) {
      setCacheItem(cacheKey, null);
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

  return null;
}
