import type { NodeDisplayDate } from './contract.ts';

const CJK_PATTERN = /[㐀-鿿]/gu;

/** Format a Unix timestamp in the site timezone. */
export function formatDisplayDate(timestampSec: number, timeZone: string): NodeDisplayDate {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestampSec * 1000));

  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';

  const year = value('year');
  const month = value('month');
  const day = value('day');

  return {
    year,
    monthDay: `${month}-${day}`,
    iso: `${year}-${month}-${day}`,
  };
}

/** Truncate by code point, preferring a word boundary for Latin text. */
export function truncateText(text: string, maxChars: number, ellipsis = '…'): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;

  const cut = chars.slice(0, maxChars).join('').trimEnd();
  const currentSlice = chars.slice(0, maxChars).join('');

  if (/[A-Za-z0-9]$/u.test(currentSlice) && currentSlice.includes(' ')) {
    const lastSpace = cut.lastIndexOf(' ');
    if (lastSpace > Math.floor(maxChars * 0.6)) {
      return `${cut.slice(0, lastSpace).trimEnd()}${ellipsis}`;
    }
  }

  return `${cut}${ellipsis}`;
}

/** Minimum one minute; CJK is counted as characters and Latin as words. */
export function contentReadingTime(plainText: string): number {
  const cjk = (plainText.match(CJK_PATTERN) ?? []).length;
  const nonCjk = plainText.replace(CJK_PATTERN, ' ');
  const words = (nonCjk.match(/[A-Za-z0-9]+/gu) ?? []).length;
  return Math.max(1, Math.ceil(cjk / 400 + words / 200));
}

/** Character count excluding whitespace, used by the full-if-short display rule. */
export function plainTextLength(plainText: string): number {
  return Array.from(plainText.replace(/\s+/gu, '')).length;
}
