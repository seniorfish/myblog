/**
 * Service worker lifecycle policy.
 *
 * This module deliberately has no worker globals so Vitest can import it
 * directly. The worker records its first activation time in Cache Storage and
 * compares it against this TTL.
 */

/** Seven days, in milliseconds. */
export const SELF_DESTRUCT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Returns true when the worker has been installed for at least `ttlMs`.
 *
 * A missing record means "not due" because the caller records the first
 * activation time on the next check. A clock rollback also means "not due";
 * the worker should not delete its caches because the system clock moved
 * backwards.
 */
export function shouldSelfDestruct(
  firstSeenMs: number | null | undefined,
  nowMs: number,
  ttlMs: number = SELF_DESTRUCT_TTL_MS,
): boolean {
  if (firstSeenMs === null || firstSeenMs === undefined) return false;
  if (!Number.isFinite(firstSeenMs) || !Number.isFinite(nowMs)) return false;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return false;
  if (nowMs < firstSeenMs) return false;
  return nowMs - firstSeenMs >= ttlMs;
}
