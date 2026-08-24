type ConverterFn = (text: string) => string;

let s2twConverter: ConverterFn | null = null;
let t2sConverter: ConverterFn | null = null;
let loadPromise: Promise<void> | null = null;

const MAX_CACHE_SIZE = 1000;
const s2twCache = new Map<string, string>();
const t2sCache = new Map<string, string>();

/**
 * Lazily loads opencc-js bundle on demand to reduce initial JavaScript bundle size by >80%.
 */
export async function ensureChineseConverter(): Promise<void> {
  if (s2twConverter && t2sConverter) return;
  if (!loadPromise) {
    loadPromise = import('opencc-js').then((OpenCC) => {
      s2twConverter = OpenCC.Converter({ from: 'cn', to: 'tw' });
      t2sConverter = OpenCC.Converter({ from: 'tw', to: 'cn' });
    }).catch((err) => {
      console.warn('[OpenCC] Failed to dynamically load opencc-js:', err);
    });
  }
  await loadPromise;
}

function getFromLru(cache: Map<string, string>, key: string): string | undefined {
  if (!cache.has(key)) return undefined;
  const val = cache.get(key)!;
  cache.delete(key);
  cache.set(key, val);
  return val;
}

function setToLru(cache: Map<string, string>, key: string, value: string, maxSize: number): void {
  if (cache.has(key)) {
    cache.delete(key);
  } else if (cache.size >= maxSize) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(key, value);
}

/**
 * Convert Simplified Chinese to Traditional Chinese (Taiwan standard) with true LRU cache
 */
export function toTraditional(text: string): string {
  if (!text) return '';
  const cached = getFromLru(s2twCache, text);
  if (cached !== undefined) return cached;

  let result = text;
  if (s2twConverter) {
    try {
      result = s2twConverter(text);
    } catch (e) {
      result = text;
    }
  }

  setToLru(s2twCache, text, result, MAX_CACHE_SIZE);
  return result;
}

/**
 * Convert Traditional Chinese to Simplified Chinese with true LRU cache
 */
export function toSimplified(text: string): string {
  if (!text) return '';
  const cached = getFromLru(t2sCache, text);
  if (cached !== undefined) return cached;

  let result = text;
  if (t2sConverter) {
    try {
      result = t2sConverter(text);
    } catch (e) {
      result = text;
    }
  }

  setToLru(t2sCache, text, result, MAX_CACHE_SIZE);
  return result;
}

/**
 * Count Traditional Chinese exclusive character features
 */
export function countTraditionalFeatures(text: string): number {
  if (!text) return 0;
  // Common Traditional Chinese exclusive characters
  const tradRegex = /[體國簡發後經對會這嗎還當點個頭開車買寫親關樂義畫動愛無話愛學聽難舊雙讓應轉聲樣優體歷幾與後點禮顏懷聲傷變]/g;
  const matches = text.match(tradRegex);
  return matches ? matches.length : 0;
}

