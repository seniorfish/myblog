import { describe, expect, it } from 'vitest';
import {
  SELF_DESTRUCT_TTL_MS,
  shouldSelfDestruct,
} from '../sw/self-destruct.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('shouldSelfDestruct', () => {
  it('uses a seven-day TTL', () => {
    expect(SELF_DESTRUCT_TTL_MS).toBe(7 * DAY_MS);
  });

  it('returns false before the TTL elapses', () => {
    expect(shouldSelfDestruct(1_000, 1_000 + 6 * DAY_MS)).toBe(false);
  });

  it('returns true exactly at the TTL boundary', () => {
    expect(shouldSelfDestruct(1_000, 1_000 + 7 * DAY_MS)).toBe(true);
  });

  it('returns true after the TTL elapses', () => {
    expect(shouldSelfDestruct(1_000, 1_000 + 7 * DAY_MS + 1)).toBe(true);
  });

  it('returns false when there is no first-seen record', () => {
    expect(shouldSelfDestruct(null, Date.now())).toBe(false);
    expect(shouldSelfDestruct(undefined, Date.now())).toBe(false);
  });

  it('treats a clock rollback as not due', () => {
    expect(shouldSelfDestruct(10_000, 9_999)).toBe(false);
  });

  it('supports a custom TTL', () => {
    expect(shouldSelfDestruct(0, 999, 1_000)).toBe(false);
    expect(shouldSelfDestruct(0, 1_000, 1_000)).toBe(true);
  });

  it('ignores invalid timestamps and TTLs', () => {
    expect(shouldSelfDestruct(Number.NaN, Date.now())).toBe(false);
    expect(shouldSelfDestruct(0, Number.NaN)).toBe(false);
    expect(shouldSelfDestruct(0, 100, Number.NaN)).toBe(false);
    expect(shouldSelfDestruct(0, 100, 0)).toBe(false);
    expect(shouldSelfDestruct(0, 100, -1)).toBe(false);
  });
});
