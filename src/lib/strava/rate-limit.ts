/**
 * Strava's rate-limit windows and headers.
 *
 * Usage and limit headers are "15-minute,daily" pairs. The short window resets
 * at :00, :15, :30 and :45; the daily one at midnight UTC
 * (developers.strava.com/docs/rate-limits).
 */

/** Windows reset at :00, :15, :30, :45; the day resets at midnight UTC. */
export function nextWindow(now: Date): Date {
  const quarter = 15 * 60_000;
  return new Date(Math.floor(now.getTime() / quarter) * quarter + quarter);
}

export function nextUtcMidnight(now: Date): Date {
  const d = new Date(now);
  d.setUTCHours(24, 0, 0, 0);
  return d;
}

/** Parse "15min,daily" pairs from a rate-limit header. */
export function parsePair(value: string | null): [number, number] | null {
  if (!value) return null;
  const [a, b] = value.split(",").map((v) => Number(v.trim()));
  return Number.isFinite(a) && Number.isFinite(b) ? [a, b] : null;
}
