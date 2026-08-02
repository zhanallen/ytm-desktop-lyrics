import * as OpenCC from 'opencc-js';

// Simplified to Traditional (Taiwan standard)
const s2twConverter = OpenCC.Converter({ from: 'cn', to: 'tw' });

// Traditional to Simplified
const t2sConverter = OpenCC.Converter({ from: 'tw', to: 'cn' });

/**
 * Convert Simplified Chinese to Traditional Chinese (Taiwan standard)
 */
export function toTraditional(text: string): string {
  if (!text) return '';
  try {
    return s2twConverter(text);
  } catch (e) {
    return text;
  }
}

/**
 * Convert Traditional Chinese to Simplified Chinese
 */
export function toSimplified(text: string): string {
  if (!text) return '';
  try {
    return t2sConverter(text);
  } catch (e) {
    return text;
  }
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
