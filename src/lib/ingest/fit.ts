import FitParser from "fit-file-parser";
import type { AltitudeSource, RideMeta, RideStreams } from "@/lib/analysis/types";

/**
 * FIT ingestion.
 *
 * Two properties of real files drive everything here:
 *
 * 1. Records are nominally 1 Hz but not reliably so. A real file from a Geoid
 *    CC700 has a median interval of 1 s and a maximum of 183 s, because the
 *    rider paused. Every downstream metric assumes a uniform grid, so
 *    normalising is not optional.
 *
 * 2. Gaps are ambiguous — a pause at a cafe and a tunnel signal dropout look
 *    identical. We hold distance across a gap rather than interpolating, so a
 *    stop is never rendered as movement. That under-reports a genuine dropout,
 *    which is the safer direction: inventing distance would inflate speed, and
 *    speed cubed is power.
 */

export interface FitRecord {
  timestamp?: string | Date;
  position_lat?: number;
  position_long?: number;
  distance?: number;
  altitude?: number;
  enhanced_altitude?: number;
  speed?: number;
  enhanced_speed?: number;
  heart_rate?: number;
  cadence?: number;
  power?: number;
  temperature?: number;
}

export interface FitSession {
  sport?: string;
  sub_sport?: string;
  start_time?: string | Date;
  total_distance?: number;
  total_elapsed_time?: number;
  total_timer_time?: number;
  total_ascent?: number;
  avg_speed?: number;
  avg_heart_rate?: number;
  avg_cadence?: number;
  avg_power?: number;
  total_calories?: number;
}

interface FitDeviceInfo {
  manufacturer?: string;
  product_name?: string;
  device_type?: string;
}

interface FitData {
  records?: FitRecord[];
  sessions?: FitSession[];
  device_infos?: FitDeviceInfo[];
}

export interface ParsedRide {
  streams: RideStreams;
  meta: RideMeta;
  name: string;
  startedAt: string;
  sport: string;
  /** True when the file itself carried power from a real meter. */
  hasMeasuredPower: boolean;
  devices: string[];
  /** Seconds of recording gap that were held rather than interpolated. */
  gapSeconds: number;
  /** What the head unit reported, for cross-checking our own computation. */
  reported: {
    distanceMeters?: number;
    elapsedSeconds?: number;
    movingSeconds?: number;
    ascentMeters?: number;
    avgHeartRate?: number;
    avgCadence?: number;
    /**
     * Calories the device itself computed, from `session.total_calories`.
     *
     * Worth preferring over anything derived here. A head unit with a heart-rate
     * strap models energy expenditure from heart rate and the rider's profile,
     * which captures the metabolic cost of a ride — not just the mechanical
     * work, which is all that can be recovered from speed and gradient. On one
     * real ride the device said 4,491 kcal where the work implies about 1,800.
     */
    calories?: number;
  };
}

/** Anything longer than this is treated as a stop, not a sampling hiccup. */
const GAP_THRESHOLD_S = 5;

export async function parseFit(buffer: ArrayBuffer): Promise<ParsedRide> {
  const Parser = (FitParser as unknown as { default?: typeof FitParser }).default ?? FitParser;
  const parser = new (Parser as unknown as new (o: unknown) => {
    parse: (b: ArrayBuffer, cb: (err: unknown, d: FitData) => void) => void;
  })({
    force: true,
    speedUnit: "m/s",
    lengthUnit: "m",
    temperatureUnit: "celsius",
    elapsedRecordField: true,
    mode: "list",
  });

  const data = await new Promise<FitData>((resolve, reject) => {
    parser.parse(buffer, (err, d) => (err ? reject(err) : resolve(d)));
  });

  const records = coalesceBySecond(
    (data.records ?? []).filter((r) => r.timestamp !== undefined && r.timestamp !== null),
  );
  if (records.length < 2) {
    throw new Error("This FIT file contains no usable ride records.");
  }

  const session = data.sessions?.[0] ?? {};
  const devices = (data.device_infos ?? [])
    .map((d) => [d.manufacturer, d.product_name].filter(Boolean).join(" "))
    .filter(Boolean);

  return normalise(records, session, devices);
}

function toEpochSeconds(value: string | Date): number {
  return (value instanceof Date ? value.getTime() : Date.parse(value)) / 1000;
}

/**
 * Merge records that share a timestamp into one sample.
 *
 * The FIT spec does not promise one record per second with every field set, and
 * real writers exploit that. A Strava phone recording emits TWO records per
 * timestamp: one carrying position, distance and speed, and one carrying only
 * elapsed/timer time. Treated as separate samples, half the ride has no
 * distance at all — a 6.0 km ride parsed as 4.4 km with zero moving time,
 * because every other sample looked stationary.
 *
 * Merging by second, taking the first non-null value for each field, restores
 * the intended sample. This is general: any device interleaving partial records
 * benefits, and files that already have one clean record per second are
 * unaffected.
 */
function coalesceBySecond(records: FitRecord[]): FitRecord[] {
  const bySecond = new Map<number, FitRecord>();

  for (const record of records) {
    const second = Math.round(toEpochSeconds(record.timestamp!));
    const existing = bySecond.get(second);
    if (!existing) {
      bySecond.set(second, { ...record });
      continue;
    }
    for (const [key, value] of Object.entries(record) as [keyof FitRecord, unknown][]) {
      if (value === null || value === undefined) continue;
      if (existing[key] === null || existing[key] === undefined) {
        (existing as Record<string, unknown>)[key] = value;
      }
    }
  }

  return [...bySecond.keys()]
    .sort((a, b) => a - b)
    .map((second) => bySecond.get(second)!);
}

/**
 * Resample onto a uniform 1 Hz grid spanning the ride, carrying values forward
 * across gaps and holding distance so stops read as stationary.
 *
 * Exported because it is not FIT-specific: anything that can be expressed as
 * timestamped records — Strava's API streams included — goes through the same
 * gap handling, so a ride does not score differently by how it arrived.
 */
export function normalise(
  records: FitRecord[],
  session: FitSession,
  devices: string[],
): ParsedRide {
  const t0 = toEpochSeconds(records[0].timestamp!);
  const tEnd = toEpochSeconds(records[records.length - 1].timestamp!);
  const n = Math.max(2, Math.round(tEnd - t0) + 1);

  const time = new Float64Array(n);
  const distance = new Float64Array(n);
  const altitude = new Float64Array(n);
  const latlng = new Float64Array(n * 2);
  const speed = new Float32Array(n);
  // Marks which samples we invented to fill a recording pause.
  const paused = new Uint8Array(n);

  const hasHr = records.some((r) => r.heart_rate != null);
  const hasCadence = records.some((r) => r.cadence != null);
  const hasTemp = records.some((r) => r.temperature != null);
  const hasPower = records.some((r) => r.power != null);
  const hasPosition = records.some((r) => r.position_lat != null);
  const hasSpeed = records.some((r) => speedOf(r) != null);

  const heartrate = hasHr ? new Float32Array(n) : undefined;
  const cadence = hasCadence ? new Float32Array(n) : undefined;
  const temperature = hasTemp ? new Float32Array(n) : undefined;
  const power = hasPower ? new Float32Array(n) : undefined;

  let gapSeconds = 0;
  let cursor = 0;
  let lastDistance = records[0].distance ?? 0;
  let lastAltitude = altitudeOf(records[0]) ?? 0;
  let lastLat = records[0].position_lat ?? 0;
  let lastLng = records[0].position_long ?? 0;

  for (let i = 0; i < n; i++) {
    const t = t0 + i;
    time[i] = i;

    // Advance to the last record at or before this second.
    while (
      cursor < records.length - 1 &&
      toEpochSeconds(records[cursor + 1].timestamp!) <= t
    ) {
      cursor++;
    }

    const rec = records[cursor];
    const recTime = toEpochSeconds(rec.timestamp!);
    const next = records[cursor + 1];
    const nextTime = next ? toEpochSeconds(next.timestamp!) : recTime;
    const gap = nextTime - recTime;
    const inGap = gap > GAP_THRESHOLD_S && t > recTime;

    if (inGap) {
      // Stopped (or signal lost). Hold position and distance; zero the speed.
      gapSeconds += 1;
      paused[i] = 1;
      distance[i] = lastDistance;
      altitude[i] = lastAltitude;
      speed[i] = 0;
      if (hasPosition) {
        latlng[i * 2] = lastLat;
        latlng[i * 2 + 1] = lastLng;
      }
      if (heartrate) heartrate[i] = rec.heart_rate ?? 0;
      if (cadence) cadence[i] = 0;
      if (temperature) temperature[i] = rec.temperature ?? 0;
      if (power) power[i] = 0;
      continue;
    }

    // Interpolate between the bracketing records for sub-sample accuracy.
    const span = nextTime - recTime;
    const f = span > 0 && next ? Math.min(1, Math.max(0, (t - recTime) / span)) : 0;
    const lerp = (a?: number, b?: number) => {
      if (a == null) return b ?? 0;
      if (b == null) return a;
      return a + (b - a) * f;
    };

    lastDistance = lerp(rec.distance ?? lastDistance, next?.distance);
    lastAltitude = lerp(altitudeOf(rec) ?? lastAltitude, next ? altitudeOf(next) : undefined);
    distance[i] = lastDistance;
    altitude[i] = lastAltitude;
    speed[i] = lerp(speedOf(rec), next ? speedOf(next) : undefined);

    if (hasPosition) {
      lastLat = lerp(rec.position_lat ?? lastLat, next?.position_lat);
      lastLng = lerp(rec.position_long ?? lastLng, next?.position_long);
      latlng[i * 2] = lastLat;
      latlng[i * 2 + 1] = lastLng;
    }
    if (heartrate) heartrate[i] = lerp(rec.heart_rate, next?.heart_rate);
    if (cadence) cadence[i] = lerp(rec.cadence, next?.cadence);
    if (temperature) temperature[i] = lerp(rec.temperature, next?.temperature);
    if (power) power[i] = lerp(rec.power, next?.power);
  }

  const startedAt = new Date(t0 * 1000).toISOString();

  return {
    streams: {
      time,
      distance,
      altitude,
      latlng: hasPosition ? latlng : undefined,
      speed,
      speedIsDerived: !hasSpeed,
      heartrate,
      cadence,
      temperature,
      power,
      paused,
    },
    meta: { altitudeSource: detectAltitudeSource(altitude), n },
    name: describeRide(startedAt, session.sport),
    startedAt,
    sport: session.sport ?? "cycling",
    hasMeasuredPower: hasPower,
    devices,
    gapSeconds,
    reported: {
      calories: session.total_calories,
      distanceMeters: session.total_distance,
      elapsedSeconds: session.total_elapsed_time,
      movingSeconds: session.total_timer_time,
      ascentMeters: session.total_ascent,
      avgHeartRate: session.avg_heart_rate,
      avgCadence: session.avg_cadence,
    },
  };
}

/** `enhanced_*` fields carry the wider range and are preferred when present. */
const altitudeOf = (r: FitRecord) => r.enhanced_altitude ?? r.altitude;
const speedOf = (r: FitRecord) => r.enhanced_speed ?? r.speed;

/**
 * Guess whether altitude came from a barometer or from GPS.
 *
 * FIT does not state this, and it changes grade error roughly fivefold, so it
 * is worth inferring. Barometric traces are smooth second to second; GPS
 * altitude jumps by metres. We look at the median absolute second-to-second
 * change, which is robust to the occasional real step.
 *
 * A heuristic, and labelled as one — it feeds the confidence chip, not a claim
 * of fact.
 */
export function detectAltitudeSource(altitude: Float64Array): AltitudeSource {
  const deltas: number[] = [];
  for (let i = 1; i < altitude.length; i++) {
    const d = Math.abs(altitude[i] - altitude[i - 1]);
    if (Number.isFinite(d)) deltas.push(d);
  }
  if (deltas.length < 30) return "gps";
  deltas.sort((a, b) => a - b);
  const median = deltas[Math.floor(deltas.length / 2)];
  // Barometric altimeters resolve well under a metre per second; consumer GPS
  // altitude rarely settles below that.
  return median <= 0.35 ? "barometric" : "gps";
}

function describeRide(startedAt: string, sport?: string): string {
  const d = new Date(startedAt);
  const hour = d.getHours();
  const part =
    hour < 5 ? "Night" : hour < 12 ? "Morning" : hour < 17 ? "Afternoon" : "Evening";
  const activity = sport === "cycling" || !sport ? "Ride" : capitalise(sport);
  return `${part} ${activity}`;
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
