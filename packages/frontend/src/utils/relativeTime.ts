import { formatDistanceToNow } from 'date-fns';
import { zhCN, enUS, ja } from 'date-fns/locale';
import type { Locale as DateFnsLocale } from 'date-fns';

/**
 * 后端时间戳都是**秒**（`last_connected_at` / `created_at` …），date-fns 要毫秒，
 * 这里统一换算，并把 i18n 的 locale（zh-CN / en-US / ja-JP，也可能是 zh / en / ja）
 * 映射到 date-fns 的 locale。
 */
const BY_FULL_TAG: Record<string, DateFnsLocale> = {
  'zh-CN': zhCN,
  'zh-TW': zhCN,
  'en-US': enUS,
  'en-GB': enUS,
  'ja-JP': ja,
};

const BY_LANG: Record<string, DateFnsLocale> = {
  zh: zhCN,
  en: enUS,
  ja,
};

/**
 * 把秒级时间戳格式化成「3 分钟前 / 2 days ago」。
 * 拿不到有效时间戳时返回 fallback（比如「从未连接」）。
 */
export function formatRelativeFromSeconds(
  seconds: number | null | undefined,
  i18nLocale: string | undefined,
  fallback = '',
  now: Date = new Date(),
): string {
  if (!seconds || !Number.isFinite(seconds)) return fallback;
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return fallback;
  // 时钟偏差导致的「未来时间」按刚刚处理，避免出现「in 2 minutes」
  const safeDate = date.getTime() > now.getTime() ? now : date;

  const tag = i18nLocale || 'zh-CN';
  const locale = BY_FULL_TAG[tag] ?? BY_LANG[tag.split('-')[0]] ?? enUS;
  return formatDistanceToNow(safeDate, { addSuffix: true, locale });
}

/**
 * 最近连接排序：先按 last_connected_at 倒序，从没连过的按 created_at 倒序垫在后面。
 */
export function sortByRecentUse<T extends { last_connected_at?: number | null; created_at?: number | null }>(items: readonly T[]): T[] {
  return [...items].sort(
    (a, b) => (b.last_connected_at ?? 0) - (a.last_connected_at ?? 0)
      || (b.created_at ?? 0) - (a.created_at ?? 0)
  );
}
