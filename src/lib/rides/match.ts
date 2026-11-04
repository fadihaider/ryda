/**
 * Are two records the same ride?
 *
 * A ride id is start minute plus duration in minutes, which collapses the same
 * file imported twice. It does not reliably collapse the same ride arriving by
 * two routes: Strava's start time and elapsed time can land either side of a
 * minute boundary from what the file says, and the ids then differ by one. So
 * cross-source matching is by tolerance rather than by id.
 *
 * Two minutes on each is loose enough for rounding and a trimmed start, and
 * tight enough that two separate rides on one day do not merge — those are
 * separated by at least the length of the first ride.
 */
export const MATCH_TOLERANCE_SECONDS = 120;

export interface RideTiming {
  startedAt: Date | string;
  durationSeconds: number;
}

export function isSameRide(a: RideTiming, b: RideTiming): boolean {
  const startA = new Date(a.startedAt).getTime();
  const startB = new Date(b.startedAt).getTime();
  return (
    Math.abs(startA - startB) <= MATCH_TOLERANCE_SECONDS * 1000 &&
    Math.abs(a.durationSeconds - b.durationSeconds) <= MATCH_TOLERANCE_SECONDS
  );
}
