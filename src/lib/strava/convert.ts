import { normalise, type FitRecord, type ParsedRide } from "@/lib/ingest/fit";

/**
 * Strava API shapes, and the conversion from Strava's streams to a ParsedRide.
 *
 * Kept free of I/O so it can be tested against fixtures: everything about how
 * a Strava activity becomes samples lives here, and everything about fetching
 * it lives in `api.ts`.
 */

/** The fields of a SummaryActivity this app reads. */
export interface StravaSummaryActivity {
  id: number;
  name: string;
  sport_type: string;
  type?: string;
  /** UTC, ISO 8601. */
  start_date: string;
  /** Local wall-clock time, written with a misleading trailing Z. */
  start_date_local: string;
  elapsed_time: number;
  moving_time?: number;
  manual?: boolean;
  trainer?: boolean;
  device_watts?: boolean;
  device_name?: string;
}

interface Stream<T> {
  data: T[];
}

/** `GET /activities/{id}/streams?key_by_type=true`. Every key may be absent. */
export interface StravaStreamSet {
  time?: Stream<number>;
  distance?: Stream<number>;
  latlng?: Stream<[number, number]>;
  altitude?: Stream<number>;
  velocity_smooth?: Stream<number>;
  heartrate?: Stream<number>;
  cadence?: Stream<number>;
  watts?: Stream<number | null>;
  temp?: Stream<number>;
  moving?: Stream<boolean>;
}

export const STREAM_KEYS = [
  "time",
  "distance",
  "latlng",
  "altitude",
  "velocity_smooth",
  "heartrate",
  "cadence",
  "watts",
  "temp",
] as const;

/**
 * Strava's PascalCase sport type in the snake_case this app stores, so the
 * existing classifier and labels work unchanged: "GravelRide" → "gravel_ride".
 */
export function sportFromStrava(sportType: string): string {
  return sportType
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

/** The date part of start_date_local, which is the rider's calendar day. */
export function localDateFromStrava(startDateLocal: string): string {
  return startDateLocal.slice(0, 10);
}

export class NoStreamsError extends Error {
  constructor() {
    super("activity has no time or distance stream (manual entry?)");
    this.name = "NoStreamsError";
  }
}

export function streamsToRide(
  activity: StravaSummaryActivity,
  set: StravaStreamSet,
): ParsedRide {
  const time = set.time?.data;
  const distance = set.distance?.data;
  if (!time || time.length < 2 || !distance) throw new NoStreamsError();

  const t0 = Date.parse(activity.start_date);
  // Only a meter's watts count as measured. `device_watts` false means Strava
  // estimated them, and an estimate fed back in as measurement would bypass
  // this app's own model entirely.
  const watts = activity.device_watts ? set.watts?.data : undefined;

  const records: FitRecord[] = new Array(time.length);
  for (let i = 0; i < time.length; i++) {
    const ll = set.latlng?.data[i];
    records[i] = {
      timestamp: new Date(t0 + time[i] * 1000),
      distance: distance[i],
      altitude: set.altitude?.data[i],
      position_lat: ll?.[0],
      position_long: ll?.[1],
      speed: set.velocity_smooth?.data[i],
      heart_rate: set.heartrate?.data[i],
      cadence: set.cadence?.data[i],
      power: watts?.[i] ?? undefined,
      temperature: set.temp?.data[i],
    };
  }

  const parsed = normalise(records, {}, activity.device_name ? [activity.device_name] : []);

  // velocity_smooth is Strava's smoothed series, not what the device measured.
  // Labelled derived so the estimator treats it with the same caution as speed
  // integrated from positions.
  parsed.streams.speedIsDerived = true;
  if (!set.velocity_smooth) parsed.streams.speed = undefined;

  return {
    ...parsed,
    name: activity.name,
    startedAt: new Date(t0).toISOString(),
    sport: sportFromStrava(activity.sport_type),
    hasMeasuredPower: watts !== undefined && watts.some((w) => w != null),
    // Strava's calorie figure is its own estimate unless the device sent one,
    // and the API does not say which. Leaving it out keeps reportedCalories
    // meaning what it means for files: the device's own number.
    reported: {
      elapsedSeconds: activity.elapsed_time,
      movingSeconds: activity.moving_time,
    },
  };
}
